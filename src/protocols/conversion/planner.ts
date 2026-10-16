import {
  CustomToolsUnsupportedError,
  ModelCapabilityUnavailableError,
  resolveModelReasoningEffort,
  supportsResponsesCustomTools,
  type SupportedReasoningEffort,
} from "../../copilot/model_capabilities.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { PROTOCOL_REQUEST_CODECS } from "./request/index.js";
import { protocolTargets } from "./routing.js";
import { diagnosticShape } from "./diagnostics.js";
import {
  ConversionContractError,
  type ConversionPlanningInput,
  type EncodedConversionRequest,
  type InferenceProtocol,
  type ProtocolExecutionPlan,
  type SemanticRequest,
} from "./types.js";

/** The single rule for selecting a native plan; callers that must predict it use this too. */
export function plansNativeExecution(
  protocols: readonly InferenceProtocol[] | null,
  source: InferenceProtocol,
  forcedTarget: InferenceProtocol | undefined,
): boolean {
  return protocols?.includes(source) === true && (forcedTarget === undefined || forcedTarget === source);
}

export function planProtocolExecution(input: Readonly<ConversionPlanningInput>): ProtocolExecutionPlan {
  input.diagnostics?.stage("planning");
  const protocols = input.capability.protocols.value;
  if (protocols === null) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      cause: new ModelCapabilityUnavailableError(),
    });
  }

  if (plansNativeExecution(protocols, input.source, input.forcedTarget)) {
    return observeNativePlan(input);
  }

  const candidates = input.forcedTarget === undefined
    ? protocolTargets(input.source, protocols)
    : protocols.includes(input.forcedTarget)
      ? [input.forcedTarget]
      : [];
  if (candidates.length === 0) {
    throw unsupportedFailure();
  }

  let decoded: SemanticRequest;
  try {
    decoded = PROTOCOL_REQUEST_CODECS[input.source].decode(input.body, input.carrierRecords);
  } catch (error: unknown) {
    throw contractFailure(error);
  }

  const orderedCandidates = decoded.reasoning === undefined
    ? candidates
    : [...candidates].sort((left, right) => reasoningTargetRank(
      input.capability,
      right,
      decoded.reasoning?.effort,
    ) - reasoningTargetRank(input.capability, left, decoded.reasoning?.effort));
  let lastUnsupported: ConversionContractError | undefined;
  for (const target of orderedCandidates) {
    if (target === input.source) {
      return observeNativePlan(input);
    }
    try {
      const request = PROTOCOL_REQUEST_CODECS[target].encode(decoded, {
        resolvedModel: input.resolvedModel,
        capability: input.capability,
      });
      return observePlan(input, Object.freeze({
        kind: "converted",
        source: input.source,
        target,
        stream: input.stream,
        requestModel: input.resolvedModel,
        request,
      }));
    } catch (error: unknown) {
      if (error instanceof ConversionContractError && error.kind === "unsupported_semantics") {
        input.diagnostics?.stage("planning", { candidateProtocol: target, ruleId: error.ruleId });
        lastUnsupported = error;
        continue;
      }

      throw contractFailure(error);
    }
  }
  throw new GatewayFailureError({
    kind: "unsupported_semantics",
    source: "converter",
    phase: "convert",
    cause: lastUnsupported,
  });
}

function observePlan(input: Readonly<ConversionPlanningInput>, plan: ProtocolExecutionPlan): ProtocolExecutionPlan {
  const diagnostics = input.diagnostics;
  diagnostics?.set({ upstreamProtocol: plan.target, converted: plan.kind === "converted", stream: plan.stream });
  diagnostics?.shape("planning", () => diagnosticShape(plan.kind === "converted" ? plan.request.body : input.body));
  if (plan.kind === "converted") diagnostics?.stage("planning", { degradations: plan.request.degradations });
  return plan;
}

function assertNativeCustomToolSupport(input: Readonly<ConversionPlanningInput>): void {
  if (input.source !== "responses" || supportsResponsesCustomTools(input.capability.vendor)) {
    return;
  }
  if (!declaresCustomTool(input.body)) {
    return;
  }
  throw new GatewayFailureError({
    kind: "unsupported_semantics",
    source: "converter",
    phase: "convert",
    cause: new CustomToolsUnsupportedError(),
  });
}

function observeNativePlan(input: Readonly<ConversionPlanningInput>): ProtocolExecutionPlan {
  assertNativeCustomToolSupport(input);
  return observePlan(input, Object.freeze({
    kind: "native",
    source: input.source,
    target: input.source,
    stream: input.stream,
  }));
}

function declaresCustomTool(body: WireJsonObject): boolean {
  return memberValues(body, "tools").some((tools) => isWireJsonArray(tools) && tools.items.some((tool) => (
    isWireJsonObject(tool) && memberValues(tool, "type").some((type) => type === "custom")
  )));
}

function reasoningTargetRank(
  capability: ConversionPlanningInput["capability"],
  target: InferenceProtocol,
  effort: SupportedReasoningEffort | undefined,
): number {
  const resolution = resolveModelReasoningEffort(capability.capabilities, target, effort);
  return resolution.kind === "exact" ? 2 : resolution.kind === "coarsened" ? 1 : 0;
}

export function prepareConvertedRequest(
  source: InferenceProtocol,
  target: InferenceProtocol,
  body: WireJsonObject,
  resolvedModel: string,
  capability: ConversionPlanningInput["capability"],
): EncodedConversionRequest {
  try {
    const decoded = PROTOCOL_REQUEST_CODECS[source].decode(body);
    return PROTOCOL_REQUEST_CODECS[target].encode(decoded, { resolvedModel, capability });
  } catch (error: unknown) {
    throw contractFailure(error);
  }
}

function contractFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (error instanceof ConversionContractError) {
    return new GatewayFailureError({
      kind: error.kind,
      source: "converter",
      phase: "convert",
      cause: error,
    });
  }
  return new GatewayFailureError({
    kind: "internal",
    source: "converter",
    phase: "convert",
    cause: error,
  });
}

function unsupportedFailure(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "unsupported_semantics",
    source: "converter",
    phase: "convert",
  });
}
