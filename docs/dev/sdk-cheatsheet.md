# BB Plugin SDK cheat sheet (`@get-bb/plugin-sdk` 0.6.37, bb 0.46.0)

What this is based on: the bundled declarations in
`node_modules/@get-bb/plugin-sdk/bundled-types/*.d.ts`, the bb 0.46.0 server,
CLI and app bundles, and the working `bb-plugin-gigaam`. Every snippet in §1–§9
was typechecked against 0.6.37. The CLI, HTTP Range, agent-tool, host-signal
and host-harness behavior was also run through the SDK test harnesses. If the
SDK version changes, run `bb plugin types --check`.

Declaration files:

| Import | Declarations |
|---|---|
| `@get-bb/plugin-sdk` (server, shared contracts) | `bundled-types/bb-plugin-sdk.d.ts` |
| `@get-bb/plugin-sdk/host` | `bundled-types/bb-plugin-sdk-host.d.ts` |
| `@get-bb/plugin-sdk/app` (frontend) | `bundled-types/bb-plugin-sdk-app.d.ts` |
| `@get-bb/plugin-sdk/testing` | `bundled-types/bb-plugin-sdk-testing.d.ts` |
| `@get-bb/plugin-sdk/testing/host` | `bundled-types/bb-plugin-sdk-testing-host.d.ts` |
| `@get-bb/plugin-sdk/testing/app` | `bundled-types/bb-plugin-sdk-testing-app.d.ts` |

Runtime exports of the package root: `defineRpcContract`, `experimental_defineHostEntry`,
`PLUGIN_CLI_OUTPUT_MAX_BYTES` (= 1048576), `PluginCliError`, `cliCommand`,
`defineCli`, `experimental_THREAD_ACTION_GROUPS`. Everything else, such as
`BbPluginApi`, is type-only.

---

## 1. Host entry (`host.ts`, manifest `bb.host`)

### Import path (verified with `bb plugin build`)

```ts
import { experimental_defineHostEntry, defineRpcContract } from "@get-bb/plugin-sdk"; // gigaam does this. USE THIS.
```

* For the host artifact, the builder replaces `@get-bb/plugin-sdk` with a stub module.
  The stub exports **only** `experimental_defineHostEntry`, `defineRpcContract` and
  `PLUGIN_CLI_OUTPUT_MAX_BYTES`. If any file in the host import graph (including
  `src/shared/*`) imports something else from the root at runtime, the build
  fails. Importing `PluginCliError`, `cliCommand` or `defineCli` gives:
  `No matching export in "bb-host-sdk-runtime:@get-bb/plugin-sdk" for import "PluginCliError"`.
  `import type { … }` is always fine.
* `@get-bb/plugin-sdk/host` also builds. The builder bundles it from
  `node_modules` when it can resolve it. If it cannot (a git install runs
  `npm install --omit=dev`, and the SDK is a devDependency), it falls back to
  the stub, which covers `experimental_defineHostEntry` **only**. If you import
  other `/host` helpers, such as `experimental_killProcessesWithCwdUnder` or
  `experimental_spawnPortableOutputProcess`, move `@get-bb/plugin-sdk` to
  `dependencies`.
* The host bundle is self-contained (ESM, node22, minified, ≤ 256 MiB). Pure-JS
  dependencies are bundled. Never import `@bb/*`; the build rejects it.
  Data files read at runtime must be embedded into TS (see §12).

### Exact types (`bb-plugin-sdk-host.d.ts`)

```ts
interface PluginRpcMethodContract<I extends StandardSchemaV1 = StandardSchemaV1, O extends StandardSchemaV1 = StandardSchemaV1> {
  readonly experimental_description?: string;
  readonly input: I;
  readonly output: O;
}
type PluginRpcContract = Readonly<Record<string, PluginRpcMethodContract>>;
declare function defineRpcContract<const Contract extends PluginRpcContract>(contract: Contract): Contract;

interface ExperimentalHostSignalContract<P extends StandardSchemaV1 = StandardSchemaV1> { readonly payload: P; }
type ExperimentalHostSignals = Readonly<Record<string, ExperimentalHostSignalContract>>;

interface ExperimentalHostPaths {
  readonly dataDir: string;  // persistent, per plugin per daemon. Here: /home/bb/.bb/plugins/meetings/host-data
  readonly tempDir: string;  // per worker process, deleted with it
}
interface ExperimentalHostWorkerLease { dispose(): Promise<void>; }  // idempotent

interface ExperimentalHostRpcContext<Signals extends ExperimentalHostSignals = {}> {
  readonly signal: AbortSignal;                       // this call: cancelled / timed out / worker disposed
  readonly lifecycle: { readonly signal: AbortSignal }; // the worker process: idle eviction, reload, disable, uninstall, daemon shutdown
  readonly experimental_paths: ExperimentalHostPaths;
  experimental_emitSignal<S extends keyof Signals & string>(signal: S, payload: StandardSchemaV1InferInput<Signals[S]["payload"]>): Promise<void>;
  experimental_watch(options: ExperimentalHostWatchOptions, listener: ExperimentalHostWatchListener): Promise<ExperimentalHostWatchSubscription>;
  experimental_retainWorker(): ExperimentalHostWorkerLease;
}
type ExperimentalHostRpcHandlers<C extends PluginRpcContract, S extends ExperimentalHostSignals = {}> = {
  [M in keyof C]: (input: InferOutput<C[M]["input"]>, context: ExperimentalHostRpcContext<S>)
    => InferInput<C[M]["output"]> | Promise<InferInput<C[M]["output"]>>;
};
declare function experimental_defineHostEntry<const C extends PluginRpcContract, const S extends ExperimentalHostSignals = {}>(args: {
  contract: C;
  experimental_signals?: S;
  handlers: ExperimentalHostRpcHandlers<C, S>;
  dispose?: () => void | Promise<void>;
}): ExperimentalHostEntry<C, S>;   // adds experimental_apiVersion: 1; never hand-build the object

// watch
interface ExperimentalHostWatchOptions { rootPath: string; ignoredPaths?: string[]; debounceMs?: number /*75, 10–5000*/; maxWaitMs?: number /*500, ≤30000*/ }
type ExperimentalHostWatchEvent =
  | { kind: "changed"; changes: { path: string; type: "create" | "delete" | "update" }[] }
  | { kind: "rescan-required" } | { kind: "watch-error"; message: string };
```

### Shared contract plus host entry

```ts
// src/shared/contract.ts (imported by BOTH server.ts and host.ts, so only stub-safe SDK imports)
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const hostContract = defineRpcContract({
  "meetings.readChunk": {
    experimental_description: "Read a byte range of a meeting file",
    input: z.object({ meetingId: z.string(), file: z.enum(["audio.ogg", "screen.jpg"]),
      offset: z.number().int().min(0), length: z.number().int().min(1).max(4 * 1024 * 1024) }).strict(),
    output: z.object({ size: z.number().int(), base64: z.string() }).strict(),
  },
  "meetings.status": { input: z.null(), output: z.object({ ok: z.boolean() }) },
});
export const hostSignals = {
  "meeting.changed": { payload: z.object({ meetingId: z.string(), phase: z.string() }).strict() },
} satisfies ExperimentalHostSignals;

// host.ts
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals } from "./src/shared/contract.js";
let lease: { dispose(): Promise<void> } | null = null;
export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    "meetings.readChunk": async ({ meetingId, file, offset, length }, ctx) => { /* fs read under ctx.experimental_paths.dataDir */ return { size: 0, base64: "" }; },
    "meetings.status": async (_input /* null */, ctx) => {
      lease ??= ctx.experimental_retainWorker();     // keep worker alive for background polling
      await ctx.experimental_emitSignal("meeting.changed", { meetingId: "m1", phase: "live" });
      return { ok: !ctx.signal.aborted };
    },
  },
  dispose: async () => { await lease?.dispose(); lease = null; },   // 5 s budget
});
```

