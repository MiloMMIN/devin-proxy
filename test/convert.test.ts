import { describe, expect, test } from "bun:test";
import {
  anthropicToInternal,
  anthropicToolsToDevin,
  openaiToInternal,
  openaiToolsToDevin,
  responsesInputToOpenAI,
  stopReasonToAnthropic,
  stopReasonToOpenAI,
  toDevinPrompts,
} from "../src/convert.js";
import { ChatMessageSource, StopReason } from "../src/proto.js";

describe("openaiToInternal", () => {
  test("tool message → tool role with toolCallId", () => {
    const [m] = openaiToInternal([{ role: "tool", content: "result", tool_call_id: "call_1" }]);
    expect(m.role).toBe("tool");
    expect(m.content).toBe("result");
    expect(m.toolCallId).toBe("call_1");
  });

  test("assistant tool_calls → toolCalls with parsed arguments", () => {
    const [m] = openaiToInternal([{
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{\"x\":1}" } }],
    }]);
    expect(m.role).toBe("assistant");
    expect(m.toolCalls).toEqual([{ id: "c1", name: "fn", arguments: { x: 1 } }]);
  });

  test("malformed tool arguments degrade to {}", () => {
    const [m] = openaiToInternal([{
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{bad" } }],
    }]);
    expect(m.toolCalls![0].arguments).toEqual({});
  });

  test("image data URL → ImageData", () => {
    const [m] = openaiToInternal([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    }]);
    expect(m.content).toBe("look");
    expect(m.images).toEqual([{ mimeType: "image/png", base64Data: "QUJD" }]);
  });
});

describe("anthropicToInternal", () => {
  test("tool_result block becomes its own tool turn", () => {
    const out = anthropicToInternal([{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "done", is_error: true },
        { type: "text", text: "next" },
      ],
    }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "tool", content: "done", toolCallId: "tu_1", isError: true });
    expect(out[1]).toMatchObject({ role: "user", content: "next" });
  });

  test("thinking + tool_use + image blocks", () => {
    const [m] = anthropicToInternal([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tu_9", name: "bash", input: { cmd: "ls" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "SkZJRg==" } },
      ],
    }]);
    expect(m.role).toBe("assistant");
    expect(m.thinking).toBe("hmm");
    expect(m.content).toBe("answer");
    expect(m.toolCalls).toEqual([{ id: "tu_9", name: "bash", arguments: { cmd: "ls" } }]);
    expect(m.images).toEqual([{ mimeType: "image/jpeg", base64Data: "SkZJRg==" }]);
  });
});

describe("responsesInputToOpenAI", () => {
  test("string input → single user message", () => {
    expect(responsesInputToOpenAI("hello")).toEqual([{ role: "user", content: "hello" }]);
  });

  test("function_call → assistant tool_calls; function_call_output → tool", () => {
    const out = responsesInputToOpenAI([
      { type: "function_call", call_id: "fc1", name: "exec", arguments: "{\"c\":1}" },
      { type: "function_call_output", call_id: "fc1", output: "ok" },
    ]);
    expect(out[0].role).toBe("assistant");
    expect(out[0].tool_calls![0]).toEqual({
      id: "fc1", type: "function", function: { name: "exec", arguments: "{\"c\":1}" },
    });
    expect(out[1]).toEqual({ role: "tool", content: "ok", tool_call_id: "fc1" });
  });

  test("input_text / input_image parts map to chat content parts", () => {
    const [m] = responsesInputToOpenAI([{
      type: "message", role: "user",
      content: [
        { type: "input_text", text: "see" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ],
    }]);
    const parts = m.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]).toEqual({ type: "text", text: "see" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
  });
});

describe("toDevinPrompts", () => {
  test("source enums and stable messageIds", () => {
    const msgs = [
      { role: "user" as const, content: "u" },
      { role: "assistant" as const, content: "a" },
      { role: "tool" as const, content: "t", toolCallId: "tc" },
    ];
    const p1 = toDevinPrompts(msgs, "casc");
    const p2 = toDevinPrompts(msgs, "casc");
    expect(p1.map((p) => p.source)).toEqual([
      ChatMessageSource.USER, ChatMessageSource.SYSTEM, ChatMessageSource.TOOL,
    ]);
    expect(p1[0].messageId).toBe(p2[0].messageId); // deterministic
    expect(p1[1].messageId.startsWith("bot-")).toBe(true);
    expect(p1[2].toolCallId).toBe("tc");
    expect(p1[0].messageId).not.toBe(p1[2].messageId);
  });
});

describe("stop reason mapping", () => {
  test("openai", () => {
    expect(stopReasonToOpenAI(0, false)).toBe("stop");
    expect(stopReasonToOpenAI(StopReason.MAX_TOKENS, false)).toBe("length");
    expect(stopReasonToOpenAI(0, true)).toBe("tool_calls");
    expect(stopReasonToOpenAI(StopReason.FUNCTION_CALL, true)).toBe("tool_calls");
  });
  test("anthropic", () => {
    expect(stopReasonToAnthropic(0, false)).toBe("end_turn");
    expect(stopReasonToAnthropic(StopReason.MAX_TOKENS, false)).toBe("max_tokens");
    expect(stopReasonToAnthropic(0, true)).toBe("tool_use");
  });
});

describe("tool conversion", () => {
  test("openaiToolsToDevin skips non-function / dotted names", () => {
    const tools = openaiToolsToDevin([
      { type: "function", function: { name: "ok", description: "d", parameters: { type: "object" } } },
      { type: "function", function: { name: "functions.exec" } },
      { type: "web_search_preview", name: "web" },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("ok");
    expect(tools[0].jsonSchemaString).toBe("{\"type\":\"object\"}");
  });

  test("anthropicToolsToDevin", () => {
    const tools = anthropicToolsToDevin([{ name: "bash", description: "run", input_schema: { type: "object" } }]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "bash", strict: false });
  });
});
