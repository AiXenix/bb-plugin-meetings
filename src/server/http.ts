// HTTP routes (docs/dev/DESIGN.md §8.4), served at
// /api/v1/plugins/meetings/http/<path>: audio with Range support, the latest
// screenshot, transcript/audio downloads, the bot's avatar frame (§14), the
// Google OAuth redirect (§13), and the mock meeting page for the selftest.
// Bytes come from the host in ≤ 4 MiB reads (base64 stays under the 8 MiB
// host RPC output cap).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { RUNTIME_FILES } from "../generated/runtime-files.js";
import { MAX_READ_CHUNK } from "../shared/contract.js";
import { MEETING_ID_PATTERN, type ReadableFile } from "../shared/runtime-files.js";
import { MeetingsError, errorMessage } from "./errors.js";
import {
  FORMAT_CONTENT_TYPES,
  TRANSCRIPT_FORMATS,
  contentDisposition,
  downloadFileName,
  renderTranscript,
  type TranscriptFormat,
} from "./format.js";
import { GOOGLE_CALLBACK_ROUTE } from "./google-auth.js";
import type { GoogleCallbackOutcome } from "./google-service.js";
import type { MeetingsService } from "./service.js";

/** Bytes per host read and per response to an open-ended range. */
export const HTTP_CHUNK = MAX_READ_CHUNK;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof MeetingsError) {
    return jsonError(error.code === "not_found" || error.code === "not_started" ? 404 : 400, error.message);
  }
  return jsonError(502, errorMessage(error));
}

function meetingIdFrom(c: Context): string | Response {
  const id = c.req.query("id") ?? "";
  if (!MEETING_ID_PATTERN.test(id)) return jsonError(400, "id: нужен идентификатор встречи mtg_…");
  return id;
}

export type ByteRange =
  | { kind: "full"; start: number; end: number }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * Parse a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range against `size`.
 * Multi-range and malformed headers are ignored (full response), as RFC 9110 allows.
 * Open-ended ranges are capped at `chunk` bytes; a shorter 206 is legal and the client asks again.
 */
