// sherpa-onnx model files: present, right size and sha256. Hashing 40 MB on
// every env check would be wasteful, so a verified hash is remembered by
// (mtime, size) in memory and in models/.verified.json.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { readJson, statOrNull, writeJsonAtomic } from "./fsutil.js";
import type { HostPaths } from "./paths.js";
import type { ModelSpec } from "./platform.js";

interface Verified {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

const memory = new Map<string, Verified>();

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", reject)
      .once("end", () => resolve(hash.digest("hex")));
  });
}

function verifiedFile(paths: HostPaths): string {
  return path.join(paths.models, ".verified.json");
}

export interface ModelCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** `full` ignores the cache and re-hashes the file. */
export async function checkModel(paths: HostPaths, spec: ModelSpec, options: { readonly full?: boolean } = {}): Promise<ModelCheck> {
  const file = path.join(paths.models, spec.file);
  const stat = await statOrNull(file);
  if (stat === null || !stat.isFile()) return { ok: false, detail: `Нет файла ${spec.file}` };
  if (stat.size !== spec.bytes) return { ok: false, detail: `${spec.file}: размер ${stat.size} Б вместо ${spec.bytes} Б` };

  if (!options.full) {
    const known = memory.get(file) ?? ((await readJson(verifiedFile(paths))) as Record<string, Verified> | null)?.[spec.file];
    if (known?.mtimeMs === stat.mtimeMs && known.size === stat.size && known.sha256 === spec.sha256) {
      memory.set(file, known);
      return { ok: true, detail: `${spec.file} (${(stat.size / 1e6).toFixed(1)} МБ)` };
    }
  }
  const actual = await sha256File(file);
  if (actual !== spec.sha256) return { ok: false, detail: `${spec.file}: неверная контрольная сумма` };
  const entry: Verified = { mtimeMs: stat.mtimeMs, size: stat.size, sha256: actual };
  memory.set(file, entry);
  const all = ((await readJson(verifiedFile(paths))) as Record<string, Verified> | null) ?? {};
  await writeJsonAtomic(verifiedFile(paths), { ...all, [spec.file]: entry }).catch(() => undefined);
  return { ok: true, detail: `${spec.file} (${(stat.size / 1e6).toFixed(1)} МБ)` };
}
