// Shared test fixtures: an in-memory host entry that simulates meeting
// runtimes (bot/transcriber state files) and a loader around createFakePluginHost.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { EnvReport, RuntimeSnapshot } from "../src/shared/contract.js";
import {
  botConfigSchema,
  type BotConfig,
  type BotState,
  type Segment,
  type TranscriberState,
} from "../src/shared/runtime-files.js";
import { createMeetingsPlugin } from "../server.js";
import type { MeetingsService } from "../src/server/service.js";

export const HOST = "host-1";
export const CHROME = "/usr/bin/google-chrome-stable";
export const GIGAAM_URL = "http://127.0.0.1:40000";

export interface FakeMeeting {
  config: BotConfig;
  exists: boolean;
  bot: BotState | null;
  botAlive: boolean;
  transcriber: TranscriberState | null;
  transcriberAlive: boolean;
  segments: Segment[];
  final: boolean;
  audio: Buffer;
  screenshot: Buffer | null;
  screenshotMtime: number | null;
  sourcePath?: string;
}

export function envReport(overrides: Partial<EnvReport> = {}): EnvReport {
  return {
    ready: true,
    items: [
      { id: "chrome", label: "Google Chrome", ok: true, required: true, version: "155.0", detail: CHROME, fix: null },
      { id: "xvfb", label: "Xvfb", ok: true, required: true, version: null, detail: "", fix: null },
      { id: "gigaam", label: "GigaAM", ok: true, required: true, version: null, detail: GIGAAM_URL, fix: null },
    ],
    setup: { phase: "idle", message: "", startedAt: null, finishedAt: null, logTail: "" },
    runtimeHash: "abc123",
    hostDataDir: "/home/bb/.bb/plugins/meetings/host-data",
    sudo: true,
    gigaam: { url: GIGAAM_URL, ready: true, detail: "ok" },
    chromePath: CHROME,
    ...overrides,
  };
}

export function botState(meetingId: string, overrides: Partial<BotState> = {}): BotState {
  return {
    version: 1,
    meetingId,
    pid: 4242,
    phase: "joining",
    detail: "Opening the web client",
    startedAt: 1_000,
    joinedAt: null,
    recordingStartedAt: null,
    endedAt: null,
    endReason: null,
    error: null,
    participants: { count: null, names: [] },
    activeSpeakers: [],
    audio: { seconds: 0, bytes: 0 },
    updatedAt: 1_000,
    ...overrides,
  };
}

export function transcriberState(overrides: Partial<TranscriberState> = {}): TranscriberState {
  return {
    version: 1,
    pid: 5151,
    mode: "live",
    phase: "live",
    detail: "",
    processedSec: 0,
    audioSec: 0,
    segments: 0,
    checkpoint: { samples: 0, nextId: 0 },
    error: null,
    startedAt: 1_000,
    updatedAt: 1_000,
    finishedAt: null,
    ...overrides,
  };
}

export function segment(id: number, start: number, speaker: string, text: string, overrides: Partial<Segment> = {}): Segment {
  return {
    id,
    start,
    end: start + 3,
    speakerKey: speaker.startsWith("Спикер") ? `spk:${speaker.split(" ")[1]}` : `ui:${speaker}`,
    speaker,
    source: speaker.startsWith("Спикер") ? "acoustic" : "ui",
    text,
    ...overrides,
  };
}

/** The host entry, simulated: files per meeting, transitions driven by the test. */
export class FakeRuntime {
  readonly meetings = new Map<string, FakeMeeting>();
  env: EnvReport = envReport();
  failStart: string | null = null;
  profile = { exists: false, signedIn: false, path: "/home/bb/.bb/plugins/meetings/host-data/profiles/zoom", updatedAt: null as number | null };
  ensureCalls: Array<{ meetingId: string; mode: string }> = [];
  controlSeq = 0;
  viewers: Array<{ meetingId: string; untilMs: number }> = [];
  /** Called on every meeting.status poll, to script transitions. */
  onStatus: ((ids: string[]) => void) | null = null;

