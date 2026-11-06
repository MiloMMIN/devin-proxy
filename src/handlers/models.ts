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
        name: m.name,
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
        // Aliases some aggregators probe for (the farm manager reads both
        // shapes: devin's context_window/max_tokens and OpenRouter-style
        // context_length/max_output_tokens).
        context_length: m.contextWindow,
        max_output_tokens: m.maxTokens,
        reasoning: m.reasoning,
        supports_images: m.supportsImages,
        ...(m.supportedEfforts && m.supportedEfforts.length > 0
          ? { supported_efforts: m.supportedEfforts, efforts: m.supportedEfforts }
          : {}),
      })),
    });
  } catch (err) {
    log.error(`[models ${reqId}] discovery failed:`, err);
    return errorResponse(req, 502, `Model discovery failed: ${String((err as Error).message ?? err)}`);
  }
}
