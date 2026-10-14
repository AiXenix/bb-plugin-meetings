import { expect, it } from "vitest";
import { botConfigSchema } from "../src/shared/runtime-files.js";
import type { MeetingSummary } from "../src/shared/rpc-contract.js";
import { HOST, hostCalls, load, segment } from "./server-fixtures.js";

it("imports through RPC on the recording host and ingests its completed offline transcript", async () => {
  const { harness, service, fake } = await load();
  try {
    const result = await harness.behavior.callRpc("meetings.import", { sourcePath: "/recordings/team-call.mp4", title: "Недельный созвон" }) as { meeting: MeetingSummary };
    expect(result.meeting).toMatchObject({ title: "Недельный созвон", source: "import", status: "processing", requestedByThreadId: null });
    const call = hostCalls(harness, "meeting.import")[0];
    expect(call.hostId).toBe(HOST);
    const input = call.input as { sourcePath: string; config: unknown };
    expect(input.sourcePath).toBe("/recordings/team-call.mp4");
    expect(botConfigSchema.parse(input.config)).toMatchObject({ meetingId: result.meeting.id, liveTranscription: false });
    const runtime = fake.get(result.meeting.id);
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.segments = [segment(0, 0, "Спикер 1", "Решили проверить доступ до пятницы.")];
    await service.tick();
    expect((await harness.behavior.callRpc("meetings.get", { id: result.meeting.id }) as { meeting: MeetingSummary }).meeting).toMatchObject({ status: "done", segmentsCount: 1 });
  } finally { await harness.dispose(); }
});

it("rejects a relative import path before creating a meeting or contacting the recording host", async () => {
  const { harness, service } = await load();
  try {
    await expect(harness.behavior.callRpc("meetings.import", { sourcePath: "team-call.mp4" })).rejects.toThrow(/абсолютный путь/);
    expect(hostCalls(harness, "meeting.import")).toEqual([]);
    expect(service.list("all", 20, null).meetings).toEqual([]);
  } finally { await harness.dispose(); }
});
