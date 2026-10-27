import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";
import { maskMeetingUrl } from "../shared/meeting-url.js";
import { agentRequestSchema, parseAgentRequest, runAgentRequest, type AgentRequest } from "./agent-api.js";
import { createAgentTokenManager, type AgentTokenManager } from "./agent-tokens.js";
import { MeetingsError } from "./errors.js";
import type { MeetingsService } from "./service.js";

export const AGENT_HTTP_BODY_BYTES = 512 * 1024;
export const AGENT_HTTP_RESULT_BYTES = 1024 * 1024;
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const MODERN_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: "AiXenix Meetings", version: "0.3.1", websiteUrl: "https://aixenix.com" };
const MCP_INSTRUCTIONS = "Record and inspect authorized meetings. Preserve invite links when joining, never repeat passcodes. Read every transcript page before summarizing. Delete only on the user's explicit request. AI answers must remain grounded in the transcript.";
const rpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number().int()]).optional(),
  method: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();
const modernMetadataSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.string(),
  "io.modelcontextprotocol/clientCapabilities": z.record(z.string(), z.unknown()),
  "io.modelcontextprotocol/clientInfo": z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
}).passthrough();
type RpcMessage = z.infer<typeof rpcMessageSchema>;
type RpcId = string | number | null;

const descriptions: Record<string, string> = {
  list: "List recorded, active and scheduled meetings.",
  show: "Inspect one meeting by id; omit id to list meetings.",
  join: "Record a meeting from its invite URL, now or at a scheduled time. Preserve the complete invite URL.",
  stop: "Stop recording and finish transcription for one meeting.",
  cancel: "Cancel one scheduled meeting.",
  delete: "Permanently delete one meeting only when the user explicitly requests deletion. Supply confirm and userRequest.",
  transcript: "Read one transcript page; continue using nextFromSegment until null. Check final before treating it as complete.",
  search: "Search words across meeting transcripts.",
  summary: "Read the saved meeting summary.",
  save_summary: "Save or replace a meeting summary in Markdown.",
  save_insights: "Save grounded structured meeting analysis and the exact template snapshot that produced it.",
  rename_speaker: "Rename a meeting speaker; empty name resets the label.",
  retranscribe: "Run transcription again for an existing recording.",
  logs: "Read bounded recorder and transcription diagnostics.",
  doctor: "Check recording runtime readiness.",
  calendar: "Inspect watched calendars and upcoming meetings.",
  meta: "Inspect supported meeting features and agent actions.",
  settings: "Read preferences with secrets redacted, or patch supported fields. Set credentials only when explicitly supplied by the user.",
  templates: "List built-in and custom meeting analysis templates.",
  save_template: "Create or update a custom meeting analysis template.",
  delete_template: "Delete a custom meeting analysis template.",
  analyze: "Analyze a transcript using a selected template; produce grounded summaries and action items.",
  ask: "Answer a question using a meeting transcript with supporting excerpts.",
  insights: "Read saved analysis, action items and speaker metrics.",
  update_action: "Mark one saved meeting action item complete or incomplete.",
  export: "Export one meeting in a supported text format.",
  retry: "Retry a failed meeting operation.",
  accounts: "Inspect connected meeting account state without exposing credentials.",
};
const readOnlyActions = new Set(["list", "show", "transcript", "search", "summary", "logs", "doctor", "meta", "templates", "insights", "export", "accounts"]);

function toolName(action: string) {
  return `meetings_${action === "show" ? "status" : action}`;
}

export function listMcpTools() {
  return agentRequestSchema.options.filter(option => String(option.shape.action.value) !== "mcp").map(option => {
    const action: string = option.shape.action.value;
    const fields: Record<string, z.ZodType> = {};
    for (const [name, field] of Object.entries(option.shape)) {
      if (name !== "action") fields[name] = field;
    }
    const input = z.strictObject(fields);
    const schema = action === "show" ? input.partial() : input;
    return {
      name: toolName(action),
      description: descriptions[action] ?? `Run the ${action} meeting action.`,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      annotations: {
        readOnlyHint: readOnlyActions.has(action),
        destructiveHint: action === "delete" || action === "delete_template",
        openWorldHint: ["join", "analyze", "ask", "calendar", "retry"].includes(action),
      },
    };
  });
}

function publicError(error: unknown) {
  if (error instanceof MeetingsError) {
    return { code: error.code, message: maskMeetingUrl(error.message).slice(0, 1500), ...(error.hint ? { hint: maskMeetingUrl(error.hint).slice(0, 1000) } : {}) };
  }
  return { code: "internal_error", message: "Не удалось выполнить запрос к встречам. Попробуйте ещё раз." };
}

