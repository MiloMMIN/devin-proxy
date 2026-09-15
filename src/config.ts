/**
 * Proxy configuration, loaded from environment variables via `loadConfig`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { LogLevel } from "./log.js";

export interface ProxyConfig {
  /** Listen port (PORT, default 3000). */
  port: number;
  /** Listen host (HOST, default 127.0.0.1). */
  host: string;
  /** Optional client-facing API key guarding /v1/* routes (PROXY_API_KEY). */
  proxyApiKey?: string;
  /** Optional upstream session token override (DEVIN_API_KEY). */
  devinApiKey?: string;
  /** Optional upstream base URL override (DEVIN_BASE_URL). */
  devinBaseUrl?: string;
  /** Config dir holding the token file (DEVIN_PROXY_CONFIG_DIR, default ~/.devin-proxy). */
  configDir: string;
  /** Explicit path to the Devin Desktop state.vscdb (DEVIN_DESKTOP_STATE_DB). */
  desktopStateDb?: string;
  /** Client model id → upstream model uid aliases (MODEL_MAP="a=uid,b=uid2"). */
  modelMap: Record<string, string>;
  /** Model catalog cache TTL (MODELS_TTL_MS, default 600000). */
  modelsTtlMs: number;
  /** Log level (LOG_LEVEL, default info). */
  logLevel: LogLevel;
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const modelMap: Record<string, string> = {};
  for (const pair of (env.MODEL_MAP ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const alias = pair.slice(0, eq).trim();
    const uid = pair.slice(eq + 1).trim();
    if (alias && uid) modelMap[alias] = uid;
  }

  const rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  const port = Number(env.PORT ?? "");
  const ttl = Number(env.MODELS_TTL_MS ?? "");

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    host: env.HOST?.trim() || "127.0.0.1",
    proxyApiKey: env.PROXY_API_KEY?.trim() || undefined,
    devinApiKey: env.DEVIN_API_KEY?.trim() || undefined,
    devinBaseUrl: env.DEVIN_BASE_URL?.trim() || undefined,
    configDir: env.DEVIN_PROXY_CONFIG_DIR?.trim() || join(homedir(), ".devin-proxy"),
    desktopStateDb: env.DEVIN_DESKTOP_STATE_DB?.trim() || undefined,
    modelMap,
    modelsTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : 600_000,
    logLevel: (LOG_LEVELS.has(rawLevel) ? rawLevel : "info") as LogLevel,
  };
}
