<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminHistorySummary } from "../types.js";
  let { client }: { client: AdminClient } = $props();
  let data: AdminHistorySummary | null = $state(null);
  let loading = $state(true); let clearing = $state(false); let failure = $state(""); let message = $state("");
  onMount(load);
  async function load(): Promise<void> { loading = true; failure = ""; try { data = await client.history(); } catch (e) { failure = errorMessage(e); } finally { loading = false; } }
  async function clear(): Promise<void> { if (!data || !confirm("Clear all retained Responses bridge history?")) return; clearing = true; failure = ""; try { data = await client.clearHistory(data.revision); message = "Responses history cleared."; } catch (e) { failure = errorMessage(e); if (e instanceof ApiError && e.status === 409) await load(); } finally { clearing = false; } }
</script>
<header class="page-head"><div><p class="eyebrow">CONVERSATION CONTINUITY</p><h1>Responses History</h1><p>Inspect bounded bridge checkpoints without exposing response content.</p></div><button class="danger" onclick={clear} disabled={!data?.count || clearing}>{clearing ? "Clearing..." : "Clear history"}</button></header>
{#if message}<p class="notice success" role="status">{message}</p>{/if}{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
{#if loading}<p class="loading-line" aria-busy="true">Inspecting history...</p>{:else if data}<section class="history-orbit"><div class="orb"><strong>{data.count}</strong><span>of {data.maxResponses}</span></div><div><p class="eyebrow">RETAINED CHECKPOINTS</p><h2>{data.count === 0 ? "History is empty" : "History is within bounds"}</h2><p>Only completed semantic checkpoints from bridged Responses are retained. Native Responses never enter this store.</p></div></section><section class="stat-row history-stats"><div><span>Oldest checkpoint</span><strong>{data.oldestAt ? new Date(data.oldestAt).toLocaleString() : "None"}</strong></div><div><span>Newest checkpoint</span><strong>{data.newestAt ? new Date(data.newestAt).toLocaleString() : "None"}</strong></div><div><span>Time to live</span><strong>{data.ttlDays} days</strong></div><div><span>Revision</span><strong>{data.revision}</strong></div></section>{/if}