function publicResult(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new MeetingsError("too_large", "Ответ слишком сложный", "Response nesting is too deep");
  if (typeof value === "string") return maskMeetingUrl(value);
  if (Array.isArray(value)) return value.map(item => publicResult(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicResult(item, depth + 1)]));
  return value;
}

function actionResult(request: AgentRequest, result: unknown) {
  const safe = publicResult(result);
  return { ok: true, action: request.action, ...(safe !== null && typeof safe === "object" ? safe : { result: safe }) };
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > AGENT_HTTP_RESULT_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: { code: "too_large", message: "Ответ слишком большой. Уменьшите limit или maxChars." } }), {
      status: 413, headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
    });
  }
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
}

function rpcError(id: RpcId, code: number, message: string, status = 400, data?: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);
}

function rpcResult(id: RpcId, result: Record<string, unknown>, modern: boolean) {
  const payload = { jsonrpc: "2.0", id, result: modern ? { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : result };
  if (Buffer.byteLength(JSON.stringify(payload)) > AGENT_HTTP_RESULT_BYTES) {
    return rpcError(id, -32603, "Ответ слишком большой. Уменьшите limit или maxChars.", 200, { code: "too_large" });
  }
  return jsonResponse(payload);
}

const callLimits = new WeakMap<MeetingsService, { active: number; recent: number[] }>();
async function executeAgent(service: MeetingsService, request: AgentRequest, signal: AbortSignal) {
  const limits = callLimits.get(service) ?? { active: 0, recent: [] };
  callLimits.set(service, limits);
  const now = Date.now();
  limits.recent = limits.recent.filter(started => started > now - 60_000);
  if (limits.active >= 6 || limits.recent.length >= 120) throw new MeetingsError("rate_limited", "Слишком много запросов. Попробуйте через минуту.", "Too many requests. Retry in a minute.");
  limits.active += 1;
  limits.recent.push(now);
  try { return await runAgentRequest(service, request, signal); }
  finally { limits.active -= 1; }
}

/** Shared JSON-RPC dispatch for HTTP and the official enrolled BB CLI. */
async function dispatchMcp(service: MeetingsService, value: unknown, protocolVersion: string, signal: AbortSignal): Promise<Response> {
  const parsed = rpcMessageSchema.safeParse(value);
  if (!parsed.success) return rpcError(null, -32600, "Expected one JSON-RPC request or notification");
  const message = parsed.data;
  if (!MCP_PROTOCOL_VERSIONS.some(supported => supported === protocolVersion)) return rpcError(message.id ?? null, -32022, "Unsupported protocol version", 400, { requested: protocolVersion, supported: MCP_PROTOCOL_VERSIONS });
  const modern = protocolVersion === MODERN_PROTOCOL;
  if (message.id === undefined) return message.method.startsWith("notifications/") ? new Response(null, { status: 202 }) : rpcError(null, -32600, "Requests require an id");
  const params = message.params ?? {};
  if (modern) {
    const metadata = modernMetadataSchema.safeParse(params._meta);
    if (!metadata.success) return rpcError(message.id, -32602, "Required per-request protocol metadata is missing or malformed");
    if (metadata.data["io.modelcontextprotocol/protocolVersion"] !== protocolVersion) return rpcError(message.id, -32020, "MCP protocol version does not match the request metadata");
  } else if (z.record(z.string(), z.unknown()).safeParse(params._meta).data?.["io.modelcontextprotocol/protocolVersion"] === MODERN_PROTOCOL) {
    return rpcError(message.id, -32020, "MCP protocol version does not match the request metadata");
  }
  if (message.method === "initialize") {
    const init = z.object({ protocolVersion: z.string(), capabilities: z.record(z.string(), z.unknown()), clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).passthrough().safeParse(params);
    if (!init.success) return rpcError(message.id, -32602, "Invalid initialization parameters");
    const negotiated = MCP_PROTOCOL_VERSIONS.find(version => version === init.data.protocolVersion && version !== MODERN_PROTOCOL) ?? "2025-11-25";
    return rpcResult(message.id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: MCP_INSTRUCTIONS }, false);
  }
  if (message.method === "server/discover") return rpcResult(message.id, { supportedVersions: MCP_PROTOCOL_VERSIONS, capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS, ttlMs: 300_000, cacheScope: "private" }, modern);
  if (message.method === "ping") return rpcResult(message.id, {}, modern);
  if (message.method === "tools/list") {
    if (params.cursor !== undefined) return rpcError(message.id, -32602, "This server does not use tool pagination");
    return rpcResult(message.id, { tools: listMcpTools(), ...(modern ? { ttlMs: 300_000, cacheScope: "private" } : {}) }, modern);
  }
  if (message.method !== "tools/call") return rpcError(message.id, -32601, "Method not found", modern ? 404 : 200);
  const call = z.object({ name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}), _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(params);
  if (!call.success) return rpcError(message.id, -32602, "Invalid tool call parameters");
  if (!listMcpTools().some(tool => tool.name === call.data.name)) return rpcError(message.id, -32602, "Unknown meeting tool", 200);
  try {
    const request = requestForTool(call.data.name, call.data.arguments);
    const content = actionResult(request, await executeAgent(service, request, signal));
    return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(content) }], structuredContent: content, isError: false }, modern);
  } catch (error) {
    const content = { ok: false, error: publicError(error) };
    return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(content) }], structuredContent: content, isError: true }, modern);
  }
}