### Worker lifecycle and limits

* The daemon starts the worker lazily on the first call and reuses one worker per plugin
  generation. After **5 min** with no active call, watch or lease, the worker
  stops gracefully. That idle stop does NOT emit `experimental_onWorkerExit`. The
  next call starts a fresh worker, so **module state is not durable**. Keep
  state in files, as DESIGN.md says. A crash fails in-flight calls and emits
  `experimental_onWorkerExit` to the server. A graceful reload, disable,
  uninstall or shutdown emits nothing.
* Limits: worker start ≤ 10 s. Per plugin, 256 active calls and 32 MiB of active
  input. Per call, **input ≤ 32 MiB of JSON and output ≤ 8 MiB** (base64 adds
  4/3, so raw chunks of ≤ 4 MiB are safe). Call timeout defaults to **30 s**,
  max 30 min (`timeoutMs`), with a 5 s cancel grace. 256 watches per worker,
  4096 ignore entries, 4096 paths per batch. Artifact ≤ 256 MiB. `dispose` ≤ 5 s.
* The host gets the user's normalized `PATH` without the daemon's `BB_*` env. Node 22.
* Host signals are ephemeral, validated and private to this plugin. Use them for
  invalidation and progress, never for durable state.
* Core never infers cwd, environment or host. Put absolute paths and ids in the typed input.

## 2. Server side of the host (`server.ts`)

```ts
interface PluginHosts {
  experimental_client<C extends PluginRpcContract, S extends ExperimentalHostSignals = {}>(args: {
    contract: C; experimental_signals?: S;
  }): ExperimentalHostClient<C, S>;
  ensureSharedPortTunnel(hostId: string): Promise<{ label: string; baseDomain: string }>;
  declareSharedPorts(hostId: string, ports: readonly number[]): void;
}
interface ExperimentalHostCallOptions {
  readonly hostId: string;          // REQUIRED, an explicit enrolled host
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;      // default 30_000, cap 30 min
}
interface ExperimentalHostClient<C, S> {
  call<M extends keyof C & string>(method: M, input: InferInput<C[M]["input"]>, options: ExperimentalHostCallOptions): Promise<InferOutput<C[M]["output"]>>;
  experimental_onWorkerExit(handler: (e: { readonly hostId: string }) => void | Promise<void>): () => void; // returns unsubscribe
  experimental_onSignal<N extends keyof S & string>(signal: N,
    handler: (e: { readonly hostId: string; readonly payload: InferOutput<S[N]["payload"]> }) => void | Promise<void>): () => void;
}
```

```ts
const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
const offSig = host.experimental_onSignal("meeting.changed", ({ hostId, payload }) =>
  bb.realtime.publish("meetings.changed", { id: payload.meetingId }));
const offExit = host.experimental_onWorkerExit(({ hostId }) => wakeReconcile());
bb.onDispose(() => { offSig(); offExit(); });

async function primaryHostId(): Promise<string> {
  const id = (await bb.sdk.system.config()).primaryHostId;   // string | null; null = no local enrolled host
  if (id === null) throw new Error("No primary machine is connected to bb");
  return id;
}
// Inside handlers/services/timers ONLY (calls made during the factory itself are rejected):
const r = await host.call("meetings.status", null, { hostId: await primaryHostId(), signal, timeoutMs: 10_000 });
```

* Create the client and subscribe in the factory. Make calls only after load
  completes, from RPC, HTTP, CLI or tool handlers, services or timers.
* gigaam's pattern: a `bb.background.service("reconcile")` loop. A wake function
  is triggered from `settings.onChange` and `experimental_onWorkerExit`, and the
  loop calls an idempotent `ensure` host method.

## 3. Settings (`bb.settings.define`)

```ts
type PluginSettingDescriptor =
  | { type: "string";  label: string; description?: string; secret?: true;
      experimental_multiline?: boolean;                 // not with secret
      experimental_schema?: StandardSchemaV1<string, string>; default?: string }
  | { type: "boolean"; label: string; description?: string; experimental_schema?: StandardSchemaV1<boolean, boolean>; default?: boolean }
  | { type: "number";  label: string; description?: string; experimental_schema?: StandardSchemaV1<number, number>; default?: number }
  | { type: "select";  label: string; description?: string; options: string[];
      experimental_optionLabels?: Record<string, string>;   // value → display label
      experimental_schema?: StandardSchemaV1<string, string>; default?: string }
  | { type: "project"; label: string; description?: string; experimental_schema?: StandardSchemaV1<string, string>; default?: string }; // stores a proj_* id

interface PluginSettingsHandle<Ds> {
  get(): Promise<Values<Ds>>;                                  // load-safe; call per use for freshness
  experimental_set(values: Partial<{ [K in keyof Ds]: ValueOf<Ds[K]> | null }>): Promise<Values<Ds>>; // null = unset
  onChange(listener: (next: Values<Ds>, prev: Values<Ds>) => void): void;  // additive
}
```

* Value types: boolean→`boolean`, number→`number`, every other type→`string`
  (select values are `string`, not a literal union, so cast them). **With
  `default` the value is non-optional. Without it, the type is `T | undefined`.**
* `experimental_schema` must be synchronous and must not transform (Zod is fine:
  `z.number().int().min(0).max(300)`). It runs on the server for UI autosave,
  `bb plugin config <id> set <k> <v>`, `experimental_set` and fake-host writes.
  The first issue is shown under the field. Use it for integer and range limits
  on numbers.
* Secrets are stored in a 0600 file under `<dataDir>/plugins/<id>/secrets/`. They
  are never in the db and never sent to the frontend; `useSettings()` omits them.
* A settings save does NOT reload a healthy or degraded plugin; `onChange`
  fires instead. A plugin in `needs-configuration` retries its load on save.

```ts
const settings = bb.settings.define({
  botName: { type: "string", label: "Имя бота", description: "Shown in Zoom", default: "bb Notetaker" },
  maxDurationMin: { type: "number", label: "…", experimental_schema: z.number().int().min(1).max(600), default: 240 },
  diarization: { type: "select", label: "…", options: ["ui+acoustic", "ui", "acoustic"],
                 experimental_optionLabels: { ui: "Только по интерфейсу" }, default: "ui+acoustic" },
  notifyThread: { type: "boolean", label: "…", default: true },
  icsFeeds: { type: "string", label: "…", experimental_multiline: true, default: "" },
});
settings.onChange((next, prev) => { if (next.maxDurationMin !== prev.maxDurationMin) wake(); });
```

## 4. Storage

