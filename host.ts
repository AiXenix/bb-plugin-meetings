// bb-plugin-meetings host entry: runs on the recording machine. It installs
// the runtime (env.check / env.setup), spawns and inspects the detached bot
// and transcriber processes, and serves files from meeting directories. It
// keeps no state of its own: every call re-reads <hostData> (DESIGN §2–§4).
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostRpcHandlers,
} from "@get-bb/plugin-sdk";
import { hostContract } from "./src/shared/contract.js";
import { checkEnv } from "./src/host/env.js";
import { untilAborted } from "./src/host/exec.js";
import { discoverGigaam } from "./src/host/gigaam.js";
import {
  meetingFilePath,
  meetingLogs,
  queueControl,
  readMeetingFile,
  requestDebugDump,
  setViewer,
} from "./src/host/meeting-files.js";
import {
  deleteMeeting,
  ensureTranscriber,
  importMeeting,
  listMeetingIds,
  meetingSegments,
  meetingTranscript,
  startMeeting,
  statusMany,
  stopMeeting,
} from "./src/host/meetings.js";
import { hostPaths, type HostPaths } from "./src/host/paths.js";
import { cancelSetups, startSetup } from "./src/host/setup.js";
import { deleteZoomProfile, zoomProfileStatus } from "./src/host/zoom-profile.js";

let cached: HostPaths | null = null;

function pathsFor(dataDir: string): HostPaths {
  if (cached === null || cached.root !== dataDir) cached = hostPaths(dataDir);
  return cached;
}

type Handler = (input: never, context: ExperimentalHostRpcContext) => unknown;

/**
 * Every handler settles as soon as its call is cancelled or times out: the
 * daemon SIGKILLs the whole worker (and any setup running in it) when a
 * cancelled call is still pending 5 s later.
 */
function settleOnAbort<H extends Record<string, Handler>>(handlers: H): H {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (input: never, context: ExperimentalHostRpcContext) =>
        untilAborted(Promise.resolve().then(() => handler(input, context)), context.signal),
    ]),
  ) as H;
}

const handlers: ExperimentalHostRpcHandlers<typeof hostContract> = {
  "env.check": async ({ chromePath, gigaamUrl }, context) =>
    checkEnv(pathsFor(context.experimental_paths.dataDir), { chromePath, gigaamUrl }),

  "env.setup": async ({ force, chromePath, gigaamUrl }, context) => {
    const paths = pathsFor(context.experimental_paths.dataDir);
    // The lease keeps the worker alive for the whole background install.
    await startSetup(paths, { force, chromePath }, () => context.experimental_retainWorker());
    return checkEnv(paths, { chromePath, gigaamUrl });
  },

  "gigaam.discover": async ({ configuredUrl }, context) =>
    discoverGigaam(pathsFor(context.experimental_paths.dataDir), configuredUrl),

  "meeting.start": async ({ config }, context) => startMeeting(pathsFor(context.experimental_paths.dataDir), config),

  "meeting.import": async ({ config, sourcePath }, context) =>
    importMeeting(pathsFor(context.experimental_paths.dataDir), config, sourcePath, context.signal),

  "meeting.stop": async ({ meetingId }, context) => stopMeeting(pathsFor(context.experimental_paths.dataDir), meetingId),

  "meeting.status": async ({ meetingIds }, context) => ({
    snapshots: await statusMany(pathsFor(context.experimental_paths.dataDir), meetingIds),
  }),

  "meeting.segments": async ({ meetingId, afterId, limit }, context) =>
    meetingSegments(pathsFor(context.experimental_paths.dataDir), meetingId, afterId, limit),

  "meeting.transcript": async ({ meetingId }, context) => ({
    transcript: await meetingTranscript(pathsFor(context.experimental_paths.dataDir), meetingId),
  }),

  "meeting.ensureTranscriber": async (input, context) =>
    ensureTranscriber(pathsFor(context.experimental_paths.dataDir), input),

  "meeting.readFile": async (input, context) => readMeetingFile(pathsFor(context.experimental_paths.dataDir), input),

  "meeting.filePath": async ({ meetingId, file }, context) => ({
    path: await meetingFilePath(pathsFor(context.experimental_paths.dataDir), meetingId, file),
  }),

  "meeting.logs": async ({ meetingId, lines }, context) => ({
    text: await meetingLogs(pathsFor(context.experimental_paths.dataDir), meetingId, lines),
  }),

  "meeting.debugDump": async ({ meetingId }, context) => ({
    requested: await requestDebugDump(pathsFor(context.experimental_paths.dataDir), meetingId),
  }),

  "meeting.control": async (input, context) => queueControl(pathsFor(context.experimental_paths.dataDir), input),

  "meeting.viewer": async ({ meetingId, untilMs }, context) => ({
    ok: await setViewer(pathsFor(context.experimental_paths.dataDir), meetingId, untilMs),
  }),

  "zoom.profile": async ({ action }, context) => {
    const paths = pathsFor(context.experimental_paths.dataDir);
    return action === "delete" ? deleteZoomProfile(paths) : zoomProfileStatus(paths);
  },

  "meeting.delete": async ({ meetingId }, context) => ({
    deleted: await deleteMeeting(pathsFor(context.experimental_paths.dataDir), meetingId),
  }),

  "runtime.list": async (_input, context) => ({
    meetingIds: await listMeetingIds(pathsFor(context.experimental_paths.dataDir)),
  }),
};

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: settleOnAbort(handlers),
  dispose: async () => {
    // Abort a running install so the worker can stop; its lease is released by the run itself.
    await cancelSetups();
  },
});
