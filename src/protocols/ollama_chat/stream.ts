import { ChatSseError, parseChatSse } from "../../copilot/chat_sse.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import type { ChatStreamFrame, UpstreamByteStream } from "../chat_completions/types.js";
import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  ollamaDoneReason,
  ollamaLogprobsFromChoice,
  parseOllamaToolArguments,
} from "./bridge.js";
import { encodeNdjson } from "./wire.js";

export async function createOllamaStreamResponse(input: {
  readonly upstream: UpstreamByteStream;
  readonly model: string;
  readonly createdAt: string;
  readonly scope: Readonly<RequestScope>;
}): Promise<Response> {
  const reducer = new OllamaStreamReducer(input.model, input.createdAt);
  const frames = parseChatSse(withBodyTimeouts(input.upstream.bytes, input.scope), input.scope.config.limits.sseEventBytes);
  let pending: Uint8Array | undefined = await firstOutput(reducer, frames, input.upstream, input.scope);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (input.scope.signal.aborted) {
        await closeUpstream(input.upstream, frames);
        controller.close();
        return;
      }
      if (pending !== undefined) {
        controller.enqueue(pending);
        pending = undefined;
        if (reducer.terminal) {
          await closeUpstream(input.upstream, frames);
          controller.close();
        }
        return;
      }
      try {
        for (;;) {
          const output = await nextOutput(reducer, frames, input.scope);
          if (output !== undefined) {
            controller.enqueue(output);
            if (reducer.terminal) {
              await closeUpstream(input.upstream, frames);
              controller.close();
            }
            return;
          }
        }
      } catch (error: unknown) {
        await closeUpstream(input.upstream, frames);
        controller.enqueue(streamErrorBytes(error));
        controller.close();
      }
    },
    async cancel(): Promise<void> {
      await closeUpstream(input.upstream, frames);
    },
  });
  input.scope.signal.addEventListener("abort", () => {
    void closeUpstream(input.upstream, frames);
  }, { once: true });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

class OllamaStreamReducer {
  private readonly tools = new Map<number, ToolAccumulator>();
  private finishReason: WireJson | undefined;
  private promptTokens: number | undefined;
  private completionTokens: number | undefined;
  private thinkingStarted = false;
  private thinkingFinished = false;
  private phase: "open" | "finished" | "errored" = "open";

  constructor(
    private readonly model: string,
    private readonly createdAt: string,
  ) {}

  get terminal(): boolean {
    return this.phase !== "open";
  }

