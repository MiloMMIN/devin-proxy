/**
 * Wrap a streaming handler's frame production into a text/event-stream
 * Response. Shared by the chat / responses / messages streaming handlers.
 *
 * The `signal` handed to `run` aborts when the client disconnects (the stream
 * is cancelled), letting handlers stop the upstream call instead of burning
 * quota on a dead connection. Once closed, `send` becomes a no-op.
 */

import { corsHeaders } from "./http.js";

export interface SseSender {
  /** Emit `data: <json>` (OpenAI Chat Completions style). */
  data(obj: unknown): void;
  /** Emit `event: <name>` + `data: <json>` (Responses / Anthropic style). */
  event(name: string, obj: unknown): void;
  /** Emit a raw frame body, e.g. `data: [DONE]`. */
  raw(text: string): void;
}

export function sseResponse(req: Request, run: (send: SseSender, signal: AbortSignal) => Promise<void>): Response {
  const aborter = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const send: SseSender = {
        data: (obj) => enqueue(`data: ${JSON.stringify(obj)}\n\n`),
        event: (name, obj) => enqueue(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`),
        raw: (text) => enqueue(`${text}\n\n`),
      };
      try {
        await run(send, aborter.signal);
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch { /* already closed/errored */ }
        }
      }
    },
    cancel() {
      closed = true;
      aborter.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...corsHeaders(req),
    },
  });
}
