/**
 * Upstream session-token resolution.
 *
 * Resolution chain (first hit wins):
 *   1. DEVIN_API_KEY environment variable (config.devinApiKey)
 *   2. Token file at <configDir>/token (written by `devin-proxy login`)
 *   3. Local Devin Desktop state.vscdb (auto-detected)
 *
 * `createTokenProvider` caches the resolution; `invalidate()` drops the cache
 * so the next `get()` walks the chain again (used after an upstream auth
 * rejection).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProxyConfig } from "./config.js";
import { findDesktopStateDb, readDesktopAuth } from "./desktop.js";
import { log } from "./log.js";

export type TokenSource = "env" | "file" | "desktop";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** Where the token came from: env var name / file path / db path. */
  detail: string;
}

export interface TokenProvider {
  get(): Promise<ResolvedToken>;
  invalidate(): void;
}

export function tokenFilePath(config: ProxyConfig): string {
  return join(config.configDir, "token");
}

export async function readTokenFile(config: ProxyConfig): Promise<string> {
  try {
    return (await readFile(tokenFilePath(config), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function writeTokenFile(config: ProxyConfig, token: string): Promise<void> {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(tokenFilePath(config), token.trim(), "utf8");
}

/** Masked token for logs: first 20 chars + "…" + last 6. Never log raw tokens. */
export function tokenFingerprint(token: string): string {
  if (token.length <= 30) return `${token.slice(0, 4)}…(${token.length} chars)…${token.slice(-4)}`;
  return `${token.slice(0, 20)}…${token.slice(-6)}`;
}

/** Walk the resolution chain once, without caching. Throws when all fail. */
export async function resolveToken(config: ProxyConfig): Promise<ResolvedToken> {
  const envToken = config.devinApiKey?.trim();
  if (envToken) return { token: envToken, source: "env", detail: "DEVIN_API_KEY" };

  const fileToken = await readTokenFile(config);
  if (fileToken) return { token: fileToken, source: "file", detail: tokenFilePath(config) };

  const dbPath = findDesktopStateDb(config.desktopStateDb);
  if (dbPath) {
    const auth = readDesktopAuth(dbPath);
    if (auth?.apiKey) return { token: auth.apiKey, source: "desktop", detail: dbPath };
    log.warn(`[token] state.vscdb at ${dbPath} contains no usable apiKey`);
  }

  throw new Error(
    "No Devin session token found. Provide one by:\n" +
    "  1. Setting the DEVIN_API_KEY environment variable, or\n" +
    "  2. Running `bun run login` (devin-proxy login) to save a token file, or\n" +
    "  3. Signing in to Devin Desktop on this machine (state.vscdb is auto-detected).",
  );
}

export function createTokenProvider(config: ProxyConfig): TokenProvider {
  let cached: ResolvedToken | null = null;
  return {
    async get(): Promise<ResolvedToken> {
      if (!cached) cached = await resolveToken(config);
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
