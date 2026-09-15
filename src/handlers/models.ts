/**
 * GET /v1/models — OpenAI-style model list backed by upstream discovery.
 * `?refresh=1` forces a catalog refresh.
 */

import type { AppDeps } from "../server.js";
import { errorResponse, jsonResponse } from "../http.js";
import { log } from "../log.js";

export async function handleModels(req: Request, deps: AppDeps, reqId: string): Promise<Response> {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  try {
    const models = await deps.catalog.list(refresh);
    return jsonResponse(req, {
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: 1700000000,
        owned_by: "devin",
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
        reasoning: m.reasoning,
        supports_images: m.supportsImages,
      })),
    });
  } catch (err) {
    log.error(`[models ${reqId}] discovery failed:`, err);
    return errorResponse(req, 502, `Model discovery failed: ${String((err as Error).message ?? err)}`);
  }
}
