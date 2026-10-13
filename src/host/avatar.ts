// The bot's avatar on the recording host (DESIGN §14). An uploaded image is
// checked (type by its magic bytes, size, dimensions) and normalized by ffmpeg
// into a center-cropped square PNG, <hostData>/bot/avatar.png. From it and the
// bot's name the host renders the camera frame (1280x720: the avatar as a
// circle above the name on a dark background) and a short MJPEG video that
// Chrome loops as its fake camera (--use-file-for-fake-video-capture), plus a
// silent WAV for the fake microphone. Renders are cached by content hash; the
// ones a running Chrome still plays are never deleted.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AvatarStatus } from "../shared/contract.js";
import { outputTail, run, which } from "./exec.js";
import { readJson, removeTree, statOrNull, writeFileAtomic } from "./fsutil.js";
import { BOT_SCRIPT_NAME, type HostPaths } from "./paths.js";
import { listProcs } from "./processes.js";

/** Largest accepted upload (decoded bytes). */
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
/** Side of the normalized square avatar, px. */
export const AVATAR_SIZE = 512;
/**
 * Bigger images are refused before ffmpeg decodes them (a small file can hold
 * a huge bitmap). The decoder enforces the pixel limit too (-max_pixels): the
 * headers inspectImage reads need not be the ones ffmpeg decodes.
 */
export const MAX_SOURCE_SIDE = 16_384;
export const MAX_SOURCE_PIXELS = 64_000_000;
/**
 * ffmpeg's -max_pixels counts the decoder's padded buffer (width rounded up to
 * a multiple of 64, height to 32), so it gets that much room above
 * MAX_SOURCE_PIXELS: an image inspectImage accepts (7999x8001) must decode.
 */
const DECODER_MAX_PIXELS = MAX_SOURCE_PIXELS + 128 * MAX_SOURCE_SIDE;
/** The camera frame. */
export const FRAME = Object.freeze({ width: 1280, height: 720 });
/** Diameter of the avatar circle and the width of the ring around it, px. */
const CIRCLE = 320;
const RING = 6;
const BACKGROUND = "0x2b3139";
const RING_COLOR = "0x434b57";
/** Chrome loops the file; its MJPEG reader plays it at a fixed 30 fps whatever was encoded. */
export const VIDEO_FPS = 5;
export const VIDEO_SECONDS = 2;
/** Renders kept besides the ones in use. */
export const KEEP_RENDERS = 10;
/** Bump when the frame layout changes, so cached renders stop matching. */
const RENDER_VERSION = 2;
/** The name's font size range, px, and the width it must fit in (a margin on each side). */
const NAME_MAX_FONT = 52;
const NAME_MIN_FONT = 12;
const NAME_MAX_WIDTH = FRAME.width - 100;
const FFMPEG_TIMEOUT_MS = 20_000;
const FONT_LOOKUP_TIMEOUT_MS = 5_000;
const WORK_PREFIX = ".work-";
const STALE_WORK_MS = 60 * 60_000;
/** Chrome's flag that names the file it plays as the camera (runtime/bot/lib/media.mjs). */
export const FAKE_VIDEO_FLAG = "--use-file-for-fake-video-capture=";

/** Sans fonts with Cyrillic, in the order they are tried (Debian/Ubuntu, Fedora, Arch layouts). */
export const FONT_CANDIDATES: readonly string[] = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
];

export type ImageType = "png" | "jpeg" | "webp";
export type AvatarMimeType = "image/png" | "image/jpeg" | "image/webp";

const EXTENSION: Record<ImageType, string> = { png: "png", jpeg: "jpg", webp: "webp" };
/** ffmpeg decoders, forced so nothing but these three is ever probed. */
const DECODER: Record<ImageType, string> = { png: "png", jpeg: "mjpeg", webp: "webp" };

export interface ImageInfo {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1–8 (JPEG only; 1 = as stored). */
  readonly orientation: number;
}

export interface AvatarActionInput {
  readonly action: "status" | "set" | "clear";
  readonly imageBase64?: string | undefined;
  readonly mimeType?: AvatarMimeType | undefined;
}

