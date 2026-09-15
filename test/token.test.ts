import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "../src/config.js";
import { createTokenProvider, resolveToken, tokenFingerprint, writeTokenFile } from "../src/token.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devin-proxy-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    configDir: join(dir, "cfg"),
    modelMap: {},
    modelsTtlMs: 60_000,
    logLevel: "error",
    // Point desktop detection at a guaranteed-missing path unless overridden.
    desktopStateDb: join(dir, "missing.vscdb"),
    ...overrides,
  };
}

function makeDesktopDb(apiKey: string): string {
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
  db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
    "windsurfAuthStatus", JSON.stringify({ apiKey }),
  ]);
  db.close();
  return path;
}

describe("resolveToken priority", () => {
  test("env beats file and desktop", async () => {
    const config = makeConfig({
      devinApiKey: "env-token",
      desktopStateDb: makeDesktopDb("desktop-token"),
    });
    await writeTokenFile(config, "file-token");
    const r = await resolveToken(config);
    expect(r).toEqual({ token: "env-token", source: "env", detail: "DEVIN_API_KEY" });
  });

  test("file beats desktop", async () => {
    const config = makeConfig({ desktopStateDb: makeDesktopDb("desktop-token") });
    await writeTokenFile(config, "file-token");
    const r = await resolveToken(config);
    expect(r.source).toBe("file");
    expect(r.token).toBe("file-token");
    expect(r.detail).toContain("token");
  });

  test("desktop when env and file absent", async () => {
    const config = makeConfig({ desktopStateDb: makeDesktopDb("desktop-token") });
    const r = await resolveToken(config);
    expect(r).toEqual({ token: "desktop-token", source: "desktop", detail: config.desktopStateDb! });
  });

  test("all missing → throws with guidance mentioning login", async () => {
    const config = makeConfig();
    await expect(resolveToken(config)).rejects.toThrow(/login/i);
    await expect(resolveToken(config)).rejects.toThrow(/DEVIN_API_KEY/);
  });
});

describe("createTokenProvider", () => {
  test("caches and invalidate() re-resolves", async () => {
    const config = makeConfig({ devinApiKey: "first" });
    const provider = createTokenProvider(config);
    expect((await provider.get()).token).toBe("first");
    // invalidate → next get re-walks the chain (env now "changed")
    (config as { devinApiKey?: string }).devinApiKey = "second";
    expect((await provider.get()).token).toBe("first"); // still cached
    provider.invalidate();
    expect((await provider.get()).token).toBe("second");
  });
});

describe("tokenFingerprint", () => {
  test("hides the middle of the token", () => {
    const token = "devin-session-token$" + "x".repeat(160) + "ENDTAIL";
    const fp = tokenFingerprint(token);
    expect(fp.startsWith(token.slice(0, 20))).toBe(true);
    expect(fp.endsWith(token.slice(-6))).toBe(true);
    expect(fp).toContain("…");
    expect(fp.length).toBeLessThan(token.length);
    expect(fp).not.toContain(token);
  });
});