  get(id: string): FakeMeeting {
    const meeting = this.meetings.get(id);
    if (meeting === undefined) throw new Error(`no fake meeting ${id}`);
    return meeting;
  }

  setBot(id: string, overrides: Partial<BotState>, alive = true): void {
    const meeting = this.get(id);
    meeting.bot = botState(id, { ...(meeting.bot ?? {}), ...overrides });
    meeting.botAlive = alive;
  }

  snapshot(id: string): RuntimeSnapshot {
    const meeting = this.meetings.get(id);
    if (meeting === undefined || !meeting.exists) {
      return {
        meetingId: id,
        exists: false,
        bot: null,
        botAlive: false,
        transcriber: null,
        transcriberAlive: false,
        roster: null,
        files: { audioBytes: null, screenshotMtime: null, transcriptFinal: false, segments: 0 },
      };
    }
    return {
      meetingId: id,
      exists: true,
      bot: meeting.bot,
      botAlive: meeting.botAlive,
      transcriber: meeting.transcriber,
      transcriberAlive: meeting.transcriberAlive,
      roster: meeting.bot?.participants.count != null ? { t: 1, count: meeting.bot.participants.count, names: meeting.bot.participants.names } : null,
      files: {
        audioBytes: meeting.audio.length > 0 ? meeting.audio.length : null,
        screenshotMtime: meeting.screenshotMtime,
        transcriptFinal: meeting.final,
        segments: meeting.segments.length,
      },
    };
  }

  private create(config: BotConfig, sourcePath?: string): FakeMeeting {
    const meeting: FakeMeeting = {
      config,
      exists: true,
      bot: null,
      botAlive: sourcePath === undefined,
      transcriber: sourcePath === undefined ? null : transcriberState({ mode: "offline", phase: "live" }),
      transcriberAlive: sourcePath !== undefined,
      segments: [],
      final: false,
      audio: sourcePath === undefined ? Buffer.alloc(0) : Buffer.alloc(1000, 1),
      screenshot: null,
      screenshotMtime: null,
      ...(sourcePath === undefined ? {} : { sourcePath }),
    };
    this.meetings.set(config.meetingId, meeting);
    return meeting;
  }

  handle(method: string, input: unknown): unknown {
    const args = input as Record<string, never>;
    switch (method) {
      case "env.check":
      case "env.setup":
        return this.env;
      case "gigaam.discover":
        return { url: GIGAAM_URL, ready: true, detail: "ok" };
      case "meeting.start": {
        if (this.failStart !== null) throw new Error(this.failStart);
        const config = botConfigSchema.parse(args.config);
        this.create(config);
        return this.snapshot(config.meetingId);
      }
      case "meeting.import": {
        const config = botConfigSchema.parse(args.config);
        this.create(config, args.sourcePath);
        return this.snapshot(config.meetingId);
      }
      case "meeting.stop": {
        const id = args.meetingId as string;
        // Like the host: no meeting directory yet (or any more) → an empty snapshot, nothing to signal.
        if (!this.meetings.has(id)) return this.snapshot(id);
        const meeting = this.get(id);
        meeting.bot = botState(id, { ...(meeting.bot ?? {}), phase: "ended", endReason: "stopped", endedAt: 9_000 });
        meeting.botAlive = false;
        return this.snapshot(id);
      }
      case "meeting.status":
        this.onStatus?.(args.meetingIds as string[]);
        return { snapshots: (args.meetingIds as string[]).map((id) => this.snapshot(id)) };
      case "meeting.segments": {
        const meeting = this.get(args.meetingId as string);
        const after = meeting.segments.filter((s) => s.id > (args.afterId as number)).slice(0, args.limit as number);
        return {
          final: meeting.final,
          segments: after,
          lastId: after.at(-1)?.id ?? (args.afterId as number),
          total: meeting.segments.length,
        };
      }
      case "meeting.transcript":
        return { transcript: null };
      case "meeting.ensureTranscriber": {
        const id = args.meetingId as string;
        const meeting = this.get(id);
        this.ensureCalls.push({ meetingId: id, mode: args.mode as string });
        if (args.mode === "offline") {
          meeting.final = false;
          meeting.segments = [];
        }
        meeting.transcriber = transcriberState({ mode: args.mode as "live" | "offline", phase: "live" });
        meeting.transcriberAlive = true;
        return this.snapshot(id);
      }
      case "meeting.readFile": {
        const meeting = this.meetings.get(args.meetingId as string);
        const file = meeting === undefined ? null : args.file === "audio.ogg" ? meeting.audio : args.file === "screen.jpg" ? meeting.screenshot : null;
        if (file === null || (args.file === "audio.ogg" && file.length === 0)) return { base64: null, totalBytes: 0, mtimeMs: null };
        const offset = args.offset as number;
        const slice = file.subarray(offset, offset + (args.length as number));
        return { base64: slice.toString("base64"), totalBytes: file.length, mtimeMs: 5 };
      }
      case "meeting.filePath":
        return { path: this.meetings.has(args.meetingId as string) ? `/data/meetings/${args.meetingId}/${args.file}` : null };
      case "meeting.logs":
        return { text: `bot log of ${args.meetingId}` };
      case "meeting.debugDump":
        return { requested: true };
      case "meeting.control":
        this.controlSeq += 1;
        return { queued: true, seq: this.controlSeq };
      case "meeting.viewer":
        this.viewers.push({ meetingId: args.meetingId as string, untilMs: args.untilMs as number });
        return { ok: true };
      case "zoom.profile":
        if (args.action === "delete") this.profile = { ...this.profile, exists: false, signedIn: false, updatedAt: null };
        return { ...this.profile };
      case "meeting.delete":
        return { deleted: this.meetings.delete(args.meetingId as string) };
      case "runtime.list":
        return { meetingIds: [...this.meetings.keys()] };
      default:
        throw new Error(`unexpected host method ${method}`);
    }
  }
}

