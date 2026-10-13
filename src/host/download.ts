// HTTPS downloads for setup: streamed to a temp file next to the target,
// hashed on the fly, verified, then renamed into place. A transfer that
// stalls for a minute or exceeds the overall cap is aborted.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export interface DownloadOptions {
  readonly signal: AbortSignal;
  readonly expectedBytes?: number;
  /** Hex SHA-256 the file must have. */
  readonly sha256?: string;
  /** npm-style SRI string, e.g. "sha512-<base64>". */
  readonly integrity?: string;
  readonly log?: { write(chunk: string): unknown };
  readonly stallMs?: number;
  readonly totalMs?: number;
}

export async function downloadFile(url: string, dest: string, options: DownloadOptions): Promise<void> {
  const stallMs = options.stallMs ?? 60_000;
  const stall = new AbortController();
  const signal = AbortSignal.any([options.signal, stall.signal, AbortSignal.timeout(options.totalMs ?? 30 * 60_000)]);
  options.log?.write(`downloading ${url}\n`);
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`Не удалось скачать ${url}: HTTP ${response.status}`);

  const sha256 = createHash("sha256");
  const sriAlgorithm = options.integrity?.split("-")[0];
  const sri = sriAlgorithm ? createHash(sriAlgorithm) : null;
  let bytes = 0;
  let timer = setTimeout(() => stall.abort(new Error(`Загрузка ${url} зависла`)), stallMs);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.part-${randomBytes(4).toString("hex")}`);
  try {
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    const measure = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        sha256.update(chunk);
        sri?.update(chunk);
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(new Error(`Загрузка ${url} зависла`)), stallMs);
        yield chunk;
      }
    };
    await pipeline(body, measure, createWriteStream(partial), { signal });
    if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
      throw new Error(`${path.basename(dest)}: размер ${bytes} Б вместо ${options.expectedBytes} Б`);
    }
    const actual = sha256.digest("hex");
    if (options.sha256 !== undefined && actual !== options.sha256) {
      throw new Error(`${path.basename(dest)}: контрольная сумма не совпала (sha256 ${actual})`);
    }
    if (options.integrity !== undefined && sri !== null) {
      const got = `${sriAlgorithm}-${sri.digest("base64")}`;
      if (got !== options.integrity) throw new Error(`${path.basename(dest)}: integrity не совпала (${got})`);
    }
    await fs.rename(partial, dest);
    options.log?.write(`saved ${dest} (${bytes} bytes, sha256 ${actual})\n`);
  } finally {
    clearTimeout(timer);
    await fs.rm(partial, { force: true });
  }
}
