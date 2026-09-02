import { VERSION } from "../../version.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import type { AccountDirectory } from "../../accounts/account_directory.js";
import { iterateChatFrames } from "../../copilot/backend.js";
import {
  UpstreamBodyLimitError,
  UpstreamTimeoutError,
} from "../../copilot/transport.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import type { FailurePresenter, RouteRegistration } from "../../gateway/hono_app.js";
import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  serializeWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import { encodeNdjson, ollamaCreatedAt, ollamaErrorBody, ollamaJsonStringify } from "./wire.js";
import { ollamaNonstreamResponse } from "./bridge.js";
import type { ChatRequest } from "../chat_completions/types.js";

export interface OllamaRouteDependencies {
  readonly directory: AccountDirectory;
  readonly copilot: CopilotBackend;
  readonly now?: () => Date;
  readonly tokenCounter?: (input: { readonly model: ""; readonly messages?: WireJsonArray; readonly text?: string }) => number;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createOllamaChatRoutes(dependencies: OllamaRouteDependencies): readonly RouteRegistration[] {
  const presentFailure: FailurePresenter = (failure) => {
    const { status, text } = ollamaFailureStatusAndText(failure);
    return new Response(ollamaErrorBody(text), { status, headers: JSON_HEADERS });
  };

  return [
    {
      method: "GET",
      path: "/api/version",
      admission: "none",
      body: "none",
      presentFailure,
      endpoint: async () => new Response(JSON.stringify({ version: VERSION }), {
        headers: JSON_HEADERS,
      }),
    },
    {
      method: "POST",
      path: "/api/chat",
      admission: "inference",
      body: "wire-json-object",
      presentFailure,
      endpoint: async (request, scope) => {
        if (request.body === undefined) {
          throw new GatewayFailureError({ kind: "invalid_request" });
        }
        const model = asNonEmptyString(memberValues(request.body, "model")[0]);
        const messages = memberValues(request.body, "messages")[0];
        if (model === undefined || !isWireJsonArray(messages)) {
          throw new GatewayFailureError({ kind: "invalid_request" });
        }
        if (messages.items.length === 0) {
          throw new GatewayFailureError({ kind: "unsupported_semantics" });
        }
        const streamValue = memberValues(request.body, "stream")[0];
        const stream = streamValue === undefined ? true : streamValue === true;
        if (streamValue !== undefined && streamValue !== true && streamValue !== false) {
          throw new GatewayFailureError({ kind: "invalid_request" });
        }
        const chatRequest = buildOllamaChatRequest(request.body, model, messages, stream);
        const hasVisionInput = hasOllamaImages(messages);
        const account = await dependencies.directory.bindDefault(scope.signal);
        const copilot = await dependencies.copilot.bind(account, scope.signal);
        const chatBody = serializeWireJson(chatRequest);
        const createdAt = ollamaCreatedAt((dependencies.now ?? (() => new Date()))());
        if (!stream) {
          const response = await completeChat(copilot, {
            model,
            body: chatBody,
            stream: false,
            hasVisionInput,
            nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
            connectTimeoutMs: scope.config.timeouts.connectMs,
            firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
            signal: scope.signal,
          });
          if (response.status < 200 || response.status >= 300) {
            throw new GatewayFailureError({ kind: "upstream_http", status: response.status });
          }
          return new Response(ollamaJsonStringify(ollamaNonstreamResponse(
            response.body,
            model,
            chatMessagesFromRequest(chatRequest),
            dependencies.now ?? (() => new Date()),
            dependencies.tokenCounter ?? (() => 0),
          )), { headers: JSON_HEADERS });
        }
        const writer = createStreamResponseWriter({
          signal: scope.signal,
          headers: { "Content-Type": "application/x-ndjson" },
        });
        const upstream = await openChatStream(copilot, {
          model,
          body: chatBody,
          stream: true,
          hasVisionInput,
          nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
          connectTimeoutMs: scope.config.timeouts.connectMs,
          firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
          signal: scope.signal,
        });
        void (async () => {
          try {
            for await (const frame of iterateChatFrames(upstream)) {
              if (scope.signal.aborted) {
                writer.abort();
                return;
              }
              if (frame.kind === "chunk") {
                const content = textFromWire(frame.chunk.payload);
                if (content.length > 0) {
                  await writer.enqueue(encodeNdjson({
                    model,
                    created_at: createdAt,
                    message: { role: "assistant", content },
                    done: false,
                  }));
                }
              }
              if (frame.kind === "done") {
                await writer.enqueue(encodeNdjson({
                  model,
                  created_at: createdAt,
                  message: { role: "assistant", content: "" },
                  done: true,
                  done_reason: "stop",
                }));
                writer.close();
                return;
              }
              if (frame.kind === "error") {
                await writer.enqueue(encodeNdjson({ error: "upstream stream error" }));
                writer.close();
                return;
              }
            }
            writer.close();
          } catch (_error) {
            if (writer.committed) {
              await writer.enqueue(encodeNdjson({ error: "upstream stream error" }));
            }
            writer.close();
          }
        })();
        return writer.response;
      },
    },
  ];
}

function ollamaFailureStatusAndText(failure: Parameters<FailurePresenter>[0]): { readonly status: number; readonly text: string } {
  switch (failure.kind) {
  case "queue_full":
  case "queue_timeout":
    return { status: 503, text: "server overloaded" };
  case "unsupported_semantics":
    return { status: 422, text: "unsupported semantics" };
  case "upstream_timeout":
    return { status: 504, text: "upstream timeout" };
  case "upstream_http":
    return { status: failure.status, text: "upstream request failed" };
  case "upstream_network":
    return { status: 502, text: "upstream request failed" };
  case "invalid_upstream_response":
    return { status: 502, text: "invalid upstream response" };
  case "invalid_tool_arguments":
    return { status: 502, text: "invalid tool arguments" };
  case "invalid_logprobs":
    return { status: 502, text: "invalid logprobs" };
  case "internal":
    return { status: 500, text: "internal error" };
  default:
    return { status: 400, text: "invalid request" };
  }
}

function asNonEmptyString(value: WireJson | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildOllamaChatRequest(
  body: WireJsonObject,
  model: string,
  messages: WireJsonArray,
  stream: boolean,
): WireJsonObject {
  assertNoUnsupportedTopLevel(body);
  const members: Array<{ key: string; value: WireJson }> = [
    { key: "model", value: model },
    { key: "messages", value: { kind: "array", items: messages.items.map(ollamaMessageToChat) } },
  ];
  const tools = memberValues(body, "tools")[0];
  if (tools !== undefined) {
    if (!isWireJsonArray(tools)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "tools", value: { kind: "array", items: tools.items.map(ollamaToolToChat) } });
  }
  const format = memberValues(body, "format")[0];
  if (format !== undefined) {
    members.push({ key: "response_format", value: responseFormat(format) });
  }
  members.push({ key: "stream", value: stream });
  if (stream) {
    members.push({
      key: "stream_options",
      value: { kind: "object", members: [{ key: "include_usage", value: true }] },
    });
  }
  const think = memberValues(body, "think")[0];
  if (think !== undefined) {
    members.push({ key: "reasoning_effort", value: reasoningEffort(think) });
  }
  for (const mapped of mappedOptions(memberValues(body, "options")[0])) {
    members.push(mapped);
  }
  const debug = memberValues(body, "_debug_render_only")[0];
  if (debug !== undefined) {
    if (debug !== true && debug !== false) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "_debug_render_only", value: debug });
  }
  const logprobs = memberValues(body, "logprobs")[0];
  if (logprobs !== undefined) {
    if (logprobs !== true && logprobs !== false) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "logprobs", value: logprobs });
  }
  const topLogprobs = memberValues(body, "top_logprobs")[0];
  if (topLogprobs !== undefined) {
    if (!isIntegerInRange(topLogprobs, 0, 20)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "top_logprobs", value: topLogprobs });
  }
  return { kind: "object", members };
}