export interface LoadOptions {
  settings?: Record<string, string | number | boolean>;
  now?: () => number;
  fetchText?: (url: string) => Promise<string>;
  primaryHostId?: string | null;
  sendThrows?: boolean;
  loopbackBaseUrl?: string;
}

export async function load(options: LoadOptions = {}) {
  const fake = new FakeRuntime();
  let service: MeetingsService | null = null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "meetings",
    settings: options.settings,
    appUrl: "https://bb.example",
    ...(options.loopbackBaseUrl === undefined ? {} : { loopbackBaseUrl: options.loopbackBaseUrl }),
    sdk: {
      system: {
        config: async () =>
          ({ primaryHostId: options.primaryHostId === undefined ? HOST : options.primaryHostId }) as never,
      },
      threads: {
        send: async () => {
          if (options.sendThrows) throw new Error("thread is gone");
          return { ok: true, delivery: "sent" } as never;
        },
      },
    },
    experimental_callHostRpc: ({ method, input }) => fake.handle(method, input),
  });
  await createMeetingsPlugin({
    now: options.now,
    joinPollMs: 5,
    fetchText: options.fetchText,
    onService: (s) => (service = s),
  })(bb);
  if (service === null) throw new Error("service not created");
  return { bb, harness, fake, service: service as MeetingsService };
}

/** Hold meeting.start calls until the returned function is called (races with a starting bot). */
export function holdStart(fake: FakeRuntime): () => void {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = fake.handle.bind(fake);
  fake.handle = (method, input) => (method === "meeting.start" ? gate.then(() => handle(method, input)) : handle(method, input));
  return release;
}

/** Poll until `check` holds (for work running in the background of an RPC call). */
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!check()) throw new Error("condition not reached");
}

export function hostCalls(
  harness: { inspection: { experimental_hostRpcCalls: readonly { method: string; input: unknown; hostId: string }[] } },
  method: string,
) {
  return harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === method);
}

export const ZOOM_URL = "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1";

let nextMeetingNumber = 81234560000;
/** A different meeting every call: one bot per meeting is enforced. */
export function uniqueZoomUrl(): string {
  nextMeetingNumber += 1;
  return `https://us02web.zoom.us/j/${nextMeetingNumber}?pwd=AbCdEf123.1`;
}
