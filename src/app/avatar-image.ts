// Preparing an avatar upload in the browser: type and size checks, a centered
// square crop scaled to at most 1024 px on a canvas (keeps uploads small and
// bakes in EXIF rotation), base64 for bot.setAvatar. The host normalizes the
// image again (512 px PNG, DESIGN §14).

export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];
/** `accept` of the file input. */
export const AVATAR_ACCEPT = AVATAR_MIME_TYPES.join(",");
/** bot.setAvatar limit: 3 MiB before base64. */
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
/** Larger files are not even decoded. */
export const AVATAR_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Side of the uploaded square, px. */
export const AVATAR_MAX_SIDE = 1024;

/** A problem with the chosen file, worded for the user. */
export class AvatarImageError extends Error {
  override name = "AvatarImageError";
}

export function isAvatarMimeType(type: string): type is AvatarMimeType {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(type);
}

export interface SquareCrop {
  /** Source rectangle: left, top and side of the centered square. */
  sx: number;
  sy: number;
  side: number;
  /** Side of the output square. */
  size: number;
}

/** The centered square of a width×height image, scaled down to at most `maxSide`. */
export function squareCrop(width: number, height: number, maxSide: number = AVATAR_MAX_SIDE): SquareCrop {
  const side = Math.max(0, Math.min(Math.floor(width), Math.floor(height)));
  return {
    sx: Math.floor((Math.floor(width) - side) / 2),
    sy: Math.floor((Math.floor(height) - side) / 2),
    side,
    size: Math.min(side, maxSide),
  };
}

/** 3145728 → "3 МБ", 4404019 → "4,2 МБ"; rounded up, so a file just over a limit does not read as the limit. */
export function formatMegabytes(bytes: number): string {
  const tenths = Math.ceil((bytes / (1024 * 1024)) * 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1).replace(".", ",")} МБ`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The cropped, scaled square, or null when this browser cannot do it (no createImageBitmap or 2D canvas):
 * then the original file is uploaded as is. Throws AvatarImageError when the image cannot be decoded.
 */
async function cropToSquare(file: Blob, sourceType: AvatarMimeType): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older browsers reject the "from-image" value: retry with their defaults.
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new AvatarImageError("Не удалось открыть изображение — файл повреждён или формат не поддерживается");
    }
  }
  try {
    const crop = squareCrop(bitmap.width, bitmap.height);
    if (crop.size === 0) throw new AvatarImageError("Изображение пустое");
    const canvas = document.createElement("canvas");
    canvas.width = crop.size;
    canvas.height = crop.size;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.size, crop.size);
    // Photos stay JPEG; PNG and WebP may be transparent, so they become PNG (JPEG when that is too big).
    if (sourceType === "image/jpeg") return await canvasToBlob(canvas, "image/jpeg", 0.92);
    const png = await canvasToBlob(canvas, "image/png");
    if (png !== null && png.size <= AVATAR_MAX_BYTES) return png;
    return (await canvasToBlob(canvas, "image/jpeg", 0.9)) ?? png;
  } finally {
    bitmap.close();
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma === -1 ? "" : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new AvatarImageError("Не удалось прочитать файл"));
    reader.readAsDataURL(blob);
  });
}

export interface PreparedAvatar {
  base64: string;
  mimeType: AvatarMimeType;
  /** Bytes before base64. */
  bytes: number;
  /** Cropped and scaled in the browser (false: the original file is sent). */
  processed: boolean;
}

/** Checks the chosen file and turns it into the bot.setAvatar input. Throws AvatarImageError. */
export async function prepareAvatar(file: Blob): Promise<PreparedAvatar> {
  if (!isAvatarMimeType(file.type)) throw new AvatarImageError("Подойдёт изображение PNG, JPEG или WebP");
  if (file.size === 0) throw new AvatarImageError("Файл пустой");
  if (file.size > AVATAR_MAX_SOURCE_BYTES) {
    throw new AvatarImageError(
      `Файл слишком большой (${formatMegabytes(file.size)}) — выберите изображение до ${formatMegabytes(AVATAR_MAX_SOURCE_BYTES)}`,
    );
  }
  const cropped = await cropToSquare(file, file.type);
  const blob = cropped ?? file;
  const mimeType = isAvatarMimeType(blob.type) ? blob.type : file.type;
  if (blob.size > AVATAR_MAX_BYTES) {
    throw new AvatarImageError(
      `Изображение слишком большое (${formatMegabytes(blob.size)}) — нужно не больше ${formatMegabytes(AVATAR_MAX_BYTES)}`,
    );
  }
  const base64 = await blobToBase64(blob);
  if (base64 === "") throw new AvatarImageError("Не удалось прочитать файл");
  return { base64, mimeType, bytes: blob.size, processed: cropped !== null };
}