function chatMessagesFromRequest(request: WireJsonObject): WireJsonArray {
  const messages = memberValues(request, "messages")[0];
  if (!isWireJsonArray(messages)) {
    throw new GatewayFailureError({ kind: "internal" });
  }
  return messages;
}

function assertNoUnsupportedTopLevel(body: WireJsonObject): void {
  for (const key of ["keep_alive", "truncate", "shift"]) {
    if (memberValues(body, key).length > 0) {
      throw new GatewayFailureError({ kind: "unsupported_semantics" });
    }
  }
}

function ollamaMessageToChat(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const role = memberValues(value, "role")[0];
  const content = memberValues(value, "content")[0];
  if (typeof role !== "string" || typeof content !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const members: Array<{ key: string; value: WireJson }> = [
    { key: "role", value: role.toLowerCase() },
    { key: "content", value: contentValue(content, memberValues(value, "images")[0]) },
  ];
  const thinking = memberValues(value, "thinking")[0];
  if (thinking !== undefined) {
    if (typeof thinking !== "string") {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "reasoning", value: thinking });
  }
  const toolName = memberValues(value, "tool_name")[0];
  if (toolName !== undefined) {
    if (typeof toolName !== "string") {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "name", value: toolName });
  }
  const toolCallId = memberValues(value, "tool_call_id")[0];
  if (toolCallId !== undefined) {
    if (typeof toolCallId !== "string") {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "tool_call_id", value: toolCallId });
  }
  const toolCalls = memberValues(value, "tool_calls")[0];
  if (toolCalls !== undefined) {
    if (!isWireJsonArray(toolCalls)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    members.push({ key: "tool_calls", value: { kind: "array", items: toolCalls.items.map(ollamaToolCallToChat) } });
  }
  return { kind: "object", members };
}

