import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models.js";
import { createApp } from "../src/server.js";
import type { TokenProvider } from "../src/token.js";
import type { ChatParams, ChatStreamEvent, DiscoveredModel, UpstreamClient } from "../src/upstream.js";

const MODELS: DiscoveredModel[] = [
  { id: "glm-5-2-none", name: "GLM 5.2", contextWindow: 200_000, maxTokens: 64_000, reasoning: false, supportsImages: true },
];

let script: ChatStreamEvent[];
let lastParams: ChatParams | null;
let streamFactory: ((params: ChatParams) => AsyncGenerator<ChatStreamEvent>) | null = null;

const upstream: UpstreamClient = {
  streamChat(params: ChatParams): AsyncGenerator<ChatStreamEvent> {
    lastParams = params;
    if (streamFactory) return streamFactory(params);
    const events = script;
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  },
  discoverModels: async () => MODELS,
  getUserJwt: async () => ({ userJwt: "jwt", payload: {} }),
};

const tokens: TokenProvider = {
  get: async () => ({ token: "fake-token", source: "env", detail: "DEVIN_API_KEY" }),
  invalidate: () => {},
};

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    configDir: join(mkdtempSync(join(tmpdir(), "devin-proxy-test-")), "cfg"),
    modelMap: { alias: "glm-5-2-none" },
    modelsTtlMs: 60_000,
    logLevel: "error",
    ...overrides,
  };
}

function makeApp(config: ProxyConfig) {
  const catalog = new ModelCatalog(upstream, config.modelsTtlMs, config.modelMap);
  return createApp({ config, tokens, upstream, catalog });
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://x${path}`, init);
}

function post(path: string, body: unknown, headers?: Record<string, string>): Request {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): { event?: string; data: unknown }[] {
  return text.split("\n\n").filter((f) => f.trim()).map((frame) => {
    let event: string | undefined;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data) };
  });
}

beforeEach(() => {
  script = [
    { type: "thinking", deltaThinking: "thinking…" },
    { type: "text", deltaText: "OK" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } },
    { type: "done", stopReason: 0 },
  ];
  lastParams = null;
  streamFactory = null;
});

describe("health & auth", () => {
  test("GET /health → 200", async () => {
    const app = makeApp(makeConfig());
    const res = await app(req("/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.token_source).toBe("env");
    expect(body.proxy_auth).toBe("disabled");
  });

  test("PROXY_API_KEY set: /v1/models without key → 401, with Bearer or x-api-key → 200", async () => {
    const app = makeApp(makeConfig({ proxyApiKey: "sekret" }));
    expect((await app(req("/v1/models"))).status).toBe(401);
    const bad = await app(req("/v1/models", { headers: { authorization: "Bearer wrong" } }));
    expect(bad.status).toBe(401);
    const errBody = await bad.json() as { error: { type: string } };
    expect(errBody.error.type).toBe("authentication_error");
    expect((await app(req("/v1/models", { headers: { authorization: "Bearer sekret" } }))).status).toBe(200);
    expect((await app(req("/v1/models", { headers: { "x-api-key": "sekret" } }))).status).toBe(200);
    // /health stays open
    expect((await app(req("/health"))).status).toBe(200);
  });

  test("PROXY_API_KEY unset → no auth required", async () => {
    const app = makeApp(makeConfig());
    expect((await app(req("/v1/models"))).status).toBe(200);
  });
});

describe("GET /v1/models", () => {
  test("returns discovered model shape", async () => {
    const app = makeApp(makeConfig());
    const res = await app(req("/v1/models"));
    const body = await res.json() as { object: string; data: Record<string, unknown>[] };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "glm-5-2-none", object: "model", owned_by: "devin",
      context_window: 200_000, max_tokens: 64_000, reasoning: false, supports_images: true,
    });
  });
});

