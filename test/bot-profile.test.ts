import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, decodeAvatar, sniffImageType } from "../src/server/bot-profile.js";
import type { BotProfile } from "../src/shared/rpc-contract.js";
import { botConfigSchema } from "../src/shared/runtime-files.js";
import { ZOOM_URL, hostCalls, load } from "./server-fixtures.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 1)]);

describe("avatar uploads", () => {
  it("detects the image type from the bytes and checks the size", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBeNull();
    expect(decodeAvatar(`data:image/png;base64,${PNG.toString("base64")}`)).toMatchObject({ mimeType: "image/png", bytes: PNG.length });
    expect(() => decodeAvatar(Buffer.from("<svg/>").toString("base64"))).toThrow("Нужна картинка PNG, JPEG или WebP");
    expect(() => decodeAvatar("%%%not base64%%%")).toThrow("некорректный base64");
    const huge = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]).toString("base64");
    expect(() => decodeAvatar(huge)).toThrow("можно не больше 3 МБ");
  });
});

describe("bot profile", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads and updates the name and the avatar switch through settings", async () => {
    const { harness } = await load();
    const profile = (await harness.behavior.callRpc("bot.profile", null)) as BotProfile;
    expect(profile).toEqual({ botName: "Notetaker", avatar: { hasAvatar: false, enabled: true, version: null } });

    const updated = (await harness.behavior.callRpc("bot.updateProfile", { botName: "  Секретарь  ", showAvatar: false })) as BotProfile;
    expect(updated).toEqual({ botName: "Секретарь", avatar: { hasAvatar: false, enabled: false, version: null } });
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "meetings.bot", payload: {} });
    await expect(harness.behavior.callRpc("bot.updateProfile", { botName: "x".repeat(65) })).rejects.toThrow();

    await harness.behavior.callRpc("meetings.join", { url: ZOOM_URL });
    const config = botConfigSchema.parse((hostCalls(harness, "meeting.start")[0]?.input as { config: unknown }).config);
    expect(config).toMatchObject({ botName: "Секретарь", avatar: false, avatarVideo: null });
  });

  it("stores the avatar on the recording host and serves the preview frame", async () => {
    const { harness, fake } = await load({ settings: { botName: "Протокол" } });
    expect((await harness.behavior.fetchHttp("GET", "/bot/avatar-preview?v=1")).status).toBe(404);

    // The declared type is a hint: the bytes decide.
    const set = (await harness.behavior.callRpc("bot.setAvatar", { imageBase64: PNG.toString("base64"), mimeType: "image/jpeg" })) as BotProfile;
    expect(set.avatar).toEqual({ hasAvatar: true, enabled: true, version: 7001 });
    expect(fake.avatarSets).toEqual([{ mimeType: "image/png", bytes: PNG.length }]);
    expect(hostCalls(harness, "bot.avatar").at(-2)?.hostId).toBe("host-1");
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "meetings.bot", payload: {} });

    const preview = await harness.behavior.fetchHttp("GET", "/bot/avatar-preview?v=7001");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/jpeg");
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]));
    expect(fake.previews).toEqual(["Протокол", "Протокол"]);

    await expect(
      harness.behavior.callRpc("bot.setAvatar", { imageBase64: Buffer.from("GIF89a....").toString("base64"), mimeType: "image/png" }),
    ).rejects.toThrow("Нужна картинка PNG, JPEG или WebP");
    expect(fake.avatarSets).toHaveLength(1);

    const cleared = (await harness.behavior.callRpc("bot.clearAvatar", null)) as BotProfile;
    expect(cleared.avatar).toEqual({ hasAvatar: false, enabled: true, version: null });
    expect((await harness.behavior.fetchHttp("GET", "/bot/avatar-preview?v=2")).status).toBe(404);
  });

  it("answers without the avatar when the recording machine is away", async () => {
    const { harness } = await load({ primaryHostId: null });
    const profile = (await harness.behavior.callRpc("bot.profile", null)) as BotProfile;
    expect(profile.avatar).toEqual({ hasAvatar: false, enabled: true, version: null });
    await expect(harness.behavior.callRpc("bot.setAvatar", { imageBase64: PNG.toString("base64"), mimeType: "image/png" })).rejects.toThrow(
      "основная машина",
    );
    expect((await harness.behavior.fetchHttp("GET", "/bot/avatar-preview")).status).toBe(400);
  });

  it("bb meetings bot shows and changes the profile; --avatar reads a file on the server machine", async () => {
    const { harness, fake } = await load();
    const shown = await harness.behavior.runCli(["bot"]);
    expect(shown.stdout).toContain("Bot name: Notetaker");
    expect(shown.stdout).toContain("Avatar: none, the camera stays off");

    const renamed = await harness.behavior.runCli(["bot", "--name", "Летописец", "--show-avatar", "off", "--json"]);
    expect(JSON.parse(renamed.stdout)).toEqual({ botName: "Летописец", avatar: { hasAvatar: false, enabled: false, version: null } });

    dir = await mkdtemp(join(tmpdir(), "meetings-avatar-"));
    await writeFile(join(dir, "me.webp"), WEBP);
    const uploaded = await harness.behavior.runCli(["bot", "--avatar", "me.webp"], { cwd: dir });
    expect(uploaded.exitCode).toBe(0);
    expect(uploaded.stdout).toContain("Avatar: set");
    expect(uploaded.stdout).toContain("camera in meetings: off");
    expect(fake.avatarSets).toEqual([{ mimeType: "image/webp", bytes: WEBP.length }]);

    const missing = await harness.behavior.runCli(["bot", "--avatar", "/nonexistent/avatar.png", "--json"]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "not_found" } });
    await writeFile(join(dir, "big.png"), Buffer.alloc(AVATAR_MAX_BYTES + 1));
    expect((await harness.behavior.runCli(["bot", "--avatar", join(dir, "big.png")])).stderr).toContain("the limit is 3 MiB");

    const cleared = await harness.behavior.runCli(["bot", "--clear-avatar"]);
    expect(cleared.stdout).toContain("Avatar: none");
  });

  it("a Zoom sign-in session never shows the avatar; an import follows the setting", async () => {
    const { harness } = await load({ settings: { showAvatar: true } });
    await harness.behavior.runCli(["zoom-login"]);
    const login = botConfigSchema.parse((hostCalls(harness, "meeting.start")[0]?.input as { config: unknown }).config);
    expect(login).toMatchObject({ mode: "login", avatar: false, avatarVideo: null });
    await harness.behavior.runCli(["import", "/data/call.mp4"]);
    const imported = botConfigSchema.parse((hostCalls(harness, "meeting.import")[0]?.input as { config: unknown }).config);
    expect(imported).toMatchObject({ avatar: true, avatarVideo: null });
  });
});
