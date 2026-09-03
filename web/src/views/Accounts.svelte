<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, DeviceFlow } from "../types.js";

  let { client }: { client: AdminClient } = $props();
  let data: AdminAccounts | null = $state(null);
  let host = $state("github.com");
  let flow: DeviceFlow | null = $state(null);
  let loading = $state(true);
  let busy = $state("");
  let message = $state("");
  let failure = $state("");
  let hostInput: HTMLInputElement | null = null;

  onMount(load);
  async function load(): Promise<void> { loading = true; failure = ""; try { data = await client.accounts(); } catch (e) { failure = errorMessage(e); } finally { loading = false; } }
  async function start(): Promise<void> { busy = "login"; failure = ""; try { flow = await client.startDeviceFlow(host); } catch (e) { failure = errorMessage(e); hostInput?.focus(); } finally { busy = ""; } }
  async function poll(): Promise<void> {
    if (!flow) return; busy = "poll";
    try { const result = await client.pollDeviceFlow(flow.flowId); if (result.state === "complete") { flow = null; message = "Account connected."; await load(); } else message = result.state === "pending" ? "Authorization is still pending." : `The flow ${result.state}.`; }
    catch (e) { failure = errorMessage(e); } finally { busy = ""; }
  }
  async function useAccount(id: string): Promise<void> { if (!data) return; busy = id; try { await client.useAccount(id, data.defaultRevision); message = "Default account updated."; await load(); } catch (e) { failure = errorMessage(e); if (e instanceof ApiError && e.status === 409) await load(); } finally { busy = ""; } }
  async function remove(id: string, revision: number): Promise<void> { if (!confirm("Remove this account's credentials and live caches?")) return; busy = id; try { await client.removeAccount(id, revision); message = "Account removed."; await load(); } catch (e) { failure = errorMessage(e); if (e instanceof ApiError && e.status === 409) await load(); } finally { busy = ""; } }
</script>

<header class="page-head"><div><p class="eyebrow">IDENTITY ROSTER</p><h1>Accounts</h1><p>Connect GitHub.com or GHES and choose the request identity.</p></div><button class="quiet" onclick={load}>Refresh</button></header>
{#if message}<p class="notice success" role="status">{message}</p>{/if}{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
<section class="section-block connect-panel"><div><p class="eyebrow">DEVICE AUTHORIZATION</p><h2>Connect an account</h2></div><form onsubmit={(e) => { e.preventDefault(); void start(); }}><label for="github-host">GitHub host</label><div class="inline-form"><input id="github-host" bind:this={hostInput} bind:value={host} required placeholder="github.com or github.example.com" /><button class="primary" disabled={busy === "login"}>{busy === "login" ? "Starting..." : "Start login"}</button></div></form></section>
{#if flow}<section class="device-flow" aria-labelledby="device-title"><div><p class="eyebrow">ONE-TIME CODE</p><h2 id="device-title">Continue in GitHub</h2><code>{flow.userCode}</code></div><div><a class="button primary" href={flow.verificationUri} target="_blank" rel="noreferrer">Open verification page</a><button onclick={poll} disabled={busy === "poll"}>{busy === "poll" ? "Checking..." : "I've authorized"}</button></div></section>{/if}
{#if loading}<p class="loading-line" aria-busy="true">Loading accounts...</p>
{:else if data?.items.length === 0}<section class="empty"><span>00</span><h2>No accounts connected</h2><p>Start a device authorization above. Credentials never enter browser storage.</p></section>
{:else if data}<section class="card-list" aria-label="Connected accounts">{#each data.items as account}<article class:muted-card={account.state !== "active"}><div class="avatar" aria-hidden="true">{(account.login ?? account.host).slice(0, 2).toUpperCase()}</div><div class="grow"><div class="account-title"><h2>{account.displayName ?? account.login ?? account.numericUserId}</h2>{#if data.defaultAccountId === account.accountId}<span class="chip">DEFAULT</span>{/if}<span class="chip state-{account.state}">{account.state}</span></div><p>{account.login ? `@${account.login} · ` : ""}{account.host}</p><small>Authenticated {account.authenticatedAt ? new Date(account.authenticatedAt).toLocaleString() : "not active"}</small></div><div class="card-actions">{#if account.state === "active" && data.defaultAccountId !== account.accountId}<button onclick={() => useAccount(account.accountId)} disabled={busy === account.accountId}>Make default</button>{/if}{#if account.state !== "removed"}<button class="danger-text" onclick={() => remove(account.accountId, account.revision)} disabled={busy === account.accountId}>Remove</button>{/if}</div></article>{/each}</section>{/if}