/** A transport wrapper, intentionally omitted from the MCP tools catalog. */
export async function runMcpRequest(service: MeetingsService, request: unknown, protocolVersion = "2025-11-25", signal = new AbortController().signal): Promise<Record<string, unknown> | null> {
  signal.throwIfAborted();
  const serialized = JSON.stringify(request);
  if (serialized === undefined || Buffer.byteLength(serialized) > AGENT_HTTP_BODY_BYTES) throw new MeetingsError("too_large", "Запрос слишком большой", "Request too large");
  const response = await dispatchMcp(service, request, protocolVersion, signal);
  return response.status === 202 ? null : await response.json() as Record<string, unknown>;
}

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > AGENT_HTTP_BODY_BYTES) throw new MeetingsError("too_large", "Запрос слишком большой", "Request too large");
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > AGENT_HTTP_BODY_BYTES) {
        void reader.cancel();
        throw new MeetingsError("too_large", "Запрос слишком большой", "Request too large");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function validOrigin(request: Request, appUrl: string | null) {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const origins = [new URL(request.url).origin];
    if (appUrl !== null) origins.push(new URL(appUrl).origin);
    return origins.includes(new URL(origin).origin) && new URL(origin).origin === origin;
  } catch { return false; }
}

function decodeNameHeader(value: string | null) {
  if (value === null || !/^[\x20-\x7e]+$/.test(value)) return null;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  return Buffer.from(encoded, "base64").toString("utf8");
}

function metadataError(request: Request, message: RpcMessage) {
  const version = request.headers.get("mcp-protocol-version") ?? "2025-03-26";
  if (!MCP_PROTOCOL_VERSIONS.some(supported => supported === version)) {
    return rpcError(message.id ?? null, -32022, "Unsupported protocol version", 400, { requested: version, supported: MCP_PROTOCOL_VERSIONS });
  }
  const bodyMetadata = z.record(z.string(), z.unknown()).safeParse(message.params?._meta);
  const bodyVersion = bodyMetadata.success ? bodyMetadata.data["io.modelcontextprotocol/protocolVersion"] : undefined;
  if ((version !== MODERN_PROTOCOL && bodyVersion !== MODERN_PROTOCOL) || message.id === undefined) return null;
  const metadata = modernMetadataSchema.safeParse(message.params?._meta);
  if (!metadata.success) return rpcError(message.id, -32602, "Required per-request protocol metadata is missing or malformed");
  if (metadata.data["io.modelcontextprotocol/protocolVersion"] !== version || request.headers.get("mcp-method") !== message.method) {
    return rpcError(message.id, -32020, "MCP protocol or method header does not match the request body");
  }
  if (message.method === "tools/call" && decodeNameHeader(request.headers.get("mcp-name")) !== message.params?.name) {
    return rpcError(message.id, -32020, "Mcp-Name header does not match the tool name");
  }
  return null;
}

