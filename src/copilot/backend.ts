import type { BoundAccount } from "../accounts/account_directory.js";
import type { AccountId } from "../accounts/credential_store.js";
import { copilotHeaders } from "./identity.js";
import { parseChatSse } from "./chat_sse.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamFrame,
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "../protocols/chat_completions/types.js";

export interface CopilotTarget {
  readonly endpoint: string;
  readonly token: string;
}

export interface BoundCopilot {
  readonly accountId: AccountId;
  readonly target: Readonly<CopilotTarget>;
  completeChat(request: Readonly<ChatRequest>): Promise<ChatResponse>;
  openChatStream(request: Readonly<ChatRequest>): Promise<UpstreamByteStream>;
  completeResponses(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse>;
  openResponsesStream(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream>;
}

export interface CopilotBackend {
  bind(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<BoundCopilot>;
}

export interface ScriptedCopilotHandlers {
  chat?: ChatResponse | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);
  chatStream?: Uint8Array[] | AsyncIterable<Uint8Array>;
  responses?: UpstreamByteResponse;
  responsesStream?: Uint8Array[];
}

export class ScriptedCopilotBackend implements CopilotBackend {
  readonly captured: Array<{ readonly accountId: string; readonly kind: string }> = [];

  constructor(
    private readonly handlers: ScriptedCopilotHandlers,
    private readonly endpoint = "https://api.githubcopilot.com",
    private readonly token = "scripted-token",
  ) {}

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target = { endpoint: this.endpoint, token: this.token };
    const captured = this.captured;
    const handlers = this.handlers;
    return {
      accountId: account.accountId,
      target,
      async completeChat(request) {
        captured.push({ accountId: account.accountId, kind: "chat" });
        const handler = handlers.chat;
        if (typeof handler === "function") {
          return handler(request);
        }
        if (handler !== undefined) {
          return handler;
        }
        throw new Error("scripted chat missing");
      },
      async openChatStream() {
        captured.push({ accountId: account.accountId, kind: "chat-stream" });
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          bytes: asAsync(handlers.chatStream ?? []),
        };
      },
      async completeResponses() {
        captured.push({ accountId: account.accountId, kind: "responses" });
        if (handlers.responses === undefined) {
          throw new Error("scripted responses missing");
        }
        return handlers.responses;
      },
      async openResponsesStream() {
        captured.push({ accountId: account.accountId, kind: "responses-stream" });
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          bytes: asAsync(handlers.responsesStream ?? []),
        };
      },
    };
  }
}

export async function* iterateChatFrames(stream: UpstreamByteStream): AsyncGenerator<ChatStreamFrame> {
  yield* parseChatSse(stream.bytes);
}

export function outboundHeaders(token: string, extra?: Headers): Headers {
  const headers = new Headers(copilotHeaders());
  headers.set("authorization", `Bearer ${token}`);
  if (extra !== undefined) {
    extra.forEach((value, key) => {
      const name = key.toLowerCase();
      if (
        name === "authorization"
        || name === "copilot-integration-id"
        || name === "editor-version"
        || name === "editor-plugin-version"
        || name === "user-agent"
        || name === "x-github-api-version"
      ) {
        return;
      }
      headers.set(key, value);
    });
  }
  return headers;
}

async function* asAsync(parts: Uint8Array[] | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in parts) {
    yield* parts;
    return;
  }
  for (const part of parts) {
    yield part;
  }
}
