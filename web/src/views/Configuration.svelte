<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminRuntimeConfig } from "../types.js";

  let { client }: { client: AdminClient } = $props();
  let data: AdminRuntimeConfig | null = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let failure = $state("");
  let message = $state("");

  const fields = [
    ["limits.requestBodyBytes", "Request body", "Maximum inbound JSON bytes"], ["limits.sseEventBytes", "SSE event", "Maximum upstream event bytes"],
    ["limits.nonstreamBodyBytes", "Non-stream body", "Maximum buffered upstream bytes"], ["limits.accumulatorBytes", "Accumulator", "Per-request protocol state"],
    ["admission.activeMax", "Active requests", "Concurrent inference permits"], ["admission.queueMax", "Queued requests", "Waiting request capacity"],
    ["timeouts.queueMs", "Queue wait", "Admission deadline"], ["timeouts.connectMs", "Connect", "Upstream connection deadline"],
    ["timeouts.firstByteMs", "First byte", "Upstream response deadline"], ["timeouts.streamIdleMs", "Stream idle", "Inter-event deadline"],
    ["timeouts.totalMs", "Total request", "End-to-end deadline"], ["accounts.maxAuthenticated", "Accounts", "Authenticated account capacity"],
    ["history.ttlDays", "History TTL", "Responses bridge retention"], ["usage.retentionDays", "Usage retention", "Hourly aggregate retention"], ["events.retentionDays", "Event retention", "Operational event retention"],
  ] as const;
  const groups = ["limits", "admission", "timeouts", "accounts", "history", "usage", "events"] as const;

  onMount(load);
  async function load(): Promise<void> { loading = true; failure = ""; try { data = await client.config(); } catch (e) { failure = errorMessage(e); } finally { loading = false; } }
  function value(key: string): number { const [group, item] = key.split("."); return (data!.config as unknown as Record<string, Record<string, number>>)[group!]![item!]!; }
  function update(key: string, next: string): void { const [group, item] = key.split("."); (data!.config as unknown as Record<string, Record<string, number>>)[group!]![item!] = Number(next); }
  async function save(): Promise<void> { if (!data) return; saving = true; failure = ""; message = ""; try { data = await client.saveConfig(data); message = "Runtime configuration applied atomically."; } catch (e) { const notice = errorMessage(e); if (e instanceof ApiError && e.status === 409) await load(); failure = notice; } finally { saving = false; } }
</script>

<header class="page-head"><div><p class="eyebrow">RUNTIME ENVELOPE</p><h1>Configuration</h1><p>Revision-safe limits, admission and retention controls.</p></div>{#if data}<span class="revision">REVISION {data.revision}</span>{/if}</header>
{#if message}<p class="notice success" role="status">{message}</p>{/if}{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
{#if loading}<p class="loading-line" aria-busy="true">Loading runtime configuration...</p>
{:else if data}<form class="config-form" onsubmit={(e) => { e.preventDefault(); void save(); }}>
  {#each groups as group}<fieldset><legend>{group}</legend><div class="config-grid">{#each fields.filter((field) => field[0].startsWith(`${group}.`)) as field}<label><span><strong>{field[1]}</strong><small>{field[2]}</small></span><input type="number" value={value(field[0])} min={data.ranges[field[0]]?.min} max={data.ranges[field[0]]?.max} required oninput={(e) => update(field[0], e.currentTarget.value)} /><small class="range">{data.ranges[field[0]]?.min.toLocaleString()}–{data.ranges[field[0]]?.max.toLocaleString()} {data.ranges[field[0]]?.unit}</small></label>{/each}</div></fieldset>{/each}
  <div class="sticky-save"><p>All fields are required. Invalid candidates leave the active snapshot unchanged.</p><button class="primary" disabled={saving}>{saving ? "Applying..." : "Apply configuration"}</button></div>
</form>{/if}
