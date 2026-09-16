import { describe, expect, test } from "bun:test";
import { ModelCatalog, effortLevelFromThinking } from "../src/models.js";
import type { ChatStreamEvent, DiscoveredModel, UpstreamClient } from "../src/upstream.js";

const MODELS: DiscoveredModel[] = [
  { id: "m-a", name: "Model A", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, supportsImages: false },
  { id: "m-b", name: "Model B", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: false, supportsImages: true },
];

/**
 * Fake catalog mirroring the live uid shapes: leveled families with `-fast` /
 * `-priority` / `-1m` tiers, the `thinking` pseudo-level family, and bare
 * un-leveled uids. `claude-opus-5-low-fast` is included so the
 * `high-fast`→`low` rewrite has a deterministic exact hit.
 */
const LEVEL_UIDS = [
  "claude-opus-5-low", "claude-opus-5-medium", "claude-opus-5-high", "claude-opus-5-xhigh", "claude-opus-5-max",
  "claude-opus-5-low-fast", "claude-opus-5-high-fast",
  "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4-6-1m", "claude-opus-4-6-thinking-1m",
  "gpt-5-6-terra-none", "gpt-5-6-terra-low-priority", "gpt-5-6-terra-high-priority",
  "glm-5-2", "swe-1-6", "swe-1-6-fast", "inkling-none", "kimi-k2-6",
];
const LEVEL_MODELS: DiscoveredModel[] = LEVEL_UIDS.map((id) => ({
  id, name: id, contextWindow: 200_000, maxTokens: 64_000, reasoning: true, supportsImages: false,
}));

function fakeUpstream(impl?: { fail?: boolean; models?: DiscoveredModel[] }): { client: UpstreamClient; calls: () => number } {
  let calls = 0;
  const client: UpstreamClient = {
    streamChat: async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "done" };
    },
    discoverModels: async () => {
      calls++;
      if (impl?.fail) throw new Error("discovery boom");
      return impl?.models ?? MODELS;
    },
    getUserJwt: async () => ({ userJwt: "jwt", payload: {} }),
  };
  return { client, calls: () => calls };
}

const EXTRA_IDS = ["adaptive", "fusion-fable5.1-swe2", "fusion-astra-swe2"];

describe("ModelCatalog", () => {
  test("list() caches within TTL — one upstream call", async () => {
    const { client, calls } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, {});
    expect((await catalog.list()).map((m) => m.id)).toEqual([...MODELS.map((m) => m.id), ...EXTRA_IDS]);
    expect((await catalog.list()).map((m) => m.id)).toEqual([...MODELS.map((m) => m.id), ...EXTRA_IDS]);
    expect(calls()).toBe(1);
  });

  test("force refresh hits upstream again", async () => {
    const { client, calls } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, {});
    await catalog.list();
    await catalog.list(true);
    expect(calls()).toBe(2);
  });

  test("expired TTL refreshes", async () => {
    const { client, calls } = fakeUpstream();
    const catalog = new ModelCatalog(client, 1, {}); // 1ms TTL
    await catalog.list();
    await new Promise((r) => setTimeout(r, 5));
    await catalog.list();
    expect(calls()).toBe(2);
  });

  test("refresh failure returns stale cache", async () => {
    let fail = false;
    const upstream: UpstreamClient = {
      streamChat: async function* (): AsyncGenerator<ChatStreamEvent> { yield { type: "done" }; },
      discoverModels: async () => { if (fail) throw new Error("boom"); return MODELS; },
      getUserJwt: async () => ({ userJwt: "jwt", payload: {} }),
    };
    const catalog = new ModelCatalog(upstream, 1, {});
    expect((await catalog.list()).length).toBe(MODELS.length + EXTRA_IDS.length);
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    expect((await catalog.list()).length).toBe(MODELS.length + EXTRA_IDS.length); // stale, not thrown
  });

  test("refresh failure with no cache throws", async () => {
    const { client } = fakeUpstream({ fail: true });
    const catalog = new ModelCatalog(client, 60_000, {});
    await expect(catalog.list()).rejects.toThrow("discovery boom");
  });

  test("resolve maps aliases and passes unknown ids through", async () => {
    const { client } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, { fast: "glm-5-2-none" });
    expect(await catalog.resolve("fast")).toBe("glm-5-2-none");
    expect(await catalog.resolve("unknown-model")).toBe("unknown-model");
  });

  test("resolve maps builtin aliases — adaptive and fusion presets", async () => {
    const { client } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, {});
    expect(await catalog.resolve("adaptive")).toBe("adaptive");
    expect(await catalog.resolve("fusion-fable5.1-swe2")).toBe("fusion-claude-fable-5-1-max-sidekick-swe-2-high");
    expect(await catalog.resolve("fusion-astra-swe2")).toBe("fusion-gpt-6-astra-max-sidekick-swe-2-high");
    // colon suffix still resolves the alias base; raw fusion uid passes through
    expect(await catalog.resolve("fusion-fable5.1-swe2:high")).toBe("fusion-claude-fable-5-1-max-sidekick-swe-2-high");
    expect(await catalog.resolve("fusion-claude-opus-5-high-sidekick-swe-2-medium"))
      .toBe("fusion-claude-opus-5-high-sidekick-swe-2-medium");
    // env MODEL_MAP wins over builtin aliases
    const envCatalog = new ModelCatalog(client, 60_000, { "fusion-astra-swe2": "custom-uid" });
    expect(await envCatalog.resolve("fusion-astra-swe2")).toBe("custom-uid");
  });
});

