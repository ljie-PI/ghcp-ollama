import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentsManager, type AgentManagerOptions } from "../../src/agents/manager.js";
import type { AgentId, AgentMapping, AgentModel } from "../../src/agents/types.js";
import { AgentStore, type AgentState } from "../../src/agents/store.js";

const homes: string[] = [];
const origin = "http://127.0.0.1:32567";
const effective = <T>(value: T) => ({ value, source: "live" as const, conflict: false, liveState: "value" as const });
const models: readonly AgentModel[] = ["model-a", "model-b", "model-c"].map((modelId) => ({
  modelId,
  protocols: effective(["responses"] as const),
  capabilities: {
    contextWindowTokens: 32000,
    maxContextWindowTokens: 32000,
    reasoningLevels: [],
    reasoningProtocols: [],
    inputModalities: ["text"],
    toolCalling: false,
    parallelToolCalling: false,
    reasoningSummaries: false,
    verbosity: false,
    search: false,
  },
}));
const mappings = models.map((model) => ({ displayName: `Label ${model.modelId}`, modelId: model.modelId }));
function harness(options: Omit<AgentManagerOptions, "home"> = {}) {
  // Legacy images use the same canonical home anchor as the production manager.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-")));
  homes.push(home);
  const manager = new FileAgentsManager({ home, now: () => new Date("2026-01-02T03:04:05Z"), ...options });
  const status = async (agent: AgentId) => (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return { home, manager, status };
}
async function apply(manager: FileAgentsManager, agent: AgentId, rows: readonly AgentMapping[] = mappings) {
  const status = (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return await manager.apply({ agent, expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings: rows }, origin, models, () => undefined, new AbortController().signal);
}
function seed(home: string, target: string, bytes: Buffer | string): string {
  const file = path.join(home, target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe("private repeatable agent configuration", () => {
  it("rejects malformed Grok model profiles before creating state or backups", async () => {
    const h = harness();
    const source = "model.personal = 1\n";
    const file = seed(h.home, ".grok/config.toml", source);
    await expect(apply(h.manager, "grokbuild")).rejects.toThrow("agent invalid config");
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.toml"]);
    expect(fs.readdirSync(h.home)).toEqual([".grok"]);
  }, 180_000);
  it("serializes Grok applies and rejects cancellation before durable intent", async () => {
    const h = harness();
    const status = await h.status("grokbuild");
    const request = { agent: "grokbuild" as const, expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings };
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(h.manager.apply(request, origin, models, () => undefined, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readdirSync(h.home)).toEqual([]);
    const second = new FileAgentsManager({ home: h.home });
    try {
      const results = await Promise.allSettled([
        h.manager.apply(request, origin, models, () => undefined, new AbortController().signal),
        second.apply({ ...request, mappings: [...mappings].reverse() }, origin, models, () => undefined, new AbortController().signal),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await h.status("grokbuild")).state).toBe("installed");
    } finally { second.close(); }
  }, 180_000);
  it("refreshes Grok external edits while retaining user models and rejecting reserved-name collisions", async () => {
    const h = harness();
    await apply(h.manager, "grokbuild");
    const file = path.join(h.home, ".grok/config.toml");
    const external = fs.readFileSync(file, "utf8").replace("models.default = \"ghcg-model-a\"", "models.default = \"personal\"")
      + "\n[model.personal]\nmodel = \"own\"\n[mcp_servers.local]\ncommand = \"node\"\n";
    fs.writeFileSync(file, external);
    expect((await h.status("grokbuild")).state).toBe("conflict");
    await apply(h.manager, "grokbuild", mappings.slice(0, 1));
    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("[model.personal]\nmodel = \"own\"\n[mcp_servers.local]\ncommand = \"node\"\n");
    expect(result).not.toContain("ghcg-model-b");
    expect(result).not.toContain("ghcg-model-c");
    const collision = `${result}\n[model."ghcg-unowned"]\nmodel = "own"\n`;
    fs.writeFileSync(file, collision);
    await expect(apply(h.manager, "grokbuild")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(file, "utf8")).toBe(collision);
  }, 180_000);
  it.each(["intent", "stage_written", "displaced", "published", "complete"] as const)("recovers Grok single-file Apply interrupted at %s", async (boundary) => {
    let failed = false;
    const h = harness({ checkpoint: (point) => {
      if (point === boundary && !failed) { failed = true; throw new Error("injected interruption"); }
    } });
    seed(h.home, ".grok/config.toml", "# original\n[mcp_servers.local]\ncommand = \"node\"\n");
    await expect(apply(h.manager, "grokbuild")).rejects.toThrow("agent recovery required");
    h.manager.close();
    const manager = new FileAgentsManager({ home: h.home });
    try {
      expect((await apply(manager, "grokbuild")).state).toBe("installed");
      expect(fs.readFileSync(path.join(h.home, ".grok/config.toml"), "utf8")).toContain("[mcp_servers.local]\ncommand = \"node\"\n");
      expect(fs.readdirSync(path.join(h.home, ".grok")).some((name) => name.startsWith(".ghcg-agents-"))).toBe(false);
    } finally { manager.close(); }
  }, 180_000);
  it("rejects unsafe Grok directories and stale revisions without writing configuration", async () => {
    const h = harness();
    const status = await h.status("grokbuild");
    await expect(h.manager.apply({ agent: "grokbuild", expectedRevision: "0".repeat(64), catalogRevision: "a".repeat(64), mappings },
      origin, models, () => undefined, new AbortController().signal)).rejects.toThrow("revision conflict");
    expect(fs.readdirSync(h.home)).toEqual([]);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-grok-elsewhere-"));
    homes.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(h.home, ".grok"), process.platform === "win32" ? "junction" : "dir");
    expect(status.state).toBe("not_managed");
    await expect(apply(h.manager, "grokbuild")).rejects.toThrow("agent unsafe path");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  }, 180_000);
  it("installs Grok Build with one backed-up file and leaves its authentication and other settings untouched", async () => {
    const h = harness();
    const original = "# Grok settings\r\n[mcp_servers.local]\r\ncommand = \"node\"\r\n";
    const file = seed(h.home, ".grok/config.toml", original);
    const auth = seed(h.home, ".grok/auth.json", "{\"client-owned\":true}\n");
    const result = await apply(h.manager, "grokbuild");
    expect(result.state).toBe("installed");
    expect(result.paths).toHaveLength(1);
    expect(result.endpoint).toBe(`${origin}/v1`);
    expect(result.takeover).toBeNull();
    expect(result.backupAvailable).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain(original);
    expect(fs.readFileSync(auth, "utf8")).toBe("{\"client-owned\":true}\n");
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("config.toml.ghcg."));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups[0]!), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(path.dirname(file), "models.json"))).toBe(false);
    h.manager.close();
    const reopened = new FileAgentsManager({ home: h.home });
    try { expect((await reopened.inspect(origin)).find((item) => item.id === "grokbuild")!.state).toBe("installed"); }
    finally { reopened.close(); }
  }, 180_000);
  it.each(["missing", "replaced"] as const)("reports %s live configuration without disabling a fresh Apply", async (change) => {
    const h = harness();
    const file = seed(h.home, ".claude/settings.json", "{}\n");
    await apply(h.manager, "claude");
    if (change === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.test" } }));
    expect((await h.status("claude")).state).toBe("conflict");
    expect((await apply(h.manager, "claude")).state).toBe("installed");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL).toBe(origin);
  }, 180_000);

  it("rejects a pre-intent cancellation without creating a backup or config", async () => {
    const h = harness();
    const status = await h.status("codex");
    const controller = new AbortController();
    controller.abort();
    await expect(h.manager.apply({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readdirSync(h.home)).toEqual([]);
  }, 180_000);
  it("reads without creating any directories and rejects invalid parsing before writes", async () => {
    const h = harness();
    expect((await h.status("codex")).state).toBe("not_managed");
    expect(fs.readdirSync(h.home)).toEqual([]);
    seed(h.home, ".codex/config.toml", "token=\"secret\n");
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent invalid config");
    expect(fs.readdirSync(h.home)).toEqual([".codex"]);
  }, 180_000);

  it("preserves outside unrelated edits when a refreshed Apply patches owned fields", async () => {
    const h = harness();
    const original = seed(h.home, ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    await apply(h.manager, "claude");
    const external = Buffer.from(JSON.stringify({ env: { OTHER: "external-edit" } }));
    fs.writeFileSync(original, external);
    expect((await h.status("claude")).state).toBe("conflict");
    await apply(h.manager, "claude");
    expect(JSON.parse(fs.readFileSync(original, "utf8")).env.OTHER).toBe("external-edit");
  }, 180_000);

  it("serializes concurrent applies from two Gateway instances sharing a home", async () => {
    const h = harness();
    const second = new FileAgentsManager({ home: h.home });
    const reversed = [...mappings].reverse();
    const firstStatus = await h.status("claude");
    const [one, two] = await Promise.allSettled([
      h.manager.apply({ agent: "claude", expectedRevision: firstStatus.revision, catalogRevision: "a".repeat(64), mappings }, origin, models, () => undefined, new AbortController().signal),
      second.apply({ agent: "claude", expectedRevision: firstStatus.revision, catalogRevision: "a".repeat(64), mappings: reversed }, origin, models, () => undefined, new AbortController().signal),
    ]);
    const outcomes = [one, two];
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ name: "AgentError" });
    const live = JSON.parse(fs.readFileSync(path.join(h.home, ".claude/settings.json"), "utf8"));
    const winner = one.status === "fulfilled" ? mappings : reversed;
    expect(live.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(winner[0]!.modelId);
    expect((await h.status("claude")).state).toBe("installed");
  }, 300_000);

  it("rejects symlinked configuration directories without writing", async () => {
    const h = harness();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-elsewhere-"));
    homes.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(h.home, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(apply(h.manager, "claude")).rejects.toThrow("agent unsafe path");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  }, 180_000);

  it.skipIf(process.platform === "win32")("accepts a canonicalized home alias but still rejects links below it", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-alias-"));
    homes.push(parent);
    const realHome = path.join(parent, "real-home");
    const aliasHome = path.join(parent, "alias-home");
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(realHome, { mode: 0o700 });
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(realHome, aliasHome, "dir");
    const manager = new FileAgentsManager({ home: aliasHome });
    expect((await manager.inspect(origin)).find((item) => item.id === "claude")!.state).toBe("not_managed");
    fs.symlinkSync(elsewhere, path.join(realHome, ".claude"), "dir");
    await expect(apply(manager, "claude")).rejects.toThrow("agent unsafe path");
  }, 180_000);

  it.skipIf(process.platform === "win32")("rejects world-readable recovery state", async () => {
    const h = harness();
    await apply(h.manager, "claude");
    fs.chmodSync(path.join(h.home, ".ghc-gateway-agents/claude/state.db"), 0o644);
    expect((await h.status("claude")).state).toBe("unsafe_path");
  }, 180_000);
});

function stateRoot(home: string, dataDir = path.join(home, ".ghc-gateway")): string {
  return path.join(dataDir, "agents");
}

function legacyStateRoot(home: string): string {
  return path.join(home, ".ghc-gateway-agents");
}

async function saveState(root: string, agent: AgentId, state: AgentState): Promise<void> {
  await new AgentStore(root, agent).locked(async (save) => save(state));
}

function homeWithCrash(): string {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-")));
  homes.push(home);
  return home;
}

describe("Agent migration and hostile filesystem evidence", () => {
  it("converges concurrent migration and remains restart-safe", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 9, mappings: [mappings[1]!], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    const one = new FileAgentsManager({ home: h.home });
    const two = new FileAgentsManager({ home: h.home });
    const results = await Promise.allSettled([one.inspect(origin), two.inspect(origin)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")).toMatchObject({
      state: "not_managed",
      mappings: state.mappings,
    });
    expect(await new AgentStore(stateRoot(h.home), "codex").read()).toEqual(state);
  }, 180_000);

  it("rejects a hard-linked legacy state database", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 1, mappings: [], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    const legacyState = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const alias = path.join(h.home, "state-alias.db");
    fs.linkSync(legacyState, alias);
    expect(await h.status("codex")).toMatchObject({ state: "unsafe_path", mappings: [] });
    expect(fs.lstatSync(alias).nlink).toBe(2);
  });

  it("rejects a replaced staged pathname before displacing the live target", async () => {
    const home = homeWithCrash();
    const original = seed(home, ".claude/settings.json", "{}\n");
    let replaced = false;
    const manager = new FileAgentsManager({
      home,
      checkpoint: (point, agent, index) => {
        if (replaced || point !== "staged" || agent !== "claude" || index !== 0) return;
        const scratch = fs.readdirSync(path.dirname(original))
          .filter((entry) => entry.startsWith(".ghcg-agents-claude-"))
          .find((entry) => fs.readFileSync(path.join(path.dirname(original), entry, "next"), "utf8") !== "{}\n");
        if (scratch === undefined) throw new Error("missing scratch");
        const stage = path.join(path.dirname(original), scratch, "next");
        fs.unlinkSync(stage);
        fs.writeFileSync(stage, "replacement");
        replaced = true;
      },
    });

    await expect(apply(manager, "claude")).rejects.toMatchObject({ code: "agent_recovery_required" });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(original, "utf8")).toBe("{}\n");
  }, 180_000);
});
