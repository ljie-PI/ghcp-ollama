import { parse, stringify } from "smol-toml";
import { parseForESLint, getStaticTOMLValue, type AST } from "toml-eslint-parser";
import { AgentError, type AgentMapping, type AgentModel } from "./types.js";

interface Edit { readonly start: number; readonly end: number; readonly text: string }

function table(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("agent_invalid_config");
  return value as Record<string, unknown>;
}

// Profile identifiers are local client labels; the request model is always the Copilot ID.
function profile(modelId: string): string { return `ghcg-${modelId}`; }

export function projectGrok(
  source: string, mappings: readonly AgentMapping[], origin: string, models: readonly AgentModel[], managedConfig: Buffer | null,
): Buffer {
  const config = parse(source);
  table(config.models);
  const entries = table(config.model);
  const previous = managedConfig === null ? {} : table(parse(managedConfig.toString("utf8")).model);
  const owned = new Set(Object.keys(previous).filter((name) => name.startsWith("ghcg-")));
  for (const name of Object.keys(entries)) {
    if (name.startsWith("ghcg-") && !owned.has(name)) throw new AgentError("agent_conflict");
  }
  const generated = Object.fromEntries(mappings.map((mapping) => {
    const context = models.find((model) => model.modelId === mapping.modelId)!.capabilities.contextWindowTokens;
    if (context === null || !Number.isSafeInteger(context) || context <= 0) throw new AgentError("agent_models_unavailable");
    return [profile(mapping.modelId), {
      name: mapping.displayName, model: mapping.modelId, base_url: `${origin}/v1`,
      api_key: "ghcg-local", api_backend: "responses", context_window: context,
    }];
  }));
  // AST ranges let untouched text (including comments, multiline strings and CRLF)
  // survive exactly. Ambiguous inline root containers fail closed instead of being rebuilt.
  const { ast } = parseForESLint(source, { tomlVersion: "1.0" });
  const edits: Edit[] = [];
  const lineEnd = (end: number): number => {
    const newline = source.indexOf("\n", end);
    return newline === -1 ? source.length : newline + 1;
  };
  let defaultFound = false;
  let modelsTable: AST.TOMLTable | undefined;
  const selected = JSON.stringify(profile(mappings[0]!.modelId));
  const inspectValue = (node: AST.TOMLKeyValue, parent: readonly (string | number)[]): void => {
    const keys = [...parent, ...getStaticTOMLValue(node.key)];
    if ((keys[0] === "models" || keys[0] === "model") && keys.length === 1) throw new AgentError("agent_invalid_config");
    if (keys[0] === "model" && typeof keys[1] === "string" && owned.has(keys[1])) {
      edits.push({ start: node.range[0], end: lineEnd(node.range[1]), text: "" });
    } else if (keys.length === 2 && keys[0] === "models" && keys[1] === "default") {
      edits.push({ start: node.value.range[0], end: node.value.range[1], text: selected });
      defaultFound = true;
    }
  };
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLKeyValue") { inspectValue(node, []); continue; }
    if (node.resolvedKey[0] === "model" && typeof node.resolvedKey[1] === "string" && owned.has(node.resolvedKey[1])) {
      edits.push({ start: node.range[0], end: lineEnd(node.range[1]), text: "" });
      continue;
    }
    if (node.resolvedKey.length === 1 && node.resolvedKey[0] === "models") modelsTable = node;
    for (const value of node.body) inspectValue(value, node.resolvedKey);
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  if (!defaultFound) {
    const position = modelsTable?.range[1] ?? 0;
    edits.push({ start: position, end: position, text: modelsTable === undefined
      ? `models.default = ${selected}${newline}` : `${newline}default = ${selected}${newline}` });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  result += `${result.endsWith("\n") ? "" : newline}${stringify({ model: generated }).replaceAll("\n", newline)}`;
  parse(result);
  return Buffer.from(result);
}
