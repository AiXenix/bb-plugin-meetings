// The bot's avatar on the host (DESIGN §14): upload validation and
// normalization (bot.avatar), the camera frame (bot.avatarPreview), the MJPEG
// for Chrome's fake camera with its cache and pruning, and meeting.start
// filling config.avatarVideo. Uses the real ffmpeg; contract-validated
// through the SDK harness where a host method is involved.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import {
  AVATAR_MAX_BYTES,
  FONT_CANDIDATES,
  KEEP_RENDERS,
  decodeBase64,
  displayName,
  findFont,
  inspectImage,
  nameFontSize,
  orientationFilters,
  pruneRenders,
  renderAvatarPreview,
  renderAvatarVideo,
  renderKey,
  silenceWav,
  sniffImage,
} from "../src/host/avatar.js";
import type { HostPaths } from "../src/host/paths.js";
import { botConfig, cleanupTempDirs, fakeHostData, newMeetingId, tempDir, waitFor } from "./host-helpers.js";

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const ORANGE = [255, 122, 26];

const harnesses: Array<{ experimental_dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.experimental_dispose()));
  await cleanupTempDirs();
});

async function setup() {
  const { dataDir, tempDir: workerTemp, paths } = await fakeHostData();
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: workerTemp } });
  harnesses.push(harness);
  return { call: harness.experimental_call.bind(harness), paths };
}

/** An image made by ffmpeg from a lavfi source graph (`-f lavfi -i <graph>`), returned as bytes. */
async function makeImage(graph: string, ext: "png" | "jpg" | "webp", extra: string[] = []): Promise<Buffer> {
  const file = path.join(await tempDir("avatar-src-"), `src.${ext}`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", graph, "-frames:v", "1", ...extra, file]);
  return fs.readFile(file);
}

/** RGB of one pixel of an image or video file (first frame). */
function pixel(file: string, x: number, y: number): number[] {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...out.subarray(0, 3)];
}

function probe(file: string): Record<string, string> {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,pix_fmt,nb_read_frames,sample_rate,channels:format=format_name", "-of", "default=nw=1", file],
    { encoding: "utf8" },
  );
  return Object.fromEntries(out.trim().split("\n").map((line) => line.split("=") as [string, string]));
}

function near(actual: number[], expected: number[], tolerance = 40): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);
}

/** Insert an EXIF APP1 segment with one Orientation tag right after the JPEG SOI. */
function withExifOrientation(jpeg: Buffer, orientation: number, bigEndian = false): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write(bigEndian ? "MM" : "II", 0, "latin1");
  const u16 = (value: number, at: number) => (bigEndian ? tiff.writeUInt16BE(value, at) : tiff.writeUInt16LE(value, at));
  const u32 = (value: number, at: number) => (bigEndian ? tiff.writeUInt32BE(value, at) : tiff.writeUInt32LE(value, at));
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(orientation, 18);
  u32(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** A PNG signature + IHDR claiming the given size (no image data). */
function fakePngHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function webpChunk(fourcc: string, body: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  header.write(fourcc, 12, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

/**
 * A baseline grayscale JPEG with one frame header + scan per entry (mid-gray:
 * every 8x8 block is "DC diff 0, end of block", 2 bits), so a huge frame is a
 * small file. ffmpeg decodes the last frame; the first header says little.
 */
function grayJpeg(frames: ReadonlyArray<{ width: number; height: number }>): Buffer {
  const segment = (marker: number, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xff00 | marker, 0);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  // One 1-bit Huffman code per table: DC category 0, AC end-of-block.
  const huffman = (tableClass: number) => Buffer.from([tableClass << 4, 1, ...new Array<number>(15).fill(0), 0x00]);
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), segment(0xc4, huffman(0)), segment(0xc4, huffman(1))];
  for (const { width, height } of frames) {
    const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
    sof.writeUInt16BE(height, 1);
    sof.writeUInt16BE(width, 3);
    const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
    const scan = Buffer.alloc(Math.ceil(bits / 8));
    if (bits % 8 !== 0) scan[scan.length - 1] = 0xff >> bits % 8;
    parts.push(segment(0xc0, sof), segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])), scan);
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** A JPEG made only of headers: SOI, then frame headers (marker, width, height), then SOS. */
function jpegHeaders(frames: ReadonlyArray<[marker: number, width: number, height: number]>): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];
  for (const [marker, width, height] of frames) {
    const sof = Buffer.from([0xff, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    parts.push(sof);
  }
  parts.push(Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]));
  return Buffer.concat(parts);
}

