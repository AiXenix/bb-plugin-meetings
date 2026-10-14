// Browser regressions for admission, participant attribution and avatar controls.
// These run entirely against local HTML; no meeting service is contacted.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { TELEMOST_OP, telemostFrame } from "./platform-telemost.mjs";
import { MEET_OP } from "./platform-meet.mjs";
import { classifyMeetPage } from "./lib/meet-state.mjs";
import { NO_OUTGOING_SCREEN_SHARE_SCRIPT } from "./lib/screen-share-policy.mjs";
const runtime = process.env.MEETINGS_TEST_RUNTIME || path.resolve(import.meta.dirname, "../../.e2e/runtime");
let chromium;
try { ({ chromium } = createRequire(path.join(runtime, "package.json"))("playwright-core")); } catch {}

test("platform admission and speaker regressions in Chrome", { skip: !chromium && "Install the local mock runtime to run browser fixtures" }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
let checks = 0;
function ok(label, fn) { fn(); console.log("PASS", label); checks++; }
try {
  const page = await browser.newPage();
  await page.setContent(`<button data-testid="turn-on-camera-button" onclick="this.dataset.testid='turn-off-camera-button';window.cameraClicks=(window.cameraClicks||0)+1">Camera</button>
    <button aria-label="Unmute" onclick="window.micClicks=(window.micClicks||0)+1">Mic</button>`);
  const op = args => page.evaluate(`${TELEMOST_OP}(${JSON.stringify(args)})`);
  await op({ op: "setMedia", muteMic: true, wantCamera: true });
  await op({ op: "setMedia", muteMic: true, wantCamera: true });
  const clicks = await page.evaluate(() => ({ camera: window.cameraClicks, mic: window.micClicks || 0 }));
  ok("Telemost enables the avatar exactly once; muted microphone stays muted", () => assert.deepEqual(clicks, { camera: 1, mic: 0 }));
  await page.setContent(`<button data-testid="turn-off-mic-button" onclick="this.dataset.testid='turn-on-mic-button'">Mic</button><button data-testid="turn-off-camera-button" onclick="this.dataset.testid='turn-on-camera-button'">Camera</button>`);
  await op({ op: "setMedia", muteMic: true, wantCamera: false });
  ok("Telemost camera-off and microphone-off requests apply", () => assert.equal(true, true));
  assert.equal(await page.locator('[data-testid="turn-on-camera-button"]').count(), 1);
  assert.equal(await page.locator('[data-testid="turn-on-mic-button"]').count(), 1);
  await page.setContent(`<button onclick="window.wrong=true">Подключиться к звонку По ссылке или номеру</button><button data-testid="enter-conference-button" onclick="window.correct=true">Подключиться</button>`);
  await op({ op: "clickJoin" });
  const joined = await page.evaluate(() => ({ wrong: !!window.wrong, correct: !!window.correct }));
  ok("Telemost never clicks the shell's unrelated join card", () => assert.deepEqual(joined, { wrong: false, correct: true }));
  const main = { url: () => "https://telemost.yandex.ru/j/123" };
  const inner = { url: () => "https://telemost.yandex.ru/private-join/123" };
  ok("Telemost selects the conference iframe", () => assert.equal(telemostFrame({ frames: () => [main, inner], mainFrame: () => main }), inner));
  await page.setContent(`<button data-testid="participants-button">Участники 3</button>
    <span class="TextName_abc" title="Test Bot">Test Bot</span>
    <span class="TextName_abc" title="Анна">Анна</span>
    <span class="TextName_abc" title="Иван">Иван</span>`);
  await page.evaluate(() => { window[Symbol.for("mtg.audio")] = { levels: () => [{ id: "remote", level: 0.125, muted: false }] }; });
  const roster = await op({ op: "probe", botName: "Test Bot" });
  ok("Telemost keeps individual names and excludes itself", () => assert.deepEqual(roster.names, ["Анна", "Иван"]));
  ok("Telemost supplies measured audio levels to speaker fusion", () => assert.deepEqual(roster.tracks, [{ id: "remote", level: 0.125, muted: false }]));
  ok("Telemost does not invent active speakers from names", () => assert.deepEqual(roster.active, []));

  const cases = [
    ["You can't join this video call Return to home screen Returning to home screen in 60 seconds", "join_rejected"],
    ["Your request to join was denied Return to home screen", "denied"],
    ["No one responded to your request to join", "waiting_timeout"],
    ["Sign in to join", "auth_required"],
    ["Check your meeting code Return to home screen", "invalid_meeting"],
    ["You left the meeting Return to home screen", "meeting_ended"],
    ["Asking to be let in Someone in the call will let you in soon", "waiting_room"],
    ["Please wait until a meeting host brings you into the call", "waiting_room"],
    ["Подождите, пока организатор примет ваш запрос.", "waiting_room"],
    ["Return to home screen", null],
  ];
  for (const [text, expected] of cases) {
    ok(`Meet correctly classifies ${expected || "generic navigation"}`, () => assert.equal(classifyMeetPage(text), expected));
    await page.setContent(`<main></main>`);
    await page.locator("main").evaluate((el, text) => el.textContent = text, text);
    const probe = await page.evaluate(`${MEET_OP}({op:"probe"})`);
    assert.equal(probe.pageState, expected);
    assert.equal(probe.inMeeting, false);
  }
  await page.setContent('<button aria-label="Leave call">Leave</button>');
  const inCall = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet requires actual in-call controls before recording", () => assert.equal(inCall.inMeeting, true));
  await page.setContent('<p>Please wait until a meeting host brings you into the call</p><button aria-label="Leave call">Leave</button>');
  const lobby = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet lobby with a Leave button must never start recording", () => { assert.equal(lobby.inMeeting, false); assert.equal(lobby.waitingRoom, true); });
  await page.setContent('<p>Подождите, пока организатор примет ваш запрос.</p><button aria-label="Покинуть видеовстречу">call_end</button>');
  const russianLobby = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet recognizes the Russian account's lobby and leave button", () => { assert.equal(russianLobby.waitingRoom, true); assert.equal(russianLobby.hasLeaveBtn, true); assert.equal(russianLobby.inMeeting, false); });
  await page.setContent('<button aria-label="Покинуть видеовстречу" onclick="window.left=true">call_end</button>');
  const russianCall = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  await page.evaluate(`${MEET_OP}({op:"leave"})`);
  ok("Meet recognizes and leaves a Russian in-call page", () => assert.equal(russianCall.inMeeting, true));
  assert.equal(await page.evaluate(() => window.left), true);
  for (const label of ["Переключиться на это устройство", "Switch here"]) {
    await page.setContent(`<button>${label}</button><button onclick="window.tipClosed=true">ОК</button>`);
    const transfer = await page.evaluate(`${MEET_OP}({op:"probe"})`);
    await page.evaluate(`${MEET_OP}({op:"sweep"})`);
    ok(`Meet never transfers an existing call with ${label}`, () => {
      assert.equal(transfer.hasJoinBtn, false);
      assert.equal(transfer.hasTransferBtn, true);
      assert.equal(transfer.inMeeting, false);
    });
    assert.equal(await page.evaluate(() => window.tipClosed), true);
  }
  for (const label of ["Join here too", "Подключиться также на этом устройстве", "add_to_queueПодключиться также на этом устройстве"]) {
    await page.setContent(`<button>${label}</button>`);
    const additional = await page.evaluate(`${MEET_OP}({op:"probe"})`);
    ok(`Meet adds an independent connection with ${label}`, () => assert.equal(additional.hasJoinBtn, true));
  }
  await page.setContent(`<button aria-label="Leave call">Leave</button>
    <div data-participant-id="remote"><div><span class="notranslate">Анна</span><div role="tooltip">Анна</div></div></div>
    <div data-participant-id="self"><button aria-label="Показать мою картинку">Self</button><span class="notranslate">Google account name</span></div>`);
  await page.evaluate(() => { window[Symbol.for("mtg.audio")] = { levels: () => [{ id: "remote-audio", lvl: 0.125 }] }; });
  const pair = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet excludes its Google account tile and does not duplicate tooltip names", () => { assert.deepEqual(pair.names, ["Анна"]); assert.equal(pair.count, 2); });
  ok("Meet attributes measured audio in a two-person call to the sole remote participant", () => assert.deepEqual(pair.active, ["Анна"]));
  await page.evaluate(() => { window[Symbol.for("mtg.audio")] = { levels: () => [{ id: "remote-audio", lvl: 0 }] }; });
  const silentPair = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet does not mark a silent participant as speaking", () => assert.deepEqual(silentPair.active, []));
  await page.evaluate(() => {
    const tile = document.createElement("div"); tile.dataset.participantId = "remote2"; tile.innerHTML = '<span class="notranslate">Иван</span>'; document.body.append(tile);
    window[Symbol.for("mtg.audio")] = { levels: () => [{ id: "mixed", lvl: 0.125 }] };
  });
  const group = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet never guesses a speaker from mixed audio in a group call", () => { assert.deepEqual(group.active, []); assert.equal(group.count, 3); });
  await page.route("https://accounts.google.com/**", route => route.fulfill({ contentType: "text/html", body: '<h1>Sign in</h1><input name="identifier">' }));
  await page.goto("https://accounts.google.com/ServiceLogin");
  const login = await page.evaluate(`${MEET_OP}({op:"probe"})`);
  ok("Meet detects a redirected account login instead of waiting for meeting controls", () => { assert.equal(login.pageState, "auth_required"); assert.equal(login.inMeeting, false); });
  console.log(JSON.stringify({ passed: checks, fixtureTests: true }));
} finally { await browser.close(); }

});

test("screen capture is denied in top-level and iframe pages while camera and microphone work", { skip: !chromium && "Install the local mock runtime to run browser fixtures" }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    await context.addInitScript({ content: NO_OUTGOING_SCREEN_SHARE_SCRIPT });
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/frame")
      ? "<p>Local iframe</p>" : '<iframe src="/frame" allow="camera; microphone"></iframe>' }));
    const page = await context.newPage();
    await page.goto("https://meetings-fixture.test/");
    await page.locator("iframe").waitFor();
    const frames = page.frames();
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      const result = await frame.evaluate(async () => {
        let error = null;
        try { await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch (caught) { error = caught.name; }
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const kinds = stream.getTracks().map(track => track.kind).sort();
        stream.getTracks().forEach(track => track.stop());
        const audit = globalThis[Symbol.for("AiXenix.notetaker.screenSharePolicy")];
        return { error, kinds, installed: audit.installed, blockedCalls: audit.blockedCalls };
      });
      assert.deepEqual(result, { error: "NotAllowedError", kinds: ["audio", "video"], installed: true, blockedCalls: 1 });
    }
  } finally { await browser.close(); }
});
