/**
 * Locate and read the local Devin Desktop credential store.
 *
 * Devin Desktop keeps the upstream session token in plain text inside
 * `state.vscdb` (SQLite, table `ItemTable(key TEXT, value BLOB)`) under its
 * VS Code-style globalStorage directory. The DB file is held open by the
 * desktop app, so it (plus any -wal/-shm siblings) is copied to a temp
 * directory before being opened with bun:sqlite.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

const STATE_DB_REL = join("Devin", "User", "globalStorage", "state.vscdb");

function defaultStateDbPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, STATE_DB_REL);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", STATE_DB_REL);
  }
  return join(homedir(), ".config", STATE_DB_REL);
}

/**
 * Resolve the Devin Desktop state.vscdb path. An explicit path (from config)
 * wins; when it is given but missing, null is returned rather than silently
 * falling back to the platform default. Without an explicit path the platform
 * default location is probed. Returns null when no file exists.
 */
export function findDesktopStateDb(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidate = defaultStateDbPath();
  return existsSync(candidate) ? candidate : null;
}

export interface DesktopAuth {
  apiKey: string;
  apiServerUrl?: string;
  email?: string;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value ?? "");
}

/**
 * Read the session token and account metadata from a state.vscdb file.
 * Returns null when the `windsurfAuthStatus` row is missing or carries no
 * apiKey.
 */
export function readDesktopAuth(dbPath: string): DesktopAuth | null {
  const dir = mkdtempSync(join(tmpdir(), "devin-proxy-"));
  try {
    const copy = join(dir, "state.vscdb");
    copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
    }

    const db = new Database(copy);
    try {
      const rows = db
        .query("SELECT key, value FROM ItemTable WHERE key IN ('windsurfAuthStatus', 'codeium.windsurf')")
        .all() as { key: string; value: unknown }[];

      let apiKey = "";
      let apiServerUrl: string | undefined;
      let email: string | undefined;

      for (const row of rows) {
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(asText(row.value)) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (row.key === "windsurfAuthStatus") {
          if (typeof json.apiKey === "string") apiKey = json.apiKey;
        } else if (row.key === "codeium.windsurf") {
          if (typeof json.apiServerUrl === "string") apiServerUrl = json.apiServerUrl;
          if (typeof json.lastLoginEmail === "string") email = json.lastLoginEmail;
        }
      }

      if (!apiKey) return null;
      return { apiKey, apiServerUrl, email };
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`[desktop] failed to read ${dbPath}: ${String((err as Error).message ?? err)}`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
