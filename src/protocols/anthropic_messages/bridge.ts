import { GatewayFailureError } from "../../gateway/failures.js";
import type { ChatResponse } from "../chat_completions/types.js";
import { asRecord, normalizeToolId, positiveInteger } from "./common.js";

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const object = asRecord(parsed);
    if (object === undefined) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return object;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}
export function convertChatResponse(response: ChatResponse): unknown {
  const payload = parseJsonObject(response.body);
  const choices = Array.isArray(payload.choices) ? payload.choices : undefined;
  if (choices === undefined || choices.length === 0) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const content: unknown[] = [];
  for (const choice of choices) {
    if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
      continue;
    }
    appendChoiceContent(content, choice as Record<string, unknown>);
  }
  return {
    id: typeof payload.id === "string" ? payload.id : "",
    type: "message",
    role: "assistant",
    model: typeof payload.model === "string" ? payload.model : "unknown-model",
    content,
    stop_reason: anthropicStopReason((choices[0] as Record<string, unknown>).finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(payload.usage),
  };
}

function appendChoiceContent(content: unknown[], choice: Record<string, unknown>): void {
  const message = choice.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return;
  }
  const record = message as Record<string, unknown>;
  const thinkingBlocks = Array.isArray(record.thinking_blocks) ? record.thinking_blocks : undefined;
  if (thinkingBlocks !== undefined && thinkingBlocks.length > 0) {
    for (const block of thinkingBlocks) {
      appendThinkingBlock(content, block);
    }
  } else if (typeof record.reasoning_content === "string" && record.reasoning_content.length > 0) {
    content.push({ type: "thinking", thinking: record.reasoning_content, signature: null });
  }
  if (record.content !== null && record.content !== undefined) {
    content.push({ type: "text", text: String(record.content) });
  }
  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      content.push(convertChatToolCall(toolCall));
    }
  }
}

function appendThinkingBlock(content: unknown[], block: unknown): void {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return;
  }
  const record = block as Record<string, unknown>;
  if (record.type === "redacted_thinking") {
    content.push({ type: "redacted_thinking", data: typeof record.data === "string" ? record.data : "" });
    return;
  }
  if (record.type === "thinking" && typeof record.thinking === "string" && record.thinking.trim().length > 0) {
    content.push({
      type: "thinking",
      thinking: record.thinking,
      signature: typeof record.signature === "string" ? record.signature : null,
    });
  }
}

function convertChatToolCall(value: unknown): unknown {
  const outer = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const fn = outer.function !== null && typeof outer.function === "object" && !Array.isArray(outer.function)
    ? outer.function as Record<string, unknown>
    : {};
  const rawId = typeof outer.id === "string" ? outer.id : "";
  const block: Record<string, unknown> = {
    type: "tool_use",
    id: normalizeToolId(rawId).id,
    name: typeof fn.name === "string" ? fn.name : "",
    input: parseToolArguments(typeof fn.arguments === "string" ? fn.arguments : ""),
  };
  const signature = typeof outer.thought_signature === "string" && outer.thought_signature.length > 0
    ? outer.thought_signature
    : typeof fn.thought_signature === "string" && fn.thought_signature.length > 0
      ? fn.thought_signature
      : undefined;
  if (signature !== undefined) {
    block.provider_specific_fields = { signature };
  }
  return block;
}

function parseToolArguments(value: string): unknown {
  if (value.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (_error: unknown) {
    const repaired = repairJson(value);
    if (repaired === undefined) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    try {
      return JSON.parse(repaired) as unknown;
    } catch (error: unknown) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
    }
  }
}

function repairJson(value: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
    }
  }
  if (inString || stack.length === 0) {
    return undefined;
  }
  let repaired = value.replace(/,\s*$/u, "").replace(/,\s*([}\]])/gu, "$1");
  while (stack.length > 0) {
    const opener = stack.pop();
    repaired += opener === "{" ? "}" : "]";
  }
  return repaired;
}

export function anthropicStopReason(value: unknown): "end_turn" | "max_tokens" | "tool_use" {
  if (value === "length") {
    return "max_tokens";
  }
  if (value === "tool_calls") {
    return "tool_use";
  }
  return "end_turn";
}

export function anthropicUsage(value: unknown): Record<string, unknown> {
  const usage = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const details = usage.prompt_tokens_details !== null
    && typeof usage.prompt_tokens_details === "object"
    && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const cacheRead = positiveInteger(usage.cache_read_input_tokens)
    ?? positiveInteger(usage._cache_read_input_tokens)
    ?? positiveInteger(details.cached_tokens)
    ?? 0;
  const cacheCreation = positiveInteger(usage.cache_creation_input_tokens)
    ?? positiveInteger(usage._cache_creation_input_tokens)
    ?? positiveInteger(details.cache_creation_tokens)
    ?? positiveInteger(details.cache_write_tokens)
    ?? 0;
  const promptTokens = positiveInteger(usage.prompt_tokens) ?? 0;
  const completionTokens = positiveInteger(usage.completion_tokens) ?? 0;
  const result: Record<string, unknown> = {
    input_tokens: Math.max(0, promptTokens - cacheRead - cacheCreation),
    output_tokens: completionTokens,
  };
  if (cacheRead > 0) {
    result.cache_read_input_tokens = cacheRead;
  }
  if (cacheCreation > 0) {
    result.cache_creation_input_tokens = cacheCreation;
  }
  const webSearch = positiveInteger(details.web_search_requests);
  if (webSearch !== undefined) {
    result.server_tool_use = { web_search_requests: webSearch };
  }
  return result;
}