```ts
interface PluginStorage {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<void>; list(prefix?: string): Promise<string[]> };   // JSON, ≤ 256 KB per value
  database(): Database.Database;   // better-sqlite3 at <dataDir>/plugins/<id>/data.db, WAL, busy_timeout 5000
  migrate(db: Database.Database, statements: string[]): void;
}
```

```ts
const db = bb.storage.database();          // same handle for the whole load; cheap to call per request
bb.storage.migrate(db, [
  `CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX meetings_created ON meetings(created_at)`,
  // APPEND ONLY. Index = migration id in _bb_migrations; the hash of each statement is recorded,
  // so editing or reordering a shipped statement is rejected. Pending statements run in one transaction.
]);
const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
```

* The handle is closed on dispose or reload, and a closed handle throws. Never
  keep it in module state across loads. Types come from `@types/better-sqlite3`
  (devDependency). At runtime the server provides `better-sqlite3`; the server
  bundle leaves it external.

## 5. RPC, realtime, frontend data

```ts
// bb.rpc.register: POST /api/v1/plugins/<id>/rpc/<method>, always "local" auth
register<C extends PluginRpcContract>(contract: C, handlers: {
  [M in keyof C]: (input: InferOutput<C[M]["input"]>, context: { readonly experimental_caller:
      { readonly kind: "plugin"; readonly pluginId: string } | { readonly kind: "client" } })
    => InferInput<C[M]["output"]> | Promise<InferInput<C[M]["output"]>>;
}, options?: { experimental_discoverable?: boolean; experimental_description?: string }): void;

// bb.realtime
publish(channel: string, payload: unknown): void;   // WS {type:"plugin-signal", pluginId, channel, payload}; undefined→null; not persisted; no per-channel subscriptions
```

* Method names must match `^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$`, so `meetings.list` is fine.
* Input is validated before the handler runs, and output after it. The wire
  envelope is `{ ok: true, result } | { ok: false, error: { code, message, issues? } }`.
  The codes are `invalid_json`, `invalid_input` (400), `unknown_method` (404),
  `handler_error`, `invalid_output` and `non_json_result` (500). Results must
  be strict JSON: no `undefined`, `Date`, bigint, class instances or NaN.
* Use `input: z.null()` so that the frontend can call `rpc.call("x")` with no argument.
* Frontend:

```tsx
import { useRpc, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./src/shared/rpc-contract";   // TYPE-ONLY import
const rpc = useRpc<typeof rpcContract>();      // stable; { call(method, ...args) } typed from the contract
const out = await rpc.call("meetings.get", { id });   // rejects with Error(message) carrying .code/.issues
useRealtime("meetings.changed", (payload: unknown) => refetch());  // only this plugin's channels, while mounted
const conn = useRealtimeConnectionState();     // "connecting" | "connected" | "reconnecting"; refetch on a LATER transition to "connected"
```

Pattern: publish small invalidation signals and let the page refetch over RPC.

## 6. HTTP routes (`bb.http.route`), binary bodies, Range, auth

```ts
type PluginHttpAuthMode = "local" | "none" | "token";
type PluginHttpHandler = (context: Context /* hono */) => Response | Promise<Response>;
route(method: string, path: string, handler: PluginHttpHandler, opts?: { auth?: PluginHttpAuthMode }): void;
experimental_websocket(path: string, handler: (ctx: { request: Request; url: URL; headers: Headers }) =>
  { onOpen?; onMessage?; onClose?; onError? }, opts?: { auth?: PluginHttpAuthMode }): void;
```

* URL: **`/api/v1/plugins/<pluginId>/http/<path>`**. For this plugin it is
  `/api/v1/plugins/meetings/http/audio?id=mtg_x`.
* Methods: GET POST PUT PATCH DELETE HEAD OPTIONS. The path must start with `/`
  and is matched **exactly**. `:` and `*` are literal characters, so there are
  no path params. Pass ids as **query params** and read them with
  `c.req.query("id")`. **HEAD is not mapped to GET.** A HEAD request to a
  GET-only route returns 404, so register `"HEAD"` too if you need it.
* Hono `Context`: `c.req.query(k)`, `c.req.header("range")`, `c.req.json()`,
  `c.req.raw` (the Fetch `Request`; `c.req.raw.signal` aborts on disconnect),
  `c.json(obj, status)`, `c.body(bytes, status, headersRecord)`. You can also
  return any `new Response(body, init)`. The server re-wraps
  `ReadableStream` bodies and **streams** them, so they are not buffered.
* A thrown error gives 500 `{ ok:false, error:"plugin route failed: …" }`. If the
  plugin is not running, the response is 503. Duplicate method+path registration throws.
* Use `import type { Context } from "hono"` only. A runtime `hono/*` import
  (for example `hono/streaming`) gets **bundled** into `dist/server.js` (verified).
  Then `hono` must be in `dependencies`, or git installs break. A plain
  `Response` with a `ReadableStream` is enough.

Auth modes, from the server source (`browserRequestProblem` and `tokenAuthProblem`):

| mode | check |
|---|---|
| `"local"` (default) | An `Origin` header is checked only **if present**; it must be a trusted bb app origin, otherwise 403. Methods other than GET, HEAD and OPTIONS need `content-type: application/json`, otherwise 415. |
| `"token"` | `x-bb-plugin-token` header or `?token=`. Print the token with `bb plugin token <id>` (`--rotate` replaces it). |
| `"none"` | No checks. Use only for webhooks that verify their own signature. |

**`<audio src>` and `<img src>` work with `"local"`.** These are no-cors GETs,
and browsers send no `Origin` header on them. With `crossOrigin` set, the
`Origin` is the app origin, which is trusted. Same-origin cookies, if any, are
sent. Use the **relative** URL, because the plugin UI runs on the bb app origin:

```tsx
<audio controls preload="metadata" src={`/api/v1/plugins/meetings/http/audio?id=${encodeURIComponent(id)}`} />
<img src={`/api/v1/plugins/meetings/http/screenshot?id=${id}&v=${updatedAt}`} alt="" />  {/* v= busts cache */}
```

Binary and Range example. It was verified in the fake host: a full GET returns
200 with all bytes, and `Range: bytes=100-199` returns 206,
`content-range: bytes 100-199/10000` and 100 bytes.

```ts
bb.http.route("GET", "/audio", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  const hostId = await primaryHostId();
  const CHUNK = 4 * 1024 * 1024;                                   // ≤ 8 MiB host output after base64
  const { size } = await host.call("meetings.readChunk", { meetingId: id, file: "audio.ogg", offset: 0, length: 1 }, { hostId });
  let start = 0, end = size - 1, status: 200 | 206 = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else start = Math.max(0, size - Number(m[2]));               // suffix range "bytes=-N"
    if (start >= size || start > end)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    end = Math.min(end, start + CHUNK - 1);                       // answering with a shorter 206 is legal; the browser asks again
    status = 206;
  }
  const signal = c.req.raw.signal;
  let offset = start;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (offset > end) return ctl.close();
      const r = await host.call("meetings.readChunk",
        { meetingId: id, file: "audio.ogg", offset, length: Math.min(CHUNK, end - offset + 1) }, { hostId, signal });
      const bytes = Buffer.from(r.base64, "base64");
      if (bytes.length === 0) return ctl.close();
      offset += bytes.length;
      ctl.enqueue(new Uint8Array(bytes));
    },
  });
  const headers: Record<string, string> = { "content-type": "audio/ogg", "accept-ranges": "bytes",
    "content-length": String(end - start + 1), "cache-control": "private, no-cache" };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status, headers });
});

bb.http.route("GET", "/screenshot", async (c) => {
  const bytes: Uint8Array = /* ≤ 4 MiB via host */ new Uint8Array();
  return c.body(bytes, 200, { "content-type": "image/jpeg", "cache-control": "no-store" });
});
```

