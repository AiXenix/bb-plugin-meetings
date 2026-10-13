// The persistent signed-in Zoom profile (<hostData>/profiles/zoom, DESIGN
// §6.6). "Signed in" means Chrome's cookie store holds a Zoom session cookie;
// it is read with node:sqlite when the runtime has it (Node ≥ 22.5), from a
// copy because Chrome keeps the live database locked, else by searching the
// file for the cookie names.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTree, statOrNull } from "./fsutil.js";
import { liveLoginSessions } from "./meetings.js";
import type { HostPaths } from "./paths.js";
import { pathInUse } from "./probes.js";

export const ZOOM_SESSION_COOKIES = ["zm_aid", "_zm_ssid", "zm_haid"] as const;
/** Chrome ≥ 96 keeps cookies in Default/Network/Cookies; older profiles in Default/Cookies. */
const COOKIE_DBS = [path.join("Default", "Network", "Cookies"), path.join("Default", "Cookies")];
/** Chrome cookie times are microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

export interface ZoomProfileStatus {
  readonly exists: boolean;
  readonly signedIn: boolean;
  readonly path: string;
  readonly updatedAt: number | null;
}

type SqliteModule = {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
};

let sqlite: SqliteModule | null | undefined;

async function loadSqlite(): Promise<SqliteModule | null> {
  if (sqlite !== undefined) return sqlite;
  try {
    // Feature-detected: node:sqlite exists from Node 22.5 (flagged before 22.13).
    sqlite = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

async function cookiesViaSqlite(module: SqliteModule, db: string): Promise<boolean | null> {
  const copyDir = await fs.mkdtemp(path.join(os.tmpdir(), "meetings-cookies-"));
  try {
    const copy = path.join(copyDir, "Cookies");
    await fs.copyFile(db, copy);
    await fs.copyFile(`${db}-journal`, `${copy}-journal`).catch(() => undefined);
    await fs.copyFile(`${db}-wal`, `${copy}-wal`).catch(() => undefined);
    const database = new module.DatabaseSync(copy, { readOnly: true });
    try {
      const rows = database
        .prepare(
          `SELECT CAST(expires_utc AS TEXT) AS expires FROM cookies
           WHERE (host_key = 'zoom.us' OR host_key LIKE '%.zoom.us') AND name IN (${ZOOM_SESSION_COOKIES.map(() => "?").join(",")})`,
        )
        .all(...ZOOM_SESSION_COOKIES) as Array<{ expires: string | null }>;
      const nowUs = BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_US;
      return rows.some((row) => {
        const expires = BigInt(row.expires ?? "0");
        return expires === 0n || expires > nowUs;
      });
    } finally {
      database.close();
    }
  } catch {
    return null;
  } finally {
    await removeTree(copyDir);
  }
}

async function cookiesViaBytes(db: string): Promise<boolean> {
  const bytes = await fs.readFile(db).catch(() => null);
  if (bytes === null) return false;
  return ZOOM_SESSION_COOKIES.some((name) => bytes.includes(Buffer.from(name, "latin1")));
}

export async function zoomSignedIn(profileDir: string): Promise<boolean> {
  for (const relative of COOKIE_DBS) {
    const db = path.join(profileDir, relative);
    if ((await statOrNull(db)) === null) continue;
    const module = await loadSqlite();
    const viaSqlite = module === null ? null : await cookiesViaSqlite(module, db);
    if (viaSqlite ?? (await cookiesViaBytes(db))) return true;
  }
  return false;
}

export async function zoomProfileStatus(paths: HostPaths): Promise<ZoomProfileStatus> {
  const dir = paths.zoomProfile;
  const stat = await statOrNull(dir);
  if (stat === null || !stat.isDirectory()) return { exists: false, signedIn: false, path: dir, updatedAt: null };
  let updatedAt = stat.mtimeMs;
  for (const relative of [...COOKIE_DBS, "Local State"]) {
    const mtime = (await statOrNull(path.join(dir, relative)))?.mtimeMs;
    if (mtime !== undefined) updatedAt = Math.max(updatedAt, mtime);
  }
  return { exists: true, signedIn: await zoomSignedIn(dir), path: dir, updatedAt: Math.round(updatedAt) };
}

export async function deleteZoomProfile(paths: HostPaths): Promise<ZoomProfileStatus> {
  const sessions = await liveLoginSessions(paths);
  if (sessions.length > 0) {
    throw new Error(`Профиль Zoom используется сеансом входа ${sessions[0]}; завершите его перед выходом из аккаунта`);
  }
  if (await pathInUse(paths.zoomProfile)) {
    throw new Error("Профиль Zoom сейчас открыт в Chrome; закройте сеанс входа перед выходом из аккаунта");
  }
  await removeTree(paths.zoomProfile);
  return zoomProfileStatus(paths);
}
