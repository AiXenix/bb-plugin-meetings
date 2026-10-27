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
import { kickPageAudio } from "./lib/audio-recovery.mjs";
import { silenceWav } from "./lib/media.mjs";
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
  ok("Telemost probe reports the measured audio levels (sample() drops the mixed slots' ids)", () => assert.deepEqual(roster.tracks, [{ id: "remote", level: 0.125, muted: false }]));
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

test("Zoom audio menu op (deaf-bot recovery) presses only the speaker and Leave Computer Audio items", { skip: !chromium && "Install the local mock runtime to run browser fixtures" }, async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./page/zoom-page.js", import.meta.url), "utf8").trim();
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    // A hostile footer: the meeting's Leave/End controls next to the audio menu, every item records its click.
    await page.setContent(`
      <div id="foot-bar">
        <button class="join-audio-container__btn" aria-label="mute my microphone">Mute</button>
        <div id="audioOptionMenu"><div role="group" aria-expanded="false">
          <button aria-label="More audio controls" onclick="document.querySelector('#menu').hidden=!document.querySelector('#menu').hidden;this.parentElement.setAttribute('aria-expanded', String(!document.querySelector('#menu').hidden))">^</button></div>
          <ul id="menu" role="menu" hidden>
            <li>Select a Speaker</li>
            <li><a role="menuitem" aria-label="Select a speaker Same as System" onclick="window.clicked.push('same')">Same as System</a></li>
            <li><a role="menuitem" aria-label="Select a speaker Fake Audio Output 1" class="checked" onclick="window.clicked.push('fake1')">Fake Audio Output 1</a></li>
            <li><a role="menuitem" onclick="window.clicked.push('leave-meeting')">Leave Meeting</a></li>
            <li><a role="menuitem" onclick="window.clicked.push('end')">End Meeting for All</a></li>
            <li><a role="menuitem" onclick="window.clicked.push('leave-audio')">Leave Computer Audio</a></li>
          </ul>
        </div>
        <button aria-label="Leave" onclick="window.clicked.push('footer-leave')">Leave</button>
      </div>`);
    await page.evaluate(() => { window.clicked = []; });
    const op = (action) => page.evaluate(`(${source})(${JSON.stringify({ op: "audioMenu", action })})`);
    const opened = await op("open");
    assert.equal(opened.toggle, true);
    assert.equal(opened.open, true);
    assert.ok(opened.items.some((item) => item.text === "Leave Computer Audio"), JSON.stringify(opened.items));
    const speaker = await op("speaker");
    assert.equal(speaker.clicked, "Same as System");
    const left = await op("leave");
    assert.equal(left.clicked, "Leave Computer Audio");
    assert.deepEqual(await page.evaluate(() => window.clicked), ["same", "leave-audio"]);
    const closed = await op("close");
    assert.deepEqual(closed, { wasOpen: true, open: false });
    // Zoom lists "Same as System" for the microphone too: only the speaker one is picked, by label or by section.
    for (const labeled of [true, false]) {
      await page.setContent(`
        <div id="audioOptionMenu"><div role="group" aria-expanded="true"><button aria-label="More audio controls">^</button></div>
          <ul role="menu">
            <li>Select a Microphone</li>
            <li><a role="menuitem" ${labeled ? 'aria-label="Select a microphone Same as System"' : ""} onclick="window.clicked.push('mic-same')">Same as System</a></li>
            <li><a role="menuitem" ${labeled ? 'aria-label="Select a microphone Fake Default Audio Input"' : ""} onclick="window.clicked.push('mic-default')">Fake Default Audio Input</a></li>
            <li>Select a Speaker</li>
            <li><a role="menuitem" ${labeled ? 'aria-label="Select a speaker Fake Audio Output 1"' : ""} class="checked" onclick="window.clicked.push('spk-1')">Fake Audio Output 1</a></li>
            <li><a role="menuitem" ${labeled ? 'aria-label="Select a speaker Same as System"' : ""} onclick="window.clicked.push('spk-same')">Same as System</a></li>
            <li><a role="menuitem" onclick="window.clicked.push('leave-audio')">Leave Computer Audio</a></li>
          </ul></div>`);
      await page.evaluate(() => { window.clicked = []; });
      const picked = await op("speaker");
      assert.equal(picked.clicked, "Same as System", JSON.stringify(picked));
      assert.deepEqual(await page.evaluate(() => window.clicked), ["spk-same"], labeled ? "by aria-label" : "by section header");
    }
    // A Russian Zoom UI: "leave the audio conference" is pressed, "leave/end the conference" never.
    await page.setContent(`
      <div id="audioOptionMenu"><div role="group" aria-expanded="true"><button aria-label="More audio controls">^</button></div>
        <ul role="menu">
          <li><a role="menuitem" onclick="window.clicked.push('leave-conf')">Выйти из конференции</a></li>
          <li><a role="menuitem" onclick="window.clicked.push('end-conf')">Завершить конференцию для всех</a></li>
          <li><a role="menuitem" onclick="window.clicked.push('leave-audio-ru')">Выйти из аудиоконференции</a></li>
        </ul></div>`);
    await page.evaluate(() => { window.clicked = []; });
    assert.equal((await op("leave")).clicked, "Выйти из аудиоконференции");
    assert.deepEqual(await page.evaluate(() => window.clicked), ["leave-audio-ru"]);
    await page.setContent(`<div id="audioOptionMenu"><div role="group" aria-expanded="true"><button aria-label="More audio controls">^</button></div>
        <ul role="menu"><li><a role="menuitem" onclick="window.clicked.push('leave-conf')">Выйти из конференции</a></li></ul></div>`);
    await page.evaluate(() => { window.clicked = []; });
    assert.equal((await op("leave")).clicked, null);
    assert.deepEqual(await page.evaluate(() => window.clicked), []);
    await page.evaluate(() => { window.clicked = []; });
    await page.setContent(`<div id="audioOptionMenu"><button aria-label="More audio controls">^</button><ul id="menu" role="menu" hidden><li><a role="menuitem" onclick="window.clicked.push('leave-meeting')">Leave Meeting</a></li></ul></div>`);
    await page.evaluate(() => { window.clicked = []; });
    // Without a Leave Computer Audio item nothing else is ever pressed.
    await op("open");
    assert.equal((await op("leave")).clicked, null);
    assert.deepEqual(await page.evaluate(() => window.clicked), []);
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

// Ported from a downstream review (2026-10-27): the deaf-bot media kick (Telemost/Meet/Jitsi) in real Chrome.
test("the media kick restarts paused WebRTC playback and never plays the platform's own sound files", { skip: !chromium && "Install the local mock runtime to run browser fixtures" }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const wav = `data:audio/wav;base64,${silenceWav(1, 8_000).toString("base64")}`;
    const page = await browser.newPage();
    // Jitsi keeps one paused <audio src> per sound effect (ringing in a loop, reactions).
    await page.setContent(`<audio id="ringing" loop preload="auto" src="${wav}"></audio><audio id="reaction" preload="auto" src="${wav}"></audio><audio id="peer"></audio><video id="camera" muted></video>`);
    await page.evaluate(async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      // A participant's audio as WebRTC delivers it: a MediaStream on an <audio>, paused (autoplay hiccup).
      document.querySelector("#peer").srcObject = dest.stream;
      // A video-only stream (a remote camera): nothing to hear, nothing to do.
      document.querySelector("#camera").srcObject = document.createElement("canvas").captureStream(1);
      for (const id of ["ringing", "reaction"]) {
        const el = document.getElementById(id);
        if (el.readyState < 1) await new Promise((resolve) => el.addEventListener("loadedmetadata", resolve, { once: true }));
      }
    });
    const result = await kickPageAudio(page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const paused = await page.evaluate(() => Object.fromEntries(["ringing", "reaction", "peer", "camera"].map((id) => [id, document.getElementById(id).paused])));
    assert.deepEqual(paused, { ringing: true, reaction: true, peer: false, camera: true }, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.played, 1);
    assert.equal(result.files, 2);
    assert.match(result.detail, /restarted 1\b/);
  } finally { await browser.close(); }
});