describe("POST /v1/chat/completions", () => {
  test("non-stream: content, tool_calls, usage, finish_reason; system excluded from turns", async () => {
    script = [
      { type: "thinking", deltaThinking: "why " },
      { type: "text", deltaText: "hi" },
      { type: "toolcall", toolCalls: [{ id: "tc1", name: "run", argumentsJson: "{\"a\":1}" }] },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", {
      model: "alias",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hey" },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("alias"); // echoes client id, not uid
    const choice = (body.choices as Record<string, unknown>[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const msg = choice.message as Record<string, unknown>;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("hi"); // content preserved alongside tool_calls
    expect(msg.reasoning_content).toBe("why ");
    const tcs = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[];
    expect(tcs[0].id).toBe("tc1");
    expect(tcs[0].function).toEqual({ name: "run", arguments: "{\"a\":1}" });
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(12);
    expect(usage.completion_tokens).toBe(7);
    expect(usage.total_tokens).toBe(19);
    expect((usage.prompt_tokens_details as Record<string, unknown>).cached_tokens).toBe(3);

    // Upstream params: modelMap applied, system only in systemPrompt
    expect(lastParams).not.toBeNull();
    expect(lastParams!.modelUid).toBe("glm-5-2-none");
    expect(lastParams!.systemPrompt).toBe("SYS");
    expect(lastParams!.messages).toHaveLength(1);
    expect(lastParams!.messages[0].prompt).toBe("hey");
  });

  test("non-stream: same-id toolcall frames append arguments", async () => {
    script = [
      { type: "toolcall", toolCalls: [{ id: "tc1", name: "run", argumentsJson: "{\"a\":" }] },
      { type: "toolcall", toolCalls: [{ id: "tc1", name: "", argumentsJson: "1}" }] },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "x" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] };
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe("{\"a\":1}");
  });

  test("non-stream: system content parts array joins into systemPrompt", async () => {
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
        { role: "user", content: "u" },
      ],
    }));
    expect(res.status).toBe(200);
    expect(lastParams!.systemPrompt).toBe("AB");
    expect(lastParams!.messages).toHaveLength(1);
    expect(lastParams!.messages[0].prompt).toBe("u");
  });

  test("stream: role chunk, content, reasoning_content, tool_calls, finish, usage, [DONE]", async () => {
    script = [
      { type: "thinking", deltaThinking: "t" },
      { type: "text", deltaText: "hi" },
      { type: "toolcall", toolCalls: [{ id: "tc1", name: "run", argumentsJson: "{\"a\":" }] },
      { type: "toolcall", toolCalls: [{ id: "tc1", name: "", argumentsJson: "1}" }] },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", {
      model: "glm-5-2-none",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hey" }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSse(await res.text());

    const chunks = frames.map((f) => f.data) as Record<string, unknown>[];
    expect(chunks[0].object).toBe("chat.completion.chunk");
    const firstChoices = chunks[0].choices as { delta: Record<string, unknown> }[];
    expect(firstChoices[0].delta.role).toBe("assistant");

    const deltas = chunks.flatMap((c) => ((c.choices ?? []) as { delta: Record<string, unknown> }[]).map((x) => x.delta));
    expect(deltas.some((d) => d.reasoning_content === "t")).toBe(true);
    expect(deltas.some((d) => d.content === "hi")).toBe(true);

    // tool_calls deltas carry OpenAI-style `index`; the continuation frame for
    // the same id emits only index + arguments.
    const tcDeltas = deltas.flatMap((d) => (d.tool_calls ?? []) as Record<string, unknown>[]);
    expect(tcDeltas).toHaveLength(2);
    expect(tcDeltas[0]).toEqual({
      index: 0, id: "tc1", type: "function",
      function: { name: "run", arguments: "{\"a\":" },
    });
    expect(tcDeltas[1]).toEqual({ index: 0, function: { arguments: "1}" } });
    expect(tcDeltas[1].id).toBeUndefined();

    const finishes = chunks.flatMap((c) => ((c.choices ?? []) as { finish_reason: unknown }[]).map((x) => x.finish_reason));
    expect(finishes).toContain("tool_calls");

    const usageChunk = chunks.find((c) => c.usage !== undefined);
    expect(usageChunk).toBeDefined();
    expect((usageChunk!.usage as Record<string, unknown>).total_tokens).toBe(8);

    expect(frames.at(-1)!.data).toBe("[DONE]");
  });

  test("stream: client cancel aborts upstream signal", async () => {
    streamFactory = (params) => (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text", deltaText: "x" };
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) return resolve();
        params.signal?.addEventListener("abort", () => resolve());
      });
      return;
    })();
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", {
      model: "m", stream: true,
      messages: [{ role: "user", content: "x" }],
    }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // role chunk
    await reader.cancel();
    expect(lastParams!.signal!.aborted).toBe(true);
  });

  test("upstream rate-limit error event → 429 rate_limit_error", async () => {
    script = [{ type: "error", error: "rate limit exceeded", code: "resource_exhausted" }];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "x" }] }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("rate_limit_error");
  });

  test("upstream unauthenticated error → 401 authentication_error", async () => {
    script = [{ type: "error", error: "unauthenticated", code: "unauthenticated" }];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "x" }] }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });
});

