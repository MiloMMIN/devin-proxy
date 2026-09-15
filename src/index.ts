/**
 * devin-proxy — CLI entry point.
 *
 * Subcommands:
 *   serve (default)   start the OpenAI/Anthropic-compatible reverse proxy
 *   login [--paste] [--print]   OAuth PKCE login → writes <configDir>/token
 *   status            show token source + upstream account info
 *   models            list upstream models
 */

import { loadConfig } from "./config.js";
import { createTokenProvider, resolveToken, tokenFingerprint } from "./token.js";
import { createUpstreamClient } from "./upstream.js";
import { ModelCatalog } from "./models.js";
import { startServer } from "./server.js";
import { runLogin } from "./login.js";
import { log } from "./log.js";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
const args = command === argv[0] ? argv.slice(1) : argv;

function usage(): void {
  console.log(`devin-proxy — Devin Desktop models behind OpenAI/Anthropic APIs

Usage: bun run src/index.ts <command>

Commands:
  serve                 start the proxy (default)
  login [--paste] [--print]   OAuth login, save token to config dir
  status                show token source and account info
  models                list upstream models
`);
}

async function cmdServe(): Promise<void> {
  const config = loadConfig();
  log.setLevel(config.logLevel);
  const tokens = createTokenProvider(config);

  // Resolve the upstream token before binding the port so a missing
  // credential fails fast with guidance instead of serving 502s.
  let resolved;
  try {
    resolved = await tokens.get();
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }

  const upstream = createUpstreamClient({ tokens, baseUrl: config.devinBaseUrl });
  const catalog = new ModelCatalog(upstream, config.modelsTtlMs, config.modelMap);
  const { server, stop } = startServer({ config, tokens, upstream, catalog });

  const shutdown = (): void => {
    void stop().then(() => process.exit(0)).catch((error) => {
      log.error("[shutdown] failed to stop cleanly:", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const addr = `http://${config.host}:${server.port}`;
  console.log(`devin-proxy listening at ${addr}`);
  console.log(`  OpenAI:    POST /v1/chat/completions, POST /v1/responses, GET /v1/models`);
  console.log(`  Anthropic: POST /v1/messages (+ /v1/messages/count_tokens)`);
  console.log(`  Health:    GET  /health`);
  console.log(`  Token:     ${resolved.source} (${resolved.detail}) ${tokenFingerprint(resolved.token)}`);
  console.log(`  Proxy key: ${config.proxyApiKey ? "enabled — /v1/* requires Bearer/x-api-key" : "disabled (PROXY_API_KEY unset)"}`);
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  log.setLevel(config.logLevel);
  try {
    const resolved = await resolveToken(config);
    console.log(`Token source: ${resolved.source}`);
    console.log(`Detail:       ${resolved.detail}`);
    console.log(`Token:        ${tokenFingerprint(resolved.token)}`);

    const tokens = createTokenProvider(config);
    const upstream = createUpstreamClient({ tokens, baseUrl: config.devinBaseUrl });
    const { payload } = await upstream.getUserJwt();
    const expMs = typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
    const mins = expMs !== undefined ? Math.max(0, Math.round((expMs - Date.now()) / 60_000)) : "?";
    console.log(`Email:        ${String(payload.email ?? "-")}`);
    console.log(`Name:         ${String(payload.name ?? "-")}`);
    console.log(`Pro:          ${String(payload.pro ?? "-")}`);
    console.log(`Teams tier:   ${String(payload.teams_tier ?? "-")}`);
    console.log(`JWT expires:  in ~${mins} min`);
  } catch (err) {
    console.error(`status failed: ${String((err as Error).message ?? err)}`);
    process.exit(1);
  }
}

async function cmdModels(): Promise<void> {
  const config = loadConfig();
  log.setLevel(config.logLevel);
  const tokens = createTokenProvider(config);
  const upstream = createUpstreamClient({ tokens, baseUrl: config.devinBaseUrl });
  const catalog = new ModelCatalog(upstream, config.modelsTtlMs, config.modelMap);
  try {
    const models = await catalog.list(true);
    const idW = Math.min(60, Math.max(20, ...models.map((m) => m.id.length)) + 2);
    const nameW = Math.min(40, Math.max(10, ...models.map((m) => m.name.length)) + 2);
    console.log(`${"ID".padEnd(idW)}${"NAME".padEnd(nameW)}${"CTX".padStart(9)}  IMG   THINK`);
    for (const m of models) {
      const name = m.name.length > nameW - 1 ? m.name.slice(0, nameW - 2) + "…" : m.name;
      console.log(
        `${m.id.padEnd(idW)}${name.padEnd(nameW)}${String(m.contextWindow).padStart(9)}  ${m.supportsImages ? "yes" : "-"}     ${m.reasoning ? "yes" : "-"}`,
      );
    }
    console.log(`\n${models.length} models`);
  } catch (err) {
    console.error(`models failed: ${String((err as Error).message ?? err)}`);
    process.exit(1);
  }
}

switch (command) {
  case "serve":
    await cmdServe();
    break;
  case "login": {
    const config = loadConfig();
    log.setLevel(config.logLevel);
    await runLogin(config, args);
    break;
  }
  case "status":
    await cmdStatus();
    break;
  case "models":
    await cmdModels();
    break;
  default:
    usage();
    process.exit(1);
}
