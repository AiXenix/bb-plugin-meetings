import { createHmac } from "node:crypto";

export const MEETING_WEBHOOK_TIMEOUT_MS = 10_000;
export const MEETING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const MEETING_WEBHOOK_MAX_RESPONSE_BYTES = 4 * 1024;

export interface MeetingWebhookInput {
  readonly url: string;
  /** Server-only signing key; never included in the event or result. */
  readonly secret: string;
  readonly eventId: string;
  readonly event: string;
  readonly meetingId: string;
  readonly data: unknown;
}

export type MeetingWebhookError =
  | "invalid_url"
  | "invalid_secret"
  | "invalid_event"
  | "invalid_payload"
  | "payload_too_large"
  | "timeout"
  | "aborted"
  | "network_error"
  | "http_error"
  | "response_too_large";

export type MeetingWebhookOutcome =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly error: MeetingWebhookError; readonly status?: number };

function endpoint(value: string): URL | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function identifier(value: string, limit: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
}

/**
 * POST one signed event. Receivers verify HMAC-SHA256 over timestamp + "." +
 * the original UTF-8 body, and deduplicate using eventId. Timestamp is Unix
 * seconds. No response body or transport error text leaves this helper.
 */
export async function sendMeetingWebhook(input: MeetingWebhookInput, signal?: AbortSignal): Promise<MeetingWebhookOutcome> {
  const url = endpoint(input.url);
  if (url === null) return { ok: false, error: "invalid_url" };
  if (typeof input.secret !== "string" || input.secret.trim() === "" || input.secret.length > 8192) {
    return { ok: false, error: "invalid_secret" };
  }
  if (!identifier(input.eventId, 256) || !identifier(input.event, 128) || !identifier(input.meetingId, 128)) {
    return { ok: false, error: "invalid_event" };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  let body: string;
  try {
    if (input.data === undefined) return { ok: false, error: "invalid_payload" };
    body = JSON.stringify({ eventId: input.eventId, event: input.event, meetingId: input.meetingId, timestamp, data: input.data });
  } catch {
    return { ok: false, error: "invalid_payload" };
  }
  if (Buffer.byteLength(body, "utf8") > MEETING_WEBHOOK_MAX_BODY_BYTES) return { ok: false, error: "payload_too_large" };
  if (signal?.aborted) return { ok: false, error: "aborted" };

  const signature = createHmac("sha256", input.secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  const controller = new AbortController();
  let abortReason: "aborted" | "timeout" | null = null;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelled = new Promise<MeetingWebhookOutcome>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ ok: false, error: abortReason ?? "aborted" }), { once: true });
  });
  const abort = (reason: "aborted" | "timeout") => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
    // Cancellation is best effort: an untrusted response must not keep the
    // caller waiting for its stream's cancellation callback.
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  };
  const onAbort = () => abort("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), MEETING_WEBHOOK_TIMEOUT_MS);

  const send = async (): Promise<MeetingWebhookOutcome> => {
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-meetings-event-id": input.eventId,
          "x-meetings-timestamp": String(timestamp),
          "x-meetings-signature": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        if (response.body) void response.body.cancel().catch(() => {});
        return { ok: false, error: abortReason ?? "aborted" };
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MEETING_WEBHOOK_MAX_RESPONSE_BYTES) {
        if (response.body) void response.body.cancel().catch(() => {});
        return { ok: false, error: "response_too_large", status: response.status };
      }
      if (response.body) {
        reader = response.body.getReader();
        let bytes = 0;
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MEETING_WEBHOOK_MAX_RESPONSE_BYTES) {
              void reader.cancel().catch(() => {});
              return { ok: false, error: "response_too_large", status: response.status };
            }
          }
        } finally {
          reader.releaseLock();
          reader = undefined;
        }
      }
      if (controller.signal.aborted) return { ok: false, error: abortReason ?? "aborted" };
      return response.ok ? { ok: true, status: response.status } : { ok: false, error: "http_error", status: response.status };
    } catch {
      return { ok: false, error: abortReason ?? "network_error" };
    }
  };

  try {
    return await Promise.race([send(), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
