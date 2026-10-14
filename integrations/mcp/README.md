# Portable Meetings MCP (STDIO)

`stdio.mjs` is a standalone MCP server adapter for any BB installation with the Meetings plugin. It uses Node.js builtins and the official `bb meetings api` command. It contains no server addresses, machine paths, account credentials, OpenClaw dependencies or third-party tunnel service.

Requirements:

- Node.js 22 or newer.
- Meetings installed and enabled in the target BB.
- An authenticated official BB CLI on `PATH`, or the official absolute `BB_CLI` environment override. Run `bb status` and `bb meetings doctor --json` from the same account first.

Keep the adapter in the plugin checkout/package or copy `stdio.mjs` to a convenient directory. Configure any MCP client that supports STDIO:

```json
{
  "mcpServers": {
    "meetings": {
      "command": "node",
      "args": ["/path/to/bb-plugin-meetings/integrations/mcp/stdio.mjs"]
    }
  }
}
```

For clients launched outside your shell, supply `BB_CLI` if they cannot find `bb` on their inherited `PATH`. Authentication remains in the private configuration owned by the official CLI. The adapter does not create Meetings tokens, copy credentials, expose a port or change BB authentication.

Every JSON-RPC request goes to `bb meetings api --request-stdin --json`. Meeting links, questions and summaries travel on stdin rather than process arguments. The same backend dispatches STDIO and HTTP, so schemas, validation, passcode masking and the explicit deletion guard stay consistent. The transport wrapper itself is excluded from the MCP tools list.

Supported methods are `initialize` (2025 compatibility), `server/discover` (2026), `ping`, `tools/list`, `tools/call` and notifications. Messages use one UTF-8 JSON object per line; stdout contains only MCP replies. Cancellation aborts an in-flight CLI call and emits no cancelled reply. Notifications do not produce responses. Request lines are limited to 512 KiB, replies to 1 MiB; use transcript pagination. At most six CLI children run concurrently. A CLI transport failure returns a generic RPC error without forwarding its private diagnostics.

`notifications/cancelled` cancels the pending request rather than deleting or stopping a recorded meeting. Use `meetings_stop` explicitly to end a recording. The official protocol specifies [newline-delimited STDIO](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [cancellation behavior](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

An external integration can inject its existing CLI launcher through `runStdio({cli})`; the core driver remains independent of any particular agent or deployment.

Native authenticated HTTP remains available for direct local/private network access and clients with suitable BB authentication. A hosted `*.getbb.app` URL has an additional BB Connect gate: a Meetings Bearer token alone does not pass that gate. Use STDIO through the official enrolled CLI when the MCP client lacks a BB Connect owner session. Anonymous public ingress is a separate future deployment option and is not enabled by this adapter.

Run isolated transport tests with:

```sh
node --test integrations/mcp/stdio.test.mjs
```