function contentValue(content: string, images: WireJson | undefined): WireJson {
  if (images === undefined) {
    return content;
  }
  if (!isWireJsonArray(images)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  return {
    kind: "array",
    items: [
      { kind: "object", members: [{ key: "type", value: "text" }, { key: "text", value: content }] },
      ...images.items.map(imagePart),
    ],
  };
}

function imagePart(value: WireJson): WireJsonObject {
  if (typeof value !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const mime = imageMime(value);
  return {
    kind: "object",
    members: [
      { key: "type", value: "image_url" },
      {
        key: "image_url",
        value: { kind: "object", members: [{ key: "url", value: `data:${mime};base64,${value}` }] },
      },
    ],
  };
}

function imageMime(base64: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || base64.length % 4 !== 0) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== base64) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47
    && decoded[4] === 0x0d && decoded[5] === 0x0a && decoded[6] === 0x1a && decoded[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    decoded[0] === 0x52 && decoded[1] === 0x49 && decoded[2] === 0x46 && decoded[3] === 0x46
    && decoded[8] === 0x57 && decoded[9] === 0x45 && decoded[10] === 0x42 && decoded[11] === 0x50
  ) {
    return "image/webp";
  }
  throw new GatewayFailureError({ kind: "invalid_request" });
}

function ollamaToolCallToChat(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const id = memberValues(value, "id")[0];
  const fn = memberValues(value, "function")[0];
  if (id !== undefined && typeof id !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (!isWireJsonObject(fn)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const index = memberValues(fn, "index")[0];
  const name = memberValues(fn, "name")[0];
  const args = memberValues(fn, "arguments")[0];
  if (index === undefined || !isIntegerInRange(index, 0, Number.MAX_SAFE_INTEGER) || typeof name !== "string" || !isWireJsonObject(args)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const members: Array<{ key: string; value: WireJson }> = [];
  if (id !== undefined && id.length > 0) {
    members.push({ key: "id", value: id });
  }
  members.push(
    { key: "index", value: index },
    { key: "type", value: "function" },
    {
      key: "function",
      value: {
        kind: "object",
        members: [
          { key: "name", value: name },
          { key: "arguments", value: new TextDecoder().decode(serializeWireJson(args)) },
        ],
      },
    },
  );
  return { kind: "object", members };
}

function ollamaToolToChat(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const type = memberValues(value, "type")[0];
  const fn = memberValues(value, "function")[0];
  if (typeof type !== "string" || !isWireJsonObject(fn)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const name = memberValues(fn, "name")[0];
  const description = memberValues(fn, "description")[0];
  const parameters = memberValues(fn, "parameters")[0];
  if (typeof name !== "string" || (description !== undefined && typeof description !== "string") || !isWireJsonObject(parameters)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const mappedParameters = toolParameters(parameters);
  const functionMembers: Array<{ key: string; value: WireJson }> = [{ key: "name", value: name }];
  if (description !== undefined) {
    functionMembers.push({ key: "description", value: description });
  }
  functionMembers.push({ key: "parameters", value: mappedParameters });
  const members: Array<{ key: string; value: WireJson }> = [{ key: "type", value: type }];
  const items = memberValues(value, "items")[0];
  if (items !== undefined) {
    members.push({ key: "items", value: items });
  }
  members.push({ key: "function", value: { kind: "object", members: functionMembers } });
  return { kind: "object", members };
}

function toolParameters(parameters: WireJsonObject): WireJsonObject {
  const type = memberValues(parameters, "type")[0];
  const properties = memberValues(parameters, "properties")[0];
  const required = memberValues(parameters, "required")[0];
  if (typeof type !== "string" || !isWireJsonObject(properties)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (required !== undefined && (!isWireJsonArray(required) || required.items.some((item) => typeof item !== "string"))) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  return {
    kind: "object",
    members: parameters.members.flatMap((member) => {
      if (member.key === "type") {
        return [{ key: member.key, value: type }];
      }
      if (member.key === "$defs" || member.key === "items") {
        return [member];
      }
      if (member.key === "required" && required !== undefined) {
        return [{ key: member.key, value: required }];
      }
      if (member.key === "properties") {
        return [{ key: member.key, value: toolProperties(properties) }];
      }
      return [];
    }),
  };
}

function toolProperties(properties: WireJsonObject): WireJsonObject {
  const members: Array<{ key: string; value: WireJson }> = [];
  for (const property of properties.members) {
    members.push({ key: property.key, value: toolProperty(property.value) });
  }
  return { kind: "object", members };
}

function toolProperty(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const mapped = new Map<string, WireJson>();
  const anyOf = memberValues(value, "anyOf")[0];
  if (anyOf !== undefined) {
    if (!isWireJsonArray(anyOf)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    mapped.set("anyOf", { kind: "array", items: anyOf.items.map(toolProperty) });
  }
  const type = memberValues(value, "type")[0];
  if (type !== undefined && typeof type !== "string" && (!isWireJsonArray(type) || type.items.some((item) => typeof item !== "string"))) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (type !== undefined) {
    mapped.set("type", type);
  }
  const items = memberValues(value, "items")[0];
  if (items !== undefined) {
    mapped.set("items", items);
  }
  const description = memberValues(value, "description")[0];
  if (description !== undefined && typeof description !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (description !== undefined) {
    mapped.set("description", description);
  }
  const enumValues = memberValues(value, "enum")[0];
  if (enumValues !== undefined && !isWireJsonArray(enumValues)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (enumValues !== undefined) {
    mapped.set("enum", enumValues);
  }
  const nestedProperties = memberValues(value, "properties")[0];
  if (nestedProperties !== undefined) {
    if (!isWireJsonObject(nestedProperties)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    mapped.set("properties", toolProperties(nestedProperties));
  }
  const required = memberValues(value, "required")[0];
  if (required !== undefined && (!isWireJsonArray(required) || required.items.some((item) => typeof item !== "string"))) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (required !== undefined) {
    mapped.set("required", required);
  }
  return {
    kind: "object",
    members: value.members.flatMap((member) => {
      const mappedValue = mapped.get(member.key);
      return mappedValue === undefined ? [] : [{ key: member.key, value: mappedValue }];
    }),
  };
}

function hasOllamaImages(messages: WireJsonArray): boolean {
  return messages.items.some((message) => {
    if (!isWireJsonObject(message)) {
      return false;
    }
    const images = memberValues(message, "images")[0];
    return isWireJsonArray(images) && images.items.length > 0;
  });
}

function mappedOptions(value: WireJson | undefined): Array<{ key: string; value: WireJson }> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const unsupported = [
    "num_keep", "top_k", "min_p", "typical_p", "repeat_last_n", "repeat_penalty", "num_ctx",
    "num_batch", "num_gpu", "main_gpu", "use_mmap", "num_thread", "draft_num_predict",
  ];
  if (unsupported.some((key) => memberValues(value, key).length > 0)) {
    throw new GatewayFailureError({ kind: "unsupported_semantics" });
  }
  const mapped: Array<{ key: string; value: WireJson }> = [];
  const numPredict = memberValues(value, "num_predict")[0];
  if (numPredict !== undefined) {
    if (!isWireJsonNumber(numPredict)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    if (!isPositiveInteger(numPredict)) {
      throw new GatewayFailureError({ kind: "unsupported_semantics" });
    }
    mapped.push({ key: "max_tokens", value: numPredict });
  }
  for (const key of ["temperature", "top_p", "seed", "frequency_penalty", "presence_penalty"]) {
    const option = memberValues(value, key)[0];
    if (option !== undefined) {
      if (!isWireJsonNumber(option)) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }
      mapped.push({ key, value: option });
    }
  }
  const stop = memberValues(value, "stop")[0];
  if (stop !== undefined) {
    if (!isWireJsonArray(stop) || stop.items.some((item) => typeof item !== "string")) {
      throw new GatewayFailureError({ kind: "unsupported_semantics" });
    }
    mapped.push({ key: "stop", value: stop });
  }
  return mapped;
}

function responseFormat(value: WireJson): WireJsonObject {
  if (value === "json") {
    return { kind: "object", members: [{ key: "type", value: "json_object" }] };
  }
  if (isWireJsonObject(value)) {
    return {
      kind: "object",
      members: [
        { key: "type", value: "json_schema" },
        { key: "json_schema", value: { kind: "object", members: [{ key: "schema", value }] } },
      ],
    };
  }
  throw new GatewayFailureError({ kind: "unsupported_semantics" });
}

function reasoningEffort(value: WireJson): string {
  if (value === false) {
    return "none";
  }
  if (value === true) {
    throw new GatewayFailureError({ kind: "unsupported_semantics" });
  }
  if (typeof value === "string") {
    return value;
  }
  throw new GatewayFailureError({ kind: "invalid_request" });
}

function isPositiveInteger(value: WireJson): boolean {
  return isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER);
}

function isIntegerInRange(value: WireJson, min: number, max: number): boolean {
  if (!isWireJsonNumber(value) || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return false;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

async function completeChat(copilot: BoundCopilot, request: Readonly<ChatRequest>) {
  try {
    return await copilot.completeChat(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error);
  }
}

async function openChatStream(copilot: BoundCopilot, request: Readonly<ChatRequest>) {
  try {
    return await copilot.openChatStream(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error);
  }
}

function upstreamCallFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayFailureError({ kind: "aborted" });
  }
  if (error instanceof UpstreamBodyLimitError) {
    return new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
  if (error instanceof UpstreamTimeoutError) {
    return new GatewayFailureError({ kind: "upstream_timeout", cause: error });
  }
  return new GatewayFailureError({ kind: "upstream_network", cause: error });
}

function textFromWire(value: WireJson): string {
  if (!isWireJsonObject(value)) {
    return "";
  }
  const choices = memberValues(value, "choices")[0];
  if (!isWireJsonArray(choices) || choices.items[0] === undefined || !isWireJsonObject(choices.items[0])) {
    return "";
  }
  const delta = memberValues(choices.items[0], "delta")[0];
  if (!isWireJsonObject(delta)) {
    return "";
  }
  const content = memberValues(delta, "content")[0];
  return typeof content === "string" ? content : "";
}
