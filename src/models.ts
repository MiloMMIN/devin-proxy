/**
 * Model catalog: upstream model discovery with a TTL cache plus client-facing
 * id → upstream uid resolution.
 *
 * `resolve` handles three things, in order:
 *  1. `MODEL_MAP` aliases — returned untouched, no effort rewriting.
 *  2. Effort → uid rewriting. Upstream has no effort parameter: every
 *     (family, level, tier) combo is a distinct uid (`claude-opus-5-high`,
 *     `claude-opus-5-high-fast`, `gpt-5-6-terra-high-priority`). The level
 *     signal comes from an explicit `family:level[-tier]` suffix inside the
 *     model string (wins over everything) or from `effortHint`
 *     (`reasoning_effort` / `reasoning.effort` / Anthropic `thinking`+`effort`
 *     mapped by `effortLevelFromThinking`). A bare family name with no signal
 *     defaults to `medium`.
 *  3. Passthrough — unknown models (and an unreachable catalog) return the
 *     client id unchanged so upstream errors keep the client's own name.
 */

import { log } from "./log.js";
import type { DiscoveredModel, UpstreamClient } from "./upstream.js";

/** Effort levels, lowest → highest. `max` is the top rung upstream exposes. */
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Tier modifiers that may follow the level token in a uid. */
const MOD_TOKENS = new Set(["fast", "priority", "1m"]);

/**
 * Numeric score per level token. `-thinking` (the claude-opus-4-6 family) is a
 * pseudo-level and scores as `high`; ids with no level token score as `none`.
 */
const LEVEL_SCORE = new Map<string, number>([
  ...LEVELS.map((l, i) => [l, i] as [string, number]),
  ["thinking", LEVELS.indexOf("high")],
]);

const DEFAULT_LEVEL = "medium";

/**
 * Client-facing aliases baked into `resolve` (below `MODEL_MAP` in priority).
 * The fusion presets are chisel-style lead+sidekick orchestration uids —
 * max-effort non-fast lead paired with a SWE-2 High sidekick. Outside chisel
 * the sidekick handoff tool has no client implementation, so they run the
 * lead model only.
 */
const BUILTIN_ALIASES: Record<string, string> = {
  "fusion-fable5.1-swe2": "fusion-claude-fable-5-1-max-sidekick-swe-2-high",
  "fusion-astra-swe2": "fusion-gpt-6-astra-max-sidekick-swe-2-high",
};

/**
 * Non-catalog uids surfaced in `list()`. `adaptive` is upstream's server-side
 * auto-router uid (verified valid — upstream gates it on quota, not model
 * validity). The two fusion aliases let clients pick the presets above by
 * friendly name; the raw `fusion-*-sidekick-*` uids also pass through.
 */
const EXTRA_MODELS: DiscoveredModel[] = [
  { id: "adaptive", name: "Adaptive (auto-routed)", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, supportsImages: true },
  { id: "fusion-fable5.1-swe2", name: "Fusion: Fable 5.1 Max + SWE-2 High", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, supportsImages: true },
  { id: "fusion-astra-swe2", name: "Fusion: GPT-6 Astra Max + SWE-2 High", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, supportsImages: true },
];

/** Discovered list plus `EXTRA_MODELS`, skipping ids upstream already lists. */
function withExtras(models: DiscoveredModel[]): DiscoveredModel[] {
  const ids = new Set(models.map((m) => m.id));
  return [...models, ...EXTRA_MODELS.filter((e) => !ids.has(e.id))];
}

/** Normalize an effort hint: `off`→`none`; `auto`/unknown values → undefined. */
function normalizeEffort(raw?: string): string | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "off") return "none";
  return (LEVELS as readonly string[]).includes(v) ? v : undefined;
}

interface UidParts {
  /** Family stem with the level/modifier tail stripped. */
  stem: string;
  /** Trailing level token (`thinking` included), if present. */
  level?: string;
  /** Trailing tier modifiers, in uid order. */
  mods: string[];
}

/** Pop trailing tokens in LEVELS ∪ {"thinking","fast","priority","1m"}. */
function parseUidTail(id: string): UidParts {
  const tokens = id.split("-");
  let end = tokens.length;
  while (end > 0 && (LEVEL_SCORE.has(tokens[end - 1]) || MOD_TOKENS.has(tokens[end - 1]))) {
    end--;
  }
  const tail = tokens.slice(end);
  return {
    stem: tokens.slice(0, end).join("-"),
    level: tail.find((t) => LEVEL_SCORE.has(t)),
    mods: tail.filter((t) => MOD_TOKENS.has(t)),
  };
}

/**
 * Parse the suffix of `family:<suffix>` — level plus optional tier tokens
 * (`xhigh`, `high-fast`, bare `fast`/`priority`/`1m` for default level + tier).
 * Returns undefined when any token is foreign, leaving the id opaque.
 */
function parseColonHint(raw: string): { level?: string; mods: string[] } | undefined {
  const tokens = raw.toLowerCase().split("-").filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  let level: string | undefined;
  const mods: string[] = [];
  for (const t of tokens) {
    if (MOD_TOKENS.has(t)) {
      mods.push(t);
      continue;
    }
    const asLevel = t === "thinking" ? "thinking" : normalizeEffort(t);
    if (asLevel === undefined || level !== undefined) return undefined;
    level = asLevel;
  }
  return { level, mods };
}

/**
 * Nearest-level picker over one family's candidate uids.
 *
 * The pool is candidates whose modifier set is a superset of the request's —
 * an empty requested set therefore admits every tier, which is how
 * `gpt-5-6-terra` + `high` lands on `gpt-5-6-terra-high-priority` (terra only
 * ships leveled uids as `-priority`). If nothing satisfies the requested mods
 * the pool widens to the whole family. Ranking: smallest level-index
 * distance, then lower level (cheaper), then exact modifier match, fewer
 * mods, and finally id order for determinism.
 */
