/**
 * HTTP server: routing, proxy-key auth, request logging, lifecycle.
 *
 *   POST /v1/chat/completions        — OpenAI Chat Completions
 *   POST /v1/responses               — OpenAI Responses API
 *   POST /v1/messages                — Anthropic Messages
 *   POST /v1/messages/count_tokens   — token-count stub
 *   GET  /v1/models                  — OpenAI-style model list
 *   GET  /health                     — health check (no auth)
 *
 * The server holds the upstream credential itself (TokenProvider); clients
 * never forward a Devin token. When PROXY_API_KEY is configured, every route
 * except /health requires `Authorization: Bearer <key>` or `x-api-key: <key>`.
 */

import type { ProxyConfig } from "./config.js";
import type { TokenProvider } from "./token.js";
import type { UpstreamClient } from "./upstream.js";
import type { ModelCatalog } from "./models.js";
import { corsHeaders, errorResponse, jsonResponse, proxyAuthorized } from "./http.js";
import { log, truncate } from "./log.js";
import { handleChatCompletions } from "./handlers/chat.js";
import { handleResponses } from "./handlers/responses.js";
import { handleAnthropicMessages, handleCountTokens } from "./handlers/messages.js";
import { handleModels } from "./handlers/models.js";

export interface AppDeps {
  config: ProxyConfig;
  tokens: TokenProvider;
  upstream: UpstreamClient;
  catalog: ModelCatalog;
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;
    const startedAt = Date.now();
    const id = crypto.randomUUID().slice(0, 8);

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    if (method === "POST" && log.enabled("debug")) {
      try {
        const bodyText = await req.clone().text();
        log.debug(`body [${id}]: ${truncate(bodyText)}`);
      } catch { /* body not cloneable/empty */ }
    }

    log.info(`→ ${method} ${path} [${id}]`);

    let res: Response;
    try {
      // Auth gate: everything except /health requires PROXY_API_KEY when set.
      if (path !== "/health" && deps.config.proxyApiKey && !proxyAuthorized(req, deps.config.proxyApiKey)) {
        res = errorResponse(req, 401, "Invalid or missing API key.", "authentication_error");
      } else if (path === "/health" && method === "GET") {
        let tokenSource = "unavailable";
        try {
          tokenSource = (await deps.tokens.get()).source;
        } catch { /* token resolution failed */ }
        res = jsonResponse(req, {
          status: "ok",
          token_source: tokenSource,
          proxy_auth: deps.config.proxyApiKey ? "enabled" : "disabled",
        });
      } else if (path === "/v1/models" && method === "GET") {
        res = await handleModels(req, deps, id);
      } else if (path === "/v1/chat/completions" && method === "POST") {
        res = await handleChatCompletions(req, deps, id);
      } else if (path === "/v1/responses" && method === "POST") {
        res = await handleResponses(req, deps, id);
      } else if (path === "/v1/messages" && method === "POST") {
        res = await handleAnthropicMessages(req, deps, id);
      } else if (path === "/v1/messages/count_tokens" && method === "POST") {
        res = await handleCountTokens(req, deps, id);
      } else {
        res = errorResponse(req, 404, `Not found: ${method} ${path}`);
      }
    } catch (err) {
      log.error(`handler error [${id}] ${method} ${path}:`, err);
      res = errorResponse(req, 500, String((err as Error).message ?? err));
    }

    const ms = Date.now() - startedAt;
    if (res.status >= 500) log.error(`← ${res.status} ${method} ${path} ${ms}ms [${id}]`);
    else if (res.status >= 400) log.warn(`← ${res.status} ${method} ${path} ${ms}ms [${id}]`);
    else log.info(`← ${res.status} ${method} ${path} ${ms}ms [${id}]`);

    return res;
  };
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}

export function startServer(deps: AppDeps): ServerHandle {
  const server = Bun.serve({
    port: deps.config.port,
    hostname: deps.config.host,
    // Bun closes idle streaming connections after 10s by default. Thinking
    // models can reason for tens of seconds before emitting text, so raise the
    // ceiling (255 is Bun's max) to keep SSE streams alive through quiet gaps.
    idleTimeout: 255,
    fetch: createApp(deps),
  });

  let shutdownStarted = false;
  const stop = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await server.stop();
  };

  return { server, stop };
}
