<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, AdminModels } from "../types.js";

  let { client }: { client: AdminClient } = $props();
  let accounts: AdminAccounts | null = $state(null);
  let data: AdminModels | null = $state(null);
  let accountId = $state("");
  let loading = $state(true);
  let busy = $state("");
  let failure = $state("");
  let message = $state("");

  onMount(async () => {
    try {
      accounts = await client.accounts();
      accountId = accounts.defaultAccountId
        ?? accounts.items.find((account) => account.state === "active")?.accountId
        ?? "";
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      loading = false;
    }
  });

  async function load(preserveFailure = false): Promise<void> {
    if (!accountId) {
      loading = false;
      data = null;
      return;
    }
    loading = true;
    if (!preserveFailure) failure = "";
    try {
      data = await client.models(accountId);
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!accountId) return;
    busy = "refresh";
    failure = "";
    try {
      data = await client.refreshModels(accountId);
      message = data.preferredModel?.validity === "invalid"
        ? "Catalog refreshed. Your previous preference is no longer available."
        : "Catalog refreshed.";
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      busy = "";
    }
  }

  async function prefer(id: string): Promise<void> {
    if (!data) return;
    busy = id;
    failure = "";
    try {
      await client.preferModel(data.accountId, id, data.preferredModel?.revision ?? 0);
      message = `${id} is now preferred.`;
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      busy = "";
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">CATALOG CONTROL</p>
    <h1 tabindex="-1">Models</h1>
    <p>Inspect capabilities and explicitly select each account's preference.</p>
  </div>
  <button class="primary" onclick={refresh} disabled={!accountId || busy === "refresh"}>
    {busy === "refresh" ? "Refreshing..." : "Refresh catalog"}
  </button>
</header>

<section class="toolbar">
  <label for="model-account">Account</label>
  <select id="model-account" bind:value={accountId} onchange={() => void load()}>
    {#each accounts?.items.filter((account) => account.state === "active") ?? [] as account (account.accountId)}
      <option value={account.accountId}>{account.login ?? account.host} · {account.host}</option>
    {/each}
  </select>
  {#if data}
    <span class="subtle">
      Generation {data.catalogGeneration} · fetched {new Date(data.fetchedAt).toLocaleString()}
    </span>
  {/if}
</section>

{#if message}
  <p class="notice success" role="status">{message}</p>
{/if}
{#if failure}
  <p class="notice error" role="alert">{failure}</p>
{/if}

{#if data?.preferredModel?.validity === "invalid"}
  <section class="notice warning" role="alert">
    <h2>Preferred model unavailable</h2>
    <p>Select a visible model below. The gateway will not silently substitute one.</p>
  </section>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Loading model catalog...</p>
{:else if !accountId}
  <section class="empty">
    <span>--</span>
    <h2>No active account</h2>
    <p>Connect an account before requesting a model catalog.</p>
  </section>
{:else if data?.items.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>Catalog is empty</h2>
    <p>The account returned no visible models. Try an explicit refresh.</p>
  </section>
{:else if data}
  <section class="model-grid" aria-label="Available models">
    {#each data.items as model (model.id)}
      <article class:preferred={data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid"}>
        <div class="model-vendor">{model.vendor}</div>
        <h2>{model.name}</h2>
        <code>{model.id}</code>
        <dl>
          <div><dt>Input window</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Not reported"}</dd></div>
          <div><dt>Output window</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Not reported"}</dd></div>
        </dl>
        <button
          onclick={() => prefer(model.id)}
          disabled={busy === model.id || (data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid")}
        >
          {data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid" ? "Preferred" : "Set preferred"}
        </button>
      </article>
    {/each}
  </section>
{/if}