function acceptsJson(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function requestForTool(name: string, args: Record<string, unknown>): AgentRequest {
  if (Object.hasOwn(args, "action")) throw new MeetingsError("invalid_request", "Поле action выбирается именем MCP-инструмента", "The MCP tool name selects the action; do not pass action as an argument");
  const option = agentRequestSchema.options.find(option => String(option.shape.action.value) !== "mcp" && toolName(option.shape.action.value) === name);
  if (option === undefined) throw new MeetingsError("unknown_tool", "Неизвестный инструмент встреч", "Unknown meeting tool");
  const action = option.shape.action.value;
  if (action === "show" && args.id === undefined) return parseAgentRequest(JSON.stringify({ ...args, action: "list" }));
  return parseAgentRequest(JSON.stringify({ ...args, action }));
}

export function registerAgentTransports(bb: BbPluginApi, service: MeetingsService, tokens: AgentTokenManager = createAgentTokenManager(bb)) {
  const authorize = async (c: Context, personal: boolean) => {
    if (!validOrigin(c.req.raw, bb.server.experimental_appUrl)) return jsonResponse({ ok: false, error: { code: "invalid_origin", message: "Origin is not allowed" } }, 403);
    if (!personal) return null;
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
    if (match === null || !(await tokens.verify(match[1]))) return jsonResponse({ ok: false, error: { code: "unauthorized", message: "A valid Meetings Bearer token is required" } }, 401, { "www-authenticate": 'Bearer realm="meetings"' });
    return null;
  };
  const rest = (personal: boolean) => async (c: Context) => {
    const denied = await authorize(c, personal);
    if (denied !== null) return denied;
    if (!acceptsJson(c.req.raw)) return jsonResponse({ ok: false, error: { code: "invalid_request", message: "Content-Type must be application/json" } }, 415);
    try {
      const request = parseAgentRequest(await readBody(c.req.raw));
      if (String(request.action) === "mcp") throw new MeetingsError("invalid_request", "Используйте MCP endpoint для JSON-RPC", "Use the MCP endpoint for JSON-RPC requests");
      const result = await executeAgent(service, request, c.req.raw.signal);
      return jsonResponse(actionResult(request, result));
    } catch (error) {
      const detail = publicError(error);
      return jsonResponse({ ok: false, error: detail }, detail.code === "too_large" ? 413 : detail.code === "not_found" ? 404 : detail.code === "rate_limited" ? 429 : detail.code === "internal_error" ? 500 : 400);
    }
  };
  const mcp = (personal: boolean) => async (c: Context) => {
    const denied = await authorize(c, personal);
    if (denied !== null) return denied;
    if (!acceptsJson(c.req.raw)) return rpcError(null, -32600, "Content-Type must be application/json", 415);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return rpcError(null, -32600, "Accept must include application/json and text/event-stream", 406);
    let raw: string;
    try { raw = await readBody(c.req.raw); }
    catch (error) { return rpcError(null, -32600, publicError(error).message, 413); }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { return rpcError(null, -32700, "Invalid JSON"); }
    const parsed = rpcMessageSchema.safeParse(value);
    if (!parsed.success) return rpcError(null, -32600, "Expected one JSON-RPC request or notification");
    const message = parsed.data;
    const invalidMetadata = metadataError(c.req.raw, message);
    if (invalidMetadata !== null) return invalidMetadata;
    return dispatchMcp(service, value, c.req.header("mcp-protocol-version") ?? "2025-03-26", c.req.raw.signal);
  };
  const methodNotAllowed = (personal: boolean) => async (c: Context) => {
    const denied = await authorize(c, personal);
    return denied ?? new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  };
  for (const personal of [false, true]) {
    const suffix = personal ? "-token" : "";
    const auth = personal ? "none" as const : "local" as const;
    bb.http.route("POST", `/api${suffix}`, rest(personal), { auth });
    bb.http.route("POST", `/mcp${suffix}`, mcp(personal), { auth });
    bb.http.route("GET", `/mcp${suffix}`, methodNotAllowed(personal), { auth });
    bb.http.route("DELETE", `/mcp${suffix}`, methodNotAllowed(personal), { auth });
  }
  bb.http.route("GET", "/agent-meta", async c => {
    const denied = await authorize(c, false);
    return denied ?? jsonResponse({
      transports: { rest: "/api/v1/plugins/meetings/http/api", mcp: "/api/v1/plugins/meetings/http/mcp", personalRest: "/api/v1/plugins/meetings/http/api-token", personalMcp: "/api/v1/plugins/meetings/http/mcp-token" },
      authentication: "Native HTTP requires BB authentication. Personal HTTP requires an explicitly created Meetings Bearer token; hosted BB Connect additionally requires its owner session or enrolled-machine access. STDIO uses official BB CLI authentication.",
      stdio: { command: "node", args: ["<plugin-directory>/integrations/mcp/stdio.mjs"], requirements: ["Node.js 22 or later", "authenticated bb CLI on PATH, or BB_CLI environment variable"] },
      protocolVersions: MCP_PROTOCOL_VERSIONS,
      actions: agentRequestSchema.options.map(option => option.shape.action.value),
      tools: listMcpTools(),
      limits: { bodyBytes: AGENT_HTTP_BODY_BYTES, resultBytes: AGENT_HTTP_RESULT_BYTES },
    });
  });
}