// Telemost speaking indicator (2026-10-27): the client outlines a speaking participant's tile by
// adding the CSS-module class rootStroke_<hash> to the tile's inner root (server voice activity and
// not muted). The fixture is a real 4-tile grid from a recorded meeting, anonymized: the bot's self
// view and a second bot share the name "Test Bot"; "Alice Example" and the default guest name "Гость"
// are outlined. Every case but the last two failed on the adapter that looked for "speaking" classes.
test("Telemost reports exactly the outlined tiles as speaking, the bot never", { skip: !chromium && "Install the local mock runtime to run browser fixtures" }, async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("./.fixtures/telemost-grid.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const probe = (botName = "Test Bot") => page.evaluate(`${TELEMOST_OP}(${JSON.stringify({ op: "probe", botName })})`);
    const tiles = "[class*='newGridItem_']";
    const sorted = (list) => [...list].sort();
    /** Outline exactly these tiles: display names, "SELF" (the self view) or "OTHERBOT" (the second "Test Bot"). */
    const outline = (on) => page.evaluate(({ on, tiles }) => {
      for (const tile of document.querySelectorAll(tiles)) {
        const name = tile.querySelector("[class*='TextName_']").getAttribute("title");
        const self = tile.matches("[class*='selfView_']");
        const want = on.some((x) => x === name || (x === "SELF" && self) || (x === "OTHERBOT" && name === "Test Bot" && !self));
        tile.querySelector("[class*='root_']").classList.toggle("rootStroke_Kb2PJ", want);
      }
    }, { on, tiles });

    await page.setContent(html);
    const captured = await probe();
    assert.equal(captured.inMeeting, true);
    assert.equal(captured.totalParticipants, 4);
    assert.deepEqual(sorted(captured.names), ["Alice Example", "Гость"], "the default guest name is a participant");
    assert.deepEqual(sorted(captured.active), ["Alice Example", "Гость"], "both outlined tiles speak");

    await outline([]);
    assert.deepEqual((await probe()).active, [], "no outline: nobody speaks");
    await outline(["Alice Example"]);
    assert.deepEqual((await probe()).active, ["Alice Example"]);
    await outline(["SELF", "OTHERBOT"]);
    assert.deepEqual((await probe()).active, [], "the bot's own tile and a same-named bot never speak");

    // Two anonymous guests: only the second one is outlined; the name is listed once and lit.
    await page.setContent(html);
    await page.evaluate((tiles) => {
      const guest = Array.from(document.querySelectorAll(tiles)).find((tile) => tile.querySelector("[title='Гость']"));
      const clone = guest.cloneNode(true);
      guest.querySelector("[class*='root_']").classList.remove("rootStroke_Kb2PJ");
      guest.after(clone);
    }, tiles);
    const guests = await probe();
    assert.equal(guests.names.filter((name) => name === "Гость").length, 1);
    assert.deepEqual(sorted(guests.active), ["Alice Example", "Гость"]);

    // The grid item class renamed: the tile is still found per badge, the grid never counts as one tile.
    await page.setContent(html);
    await outline(["Alice Example"]);
    await page.evaluate((tiles) => { for (const tile of document.querySelectorAll(tiles)) tile.className = tile.className.replace(/newGridItem_\S+/, "gridCell_ZZZZZ"); }, tiles);
    const renamed = await probe();
    assert.deepEqual(sorted(renamed.names), ["Alice Example", "Гость"]);
    assert.deepEqual(renamed.active, ["Alice Example"]);

    // An outlined tile without a name badge (a screen share) lights nobody.
    await page.setContent(html);
    await outline([]);
    await page.evaluate(() => {
      const share = document.createElement("div");
      share.className = "item_NZ2DW newGridItem_X3tXt itemDisplay_D0Ml1";
      share.style.cssText = "transform: translate(0px, 0px); width: 300px; height: 200px;";
      share.innerHTML = '<div style="position:relative;width:100%;height:100%"><div class="root_ypmDo rootPresenter_Tj9H- rootStroke_Kb2PJ"></div></div>';
      document.querySelector(".GoloomParticipantsRenderer").prepend(share);
    });
    assert.deepEqual((await probe()).active, []);

    // Status texts in a tile are no indicator: Telemost's "video appears when the participant speaks".
    await page.setContent(html);
    await outline([]);
    await page.evaluate(() => {
      for (const status of document.querySelectorAll(".participantStatuses")) {
        status.innerHTML = '<div aria-label="Видео появится, когда участник заговорит" title="Video will appear when the participant starts speaking">i</div>';
      }
    });
    assert.deepEqual((await probe()).active, [], "a limited-video note is not speech");

    // A person whose name is only part of the bot's ("Test" next to the bot "Test Bot") is a participant.
    await page.setContent(html);
    await page.evaluate(() => { const badge = document.querySelector("[title='Alice Example']"); badge.title = "Test"; badge.textContent = "Test"; });
    await outline(["Test"]);
    const partial = await probe();
    assert.deepEqual(sorted(partial.names), ["Test", "Гость"]);
    assert.deepEqual(partial.active, ["Test"]);

    // The self view is the bot even under another name (a signed-in Yandex account), outlined or not.
    await page.setContent(html);
    await page.evaluate(() => { const badge = document.querySelector("[class*='selfView_'] [class*='TextName_']"); badge.title = "Yandex Account"; badge.textContent = "Yandex Account"; });
    await outline(["SELF"]);
    const signedIn = await probe();
    assert.deepEqual(sorted(signedIn.names), ["Alice Example", "Гость"]);
    assert.deepEqual(signedIn.active, []);
  } finally { await browser.close(); }
});
