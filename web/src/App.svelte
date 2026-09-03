<script lang="ts">
  import { onMount } from "svelte";
  import { AdminClient, errorMessage, takeBootstrapToken } from "./api.js";
  import type { AdminOperationalEvent, AdminSessionMetadata, AdminStatus } from "./types.js";
  import Accounts from "./views/Accounts.svelte";
  import Configuration from "./views/Configuration.svelte";
  import Events from "./views/Events.svelte";
  import Models from "./views/Models.svelte";
  import Overview from "./views/Overview.svelte";
  import ResponsesHistory from "./views/ResponsesHistory.svelte";

  const views = ["Overview", "Accounts", "Models", "Configuration", "Responses History", "Events"] as const;
  type View = typeof views[number];

  let view: View = $state("Overview");
  let session: AdminSessionMetadata | null = $state(null);
  let phase: "loading" | "ready" | "signed-out" = $state("loading");
  let authError = $state("");
  let streamState: "connecting" | "live" | "reconnecting" = $state("connecting");
  let liveStatus: AdminStatus | null = $state(null);
  let liveEvents: AdminOperationalEvent[] = $state([]);
  let resetVersion = $state(0);
  let stream: EventSource | null = null;
  let signedOutPanel: HTMLElement | null = $state(null);
  const client = new AdminClient(teardown);

  onMount(() => {
    void authenticate();
    return closeStream;
  });

  async function authenticate(): Promise<void> {
    phase = "loading";
    authError = "";
    const token = takeBootstrapToken();
    try {
      session = token === null ? await client.session() : await client.bootstrap(token);
      phase = "ready";
      openStream();
    } catch (error: unknown) {
      phase = "signed-out";
      authError = token === null ? "Open this control room with `ghcg admin open`." : errorMessage(error);
      requestAnimationFrame(() => signedOutPanel?.focus());
    }
  }

  function openStream(): void {
    closeStream();
    streamState = "connecting";
    stream = new EventSource("/admin/api/v1/events/stream");
    stream.onopen = () => { streamState = "live"; };
    stream.onerror = () => {
      streamState = "reconnecting";
      void client.session().catch(() => undefined);
    };
    stream.addEventListener("performance", (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as { status: AdminStatus };
      liveStatus = value.status;
    });
    stream.addEventListener("operational", (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as { event: AdminOperationalEvent };
      liveEvents = [...liveEvents, value.event].slice(-512);
    });
    stream.addEventListener("reset", () => {
      liveEvents = [];
      resetVersion += 1;
    });
  }

  function closeStream(): void {
    stream?.close();
    stream = null;
  }

  function teardown(): void {
    closeStream();
    client.clear();
    session = null;
    liveStatus = null;
    liveEvents = [];
    phase = "signed-out";
    authError = "Your admin session ended. Run `ghcg admin open` to reconnect.";
    requestAnimationFrame(() => signedOutPanel?.focus());
  }

  async function logout(): Promise<void> {
    try { await client.logout(); } catch { /* Local teardown is mandatory even if the daemon stopped. */ }
    teardown();
  }
</script>

<svelte:head><meta name="description" content="Local ghc-gateway administration" /></svelte:head>

{#if phase === "loading"}
  <main class="auth-stage" aria-busy="true">
    <div class="boot-mark" aria-hidden="true"></div>
    <p class="eyebrow">LOCAL CONTROL PLANE</p>
    <h1>Establishing a secure session</h1>
    <p class="muted">The one-time bootstrap is being exchanged in memory.</p>
  </main>
{:else if phase === "signed-out"}
  <main class="auth-stage">
    <section class="signed-out" aria-labelledby="signed-out-title">
      <span class="status-dot stopped" aria-hidden="true"></span>
      <p class="eyebrow">SESSION CLOSED</p>
      <h1 id="signed-out-title" tabindex="-1" bind:this={signedOutPanel}>Control room locked</h1>
      <p>{authError}</p>
      <button class="primary" onclick={authenticate}>Try current session</button>
    </section>
  </main>
{:else}
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-glyph">G</span><div><strong>ghc-gateway</strong><small>CONTROL ROOM</small></div></div>
      <div class="top-actions">
        <span class="stream-state"><span class:reconnecting={streamState !== "live"} class="status-dot"></span>{streamState}</span>
        <button class="quiet" onclick={logout}>End session</button>
      </div>
    </header>
    <aside class="rail" aria-label="Primary">
      <nav>
        {#each views as item, index}
          <button class:active={view === item} aria-current={view === item ? "page" : undefined} onclick={() => view = item}>
            <span class="nav-index">0{index + 1}</span><span>{item}</span>
          </button>
        {/each}
      </nav>
      <div class="rail-foot"><span>SESSION</span><time datetime={session?.idleExpiresAt}>idle until {session ? new Date(session.idleExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}</time></div>
    </aside>
    <main class="workspace" tabindex="-1">
      {#if view === "Overview"}<Overview {client} {liveStatus} />
      {:else if view === "Accounts"}<Accounts {client} />
      {:else if view === "Models"}<Models {client} />
      {:else if view === "Configuration"}<Configuration {client} />
      {:else if view === "Responses History"}<ResponsesHistory {client} />
      {:else}<Events {client} {liveEvents} {resetVersion} />{/if}
    </main>
  </div>
{/if}