export function parseRange(header: string | undefined, size: number, chunk = HTTP_CHUNK): ByteRange {
  const full: ByteRange = { kind: "full", start: 0, end: size - 1 };
  if (header === undefined) return full;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return full;
  let start: number;
  let end: number;
  if (match[1] !== "") {
    start = Number(match[1]);
    if (match[2] !== "") {
      end = Math.min(Number(match[2]), size - 1);
      if (Number(match[2]) < start) return { kind: "unsatisfiable" };
    } else {
      end = Math.min(size - 1, start + chunk - 1);
    }
  } else {
    const suffix = Number(match[2]);
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}

async function streamFile(
  service: MeetingsService,
  c: Context,
  id: string,
  file: ReadableFile,
  extraHeaders: Record<string, string>,
  method: "GET" | "HEAD",
): Promise<Response> {
  const hostId = await service.hostForViewable(id);
  const probe = await service.call("meeting.readFile", { meetingId: id, file, offset: 0, length: 1 }, { hostId });
  if (probe.base64 === null) return jsonError(404, "Файл ещё не записан");
  const size = probe.totalBytes;
  const headers: Record<string, string> = {
    "content-type": "audio/ogg",
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
    ...extraHeaders,
  };
  if (size === 0) {
    return new Response(method === "HEAD" ? null : new Uint8Array(), { status: 200, headers: { ...headers, "content-length": "0" } });
  }
  const range = parseRange(c.req.header("range"), size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
  }
  const { start, end } = range;
  headers["content-length"] = String(end - start + 1);
  if (range.kind === "partial") headers["content-range"] = `bytes ${start}-${end}/${size}`;
  const status = range.kind === "partial" ? 206 : 200;
  if (method === "HEAD") return new Response(null, { status, headers });

  const signal = c.req.raw.signal;
  let offset = start;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > end) {
        controller.close();
        return;
      }
      try {
        const length = Math.min(HTTP_CHUNK, end - offset + 1);
        const chunk = await service.call("meeting.readFile", { meetingId: id, file, offset, length }, { hostId, signal });
        const bytes = chunk.base64 === null ? Buffer.alloc(0) : Buffer.from(chunk.base64, "base64");
        if (bytes.length === 0) {
          controller.error(new Error(`${file} of ${id} ended at ${offset} of ${size} bytes`));
          return;
        }
        offset += bytes.length;
        controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, { status, headers });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The small self-contained page the browser lands on after Google's consent screen. */
export function googleResultPage(outcome: GoogleCallbackOutcome): Response {
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(outcome.title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 32rem; margin: 1.5rem; padding: 1.75rem 2rem; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 0.75rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  .ok h1 { color: #15803d; } .fail h1 { color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .ok h1 { color: #4ade80; } .fail h1 { color: #f87171; } }
  p { line-height: 1.5; margin: 0 0 1rem; }
  a { color: LinkText; }
</style>
</head>
<body>
<main class="${outcome.ok ? "ok" : "fail"}">
<h1>${escapeHtml(outcome.title)}</h1>
<p>${escapeHtml(outcome.message)}</p>
<p><a href="${escapeHtml(outcome.backPath)}">Вернуться к встречам</a></p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: outcome.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      // The address bar still holds the code: never send it on as a referrer.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

const MOCK_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The mock meeting page (runtime/mock-meeting) for `bb meetings selftest`, served on the bb loopback URL. */
function registerMockMeeting(bb: BbPluginApi): void {
  for (const [file, content] of Object.entries(RUNTIME_FILES)) {
    if (!file.startsWith("mock-meeting/")) continue;
    const type = MOCK_TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    bb.http.route("GET", `/${file}`, () =>
      new Response(content, { status: 200, headers: { "content-type": type, "cache-control": "no-store" } }),
    );
  }
  // The page reports its script events here; the selftest does not need them.
  bb.http.route("POST", "/mock-meeting/log", () => new Response(null, { status: 204 }));
}

export function registerHttp(bb: BbPluginApi, service: MeetingsService): void {
  registerMockMeeting(bb);

  // Google redirects here after the consent screen (a top-level navigation: no Origin header, "local" auth passes).
  bb.http.route("GET", GOOGLE_CALLBACK_ROUTE, async (c) => {
    const query = (name: string) => c.req.query(name)?.slice(0, 4096);
    const outcome = await service.google.handleCallback({
      code: query("code"),
      state: query("state"),
      error: query("error"),
      errorDescription: query("error_description"),
    });
    return googleResultPage(outcome);
  });

  bb.http.route("GET", "/bot/avatar-preview", async () => {
    try {
      const jpeg = await service.bot.preview();
      if (jpeg === null) return jsonError(404, "Аватар не загружен");
      return new Response(new Uint8Array(jpeg), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(jpeg.byteLength), "cache-control": "no-store" },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  for (const method of ["GET", "HEAD"] as const) {
    bb.http.route(method, "/audio", async (c) => {
      const id = meetingIdFrom(c);
      if (typeof id !== "string") return id;
      try {
        service.requireMeeting(id);
        return await streamFile(service, c, id, "audio.ogg", {}, method);
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  bb.http.route("GET", "/screenshot", async (c) => {
    const id = meetingIdFrom(c);
    if (typeof id !== "string") return id;
    try {
      const hostId = await service.hostForViewable(id);
      const result = await service.call(
        "meeting.readFile",
        { meetingId: id, file: "screen.jpg", offset: 0, length: MAX_READ_CHUNK },
        { hostId },
      );
      if (result.base64 === null) return jsonError(404, "Скриншота ещё нет");
      const bytes = Buffer.from(result.base64, "base64");
      return new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  bb.http.route("GET", "/download", async (c) => {
    const id = meetingIdFrom(c);
    if (typeof id !== "string") return id;
    const format = c.req.query("format") ?? "md";
    if (format !== "audio" && !(TRANSCRIPT_FORMATS as readonly string[]).includes(format)) {
      return jsonError(400, `format: одно из ${[...TRANSCRIPT_FORMATS, "audio"].join(", ")}`);
    }
    try {
      const row = service.requireMeeting(id);
      const meta = service.formatMeta(row);
      if (format === "audio") {
        const name = downloadFileName(row.title, meta.startedAt, "ogg");
        return await streamFile(service, c, id, "audio.ogg", { "content-disposition": contentDisposition(name) }, "GET");
      }
      const transcriptFormat = format as TranscriptFormat;
      const text = renderTranscript(transcriptFormat, meta, service.transcriptSegments(id), row.speakerNames);
      const name = downloadFileName(row.title, meta.startedAt, transcriptFormat);
      return new Response(text, {
        status: 200,
        headers: {
          "content-type": FORMAT_CONTENT_TYPES[transcriptFormat],
          "content-disposition": contentDisposition(name),
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
