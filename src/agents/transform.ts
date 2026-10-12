import { parse, stringify, type TomlTable } from "smol-toml";
import { supportsModelReasoning } from "../copilot/model_capabilities.js";
import { protocolTargets } from "../protocols/conversion/routing.js";
import { CODEX_BASE_INSTRUCTIONS } from "./codex_instructions.js";
import { AgentError, validateMappings, type AgentId, type AgentMapping, type AgentModel } from "./types.js";

export interface AgentProjection {
  readonly config: Buffer;
  readonly catalog?: Buffer;
}

export function validateCodexTakeover(source: Buffer | null): void {
  try {
    const config = source === null ? {} as TomlTable : parse(source.toString("utf8").replace(/^\uFEFF/u, ""));
    if (config.profile !== undefined || config.profiles !== undefined || config.agents !== undefined) {
      throw new AgentError("agent_invalid_config");
    }
    if (config.model_providers !== undefined) object(config.model_providers);
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("agent_invalid_config");
  }
}

// These are client labels, never aliases in Gateway model resolution.
export function projectAgent(
  agent: AgentId,
  original: Buffer | null,
  mappings: readonly AgentMapping[],
  origin: string,
  catalogPath: string,
  models: readonly AgentModel[],
  managedConfig: Buffer | null,
  takeover = false,
): AgentProjection {
  validateMappings(agent, mappings);
  if (!isLoopbackOrigin(origin)) {
    throw new AgentError("validation_failed");
  }
  if (mappings.some((mapping) => !models.some((model) => model.modelId === mapping.modelId))) {
    throw new AgentError("agent_models_unavailable");
  }
  try {
    const source = original?.toString("utf8").replace(/^\uFEFF/u, "") ?? "";
    switch (agent) {
    case "claude": return { config: projectClaude(source, mappings, origin) };
    case "codex": return projectCodex(source, mappings, origin, catalogPath, models, managedConfig !== null, takeover);
    case "grokbuild": return { config: projectGrok(source, mappings, origin, models, managedConfig) };
    }
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    // Parser diagnostics can contain configuration secrets.
    throw new AgentError("agent_invalid_config");
  }
}

function isLoopbackOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === value
    && parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === "";
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("agent_invalid_config");
  return value as Record<string, unknown>;
}

function responsesReasoningLevels(model: AgentModel): AgentModel["capabilities"]["reasoningLevels"] {
  return model.protocols.value !== null
    && protocolTargets("responses", model.protocols.value).some((target) => supportsModelReasoning(model.capabilities, target))
    ? model.capabilities.reasoningLevels
    : [];
}

