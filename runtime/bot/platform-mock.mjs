// Mock platform (docs/dev/DESIGN.md §6.3): the local mock-meeting page copies
// the Zoom web-client DOM that the Zoom adapter reads, so the mock runs the
// very same join flow, sampler, chat and leave code against it.
import { ensureAudio, joinFlow, leaveMeeting, sampleMeeting, sendChat, sweepPopups } from "./platform-zoom.mjs";

export default {
  name: "mock",
  join: (ctx) => joinFlow(ctx, { launchPage: false }),
  sample: sampleMeeting,
  sweep: sweepPopups,
  ensureAudio,
  sendChat,
  leave: leaveMeeting,
};
