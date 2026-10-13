// Detached spawning, PID-reuse-safe liveness, meeting process teardown and
// PulseAudio module cleanup.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, untilAborted } from "../src/host/exec.js";
import { hostPaths } from "../src/host/paths.js";
import {
  findLive,
  findMeetingProcesses,
  killMeetingProcesses,
  mentionsDir,
  pulseArgsMatch,
  readProc,
  spawnDetached,
  unloadPulseModules,
} from "../src/host/processes.js";
import { cleanupTempDirs, newMeetingId, processAlive, tempDir, waitFor } from "./host-helpers.js";

const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await cleanupTempDirs();
});

describe("mentionsDir / pulseArgsMatch", () => {
  it("matches a directory only at path boundaries", () => {
    const dir = "/data/meetings/mtg_abc123";
    expect(mentionsDir(dir, dir)).toBe(true);
    expect(mentionsDir(`${dir}/profile`, dir)).toBe(true);
    expect(mentionsDir(`--user-data-dir=${dir}/profile`, dir)).toBe(true);
    expect(mentionsDir(`--user-data-dir=${dir}`, dir)).toBe(true);
    expect(mentionsDir(`${dir}4`, dir)).toBe(false);
    expect(mentionsDir(`/x${dir}`, dir)).toBe(false);
    expect(mentionsDir(`${dir}4 ${dir}/a`, dir)).toBe(true);
  });

  it("recognizes the meeting's pulse devices", () => {
    const id = "mtg_k3j9x2p7q1zz";
    expect(pulseArgsMatch("sink_name=mtg_k3j9x2p7q1zz sink_properties=x", id)).toBe(true);
    expect(pulseArgsMatch("sink_name=mtg_k3j9x2_micsink", id)).toBe(true);
    expect(pulseArgsMatch("master=mtg_k3j9x2_micsink.monitor source_name=mtg_k3j9x2_mic", id)).toBe(true);
    expect(pulseArgsMatch("sink_name=mtg_mtg_k3j9x2p7q1zz", id)).toBe(true);
    expect(pulseArgsMatch("sink_name=mtg_k3j9", id)).toBe(false); // too short to be ours
    expect(pulseArgsMatch("sink_name=mtg_aaaaaa", id)).toBe(false);
    expect(pulseArgsMatch("sink_name=auto_null", id)).toBe(false);
  });
});