function pickNearestUid(candidates: string[], targetLevel: string, targetMods: string[]): string {
  const targetScore = LEVEL_SCORE.get(targetLevel) ?? LEVEL_SCORE.get(DEFAULT_LEVEL)!;
  const targetSet = new Set(targetMods);
  const superset = candidates.filter((id) => {
    const { mods } = parseUidTail(id);
    return targetMods.every((m) => mods.includes(m));
  });
  const pool = superset.length > 0 ? superset : candidates;

  let best: { id: string; dist: number; score: number; sameMods: boolean; modCount: number } | null = null;
  for (const id of pool) {
    const parsed = parseUidTail(id);
    const score = parsed.level === undefined ? 0 : (LEVEL_SCORE.get(parsed.level) ?? 0);
    const cand = {
      id,
      dist: Math.abs(score - targetScore),
      score,
      sameMods: parsed.mods.length === targetMods.length && parsed.mods.every((m) => targetSet.has(m)),
      modCount: parsed.mods.length,
    };
    if (
      best === null
      || cand.dist < best.dist
      || (cand.dist === best.dist && cand.score < best.score)
      || (cand.dist === best.dist && cand.score === best.score && cand.sameMods && !best.sameMods)
      || (cand.dist === best.dist && cand.score === best.score && cand.sameMods === best.sameMods && cand.modCount < best.modCount)
      || (cand.dist === best.dist && cand.score === best.score && cand.sameMods === best.sameMods
        && cand.modCount === best.modCount && cand.id < best.id)
    ) {
      best = cand;
    }
  }
  return best!.id;
}

/**
 * Map Anthropic thinking controls to a level for `resolve`. `effort` (the
 * newer top-level param) overrides `thinking` when present and valid.
 * `disabled`→none; `enabled`/`adaptive` map `budget_tokens`:
 * absent→high, <8000→low, <32000→medium, <128000→high, ≥128000→xhigh.
 */
export function effortLevelFromThinking(
  thinking?: { type?: string; budget_tokens?: number },
  effort?: string,
): string | undefined {
  const fromEffort = normalizeEffort(effort);
  if (fromEffort !== undefined) return fromEffort;
  if (!thinking) return undefined;
  const type = thinking.type?.toLowerCase();
  if (type === "disabled") return "none";
  if (type !== "enabled" && type !== "adaptive") return undefined;
  const budget = thinking.budget_tokens;
  if (budget === undefined) return "high";
  if (budget < 8_000) return "low";
  if (budget < 32_000) return "medium";
  if (budget < 128_000) return "high";
  return "xhigh";
}

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
      return withExtras(this.cache);
    }
    this.inflight ??= this.refresh();
    try {
      return withExtras(await this.inflight);
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

  /**
   * Map a client-facing model id to the upstream uid. `MODEL_MAP` aliases
   * return untouched. Otherwise the effort signal — an explicit
   * `family:level[-tier]` suffix in `modelId` (which wins over `effortHint`)
   * or the per-protocol hint — selects the exact `family-level[-tier]` uid;
   * missing uids fall back to the nearest catalog level while `fast` /
   * `priority` / `1m` modifiers from the original id are preserved. A bare
   * family name defaults to `medium`. Unknown ids pass through unchanged;
   * when the catalog is unavailable, `family:level` still joins
   * syntactically so the hint reaches upstream.
   */
  async resolve(modelId: string, effortHint?: string): Promise<string> {
    const colon = modelId.indexOf(":");
    const colonHint = colon > 0 ? parseColonHint(modelId.slice(colon + 1)) : undefined;
    const base = colonHint ? modelId.slice(0, colon) : modelId;

    const mapped =
      this.modelMap[modelId] ?? this.modelMap[base] ?? BUILTIN_ALIASES[modelId] ?? BUILTIN_ALIASES[base];
    if (mapped) return mapped;

    const { stem, level: embeddedLevel, mods: embeddedMods } = parseUidTail(base);
    const hintLevel = colonHint ? undefined : normalizeEffort(effortHint);

    // Already a leveled uid and no new level signal → nothing to rewrite.
    if (!colonHint && hintLevel === undefined && embeddedLevel !== undefined) {
      return modelId;
    }

    const targetLevel = colonHint
      ? (colonHint.level ?? embeddedLevel ?? DEFAULT_LEVEL)
      : (hintLevel ?? embeddedLevel ?? DEFAULT_LEVEL);
    // Explicit `:level-tier` sets the tier; level-only hints keep whatever
    // modifiers the original id carried.
    const targetMods = colonHint && colonHint.mods.length > 0 ? colonHint.mods : embeddedMods;

    let ids: string[];
    try {
      ids = (await this.list()).map((m) => m.id);
    } catch {
      ids = [];
    }
    if (ids.length === 0) {
      return colonHint ? `${base}-${modelId.slice(colon + 1)}` : modelId;
    }

    const candidates = ids.filter((id) => parseUidTail(id).stem === stem);
    // Unknown family: a colon hint still joins syntactically so the hint
    // reaches upstream as a `family-level-tier` uid rather than raw `a:b`.
    if (candidates.length === 0) {
      return colonHint ? `${base}-${modelId.slice(colon + 1)}` : modelId;
    }

    const exact = [stem, targetLevel, ...targetMods].join("-");
    if (candidates.includes(exact)) return exact;
    return pickNearestUid(candidates, targetLevel, targetMods);
  }
}
