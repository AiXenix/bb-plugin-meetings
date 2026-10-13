// Meeting-directory file helpers (docs/dev/DESIGN.md §4): JSON files are
// replaced atomically (write a temp file, then rename) so readers never see a
// half-written file; JSONL files are append-only, one object per line.
import fs from "node:fs";
import fsp from "node:fs/promises";

let tmpCounter = 0;

function tmpName(file) {
  tmpCounter += 1;
  return `${file}.${process.pid}.${tmpCounter}.tmp`;
}

/** Atomically replace `file` with JSON (synchronous: state files are small). */
export function writeJsonAtomic(file, value) {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Atomically replace `file` with arbitrary bytes (screenshots). */
export async function writeFileAtomic(file, data) {
  const tmp = tmpName(file);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Append one JSON object as a line. */
export function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** Parse a JSON file; `fallback` when it is missing or unreadable. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

/** Short filesystem-safe timestamp for debug artifacts. */
export function stamp(t = Date.now()) {
  return new Date(t).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
