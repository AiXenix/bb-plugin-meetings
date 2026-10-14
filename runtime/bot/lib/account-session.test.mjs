import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { profileFor, sessionReady } from "./account-session.mjs";
import { prepareProfile } from "./chrome.mjs";
import { BotRunner, PLATFORMS, validateConfig } from "../bot-runner.mjs";

test("platform profiles override legacy Zoom profiles without leaking Zoom cookies to other providers", () => {
  assert.equal(profileFor({ platform: "meet", browserProfileDir: "/accounts/meet", zoomProfileDir: "/accounts/zoom" }), "/accounts/meet");
  assert.equal(profileFor({ platform: "meet", zoomProfileDir: "/accounts/zoom" }), null);
  assert.equal(profileFor({ platform: "zoom", zoomProfileDir: "/accounts/zoom" }), "/accounts/zoom");
  assert.equal(profileFor({ platform: "mock", zoomProfileDir: "/fixture/zoom" }), "/fixture/zoom");
});

test("authentication needs a live provider cookie and a completed provider destination", () => {
  const cookie = name => [{ name, value: "fixture", expires: -1 }];
  assert.equal(sessionReady("zoom", "https://zoom.us/profile", cookie("_zm_ssid")), true);
  assert.equal(sessionReady("zoom", "https://zoom.us/signin", cookie("_zm_ssid")), false);
  assert.equal(sessionReady("meet", "https://meet.google.com/landing", cookie("SID")), true);
  assert.equal(sessionReady("meet", "https://accounts.google.com/signin", cookie("SID")), false);
  assert.equal(sessionReady("telemost", "https://telemost.360.yandex.kz/", cookie("Session_id")), true);
  assert.equal(sessionReady("telemost", "https://passport.yandex.ru/auth", cookie("Session_id")), false);
  assert.equal(sessionReady("meet", "https://meet.google.com/", [{ name: "SID", value: "fixture", expires: 1 }]), false);
  assert.equal(sessionReady("meet", "https://meet.google.com/", cookie("_zm_ssid")), false);
});

test("meeting profile preparation copies account state and preserves the original account and its locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-profile-"));
  try {
    const account = path.join(root, "account");
    const meeting = path.join(root, "meeting");
    fs.mkdirSync(path.join(account, "Default"), { recursive: true });
    fs.writeFileSync(path.join(account, "Default", "Cookies"), "account-cookie-fixture");
    fs.writeFileSync(path.join(account, "Default", "Preferences"), '{"marker":"keep"}');
    fs.symlinkSync("fixture-lock", path.join(account, "SingletonLock"));
    prepareProfile(meeting, { copyFrom: account });
    assert.equal(fs.readFileSync(path.join(account, "Default", "Cookies"), "utf8"), "account-cookie-fixture");
    assert.equal(fs.lstatSync(path.join(account, "SingletonLock")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(meeting, "SingletonLock")), false);
    assert.equal(fs.readFileSync(path.join(meeting, "Default", "Cookies"), "utf8"), "account-cookie-fixture");
    assert.equal(JSON.parse(fs.readFileSync(path.join(meeting, "Default", "Preferences"), "utf8")).marker, "keep");
    assert.equal(fs.statSync(meeting).mode & 0o777, 0o700);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime supports all adapters and legacy configs without launching a browser on import", () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), ["jitsi", "meet", "mock", "telemost", "zoom"]);
  const runner = new BotRunner("/tmp/meeting-fixture");
  assert.equal(runner.page, null);
  const config = { version: 1, meetingId: "mtg_fixture01", platform: "meet", joinUrl: "https://meet.google.com/abc-defg-hij", botName: "Fixture", maxDurationSec: 60, aloneTimeoutSec: 30, waitingTimeoutSec: 60, screenshotIntervalSec: 10 };
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(validateConfig({ ...config, browserProfileDir: "/accounts/meet" }), []);
});