  apply(frame: ChatStreamFrame): readonly Uint8Array[] {
    if (this.phase !== "open") {
      return [];
    }
    if (frame.kind === "error") {
      this.phase = "errored";
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    if (frame.kind === "done") {
      this.phase = "finished";
      return [encodeNdjson(this.terminalObject())];
    }
    return this.applyChunk(frame.chunk.payload);
  }

  private applyChunk(payload: WireJson): readonly Uint8Array[] {
    const root = objectOrStreamError(payload);
    this.mergeUsage(memberValues(root, "usage")[0]);
    const choices = memberValues(root, "choices")[0];
    if (!isWireJsonArray(choices)) {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    if (choices.items.length === 0) {
      return [];
    }
    const choice = selectedChoice(choices);
    this.recordFinish(memberValues(choice, "finish_reason")[0]);
    const delta = memberValues(choice, "delta")[0];
    if (!isWireJsonObject(delta)) {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    this.mergeToolCalls(memberValues(delta, "tool_calls")[0]);
    const message = this.messageFromDelta(delta);
    const logprobs = ollamaLogprobsFromChoice(choice);
    if (message === undefined && (logprobs === undefined || logprobs.length === 0)) {
      return [];
    }
    return [encodeNdjson({
      model: this.model,
      created_at: this.createdAt,
      message: message ?? { role: "assistant", content: "" },
      done: false,
      ...(logprobs === undefined || logprobs.length === 0 ? {} : { logprobs }),
    })];
  }

  private messageFromDelta(delta: WireJsonObject): Record<string, unknown> | undefined {
    const contentValues = memberValues(delta, "content");
    const reasoningContentValues = memberValues(delta, "reasoning_content");
    const reasoningValues = memberValues(delta, "reasoning");
    const message: Record<string, unknown> = { role: "assistant", content: "" };
    let emitted = false;
    if (reasoningContentValues.length > 0) {
      const thinking = optionalString(reasoningContentValues[0]);
      if (thinking.length > 0) {
        message.thinking = thinking;
        emitted = true;
      }
    } else if (reasoningValues.length > 0) {
      const thinking = optionalString(reasoningValues[0]);
      if (thinking.length > 0) {
        message.thinking = thinking;
        emitted = true;
      }
    } else if (contentValues.length > 0) {
      const reduced = this.reduceContent(optionalString(contentValues[0]));
      if (reduced.content.length > 0) {
        message.content = reduced.content;
        emitted = true;
      }
      if (reduced.thinking.length > 0) {
        message.thinking = reduced.thinking;
        emitted = true;
      }
    }
    return emitted ? message : undefined;
  }

  private reduceContent(fragment: string): { readonly content: string; readonly thinking: string } {
    if (fragment.length === 0) {
      return { content: "", thinking: "" };
    }
    if (this.thinkingStarted && !this.thinkingFinished) {
      this.thinkingFinished = true;
    }
    let reduced = fragment;
    if (reduced.includes("<think>")) {
      reduced = reduced.replaceAll("<think>", "");
      this.thinkingStarted = true;
      this.thinkingFinished = false;
    }
    if (reduced.includes("</think>") && this.thinkingStarted) {
      reduced = reduced.replaceAll("</think>", "");
      this.thinkingFinished = true;
    }
    if (this.thinkingStarted && !this.thinkingFinished) {
      return { content: "", thinking: reduced };
    }
    return { content: reduced, thinking: "" };
  }

  private mergeToolCalls(value: WireJson | undefined): void {
    if (value === undefined) {
      return;
    }
    if (!isWireJsonArray(value)) {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    for (const item of value.items) {
      this.mergeToolCall(item);
    }
  }

  private mergeToolCall(value: WireJson): void {
    const call = objectOrStreamError(value);
    const index = requiredInteger(memberValues(call, "index")[0]);
    const current = this.tools.get(index) ?? { argumentFragments: [] };
    const id = memberValues(call, "id")[0];
    if (id !== undefined && id !== null) {
      if (typeof id !== "string") {
        throw new GatewayFailureError({ kind: "upstream_stream_error" });
      }
      lockValue(current.id, id, () => { current.id = id; });
    }
    const fn = memberValues(call, "function")[0];
    if (fn !== undefined) {
      const functionObject = objectOrStreamError(fn);
      const name = memberValues(functionObject, "name")[0];
      if (name !== undefined && name !== null) {
        if (typeof name !== "string") {
          throw new GatewayFailureError({ kind: "upstream_stream_error" });
        }
        lockValue(current.name, name, () => { current.name = name; });
      }
      const args = memberValues(functionObject, "arguments")[0];
      if (args !== undefined && args !== null) {
        if (typeof args !== "string") {
          throw new GatewayFailureError({ kind: "upstream_stream_error" });
        }
        current.argumentFragments.push(args);
      }
    }
    this.tools.set(index, current);
  }

  private recordFinish(value: WireJson | undefined): void {
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value !== "string") {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    if (this.finishReason !== undefined && this.finishReason !== value) {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    this.finishReason = value;
  }

  private mergeUsage(value: WireJson | undefined): void {
    if (value === undefined || value === null) {
      return;
    }
    const usage = objectOrStreamError(value);
    const prompt = streamUsageCount(usage, "prompt_tokens");
    const completion = streamUsageCount(usage, "completion_tokens");
    this.promptTokens = prompt ?? this.promptTokens;
    this.completionTokens = completion ?? this.completionTokens;
  }

  private terminalObject(): Record<string, unknown> {
    const toolCalls = [...this.tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, tool]) => toolCallObject(index, tool));
    return {
      model: this.model,
      created_at: this.createdAt,
      message: {
        role: "assistant",
        content: "",
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      },
      done: true,
      done_reason: ollamaDoneReason(this.finishReason, toolCalls.length),
      ...((this.promptTokens ?? 0) === 0 ? {} : { prompt_eval_count: this.promptTokens ?? 0 }),
      ...((this.completionTokens ?? 0) === 0 ? {} : { eval_count: this.completionTokens ?? 0 }),
    };
  }
}

interface ToolAccumulator {
  id?: string;
  name?: string;
  argumentFragments: string[];
}

async function firstOutput(
  reducer: OllamaStreamReducer,
  frames: AsyncGenerator<ChatStreamFrame>,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
): Promise<Uint8Array> {
  try {
    for (;;) {
      const output = await nextOutput(reducer, frames, scope);
      if (output !== undefined) {
        return output;
      }
    }
  } catch (error: unknown) {
    await closeUpstream(upstream, frames);
    throw streamGatewayFailure(error);
  }
}

async function nextOutput(
  reducer: OllamaStreamReducer,
  frames: AsyncGenerator<ChatStreamFrame>,
  scope: Readonly<RequestScope>,
): Promise<Uint8Array | undefined> {
  if (scope.signal.aborted) {
    throw new GatewayFailureError({ kind: "aborted" });
  }
  try {
    const next = await frames.next();
    if (next.done === true) {
      throw new GatewayFailureError({ kind: "upstream_stream_truncated" });
    }
    return reducer.apply(next.value)[0];
  } catch (error: unknown) {
    throw streamGatewayFailure(error);
  }
}

function streamGatewayFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (error instanceof ChatSseError) {
    return new GatewayFailureError({
      kind: error.code === "truncated" ? "upstream_stream_truncated" : "upstream_stream_error",
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayFailureError({ kind: "aborted" });
  }
  return new GatewayFailureError({ kind: "upstream_stream_error", cause: error });
}

function streamErrorBytes(error: unknown): Uint8Array {
  const failure = streamGatewayFailure(error).failure;
  if (failure.kind === "upstream_stream_truncated") {
    return encodeNdjson({ error: "upstream stream truncated" });
  }
  if (failure.kind === "invalid_tool_arguments") {
    return encodeNdjson({ error: "invalid tool arguments" });
  }
  if (failure.kind === "invalid_logprobs") {
    return encodeNdjson({ error: "invalid logprobs" });
  }
  return encodeNdjson({ error: "upstream stream error" });
}

async function closeUpstream(upstream: UpstreamByteStream, frames: AsyncGenerator<ChatStreamFrame>): Promise<void> {
  await upstream.cancel().catch(() => undefined);
  await frames.return(undefined).catch(() => undefined);
}

async function* withBodyTimeouts(
  bytes: AsyncIterable<Uint8Array>,
  scope: Readonly<RequestScope>,
): AsyncIterable<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]();
  let seenBytes = false;
  try {
    for (;;) {
      const timeout = bodyTimeout(seenBytes ? scope.config.timeouts.streamIdleMs : scope.config.timeouts.firstByteMs, scope.signal);
      let next: IteratorResult<Uint8Array>;
      try {
        next = await Promise.race([
          iterator.next(),
          timeout.promise,
        ]);
      } finally {
        timeout.clear();
      }
      if (next.done === true) {
        return;
      }
      seenBytes = true;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

function bodyTimeout(ms: number, signal: AbortSignal): {
  readonly promise: Promise<IteratorResult<Uint8Array>>;
  readonly clear: () => void;
} {
  let clear = (): void => undefined;
  const promise = new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new GatewayFailureError({ kind: "aborted" }));
      return;
    }
    const timer = setTimeout(() => reject(new GatewayFailureError({ kind: "upstream_timeout" })), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GatewayFailureError({ kind: "aborted" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  return { promise, clear };
}

function selectedChoice(choices: WireJsonArray): WireJsonObject {
  const selected = choices.items.filter((choice): choice is WireJsonObject => {
    if (!isWireJsonObject(choice)) {
      throw new GatewayFailureError({ kind: "upstream_stream_error" });
    }
    const index = memberValues(choice, "index")[0];
    return isWireJsonNumber(index) && index.lexeme === "0";
  });
  if (selected.length !== 1) {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  return selected[0] as WireJsonObject;
}

function objectOrStreamError(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  return value;
}

function optionalString(value: WireJson | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  return value;
}

function requiredInteger(value: WireJson | undefined): number {
  if (!isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  return Number.parseInt(value.lexeme, 10);
}

function streamUsageCount(usage: WireJsonObject, key: string): number | undefined {
  const values = memberValues(usage, key);
  if (values.length === 0) {
    return undefined;
  }
  if (!isIntegerInRange(values[0], 0, Number.MAX_SAFE_INTEGER)) {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  return Number.parseInt(values[0].lexeme, 10);
}

function isIntegerInRange(value: WireJson | undefined, min: number, max: number): value is { readonly kind: "number"; readonly lexeme: string } {
  if (!isWireJsonNumber(value) || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return false;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

function lockValue(current: string | undefined, next: string, set: () => void): void {
  if (next.length === 0) {
    return;
  }
  if (current !== undefined && current !== next) {
    throw new GatewayFailureError({ kind: "upstream_stream_error" });
  }
  set();
}

function toolCallObject(index: number, tool: ToolAccumulator): Record<string, unknown> {
  return {
    ...(tool.id === undefined ? {} : { id: tool.id }),
    function: {
      index,
      name: tool.name ?? "",
      arguments: parseOllamaToolArguments(tool.argumentFragments.join("")),
    },
  };
}