describe("POST /v1/messages", () => {
  test("non-stream: content order thinking → text → tool_use, stop_reason, usage", async () => {
    script = [
      { type: "thinking", deltaThinking: "ponder" },
      { type: "text", deltaText: "answer" },
      { type: "toolcall", toolCalls: [{ id: "tu1", name: "bash", argumentsJson: "{\"c\":\"ls\"}" }] },
      { type: "usage", usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 } },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/messages", {
      model: "alias",
      max_tokens: 32,
      system: "SYS",
      messages: [{ role: "user", content: "q" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.model).toBe("alias");
    const content = body.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(["thinking", "text", "tool_use"]);
    expect((content[2] as Record<string, unknown>).input).toEqual({ c: "ls" });
    expect(body.stop_reason).toBe("tool_use");
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(9);
    expect(usage.cache_read_input_tokens).toBe(2);

    expect(lastParams!.systemPrompt).toBe("SYS");
    expect(lastParams!.modelUid).toBe("glm-5-2-none");
  });

  test("stream: message_start → content_block_* → message_delta → message_stop", async () => {
    script = [
      { type: "thinking", deltaThinking: "ponder" },
      { type: "text", deltaText: "answer" },
      { type: "toolcall", toolCalls: [{ id: "tu1", name: "bash", argumentsJson: "{\"c\":1}" }] },
      { type: "usage", usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/messages", {
      model: "glm-5-2-none", max_tokens: 32, stream: true,
      messages: [{ role: "user", content: "q" }],
    }));
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const events = frames.map((f) => f.event ?? (f.data as { type?: string }).type);

    expect(events[0]).toBe("message_start");
    expect(events).toContain("content_block_start");
    expect(events).toContain("content_block_delta");
    expect(events).toContain("content_block_stop");
    expect(events).toContain("message_delta");
    expect(events.at(-1)).toBe("message_stop");

    const deltaTypes = frames
      .filter((f) => (f.data as { type?: string }).type === "content_block_delta")
      .map((f) => ((f.data as { delta: { type: string } }).delta.type));
    expect(deltaTypes).toContain("thinking_delta");
    expect(deltaTypes).toContain("text_delta");
    expect(deltaTypes).toContain("input_json_delta");

    const msgDelta = frames.find((f) => (f.data as { type?: string }).type === "message_delta")!.data as {
      delta: { stop_reason: string }; usage: { input_tokens: number; output_tokens: number };
    };
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
    expect(msgDelta.usage.input_tokens).toBe(9);
    expect(msgDelta.usage.output_tokens).toBe(4);
  });

  test("stream: empty tool arguments emit partial_json \"{}\"", async () => {
    script = [
      { type: "toolcall", toolCalls: [{ id: "tu1", name: "bash", argumentsJson: "" }] },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/messages", {
      model: "m", max_tokens: 32, stream: true,
      messages: [{ role: "user", content: "q" }],
    }));
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const jsonDelta = frames
      .map((f) => f.data as { delta?: { type: string; partial_json?: string } })
      .find((d) => d.delta?.type === "input_json_delta");
    expect(jsonDelta!.delta!.partial_json).toBe("{}");
  });

  test("non-stream: malformed tool arguments degrade to {} instead of 500", async () => {
    script = [
      { type: "toolcall", toolCalls: [{ id: "tu1", name: "bash", argumentsJson: "{\"a\":" }] },
      { type: "done", stopReason: 10 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/messages", {
      model: "m", max_tokens: 32,
      messages: [{ role: "user", content: "q" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { content: { type: string; input?: unknown }[] };
    const toolUse = body.content.find((c) => c.type === "tool_use");
    expect(toolUse!.input).toEqual({});
  });

  test("count_tokens returns a positive integer", async () => {
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/messages/count_tokens", {
      model: "m",
      system: "sys",
      messages: [{ role: "user", content: "hello there" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { input_tokens: number };
    expect(Number.isInteger(body.input_tokens)).toBe(true);
    expect(body.input_tokens).toBeGreaterThan(0);
  });
});

describe("POST /v1/responses", () => {
  test("non-stream: output array with message item and usage", async () => {
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/responses", { model: "alias", input: "Reply with exactly: OK" }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("alias");
    const output = body.output as { type: string; content?: { type: string; text: string }[] }[];
    expect(output[0].type).toBe("message");
    expect(output[0].content![0].text).toBe("OK");
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.total_tokens).toBe(12);
    // instructions not provided → systemPrompt empty; input string → single user turn
    expect(lastParams!.systemPrompt).toBe("");
    expect(lastParams!.messages).toHaveLength(1);
    expect(lastParams!.messages[0].prompt).toBe("Reply with exactly: OK");
  });

  test("stream: response.created → item events → response.completed", async () => {
    script = [
      { type: "thinking", deltaThinking: "ponder" },
      { type: "text", deltaText: "hi" },
      { type: "toolcall", toolCalls: [{ id: "fc1", name: "exec", argumentsJson: "{\"a\":1}" }] },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: "done", stopReason: 0 },
    ];
    const app = makeApp(makeConfig());
    const res = await app(post("/v1/responses", {
      model: "glm-5-2-none", stream: true,
      instructions: "inst",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hey" }] }],
    }));
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const events = frames.map((f) => f.event ?? (f.data as { type?: string }).type);

    expect(events[0]).toBe("response.created");
    expect(events).toContain("response.output_item.added");
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.function_call_arguments.delta");
    expect(events).toContain("response.function_call_arguments.done");
    expect(events.at(-1)).toBe("response.completed");

    const completed = frames.at(-1)!.data as { response: { output: { type: string }[]; usage: Record<string, unknown> } };
    const types = completed.response.output.map((o) => o.type);
    expect(types).toContain("reasoning");
    expect(types).toContain("message");
    expect(types).toContain("function_call");
    expect(completed.response.usage.total_tokens).toBe(12);

    // instructions went to systemPrompt, not a developer turn
    expect(lastParams!.systemPrompt).toBe("inst");
    expect(lastParams!.messages).toHaveLength(1);
  });
});

describe("log.setLevel", () => {
  test("setLevel controls enabled()", async () => {
    const { log } = await import("../src/log.js");
    log.setLevel("error");
    expect(log.enabled("info")).toBe(false);
    expect(log.enabled("error")).toBe(true);
    log.setLevel("info");
  });
});
