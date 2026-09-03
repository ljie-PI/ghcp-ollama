<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AdminStatus, AdminUsagePage } from "../types.js";

  let { client, liveStatus }: { client: AdminClient; liveStatus: AdminStatus | null } = $props();
  let status: AdminStatus | null = $state(null);
  let usage: AdminUsagePage | null = $state(null);
  let loading = $state(true);
  let failure = $state("");
  let current = $derived(liveStatus ?? status);

  onMount(load);
  async function load(): Promise<void> {
    loading = true; failure = "";
    try { [status, usage] = await Promise.all([client.status(), client.usage()]); }
    catch (error: unknown) { failure = errorMessage(error); }
    finally { loading = false; }
  }
  const number = (value: number): string => new Intl.NumberFormat().format(value);
</script>

<header class="page-head"><div><p class="eyebrow">SYSTEM PULSE</p><h1>Overview</h1><p>Health, throughput and pressure at a glance.</p></div><button class="quiet" onclick={load}>Refresh</button></header>
{#if loading}<div class="skeleton-grid" aria-label="Loading overview" aria-busy="true"><i></i><i></i><i></i></div>
{:else if failure}<section class="notice error" role="alert"><strong>Overview unavailable</strong><p>{failure}</p><button onclick={load}>Retry</button></section>
{:else if current && usage}
  {#if current.performance === "degraded"}<section class="degraded" role="status"><div><p class="eyebrow">PERFORMANCE WATCH</p><h2>Gateway is degraded</h2></div><p>Health remains OK. Limits and routing are unchanged while metrics recover.</p></section>{/if}
  <section class="hero-metrics" aria-label="Gateway status">
    <article class="health-card"><span class="status-dot"></span><p>Gateway health</p><strong>{current.health === "ok" ? "Nominal" : current.health}</strong><small>v{current.version} · up {Math.floor(current.uptimeMs / 60000)} min</small></article>
    <article><p>Active requests</p><strong>{current.admission.activeRequests}<small> / {current.admission.activeMax}</small></strong><meter min="0" max={current.admission.activeMax} value={current.admission.activeRequests}>{current.admission.activeRequests}</meter></article>
    <article><p>Streaming now</p><strong>{current.admission.activeStreams}</strong><small>{current.admission.queuedRequests} queued</small></article>
  </section>
  <section class="section-block"><div class="section-title"><div><p class="eyebrow">LAST 24 HOURS</p><h2>Usage ledger</h2></div><span class="chip">{usage.items.length} buckets</span></div>
    <div class="stat-row"><div><span>Requests</span><strong>{number(usage.totals.requestCount)}</strong></div><div><span>Errors</span><strong>{number(usage.totals.errorCount)}</strong></div><div><span>Input tokens</span><strong>{number(usage.totals.inputTokens)}</strong></div><div><span>Output tokens</span><strong>{number(usage.totals.outputTokens)}</strong></div></div>
  </section>
  <section class="split-panels">
    <article class="section-block"><div class="section-title"><h2>Performance windows</h2><span class:warning={current.performance === "degraded"} class="chip">{current.performance}</span></div><ul class="metric-list">{#each current.performanceMetrics as metric}<li><span>{metric.metric.replaceAll("_", " ")}</span><strong>{metric.actual === null ? "Collecting" : `${metric.actual} ms`}</strong><small>limit {metric.threshold} ms</small></li>{/each}</ul></article>
    <article class="section-block"><div class="section-title"><h2>Bounded storage</h2></div><ul class="storage-list"><li><span>Responses history</span><strong>{current.storage.historyCount}</strong></li><li><span>Usage buckets</span><strong>{current.storage.usageBucketCount}</strong></li><li><span>Operational events</span><strong>{current.storage.eventCount} / 512</strong></li></ul></article>
  </section>
{/if}