describe("spawnDetached / findLive", () => {
  it("starts a process in its own group with cwd, env and an appended log", async () => {
    const dir = await tempDir();
    const log = path.join(dir, "out.log");
    await fs.writeFile(log, "previous\n");
    const script = path.join(dir, "worker.mjs");
    await fs.writeFile(script, "console.log('env=' + process.env.PROBE_VALUE + ' cwd=' + process.cwd()); setTimeout(() => {}, 60000);\n");
    const pid = await spawnDetached({
      command: process.execPath,
      args: [script, "--meeting-dir", dir],
      cwd: dir,
      logFile: log,
      env: { ...process.env, PROBE_VALUE: "42" },
    });
    strays.push(pid);
    const proc = await readProc(pid);
    expect(proc).toMatchObject({ pid, pgid: pid, cwd: dir });
    expect(await findLive([999_999_999, pid], dir, "worker.mjs")).toBe(pid);
    expect(await findLive([pid], dir, "other.mjs")).toBeNull();
    expect(await findLive([pid], `${dir}x`, "worker.mjs")).toBeNull();
    // The test runner itself is alive but is not this meeting's worker.
    expect(await findLive([process.pid], dir, "worker.mjs")).toBeNull();
    const text = await waitFor(() => fs.readFile(log, "utf8"), (t) => t.includes("env=42"));
    expect(text.startsWith("previous\n")).toBe(true);
    expect(text).toContain(`cwd=${dir}`);
    process.kill(pid, "SIGKILL");
    await waitFor(async () => findLive([pid], dir, "worker.mjs"), (value) => value === null);
  });

  it("refuses a log file that is a symlink", async () => {
    const dir = await tempDir();
    const outside = path.join(await tempDir(), "victim");
    await fs.writeFile(outside, "keep\n");
    const log = path.join(dir, "transcriber.log");
    await fs.symlink(outside, log);
    await expect(
      spawnDetached({ command: "/bin/true", args: [], cwd: dir, logFile: log, env: process.env }),
    ).rejects.toThrow(/ELOOP/);
    expect(await fs.readFile(outside, "utf8")).toBe("keep\n");
  });

  it("rejects when the command does not exist", async () => {
    const dir = await tempDir();
    await expect(
      spawnDetached({ command: path.join(dir, "missing"), args: [], cwd: dir, logFile: path.join(dir, "log"), env: process.env }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("run", () => {
  it("kills the whole process group on timeout, even when a descendant holds the pipes", { timeout: 20_000 }, async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "bg");
    const started = Date.now();
    const result = await run("sh", ["-c", `sleep 30 & echo $! > '${pidFile}'; sleep 31`], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_000);
    const background = Number(await fs.readFile(pidFile, "utf8"));
    strays.push(background);
    await waitFor(async () => processAlive(background), (alive) => !alive, 5_000, "background sleep killed");
  });

  it("returns soon after the command exits although a background child keeps its stdout", { timeout: 20_000 }, async () => {
    const started = Date.now();
    const result = await run("sh", ["-c", "sleep 30 & echo started $!"], { timeoutMs: 20_000 });
    const background = Number(/started (\d+)/.exec(result.stdout)?.[1]);
    strays.push(background);
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects promptly on abort and kills the group", { timeout: 20_000 }, async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "bg");
    const controller = new AbortController();
    const pending = run("sh", ["-c", `sleep 30 & echo $! > '${pidFile}'; sleep 31`], { timeoutMs: 60_000, signal: controller.signal });
    await waitFor(() => fs.readFile(pidFile, "utf8").catch(() => ""), (text) => text.trim() !== "");
    const background = Number(await fs.readFile(pidFile, "utf8"));
    strays.push(background);
    const aborted = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - aborted).toBeLessThan(5_000);
    await waitFor(async () => processAlive(background), (alive) => !alive, 5_000, "background sleep killed");
  });

  it("untilAborted settles on abort without waiting for the work", async () => {
    const controller = new AbortController();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 10_000).unref());
    const guarded = untilAborted(slow, controller.signal);
    controller.abort(new Error("cancelled by the caller"));
    await expect(guarded).rejects.toThrow("cancelled by the caller");
    await expect(untilAborted(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1);
  });
});

describe("killMeetingProcesses", () => {
  it("kills processes in the meeting dir and its groups, sparing excluded and unrelated ones", { timeout: 20_000 }, async () => {
    const root = await tempDir();
    const dir = path.join(root, "mtg_aaaaaaaaaaaa");
    const sibling = path.join(root, "mtg_aaaaaaaaaaaab");
    await fs.mkdir(dir);
    await fs.mkdir(sibling);
    // A "bot" group: leader names the dir, its child runs with cwd elsewhere (only the group ties it).
    const leader = spawn("sh", ["-c", `sleep 300 & echo $! > '${dir}/child'; sleep 301`, dir], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
    });
    // Own session like everything the host starts (no controlling terminal even when the tests run in one).
    const inDir = spawn("sleep", ["302"], { cwd: dir, detached: true, stdio: "ignore" });
    const spared = spawn("sleep", ["303"], { cwd: dir, detached: true, stdio: "ignore" });
    const neighbour = spawn("sleep", ["304"], { cwd: sibling, stdio: "ignore" });
    const unrelated = spawn("sleep", ["305"], { cwd: "/", stdio: "ignore" });
    for (const child of [leader, inDir, spared, neighbour, unrelated]) strays.push(child.pid!);
    const groupChild = Number(await waitFor(() => fs.readFile(path.join(dir, "child"), "utf8").catch(() => ""), (t) => t.trim() !== ""));
    strays.push(groupChild);
    await waitFor(async () => (await readProc(leader.pid!))?.argv.includes(dir) ?? false, Boolean);

    const found = (await findMeetingProcesses(dir, { groups: [leader.pid!] })).map((p) => p.pid);
    expect(found).toEqual(expect.arrayContaining([leader.pid, inDir.pid, spared.pid, groupChild]));
    expect(found).not.toContain(neighbour.pid);
    expect(found).not.toContain(unrelated.pid);
    expect(found).not.toContain(process.pid);

    const killed = await killMeetingProcesses(dir, {
      groups: [leader.pid!],
      exclude: (proc) => proc.pgid === spared.pid,
    });
    expect(killed).toEqual(expect.arrayContaining([leader.pid, inDir.pid, groupChild]));
    for (const pid of [leader.pid!, inDir.pid!, groupChild]) expect(processAlive(pid)).toBe(false);
    for (const pid of [spared.pid!, neighbour.pid!, unrelated.pid!]) expect(processAlive(pid)).toBe(true);
  });

  it("finds processes by cwd when the data dir is reached through a symlink", { timeout: 20_000 }, async () => {
    const real = await tempDir();
    const link = `${real}-link`;
    await fs.symlink(real, link);
    try {
      const dir = path.join(link, "meetings", "mtg_aaaaaaaaaaaa");
      await fs.mkdir(dir, { recursive: true });
      // Like Xvfb or login-mode Chrome: only the cwd ties it to the meeting, and /proc shows the resolved path.
      const child = spawn("sleep", ["300"], { cwd: dir, detached: true, stdio: "ignore" });
      strays.push(child.pid!);
      await waitFor(async () => (await readProc(child.pid!))?.argv[0] === "sleep", Boolean);
      expect((await readProc(child.pid!))?.cwd).toBe(path.join(real, "meetings", "mtg_aaaaaaaaaaaa"));
      expect((await findMeetingProcesses(dir)).map((proc) => proc.pid)).toContain(child.pid);
      await killMeetingProcesses(dir);
      expect(processAlive(child.pid!)).toBe(false);
    } finally {
      await fs.unlink(link);
    }
  });

  it("spares a user's terminal process that sits in the meeting dir", { timeout: 20_000 }, async () => {
    const root = await tempDir();
    const dir = path.join(root, "mtg_aaaaaaaaaaaa");
    await fs.mkdir(dir);
    const pidFile = path.join(root, "tty-child");
    // A shell-like process with a controlling terminal, cwd = meeting dir. The holder keeps the pty open and
    // gets the dir via the environment so that nothing but the terminal process itself is tied to the meeting.
    const holderScript = [
      "import os, pty, time",
      "pid, fd = pty.fork()",
      "if pid == 0:",
      "    os.chdir(os.environ['TARGET_DIR'])",
      "    os.execvp('sleep', ['sleep', '300'])",
      "open(os.environ['PID_FILE'], 'w').write(str(pid))",
      "time.sleep(300)",
    ].join("\n");
    const holder = spawn("python3", ["-c", holderScript], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TARGET_DIR: dir, PID_FILE: pidFile },
    });
    strays.push(holder.pid!);
    const terminal = Number(await waitFor(() => fs.readFile(pidFile, "utf8").catch(() => ""), (t) => t.trim() !== ""));
    strays.push(terminal);
    const ours = spawn("sleep", ["301"], { cwd: dir, detached: true, stdio: "ignore" });
    strays.push(ours.pid!);
    await waitFor(async () => (await readProc(terminal))?.cwd === dir, Boolean, 5_000, "terminal process in dir");
    expect((await readProc(terminal))?.tty).not.toBe(0);

    const found = (await findMeetingProcesses(dir)).map((proc) => proc.pid);
    expect(found).toContain(ours.pid);
    expect(found).not.toContain(terminal);
    await killMeetingProcesses(dir);
    expect(processAlive(ours.pid!)).toBe(false);
    expect(processAlive(terminal)).toBe(true);
  });

  it("SIGTERMs first when given a grace period", { timeout: 20_000 }, async () => {
    const dir = await tempDir();
    const script = path.join(dir, "graceful.mjs");
    await fs.writeFile(
      script,
      `import fs from "node:fs"; process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(path.join(dir, "termed"))}, "1"); process.exit(0); }); setInterval(() => {}, 1000);\n`,
    );
    const child = spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
    strays.push(child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await killMeetingProcesses(dir, { graceMs: 3_000 });
    expect(await fs.readFile(path.join(dir, "termed"), "utf8")).toBe("1");
  });
});