There is a built-in alternative with Range, ETag and 304 included:
`bb.sdk.files.createPreview({ hostId?, rootPath /*absolute dir on that host*/, ttlMs? /*60_000–3_600_000, default 600_000*/ })`
returns `{ baseUrl: "/api/v1/file-previews/<uuid>", expiresAtMs }`. Serve
`${baseUrl}/${encodeURIComponent(relativeName)}`; the server streams it in 1 MiB
host chunks with full Range support. Leases live in server memory and expire,
or are lost on a server restart, so mint them on demand (for example from an
RPC) and never store them. `bb.sdk.files.read({ hostId?, path, rootPath? })` and
`write(...)` also exist (write is limited to 25 MB). Omitting `hostId` means
`primaryHostId`.

## 7. CLI (`bb.cli.register(defineCli({...}))`)

```ts
declare function defineCli(spec: PluginCliSpec): PluginCliRegistration;
interface PluginCliSpec {
  name: string;                      // bb <name>; ^[a-z0-9-]+$; core names win (then only `bb plugin run <id>`)
  summary: string; description?: string;
  root?: PluginCliCommand;           // runs when no command named
  commands: Record<string, PluginCliCommand>;   // keys are invocation paths: "join", "transcript show"
  usageErrorExitCode?: number;       // default 1
}
declare function cliCommand<const TOptions extends CliOptions = Record<string, never>, const TPositionals extends CliPositionals = readonly []>(command: {
  summary: string; description?: string;
  aliases?: readonly string[];       // extra invocation paths (hidden)
  suggestFor?: readonly string[];    // typos that suggest this command
  hidden?: boolean;
  options?: TOptions; positionals?: TPositionals;
  constraints?: readonly PluginCliConstraint[];
  passthrough?: boolean;             // tokens after `--` → input.passthrough
  unexpectedPositionalHint?: string;
  run(input: PluginCliRunInput<TOptions, TPositionals>, ctx: PluginCliContext): PluginCliResult | Promise<PluginCliResult>;
}): PluginCliCommand;

// option base (all types): description: string (REQUIRED); aliases?: string[]; short?: "j"; hidden?: boolean; placeholder?: string; stdin?: boolean (--<name>-stdin)
type PluginCliOption =
  | { type: "boolean" }                                                          // → boolean (absent = false)
  | { type: "string";  required?: boolean; repeatable?: boolean; split?: string /*needs repeatable*/; default?: string }
  | { type: "integer"; min: number; max: number /*BOTH REQUIRED*/; required?: boolean; default?: number }
  | { type: "enum";    values: readonly string[]; required?: boolean; repeatable?: boolean; split?: string; default?: string } // → literal union
  | { type: "duration"; defaultUnit: "d"|"h"|"m"|"ms"|"s" /*REQUIRED*/; bareUnits?: Unit[]; min?: number; max?: number /*ms*/;
      required?: boolean; default?: number /*ms*/ };                             // → number (ms); "90s", "10m", bare "90" uses defaultUnit
// There is NO "number" option type (tsc: '"number"' is not assignable). Use integer or a string you parse yourself.
// Resolved type: boolean→boolean; repeatable→T[]; required or default→T; otherwise T | undefined.

interface PluginCliPositional { name: string; description: string; required?: boolean; variadic?: boolean /*→ string[]*/ }
type PluginCliConstraint =
  | { kind: "exactly-one" | "at-most-one" | "at-least-one"; options: readonly string[] }
  | { kind: "requires"; option: string; needs: readonly string[] };
interface PluginCliRunInput<O, P> { options: Values<O>; positionals: Values<P>; passthrough: string[]; help: string }
interface PluginCliContext { cwd?: string; threadId?: string; projectId?: string; signal?: AbortSignal } // ALL optional
interface PluginCliResult { exitCode: number; stdout?: string; stderr?: string }
declare class PluginCliError extends Error {
  readonly code: string; readonly hint: string | undefined; readonly exitCode: number;
  constructor(message: string, options?: { code?: string; hint?: string; exitCode?: number });
}
```

```ts
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";   // server only (NOT in host graph)
bb.cli.register(defineCli({
  name: "meetings", summary: "Record and transcribe meetings",
  commands: {
    join: cliCommand({
      summary: "Join a Zoom meeting",
      positionals: [{ name: "url", description: "Zoom link", required: true }],
      options: {
        name: { type: "string", description: "Bot display name", aliases: ["bot-name"], placeholder: "NAME" },
        minutes: { type: "integer", min: 1, max: 600, default: 240, description: "Max minutes, 1-600" },
        wait: { type: "duration", defaultUnit: "s", min: 0, max: 600_000, default: 60_000, description: "How long to wait for the join" },
        mode: { type: "enum", values: ["live", "offline"], default: "live", description: "Transcription mode" },
        tag: { type: "string", repeatable: true, split: ",", description: "Tags" },
        json: { type: "boolean", short: "j", description: "Print JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["name", "json"] }],
      async run(input, ctx) {
        // input.positionals.url: string; input.options.minutes: number; .wait: number(ms); .mode: "live"|"offline"; .tag: string[]
        if (!ok) throw new PluginCliError("Not a Zoom link", { code: "invalid_url", hint: "Pass https://…zoom.us/j/<id>", exitCode: 2 });
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : text };
      },
    }),
    "transcript show": cliCommand({ summary: "Print a transcript",
      positionals: [{ name: "ids", description: "Meeting ids", variadic: true }],
      run: (input) => ({ exitCode: 0, stdout: input.positionals.ids.join("\n") }) }),
  },
}));
```

Behavior, verified in the harness:

* `--help`, `-h` and a leading `help` print the full help and exit 0. Option
  defaults and constraints appear in it.
* All missing required values are reported in one error with the usage line, exit 1.
* `PluginCliError` puts `"msg (hint)"` on stderr. With `--json`, stdout also gets
  `{"ok":false,"error":{"code","message","hint"}}`, and the exit code is the
  `exitCode` you set.
* Any other throw gives `{ exitCode: 1, stderr: "bb <name> failed: …" }`.
* stdout and stderr together must be ≤ `PLUGIN_CLI_OUTPUT_MAX_BYTES` (1 MiB).
  Larger output is rejected whole with `plugin_cli_output_too_large`; it is
  never clipped. Paginate.
* `run` executes in the **server process**. A path argument names a file on the
  *invoking* machine. Use `bb.sdk.files` with an explicit `hostId`, not `node:fs`.
* `ctx.threadId` and `ctx.projectId` are set when an agent thread runs the
  command. Put the command's docs in `skills/<name>/SKILL.md`, because agents
  learn commands from the generated plugin-commands skill.

## 8. Agent tools and instructions (`bb.agents`)

