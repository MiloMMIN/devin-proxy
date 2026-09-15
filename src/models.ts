/**
 * Model catalog: upstream model discovery with a TTL cache plus client-facing
 * id → upstream uid alias resolution (MODEL_MAP).
 */

import { log } from "./log.js";
import type { DiscoveredModel, UpstreamClient } from "./upstream.js";

export class ModelCatalog {
  private cache: DiscoveredModel[] | null = null;
  private cachedAt = 0;
  private inflight: Promise<DiscoveredModel[]> | null = null;

  constructor(
    private upstream: UpstreamClient,
    private ttlMs: number,
    private modelMap: Record<string, string>,
  ) {}

  /**
   * List discovered models. Returns the cache while fresh; on expiry (or
   * `force`) refreshes from upstream. A failed refresh falls back to the
   * stale cache when one exists, otherwise rethrows.
   */
  async list(force = false): Promise<DiscoveredModel[]> {
    if (!force && this.cache !== null && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cache;
    }
    this.inflight ??= this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async refresh(): Promise<DiscoveredModel[]> {
    try {
      const models = await this.upstream.discoverModels();
      this.cache = models;
      this.cachedAt = Date.now();
      return models;
    } catch (err) {
      if (this.cache !== null) {
        log.warn(`[models] refresh failed, serving stale cache: ${String((err as Error).message ?? err)}`);
        return this.cache;
      }
      throw err;
    }
  }

  /** Map a client-facing model id to the upstream uid; unknown ids pass through. */
  resolve(modelId: string): string {
    return this.modelMap[modelId] ?? modelId;
  }
}
