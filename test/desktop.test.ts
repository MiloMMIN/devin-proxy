import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDesktopStateDb, readDesktopAuth } from "../src/desktop.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devin-proxy-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDb(rows: Record<string, unknown>): string {
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
  for (const [k, v] of Object.entries(rows)) {
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [k, JSON.stringify(v)]);
  }
  db.close();
  return path;
}

describe("readDesktopAuth", () => {
  test("reads apiKey, apiServerUrl, email", () => {
    const path = makeDb({
      "windsurfAuthStatus": { apiKey: "devin-session-token$abc123", other: 1 },
      "codeium.windsurf": { apiServerUrl: "https://server.codeium.com", lastLoginEmail: "user@example.com" },
      "unrelated": { x: 1 },
    });
    const auth = readDesktopAuth(path);
    expect(auth).not.toBeNull();
    expect(auth!.apiKey).toBe("devin-session-token$abc123");
    expect(auth!.apiServerUrl).toBe("https://server.codeium.com");
    expect(auth!.email).toBe("user@example.com");
  });

  test("returns null when apiKey missing", () => {
    const path = makeDb({ "codeium.windsurf": { apiServerUrl: "https://x" } });
    expect(readDesktopAuth(path)).toBeNull();
  });

  test("returns null when apiKey is empty", () => {
    const path = makeDb({ "windsurfAuthStatus": { apiKey: "" } });
    expect(readDesktopAuth(path)).toBeNull();
  });
});

describe("findDesktopStateDb", () => {
  test("explicit path wins", () => {
    const path = makeDb({});
    expect(findDesktopStateDb(path)).toBe(path);
  });

  test("explicit missing path → null", () => {
    expect(findDesktopStateDb(join(dir, "nope.vscdb"))).toBeNull();
  });
});
