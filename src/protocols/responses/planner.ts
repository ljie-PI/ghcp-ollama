import type { CopilotTarget } from "../../copilot/backend.js";
import type { ResolvedModel } from "../model_catalog/resolver.js";
import type { ResponsesRequest } from "./dto.js";

export type ResponsesExecutionPlan = NativeResponsesPlan | ChatBridgePlan;

export interface NativeResponsesPlan {
  readonly kind: "native_responses";
  readonly originalRequest: ResponsesRequest;
  readonly resolvedModel: ResolvedModel;
  readonly upstreamUrl: string;
  readonly stream: boolean;
}

export interface ChatBridgePlan {
  readonly kind: "chat_bridge";
  readonly originalRequest: ResponsesRequest;
  readonly resolvedModel: ResolvedModel;
}

export function planResponsesExecution(
  request: ResponsesRequest,
  resolvedModel: ResolvedModel,
  target: Readonly<CopilotTarget>,
): ResponsesExecutionPlan {
  if (!usesNativeResponses(resolvedModel.routing)) {
    return { kind: "chat_bridge", originalRequest: request, resolvedModel };
  }
  return {
    kind: "native_responses",
    originalRequest: request,
    resolvedModel,
    upstreamUrl: responsesUpstreamUrl(target.endpoint),
    stream: request.stream,
  };
}

export function responsesUpstreamUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/responses`;
}

function usesNativeResponses(routing: ResolvedModel["routing"]): boolean {
  if (routing.mode === "responses") {
    return true;
  }
  if (routing.mode === "chat") {
    return false;
  }
  return routing.supportedEndpoints?.includes("/v1/responses") === true;
}