describe("ModelCatalog.resolve — effort levels", () => {
  const makeCatalog = (modelMap: Record<string, string> = {}, models = LEVEL_MODELS) =>
    new ModelCatalog(fakeUpstream({ models }).client, 60_000, modelMap);

  test("bare family name defaults to medium", async () => {
    expect(await makeCatalog().resolve("claude-opus-5")).toBe("claude-opus-5-medium");
  });

  test("`family:level` and `family:level-tier` colon hints", async () => {
    const catalog = makeCatalog();
    expect(await catalog.resolve("claude-opus-5:xhigh")).toBe("claude-opus-5-xhigh");
    expect(await catalog.resolve("claude-opus-5:high-fast")).toBe("claude-opus-5-high-fast");
  });

  test("colon hint beats the effort param", async () => {
    expect(await makeCatalog().resolve("claude-opus-5:low", "high")).toBe("claude-opus-5-low");
  });

  test("effort hint rewrites the level, keeping modifiers", async () => {
    const catalog = makeCatalog();
    expect(await catalog.resolve("claude-opus-5-low", "high")).toBe("claude-opus-5-high");
    // `low-fast` is in the fixture, so this is an exact hit rather than a
    // nearest-level fallback.
    expect(await catalog.resolve("claude-opus-5-high-fast", "low")).toBe("claude-opus-5-low-fast");
  });

  test("invalid hint values leave the uid untouched", async () => {
    const catalog = makeCatalog();
    expect(await catalog.resolve("claude-opus-5-low", "bogus")).toBe("claude-opus-5-low");
    expect(await catalog.resolve("claude-opus-5-low", "auto")).toBe("claude-opus-5-low");
  });

  test("nearest fallback crosses tier when the level only exists there", async () => {
    const catalog = makeCatalog();
    // terra has no plain `-high` — only `-none` plain; leveled uids are `-priority`.
    expect(await catalog.resolve("gpt-5-6-terra", "high")).toBe("gpt-5-6-terra-high-priority");
    expect(await catalog.resolve("gpt-5-6-terra-none", "high")).toBe("gpt-5-6-terra-high-priority");
  });

  test("`-thinking` pseudo-level family (claude-opus-4-6)", async () => {
    const catalog = makeCatalog();
    expect(await catalog.resolve("claude-opus-4-6", "xhigh")).toBe("claude-opus-4-6-thinking");
    expect(await catalog.resolve("claude-opus-4-6", "none")).toBe("claude-opus-4-6");
    // `-1m` from the original id is preserved across the level rewrite.
    expect(await catalog.resolve("claude-opus-4-6-thinking-1m", "none")).toBe("claude-opus-4-6-1m");
  });

  test("un-leveled uids cannot take a level and come back unchanged", async () => {
    const catalog = makeCatalog();
    expect(await catalog.resolve("glm-5-2", "high")).toBe("glm-5-2");
    expect(await catalog.resolve("swe-1-6-fast", "high")).toBe("swe-1-6-fast");
    expect(await catalog.resolve("kimi-k2-6", "high")).toBe("kimi-k2-6"); // `-6` is name, not level
  });

  test("unknown models pass through, hint or not", async () => {
    expect(await makeCatalog().resolve("bogus-model", "high")).toBe("bogus-model");
  });

  test("MODEL_MAP alias wins and skips rewriting", async () => {
    const catalog = makeCatalog({ "alias-x": "claude-opus-5-low" });
    expect(await catalog.resolve("alias-x", "high")).toBe("claude-opus-5-low");
  });

  test("empty catalog: colon joins syntactically, bare ids pass through", async () => {
    const catalog = makeCatalog({}, []);
    expect(await catalog.resolve("family:high")).toBe("family-high");
    expect(await catalog.resolve("family:high-fast")).toBe("family-high-fast");
    expect(await catalog.resolve("model", "high")).toBe("model");
  });
});

describe("effortLevelFromThinking", () => {
  test("budget_tokens brackets", () => {
    expect(effortLevelFromThinking({ type: "enabled" })).toBe("high");
    expect(effortLevelFromThinking({ type: "adaptive" })).toBe("high");
    expect(effortLevelFromThinking({ type: "enabled", budget_tokens: 5_000 })).toBe("low");
    expect(effortLevelFromThinking({ type: "enabled", budget_tokens: 20_000 })).toBe("medium");
    expect(effortLevelFromThinking({ type: "enabled", budget_tokens: 100_000 })).toBe("high");
    expect(effortLevelFromThinking({ type: "enabled", budget_tokens: 200_000 })).toBe("xhigh");
  });

  test("disabled → none; missing → undefined", () => {
    expect(effortLevelFromThinking({ type: "disabled" })).toBe("none");
    expect(effortLevelFromThinking(undefined)).toBeUndefined();
    expect(effortLevelFromThinking({ type: "bogus" })).toBeUndefined();
  });

  test("top-level effort overrides thinking", () => {
    expect(effortLevelFromThinking({ type: "enabled", budget_tokens: 200_000 }, "low")).toBe("low");
    expect(effortLevelFromThinking({ type: "disabled" }, "max")).toBe("max");
    // invalid effort falls back to the thinking mapping
    expect(effortLevelFromThinking({ type: "disabled" }, "bogus")).toBe("none");
  });
});