// ── image inspection (pure) ──────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("latin1");
}

/** The image type from the magic bytes, or null when it is none of PNG, JPEG, WebP. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  return null;
}

/** Width and height from a PNG's IHDR, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || sniffImage(bytes) !== "png" || ascii(bytes, 12, 16) !== "IHDR") return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/** EXIF orientation from an APP1 "Exif" payload (starting at "Exif\0\0"), or 1. */
function exifOrientation(view: Buffer, start: number, end: number): number {
  const tiff = start + 6;
  if (end - tiff < 8) return 1;
  const order = ascii(view, tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (at: number) => (le ? view.readUInt16LE(at) : view.readUInt16BE(at));
  const u32 = (at: number) => (le ? view.readUInt32LE(at) : view.readUInt32BE(at));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xf7]);

/**
 * Size and orientation of a JPEG from its headers up to the first scan. Every
 * frame header counts, the largest wins: ffmpeg skips the ones it cannot
 * decode and a later header replaces an earlier one, so the first is no proof
 * of the decoded size.
 */
function jpegInfo(view: Buffer): { width: number; height: number; orientation: number } | null {
  let orientation = 1;
  let size: { width: number; height: number } | null = null;
  let at = 2;
  while (at + 4 <= view.length) {
    if (view[at] !== 0xff) return null;
    let marker = view[at + 1]!;
    while (marker === 0xff && at + 2 < view.length) {
      at += 1;
      marker = view[at + 1]!;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan: the headers are over. End of image (or a scan) before any frame header: unusable.
    if (marker === 0xd9 || marker === 0xda) return size === null ? null : { ...size, orientation };
    if (at + 4 > view.length) return null;
    const length = view.readUInt16BE(at + 2);
    const start = at + 4;
    const end = Math.min(view.length, at + 2 + length);
    if (length < 2) return null;
    if (marker === 0xe1 && end - start >= 6 && ascii(view, start, start + 6) === "Exif\0\0") {
      orientation = exifOrientation(view, start, end);
    }
    if (JPEG_SOF.has(marker)) {
      if (start + 5 > view.length) return null;
      const frame = { height: view.readUInt16BE(start + 1), width: view.readUInt16BE(start + 3) };
      size = size === null ? frame : { width: Math.max(size.width, frame.width), height: Math.max(size.height, frame.height) };
    }
    at += 2 + length;
  }
  return null;
}

/** Size from a "VP8 " (key frame) or "VP8L" chunk whose header starts at `at`, or null. */
function webpBitstreamSize(view: Buffer, at: number): { width: number; height: number } | null {
  const chunk = ascii(view, at, at + 4);
  const data = at + 8;
  if (chunk === "VP8 ") {
    // Key frame: 3-byte frame tag, start code 9d 01 2a, 14-bit width and height.
    if (data + 10 > view.length || view[data + 3] !== 0x9d || view[data + 4] !== 0x01 || view[data + 5] !== 0x2a) return null;
    return { width: view.readUInt16LE(data + 6) & 0x3fff, height: view.readUInt16LE(data + 8) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (data + 5 > view.length || view[data] !== 0x2f) return null;
    const bits = view.readUInt32LE(data + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function webpInfo(view: Buffer): { width: number; height: number; animated: boolean } | null {
  if (view.length < 30) return null;
  const chunk = ascii(view, 12, 16);
  if (chunk === "VP8 " || chunk === "VP8L") {
    const size = webpBitstreamSize(view, 12);
    return size === null ? null : { ...size, animated: false };
  }
  if (chunk === "VP8X") {
    const flags = view[20]!;
    let width = (view[24]! | (view[25]! << 8) | (view[26]! << 16)) + 1;
    let height = (view[27]! | (view[28]! << 8) | (view[29]! << 16)) + 1;
    // ffmpeg decodes at the bitstream's size, whatever the canvas says: count the larger of both.
    for (let at = 20 + view.readUInt32LE(16); at + 8 <= view.length; ) {
      const size = webpBitstreamSize(view, at);
      if (size !== null) {
        width = Math.max(width, size.width);
        height = Math.max(height, size.height);
      }
      const length = view.readUInt32LE(at + 4);
      at += 8 + length + (length & 1);
    }
    return { width, height, animated: (flags & 0x02) !== 0 };
  }
  return null;
}

/** Type, dimensions and orientation of an uploaded image; throws a user-facing (Russian) error when it is unusable. */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  const type = sniffImage(bytes);
  if (type === null) throw new Error("Файл не похож на изображение PNG, JPEG или WebP");
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: { width: number; height: number } | null = null;
  let orientation = 1;
  if (type === "png") size = pngSize(view);
  else if (type === "jpeg") {
    const info = jpegInfo(view);
    if (info !== null) {
      size = info;
      orientation = info.orientation;
    }
  } else {
    const info = webpInfo(view);
    if (info?.animated) throw new Error("Анимированные WebP не поддерживаются: загрузите обычное изображение");
    size = info;
  }
  if (size === null || size.width <= 0 || size.height <= 0) throw new Error("Не удалось прочитать размер изображения: файл повреждён?");
  if (size.width > MAX_SOURCE_SIDE || size.height > MAX_SOURCE_SIDE || size.width * size.height > MAX_SOURCE_PIXELS) {
    throw new Error(`Изображение слишком большое (${size.width}×${size.height}); подойдёт до ${MAX_SOURCE_SIDE} px по стороне`);
  }
  return { type, width: size.width, height: size.height, orientation };
}

/** Base64 (optionally a data: URL) to bytes; null when it is not valid base64. */
export function decodeBase64(text: string): Buffer | null {
  const compact = text.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (compact === "" || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, "base64");
}

/** ffmpeg filters that undo an EXIF orientation (ffmpeg's own autorotation is off: it differs between versions). */
export function orientationFilters(orientation: number): string[] {
  switch (orientation) {
    case 2:
      return ["hflip"];
    case 3:
      return ["hflip", "vflip"];
    case 4:
      return ["vflip"];
    case 5:
      return ["transpose=0"];
    case 6:
      return ["transpose=1"];
    case 7:
      return ["transpose=3"];
    case 8:
      return ["transpose=2"];
    default:
      return [];
  }
}

/** Names go into drawtext through a file; control characters would break the line. */
export function displayName(botName: string): string {
  return botName.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Font size that keeps the name inside the frame: from `measuredWidth`, the
 * name's drawn width (px) at NAME_MAX_FONT (measureName), else estimated at
 * one em per character (wide enough for capitals, Cyrillic Ш/Ж, W).
 */
export function nameFontSize(name: string, measuredWidth: number | null = null): number {
  const chars = Math.max(1, [...name].length);
  const size =
    measuredWidth !== null && Number.isFinite(measuredWidth) && measuredWidth > 0
      ? (NAME_MAX_FONT * NAME_MAX_WIDTH) / measuredWidth
      : NAME_MAX_WIDTH / chars;
  return Math.max(NAME_MIN_FONT, Math.min(NAME_MAX_FONT, Math.floor(size)));
}

/** Cache key of a render: the layout version, the font, the name and the avatar's bytes. */
export function renderKey(botName: string, avatar: Uint8Array, font: string | null): string {
  return createHash("sha256")
    .update(`v${RENDER_VERSION}\0${font ?? "-"}\0${displayName(botName)}\0`)
    .update(avatar)
    .digest("hex")
    .slice(0, 12);
}

/** A mono 16-bit PCM WAV of silence. */
export function silenceWav(seconds = 1, rate = 48_000): Buffer {
  const dataBytes = Math.round(seconds * rate) * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "latin1");
  wav.write("fmt ", 12, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

// ── processes ────────────────────────────────────────────────────────────

async function requireFfmpeg(): Promise<string> {
  const ffmpeg = await which("ffmpeg");
  if (ffmpeg === null) throw new Error("Для аватара нужен ffmpeg (sudo apt-get install -y ffmpeg)");
  return ffmpeg;
}

async function ffmpegIn(work: string, ffmpeg: string, args: readonly string[], what: string, signal?: AbortSignal): Promise<void> {
  const result = await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeoutMs: FFMPEG_TIMEOUT_MS,
    cwd: work,
    signal,
  });
  if (result.code === 0 && !result.timedOut) return;
  const how = result.timedOut ? `ffmpeg не уложился в ${FFMPEG_TIMEOUT_MS / 1000} с` : outputTail(result) || `код ${result.code ?? result.signal}`;
  throw new Error(`${what}: ${how}`);
}

let fontLookup: Promise<string | null> | null = null;

/** The first installed font from `candidates`, else what fontconfig offers; null = render without the name. */
export async function findFont(candidates: readonly string[] = FONT_CANDIDATES): Promise<string | null> {
  for (const candidate of candidates) if ((await statOrNull(candidate))?.isFile()) return candidate;
  const fcMatch = await which("fc-match");
  if (fcMatch === null) return null;
  try {
    const result = await run(fcMatch, ["-f", "%{file}", "sans-serif:lang=ru"], { timeoutMs: FONT_LOOKUP_TIMEOUT_MS });
    const file = result.stdout.trim();
    return result.code === 0 && /\.(ttf|otf|ttc)$/i.test(file) && (await statOrNull(file))?.isFile() ? file : null;
  } catch {
    return null;
  }
}

function defaultFont(): Promise<string | null> {
  fontLookup ??= findFont().catch(() => null);
  return fontLookup;
}

/** A private scratch dir under <hostData>/bot (same filesystem, so results can be renamed into place). */
async function withWorkDir<T>(paths: HostPaths, work: (dir: string) => Promise<T>): Promise<T> {
  await fs.mkdir(paths.botDir, { recursive: true });
  await removeStaleWorkDirs(paths);
  const dir = path.join(paths.botDir, `${WORK_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(dir);
  try {
    return await work(dir);
  } finally {
    await removeTree(dir).catch(() => undefined);
  }
}

async function removeStaleWorkDirs(paths: HostPaths): Promise<void> {
  const entries = await fs.readdir(paths.botDir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const stat = await statOrNull(path.join(paths.botDir, name));
    if (stat !== null && now - stat.mtimeMs > STALE_WORK_MS) await removeTree(path.join(paths.botDir, name)).catch(() => undefined);
  }
}

// ── avatar image ─────────────────────────────────────────────────────────

export async function avatarStatus(paths: HostPaths): Promise<AvatarStatus> {
  const stat = await statOrNull(paths.avatar);
  if (stat === null || !stat.isFile()) return { hasAvatar: false, updatedAt: null, size: null };
  const head = Buffer.alloc(24);
  const handle = await fs.open(paths.avatar, "r").catch(() => null);
  if (handle !== null) {
    try {
      await handle.read(head, 0, 24, 0);
    } finally {
      await handle.close();
    }
  }
  return { hasAvatar: true, updatedAt: Math.round(stat.mtimeMs), size: pngSize(head)?.width ?? null };
}

/**
 * Validate an uploaded image and store it as the avatar: EXIF orientation
 * applied, center-cropped to a square, scaled to AVATAR_SIZE, RGBA PNG. The declared
 * MIME type must be one of the three accepted ones; the bytes decide which
 * decoder runs (a JPEG saved as .png is still a valid JPEG).
 */
export async function setAvatar(
  paths: HostPaths,
  imageBase64: string | undefined,
  mimeType: AvatarMimeType | undefined,
  signal?: AbortSignal,
): Promise<AvatarStatus> {
  if (imageBase64 === undefined || imageBase64 === "") throw new Error("Нет изображения для аватара");
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new Error("Аватар должен быть изображением PNG, JPEG или WebP");
  }
  const bytes = decodeBase64(imageBase64);
  if (bytes === null) throw new Error("Изображение повреждено: неверный base64");
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new Error(`Изображение больше ${AVATAR_MAX_BYTES / 1024 / 1024} МБ (${(bytes.length / 1024 / 1024).toFixed(1)} МБ)`);
  }
  const info = inspectImage(bytes);
  const ffmpeg = await requireFfmpeg();
  await withWorkDir(paths, async (work) => {
    const source = `source.${EXTENSION[info.type]}`;
    await fs.writeFile(path.join(work, source), bytes);
    // Crop before scaling: scaling a long strip to cover the square first makes a huge
    // intermediate frame (10x8000 -> 512x409600).
    const filters = [
      ...orientationFilters(info.orientation),
      "crop='min(iw,ih)':'min(iw,ih)'",
      `scale=${AVATAR_SIZE}:${AVATAR_SIZE}:flags=lanczos`,
      "format=rgba",
    ];
    await ffmpegIn(
      work,
      ffmpeg,
      ["-noautorotate", "-max_pixels", String(DECODER_MAX_PIXELS), "-f", "image2", "-c:v", DECODER[info.type], "-i", source,
        "-frames:v", "1", "-vf", filters.join(","), "-c:v", "png", "-f", "image2", "avatar.png"],
      "Не удалось обработать изображение",
      signal,
    );
    const out = path.join(work, "avatar.png");
    const size = pngSize(await fs.readFile(out).catch(() => Buffer.alloc(0)));
    if (size?.width !== AVATAR_SIZE || size.height !== AVATAR_SIZE) throw new Error("Не удалось обработать изображение: ffmpeg не создал PNG нужного размера");
    await fs.rename(out, paths.avatar);
  });
  // Renders of the previous image are of no use any more.
  await pruneRenders(paths, 0).catch(() => undefined);
  return avatarStatus(paths);
}

export async function clearAvatar(paths: HostPaths): Promise<AvatarStatus> {
  await fs.rm(paths.avatar, { force: true });
  await pruneRenders(paths, 0).catch(() => undefined);
  return avatarStatus(paths);
}

export function avatarAction(paths: HostPaths, input: AvatarActionInput, signal?: AbortSignal): Promise<AvatarStatus> {
  if (input.action === "set") return setAvatar(paths, input.imageBase64, input.mimeType, signal);
  if (input.action === "clear") return clearAvatar(paths);
  return avatarStatus(paths);
}

// ── rendering ────────────────────────────────────────────────────────────

interface RenderSource {
  readonly avatar: Buffer;
  readonly name: string;
  readonly font: string | null;
}

/**
 * Width (px) of the inked part of name.txt drawn at NAME_MAX_FONT with `fontFile`
 * (both in `work`), by ffmpeg's drawtext itself; null when it cannot tell.
 */
async function measureName(work: string, ffmpeg: string, fontFile: string, name: string, signal?: AbortSignal): Promise<number | null> {
  const pad = 8;
  // Room for 2.5 em per character; ink reaching the right edge means it did not fit.
  const width = Math.min(16_000, 2 * pad + Math.ceil([...name].length * NAME_MAX_FONT * 2.5));
  const height = 2 * NAME_MAX_FONT;
  try {
    await ffmpegIn(
      work,
      ffmpeg,
      ["-filter_complex", `color=c=black:s=${width}x${height},format=gray,drawtext=fontfile=${fontFile}:textfile=name.txt:expansion=none:fontcolor=white:fontsize=${NAME_MAX_FONT}:x=${pad}:y=${pad}`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "measure.gray"],
      "Не удалось измерить имя",
      signal,
    );
    const pixels = await fs.readFile(path.join(work, "measure.gray"));
    if (pixels.length !== width * height) return null;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < left; x += 1) if (pixels[row + x]! > 32) left = x;
      for (let x = width - 1; x > right; x -= 1) if (pixels[row + x]! > 32) right = x;
    }
    if (right < left || right >= width - 1) return null;
    return right - left + 1;
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    return null;
  }
}

/** The camera frame as frame.png in `work`: background, ringed avatar circle, name below. */
async function renderFrame(work: string, ffmpeg: string, source: RenderSource, signal?: AbortSignal): Promise<string> {
  await fs.writeFile(path.join(work, "avatar.png"), source.avatar);
  const text = source.font !== null && source.name !== "";
  const fontFile = text ? `font${path.extname(source.font!)}` : "";
  // Relative names in the filter graph: no path (with its quotes, colons, commas) ever needs escaping.
  if (text) {
    await fs.symlink(source.font!, path.join(work, fontFile));
    await fs.writeFile(path.join(work, "name.txt"), source.name);
  }
  const fontSize = nameFontSize(source.name, text ? await measureName(work, ffmpeg, fontFile, source.name, signal) : null);
  const ringSide = CIRCLE + 2 * RING;
  const gap = text ? 40 : 0;
  const textHeight = text ? Math.round(fontSize * 1.2) : 0;
  const top = Math.round((FRAME.height - ringSide - gap - textHeight) / 2);
  const c = CIRCLE / 2;
  const r = ringSide / 2;
  const graph = [
    `color=c=${BACKGROUND}:s=${FRAME.width}x${FRAME.height},vignette=angle=PI/5,format=rgba[bg]`,
    `color=c=${RING_COLOR}:s=${ringSide}x${ringSide},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(${r + 0.5}-hypot(X-${r - 0.5},Y-${r - 0.5}),0,1)'[ring]`,
    `[0:v]scale=${CIRCLE}:${CIRCLE}:flags=lanczos,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${c + 0.5}-hypot(X-${c - 0.5},Y-${c - 0.5}),0,1)'[av]`,
    `[bg][ring]overlay=x=(W-w)/2:y=${top}[b1]`,
    `[b1][av]overlay=x=(W-w)/2:y=${top + RING}${text ? "[b2]" : ",format=rgb24[out]"}`,
  ];
  if (text) {
    graph.push(
      `[b2]drawtext=fontfile=${fontFile}:textfile=name.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=${top + ringSide + gap},format=rgb24[out]`,
    );
  }
  await ffmpegIn(
    work,
    ffmpeg,
    ["-f", "image2", "-c:v", "png", "-i", "avatar.png", "-filter_complex", graph.join(";"), "-map", "[out]", "-frames:v", "1", "-c:v", "png", "-f", "image2", "frame.png"],
    "Не удалось нарисовать кадр с аватаром",
    signal,
  );
  return path.join(work, "frame.png");
}

export interface RenderOptions {
  readonly signal?: AbortSignal | undefined;
  /** Font file for the name; null = no name; undefined = FONT_CANDIDATES / fontconfig. */
  readonly font?: string | null | undefined;
}

async function renderSource(paths: HostPaths, botName: string, options: RenderOptions): Promise<RenderSource | null> {
  const avatar = await fs.readFile(paths.avatar).catch(() => null);
  if (avatar === null) return null;
  return { avatar, name: displayName(botName), font: options.font === undefined ? await defaultFont() : options.font };
}

/** The camera frame for the page (avatar + name), as JPEG base64; null without an avatar. */
export async function renderAvatarPreview(paths: HostPaths, botName: string, options: RenderOptions = {}): Promise<string | null> {
  const { signal } = options;
  const source = await renderSource(paths, botName, options);
  if (source === null) return null;
  const ffmpeg = await requireFfmpeg();
  return withWorkDir(paths, async (work) => {
    await renderFrame(work, ffmpeg, source, signal);
    await ffmpegIn(
      work,
      ffmpeg,
      ["-f", "image2", "-c:v", "png", "-i", "frame.png", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p", "-f", "image2", "preview.jpg"],
      "Не удалось сохранить кадр с аватаром",
      signal,
    );
    return (await fs.readFile(path.join(work, "preview.jpg"))).toString("base64");
  });
}

/** <hostData>/bot/silence.wav for Chrome's fake microphone (written when missing or wrong). */
export async function ensureSilenceWav(paths: HostPaths): Promise<string> {
  const wav = silenceWav();
  const stat = await statOrNull(paths.silenceWav);
  if (stat?.size !== wav.length) {
    await fs.mkdir(paths.botDir, { recursive: true });
    await writeFileAtomic(paths.silenceWav, wav);
  }
  return paths.silenceWav;
}

/**
 * The MJPEG Chrome plays as the bot's camera (VIDEO_SECONDS at VIDEO_FPS of
 * the same frame), rendered once per name + avatar and reused; null without
 * an avatar. Also makes sure silence.wav exists next to the render dir.
 */
export async function renderAvatarVideo(paths: HostPaths, botName: string, options: RenderOptions = {}): Promise<string | null> {
  const { signal } = options;
  const source = await renderSource(paths, botName, options);
  if (source === null) return null;
  await ensureSilenceWav(paths);
  const target = path.join(paths.avatarRenders, `${renderKey(botName, source.avatar, source.font)}.mjpeg`);
  const cached = await statOrNull(target);
  if (cached?.isFile() && cached.size > 0) {
    // Recently used renders survive pruning.
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => undefined);
    return target;
  }
  const ffmpeg = await requireFfmpeg();
  await fs.mkdir(paths.avatarRenders, { recursive: true });
  await withWorkDir(paths, async (work) => {
    await renderFrame(work, ffmpeg, source, signal);
    // -f mjpeg: raw concatenated baseline JPEGs, the format Chrome's file capture reads from a .mjpeg.
    await ffmpegIn(
      work,
      ffmpeg,
      ["-f", "image2", "-c:v", "png", "-loop", "1", "-framerate", String(VIDEO_FPS), "-i", "frame.png",
        "-frames:v", String(VIDEO_FPS * VIDEO_SECONDS), "-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p", "-f", "mjpeg", "video.mjpeg"],
      "Не удалось записать видео с аватаром",
      signal,
    );
    const video = path.join(work, "video.mjpeg");
    const head = Buffer.alloc(3);
    const handle = await fs.open(video, "r");
    try {
      await handle.read(head, 0, 3, 0);
    } finally {
      await handle.close();
    }
    if (sniffImage(head) !== "jpeg") throw new Error("Не удалось записать видео с аватаром: ffmpeg создал не MJPEG");
    await fs.rename(video, target);
  });
  await pruneRenders(paths, KEEP_RENDERS, target).catch(() => undefined);
  return target;
}

/**
 * Renders in use: the ones a running Chrome plays (its command line), and the
 * ones a live bot runner's config.json names (Chrome may not be started yet).
 */
export async function rendersInUse(): Promise<Set<string>> {
  const used = new Set<string>();
  for (const proc of await listProcs()) {
    if (proc.state === "Z") continue;
    for (const arg of proc.argv) if (arg.startsWith(FAKE_VIDEO_FLAG)) used.add(path.resolve(arg.slice(FAKE_VIDEO_FLAG.length)));
    if (!proc.argv.some((arg) => path.basename(arg) === BOT_SCRIPT_NAME)) continue;
    const dir = proc.argv[proc.argv.indexOf("--meeting-dir") + 1];
    if (proc.argv.includes("--meeting-dir") && dir !== undefined) {
      const config = (await readJson(path.join(dir, "config.json"))) as { avatarVideo?: unknown } | null;
      if (typeof config?.avatarVideo === "string") used.add(path.resolve(config.avatarVideo));
    }
  }
  return used;
}

/**
 * Keep the `keep` most recently used renders (and `also`), delete the rest,
 * except files a running Chrome plays: it reopens the file whenever the
 * camera restarts. Returns the number of files deleted.
 */
export async function pruneRenders(
  paths: HostPaths,
  keep = KEEP_RENDERS,
  also: string | null = null,
  inUse?: ReadonlySet<string>,
): Promise<number> {
  const names = await fs.readdir(paths.avatarRenders).catch(() => [] as string[]);
  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".mjpeg")) continue;
    const file = path.join(paths.avatarRenders, name);
    const stat = await statOrNull(file);
    if (stat?.isFile()) files.push({ file, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = files.slice(keep).filter(({ file }) => file !== also);
  if (doomed.length === 0) return 0;
  const busy = inUse ?? (await rendersInUse());
  let removed = 0;
  for (const { file } of doomed) {
    if (busy.has(file)) continue;
    if (await fs.rm(file, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return removed;
}
