// bb-plugin-meetings — a Fireflies-style notetaker for Zoom.
//
// This server entry keeps the meeting registry (SQLite), serves the Meetings
// page (RPC, realtime, HTTP audio/screenshots/downloads), the `bb meetings`
// CLI and the agent tools, and runs the scheduler that starts bots, follows
// them and notifies threads. The bots themselves run on the primary machine
// as detached processes managed by the host entry (host.ts); see
// docs/dev/DESIGN.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract } from "./src/shared/contract.js";
import { registerCli } from "./src/server/cli.js";
import { Repository, openDatabase } from "./src/server/db.js";
import { registerHttp } from "./src/server/http.js";
import { registerRpc } from "./src/server/rpc.js";
import { MeetingsService, type ServiceOptions } from "./src/server/service.js";
import { defineSettings } from "./src/server/settings.js";
import { registerTools } from "./src/server/tools.js";

export type { RpcContract } from "./src/shared/rpc-contract.js";

export interface PluginOptions extends ServiceOptions {
  /** Tests: receive the service to drive the scheduler deterministically. */
  readonly onService?: (service: MeetingsService) => void;
}

/** The plugin factory; options exist for tests (clock, polling, ICS fetching). */
export function createMeetingsPlugin(options: PluginOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = defineSettings(bb);
    const repo = new Repository(openDatabase(bb));
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const service = new MeetingsService(bb, settings, repo, host, options);
    options.onService?.(service);

    registerRpc(bb, service);
    registerHttp(bb, service);
    registerCli(bb, service);
    registerTools(bb, service);

    settings.onChange((next, prev) => {
      service.wake();
      // Auto-join, filter and feed changes apply to already scheduled calendar bots right away.
      service.calendar.settingsChanged(next, prev);
    });
    const offWorkerExit = host.experimental_onWorkerExit(() => service.wake());
    bb.onDispose(() => {
      offWorkerExit();
      service.dispose();
    });

    // Starts due meetings, follows running ones (2 s while active, 15 s idle),
    // reconciles everything once on load and syncs calendars.
    bb.background.service("scheduler", { start: (signal) => service.runScheduler(signal) });
  };
}

export default createMeetingsPlugin();
