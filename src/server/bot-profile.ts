// The bot's name and avatar (docs/dev/DESIGN.md §14): the botName and
// showAvatar settings, and the avatar image kept by the host on the
// recording machine (host `bot.avatar` / `bot.avatarPreview`).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AvatarStatus } from "../shared/contract.js";
import { CHANNEL_BOT_CHANGED, type BotProfile } from "../shared/rpc-contract.js";
import { MeetingsError, errorMessage } from "./errors.js";
import type { MeetingsService } from "./service.js";
import type { MeetingsSettings, SettingsHandle } from "./settings.js";

/** Largest avatar upload, decoded (DESIGN §14). */
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 60_000;

export type AvatarMimeType = "image/png" | "image/jpeg" | "image/webp";

/** The image type from its first bytes, or null when it is not PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): AvatarMimeType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function tooLarge(bytes: number): MeetingsError {
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return new MeetingsError(
    "avatar_too_large",
    `Картинка весит ${mb} МБ, можно не больше 3 МБ`,
    `The image is ${mb} MiB; the limit is 3 MiB`,
  );
}

/**
 * Validate an uploaded avatar: base64 (a data: URL prefix is tolerated),
 * at most 3 MiB decoded, and really a PNG/JPEG/WebP (the type is taken from
 * the bytes). Returns clean base64 and the detected type.
 */
export function decodeAvatar(input: string): { base64: string; mimeType: AvatarMimeType; bytes: number } {
  const base64 = input.replace(/^data:[^,]{0,100},/, "").replace(/\s+/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const estimated = Math.floor((base64.length * 3) / 4) - padding;
  if (estimated > AVATAR_MAX_BYTES) throw tooLarge(estimated);
  if (base64 === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new MeetingsError("invalid_avatar", "Картинка повреждена (некорректный base64)", "The image is not valid base64");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > AVATAR_MAX_BYTES) throw tooLarge(bytes.length);
  return { base64: bytes.toString("base64"), mimeType: avatarType(bytes), bytes: bytes.length };
}

export function avatarType(bytes: Uint8Array): AvatarMimeType {
  const mimeType = sniffImageType(bytes);
  if (mimeType === null) {
    throw new MeetingsError("invalid_avatar", "Нужна картинка PNG, JPEG или WebP", "The avatar must be a PNG, JPEG or WebP image");
  }
  return mimeType;
}

export function botNameOf(settings: Pick<MeetingsSettings, "botName">): string {
  return settings.botName.trim().slice(0, 64) || "Notetaker";
}

export class BotProfileService {
  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: SettingsHandle,
    private readonly service: MeetingsService,
  ) {}

  private changed(): void {
    this.bb.realtime.publish(CHANNEL_BOT_CHANGED, {});
  }

  /** The avatar on the recording machine; null when the host cannot be asked right now. */
  async avatarStatus(): Promise<AvatarStatus | null> {
    try {
      return await this.service.call("bot.avatar", { action: "status" });
    } catch (error) {
      this.bb.log.warn(`Could not read the bot avatar: ${errorMessage(error)}`);
      return null;
    }
  }

  async profile(): Promise<BotProfile> {
    const settings = await this.settings.get();
    const avatar = await this.avatarStatus();
    const hasAvatar = avatar?.hasAvatar ?? false;
    return {
      botName: botNameOf(settings),
      avatar: { hasAvatar, enabled: settings.showAvatar, version: hasAvatar ? (avatar?.updatedAt ?? null) : null },
    };
  }

  async updateProfile(input: { botName?: string; showAvatar?: boolean }): Promise<BotProfile> {
    const patch: { botName?: string; showAvatar?: boolean } = {};
    if (input.botName !== undefined) {
      const name = input.botName.trim();
      if (name === "" || name.length > 64) {
        throw new MeetingsError("invalid_bot_name", "Имя бота: от 1 до 64 символов", "The bot name must be 1-64 characters");
      }
      patch.botName = name;
    }
    if (input.showAvatar !== undefined) patch.showAvatar = input.showAvatar;
    if (Object.keys(patch).length > 0) {
      await this.settings.experimental_set(patch);
      this.changed();
    }
    return this.profile();
  }

  async setAvatar(imageBase64: string): Promise<BotProfile> {
    const image = decodeAvatar(imageBase64);
    await this.service.call("bot.avatar", { action: "set", imageBase64: image.base64, mimeType: image.mimeType }, { timeoutMs: AVATAR_TIMEOUT_MS });
    this.bb.log.info(`Bot avatar replaced (${image.mimeType}, ${image.bytes} bytes)`);
    this.changed();
    return this.profile();
  }

  async clearAvatar(): Promise<BotProfile> {
    await this.service.call("bot.avatar", { action: "clear" });
    this.changed();
    return this.profile();
  }

  /** The frame the bot shows as its camera (avatar + current name), JPEG; null without an avatar. */
  async preview(): Promise<Buffer | null> {
    const settings = await this.settings.get();
    const { jpegBase64 } = await this.service.call("bot.avatarPreview", { botName: botNameOf(settings) }, { timeoutMs: AVATAR_TIMEOUT_MS });
    return jpegBase64 === null ? null : Buffer.from(jpegBase64, "base64");
  }
}
