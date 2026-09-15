import { describe, expect, test } from "bun:test";
import {
  ChatMessageRequestType,
  ProtoDecoder,
  ProtoEncoder,
  decodeGetChatMessageResponse,
  encodeGetChatMessageRequest,
  type GetChatMessageRequest,
} from "../src/proto.js";

describe("ProtoEncoder/ProtoDecoder roundtrip", () => {
  test("string, uint32, uint64 (large), bool, double, nested message, repeated", () => {
    const enc = new ProtoEncoder();
    enc.string(1, "hello");
    enc.uint32(2, 42);
    enc.uint64(3, 18446744073709551615n); // max uint64
    enc.bool(4, true);
    enc.double(5, 3.25);
    enc.message(6, (e) => e.string(1, "nested"));
    enc.repeatedString(7, ["a", "b", "c"]);
    enc.repeatedMessage(8, [1, 2], (e, v) => e.uint32(1, v));
    const bytes = enc.finish();

    const d = new ProtoDecoder(bytes);
    const seen: Record<number, unknown> = {};
    const repeatedStrings: string[] = [];
    const repeatedNums: number[] = [];
    while (!d.done) {
      const { field, wire } = d.readTag();
      switch (field) {
        case 1: seen[1] = d.readString(); break;
        case 2: seen[2] = Number(d.readVarint()); break;
        case 3: seen[3] = d.readVarint(); break;
        case 4: seen[4] = d.readVarint() !== 0n; break;
        case 5: seen[5] = d.readDouble(); break;
        case 6: seen[6] = d.readMessage((sub) => { sub.readTag(); return sub.readString(); }); break;
        case 7: repeatedStrings.push(d.readString()); break;
        case 8: repeatedNums.push(d.readMessage((sub) => { sub.readTag(); return Number(sub.readVarint()); })); break;
        default: d.skip(wire);
      }
    }

    expect(seen[1]).toBe("hello");
    expect(seen[2]).toBe(42);
    expect(seen[3]).toBe(18446744073709551615n);
    expect(seen[4]).toBe(true);
    expect(seen[5]).toBe(3.25);
    expect(seen[6]).toBe("nested");
    expect(repeatedStrings).toEqual(["a", "b", "c"]);
    expect(repeatedNums).toEqual([1, 2]);
  });

  test("zero-valued scalars are omitted", () => {
    const enc = new ProtoEncoder();
    enc.string(1, "");
    enc.uint32(2, 0);
    enc.bool(3, false);
    enc.double(4, 0);
    expect(enc.finish().length).toBe(0);
  });
});

describe("encodeGetChatMessageRequest", () => {
  test("encodes prompt, model uid, request type, cascadeId", () => {
    const req: GetChatMessageRequest = {
      metadata: {
        ideName: "windsurf", ideVersion: "3.2.23", extensionName: "windsurf",
        extensionVersion: "1.48.2", apiKey: "tok", locale: "en", userJwt: "jwt",
      },
      prompt: "SYS-PROMPT",
      chatMessagePrompts: [{ messageId: "m1", source: 1, prompt: "hi" }],
      chatModelUid: "glm-5-2-none",
      configuration: {
        numCompletions: 1n, maxTokens: 32n, maxNewlines: 200n,
        temperature: 0.4, firstTemperature: 0.4, topK: 50n, topP: 1,
        stopPatterns: [], fimEotProbThreshold: 1,
      },
      tools: [],
      disableParallelToolCalls: true,
      toolChoice: { optionName: "auto" },
      cascadeId: "cascade-123",
      executionId: "exec-456",
    };
    const bytes = encodeGetChatMessageRequest(req);
    const d = new ProtoDecoder(bytes);
    const fields = new Map<number, unknown>();
    while (!d.done) {
      const { field, wire } = d.readTag();
      if (wire === 2) fields.set(field, d.readString());
      else if (wire === 0) fields.set(field, Number(d.readVarint()));
      else d.skip(wire);
    }
    expect(fields.get(2)).toBe("SYS-PROMPT");            // field 2 = prompt
    expect(fields.get(21)).toBe("glm-5-2-none");         // field 21 = chatModelUid
    expect(fields.get(7)).toBe(ChatMessageRequestType.CASCADE); // field 7 = 5
    expect(fields.get(16)).toBe("cascade-123");          // field 16 = cascadeId
    expect(fields.get(22)).toBe("exec-456");             // field 22 = executionId
    expect(fields.get(11)).toBe(1);                      // disableParallelToolCalls
  });
});

describe("decodeGetChatMessageResponse", () => {
  test("decodes deltaText, toolcall, usage, thinking, stopReason", () => {
    const enc = new ProtoEncoder();
    enc.string(1, "msg-1");
    enc.string(3, "delta text");
    enc.uint64(5, 3n); // StopReason.MAX_TOKENS
    enc.message(6, (e) => {
      e.string(1, "call-1");
      e.string(2, "my_tool");
      e.string(3, "{\"a\":1}");
    });
    enc.message(7, (e) => {
      e.uint64(2, 100n);
      e.uint64(3, 25n);
      e.uint64(4, 10n);
      e.uint64(5, 60n);
    });
    enc.string(9, "thinking…");
    const res = decodeGetChatMessageResponse(enc.finish());

    expect(res.messageId).toBe("msg-1");
    expect(res.deltaText).toBe("delta text");
    expect(res.stopReason).toBe(3);
    expect(res.deltaToolCalls).toHaveLength(1);
    expect(res.deltaToolCalls[0].id).toBe("call-1");
    expect(res.deltaToolCalls[0].name).toBe("my_tool");
    expect(res.deltaToolCalls[0].argumentsJson).toBe("{\"a\":1}");
    expect(res.usage).not.toBeNull();
    expect(res.usage!.inputTokens).toBe(100);
    expect(res.usage!.outputTokens).toBe(25);
    expect(res.usage!.cacheWriteTokens).toBe(10);
    expect(res.usage!.cacheReadTokens).toBe(60);
    expect(res.deltaThinking).toBe("thinking…");
  });
});