```ts
registerTool<Schema extends z.ZodType>(tool: {
  name: string;                 // ^[a-zA-Z0-9_-]+$, unique ACROSS plugins (the later one is dropped and noted in status detail)
  description: string;
  instructions?: string;        // ≤ 4096 chars; appended to thread instructions while the tool is in the session
  presentation?: {              // timeline row
    label?: { pending: string; completed: string };      // each ≤ 80 chars, plain text
    icon?: { glyph: string };   // host glyph ("Mic") or "<pluginId>/<name>" from bb.branding.experimental_icons
    suppress?: boolean;         // collapsed by default
    tint?: { light: string; dark: string };
  };
  parameters: Schema;           // zod 4; validated per call (bad args → tool error); sent to the model as JSON Schema 2020-12
  execute(params: z.output<Schema>, ctx: PluginAgentToolContext): PluginAgentToolResult | Promise<PluginAgentToolResult>;
}): void;
// overload: parameters: Record<string, unknown> (raw JSON schema) → execute(params: unknown, ctx)

interface PluginAgentToolContext { threadId: string; projectId: string; signal: AbortSignal }
type PluginAgentToolResult = string | {
  content: ({ type: "text"; text: string } | { type: "image"; data: string /*base64*/; mimeType: string })[];
  isError?: boolean;
};

contributeInstructions(provider: (ctx: { threadId: string; projectId: string }) => string | null): void; // SYNC, fast, ≤4096, once per factory
configure(provider: (context: PluginAgentConfigurationContext) =>
  { tools: Array<string | { name: string; parameters: Record<string, unknown> }>; skills: string[]; instructions?: string }): void; // optional, once
```

```ts
bb.agents.registerTool({
  name: "meetings_join",
  description: "Join a Zoom meeting with the notetaker bot, record and transcribe it.",
  presentation: { label: { pending: "Подключаю бота к встрече", completed: "Бот подключён к встрече" }, icon: { glyph: "Mic" } },
  parameters: z.object({ url: z.string().url(), title: z.string().optional() }),
  async execute({ url, title }, { threadId, projectId, signal }) {
    const m = await startMeeting({ url, title, requestedByThreadId: threadId });
    return JSON.stringify(m);   // a string is the simplest return; { content, isError: true } reports failure
  },
});
```

* Tool and instruction changes apply when the provider session is **next
  started or resumed**, never in the middle of a session.
* Without `configure`, every registered tool (and every manifest skill) is
  offered. That is how the fake host resolves it, and the docs agree.
* Order of instructions: bb's own, then tool snippets, then
  `contributeInstructions`, then `configure.instructions`, then user and
  workspace instructions.
* Prefer `skills/` for standing knowledge. Use instructions only for live state.

## 9. Posting into an existing thread (`bb.sdk.threads`)

`bb.sdk` is bind-gated. The real server binds it before factories run, but
prefer using it from handlers.

```ts
send(args: ThreadSendArgs): Promise<ThreadSendResult>;
interface ThreadSendArgs /* = SendMessageRequest & */ {
  threadId: string;
  mode: "auto" | "start" | "steer" | "steer-if-active" | "queue-if-active";   // REQUIRED
  input: Array<
    | { type: "text"; text: string; mentions: Mention[] /* REQUIRED in TS (zod default), pass [] */; visibility?: "agent-only" }
    | { type: "image"; url: string; visibility?: "agent-only" }
    | { type: "localImage"; path: string; hostId?: string; sourceProjectId?: string; visibility?: "agent-only" }
    | { type: "localFile"; path: string; hostId?: string; mimeType?: string; name?: string; sizeBytes?: number; sourceProjectId?: string; visibility?: "agent-only" }>;
  model?: string; permissionMode?: "accept-edits" | "auto" | "full"; reasoningLevel?: "none"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"|"ultracode";
  serviceTier?: string; sendAt?: number /*epoch ms*/; senderThreadId?: string;
  pluginSubmission?: { pluginId: string; data: JsonValue }; executionInputSources?: {...};
}
type Mention = { start: number; end: number /*UTF-16 offsets into text*/; resource:
  | { kind: "thread"; label: string; threadId: string; projectId?: string }
  | { kind: "project"; label: string; projectId: string } | { kind: "section"; label: string; sectionId: string }
  | { kind: "path"; label: string; path: string; entryKind: "file" | "directory"; source: "workspace" | "thread-storage" }
  | { kind: "plugin"; label: string; pluginId: string; itemId: string; icon?: string | null } | { kind: "attachment"; label: string; path: string } | /* command */ ... };
type ThreadSendResult = { ok: true; delivery: "sent" } | { ok: true; delivery: "queued"; queuedMessage: { id: string; waitingOn: {kind: "thread-busy"|"time"|"host-offline"|"interaction"|"plugin"|…} | null; … } };
```

`mode` semantics, from the server's `resolveSendMode` and dispatch code:

| mode | idle / error thread | active thread |
|---|---|---|
| `"queue-if-active"` (CLI `--mode queue`) | starts a new turn | queued as a new turn (`waitingOn: thread-busy`) and starts when the thread is idle |
| `"auto"` (CLI `--mode auto`) | starts a turn | steers into the running turn |
| `"steer-if-active"` (CLI default) | starts a turn (also from `error`) | steers |
| `"steer"` | starts if `idle`, errors otherwise | steers |
| `"start"` | starts | error `already_active` |

To notify the requesting thread without interrupting it, use `"queue-if-active"`:

```ts
const res = await bb.sdk.threads.send({
  threadId: meeting.requestedByThreadId,
  mode: "queue-if-active",
  input: [{ type: "text", mentions: [], text:
    `Встреча «${title}» (${id}) завершена: ${dur}, спикеры: ${names}. Транскрипт: \`bb meetings transcript ${id}\`.` }],
});
// res.delivery === "sent" | "queued"
```

```ts
get(args: { threadId: string; include?: string; signal?: AbortSignal }): Promise<ThreadResponse | ThreadWithIncludesResponse>;
// ThreadResponse: id, projectId, title (string|null), titleFallback, status ("pending"|"starting"|"active"|"idle"|"error"|"stopping"),
//   environmentId, providerId, parentThreadId, sourceThreadId, visibility, archivedAt, deletedAt, createdAt, updatedAt, originKind, originPluginId, …
```

* A thread that was deleted or is stopping throws on `send`. Catch it and log;
  don't fail the meeting.
* Thread links:
  * App route: `/threads/<threadId>` for the personal project, otherwise
    `/projects/<projectId>/threads/<threadId>`. `/threads/<id>` alone also
    resolves. Append `#msg=<seq>` to deep-link a message.
  * In the frontend, use `useBbNavigate().toThread(threadId, { split?: boolean })`.
  * For an absolute URL, use `bb.server.experimental_appUrl`, which is
    `string | null` (`BB_APP_URL`). The loopback `bb.server.loopbackBaseUrl` is not for users.
  * Inside message input, a `{ kind: "thread" }` mention renders as a thread pill.
* Other areas: `threads.spawn({ projectId, environment: { type: "project-default" }, prompt | input, title?, visibility?, pluginMetadata? })`,
  `threads.list`, `threads.timeline`, `threads.output`,
  `threads.getPluginMetadata` and `threads.updatePluginMetadata` (pluginId
  defaults to yours).

