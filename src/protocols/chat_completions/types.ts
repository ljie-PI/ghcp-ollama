import type { WireJson } from "../../serialization/wire_json.js";

export interface ChatRequest {
  readonly model: string;
  readonly body: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
  readonly nonstreamBodyBytes?: number;
  readonly firstByteTimeoutMs?: number;
  readonly signal: AbortSignal;
}

export interface ChatResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface ChatChunk {
  readonly payload: WireJson;
}

export type ChatStreamFrame =
  | { readonly kind: "chunk"; readonly chunk: ChatChunk }
  | { readonly kind: "error"; readonly value: WireJson | string }
  | { readonly kind: "done" };

export interface NativeResponsesUpstreamRequest {
  readonly body: Uint8Array;
  readonly hasVisionInput: boolean;
  readonly initiator: "user" | "agent";
  readonly signal: AbortSignal;
}

export interface UpstreamByteResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface UpstreamByteStream {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: AsyncIterable<Uint8Array>;
}
