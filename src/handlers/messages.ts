/**
 * POST /v1/messages — Anthropic Messages (stream + non-stream),
 * plus the POST /v1/messages/count_tokens stub.
 */

import type { AppDeps } from "../server.js";
import type { ChatToolChoice, GetChatMessageResponse } from "../proto.js";
import {
  anthropicToInternal,
  anthropicToolsToDevin,
  toDevinPrompts,
  stopReasonToAnthropic,
  type AnthropicMessage,
  type AnthropicTool,
} from "../convert.js";
import {
  DEVIN_REJECTED_CLAUDE_CLI_HOST_TOOLS,
  isClaudeCodeBoilerplateBlock,
  isClaudeCodeRequest,
  sanitizeAnthropicSystem,
} from "../sanitize.js";
import { sseResponse } from "../sse.js";
import { classifyUpstreamError, errorResponse, jsonResponse } from "../http.js";
import { effortLevelFromThinking } from "../models.js";
import { log } from "../log.js";

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | { type: string; text: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stop_sequences?: string[];
  thinking?: { type: string; budget_tokens?: number };
  effort?: string;
}

type Usage = GetChatMessageResponse["usage"] | undefined;

/** Map an Anthropic `tool_choice` value onto a Devin `ChatToolChoice`. */
function mapAnthropicToolChoice(choice: AnthropicRequest["tool_choice"]): ChatToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "any") return { optionName: choice.type };
  if (choice.type === "tool" && choice.name) return { toolName: choice.name };
  return undefined;
}