## 10. Background, lifecycle, status

```ts
bb.background.service(name /*^[a-zA-Z0-9_-]+$*/, { start(signal: AbortSignal): void | Promise<void> }): void;
// starts after the factory; MUST resolve soon after `signal` aborts (5 s, else the plugin shows "degraded (service did not stop)").
// A crash, including an uncaught error in a timer or EventEmitter, restarts it with capped exponential backoff.
bb.background.schedule(name, cron /*5-field, server-local time*/, fn: () => void | Promise<void>): void;
// durable row (pluginId, name); fires only while loaded; a throw only sets last_status/last_error (bb plugin list)
bb.onDispose(hook: () => void | Promise<void>): void;   // LIFO; reload/disable/shutdown
bb.onInstall(handler: () => void | Promise<void>): void; // once after a fresh install (≤ 30 s)
bb.status.needsConfiguration(message: string): void;    // the ONLY status method
bb.log.debug|info|warn|error(message: string): void;     // `bb plugin logs <id> -f`
bb.events.on("thread.idle" | "thread.deleted" | …, handler)  // observe-only, fire-and-forget
```

* There is no `degraded`, `error` or `ready` API. The host derives those states:
  `error` when the factory throws (30 s budget), `degraded` when a service
  ignores abort. To get `needs-configuration`, call
  `bb.status.needsConfiguration(msg)` in the factory, or throw
  `Object.assign(new Error(msg), { name: "NeedsConfigurationError" })` from a
  service. It is matched by name, so no import is needed. The state is cleared
  on the next load.
* Sleeps must wake on abort:
  `await new Promise<void>(r => { const t = setTimeout(r, ms); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); })`.
* Reload order: the candidate factory runs first. If it throws, the old
  generation stays. Then the old host artifact is disposed, services are
  aborted (5 s each), `onDispose` hooks run LIFO, in-flight handlers get 5 s,
  and db handles close. **A `bb` object captured from an old load throws
  `PluginContextStaleError`.** Never store `bb` in module scope.
* An instance of a stopped or reloaded plugin can still be running in host
  workers until their next call. Detached processes (bots) survive reloads by design.

## 11. Frontend (`app.tsx`, `@get-bb/plugin-sdk/app`)

Exports: `definePluginApp`, `useRpc`, `useRealtime`,
`useRealtimeConnectionState`, `useSettings`, `useBbContext`, `useBbNavigate`,
`useSdk`, `useComposer`, `useComposers`, `useEnvironmentProviders`,
`experimental_Icon`, `experimental_ProviderIcon`, `Markdown`, `UrlLink`,
`ThreadChat`, `ThreadTitle`, `experimental_copyToClipboard`,
`experimental_usePluginId`, `experimental_FileLink`, `experimental_SourceCode`,
`experimental_Diff`, `experimental_useAppPanel`,
`experimental_useFixedTabTarget`, `experimental_useSidebarThreads`,
`experimental_ThreadStatusGlyph`, `experimental_VoiceInputTextarea`, and
others, plus types (`PluginNavPanelProps`, …).

```ts
declare const definePluginApp: (setup: (app: PluginAppBuilder) => void /* SYNC */) => PluginAppDefinition; // must be the default export
interface PluginNavPanelRegistration {
  id: string;                 // [A-Za-z0-9_-]
  title: string;
  icon: string;               // BbIconName; unknown → plugin branding
  path: string;               // route /plugins/<pluginId>/<path>/*  ([A-Za-z0-9_-])
  component: ComponentType<PluginNavPanelProps>;
  headerContent?: ComponentType<PluginNavPanelProps>;   // right side of the title bar
  fixedTabs?: readonly PluginFixedTabDeclaration[];     // experimental right-panel tabs
  experimental_sidebarAccessory?: ComponentType;        // not mounted anywhere yet
}
interface PluginNavPanelProps { subPath: string }      // route remainder after the panel root, "" at root
interface PluginSettingsSectionRegistration { id: string; title?: string; description?: string; component: ComponentType<{}>; experimental_page?: "mobile" }
interface BbNavigate {
  toThread(threadId: string, options?: { split?: boolean }): void;
  toProject(projectId: string): void;
  toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }): void;   // own panels only; back/forward walk subPaths
  toCompose(options?: { projectId?: string; initialPrompt?: string; focusPrompt?: boolean;
    placement?: { sectionId: string | null; pinned: boolean }; environmentId?: string; hostId?: string }): void;
  openThreadPanel(options: { actionId: string; title?: string; params?: JsonValue }): boolean;
  openUrl(url: string): boolean;                          // http(s) via bb browser preference
  experimental_openFilePreview(o): boolean; experimental_openFileExternally(o): boolean;
  experimental_openTerminal(o: { terminalId: string }): Promise<boolean>;
}
useSettings(): { values: Record<string, string | number | boolean> | undefined /* non-secret only */; isLoading: boolean };
useBbContext(): { projectId: string | null; threadId: string | null };
useSdk(): PluginBrowserBbSdk;                             // same areas as bb.sdk, user session, stable reference
experimental_copyToClipboard(content: { text: string; html?: string }): Promise<boolean>;
```

```tsx
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "meetings", title: "Встречи", icon: "Mic", path: "meetings", component: MeetingsPage });
  app.slots.settingsSection({ id: "runtime", title: "Среда выполнения", description: "Проверка и установка", component: RuntimeSection });
});
function MeetingsPage({ subPath }: PluginNavPanelProps) {   // "" = list, "m/<id>" = detail
  const nav = useBbNavigate();
  const open = (id: string) => nav.toPluginPanel("meetings", { subPath: `m/${id}` });
  …
}
```

The settings sidebar shows the plugin when it declares settings descriptors OR
registers a `settingsSection`. The section renders below the auto-generated
descriptor form. The page frame of the scaffold matches bb's own pages:
`<div className="h-full min-h-0 flex-1 overflow-y-auto"><div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">`.

### Icons (`components/ui/icon.tsx` re-exports `experimental_Icon`)

`<Icon name="Mic" className="size-4" fallback="Zap" aria-label="…" />` takes
props `{ name: string; fallback?: string /*default "Zap"*/; className?; style?; "aria-hidden"?; "aria-label"? }`.
Names are matched **exactly** (case-sensitive), with no lucide aliases. The
lookup order is: a name registered at runtime with
`app.experimental_icons.register`, then a built-in, then
`"<pluginId>/<name>"` from the manifest's `bb.branding.experimental_icons`,
then `fallback`, then Zap. `IconName` is just `string`, so tsc does NOT catch
typos. The list below was extracted from the bb 0.46.0 app registry.

From the requested list:

| Exists | Does NOT exist (use instead) |
|---|---|
| Mic, Calendar, Play, Pause, Square, Download, Trash2, Search, Clock, ExternalLink, Copy, Check, X, AlertTriangle, FileText | **Video** (→ register your own or use `Mic`/`AppWindow`), **RefreshCw** (→ `RotateCcw` / `Repeat` / `ArrowReloadHorizontal`), **Users** (→ `UserRound`, `UserRoundPlus`), **Pencil** (→ `Edit` / `EditFile`), **Loader** (→ `Loading` or `Spinner`, the same glyph; add `animate-spin` yourself) |

