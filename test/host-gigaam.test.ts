// gigaam.discover with a fake `bb` CLI on PATH and a local /health server.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { clearGigaamCache, discoverGigaam } from "../src/host/gigaam.js";
import { hostPaths } from "../src/host/paths.js";
import { cleanupTempDirs, tempDir } from "./host-helpers.js";

const originalPath = process.env.PATH;
const servers: http.Server[] = [];

beforeEach(() => clearGigaamCache());
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await cleanupTempDirs();
});

async function healthServer(body: unknown, status = 200): Promise<number> {
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Puts a `bb` script first on PATH that prints `status` for `bb gigaam status --json` and counts calls. */
async function fakeBb(status: unknown, exitCode = 0): Promise<{ calls: () => Promise<number> }> {
  const bin = await tempDir("meetings-fake-bb-");
  const counter = path.join(bin, "calls");
  const script = [
    "#!/bin/sh",
    `echo x >> '${counter}'`,
    `if [ "$1 $2 $3" != "gigaam status --json" ]; then echo "unexpected args: $*" >&2; exit 2; fi`,
    `cat <<'EOF'`,
    JSON.stringify(status),
    "EOF",
    `exit ${exitCode}`,
  ].join("\n");
  await fs.writeFile(path.join(bin, "bb"), `${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  return {
    calls: async () => (await fs.readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length,
  };
}

describe("gigaam.discover", () => {
  it("finds the gigaam plugin's server through bb, checks /health and persists gigaam.json", async () => {
    const port = await healthServer({ ready: true, model: "v3_e2e_rnnt", threads: 5 });
    const bb = await fakeBb({ mode: "managed", phase: "ready", model: "v3_e2e_rnnt", threads: 0, port });
    const dataDir = await tempDir();
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: { dataDir, tempDir: await tempDir() },
    });
    const status = await harness.experimental_call("gigaam.discover", { configuredUrl: "" });
    expect(status).toEqual({ url: `http://127.0.0.1:${port}`, ready: true, detail: "Готов (v3_e2e_rnnt) — сервер плагина gigaam" });
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, "gigaam.json"), "utf8"));
    expect(saved.url).toBe(`http://127.0.0.1:${port}`);

    // Cached for 30 s: no second bb run, gigaam.json untouched.
    const before = (await fs.stat(path.join(dataDir, "gigaam.json"))).mtimeMs;
    await harness.experimental_call("gigaam.discover", { configuredUrl: "" });
    expect(await bb.calls()).toBe(1);
    expect((await fs.stat(path.join(dataDir, "gigaam.json"))).mtimeMs).toBe(before);
    await harness.experimental_dispose();
  });

  it("uses the configured URL without asking bb", async () => {
    const port = await healthServer({ ready: true });
    const bb = await fakeBb({ mode: "managed", phase: "ready", port: 1 });
    const paths = hostPaths(await tempDir());
    const status = await discoverGigaam(paths, ` http://127.0.0.1:${port}/ `);
    expect(status).toMatchObject({ url: `http://127.0.0.1:${port}`, ready: true });
    expect(await bb.calls()).toBe(0);
  });

  it("reports a server that is still starting, an external one, and an unreachable one", async () => {
    const paths = hostPaths(await tempDir());
    await fakeBb({ mode: "managed", phase: "installing", message: "Installing PyTorch", port: null });
    const starting = await discoverGigaam(paths, "", { fresh: true });
    expect(starting).toMatchObject({ url: null, ready: false });
    expect(starting.detail).toContain("Installing PyTorch");
    await expect(fs.stat(paths.gigaamFile)).rejects.toThrow(); // nothing to persist

    const port = await healthServer({ ready: false });
    await fakeBb({ mode: "external", serverUrl: `http://127.0.0.1:${port}/`, ready: true });
    const loading = await discoverGigaam(paths, "", { fresh: true });
    expect(loading).toMatchObject({ url: `http://127.0.0.1:${port}`, ready: false, detail: expect.stringContaining("загружает") });

    const dead = await healthServer({}, 503);
    const unreachable = await discoverGigaam(paths, `http://127.0.0.1:${dead}`, { fresh: true });
    expect(unreachable).toMatchObject({ ready: false, detail: expect.stringContaining("HTTP 503") });
    const closed = await discoverGigaam(paths, "http://127.0.0.1:9", { fresh: true });
    expect(closed).toMatchObject({ url: "http://127.0.0.1:9", ready: false, detail: expect.stringContaining("недоступен") });
  });

  it("explains a missing gigaam plugin", async () => {
    const paths = hostPaths(await tempDir());
    const bin = await tempDir("meetings-fake-bb-");
    await fs.writeFile(path.join(bin, "bb"), "#!/bin/sh\necho 'Unknown command: gigaam' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const status = await discoverGigaam(paths, "", { fresh: true });
    expect(status).toMatchObject({ url: null, ready: false });
    expect(status.detail).toMatch(/gigaam не установлен/);
  });
});