function projectClaude(source: string, mappings: readonly AgentMapping[], origin: string): Buffer {
  const config = source === "" ? {} : object(JSON.parse(source));
  const env = config.env === undefined ? {} : object(config.env);
  if (Object.values(env).some((value) => typeof value !== "string")) throw new AgentError("agent_invalid_config");
  // Replace only the keys that route/authenticate Claude Code or pin models.
  // Stale credentials or a Bedrock/Vertex/Foundry override would bypass the
  // Gateway; unrelated keys (for example ANTHROPIC_CUSTOM_HEADERS) and the
  // original bytes are retained in the first backup.
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ]) delete env[key];
  delete config.apiKeyHelper;
  delete config.awsAuthRefresh;
  delete config.awsCredentialExport;
  delete config.forceLoginMethod;
  delete config.forceLoginOrgUUID;
  // Settings-level model takes precedence over startup defaults in some client releases.
  config.model = mappings[0]!.modelId;
  env.ANTHROPIC_BASE_URL = origin;
  env.ANTHROPIC_AUTH_TOKEN = "ghcg-local";
  env.ANTHROPIC_MODEL = mappings[0]!.modelId;
  env.ANTHROPIC_SMALL_FAST_MODEL = mappings[2]!.modelId;
  for (const [index, role] of ["SONNET", "OPUS", "HAIKU"].entries()) {
    env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = mappings[index]!.modelId;
    env[`ANTHROPIC_DEFAULT_${role}_MODEL_NAME`] = mappings[index]!.displayName;
  }
  config.modelPicker = {
    replaceBuiltInOptions: true,
    options: mappings.filter((row, index) => mappings.findIndex((item) => item.modelId === row.modelId) === index)
      .map((row) => ({ model: row.modelId, label: row.displayName })),
  };
  config.env = env;
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function projectCodex(
  source: string, mappings: readonly AgentMapping[], origin: string, catalogPath: string, models: readonly AgentModel[],
  managed: boolean,
  takeover: boolean,
): AgentProjection {
  const config = source === "" ? {} as TomlTable : parse(source);
  // Profiles and named subagents can override the provider/catalog. Refuse rather than
  // silently configure only the root while another visible selection bypasses Gateway.
  if (config.profile !== undefined || config.profiles !== undefined || config.agents !== undefined) {
    throw new AgentError("agent_invalid_config");
  }
  const providers = config.model_providers === undefined ? {} : object(config.model_providers);
  const reserved = "ghc_gateway";
  if (takeover) {
    // Explicit takeover owns only the root routing/provider/catalog fields.
  } else if (!managed) {
    if (source !== "") throw new AgentError("agent_conflict");
    if (providers[reserved] !== undefined) throw new AgentError("agent_conflict");
  }
  providers[reserved] = {
    name: "GHC Gateway", base_url: `${origin}/v1`, wire_api: "responses",
    experimental_bearer_token: "ghcg-local", requires_openai_auth: false,
  };
  config.model_providers = providers as TomlTable;
  config.model_provider = reserved;
  config.model = mappings[0]!.modelId;
  config.model_catalog_json = catalogPath;
  // These global overrides describe the previous provider's model, not this
  // catalog; leaving them would send unsupported reasoning/context directives.
  for (const key of ["model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "model_context_window",
    "model_auto_compact_token_limit", "model_supports_reasoning_summaries", "review_model", "service_tier"]) delete config[key];
  const catalog = { models: mappings.map((mapping, index) => {
    const model = models.find((item) => item.modelId === mapping.modelId)!;
    const reasoningLevels = responsesReasoningLevels(model);
    return {
      slug: mapping.modelId, display_name: mapping.displayName, description: mapping.displayName,
      base_instructions: CODEX_BASE_INSTRUCTIONS,
      supported_reasoning_levels: reasoningLevels.map((effort) => ({
        effort, description: effort.charAt(0).toUpperCase() + effort.slice(1),
      })),
      shell_type: model.capabilities.toolCalling ? "shell_command" : "disabled", visibility: "list", supported_in_api: true,
      priority: index, support_verbosity: model.capabilities.verbosity,
      supports_reasoning_summaries: model.capabilities.reasoningSummaries,
      supports_reasoning_summary_parameter: model.capabilities.reasoningSummaries,
      ...(model.capabilities.reasoningSummaries ? { default_reasoning_summary: "none" } : {}),
      supports_parallel_tool_calls: model.capabilities.parallelToolCalling,
      supports_image_detail_original: model.capabilities.inputModalities.includes("image"),
      supports_search_tool: model.capabilities.search,
      truncation_policy: { mode: "bytes", limit: 10000 },
      experimental_supported_tools: [], input_modalities: model.capabilities.inputModalities,
      ...(model.capabilities.contextWindowTokens === null ? {} : {
        context_window: model.capabilities.contextWindowTokens,
        max_context_window: model.capabilities.maxContextWindowTokens ?? model.capabilities.contextWindowTokens,
        ...(model.capabilities.maxContextWindowTokens === null ? {} : {
          effective_context_window_percent: 100,
        }),
      }),
    };
  }) };
  const result = stringify(config);
  parse(result);
  return { config: Buffer.from(result), catalog: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`) };
}

function table(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const result = object(value);
  if (value instanceof Date) throw new AgentError("agent_invalid_config");
  return result;
}

// Profile identifiers are local client labels; the request model is always the Copilot ID.
function profile(modelId: string): string { return `ghcg-${modelId}`; }

function projectGrok(
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
    const model = models.find((candidate) => candidate.modelId === mapping.modelId)!;
    const context = model.capabilities.contextWindowTokens;
    if (context === null || !Number.isSafeInteger(context) || context <= 0) throw new AgentError("agent_models_unavailable");
    const reasoningLevels = responsesReasoningLevels(model);
    return [profile(mapping.modelId), {
      name: mapping.displayName, model: mapping.modelId, base_url: `${origin}/v1`,
      api_key: "ghcg-local", api_backend: "responses", context_window: context,
      supports_reasoning_effort: reasoningLevels.length > 0,
      reasoning_efforts: reasoningLevels.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
      reasoning_summary: model.capabilities.reasoningSummaries ? "concise" : "none",
    }];
  }));
  for (const name of owned) delete entries[name];
  // Grok otherwise uses its built-in model for session titles, independently of the selected model.
  if (defaults.session_summary === undefined
    || (typeof defaults.session_summary === "string" && owned.has(defaults.session_summary))) {
    defaults.session_summary = profile(mappings[0]!.modelId);
  }
  config.models = { ...defaults, default: profile(mappings[0]!.modelId) } as TomlTable;
  config.model = { ...entries, ...generated } as TomlTable;
  const result = stringify(config);
  parse(result);
  return Buffer.from(result);
}
