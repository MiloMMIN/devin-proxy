/**
 * Convert between OpenAI / Anthropic request formats and Devin's internal
 * ChatMessagePrompt representation, and convert Devin stream events back to
 * the appropriate response shapes.
 */

import {
  type ChatMessagePrompt,
  type ChatToolCall,
  type ChatToolDefinition,
  type ImageData,
  ChatMessageSource,
  StopReason,
} from "./proto.js";

// ─── Common internal message shape ───────────────────────────────────────────

export interface InternalMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  images?: ImageData[];
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  isError?: boolean;
  thinking?: string;
}

// ─── OpenAI → Internal ───────────────────────────────────────────────────────

export interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: string;
  /** Chat Completions tools nest the definition under `function`; Responses
   * tools use the flat shape (`name`, `description`, `parameters`). */
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Join all system/developer message contents into a single system prompt.
 * Each message's content may be a plain string or an array of text parts.
 */
export function extractSystemPrompt(messages: OpenAIMessage[]): string {
  return messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : extractOpenAIText(m.content)))
    .filter(Boolean)
    .join("\n\n");
}

export function openaiToInternal(messages: OpenAIMessage[]): InternalMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        toolCallId: msg.tool_call_id,
      };
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      const images = extractOpenAIImages(msg.content);
      return {
        role: "assistant",
        content: text,
        images,
        toolCalls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
        })),
      };
    }

    // user / system / developer
    const text = typeof msg.content === "string" ? msg.content : extractOpenAIText(msg.content);
    const images = extractOpenAIImages(msg.content);
    return { role: "user", content: text, images };
  });
}

function extractOpenAIText(content?: string | OpenAIContentPart[]): string {
  if (!content || typeof content === "string") return content ?? "";
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

function extractOpenAIImages(content?: string | OpenAIContentPart[]): ImageData[] {
  if (!content || typeof content === "string") return [];
  return content
    .filter((p) => p.type === "image_url" && p.image_url?.url)
    .map((p) => parseDataUrl(p.image_url!.url))
    .filter((img): img is ImageData => img !== null);
}

function parseDataUrl(url: string): ImageData | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
}

export function openaiToolsToDevin(tools?: OpenAITool[]): ChatToolDefinition[] {
  if (!tools) return [];
  return tools.flatMap((t) => {
    // Devin currently supports function tools. Responses built-ins (for
    // example `web_search_preview`) are deliberately ignored rather than
    // crashing the whole request when they do not carry a function name.
    const fn = t.function;
    const name = fn?.name ?? t.name;
    // Host-side MCP namespaces (for example `functions.exec`) are not valid
    // Devin function names. Forwarding one makes GetChatMessage fail with an
    // opaque invalid_argument/permission_denied error before generation.
    if (t.type !== "function" || !name || name.includes(".")) return [];
    return [{
      name,
      description: fn?.description ?? t.description ?? "",
      jsonSchemaString: JSON.stringify(fn?.parameters ?? t.parameters ?? { type: "object" }),
      strict: false,
    }];
  });
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Upstream models can occasionally emit a truncated argument fragment.
    // Keep the turn processable so the client receives a normal tool result
    // instead of a gateway-wide 500; the malformed call is treated as empty.
    return {};
  }
}

/** A Responses API input item, including function-call turns emitted by Codex. */
export interface OpenAIResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | unknown[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
  tools?: unknown[];
}

/** Convert Responses `input` items into the Chat Completions message shape. */
export function responsesInputToOpenAI(
  input: string | OpenAIResponsesInputItem[],
): OpenAIMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages: OpenAIMessage[] = [];
  for (const item of input) {
    if (item.type === "function_call") {
      const id = item.call_id ?? item.id ?? "";
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id,
          type: "function",
          function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      messages.push({ role: "tool", content: output, tool_call_id: item.call_id });
      continue;
    }

    const role = item.role ?? (item.type === "message" ? "user" : "user");
    const content = typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part) => {
          const p = part as Record<string, unknown>;
          if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
            return { type: "text", text: typeof p.text === "string" ? p.text : "" };
          }
          if (p.type === "input_image") {
            const imageUrl = typeof p.image_url === "string"
              ? p.image_url
              : typeof p.image_url === "object" && p.image_url
                ? (p.image_url as { url?: string }).url
                : undefined;
            return imageUrl ? { type: "image_url", image_url: { url: imageUrl } } : p;
          }
          return p;
        })
        : undefined;
    messages.push({ role, content: content as OpenAIMessage["content"] });
  }
  return messages;
}

// ─── Anthropic → Internal ────────────────────────────────────────────────────

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: { type: string; media_type: string; data: string };
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export function anthropicToInternal(messages: AnthropicMessage[]): InternalMessage[] {
  const result: InternalMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }

    // Group tool_result blocks into tool messages
    const blocks = msg.content;
    let textBuf = "";
    let thinkingBuf = "";
    const toolCalls: NonNullable<InternalMessage["toolCalls"]> = [];
    const images: ImageData[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          textBuf += block.text ?? "";
          break;
        case "thinking":
          thinkingBuf += block.thinking ?? "";
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: block.input ?? {},
          });
          break;
        case "tool_result": {
          const resultText = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
              : "";
          result.push({
            role: "tool",
            content: resultText,
            toolCallId: block.tool_use_id,
            isError: block.is_error,
          });
          break;
        }
        case "image":
          if (block.source?.type === "base64") {
            images.push({ mimeType: block.source.media_type, base64Data: block.source.data });
          }
          break;
      }
    }

    if (textBuf || thinkingBuf || toolCalls.length > 0 || images.length > 0) {
      result.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: textBuf,
        thinking: thinkingBuf || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        images: images.length > 0 ? images : undefined,
      });
    }
  }
  return result;
}

export function anthropicToolsToDevin(tools?: AnthropicTool[]): ChatToolDefinition[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    jsonSchemaString: JSON.stringify(t.input_schema ?? { type: "object" }),
    strict: false,
  }));
}

// ─── Internal → Devin ChatMessagePrompt ──────────────────────────────────────

export function toDevinPrompts(messages: InternalMessage[], cascadeId: string): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, msg] of messages.entries()) {
    const messageId = deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`);
    if (msg.role === "user") {
      prompts.push({
        messageId,
        source: ChatMessageSource.USER,
        prompt: msg.content,
        images: msg.images,
      });
    } else if (msg.role === "assistant") {
      prompts.push({
        messageId: `bot-${messageId}`,
        source: ChatMessageSource.SYSTEM,
        prompt: msg.content,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          argumentsJson: JSON.stringify(tc.arguments),
        })),
      });
    } else {
      prompts.push({
        messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId ?? ""}`),
        source: ChatMessageSource.TOOL,
        toolCallId: msg.toolCallId,
        toolResultIsError: msg.isError,
        prompt: msg.content,
        images: msg.images,
      });
    }
  }
  return prompts;
}

function deterministicUuid(seed: string): string {
  // Simple deterministic ID from seed (not a real UUID, but stable)
  let h1 = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-0000-0000-000000000000`;
}

// ─── Stop reason mapping ─────────────────────────────────────────────────────

export function stopReasonToOpenAI(reason: number, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (reason === StopReason.MAX_TOKENS) return "length";
  return "stop";
}

export function stopReasonToAnthropic(reason: number, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  if (reason === StopReason.MAX_TOKENS) return "max_tokens";
  return "end_turn";
}