/** Ink extent (x of the first and last bright pixel) of rows y0..y1 of a JPEG frame. */
function inkExtent(file: string, y0: number, y1: number, width = 1280): { left: number; right: number } {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `crop=${width}:${y1 - y0}:0:${y0}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  let left = width;
  let right = -1;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i]! < 180) continue;
    left = Math.min(left, i % width);
    right = Math.max(right, i % width);
  }
  return { left, right };
}

const ORANGE_SQUARE = "color=c=0xff7a1a:s=600x600";
/** 900x600: red | green | blue thirds. A center crop keeps x 150..750. */
const THIRDS =
  "color=c=red:s=900x600,drawbox=x=300:y=0:w=300:h=600:color=0x00ff00:t=fill,drawbox=x=600:y=0:w=300:h=600:color=blue:t=fill";

describe("image inspection", () => {
  it("knows PNG, JPEG and WebP by their magic bytes, not by name", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(webpChunk("VP8 ", Buffer.alloc(10)))).toBe("webp");
    expect(sniffImage(Buffer.from("GIF89a......"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns=…>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(2))).toBeNull();
  });

  it("reads dimensions from PNG, JPEG (any SOF) and every WebP flavour", async () => {
    expect(inspectImage(fakePngHeader(640, 480))).toMatchObject({ type: "png", width: 640, height: 480, orientation: 1 });
    // VP8 key frame: tag, start code, 14-bit sizes.
    const vp8 = Buffer.alloc(20);
    Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8, 3);
    vp8.writeUInt16LE(320, 6);
    vp8.writeUInt16LE(200, 8);
    expect(inspectImage(webpChunk("VP8 ", vp8))).toMatchObject({ type: "webp", width: 320, height: 200 });
    // VP8L: signature 0x2f, then (w-1) and (h-1) in 14 bits each.
    const vp8l = Buffer.alloc(10);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE((99 & 0x3fff) | ((49 & 0x3fff) << 14), 1);
    expect(inspectImage(webpChunk("VP8L", vp8l))).toMatchObject({ width: 100, height: 50 });
    // VP8X: 24-bit (w-1), (h-1).
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1999, 4, 3);
    vp8x.writeUIntLE(999, 7, 3);
    expect(inspectImage(webpChunk("VP8X", vp8x))).toMatchObject({ width: 2000, height: 1000 });
    vp8x[0] = 0x02; // animation flag
    expect(() => inspectImage(webpChunk("VP8X", vp8x))).toThrow(/Анимированные WebP/);
    if (HAS_FFMPEG) {
      expect(inspectImage(await makeImage("color=c=red:s=300x200", "jpg"))).toMatchObject({ type: "jpeg", width: 300, height: 200 });
      expect(inspectImage(await makeImage("color=c=red:s=300x200", "jpg", ["-q:v", "2"]))).toMatchObject({ width: 300 });
      expect(inspectImage(await makeImage("color=c=red:s=64x48", "webp", ["-c:v", "libwebp", "-lossless", "1"]))).toMatchObject({ type: "webp", width: 64, height: 48 });
      expect(inspectImage(await makeImage("color=c=red:s=64x48", "webp", ["-c:v", "libwebp"]))).toMatchObject({ type: "webp", width: 64, height: 48 });
    }
  });

  it("finds the EXIF orientation in little- and big-endian TIFF headers", async () => {
    if (!HAS_FFMPEG) return;
    const jpeg = await makeImage("color=c=red:s=300x200", "jpg");
    expect(inspectImage(withExifOrientation(jpeg, 6)).orientation).toBe(6);
    expect(inspectImage(withExifOrientation(jpeg, 8, true)).orientation).toBe(8);
    expect(inspectImage(withExifOrientation(jpeg, 42)).orientation).toBe(1);
    expect(inspectImage(jpeg).orientation).toBe(1);
  });

  it("sizes a JPEG by its largest frame header, of any type, up to the first scan", () => {
    expect(inspectImage(jpegHeaders([[0xc0, 640, 480]]))).toMatchObject({ type: "jpeg", width: 640, height: 480 });
    // ffmpeg skips the frame types it cannot decode (here SOF5) and a later header replaces an earlier one.
    expect(() => inspectImage(jpegHeaders([[0xc5, 1, 1], [0xc0, 12_000, 12_000]]))).toThrow(/слишком большое \(12000×12000\)/);
    expect(() => inspectImage(jpegHeaders([[0xc0, 1, 1], [0xc0, 12_000, 12_000]]))).toThrow(/слишком большое/);
    expect(() => inspectImage(jpegHeaders([[0xc2, 100, 16_000], [0xc0, 16_000, 100]]))).toThrow(/слишком большое/);
  });

  it("sizes an extended WebP by its canvas or its bitstream, whichever is larger", () => {
    // VP8X canvas 1x1 around a 12000x12000 VP8L: ffmpeg decodes the bitstream's size.
    const canvas = Buffer.alloc(18);
    canvas.write("VP8X", 0, "latin1");
    canvas.writeUInt32LE(10, 4);
    const vp8l = Buffer.alloc(14);
    vp8l.write("VP8L", 0, "latin1");
    vp8l.writeUInt32LE(5, 4);
    vp8l[8] = 0x2f;
    vp8l.writeUInt32LE((11_999 & 0x3fff) | ((11_999 & 0x3fff) << 14), 9);
    const alph = Buffer.alloc(9 + 1);
    alph.write("ALPH", 0, "latin1");
    alph.writeUInt32LE(1, 4); // odd size: one pad byte follows
    const webp = (...chunks: Buffer[]) => {
      const body = Buffer.concat(chunks);
      const head = Buffer.alloc(12);
      head.write("RIFF", 0, "latin1");
      head.writeUInt32LE(4 + body.length, 4);
      head.write("WEBP", 8, "latin1");
      return Buffer.concat([head, body]);
    };
    expect(() => inspectImage(webp(canvas, vp8l))).toThrow(/слишком большое \(12000×12000\)/);
    expect(() => inspectImage(webp(canvas, alph, vp8l))).toThrow(/слишком большое/);
    vp8l.writeUInt32LE((63 & 0x3fff) | ((47 & 0x3fff) << 14), 9);
    canvas.writeUIntLE(63, 12, 3);
    canvas.writeUIntLE(47, 15, 3);
    expect(inspectImage(webp(canvas, alph, vp8l))).toMatchObject({ type: "webp", width: 64, height: 48 });
  });

  it("refuses unreadable, truncated and huge images before decoding them", () => {
    expect(() => inspectImage(Buffer.from("not an image at all"))).toThrow(/PNG, JPEG или WebP/);
    expect(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toThrow(/размер/);
    expect(() => inspectImage(fakePngHeader(0, 10))).toThrow(/размер/);
    expect(() => inspectImage(fakePngHeader(20_000, 100))).toThrow(/слишком большое/);
    expect(() => inspectImage(fakePngHeader(10_000, 10_000))).toThrow(/слишком большое/);
  });

  it("maps EXIF orientations to ffmpeg filters", () => {
    expect(orientationFilters(1)).toEqual([]);
    expect(orientationFilters(3)).toEqual(["hflip", "vflip"]);
    expect(orientationFilters(6)).toEqual(["transpose=1"]);
    expect(orientationFilters(8)).toEqual(["transpose=2"]);
    expect(orientationFilters(5)).toEqual(["transpose=0"]);
    expect(orientationFilters(7)).toEqual(["transpose=3"]);
  });

  it("decodes strict base64 and data: URLs only", () => {
    expect(decodeBase64("aGVsbG8=")?.toString()).toBe("hello");
    expect(decodeBase64("data:image/png;base64,aGVs\nbG8=")?.toString()).toBe("hello");
    expect(decodeBase64("")).toBeNull();
    expect(decodeBase64("not base64!")).toBeNull();
    expect(decodeBase64("aGVsbG8")).not.toBeNull();
    expect(decodeBase64("a")).toBeNull();
  });

  it("keeps names on one line and sizes them to fit", () => {
    expect(displayName("  Bot\nname\u0007  x ")).toBe("Bot name x");
    // From the measured width at 52 px: fit 1180 px.
    expect(nameFontSize("Notetaker", 250)).toBe(52);
    expect(nameFontSize("x".repeat(60), 2360)).toBe(26);
    expect(nameFontSize("W".repeat(64), 100_000)).toBe(12);
    // Without a measurement: one em per character.
    expect(nameFontSize("Notetaker")).toBe(52);
    expect(nameFontSize("Ш".repeat(64)) * 64).toBeLessThanOrEqual(1180);
    expect(nameFontSize("x".repeat(30), null)).toBe(39);
  });

  it("writes a 48 kHz mono PCM WAV of silence", () => {
    const wav = silenceWav();
    expect(wav.length).toBe(44 + 96_000);
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
  });

  it("keys renders by name, avatar bytes and font", () => {
    const a = Buffer.from("avatar-a");
    expect(renderKey("Bot", a, "/f.ttf")).toMatch(/^[0-9a-f]{12}$/);
    expect(renderKey("Bot", a, "/f.ttf")).toBe(renderKey("Bot", Buffer.from("avatar-a"), "/f.ttf"));
    expect(renderKey("Bot2", a, "/f.ttf")).not.toBe(renderKey("Bot", a, "/f.ttf"));
    expect(renderKey("Bot", Buffer.from("avatar-b"), "/f.ttf")).not.toBe(renderKey("Bot", a, "/f.ttf"));
    expect(renderKey("Bot", a, null)).not.toBe(renderKey("Bot", a, "/f.ttf"));
  });

  it("finds a font from the candidates, and falls back past missing ones", async () => {
    const dir = await tempDir("avatar-font-");
    const font = path.join(dir, "Font.ttf");
    await fs.writeFile(font, "ttf");
    expect(await findFont([path.join(dir, "missing.ttf"), font])).toBe(font);
    expect(FONT_CANDIDATES[0]).toMatch(/DejaVuSans\.ttf$/);
  });
});

describe.skipIf(!HAS_FFMPEG)("bot.avatar", () => {
  it("stores a center-cropped 512 px square PNG and reports it", async () => {
    const { call, paths } = await setup();
    expect(await call("bot.avatar", { action: "status" })).toEqual({ hasAvatar: false, updatedAt: null, size: null });
    const source = await makeImage(THIRDS, "png");
    const before = Date.now();
    const status = await call("bot.avatar", { action: "set", imageBase64: source.toString("base64"), mimeType: "image/png" });
    expect(status).toMatchObject({ hasAvatar: true, size: 512 });
    expect(status.updatedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(probe(paths.avatar)).toMatchObject({ codec_name: "png", width: "512", height: "512", pix_fmt: "rgba" });
    // x 150..750 of the source: red, green, blue thirds in the square.
    expect(near(pixel(paths.avatar, 10, 256), [255, 0, 0])).toBe(true);
    expect(near(pixel(paths.avatar, 256, 256), [0, 255, 0])).toBe(true);
    expect(near(pixel(paths.avatar, 500, 256), [0, 0, 255])).toBe(true);
    expect(await call("bot.avatar", { action: "status" })).toEqual(status);
    // Nothing but the result and the cache dirs is left behind.
    expect((await fs.readdir(paths.botDir)).filter((name) => name.startsWith(".work-"))).toEqual([]);
  });

  it("accepts JPEG and WebP, applies the EXIF orientation, trusts the bytes over the declared type", async () => {
    const { call, paths } = await setup();
    // 300x200, top half blue, bottom half red; EXIF 6 = rotate 90° clockwise: red ends up left, blue right.
    const jpeg = withExifOrientation(await makeImage("color=c=red:s=300x200,drawbox=x=0:y=0:w=300:h=100:color=blue:t=fill", "jpg", ["-q:v", "2"]), 6);
    await call("bot.avatar", { action: "set", imageBase64: jpeg.toString("base64"), mimeType: "image/jpeg" });
    expect(near(pixel(paths.avatar, 30, 256), [255, 0, 0], 60)).toBe(true);
    expect(near(pixel(paths.avatar, 480, 256), [0, 0, 255], 60)).toBe(true);
    // A JPEG declared as PNG (a renamed file) is still a JPEG.
    const plain = await makeImage(ORANGE_SQUARE, "jpg", ["-q:v", "2"]);
    expect(await call("bot.avatar", { action: "set", imageBase64: plain.toString("base64"), mimeType: "image/png" })).toMatchObject({ hasAvatar: true });
    expect(near(pixel(paths.avatar, 256, 256), ORANGE)).toBe(true);
    const webp = await makeImage("color=c=0x00ff00:s=200x300", "webp", ["-c:v", "libwebp", "-lossless", "1"]);
    await call("bot.avatar", { action: "set", imageBase64: webp.toString("base64"), mimeType: "image/webp" });
    expect(probe(paths.avatar)).toMatchObject({ width: "512", height: "512" });
    expect(near(pixel(paths.avatar, 256, 256), [0, 255, 0])).toBe(true);
  });

  it("rejects bad uploads and keeps the previous avatar", async () => {
    const { call, paths } = await setup();
    const good = await makeImage(ORANGE_SQUARE, "png");
    const status = await call("bot.avatar", { action: "set", imageBase64: good.toString("base64"), mimeType: "image/png" });
    const reject = (input: { imageBase64?: string; mimeType?: "image/png" | "image/jpeg" | "image/webp" }) => call("bot.avatar", { action: "set", ...input });
    await expect(reject({ mimeType: "image/png" })).rejects.toThrow(/Нет изображения/);
    await expect(reject({ imageBase64: good.toString("base64") })).rejects.toThrow(/PNG, JPEG или WebP/);
    await expect(reject({ imageBase64: "%%%not-base64%%%", mimeType: "image/png" })).rejects.toThrow(/base64/);
    await expect(reject({ imageBase64: Buffer.from("plain text, not an image").toString("base64"), mimeType: "image/png" })).rejects.toThrow(/не похож/);
    const big = Buffer.concat([good, Buffer.alloc(AVATAR_MAX_BYTES + 1 - good.length)]);
    await expect(reject({ imageBase64: big.toString("base64"), mimeType: "image/png" })).rejects.toThrow(/больше 3 МБ/);
    await expect(reject({ imageBase64: fakePngHeader(30_000, 30_000).toString("base64"), mimeType: "image/png" })).rejects.toThrow(/слишком большое/);
    // The first frame header says 16x16, ffmpeg would decode a later 9000x9000 one (81 MP):
    // the decoder's own pixel limit refuses it.
    const decoy = grayJpeg([{ width: 16, height: 16 }, { width: 9_000, height: 9_000 }]);
    expect(inspectImage(decoy)).toMatchObject({ width: 16, height: 16 });
    await expect(reject({ imageBase64: decoy.toString("base64"), mimeType: "image/jpeg" })).rejects.toThrow(/Не удалось обработать/);
    // A header that looks fine with no image behind it: ffmpeg fails, nothing is replaced.
    await expect(reject({ imageBase64: fakePngHeader(64, 64).toString("base64"), mimeType: "image/png" })).rejects.toThrow(/Не удалось обработать/);
    expect(await call("bot.avatar", { action: "status" })).toEqual(status);
    expect(near(pixel(paths.avatar, 256, 256), ORANGE)).toBe(true);
    expect((await fs.readdir(paths.botDir)).filter((name) => name.startsWith(".work-"))).toEqual([]);
  });

  it("decodes an image just inside the pixel limit (the decoder's limit leaves room for its padding)", async () => {
    const { call, paths } = await setup();
    const near = grayJpeg([{ width: 7_999, height: 8_001 }]);
    expect(inspectImage(near)).toMatchObject({ width: 7_999, height: 8_001 });
    expect(await call("bot.avatar", { action: "set", imageBase64: near.toString("base64"), mimeType: "image/jpeg" })).toMatchObject({ hasAvatar: true, size: 512 });
    expect(probe(paths.avatar)).toMatchObject({ width: "512", height: "512" });
  });

  it("crops long strips to a square before scaling them (no huge intermediate frame)", async () => {
    const { call, paths } = await setup();
    // Scaling first made 2x4000 a 512x1024000 frame: ffmpeg failed after ~12 s at 0.8 GB.
    const strip = await makeImage("color=c=0xff7a1a:s=2x4000", "png");
    const started = Date.now();
    expect(await call("bot.avatar", { action: "set", imageBase64: strip.toString("base64"), mimeType: "image/png" })).toMatchObject({ hasAvatar: true, size: 512 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(probe(paths.avatar)).toMatchObject({ width: "512", height: "512" });
    expect(near(pixel(paths.avatar, 256, 256), ORANGE)).toBe(true);
  });

  it("clears the avatar and its renders", async () => {
    const { call, paths } = await setup();
    const good = await makeImage(ORANGE_SQUARE, "png");
    await call("bot.avatar", { action: "set", imageBase64: good.toString("base64"), mimeType: "image/png" });
    const video = await renderAvatarVideo(paths, "Bot", { font: null });
    expect(video).not.toBeNull();
    expect(await call("bot.avatar", { action: "clear" })).toEqual({ hasAvatar: false, updatedAt: null, size: null });
    await expect(fs.stat(paths.avatar)).rejects.toThrow();
    expect(await fs.readdir(paths.avatarRenders)).toEqual([]);
    expect(await call("bot.avatarPreview", { botName: "Bot" })).toEqual({ jpegBase64: null });
  });
});

describe.skipIf(!HAS_FFMPEG)("rendering", () => {
  async function withAvatar(): Promise<{ call: Awaited<ReturnType<typeof setup>>["call"]; paths: HostPaths }> {
    const { call, paths } = await setup();
    const good = await makeImage(ORANGE_SQUARE, "png");
    await call("bot.avatar", { action: "set", imageBase64: good.toString("base64"), mimeType: "image/png" });
    return { call, paths };
  }

  it("previews the 1280x720 camera frame as a JPEG: avatar circle on a dark background", async () => {
    const { call } = await withAvatar();
    const { jpegBase64 } = await call("bot.avatarPreview", { botName: "Записывающий бот" });
    expect(jpegBase64).not.toBeNull();
    const jpeg = Buffer.from(jpegBase64!, "base64");
    expect(sniffImage(jpeg)).toBe("jpeg");
    const file = path.join(await tempDir("avatar-preview-"), "preview.jpg");
    await fs.writeFile(file, jpeg);
    expect(probe(file)).toMatchObject({ width: "1280", height: "720" });
    expect(near(pixel(file, 640, 200), ORANGE)).toBe(true);
    const corner = pixel(file, 40, 40);
    expect(corner.every((v) => v < 70)).toBe(true);
  });

  it("fits long and wide names inside the frame, measured with the font itself", async (context) => {
    if ((await findFont()) === null) context.skip();
    const { paths } = await withAvatar();
    const dir = await tempDir("avatar-names-");
    const names = ["ПРОТОКОЛ ВСТРЕЧИ: ООО «МЕЖРЕГИОНАЛЬНАЯ ШИРОКОПОЛОСНАЯ СВЯЗЬ»", "W".repeat(64), "Ж".repeat(40), "Notetaker"];
    const widths: number[] = [];
    for (const [i, name] of names.entries()) {
      const jpeg = await renderAvatarPreview(paths, name);
      const file = path.join(dir, `name-${i}.jpg`);
      await fs.writeFile(file, Buffer.from(jpeg!, "base64"));
      // The name is drawn below the circle (y >= 500); its ink must stay off the edges.
      const { left, right } = inkExtent(file, 500, 720);
      expect(right, name).toBeGreaterThan(left);
      expect(left, name).toBeGreaterThanOrEqual(20);
      expect(right, name).toBeLessThanOrEqual(1260);
      widths.push(right - left);
    }
    // A short name keeps the full size: about 250 px for "Notetaker" at 52 px.
    expect(widths.at(-1)).toBeGreaterThan(200);
  });

  it("renders the MJPEG Chrome plays (10 baseline JPEG frames, 1280x720) and silence.wav, then reuses it", async () => {
    const { paths } = await withAvatar();
    const video = await renderAvatarVideo(paths, "Notetaker");
    expect(video).not.toBeNull();
    expect(path.dirname(video!)).toBe(paths.avatarRenders);
    expect(path.basename(video!)).toMatch(/^[0-9a-f]{12}\.mjpeg$/);
    expect(probe(video!)).toMatchObject({ codec_name: "mjpeg", width: "1280", height: "720", pix_fmt: "yuvj420p", nb_read_frames: "10" });
    const bytes = await fs.readFile(video!);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(near(pixel(video!, 640, 200), ORANGE)).toBe(true);
    expect(probe(paths.silenceWav)).toMatchObject({ codec_name: "pcm_s16le", sample_rate: "48000", channels: "1" });

    const first = await fs.stat(video!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await renderAvatarVideo(paths, "Notetaker")).toBe(video);
    const again = await fs.stat(video!);
    expect(again.ino).toBe(first.ino); // not rendered again
    expect(again.mtimeMs).toBeGreaterThan(first.mtimeMs); // but marked as recently used
    const other = await renderAvatarVideo(paths, "Другое имя");
    expect(other).not.toBe(video);
    expect(await renderAvatarVideo(paths, "Notetaker", { font: null })).not.toBe(video);
    expect((await fs.readdir(paths.botDir)).filter((name) => name.startsWith(".work-"))).toEqual([]);
  });

  it("returns null without an avatar", async () => {
    const { paths } = await setup();
    expect(await renderAvatarVideo(paths, "Bot")).toBeNull();
    expect(await renderAvatarPreview(paths, "Bot")).toBeNull();
  });

  it("prunes old renders but never one a running Chrome plays", async () => {
    const { paths } = await setup();
    await fs.mkdir(paths.avatarRenders, { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < KEEP_RENDERS + 3; i += 1) {
      const file = path.join(paths.avatarRenders, `${String(i).padStart(12, "0")}.mjpeg`);
      await fs.writeFile(file, "x");
      const time = new Date(Date.now() - (KEEP_RENDERS + 3 - i) * 60_000);
      await fs.utimes(file, time, time);
      files.push(file);
    }
    await fs.writeFile(path.join(paths.avatarRenders, "notes.txt"), "kept");
    // The oldest is in use.
    expect(await pruneRenders(paths, KEEP_RENDERS, null, new Set([files[0]!]))).toBe(2);
    const left = await fs.readdir(paths.avatarRenders);
    expect(left).toContain(path.basename(files[0]!));
    expect(left).not.toContain(path.basename(files[1]!));
    expect(left).not.toContain(path.basename(files[2]!));
    expect(left).toContain("notes.txt");
    expect(left.filter((name) => name.endsWith(".mjpeg"))).toHaveLength(KEEP_RENDERS + 1);
    // keep = 0 (avatar replaced or cleared): everything not in use goes.
    expect(await pruneRenders(paths, 0, null, new Set([files[0]!]))).toBe(KEEP_RENDERS);
  });

  it("finds renders in use on Chrome's command line", async () => {
    const { paths } = await setup();
    await fs.mkdir(paths.avatarRenders, { recursive: true });
    const used = path.join(paths.avatarRenders, "aaaaaaaaaaaa.mjpeg");
    const unused = path.join(paths.avatarRenders, "bbbbbbbbbbbb.mjpeg");
    await fs.writeFile(used, "x");
    await fs.writeFile(unused, "x");
    // A process whose argv carries the flag, like the bot's Chrome.
    const chrome = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", `--use-file-for-fake-video-capture=${used}`], { stdio: "ignore" });
    try {
      await waitFor(
        async () => (await fs.readFile(`/proc/${chrome.pid}/cmdline`, "utf8").catch(() => "")).includes(used),
        Boolean,
        5_000,
        "the fake Chrome process",
      );
      expect(await pruneRenders(paths, 0)).toBe(1);
      expect(await fs.readdir(paths.avatarRenders)).toEqual([path.basename(used)]);
    } finally {
      chrome.kill("SIGKILL");
    }
  });

  it("keeps the render a starting bot's config.json names (before its Chrome is up)", async () => {
    const { paths } = await setup();
    await fs.mkdir(paths.avatarRenders, { recursive: true });
    const used = path.join(paths.avatarRenders, "cccccccccccc.mjpeg");
    await fs.writeFile(used, "x");
    const dir = path.join(paths.meetings, newMeetingId());
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ avatarVideo: used }));
    const runner = path.join(await tempDir("avatar-runner-"), "bot-runner.mjs");
    await fs.writeFile(runner, "setTimeout(() => {}, 30000);\n");
    const bot = spawn(process.execPath, [runner, "--meeting-dir", dir], { stdio: "ignore" });
    try {
      await waitFor(
        async () => (await fs.readFile(`/proc/${bot.pid}/cmdline`, "utf8").catch(() => "")).includes(dir),
        Boolean,
        5_000,
        "the fake bot runner",
      );
      expect(await pruneRenders(paths, 0)).toBe(0);
      expect(await fs.readdir(paths.avatarRenders)).toEqual([path.basename(used)]);
    } finally {
      bot.kill("SIGKILL");
    }
    expect(await pruneRenders(paths, 0)).toBe(1);
  });
});

describe.skipIf(!HAS_FFMPEG)("meeting.start and the avatar", () => {
  async function startWith(call: Awaited<ReturnType<typeof setup>>["call"], paths: HostPaths, overrides: Parameters<typeof botConfig>[1]) {
    const id = newMeetingId();
    await call("meeting.start", { config: botConfig(id, { liveTranscription: false, ...overrides }) });
    const config = JSON.parse(await fs.readFile(path.join(paths.meetings, id, "config.json"), "utf8"));
    await call("meeting.stop", { meetingId: id });
    return { id, config };
  }

  it("sets avatarVideo only when the avatar is on, an image exists and it is a meeting", async () => {
    const { call, paths } = await setup();
    // On, but no image yet.
    expect((await startWith(call, paths, { avatar: true })).config).toMatchObject({ avatar: true, avatarVideo: null });
    const good = await makeImage(ORANGE_SQUARE, "png");
    await call("bot.avatar", { action: "set", imageBase64: good.toString("base64"), mimeType: "image/png" });
    // Image, but off; a caller-supplied path is replaced.
    expect((await startWith(call, paths, { avatar: false, avatarVideo: "/tmp/whatever.mjpeg" })).config.avatarVideo).toBeNull();
    // Login sessions never get a camera.
    const login = await startWith(call, paths, { avatar: true, mode: "login", zoomProfileDir: path.join(paths.profiles, "zoom") });
    expect(login.config.avatarVideo).toBeNull();
    // On + image: the rendered video for this bot name.
    const { config } = await startWith(call, paths, { avatar: true, botName: "normal" });
    expect(config.avatarVideo).toMatch(new RegExp(`^${paths.avatarRenders}/[0-9a-f]{12}\\.mjpeg$`));
    expect(probe(config.avatarVideo)).toMatchObject({ codec_name: "mjpeg", width: "1280", height: "720" });
    expect((await fs.stat(paths.silenceWav)).size).toBe(44 + 96_000);
    // Same name and image: the same file again.
    expect((await startWith(call, paths, { avatar: true, botName: "normal" })).config.avatarVideo).toBe(config.avatarVideo);
  });

  it("starts without a camera when the render fails, and says why in bot.log", async () => {
    const { call, paths } = await setup();
    await fs.mkdir(paths.botDir, { recursive: true });
    await fs.writeFile(paths.avatar, "this is not a PNG");
    const { id, config } = await startWith(call, paths, { avatar: true });
    expect(config.avatarVideo).toBeNull();
    const log = await fs.readFile(path.join(paths.meetings, id, "bot.log"), "utf8");
    expect(log).toMatch(/avatar video not rendered, the camera stays off/);
  });
});
