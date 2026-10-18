import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentsManager, type AgentManagerOptions } from "../../src/agents/manager.js";
import type { AgentId, AgentMapping, AgentModel } from "../../src/agents/types.js";
import { AgentStore } from "../../src/agents/store.js";

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
    fs.chmodSync(path.join(stateRoot(h.home), "claude", "state.db"), 0o644);
    expect((await h.status("claude")).state).toBe("unsafe_path");
  }, 180_000);
});

function stateRoot(home: string, dataDir = path.join(home, ".ghc-gateway")): string {
  return path.join(dataDir, "agents");
}

function homeWithCrash(): string {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-")));
  homes.push(home);
  return home;
}

describe("Agent state storage and hostile filesystem evidence", () => {
  it.each([
    ["claude", "default"], ["codex", "default"], ["grokbuild", "default"],
    ["claude", "custom"], ["codex", "custom"], ["grokbuild", "custom"],
  ] as const)("keeps %s state only in the %s data directory across Apply and restart", async (agent, location) => {
    const h = harness();
    const dataName = location === "default" ? ".ghc-gateway" : "gateway-data";
    const dataDir = path.join(h.home, dataName);
    const manager = new FileAgentsManager({ home: h.home, dataDir });
    expect((await manager.inspect(origin)).every((item) => item.state === "not_managed")).toBe(true);
    expect(fs.readdirSync(h.home)).toEqual([]);
    expect((await apply(manager, agent)).state).toBe("installed");
    const root = stateRoot(h.home, dataDir);
    const saved = await new AgentStore(root, agent).read();
    expect(saved).toMatchObject({ version: 4, revision: 1, mappings, pending: null });
    expect(fs.readdirSync(root)).toEqual([agent]);
    expect(fs.readdirSync(path.join(root, agent)).sort()).toEqual(["lock.db", "state.db"]);
    manager.close();
    const restarted = new FileAgentsManager({ home: h.home, dataDir });
    expect((await restarted.inspect(origin)).find((item) => item.id === agent)).toMatchObject({
      state: "installed", mappings,
    });
    expect(await new AgentStore(root, agent).read()).toEqual(saved);
    expect((await apply(restarted, agent, [...mappings].reverse())).state).toBe("installed");
    const configName = agent === "claude" ? ".claude" : agent === "codex" ? ".codex" : ".grok";
    expect(fs.readdirSync(h.home).sort()).toEqual([configName, dataName].sort());
    restarted.close();
  }, 180_000);

  it.each(["default", "custom"] as const)("keeps Codex Takeover state only in the %s data directory", async (location) => {
    const h = harness();
    const dataName = location === "default" ? ".ghc-gateway" : "gateway-data";
    const dataDir = path.join(h.home, dataName);
    seed(h.home, ".codex/models.json", "{\"models\":[]}\n");
    seed(h.home, ".codex/config.toml", "model=\"external\"\n");
    const manager = new FileAgentsManager({ home: h.home, dataDir });
    const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
    expect(status.takeover).not.toBeNull();
    expect(fs.readdirSync(h.home)).toEqual([".codex"]);
    expect((await manager.takeover({
      agent: "codex", expectedRevision: status.revision, takeoverRevision: status.takeover!.revision,
      catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal)).state).toBe("installed");
    manager.close();
    const restarted = new FileAgentsManager({ home: h.home, dataDir });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")?.state).toBe("installed");
    expect((await new AgentStore(stateRoot(h.home, dataDir), "codex").read()).targets).toHaveLength(2);
    expect(fs.readdirSync(h.home).sort()).toEqual([".codex", dataName].sort());
    restarted.close();
  }, 180_000);

  it("rejects a hard-linked state database", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const state = path.join(stateRoot(h.home), "codex", "state.db");
    const alias = path.join(h.home, "state-alias.db");
    fs.linkSync(state, alias);
    expect(await h.status("codex")).toMatchObject({ state: "unsafe_path", mappings: [] });
    expect(fs.lstatSync(alias).nlink).toBe(2);
  }, 180_000);

  it.each(["version", "backups", "backup", "kind"] as const)("rejects an invalid %s without resetting durable state", async (field) => {
    const h = harness({
      checkpoint: (point) => { if (point === "intent") throw new Error("interrupted"); },
    });
    await expect(apply(h.manager, "claude")).rejects.toMatchObject({ code: "agent_recovery_required" });
    const file = path.join(stateRoot(h.home), "claude", "state.db");
    const store = new AgentStore(stateRoot(h.home), "claude");
    const state = await store.read();
    const document = JSON.stringify({
      ...state,
      ...(field === "version" ? { version: 999 } : {}),
      ...(field === "backups" ? { targets: state.targets.map((target) => ({ ...target, backups: undefined })) } : {}),
      pending: {
        ...state.pending,
        ...(field === "backup" ? { steps: state.pending!.steps.map((step) => ({ ...step, backup: undefined })) } : {}),
        ...(field === "kind" ? { kind: "invalid" } : {}),
      },
    });
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE state SET document=? WHERE id=1").run(document); }
    finally { db.close(); }
    await expect(store.read()).rejects.toMatchObject({ code: "agent_recovery_required" });
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await restarted.inspect(origin)).find((item) => item.id === "claude")?.state).toBe("recovery_required");
    await expect(apply(restarted, "claude")).rejects.toMatchObject({ code: "agent_recovery_required" });
    const unchanged = new DatabaseSync(file, { readOnly: true });
    try { expect(unchanged.prepare("SELECT document FROM state WHERE id=1").get()?.document).toBe(document); }
    finally { unchanged.close(); }
    expect(fs.readdirSync(h.home)).toEqual([".ghc-gateway"]);
    restarted.close();
  }, 180_000);

  it.each([
    ["intent", -1], ["staged", 0], ["displaced_raw", 0], ["displaced", 0],
    ["linked", 0], ["published", 0], ["cleanup", 0], ["quarantined", 0],
    ["staged", 1], ["displaced_raw", 1], ["displaced", 1], ["linked", 1],
    ["published", 1], ["cleanup", 1], ["quarantined", 1],
  ] as const)("recovers a current Apply interrupted at %s for target %s", async (boundary, target) => {
    const h = harness();
    await apply(h.manager, "codex");
    const root = stateRoot(h.home);
    const previous = await new AgentStore(root, "codex").read();
    h.manager.close();
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (point === boundary && agent === "codex" && index === target) throw new Error("interrupted");
      },
    });
    const nextMappings = [...mappings].reverse();
    await expect(apply(manager, "codex", nextMappings)).rejects.toMatchObject({ code: "agent_recovery_required" });
    manager.close();
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")?.state).toBe("recovery_required");
    expect((await apply(restarted, "codex", nextMappings)).state).toBe("installed");
    const recovered = await new AgentStore(root, "codex").read();
    expect(recovered).toMatchObject({ version: 4, revision: 3, mappings: nextMappings, pending: null });
    for (const [index, entry] of recovered.targets.entries()) {
      expect(fs.readFileSync(entry.path).toString("base64")).toBe(entry.expected!.bytes);
      expect(entry.backups.some((backup) => fs.readFileSync(backup.path).toString("base64") === previous.targets[index]!.expected!.bytes)).toBe(true);
      expect(fs.readdirSync(path.dirname(entry.path)).some((name) => name.startsWith(".ghcg-agents-"))).toBe(false);
    }
    expect(fs.readdirSync(h.home).sort()).toEqual([".codex", ".ghc-gateway"]);
    restarted.close();
  }, 180_000);

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