Also missing: Camera, Image, Upload, Save, Share, Stop/CircleStop, Phone,
Speaker, Volume2, Headphones.

The 55 core icons (bundled):
AlertCircle AlertTriangle Archive Bot Bug Check ChevronDown ChevronLeft
ChevronRight Circle CircleCheck CircleQuestion CircleX ClosePluginPane
CloseThreadPane Code ComputerTerminal01 Copy Download Edit Filter
FilterHorizontal Folder FolderExport FolderGit FolderPlus FolderSync
FolderUnknown Folder02 Home Info ListTodo Loading MessageQuestion
MessageCirclePlus MessageSquarePlus MessageSquare MoreHorizontal PanelLeft
Search SectionAdd SectionMove Settings SlidersHorizontal Spinner Target
Terminal Toolbox ToolCase Trash2 Unavailable UserRoundPlus Workflow X Zap

The 121 extended icons are lazy-loaded on first use; the icon is blank for a moment:
AiBrain01 AiBrowser AiContentGenerator01 AlignLeft AppWindow ArchiveRestore
ArrowDown ArrowLeft ArrowRight ArrowReloadHorizontal ArrowUp ArrowUpDown
ArrowTurnBackward ArrowTurnForward ArrowUpRight Beaker BellDot Browser Brain
Calendar CalendarCheckOut02 ChartColumn ChevronUp ChevronsDown ChevronsUp
CircleArrowShrink Clean Clock ClockArrowUp ClockArrowDown Cloud CloudOff
ComputerCloud Coffee Columns2 CornerDownLeft CornerDownRight DiffAdded
DiffConflict DiffModified DiffRemoved DiffRenamed Discord DiscordLogo DateTime
Github GithubLogo DragDropHorizontal DragDropVertical EditFile ElectricPlugs Eye
EyeOff Explore ExternalLink FileDiff File FileAttachment FileQuestion FileText
FolderOpen FolderEdit FolderMinus Fork GitBranch GitMerge GitPullRequest
GitPullRequestArrow GitPullRequestClosed GitPullRequestDraft Globe GridView
Keyboard Laptop Layers Limitation Link ListEnd ListView Lock Mail MailOpen
Maximize2 Mic Minus Minimize2 MoveTo NewTab News01 PackageReceive Palette
PanelBottom PanelRight Paperclip Pause Pin PinOff Play Plug02 Plus Puzzle Repeat
RotateCcw Rows2 SecurityCheck Sent SideChat Smartphone Sort SortingAZ02
SortingZA01 SortingOneNine SortingNineOne Square SquareUnlock02 Star TextWrap
TimeSchedule UserRound ZoomIn ZoomOut

For missing glyphs there are two options:

1. Register an inline component in setup:
   `app.experimental_icons.register({ name: "meetings-video", component: ({ className }) => <svg className={className} …stroke="currentColor"/> })`.
   It works only while the app bundle is loaded.
2. Declare it in the manifest:
   `"branding": { "experimental_icons": { "video": "./icons/video.svg" } }`,
   then use it as `"meetings/video"`. It works everywhere, including tool
   `presentation.icon.glyph`. Names match `[a-z0-9][a-z0-9-]*` (≤ 48 chars,
   ≤ 64 icons). Each file is a monochrome SVG ≤ 32 KiB with no
   script/style/image/foreignObject/href elements, drawn as a currentColor mask.

### Styling and components

* Tailwind classes compile against the host theme's CSS variables. Use only
  token classes with `bg-` `text-` `border-` `ring-`: `background`
  `foreground` `card` `card-foreground` `popover` `muted` `muted-foreground`
  `subtle-foreground` `accent` `accent-foreground` `primary`
  `primary-foreground` `secondary` `secondary-foreground` `destructive`
  `destructive-foreground` `destructive-text` `success` `success-foreground`
  `warning` `warning-text` `attention` `border` `border-hairline` `input`
  `ring` `state-hover` `state-active` `surface-raised` `surface-recessed`
  `surface-selected` `surface-attention` `surface-destructive` `surface-scrim`
  `timeline-accent` `diff-added` `diff-removed` `sidebar*`.
  Default-palette utilities (`text-red-500`) compile too, but they break custom
  themes. Never add `@theme` colors or hand-set oklch values or grays.
  Patterns: `text-muted-foreground`, `border-border`, `bg-card`,
  `divide-border`, `text-destructive`, `animate-pulse` for a recording dot,
  `bg-destructive`.
* Vendored (you own them, `@/` alias): `components/ui/button.tsx` (variants
  default, destructive, outline, secondary, ghost, link; sizes default, sm, lg,
  icon), `card.tsx` (Card, CardHeader, CardTitle, CardDescription, CardContent,
  CardFooter), `input.tsx`, `checkbox.tsx`, `dialog.tsx` (Dialog, DialogTrigger,
  DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
  DialogClose; a bottom drawer on compact screens), `responsive-overlay.tsx`,
  `icon.tsx`, and `lib/utils.ts` (`cn`).
* Add more with `npx shadcn add @bb/<name>` (registry pinned to desktop-v0.46.0
  in `components.json`). About 46 items: select, dropdown-menu, tabs, table,
  badge, tooltip, alert-dialog, slider, progress, skeleton, empty-state, …
  Run `npm install` afterwards.
* Toasts: `import { toast } from "sonner"` uses the host Toaster. Never mount `<Toaster>`.
* Shimmed and never bundled (keep them as type-only **devDependencies**): react,
  react-dom, the portal radix families, sonner, vaul, @pierre/diffs, clsx,
  tailwind-merge, class-variance-authority. Everything else (zod, non-portal
  radix such as `react-checkbox` and `react-slot`, lucide if you add it) is
  bundled from **dependencies**.
* `Markdown` (`{ content: string; className? }`) renders like a chat message.
  `UrlLink` (`<a>` props plus `href`) opens via bb's browser preference.

## 12. Manifest, build, embedding, skills

```jsonc
"bb": {
  "name": "Meetings", "description": "…",
  "branding": {
    "icon": "./assets/icon.svg",          // OR a host icon name like "Mic"; "<pluginId>/<x>" is REFUSED here
    "experimental_icons": { "video": "./icons/video.svg" },   // optional, referenced as "meetings/video"
    "logo": { "light": "./assets/logo.svg", "dark": "…" }     // optional, rich artwork only
  },
  "server": "./server.ts",   // required
  "host": "./host.ts",       // singular host entry → dist/host.js
  "app": "./app.tsx",        // → dist/app.js + app.css
  "skills": ["skills"]       // optional; default skills/; [] opts out
}
```

* The SVG `branding.icon` is validated (well-formed, `<svg>` root, no doctype),
  hash-served, and drawn as a currentColor **mask**, so its colors are ignored.
  Ship a transparent glyph (gigaam: 24×24 stroke icon).
* Plugin id = package name minus `bb-plugin-`, so `meetings`. It namespaces
  routes, storage, settings and the CLI.
* `engines.bbPluginSdk` must be satisfiable: managed installs refuse a newer
  SDK or a different major. `bb plugin types` repins the SDK and the shimmed
  devDependencies.
