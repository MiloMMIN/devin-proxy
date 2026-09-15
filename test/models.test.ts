import { describe, expect, test } from "bun:test";
import { ModelCatalog } from "../src/models.js";
import type { ChatStreamEvent, DiscoveredModel, UpstreamClient } from "../src/upstream.js";

const MODELS: DiscoveredModel[] = [
  { id: "m-a", name: "Model A", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, supportsImages: false },
  { id: "m-b", name: "Model B", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: false, supportsImages: true },
];

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

describe("ModelCatalog", () => {
  test("list() caches within TTL — one upstream call", async () => {
    const { client, calls } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, {});
    expect(await catalog.list()).toEqual(MODELS);
    expect(await catalog.list()).toEqual(MODELS);
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
    expect(await catalog.list()).toEqual(MODELS);
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    expect(await catalog.list()).toEqual(MODELS); // stale, not thrown
  });

  test("refresh failure with no cache throws", async () => {
    const { client } = fakeUpstream({ fail: true });
    const catalog = new ModelCatalog(client, 60_000, {});
    await expect(catalog.list()).rejects.toThrow("discovery boom");
  });

  test("resolve maps aliases and passes unknown ids through", () => {
    const { client } = fakeUpstream();
    const catalog = new ModelCatalog(client, 60_000, { fast: "glm-5-2-none" });
    expect(catalog.resolve("fast")).toBe("glm-5-2-none");
    expect(catalog.resolve("unknown-model")).toBe("unknown-model");
  });
});
