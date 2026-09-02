import { GatewayFailureError } from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { ollamaCreatedAt } from "./wire.js";

export type OllamaTokenCounter = (
  input: { readonly model: ""; readonly messages?: WireJsonArray; readonly text?: string },
) => number;

export function ollamaNonstreamResponse(
  body: Uint8Array,
  model: string,
  chatMessages: WireJsonArray,
  maxBytes: number,
  now: () => Date,
  tokenCounter: OllamaTokenCounter,
): Record<string, unknown> {
  const root = parseUpstreamObject(body, maxBytes);
  const choice = selectedChoice(root);
  const message = memberValues(choice, "message")[0];
  if (!isWireJsonObject(message)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const reduced = reduceMessage(message);
  const toolCalls = toolCallsFromMessage(message);
  const doneReason = doneReasonFromChoice(choice, toolCalls.length);
  const usage = usageCounts(root, chatMessages, reduced.content, tokenCounter);
  const logprobs = logprobsFromChoice(choice);
  return {
    model,
    created_at: createdAtFromUpstream(root, now),
    message: {
      role: "assistant",
      content: reduced.content,
      ...(reduced.thinking === undefined || reduced.thinking.length === 0 ? {} : { thinking: reduced.thinking }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    },
    done: true,
    done_reason: doneReason,
    ...(logprobs === undefined || logprobs.length === 0 ? {} : { logprobs }),
    ...(usage.promptEvalCount === 0 ? {} : { prompt_eval_count: usage.promptEvalCount }),
    ...(usage.evalCount === 0 ? {} : { eval_count: usage.evalCount }),
  };
}

function parseUpstreamObject(body: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const value = parseWireJson(body, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(value)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function selectedChoice(root: WireJsonObject): WireJsonObject {
  const choices = memberValues(root, "choices")[0];
  if (!isWireJsonArray(choices)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const selected = choices.items.filter((choice): choice is WireJsonObject => {
    if (!isWireJsonObject(choice)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    const index = memberValues(choice, "index")[0];
    return isWireJsonNumber(index) && index.lexeme === "0";
  });
  if (selected.length !== 1) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return selected[0] as WireJsonObject;
}

function reduceMessage(message: WireJsonObject): { readonly content: string; readonly thinking?: string } {
  const rawContent = memberValues(message, "content")[0];
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const content = rawContent ?? "";
  const explicitReasoningContent = memberValues(message, "reasoning_content");
  if (explicitReasoningContent.length > 0) {
    return { content, ...thinkingFromExplicit(explicitReasoningContent[0]) };
  }
  const explicitReasoning = memberValues(message, "reasoning");
  if (explicitReasoning.length > 0) {
    return { content, ...thinkingFromExplicit(explicitReasoning[0]) };
  }
  const extracted = /^(?:<think>|<thinking>|<budget:thinking>)([\s\S]*)(?:<\/think>|<\/thinking>|<\/budget:thinking>)([\s\S]*)$/u.exec(content);
  if (extracted !== null && extracted[1] !== undefined && extracted[2] !== undefined) {
    return { thinking: extracted[1], content: extracted[2] };
  }
  return { content };
}

function thinkingFromExplicit(value: WireJson | undefined): { readonly thinking?: string } {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return { thinking: value };
}

function toolCallsFromMessage(message: WireJsonObject): Array<Record<string, unknown>> {
  const calls = memberValues(message, "tool_calls")[0];
  if (calls === undefined) {
    return [];
  }
  if (!isWireJsonArray(calls)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return calls.items.map((call, position) => toolCallFromChat(call, position));
}

function toolCallFromChat(value: WireJson, position: number): Record<string, unknown> {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const id = memberValues(value, "id")[0];
  const index = memberValues(value, "index")[0];
  const fn = memberValues(value, "function")[0];
  if (id !== undefined && typeof id !== "string") {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  if (index !== undefined && !isIntegerInRange(index, 0, Number.MAX_SAFE_INTEGER)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  if (!isWireJsonObject(fn)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const name = memberValues(fn, "name")[0];
  const args = memberValues(fn, "arguments")[0];
  if (typeof name !== "string" || typeof args !== "string") {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const parsedArgs = parseToolArguments(args);
  const call: Record<string, unknown> = {};
  if (id !== undefined && id.length > 0) {
    call.id = id;
  }
  call.function = {
    index: isWireJsonNumber(index) ? Number.parseInt(index.lexeme, 10) : position,
    name,
    arguments: parsedArgs,
  };
  return call;
}

function parseToolArguments(value: string): WireJsonObject {
  const bytes = new TextEncoder().encode(value);
  try {
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      throw new GatewayFailureError({ kind: "invalid_tool_arguments" });
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_tool_arguments", cause: error });
  }
}

function logprobsFromChoice(choice: WireJsonObject): Array<Record<string, unknown>> | undefined {
  const logprobs = memberValues(choice, "logprobs")[0];
  if (logprobs === undefined || logprobs === null) {
    return undefined;
  }
  if (!isWireJsonObject(logprobs)) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  const content = memberValues(logprobs, "content")[0];
  if (!isWireJsonArray(content)) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  return content.items.map((item) => logprobItem(item, true));
}

function logprobItem(value: WireJson, allowTop: boolean): Record<string, unknown> {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  const token = memberValues(value, "token")[0];
  const logprob = memberValues(value, "logprob")[0];
  if (typeof token !== "string" || !isFiniteNumber(logprob)) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  const result: Record<string, unknown> = { token, logprob: numberValue(logprob) };
  const bytes = memberValues(value, "bytes")[0];
  if (bytes !== undefined && bytes !== null) {
    if (!isWireJsonArray(bytes) || bytes.items.some((item) => !isByteInteger(item))) {
      throw new GatewayFailureError({ kind: "invalid_logprobs" });
    }
    if (bytes.items.length > 0) {
      result.bytes = bytes.items.map((item) => numberValue(item));
    }
  }
  const topValues = memberValues(value, "top_logprobs");
  if (!allowTop && topValues.length > 0) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  const top = topValues[0];
  if (top !== undefined && top !== null) {
    if (!allowTop || !isWireJsonArray(top)) {
      throw new GatewayFailureError({ kind: "invalid_logprobs" });
    }
    if (top.items.length > 0) {
      result.top_logprobs = top.items.map((item) => logprobItem(item, false));
    }
  }
  return result;
}

function doneReasonFromChoice(choice: WireJsonObject, toolCallCount: number): "stop" | "length" {
  const finish = memberValues(choice, "finish_reason")[0];
  if (finish === undefined || finish === null || finish === "stop" || finish === "content_filter") {
    return "stop";
  }
  if (finish === "length") {
    return "length";
  }
  if ((finish === "tool_calls" || finish === "function_call") && toolCallCount > 0) {
    return "stop";
  }
  throw new GatewayFailureError({ kind: "invalid_upstream_response" });
}

function usageCounts(
  root: WireJsonObject,
  requestMessages: WireJsonArray,
  responseContent: string,
  tokenCounter: OllamaTokenCounter,
): { readonly promptEvalCount: number; readonly evalCount: number } {
  const usage = memberValues(root, "usage")[0];
  if (usage !== undefined && usage !== null && !isWireJsonObject(usage)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const promptTokens = isWireJsonObject(usage) ? nonnegativeInteger(memberValues(usage, "prompt_tokens")[0]) : undefined;
  const completionTokens = isWireJsonObject(usage) ? nonnegativeInteger(memberValues(usage, "completion_tokens")[0]) : undefined;
  return {
    promptEvalCount: promptTokens ?? tokenCounter({ model: "", messages: requestMessages }),
    evalCount: completionTokens ?? tokenCounter({ model: "", text: responseContent }),
  };
}

function createdAtFromUpstream(root: WireJsonObject, now: () => Date): string {
  const created = memberValues(root, "created")[0];
  if (created === undefined || created === null) {
    return ollamaCreatedAt(now());
  }
  if (!isWireJsonNumber(created) || !/^(?:0|[1-9]\d*)$/u.test(created.lexeme)) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  const date = new Date(Number.parseInt(created.lexeme, 10) * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return ollamaCreatedAt(date);
}

function nonnegativeInteger(value: WireJson | undefined): number | undefined {
  if (!isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number.parseInt(value.lexeme, 10);
}

function isIntegerInRange(value: WireJson | undefined, min: number, max: number): value is { readonly kind: "number"; readonly lexeme: string } {
  if (!isWireJsonNumber(value) || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return false;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

function isFiniteNumber(value: WireJson | undefined): value is { readonly kind: "number"; readonly lexeme: string } {
  return isWireJsonNumber(value) && Number.isFinite(Number(value.lexeme));
}

function isByteInteger(value: WireJson): boolean {
  return isIntegerInRange(value, 0, 255);
}

function numberValue(value: WireJson): number {
  if (!isWireJsonNumber(value)) {
    throw new GatewayFailureError({ kind: "invalid_logprobs" });
  }
  return Number(value.lexeme);
}
