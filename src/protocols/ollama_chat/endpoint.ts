import { VERSION } from "../../version.js";
import type { CopilotBackend } from "../../copilot/backend.js";
import type { AccountDirectory } from "../../accounts/account_directory.js";
import { iterateChatFrames } from "../../copilot/backend.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import type { FailurePresenter, RouteRegistration } from "../../gateway/hono_app.js";
import { isWireJsonArray, isWireJsonObject, memberValues, type WireJson } from "../../serialization/wire_json.js";
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import { encodeNdjson, ollamaCreatedAt, ollamaErrorBody } from "./wire.js";

export interface OllamaRouteDependencies {
  readonly directory: AccountDirectory;
  readonly copilot: CopilotBackend;
  readonly now?: () => Date;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createOllamaChatRoutes(dependencies: OllamaRouteDependencies): readonly RouteRegistration[] {
  const presentFailure: FailurePresenter = (failure) => {
    const status = failure.kind === "queue_full" || failure.kind === "queue_timeout"
      ? 503
      : failure.kind === "unsupported_semantics"
        ? 422
        : failure.kind === "upstream_timeout"
          ? 504
          : failure.kind === "internal"
            ? 500
            : 400;
    const text = failure.kind === "queue_full" || failure.kind === "queue_timeout"
      ? "server overloaded"
      : failure.kind === "unsupported_semantics"
        ? "unsupported semantics"
        : failure.kind === "upstream_timeout"
          ? "upstream timeout"
          : failure.kind === "internal"
            ? "internal error"
            : "invalid request";
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
        if (model === undefined || !isWireJsonArray(messages) || messages.items.length === 0) {
          throw new GatewayFailureError({ kind: "invalid_request" });
        }
        const streamValue = memberValues(request.body, "stream")[0];
        const stream = streamValue === undefined ? true : streamValue === true;
        if (streamValue !== undefined && streamValue !== true && streamValue !== false) {
          throw new GatewayFailureError({ kind: "invalid_request" });
        }
        const account = await dependencies.directory.bindDefault(scope.signal);
        const copilot = await dependencies.copilot.bind(account, scope.signal);
        const chatBody = new TextEncoder().encode(JSON.stringify({
          model,
          messages: messages.items.map(ollamaMessageToChat),
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }));
        const createdAt = ollamaCreatedAt((dependencies.now ?? (() => new Date()))());
        if (!stream) {
          const response = await copilot.completeChat({
            model,
            body: chatBody,
            stream: false,
            hasVisionInput: false,
            nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
            connectTimeoutMs: scope.config.timeouts.connectMs,
            firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
            signal: scope.signal,
          });
          const content = extractContent(response.body);
          return new Response(JSON.stringify({
            model,
            created_at: createdAt,
            message: { role: "assistant", content },
            done: true,
            done_reason: "stop",
          }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
        }
        const writer = createStreamResponseWriter({
          signal: scope.signal,
          headers: { "Content-Type": "application/x-ndjson" },
        });
        const upstream = await copilot.openChatStream({
          model,
          body: chatBody,
          stream: true,
          hasVisionInput: false,
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

function asNonEmptyString(value: WireJson | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ollamaMessageToChat(value: WireJson): { role: string; content: string } {
  if (!isWireJsonObject(value)) {
    return { role: "user", content: "" };
  }
  const role = asNonEmptyString(memberValues(value, "role")[0]) ?? "user";
  const content = typeof memberValues(value, "content")[0] === "string"
    ? memberValues(value, "content")[0] as string
    : "";
  return { role: role.toLowerCase(), content };
}

function extractContent(body: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parsed.choices?.[0]?.message?.content ?? "";
  } catch (_error) {
    return "";
  }
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