export async function handleAnthropicMessages(req: Request, deps: AppDeps, reqId: string): Promise<Response> {
  const body = (await req.json()) as AnthropicRequest;
  const modelUid = await deps.catalog.resolve(body.model, effortLevelFromThinking(body.thinking, body.effort));
  log.debug(`[messages ${reqId}] model=${body.model} uid=${modelUid} stream=${!!body.stream}`);

  const internal = anthropicToInternal(body.messages);
  const cascadeId = crypto.randomUUID();
  const prompts = toDevinPrompts(internal, cascadeId);
  const systemBlocks = Array.isArray(body.system) ? body.system.map((s) => s.text) : [];
  const boilerplateBlocks = systemBlocks.map(isClaudeCodeBoilerplateBlock);
  const rawSystemPrompt = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system)
      ? systemBlocks.filter((_text, index) => !boilerplateBlocks[index]).join("\n\n")
      : "";
  const systemPrompt = sanitizeAnthropicSystem(rawSystemPrompt);
  const claudeCliHostTools = isClaudeCodeRequest(req);
  const incomingTools = body.tools ?? [];
  const droppedClaudeCliTools = claudeCliHostTools
    ? incomingTools.filter((tool) => DEVIN_REJECTED_CLAUDE_CLI_HOST_TOOLS.has(tool.name)).map((tool) => tool.name)
    : [];
  const forwardedAnthropicTools = claudeCliHostTools
    ? incomingTools.filter((tool) => !DEVIN_REJECTED_CLAUDE_CLI_HOST_TOOLS.has(tool.name))
    : incomingTools;
  const tools = anthropicToolsToDevin(forwardedAnthropicTools);
  log.debug(`[messages ${reqId}] system normalized blocks=${systemBlocks.length} boilerplate=${boilerplateBlocks.join(",")} rawChars=${rawSystemPrompt.length} sanitizedChars=${systemPrompt.length} receivedTools=${incomingTools.length} forwardedTools=${tools.length} droppedClaudeCliTools=${droppedClaudeCliTools.join(",")} claudeCliHostTools=${claudeCliHostTools}`);
  const toolChoice = mapAnthropicToolChoice(body.tool_choice);
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const chatParams = {
    modelUid,
    systemPrompt,
    messages: prompts,
    tools,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
    cascadeId,
    toolChoice,
  };

  if (body.stream) {
    return sseResponse(req, async (send, signal) => {
      const slog = (msg: string) => log.debug(`[stream/messages ${reqId}] ${msg}`);
      let upstreamChunks = 0;

      try {
        send.event("message_start", {
          type: "message_start",
          message: {
            id: messageId, type: "message", role: "assistant", model: body.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        });

        let contentIndex = 0;
        let currentBlockType: "text" | "thinking" | null = null;
        let hasToolCalls = false;
        let stopReason = 0;
        let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
        const bufferedToolCalls: { id: string; name: string; argumentsJson: string }[] = [];

        const startBlock = (type: "text" | "thinking") => {
          currentBlockType = type;
          send.event("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
          });
        };

        const stopBlock = () => {
          if (currentBlockType) {
            send.event("content_block_stop", { type: "content_block_stop", index: contentIndex });
            contentIndex++;
            currentBlockType = null;
          }
        };

        const emitBufferedToolCalls = () => {
          stopBlock();
          for (const tc of bufferedToolCalls) {
            // A continuation fragment can be malformed or arrive without an
            // initial declaration. Never expose an unusable empty-name tool.
            if (!tc.name) {
              slog(`discarded incomplete tool-call fragment id=${tc.id || "(none)"}`);
              continue;
            }
            hasToolCalls = true;
            const toolId = tc.id || `toolu_${crypto.randomUUID().slice(0, 12)}`;
            send.event("content_block_start", {
              type: "content_block_start", index: contentIndex,
              content_block: { type: "tool_use", id: toolId, name: tc.name, input: {} },
            });
            send.event("content_block_delta", {
              type: "content_block_delta", index: contentIndex,
              delta: { type: "input_json_delta", partial_json: tc.argumentsJson || "{}" },
            });
            send.event("content_block_stop", { type: "content_block_stop", index: contentIndex });
            contentIndex++;
          }
        };

        for await (const ev of deps.upstream.streamChat({ ...chatParams, signal })) {
          upstreamChunks++;
          if (ev.type === "thinking" && ev.deltaThinking) {
            if (currentBlockType !== "thinking") {
              stopBlock();
              startBlock("thinking");
            }
            send.event("content_block_delta", {
              type: "content_block_delta", index: contentIndex,
              delta: { type: "thinking_delta", thinking: ev.deltaThinking },
            });
          } else if (ev.type === "text" && ev.deltaText) {
            if (currentBlockType !== "text") {
              stopBlock();
              startBlock("text");
            }
            send.event("content_block_delta", {
              type: "content_block_delta", index: contentIndex,
              delta: { type: "text_delta", text: ev.deltaText },
            });
          } else if (ev.type === "toolcall" && ev.toolCalls) {
            for (const tc of ev.toolCalls) {
              const existing = tc.id
                ? bufferedToolCalls.find((call) => call.id === tc.id)
                : bufferedToolCalls.at(-1);
              if (existing) {
                if (tc.name) existing.name = tc.name;
                existing.argumentsJson += tc.argumentsJson;
              } else if (tc.id || tc.name) {
                bufferedToolCalls.push({ id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson });
              } else {
                slog("discarded orphan tool-call continuation");
              }
            }
          } else if (ev.type === "usage" && ev.usage) {
            inputTokens = ev.usage.inputTokens;
            outputTokens = ev.usage.outputTokens;
            cacheReadTokens = ev.usage.cacheReadTokens;
            cacheWriteTokens = ev.usage.cacheWriteTokens;
          } else if (ev.type === "done") {
            stopReason = ev.stopReason ?? 0;
          } else if (ev.type === "error") {
            const cls = classifyUpstreamError(ev.error, ev.code);
            slog(`upstream error: ${ev.error}`);
            send.event("error", { type: "error", error: { type: cls.type, message: ev.error } });
          }
        }

        emitBufferedToolCalls();
        stopBlock();

        send.event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasonToAnthropic(stopReason, hasToolCalls), stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: cacheWriteTokens },
        });
        send.event("message_stop", { type: "message_stop" });
        slog(`done — upstream chunks: ${upstreamChunks}`);
      } catch (err) {
        if ((err as Error & { code?: string }).code === "aborted") {
          slog(`client aborted after upstream=${upstreamChunks}`);
          return;
        }
        const msg = String((err as Error).message ?? err);
        const cls = classifyUpstreamError(msg);
        log.error(`[stream/messages ${reqId}] exception after upstream=${upstreamChunks}:`, err);
        send.event("error", { type: "error", error: { type: cls.type, message: msg } });
      }
    });
  }

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
          if (existing) existing.arguments += tc.argumentsJson;
          else toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.argumentsJson });
        }
      } else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "done") stopReason = ev.stopReason ?? 0;
      else if (ev.type === "error") throw Object.assign(new Error(ev.error), { code: ev.code });
    }

    const hasToolCalls = toolCalls.length > 0;
    const content: unknown[] = [];
    if (thinking) content.push({ type: "thinking", thinking });
    if (text) content.push({ type: "text", text });
    if (hasToolCalls) {
      for (const tc of toolCalls) {
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(tc.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          log.warn(`[messages ${reqId}] malformed tool arguments for ${tc.name}, falling back to {}`);
        }
        content.push({
          type: "tool_use", id: tc.id || `toolu_${crypto.randomUUID().slice(0, 12)}`,
          name: tc.name, input,
        });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });

    return jsonResponse(req, {
      id: messageId,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: stopReasonToAnthropic(stopReason, hasToolCalls),
      stop_sequence: null,
      usage: usage ? {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
      } : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const cls = classifyUpstreamError(msg, (err as Error & { code?: string }).code);
    if ((err as Error & { code?: string }).code === "aborted") {
      log.debug(`[messages ${reqId}] client aborted`);
    } else {
      log.error(`[messages ${reqId}] non-stream failed:`, err);
    }
    return errorResponse(req, cls.status, msg, cls.type);
  }
}

/**
 * POST /v1/messages/count_tokens — stub estimator (~4 chars per token) over
 * system + message contents + serialized tools.
 */
export async function handleCountTokens(req: Request, _deps: AppDeps, _reqId: string): Promise<Response> {
  const body = (await req.json()) as AnthropicRequest;
  const systemChars = typeof body.system === "string"
    ? body.system.length
    : Array.isArray(body.system)
      ? body.system.reduce((n, b) => n + (b.text?.length ?? 0), 0)
      : 0;
  const messageChars = (body.messages ?? []).reduce((n, m) => {
    return n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length);
  }, 0);
  const toolChars = JSON.stringify(body.tools ?? []).length;
  return jsonResponse(req, { input_tokens: Math.ceil((systemChars + messageChars + toolChars) / 4) });
}
