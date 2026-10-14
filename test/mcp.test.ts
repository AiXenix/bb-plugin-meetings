import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentTokenManager } from "../src/server/agent-tokens.js";
import { AGENT_HTTP_BODY_BYTES, AGENT_HTTP_RESULT_BYTES, listMcpTools, registerAgentTransports, runMcpRequest } from "../src/server/mcp.js";
import { load, uniqueZoomUrl } from "./server-fixtures.js";

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
const modern = (method: string, name?: string) => ({ ...headers, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });
const metadata = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function fixture() {
  const loaded = await load();
  disposers.push(() => loaded.harness.lifecycle.dispose());
  const tokens = createAgentTokenManager(loaded.bb);
  if (!loaded.harness.inspection.registrations.httpRoutes.some(route => route.path === "/mcp")) registerAgentTransports(loaded.bb, loaded.service, tokens);
  const post = (message: unknown, requestHeaders: Record<string, string> = headers, path = "/mcp") => loaded.harness.behavior.fetchHttp("POST", path, { headers: requestHeaders, body: JSON.stringify(message) });
  return { ...loaded, tokens, post };
}

describe("meeting agent transports", () => {
  it("reuses the dispatcher through enrolled CLI without exposing the transport wrapper as a tool", async () => {
    const { harness, service } = await fixture();
    const request = { jsonrpc: "2.0", id: "cli", method: "tools/list" };
    const result = await harness.behavior.runCli(["api", "--request", JSON.stringify({ action: "mcp", request }), "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, action: "mcp", jsonrpc: "2.0", id: "cli", result: { tools: expect.any(Array) } });
    expect(listMcpTools().some(tool => tool.name === "meetings_mcp")).toBe(false);
    expect(await runMcpRequest(service, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const nested = await runMcpRequest(service, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "meetings_mcp", arguments: { request } } });
    expect(nested).toMatchObject({ error: { code: -32602 } });
    const forbiddenRest = await harness.behavior.fetchHttp("POST", "/api", { headers, body: JSON.stringify({ action: "mcp", request }) });
    expect(await forbiddenRest.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const deletion = await runMcpRequest(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "meetings_delete", arguments: { id: "mtg_abcdef" } } });
    expect(deletion).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "invalid_request" } } } });
  });

  it("negotiates legacy initialize, accepts initialized notifications and declares no session", async () => {
    const { post } = await fixture();
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.headers.has("mcp-session-id")).toBe(false);
    expect((await init.json()).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it("supports current stateless discovery and tool calls with required header/body metadata", async () => {
    const { post } = await fixture();
    const discovery = await post({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: metadata } }, modern("server/discover"));
    expect((await discovery.json()).result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]) });
    const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "meetings_list", arguments: {}, _meta: metadata } }, modern("tools/call", "meetings_list"));
    expect((await call.json()).result).toMatchObject({ resultType: "complete", isError: false, structuredContent: { ok: true, action: "list", meetings: [] } });
    const mismatch = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "meetings_list", _meta: metadata } }, modern("tools/call", "meetings_stop"));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe(-32020);
    const missing = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, modern("ping"));
    expect((await missing.json()).error.code).toBe(-32602);
    const downgraded = await post({ jsonrpc: "2.0", id: 5, method: "ping", params: { _meta: metadata } }, headers);
    expect((await downgraded.json()).error.code).toBe(-32020);
    const withoutHeader = { ...headers };
    delete (withoutHeader as Partial<typeof headers>)["mcp-protocol-version"];
    const missingHeader = await post({ jsonrpc: "2.0", id: 6, method: "ping", params: { _meta: metadata } }, withoutHeader);
    expect((await missingHeader.json()).error.code).toBe(-32020);
  });

  it("derives tool schemas from validated agent actions and exposes empty-name resets", async () => {
    const { post } = await fixture();
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (await response.json()).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(listMcpTools().map(tool => tool.name));
    const reset = tools.find((tool: { name: string }) => tool.name === "meetings_rename_speaker");
    expect(reset.inputSchema.properties.action).toBeUndefined();
    expect(reset.inputSchema.properties.name.minLength).toBeUndefined();
    const deletion = tools.find((tool: { name: string }) => tool.name === "meetings_delete");
    expect(deletion.inputSchema.required).toEqual(expect.arrayContaining(["confirm", "userRequest"]));
    expect(deletion.annotations.destructiveHint).toBe(true);
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      "meetings_settings", "meetings_templates", "meetings_save_template", "meetings_analyze", "meetings_save_insights", "meetings_ask", "meetings_update_action", "meetings_accounts",
    ]));
  });

  it("supports expanded template actions and never returns stored secrets from settings", async () => {
    const { post, harness } = await fixture();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await post({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
      return response.json();
    };
    const settings = await call("meetings_settings", { patch: { aiApiKey: "test-only-api-key", webhookSecret: "test-only-hook-secret", autoSummarize: false } });
    expect(settings.result.isError).toBe(false);
    expect(settings.result.structuredContent.settings).toMatchObject({ aiApiKeyConfigured: true, webhookSecretConfigured: true, autoSummarize: false });
    expect(JSON.stringify(settings)).not.toContain("test-only-api-key");
    expect(JSON.stringify(settings)).not.toContain("test-only-hook-secret");
    const saved = await call("meetings_save_template", { label: "Team review", prompt: "Use only decisions from the transcript.", copyFrom: "tech" });
    expect(saved.result.isError).toBe(false);
    const id = saved.result.structuredContent.template.id;
    const templateList = await call("meetings_templates");
    expect(templateList.result.structuredContent.templates).toEqual(expect.arrayContaining([expect.objectContaining({ id, label: "Team review" })]));
    const deleted = await harness.behavior.fetchHttp("POST", "/api", { headers, body: JSON.stringify({ action: "delete_template", id }) });
    expect(await deleted.json()).toMatchObject({ ok: true, action: "delete_template", deleted: true });
  });

  it("routes REST and MCP to the same meeting operation and keeps passcodes masked", async () => {
    const { post, harness } = await fixture();
    const response = await harness.behavior.fetchHttp("POST", "/api", { headers, body: JSON.stringify({ action: "join", url: uniqueZoomUrl(), waitSeconds: 0, title: "Transport test" }) });
    const joined = await response.json();
    expect(joined.ok).toBe(true);
    expect(joined.meeting.link).not.toContain("Secret9");
    const status = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "meetings_status", arguments: { id: joined.meeting.id } } });
    expect((await status.json()).result.structuredContent).toMatchObject({ ok: true, action: "show", meeting: { id: joined.meeting.id, title: "Transport test" } });
    const all = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "meetings_status", arguments: {} } });
    expect((await all.json()).result.structuredContent).toMatchObject({ ok: true, action: "list", meetings: [expect.objectContaining({ id: joined.meeting.id })] });
  });

  it("requires the personal Bearer token and rejects foreign origins and revoked tokens", async () => {
    const { tokens, post } = await fixture();
    const { token } = await tokens.create();
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meetings_list" } };
    expect((await post(request, headers, "/mcp-token")).status).toBe(401);
    const authorized = { ...headers, authorization: `Bearer ${token}` };
    expect((await post(request, authorized, "/mcp-token")).status).toBe(200);
    expect((await post(request, { ...authorized, origin: "https://evil.example" }, "/mcp-token")).status).toBe(403);
    await tokens.revoke();
    expect((await post(request, authorized, "/mcp-token")).status).toBe(401);
  });

  it("distinguishes protocol errors from recoverable action errors and rejects oversized bodies", async () => {
    const { post, harness } = await fixture();
    const unknown = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meetings_not_a_tool" } });
    expect((await unknown.json()).error.code).toBe(-32602);
    const badArgument = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "meetings_transcript", arguments: { id: "bad" } } });
    expect((await badArgument.json()).result).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "invalid_request" } } });
    const oversized = await harness.behavior.fetchHttp("POST", "/mcp", { headers, body: " ".repeat(AGENT_HTTP_BODY_BYTES + 1) });
    expect(oversized.status).toBe(413);
    const unsupported = await post({ jsonrpc: "2.0", id: 3, method: "ping" }, { ...headers, "mcp-protocol-version": "1900-01-01" });
    expect((await unsupported.json()).error).toMatchObject({ code: -32022, data: { supported: expect.any(Array) } });
    expect((await post([{ jsonrpc: "2.0", id: 4, method: "ping" }])).status).toBe(400);
  });

  it("bounds results without emitting partial or invalid JSON", async () => {
    const { harness, service, post } = await fixture();
    const joined = await harness.behavior.runCli(["join", uniqueZoomUrl(), "--json"]);
    const id = JSON.parse(joined.stdout).meeting.id;
    vi.spyOn(service, "logs").mockResolvedValue("x".repeat(AGENT_HTTP_RESULT_BYTES));
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meetings_logs", arguments: { id } } });
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThan(AGENT_HTTP_RESULT_BYTES);
    expect(JSON.parse(body)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { data: { code: "too_large" } } });
  });

  it("masks passcodes even in saved user text returned by additional actions", async () => {
    const { harness, service, post } = await fixture();
    const joined = await harness.behavior.runCli(["join", uniqueZoomUrl(), "--json"]);
    const id = JSON.parse(joined.stdout).meeting.id;
    service.update(id, { summaryMd: "Invite https://zoom.us/j/123456789?pwd=PrivatePasscode9" });
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meetings_summary", arguments: { id } } });
    const text = await response.text();
    expect(text).not.toContain("PrivatePasscode9");
    expect(JSON.parse(text).result.isError).toBe(false);
  });

  it("rejects excessive concurrent calls while existing ones finish normally", async () => {
    const { harness, service, post } = await fixture();
    const joined = await harness.behavior.runCli(["join", uniqueZoomUrl(), "--json"]);
    const id = JSON.parse(joined.stdout).meeting.id;
    let finish: (value: string) => void = () => {};
    const gate = new Promise<string>(resolve => { finish = resolve; });
    const logs = vi.spyOn(service, "logs").mockImplementation(() => gate);
    const message = (number: number) => ({ jsonrpc: "2.0", id: number, method: "tools/call", params: { name: "meetings_logs", arguments: { id } } });
    const running = Array.from({ length: 6 }, (_, index) => post(message(index)));
    await vi.waitFor(() => expect(logs).toHaveBeenCalledTimes(6));
    const excessive = await post(message(7));
    expect((await excessive.json()).result.structuredContent.error.code).toBe("rate_limited");
    finish("finished");
    for (const response of await Promise.all(running)) expect((await response.json()).result.isError).toBe(false);
  });

  it("offers no standalone SSE or server-side session mutation", async () => {
    const { harness } = await fixture();
    expect((await harness.behavior.fetchHttp("GET", "/mcp")).status).toBe(405);
    expect((await harness.behavior.fetchHttp("DELETE", "/mcp")).status).toBe(405);
    expect((await harness.behavior.fetchHttp("GET", "/mcp-token")).status).toBe(401);
    const auth = harness.inspection.registrations.httpRoutes.filter(route => ["/mcp", "/mcp-token", "/api", "/api-token"].includes(route.path));
    expect(auth.filter(route => !route.path.endsWith("-token")).every(route => route.auth === "local")).toBe(true);
    expect(auth.filter(route => route.path.endsWith("-token")).every(route => route.auth === "none")).toBe(true);
  });
});
