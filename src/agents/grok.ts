import { parse, stringify, type TomlTable } from "smol-toml";
import { AgentError, type AgentMapping, type AgentModel } from "./types.js";

function table(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) throw new AgentError("agent_invalid_config");
  return value as Record<string, unknown>;
}

// Profile identifiers are local client labels; the request model is always the Copilot ID.
function profile(modelId: string): string { return `ghcg-${modelId}`; }

export function projectGrok(
  source: string, mappings: readonly AgentMapping[], origin: string, models: readonly AgentModel[], managedConfig: Buffer | null,
): Buffer {
  const config = parse(source);
  const defaults = table(config.models);
  const entries = table(config.model);
  for (const entry of Object.values(entries)) table(entry);
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
  for (const name of owned) delete entries[name];
  config.models = { ...defaults, default: profile(mappings[0]!.modelId) } as TomlTable;
  config.model = { ...entries, ...generated } as TomlTable;
  const result = stringify(config);
  parse(result);
  return Buffer.from(result);
}
