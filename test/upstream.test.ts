import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { ProtoDecoder, ProtoEncoder } from "../src/proto.js";
import { createUpstreamClient } from "../src/upstream.js";
import type { TokenProvider } from "../src/token.js";

const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

const fakeJwt =
  "h." +
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url") +
  ".s";

/** Decode a request body and return the Metadata sub-message's wire-2 fields. */
function decodeMetadataFields(body: Uint8Array): Map<number, string> {
  const fields = new Map<number, string>();
  const d = new ProtoDecoder(body);
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 1 && wire === 2) {
      const sub = new ProtoDecoder(d.readBytes());
      while (!sub.done) {
        const t = sub.readTag();
        if (t.wire === 2) fields.set(t.field, sub.readString());
        else sub.skip(t.wire);
      }
    } else {
      d.skip(wire);
    }
  }
  return fields;
}

function connectFrame(flag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flag;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

describe("upstream client sends ide_type=chisel", () => {
  let server: ReturnType<typeof Bun.serve>;
  const metadataSeen: Record<string, Map<number, string>> = {};

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = new Uint8Array(await req.arrayBuffer());

        if (path === AUTH_PATH) {
          metadataSeen[AUTH_PATH] = decodeMetadataFields(body);
          const enc = new ProtoEncoder();
          enc.string(1, fakeJwt);
          return new Response(enc.finish(), { headers: { "content-type": "application/proto" } });
        }

        if (path === CHAT_PATH) {
          const flag = body[0];
          const len = new DataView(body.buffer, body.byteOffset).getUint32(1);
          let payload = body.subarray(5, 5 + len);
          if (flag & 1) payload = gunzipSync(payload);
          metadataSeen[CHAT_PATH] = decodeMetadataFields(payload);
          const delta = new ProtoEncoder();
          delta.string(3, "OK"); // field 3 = deltaText
          const stream = new Uint8Array([
            ...connectFrame(0, delta.finish()),
            ...connectFrame(0x02, new TextEncoder().encode("{}")),
          ]);
          return new Response(stream, { headers: { "content-type": "application/connect+proto" } });
        }

        if (path === CONFIGS_PATH) {
          metadataSeen[CONFIGS_PATH] = decodeMetadataFields(body);
          return new Response(new Uint8Array(0), { headers: { "content-type": "application/proto" } });
        }

        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function makeClient() {
    const tokens: TokenProvider = {
      get: async () => ({ token: "devin-session-token$fake", source: "env", detail: "DEVIN_API_KEY" }),
      invalidate() {},
    };
    return createUpstreamClient({ tokens, baseUrl: `http://127.0.0.1:${server.port}` });
  }

  test("streamChat metadata carries ide_type on GetUserJwt and GetChatMessage", async () => {
    let text = "";
    for await (const ev of makeClient().streamChat({
      modelUid: "gpt-5-6-sol-medium",
      systemPrompt: "",
      messages: [{ messageId: "m1", source: 1, prompt: "hi" }],
      tools: [],
    })) {
      if (ev.type === "text") text += ev.deltaText;
    }
    expect(text).toBe("OK");

    expect(metadataSeen[AUTH_PATH].get(1)).toBe("windsurf");
    expect(metadataSeen[AUTH_PATH].get(28)).toBe("chisel");
    expect(metadataSeen[CHAT_PATH].get(1)).toBe("windsurf");
    expect(metadataSeen[CHAT_PATH].get(28)).toBe("chisel");
    expect(metadataSeen[CHAT_PATH].get(21)).toBe(fakeJwt);
  });

  test("discoverModels metadata carries ide_type on GetCliModelConfigs", async () => {
    const models = await makeClient().discoverModels();
    expect(models).toEqual([]);
    expect(metadataSeen[CONFIGS_PATH].get(28)).toBe("chisel");
  });
});
