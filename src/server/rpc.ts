// Frontend RPC (src/shared/rpc-contract.ts): thin handlers over the service.
// Inputs are validated by the host; defaults are re-applied defensively in
// case a raw input (without zod defaults) reaches a handler.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "../shared/rpc-contract.js";
import type { MeetingsService } from "./service.js";

export function registerRpc(bb: BbPluginApi, service: MeetingsService): void {
  bb.rpc.register(rpcContract, {
    "meetings.list": (input) =>
      service.list(input?.filter ?? "all", clampInt(input?.limit, 1, 200, 50), input?.before ?? null),

    "meetings.get": async ({ id }) => ({ meeting: await service.toDetail(service.requireMeeting(id)) }),

    "meetings.segments": (input) =>
      service.segments(input.id, clampInt(input.afterId, -1, Number.MAX_SAFE_INTEGER, -1), clampInt(input.limit, 1, 5000, 2000)),

    "meetings.join": async (input) => {
      const row = await service.join({
        url: input.url,
        title: input.title ?? null,
        botName: input.botName ?? null,
        scheduledAt: input.scheduledAt ?? null,
        maxDurationMinutes: input.maxDurationMinutes ?? null,
        source: "ui",
      });
      return { meeting: service.toSummary(row) };
    },

    "meetings.stop": async ({ id }) => ({ meeting: service.toSummary(await service.stop(id)) }),
    "meetings.cancel": ({ id }) => ({ meeting: service.toSummary(service.cancel(id)) }),
    "meetings.retranscribe": async ({ id }) => ({ meeting: service.toSummary(await service.retranscribe(id)) }),
    "meetings.delete": async ({ id }) => ({ deleted: await service.delete(id) }),

    "meetings.update": (input) => {
      const fields: { title?: string; summaryMd?: string | null } = {};
      if (input.title !== undefined) fields.title = input.title;
      if (input.summaryMd !== undefined) fields.summaryMd = input.summaryMd;
      return { meeting: service.toSummary(service.update(input.id, fields)) };
    },

    "meetings.renameSpeaker": ({ id, speakerKey, name }) => ({
      meeting: service.toSummary(service.renameSpeaker(id, speakerKey, name ?? "")),
    }),

    "meetings.search": (input) => ({ hits: service.search(input.query, clampInt(input.limit, 1, 100, 30)) }),

    "meetings.logs": async (input) => ({ text: await service.logs(input.id, clampInt(input.lines, 1, 1000, 200)) }),
    "meetings.debugDump": async ({ id }) => ({ requested: await service.debugDump(id) }),
    "meetings.liveView": ({ id }) => service.liveView(id),
    "meetings.control": (input) => service.control(input),

    "zoom.status": () => service.zoom.status(),
    "zoom.loginStart": () => service.zoom.loginStart(),
    "zoom.loginFinish": () => service.zoom.loginFinish(),
    "zoom.logout": () => service.zoom.logout(),

    "env.status": () => service.envStatus(),
    "env.setup": async (input) => ({ env: await service.envSetup(input?.force ?? false) }),

    "calendar.status": () => service.calendar.status(),
    "calendar.sync": () => service.calendar.sync(),
    "calendar.setSkip": ({ key, skip }) => service.calendar.setSkip(key, skip),
  });
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
