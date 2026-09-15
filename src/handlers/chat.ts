/**
 * POST /v1/chat/completions — OpenAI Chat Completions (stream + non-stream).
 */

import type { AppDeps } from "../server.js";
import type { ChatToolChoice, GetChatMessageResponse } from "../proto.js";
import {
  extractSystemPrompt,
  openaiToInternal,
  openaiToolsToDevin,
  toDevinPrompts,
  stopReasonToOpenAI,
  type OpenAIMessage,
  type OpenAITool,
} from "../convert.js";
import { sseResponse } from "../sse.js";
import { classifyUpstreamError, errorResponse, jsonResponse } from "../http.js";
import { log } from "../log.js";

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  stop?: string | string[];
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
}

type Usage = GetChatMessageResponse["usage"] | undefined;

/** Map an OpenAI `tool_choice` value onto a Devin `ChatToolChoice`. */
function mapOpenAIToolChoice(choice: OpenAIChatRequest["tool_choice"]): ChatToolChoice | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    // "auto" | "none" | "required" → optionName; Devin recognises "auto".
    return { optionName: choice === "required" ? "any" : choice };
  }
  if (choice.type === "function" && choice.function?.name) {
    return { toolName: choice.function.name };
  }
  return undefined;
}

export async function handleChatCompletions(req: Request, deps: AppDeps, reqId: string): Promise<Response> {
  const body = (await req.json()) as OpenAIChatRequest;
  const modelUid = deps.catalog.resolve(body.model);
  log.debug(`[chat/completions ${reqId}] model=${body.model} uid=${modelUid} stream=${!!body.stream}`);

  const cascadeId = crypto.randomUUID();
  const systemPrompt = extractSystemPrompt(body.messages);
  // system/developer messages feed systemPrompt only — they are not user turns.
  const internal = openaiToInternal(body.messages.filter((m) => m.role !== "system" && m.role !== "developer"));
  const prompts = toDevinPrompts(internal, cascadeId);
  const tools = openaiToolsToDevin(body.tools);
  const toolChoice = mapOpenAIToolChoice(body.tool_choice);
  const stop = Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : undefined;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;

  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const chatParams = {
    modelUid,
    systemPrompt,
    messages: prompts,
    tools,
    maxTokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: stop,
    cascadeId,
    toolChoice,
  };

  if (body.stream) {
    return sseResponse(req, async (send, signal) => {
      let upstreamChunks = 0;
      let sentChunks = 0;
      const slog = (msg: string) => log.debug(`[stream/chat ${reqId}] ${msg}`);

      try {
        // Initial role chunk
        send.data({
          id: completionId, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        sentChunks++;

        let hasToolCalls = false;
        let stopReason = 0;
        let usage: Usage;
        // OpenAI tool_calls deltas are merged by `index`: the first delta for a
        // call carries id+type+name, continuations carry only arguments.
        const toolCallIndexes = new Map<string, number>();
        let lastToolCallIndex = -1;

        for await (const ev of deps.upstream.streamChat({ ...chatParams, signal })) {
          upstreamChunks++;
          if (ev.type === "text" && ev.deltaText) {
            send.data({
              id: completionId, object: "chat.completion.chunk", created, model: body.model,
              choices: [{ index: 0, delta: { content: ev.deltaText }, finish_reason: null }],
            });
            sentChunks++;
          } else if (ev.type === "thinking" && ev.deltaThinking) {
            // Forward reasoning tokens as reasoning_content so thinking models
            // keep the SSE stream alive while reasoning (Bun closes idle
            // streaming connections after idleTimeout seconds of silence).
            send.data({
              id: completionId, object: "chat.completion.chunk", created, model: body.model,
              choices: [{ index: 0, delta: { reasoning_content: ev.deltaThinking }, finish_reason: null }],
            });
            sentChunks++;
          } else if (ev.type === "toolcall" && ev.toolCalls) {
            hasToolCalls = true;
            for (const tc of ev.toolCalls) {
              let index: number;
              let firstDelta: boolean;
              if (tc.id) {
                const known = toolCallIndexes.get(tc.id);
                if (known === undefined) {
                  index = toolCallIndexes.size;
                  toolCallIndexes.set(tc.id, index);
                  firstDelta = true;
                } else {
                  index = known;
                  firstDelta = false;
                }
              } else {
                // Id-less fragment: continue the most recent index.
                index = lastToolCallIndex >= 0 ? lastToolCallIndex : 0;
                firstDelta = false;
              }
              lastToolCallIndex = index;
              send.data({
                id: completionId, object: "chat.completion.chunk", created, model: body.model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [firstDelta
                      ? { index, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.argumentsJson } }
                      : { index, function: { arguments: tc.argumentsJson } }],
                  },
                  finish_reason: null,
                }],
              });
              sentChunks++;
            }
          } else if (ev.type === "usage") {
            usage = ev.usage;
          } else if (ev.type === "done") {
            stopReason = ev.stopReason ?? 0;
          } else if (ev.type === "error") {
            const cls = classifyUpstreamError(ev.error, ev.code);
            send.data({ error: { message: ev.error, type: cls.type, code: cls.code } });
            sentChunks++;
            slog(`upstream error: ${ev.error}`);
          }
        }
        send.data({
          id: completionId, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: stopReasonToOpenAI(stopReason, hasToolCalls) }],
        });
        sentChunks++;
        if (body.stream_options?.include_usage) {
          send.data({
            id: completionId, object: "chat.completion.chunk", created, model: body.model,
            choices: [],
            usage: usage ? {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
              prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
            } : undefined,
          });
          sentChunks++;
        }
        send.raw("data: [DONE]");
        slog(`done — upstream chunks: ${upstreamChunks}, client chunks: ${sentChunks}`);
      } catch (err) {
        if ((err as Error & { code?: string }).code === "aborted") {
          slog(`client aborted after upstream=${upstreamChunks} client=${sentChunks}`);
          return;
        }
        const cls = classifyUpstreamError(String((err as Error).message ?? err));
        send.data({ error: { message: String((err as Error).message ?? err), type: cls.type, code: cls.code } });
        sentChunks++;
        log.error(`[stream/chat ${reqId}] exception after upstream=${upstreamChunks} client=${sentChunks}:`, err);
      }
    });
  }

  // Non-streaming: collect all events
  try {
    let text = "";
    let thinking = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    let stopReason = 0;
    let usage: Usage;

    for await (const ev of deps.upstream.streamChat({ ...chatParams, signal: req.signal })) {
      if (ev.type === "text") text += ev.deltaText;
      else if (ev.type === "thinking") thinking += ev.deltaThinking;
      else if (ev.type === "toolcall" && ev.toolCalls) {
        for (const tc of ev.toolCalls) {
          const existing = toolCalls.find((t) => t.id === tc.id);
          // Live probe (2026-09-15): upstream emits complete-per-frame tool
          // calls; append is correct for both complete and fragmented frames.
          if (existing) {
            existing.arguments += tc.argumentsJson;
          } else {
            toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.argumentsJson });
          }
        }
      } else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "done") stopReason = ev.stopReason ?? 0;
      else if (ev.type === "error") throw Object.assign(new Error(ev.error), { code: ev.code });
    }

    const hasToolCalls = toolCalls.length > 0;
    const message: Record<string, unknown> = {
      role: "assistant",
      content: text || null,
    };
    if (thinking) message.reasoning_content = thinking;
    if (hasToolCalls) {
      message.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));
    }

    return jsonResponse(req, {
      id: completionId,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{
        index: 0,
        message,
        finish_reason: stopReasonToOpenAI(stopReason, hasToolCalls),
      }],
      usage: usage ? {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      } : undefined,
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const cls = classifyUpstreamError(msg, (err as Error & { code?: string }).code);
    if ((err as Error & { code?: string }).code === "aborted") {
      log.debug(`[chat/completions ${reqId}] client aborted`);
    } else {
      log.error(`[chat/completions ${reqId}] non-stream failed:`, err);
    }
    return errorResponse(req, cls.status, msg, cls.type);
  }
}
