/**
 * Live integration test — one real upstream call.
 * Only runs with LIVE=1; skipped otherwise. Requires a resolvable token
 * (DEVIN_API_KEY, token file, or local Devin Desktop).
 */

import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { ChatMessageSource } from "../src/proto.js";
import { createTokenProvider } from "../src/token.js";
import { createUpstreamClient, type ChatStreamEvent } from "../src/upstream.js";

const LIVE = process.env.LIVE === "1";

test.skipIf(!LIVE)("live streamChat round trip", async () => {
  const config = loadConfig();
  const tokens = createTokenProvider(config);
  const upstream = createUpstreamClient({ tokens, baseUrl: config.devinBaseUrl });

  const events: ChatStreamEvent[] = [];
  for await (const ev of upstream.streamChat({
    modelUid: "glm-5-2-none",
    systemPrompt: "",
    messages: [{
      messageId: crypto.randomUUID(),
      source: ChatMessageSource.USER,
      prompt: "Reply with exactly: OK",
    }],
    tools: [],
    maxTokens: 32,
  })) {
    events.push(ev);
  }

  expect(events.some((e) => e.type === "text" && (e.deltaText ?? "").length > 0)).toBe(true);
  expect(events.at(-1)!.type).toBe("done");
}, 60_000);
