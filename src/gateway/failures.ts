export type GatewayFailure =
  | { readonly kind: "invalid_request"; readonly cause?: unknown }
  | { readonly kind: "body_too_large"; readonly cause?: unknown }
  | { readonly kind: "unsupported_media_type"; readonly cause?: unknown }
  | { readonly kind: "unsupported_semantics"; readonly cause?: unknown }
  | { readonly kind: "authentication"; readonly cause?: unknown }
  | { readonly kind: "permission"; readonly cause?: unknown }
  | { readonly kind: "model_not_found"; readonly cause?: unknown }
  | { readonly kind: "queue_full" }
  | { readonly kind: "queue_timeout" }
  | { readonly kind: "upstream_http"; readonly status: number; readonly retryAfter?: string }
  | { readonly kind: "upstream_timeout"; readonly cause?: unknown }
  | { readonly kind: "upstream_network"; readonly cause?: unknown }
  | { readonly kind: "upstream_stream_error"; readonly cause?: unknown }
  | { readonly kind: "upstream_stream_truncated"; readonly cause?: unknown }
  | { readonly kind: "invalid_upstream_response"; readonly cause?: unknown }
  | { readonly kind: "invalid_tool_arguments"; readonly cause?: unknown }
  | { readonly kind: "invalid_logprobs"; readonly cause?: unknown }
  | { readonly kind: "aborted" }
  | { readonly kind: "internal"; readonly cause?: unknown };

export class GatewayFailureError extends Error {
  constructor(readonly failure: GatewayFailure) {
    super(failure.kind);
    this.name = "GatewayFailureError";
  }
}

export function isGatewayFailureError(error: unknown): error is GatewayFailureError {
  return error instanceof GatewayFailureError;
}

export function failureFromUnknown(error: unknown): GatewayFailure {
  if (isGatewayFailureError(error)) {
    return error.failure;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "aborted" };
  }
  return { kind: "internal", cause: error };
}
