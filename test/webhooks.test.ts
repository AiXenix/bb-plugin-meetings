import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_WEBHOOK_MAX_BODY_BYTES,
  MEETING_WEBHOOK_MAX_RESPONSE_BYTES,
  MEETING_WEBHOOK_TIMEOUT_MS,
  sendMeetingWebhook,
  type MeetingWebhookInput,
} from "../src/server/webhooks.js";

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const INPUT: MeetingWebhookInput = {
  url: "http://192.168.1.10:8080/events?token=private-query",
  secret: "server-only-signing-key",
  eventId: "evt_123",
  event: "meeting.completed",
  meetingId: "mtg_123",
  data: { title: "Разбор встречи", transcriptReady: true },
};

describe("signed meeting webhooks", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("signs the exact UTF-8 JSON envelope and sends only signature credentials", async () => {
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(INPUT.url);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const body = init!.body as string;
    const headers = new Headers(init!.headers);
    const timestamp = String(Math.floor(NOW / 1000));
    expect(JSON.parse(body)).toEqual({ eventId: INPUT.eventId, event: INPUT.event, meetingId: INPUT.meetingId, timestamp: Number(timestamp), data: INPUT.data });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-meetings-event-id")).toBe(INPUT.eventId);
    expect(headers.get("x-meetings-timestamp")).toBe(timestamp);
    expect(headers.get("x-meetings-signature")).toBe(`sha256=${createHmac("sha256", INPUT.secret).update(`${timestamp}.${body}`).digest("hex")}`);
    expect(body).not.toContain(INPUT.secret);
    expect(headers.get("authorization")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["https://hooks.example/events", "http://localhost:8080/events", "http://10.0.0.1/events"])("allows a chosen HTTP(S) endpoint %s", async (url) => {
    expect(await sendMeetingWebhook({ ...INPUT, url })).toEqual({ ok: true, status: 204 });
  });

  it.each(["not-a-url", "file:///tmp/events", "ftp://example/events", "https://user:password@example/events", "https://example/events#fragment"])("rejects an invalid endpoint without sending %s", async (url) => {
    expect(await sendMeetingWebhook({ ...INPUT, url })).toEqual({ ok: false, error: "invalid_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid headers, missing secrets and nonserializable data before sending", async () => {
    expect(await sendMeetingWebhook({ ...INPUT, eventId: "evt\r\ninjected" })).toEqual({ ok: false, error: "invalid_event" });
    expect(await sendMeetingWebhook({ ...INPUT, secret: " " })).toEqual({ ok: false, error: "invalid_secret" });
    expect(await sendMeetingWebhook({ ...INPUT, data: { bigint: 1n } })).toEqual({ ok: false, error: "invalid_payload" });
    expect(await sendMeetingWebhook({ ...INPUT, data: undefined })).toEqual({ ok: false, error: "invalid_payload" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps request bytes rather than characters", async () => {
    const data = "я".repeat(MEETING_WEBHOOK_MAX_BODY_BYTES / 2);
    expect(data.length).toBeLessThan(MEETING_WEBHOOK_MAX_BODY_BYTES);
    expect(await sendMeetingWebhook({ ...INPUT, data })).toEqual({ ok: false, error: "payload_too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a small response without returning its body or headers", async () => {
    fetchMock.mockResolvedValue(new Response(`${INPUT.secret} ${INPUT.url}`, { status: 401, headers: { "set-cookie": "private-session" } }));
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: false, error: "http_error", status: 401 });
  });

  it("stops a streamed response once its size exceeds the cap", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MEETING_WEBHOOK_MAX_RESPONSE_BYTES + 1)); },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: false, error: "response_too_large", status: 200 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an oversized declared response without reading it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValue(new Response(stream, { headers: { "content-length": String(MEETING_WEBHOOK_MAX_RESPONSE_BYTES + 1) } }));
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: false, error: "response_too_large", status: 200 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("times out a fetch even when the transport ignores cancellation", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const sending = sendMeetingWebhook(INPUT);
    await vi.advanceTimersByTimeAsync(MEETING_WEBHOOK_TIMEOUT_MS);
    expect(await sending).toEqual({ ok: false, error: "timeout" });
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the timeout to reading a response and cancels the stream", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const sending = sendMeetingWebhook(INPUT);
    await vi.advanceTimersByTimeAsync(MEETING_WEBHOOK_TIMEOUT_MS);
    expect(await sending).toEqual({ ok: false, error: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("supports caller cancellation and never exposes its reason", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const sending = sendMeetingWebhook(INPUT, controller.signal);
    controller.abort(new Error(`${INPUT.secret} ${INPUT.url}`));
    expect(await sending).toEqual({ ok: false, error: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockClear();
    expect(await sendMeetingWebhook(INPUT, controller.signal)).toEqual({ ok: false, error: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a safe code for transport and response-read errors", async () => {
    fetchMock.mockRejectedValue(new Error(`request failed ${INPUT.url} ${INPUT.secret}`));
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: false, error: "network_error" });
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(INPUT.secret)); } })));
    expect(await sendMeetingWebhook(INPUT)).toEqual({ ok: false, error: "network_error" });
  });
});