* `bb plugin build [path]` needs no server. It writes `dist/server.js` (SDK and
  better-sqlite3 external, zod/hono/everything else bundled), `dist/host.js`
  and `dist/app.js`/`app.css`, each with a `*.meta.json`. `dist/` is
  gitignored. Path installs (`bb plugin install .`) load `server.ts` directly;
  `bb plugin dev` rebuilds app and host and reloads on save. Git installs run
  `npm install --omit=dev --omit=optional`, then build. So **every package
  imported at runtime by server, host or app must be in `dependencies`** (zod,
  ical.js, hono if imported at runtime). Types and shims go in devDependencies.
* Embedding non-TS files into the host bundle (gigaam
  `scripts/embed-python.mjs`): the script reads `python/gigaam_server.py` and
  writes `src/generated/gigaam-server-py.ts`, which contains
  `export const X_SHA256 = "<sha256>"; export const X = <JSON.stringify(source)>;`
  with a "Generated … Do not edit" header. It also exports
  `renderEmbeddedPython`, `sourcePath` and `generatedPath`, so a test can assert
  `readFileSync(generatedPath) === render(readFileSync(sourcePath))` with
  "run `npm run embed`" in the test name. The host writes the string into
  `dataDir` at runtime and uses the hash as an install-spec id. Scripts:
  `"embed": "node scripts/embed-python.mjs"`, `"typecheck": "tsc -p ."`,
  `"test": "vitest run"`, `"build": "bb plugin build"`. Meetings mirrors this
  with `scripts/embed-runtime.mjs`, which writes `src/generated/runtime-files.ts`.
* Skills: `skills/<name>/SKILL.md` with frontmatter `name:` (kebab-case,
  unique) and `description:` (when to use it). It is injected into agent
  threads as the plugin skills tier. Document every CLI command, tool, setting
  and limit there.

## 13. Testing

### Server: `createFakePluginHost` (`@get-bb/plugin-sdk/testing`; needs devDependency `better-sqlite3`)

```ts
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
const { bb, harness } = createFakePluginHost({
  pluginId: "meetings",
  settings: { notifyThread: true },               // pre-seeded stored values (secrets too)
  dataDir: "/tmp/x", appUrl: null,
  sdk: {                                          // stubs; any unstubbed bb.sdk call THROWS naming the path
    system: { config: async () => ({ primaryHostId: "host-1" }) as never },
    threads: { send: async () => ({ ok: true, delivery: "sent" }) as never, get: async () => makeThreadResponse({ id: "thr_1" }) },
  },
  experimental_callHostRpc: async ({ method, input, hostId, signal }) => { /* fake host entry */ return { ok: true }; },
  experimental_declaredIconNames: ["video"],       // needed if tools use "meetings/video"
});
await plugin(bb);
await harness.behavior.callRpc("meetings.list", null);                 // wire semantics; rejects with code/issues
const res = await harness.behavior.fetchHttp("GET", "/audio?id=m1", { headers: { range: "bytes=0-99" } }); // real Hono ctx; auth NOT enforced
await harness.behavior.runCli(["join", "https://zoom.us/j/1", "--json"]);   // → { exitCode, stdout, stderr, error? }
await harness.behavior.callAgentTool("meetings_join", { url: "…" }, { threadId: "thr_9" });
const svc = harness.behavior.runService("reconcile"); svc.controller.abort(); await svc.done;  // services never auto-run
await harness.behavior.runSchedule("calendar-sync");
await harness.behavior.setSettings({ notifyThread: false });           // validates + fires onChange
await harness.behavior.experimental_emitHostSignal("host-1", "meeting.changed", { meetingId: "m1", phase: "live" });
await harness.behavior.experimental_emitHostWorkerExit("host-1");
await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_1" }) });
harness.inspection.experimental_hostRpcCalls;   // [{ method, input, hostId, signal }]
harness.inspection.sdk.callsTo("threads.send"); // [[args]]
harness.inspection.realtimeSignals;             // [{ channel, payload }]
harness.inspection.needsConfigurationMessages; harness.inspection.logEntries; harness.inspection.registrations; // .httpRoutes .agentTools[].inputSchema .cli .services …
harness.inspection.sdk.stub("projects.list", async () => []);
await harness.lifecycle.dispose();              // aborts services, LIFO hooks, closes db, poisons bb
await harness.lifecycle.reload(plugin);         // keeps settings/kv/db
```

### Host entry: `experimental_createHostEntryHarness` (`@get-bb/plugin-sdk/testing/host`)

```ts
const h = experimental_createHostEntryHarness(hostEntry, {
  experimental_paths: { dataDir: await mkdtemp(...), tempDir: await mkdtemp(...) },
  experimental_watch: optionalAdapter,
});
await h.experimental_call("meetings.readChunk", { … }, { signal });   // real schema validation, JSON round-trip, 8 MiB output cap
h.experimental_getSignals();                 // [{ signal: "meeting.changed", payload }]
h.experimental_getRetainedWorkerLeaseCount(); // verified: 1 after retainWorker, 0 after dispose
h.experimental_lifecycleSignal;               // aborted by dispose
await h.experimental_dispose();
```

### Frontend: `@get-bb/plugin-sdk/testing/app` (vitest + jsdom)

This needs devDependencies `@testing-library/react`, `jsdom`, `react` and
`react-dom`, none of which are installed yet. It also needs a vitest
`resolve.alias` for `@` mapped to the plugin root, an `include` pattern that
matches `*.test.tsx`, and `// @vitest-environment jsdom` at the top of the file.

```tsx
const app = await loadPluginApp(() => import("../app"));        // validates registrations like the host
const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
  rpc: { "meetings.list": () => ({ items: [] }) }, settings: { notifyThread: true },
  context: { projectId: null, threadId: null }, pluginId: "meetings",
});
await slot.findByText("…"); await slot.behavior.emitRealtime("meetings.changed", { id: "m1" });
slot.inspection.rpcCalls; slot.inspection.navigateCalls; slot.lifecycle.unmount();
```

### gigaam's test layout (copy it)

* `vitest.config.ts`: `defineConfig({ test: { include: ["test/**/*.test.ts"] } })`.
  tsconfig `include` lists `server.ts`, `host.ts`, `src` and `test`.
* `test/server.test.ts`: a `load({ state, settings, primaryHostId })` helper
  builds `createFakePluginHost` with a `system.config` stub and an
  `experimental_callHostRpc` switch on `method`. It runs `await plugin(bb)`
  and asserts on registrations, `runCli` output and `experimental_hostRpcCalls`.
* `test/supervisor.test.ts`: tests the pure class against temp dirs and the
  host entry through `experimental_createHostEntryHarness` with
  `experimental_paths`. Temp dirs are cleaned in `afterEach`.
* `test/platform.test.ts`: pure functions, plus the embed-freshness check that
  imports the `.mjs` with `// @ts-expect-error`.
* `test/e2e.test.ts`: `describe.runIf(process.env.GIGAAM_E2E === "1")` for slow real installs.
* Fidelity limits: HTTP auth is not enforced, services and schedules don't
  auto-run, `bb.sdk` is always bound, storage is process-local, and crashes,
  idle eviction and reconnects are not simulated. Check those live with
  `bb plugin dev`, `bb plugin list`, `bb plugin logs meetings -f`, and
  `curl -X POST -H 'content-type: application/json' -d 'null' http://127.0.0.1:<port>/api/v1/plugins/meetings/rpc/<method>`.