const pulseUp = spawnSync("pactl", ["info"], { timeout: 5_000 }).status === 0;

describe.runIf(pulseUp)("unloadPulseModules (real PulseAudio)", () => {
  it("unloads only this meeting's sinks and remapped sources", { timeout: 20_000 }, async () => {
    const paths = hostPaths(await tempDir());
    const id = newMeetingId();
    const other = newMeetingId();
    const short = id.slice(4, 12);
    // Bots running concurrently unload mtg_* modules that no live process mentions; keep ours "owned".
    for (const name of [`mtg_${short}`, other]) {
      const owner = spawn("sh", ["-c", "sleep 60", name], { stdio: "ignore" });
      strays.push(owner.pid!);
    }
    const load = (...args: string[]) => {
      const result = spawnSync("pactl", ["load-module", ...args], { encoding: "utf8" });
      expect(result.status).toBe(0);
      return Number(result.stdout.trim());
    };
    const loaded = [
      load("module-null-sink", `sink_name=mtg_${short}`),
      load("module-null-sink", `sink_name=mtg_${short}_micsink`),
      load("module-remap-source", `master=mtg_${short}_micsink.monitor`, `source_name=mtg_${short}_mic`),
    ];
    const foreign = load("module-null-sink", `sink_name=mtg_${other.slice(4)}`);
    try {
      expect(await unloadPulseModules(paths, id)).toBe(3);
      const left = spawnSync("pactl", ["list", "short", "modules"], { encoding: "utf8" }).stdout;
      for (const index of loaded) expect(left).not.toMatch(new RegExp(`^${index}\\t`, "m"));
      expect(left).toMatch(new RegExp(`^${foreign}\\t`, "m"));
      expect(await unloadPulseModules(paths, id)).toBe(0);
    } finally {
      spawnSync("pactl", ["unload-module", String(foreign)]);
      for (const index of loaded) spawnSync("pactl", ["unload-module", String(index)]);
    }
  });
});
