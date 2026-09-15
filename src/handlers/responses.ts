/**
 * POST /v1/responses — OpenAI Responses API (stream + non-stream).
 */

import type { AppDeps } from "../server.js";
import type { GetChatMessageResponse } from "../proto.js";
import {
  extractSystemPrompt,
  openaiToInternal,
  openaiToolsToDevin,
  responsesInputToOpenAI,
  toDevinPrompts,
  type OpenAIMessage,
  type OpenAIResponsesInputItem,
  type OpenAITool,
} from "../convert.js";
import { isCodexRequest, sanitizeCodexInstructions } from "../sanitize.js";
import { sseResponse } from "../sse.js";
import { classifyUpstreamError, errorResponse, jsonResponse } from "../http.js";
import { log } from "../log.js";

interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponsesInputItem[];
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  tools?: OpenAITool[];
  reasoning?: { effort?: string };
  instructions?: string;
}

type Usage = GetChatMessageResponse["usage"] | undefined;

export async function handleResponses(req: Request, deps: AppDeps, reqId: string): Promise<Response> {
  const body = (await req.json()) as OpenAIResponsesRequest;
  const modelUid = deps.catalog.resolve(body.model);
  log.debug(`[responses ${reqId}] model=${body.model} uid=${modelUid} stream=${!!body.stream}`);

  // Convert Responses input items (including function-call turns) to the
  // internal OpenAI Chat Completions-compatible representation.
  const messages: OpenAIMessage[] = responsesInputToOpenAI(body.input);
  const sanitizedInstructions = sanitizeCodexInstructions(req, body.instructions);

  // instructions + system/developer input items feed systemPrompt only.
  const systemPrompt = [sanitizedInstructions, extractSystemPrompt(messages)]
    .filter(Boolean)
    .join("\n\n");
  const internal = openaiToInternal(messages.filter((m) => m.role !== "system" && m.role !== "developer"));

  const cascadeId = crypto.randomUUID();
  const prompts = toDevinPrompts(internal, cascadeId);
  // Codex's top-level `tools` array is a host-tool manifest (shell/MCP,
  // planning, image helpers, etc.), not a set of Devin function tools. Devin
  // validates these as MCP configuration and rejects the request. Genuine
  // Responses function tools from other clients remain supported.
  const tools = openaiToolsToDevin(isCodexRequest(req) ? [] : body.tools);
  log.debug(`[responses ${reqId}] inputItems=${Array.isArray(body.input) ? body.input.length : 1} prompts=${prompts.length} forwardedTools=${tools.map((t) => t.name).join(",")}`);

  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const chatParams = {
    modelUid,
    systemPrompt,
    messages: prompts,
    tools,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    cascadeId,
  };

  if (body.stream) {
    return sseResponse(req, async (send, signal) => {
      const slog = (msg: string) => log.debug(`[stream/responses ${reqId}] ${msg}`);
      let upstreamChunks = 0;

      try {
        send.event("response.created", {
          type: "response.created",
          response: { id: responseId, object: "response", created_at: created, model: body.model, status: "in_progress" },
        });

        const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const reasoningId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        let reasoningStarted = false;
        let messageStarted = false;
        let fullText = "";
        let outputIndex = 0;
        const outputItems: unknown[] = [];
        const toolCallStates = new Map<string, { id: string; name: string; arguments: string; outputIndex: number }>();
        let usage: Usage;

        const startMessage = () => {
          messageStarted = true;
          send.event("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { type: "message", id: messageId, status: "in_progress", role: "assistant", content: [] },
          });
          send.event("response.content_part.added", {
            type: "response.content_part.added",
            item_id: messageId, output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: "" },
          });
        };

        for await (const ev of deps.upstream.streamChat({ ...chatParams, signal })) {
          upstreamChunks++;
          if (ev.type === "thinking" && ev.deltaThinking) {
            // Forward reasoning as a summary_text part so thinking models keep
            // the SSE stream alive (Bun closes idle streams after idleTimeout).
            if (!reasoningStarted) {
              reasoningStarted = true;
              send.event("response.output_item.added", {
                type: "response.output_item.added",
                output_index: outputIndex,
                item: { type: "reasoning", id: reasoningId, status: "in_progress", summary: [] },
              });
            }
            send.event("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              item_id: reasoningId, output_index: outputIndex, delta: ev.deltaThinking,
            });
          } else if (ev.type === "text" && ev.deltaText) {
            if (reasoningStarted) {
              send.event("response.reasoning_summary_text.done", {
                type: "response.reasoning_summary_text.done",
                item_id: reasoningId, output_index: outputIndex,
              });
              send.event("response.output_item.done", {
                type: "response.output_item.done",
                output_index: outputIndex,
                item: { type: "reasoning", id: reasoningId, status: "completed", summary: [] },
              });
              outputItems.push({ type: "reasoning", id: reasoningId, status: "completed", summary: [] });
              reasoningStarted = false;
              outputIndex++;
            }
            if (!messageStarted) startMessage();
            fullText += ev.deltaText;
            send.event("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: messageId, output_index: outputIndex, content_index: 0, delta: ev.deltaText,
            });
          } else if (ev.type === "toolcall" && ev.toolCalls) {
            // Responses API represents tool calls as output items with a
            // separate arguments-delta stream. Close any preceding text item
            // before beginning function-call output.
            if (reasoningStarted) {
              send.event("response.reasoning_summary_text.done", {
                type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: outputIndex,
              });
              send.event("response.output_item.done", {
                type: "response.output_item.done", output_index: outputIndex,
                item: { type: "reasoning", id: reasoningId, status: "completed", summary: [] },
              });
              outputItems.push({ type: "reasoning", id: reasoningId, status: "completed", summary: [] });
              reasoningStarted = false;
              outputIndex++;
            }
            if (messageStarted) {
              send.event("response.content_part.done", {
                type: "response.content_part.done", item_id: messageId, output_index: outputIndex,
                content_index: 0, part: { type: "output_text", text: fullText },
              });
              send.event("response.output_item.done", {
                type: "response.output_item.done", output_index: outputIndex,
                item: { type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText }] },
              });
              outputItems.push({ type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText }] });
              messageStarted = false;
              outputIndex++;
            }
            for (const tc of ev.toolCalls) {
              const id = tc.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
              let state = toolCallStates.get(id);
              if (!state) {
                state = { id, name: tc.name, arguments: "", outputIndex };
                toolCallStates.set(id, state);
                send.event("response.output_item.added", {
                  type: "response.output_item.added", output_index: state.outputIndex,
                  item: { type: "function_call", id, call_id: id, name: tc.name, arguments: "", status: "in_progress" },
                });
                outputIndex++;
              }
              state.arguments += tc.argumentsJson ?? "";
              send.event("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta", item_id: id,
                output_index: state.outputIndex, delta: tc.argumentsJson ?? "",
              });
            }
          } else if (ev.type === "usage") {
            usage = ev.usage;
          } else if (ev.type === "error") {
            const cls = classifyUpstreamError(ev.error, ev.code);
            slog(`upstream error: ${ev.error}`);
            send.event("response.failed", { type: "response.failed", error: { message: ev.error, type: cls.type, code: cls.code } });
          }
        }
        slog(`done — upstream chunks: ${upstreamChunks}`);

        if (reasoningStarted) {
          send.event("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: { type: "reasoning", id: reasoningId, status: "completed", summary: [] },
          });
          outputItems.push({ type: "reasoning", id: reasoningId, status: "completed", summary: [] });
          outputIndex++;
        }

        if (messageStarted) {
          send.event("response.content_part.done", {
            type: "response.content_part.done",
            item_id: messageId, output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: fullText },
          });
          send.event("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: { type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText }] },
          });
          outputItems.push({ type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText }] });
        }

        for (const state of toolCallStates.values()) {
          send.event("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done", item_id: state.id,
            output_index: state.outputIndex, arguments: state.arguments || "{}",
          });
          const item = {
            type: "function_call", id: state.id, call_id: state.id, name: state.name,
            arguments: state.arguments || "{}", status: "completed",
          };
          send.event("response.output_item.done", {
            type: "response.output_item.done", output_index: state.outputIndex, item,
          });
          outputItems.push(item);
        }

        send.event("response.completed", {
          type: "response.completed",
          response: {
            id: responseId, object: "response", created_at: created, model: body.model, status: "completed", output: outputItems,
            usage: usage ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
              input_tokens_details: { cached_tokens: usage.cacheReadTokens },
            } : undefined,
          },
        });
      } catch (err) {
        if ((err as Error & { code?: string }).code === "aborted") {
          slog(`client aborted after upstream=${upstreamChunks}`);
          return;
        }
        const msg = String((err as Error).message ?? err);
        const cls = classifyUpstreamError(msg);
        log.error(`[stream/responses ${reqId}] exception after upstream=${upstreamChunks}:`, err);
        send.event("response.failed", { type: "response.failed", error: { message: msg, type: cls.type, code: cls.code } });
      }
    });
  }

  try {
    let text = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    let usage: Usage = null;

    for await (const ev of deps.upstream.streamChat({ ...chatParams, signal: req.signal })) {
      if (ev.type === "text") text += ev.deltaText;
      else if (ev.type === "toolcall" && ev.toolCalls) {
        for (const tc of ev.toolCalls) {
          const existing = toolCalls.find((t) => t.id === tc.id);
          // Live probe (2026-09-15): upstream emits complete-per-frame tool
          // calls; append is correct for both complete and fragmented frames.
          if (existing) existing.arguments += tc.argumentsJson;
          else toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.argumentsJson });
        }
      }
      else if (ev.type === "usage" && ev.usage) usage = ev.usage;
      else if (ev.type === "error") throw Object.assign(new Error(ev.error), { code: ev.code });
    }

    const output: unknown[] = [];
    if (text || toolCalls.length === 0) {
      output.push({
        type: "message",
        id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
    for (const tc of toolCalls) {
      const callId = tc.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      output.push({
        type: "function_call",
        id: callId,
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments || "{}",
        status: "completed",
      });
    }

    return jsonResponse(req, {
      id: responseId,
      object: "response",
      created_at: created,
      model: body.model,
      status: "completed",
      output,
      usage: usage ? {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        input_tokens_details: { cached_tokens: usage.cacheReadTokens },
      } : undefined,
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const cls = classifyUpstreamError(msg, (err as Error & { code?: string }).code);
    if ((err as Error & { code?: string }).code === "aborted") {
      log.debug(`[responses ${reqId}] client aborted`);
    } else {
      log.error(`[responses ${reqId}] non-stream failed:`, err);
    }
    return errorResponse(req, cls.status, msg, cls.type);
  }
}
