import {
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  RESPONSE_REQUEST_CONTROL_FIELDS,
  type ResponsesRequest,
} from "./dto.js";

export class ResponsesRequestDecodeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ResponsesRequestDecodeError";
  }
}

export function decodeResponsesRequest(body: WireJsonObject): ResponsesRequest {
  assertNoDuplicateControlFields(body);

  const model = optionalModel(body);
  const stream = optionalBoolean(body, "stream", false, false);
  const store = optionalBoolean(body, "store", true, true);
  const input = memberValues(body, "input")[0];
  const previous = optionalString(body, "previous_response_id");

  return {
    body,
    ...(model === undefined ? {} : { model }),
    stream,
    store,
    ...(input === undefined ? {} : { input }),
    ...(previous === undefined ? {} : { previousResponseId: previous }),
  };
}

function assertNoDuplicateControlFields(body: WireJsonObject): void {
  const seen = new Set<string>();
  for (const member of body.members) {
    if (!RESPONSE_REQUEST_CONTROL_FIELDS.has(member.key)) {
      continue;
    }
    if (seen.has(member.key)) {
      throw new ResponsesRequestDecodeError(member.key, `duplicate Responses request field: ${member.key}`);
    }
    seen.add(member.key);
  }
}

function optionalModel(body: WireJsonObject): string | undefined {
  const value = memberValues(body, "model")[0];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ResponsesRequestDecodeError("model", "Responses request field model must be a non-empty string when present");
  }
  return value;
}

function optionalString(body: WireJsonObject, field: string): string | undefined {
  const value = memberValues(body, field)[0];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ResponsesRequestDecodeError(field, `Responses request field ${field} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalBoolean(body: WireJsonObject, field: string, defaultValue: boolean, allowNull: boolean): boolean {
  const value = memberValues(body, field)[0];
  if (value === undefined || (allowNull && value === null)) {
    return defaultValue;
  }
  if (value !== true && value !== false) {
    throw new ResponsesRequestDecodeError(field, `Responses request field ${field} must be a boolean or null`);
  }
  return value;
}

export function wireJsonString(value: WireJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
