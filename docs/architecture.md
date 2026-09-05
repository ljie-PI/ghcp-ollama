# ghc-gateway maintenance architecture

This is the normative maintenance reference for the current TypeScript gateway: ownership, local state, configuration,
management interfaces, resource bounds and verification. Requirements here describe required behavior, **not a
certification that the implementation complies**. Completed migration plans, implementation slices and historical test
results are not maintenance contracts.

## Authority and navigation

Read the relevant production contract before changing its behavior. It takes precedence within its scope; code and
passing tests are evidence, not permission to weaken a requirement.

| Change | Owning contract |
| --- | --- |
| Public routes, probes, parsing, admission, limits, timeouts, request IDs, pre-first-byte errors | [Gateway HTTP](./gateway_http_contracts.md) |
| Native Chat requests, responses and SSE | [OpenAI Chat](./openai_chat_completions.md) |
| Responses selection, native URLs/events/IDs and history ownership | [Responses routing](./openai_responses_routing.md) |
| Responses bridge fields, tools, reasoning, history enrichment, checkpoints and wire events | [Responses bridge](./codex_response_to_chat_completions.md) |
| Messages request/response conversion and block lifecycle | [Anthropic bridge](./claude_messages_to_chat_completions.md) |
| Ollama DTOs, token fallback, Go serialization and NDJSON | [Ollama bridge](./ollama_chat_to_chat_completions.md) |
| Credentials, CAPI fetching/caching and the three public model serializers | [Model listing](./github_copilot_model_listing_apis.md) |
| Vocabulary and durable decisions | [CONTEXT](../CONTEXT.md), [protocol modules](./adr/0001-protocol-endpoint-modules.md), [secret files](./adr/0002-file-backed-secret-store.md), [clean break](./adr/0003-clean-break-rename.md), [daemon](./adr/0004-self-managed-daemon.md) |

Pinned upstream sources referenced by those contracts are provenance, not alternate runtime profiles. A conflict that
cannot be resolved by scope needs an explicit specification correction before dependent implementation changes.
Catalog transport's fixed 30-second connect/600-second total deadlines remain distinct from configurable inference
timeouts. **The unresolved intersection is the status/presenter for a catalog-source timeout during inference
preplanning**: the HTTP contract's catalog exception and model listing's GET-only presenter scope need explicit
reconciliation. Do not choose 502 versus 504 from existing tests, apply the inference snapshot to CAPI, or erase
either contract's wording. The inference host's own deadline remains governed by its route's HTTP contract.

## Runtime and module ownership

One npm package, `@ljie-pi/ghc-gateway`, publishes one executable, `ghcg`. Node.js 24 LTS, ESM and strict TypeScript
run one gateway process with one main-thread SQLite connection. Hono and `@hono/node-server` host Fetch-standard
interfaces; Undici owns upstream HTTP; `better-sqlite3` owns persistence; Svelte 5/Vite produce static Admin assets
served by that same process. [Package metadata](../package.json) is the mechanical source for versions, entrypoints,
scripts and packaged paths. The build version must equal `package.json.version`, including probe responses.

The clean break is permanent: use only `~/.ghc-gateway` and the `GHC_GATEWAY_` environment prefix. There is no old
data/config/credential/process-state import and no `ghcp-ollama`, `ghcp-gateway`, `ghcpo` or `ghcpo-server` alias.
Users reauthenticate and reconfigure. There is no watchdog, automatic restart, OS supervisor requirement, second
JavaScript server, multi-instance shared mutable store, ORM, Redis, WebSocket, SvelteKit server or arbitrary provider/
protocol plugin system.

| Owner / navigation | State and boundary |
| --- | --- |
| [Composition](../src/main.ts), [Gateway creation](../src/gateway/create_gateway.ts) | Read startup inputs, migrate/open stores, reconcile credentials, construct shared dependencies, register routes/mounts, publish readiness and arrange shutdown. Protocol modules do none of this themselves. |
| [Gateway Foundation](../src/gateway) | `Gateway.fetch(Request): Promise<Response>` and idempotent `close()` hide HTTP routing, request IDs, body/WireJson parsing, admission, request scope, cancellation and downstream commit. `RequestScope` contains only request ID, signal and immutable config. |
| [Protocol endpoint modules](../src/protocols) | Each owns its decoder, endpoint, failure presenter, planning/conversion, stream state, clock/UUID timing, terminal and wire encoder. Factories explicitly register method/path, admission `none` or `inference`, and body `none` or `wire-json-object`. |
| [Accounts](../src/accounts) | Stable identity, request-bound account, default-account revision, account revisions, credentials and per-account preferred-model revisions. The credential store is a protected-file production seam with a memory test adapter. |
| [Copilot backend](../src/copilot/backend.ts) | Bind the selected account once to credential and target; hide token refresh, discovery, headers, URLs, HTTP pool, redirect, timeout and cancellation. Production Undici and scripted adapters share this real seam. |
| [Catalog](../src/copilot/model_catalog.ts) | Per-account catalog/generation, no TTL or single-flight, success-empty cache and generation-safe invalidation. A narrow models source reuses the credential provider/pool; it does not widen inference methods. |
| [Responses History](../src/protocols/responses/history.ts) | SQLite bridge-only history. Inference receives `enrich/record`; Admin receives separate `inspect/clear`, never each other's mutation surface. Tests run the production SQLite implementation. |
| [Config](../src/config), [persistence](../src/persistence) | Revisioned immutable runtime snapshot and explicit SQL/migrations. These are deep modules, not pass-through swappable database ports. |
| [Telemetry](../src/telemetry) | Bounded Usage Buckets, Operational Events, JSONL, performance windows and read-only Admin queries/subscriptions. |
| [Admin](../src/admin), [web](../web) | In-memory bootstrap/session/CSRF and bounded monitor subscribers. UI uses only Admin HTTP; neither Admin nor UI opens daemon files, credentials or SQLite directly. |
| [Daemon](../src/daemon), [CLI](../src/cli) | Protected process identity, local control and lifecycle; management CLI is a thin authenticated client, not another application-storage owner. |

Dependencies flow from composition/HTTP host to endpoint or Admin use cases, then to their account/catalog/backend/
history/telemetry modules. Protocol modules do not import Hono, SQLite, `process.env` or a concrete HTTP client.
Chat DTOs are a bridge wire pivot, not a reversible canonical message model. Do not merge independent lifecycles into
`BaseAdapter`, `StreamTransformer`, a generic provider context or a global protocol-switch serializer. Share an
algorithm only where the owning production contracts explicitly require the same behavior.

The public surface is the exact [HTTP route matrix](./gateway_http_contracts.md#22-受本文约束的-routes), plus its
three probes. Gateway Foundation alone owns `/api/version`. Model listing owns `/v1/models` and `/api/tags`;
OpenAI Chat, Responses, Messages and Ollama own their inference routes. No convenience, compact or trailing-slash
aliases are registered. The listener accepts only literal `127.0.0.1`; reject hostnames, `::1` and other addresses
before opening a socket. Inference requires no gateway API key; inbound credentials never override the Bound Account.

Optional `admin`, `control` and `adminStatic` mounts preserve public `RouteRegistration` and protocol behavior when
omitted. Match exact `/__ghcg/control/v1/*` before protocols, exact `/admin/api/v1` and `/admin/api/v1/*` before
static handling, and permit assets/SPA fallback only for `GET /admin/*`. Unknown Admin API routes remain Admin JSON
404, never HTML; static fallback cannot catch protocols, probes or control. Gateway supplies mounted request IDs,
caller/shutdown signals, active-listener Origin and read-only activity snapshots. Admin captures its own body limit;
control owns its fixed cap. Neither uses inference admission or a protocol error envelope.

Admin HTTP and local control share **one** `AdminModule`; control only calls its `mintBootstrap()`. Admin obtains
version, uptime and verified daemon metadata from `AdminRuntimeStatus`, not process globals/files.
`GatewayActivity` exposes active requests, active streams and queued requests without mutation capability. With no
Admin mount/observer, instrumentation creates no observer, timer or queue and changes no admission, bytes or cleanup.

## Request execution and wire boundaries

### Model resolution

A request captures one immutable config snapshot, cancellation signal, Bound Account, resolved model and credential/
target. Capture request-local state before awaits that could observe a concurrent management change. Catalog and
backend must consume the **same** account; later default/model/config changes affect only later requests.

For OpenAI Chat, Messages and Responses, `ModelResolver` consumes a protocol-decoded model plus a captured catalog:

| Model input | Required result |
| --- | --- |
| Missing | Capture that account's preference before catalog awaits; use only a `valid` preference whose exact ID remains visible. Otherwise `invalid_request`; never choose the first catalog item. |
| Explicit non-empty string, exact catalog ID | Resolve it once without reading preferred-model state. |
| Explicit wrong type or empty string | `invalid_request`. |
| Explicit unknown ID | `model_not_found`, zero upstream calls, no preference fallback. OpenAI and Anthropic presenters use HTTP 404 `not_found_error`. |

The immutable `ResolvedModel {requestedModel,upstreamModel,source,routing}` is not resolved again after planning.
Ollama instead requires an explicit non-empty model and preserves it for upstream handling; it does not use this fallback.
`PreferredModelManager` validates an exact ID against a captured catalog and passes `{modelId,catalogGeneration}` to
the account preference store. Resolver reads preferences; catalog refresh calls that store's invalidation operation,
never writes preference tables itself. Routing metadata stays private to planning and out of public model DTOs.

Responses decodes once, binds account/catalog/model/target, then plans once. Native and bridge plan types and the
bridge's history → same resolved model → immutable ToolContext → reasoning → conversion → prompt-cache sequence
belong to [Responses routing](./openai_responses_routing.md) and [bridge preprocessing](./codex_response_to_chat_completions.md#3-request-预处理).
Converters do not fetch catalogs/defaults. Native Responses never calls Chat conversion or local history and never
retries through Chat after a native failure.

<a id="91-pipeline"></a>
### Streaming pipeline

Chat path: upstream bytes → incremental UTF-8/SSE framing → typed `ChatStreamFrame` → protocol-local state → local
wire encoder → downstream bytes. Frames discriminate `chunk`, `error` and `done`; normal iterator EOF is not `done`.
Raw SSE handles BOM, LF/CRLF/CR, fields, multi-data, error frames and `[DONE]`, but constructs no downstream objects.
Typed converters never parse `data:` or residual UTF-8 bytes. OpenAI's native Chat fast path still uses this parser
and its OpenAI re-encoder; it is not byte-blind passthrough or another protocol's state machine.

Native Responses uses its own SSE validation and stream-scoped `output_index` → stable item-ID map, preserving
events/usage/order except the specified ID normalization. Native state is separate from the bridge's response,
reasoning, message, tool, index and sequence state. Terminal ownership remains protocol-local.

Every stage is pull-based `AsyncIterable`: **at most one unconsumed item ahead**. A Web `ReadableStream` calls
`iterator.next()` only from `pull()`; callbacks must not build queues behind the writer. Do not retain raw chunk
history or full native stream responses. Bridge aggregation is limited to the terminal/history data it needs.

First downstream **body byte**, not upstream headers, `Response` construction or an internal flag, commits the
response. Before it, complete bounded validation must permit the protocol's ordinary JSON error response, even for a
stream request. Do not flush 200/SSE headers, comments, blank events or NDJSON whitespace to evade that boundary.
Comments, blank events and headers do not satisfy the first-payload timeout. Shared Chat transport requires bounded
body, connect and first-byte controls from the captured snapshot for every caller; omitted controls cannot disable them.
After the first-payload contract, idle time tracks upstream body-byte progress. Exact timers/errors remain in
[Gateway HTTP](./gateway_http_contracts.md#4-admissionlimits-与-timeouts).

Client abort differs from timeout: emit zero further bytes, abort the same upstream operation, call iterator `return()`,
and release reader/socket, decoder/state, timers/listeners and permit exactly once. Invalid headers/body, non-2xx,
parser errors and pre-commit stream failures must cancel or drain upstream before returning safe errors. Post-commit
non-abort closure is [protocol-specific](./gateway_http_contracts.md#52-post-commit): only Ollama emits its one safe
NDJSON error; no success terminal or synthetic terminal/error from another protocol is invented. Preserve internal
causes for diagnosis, but never leak them through a generic public error envelope.

<a id="101-wire-json"></a>
### Wire JSON and validation

`WireJson` is a bounded syntax tree: scalar null/boolean/string, number **lexeme**, ordered array, ordered object
members. Preserve duplicates until the protocol decoder decides validity; preserve missing/null/false/0/empty,
integer-like member order, `-0`, exponent/large-number lexemes and Unicode. Do not round-trip through JavaScript
numbers or `JSON.parse()` plus broad casts before decoding. Compact and ordered serialization and canonical
Unicode-code-point key sorting are distinct operations; typed parse/serialization failures retain causes.

Inference uses explicit protocol WireJson decoders; Admin/config use TypeBox with coercion disabled. The TypeScript
baseline includes `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`,
`noImplicitOverride` and `verbatimModuleSyntax`. Use discriminated unions for frames/errors/phases; keep `unknown`
at HTTP/remote/SQLite-JSON seams, and dynamic records only where specified. Protocol-local Go, Python, native and
Responses encoders remain governed by their production byte contracts, not a shared serialization convenience helper.

## Runtime configuration

Startup settings use `CLI > GHC_GATEWAY_* environment > default` and take effect only on process start:

| Setting | Flag / environment | Default and validation |
| --- | --- | --- |
| Port | `--port` / `GHC_GATEWAY_PORT` | `31400`; integer `1..65535`; host remains literal `127.0.0.1` |
| Data directory | `--data-dir` / `GHC_GATEWAY_DATA_DIR` | `~/.ghc-gateway`, resolved to an absolute path |
| Log level | `--log-level` / `GHC_GATEWAY_LOG_LEVEL` | `info`; `trace`, `debug`, `info`, `warn`, `error` only |

Only `serve/start` accept port/log-level flags; every command accepts data-dir as its exact identity locator.
SQLite is the sole runtime-config truth after initialization. Environment values seed a missing row **once**, not on
subsequent starts. Seed names are `GHC_GATEWAY_` plus dot/camel segments in upper snake case, e.g.
`GHC_GATEWAY_LIMITS_REQUEST_BODY_BYTES`. Explicitly parse environment text and CLI `config set` text into the key's
primitive type before validating the complete candidate; schema validation itself never coerces.

| Runtime key | Default | Inclusive hard range | Unit |
| --- | ---: | ---: | --- |
| `limits.requestBodyBytes` | 33554432 | 1048576..67108864 | bytes |
| `limits.sseEventBytes` | 4194304 | 65536..16777216 | bytes |
| `limits.nonstreamBodyBytes` | 33554432 | 1048576..134217728 | bytes |
| `limits.accumulatorBytes` | 33554432 | 1048576..134217728 | bytes |
| `admission.activeMax` | 4 | 1..16 | requests |
| `admission.queueMax` | 16 | 0..64 | requests |
| `timeouts.queueMs` | 30000 | 1000..300000 | milliseconds |
| `timeouts.connectMs` | 30000 | 1000..120000 | milliseconds |
| `timeouts.firstByteMs` | 120000 | 5000..600000 | milliseconds |
| `timeouts.streamIdleMs` | 120000 | 5000..600000 | milliseconds |
| `timeouts.totalMs` | 1800000 | 60000..7200000 | milliseconds |
| `accounts.maxAuthenticated` | 8 | 1..32 | accounts |
| `history.ttlDays` | 7 | 1..365 | days |
| `usage.retentionDays` | 90 | 1..365 | days |
| `events.retentionDays` | 7 | 1..30 | days |

All 15 values are required numeric fields in the complete nested config DTO; registry identifiers split at dots give
its exact object shape. [Config schema](../src/config/schema.ts) provides the mechanical schema/range lookup, not an
alternative behavioral contract. Port/data-dir/log-level and fixed capacities are readable status, not mutable runtime
keys. Setting one of those or an unknown key fails without changing revision. Default account and model preference
have independent revisioned stores and are not fields in `RuntimeConfigSnapshot`.

Update order: parse → validate complete candidate → revision-CAS SQLite transaction → construct immutable snapshot →
atomic snapshot swap → invalidate only affected caches. Validation, conflict, write or snapshot-build failure leaves
**both old row and old snapshot active**, never partially applied. A request captures its snapshot at admission.
Reducing `activeMax` or `queueMax` cancels neither active requests nor existing waiters: admit no new work until active
count is below the **new** active limit; honor the reduced capacity for new arrivals. Existing waiters keep captured
deadlines; new waiters use the new snapshot. A downshift must not keep dispatching under a stale larger active limit.

### Fixed capacities

These bounds are not runtime keys. Exact byte limits are inclusive; overflow is not silent truncation or partial
success. Critical config/account/credential/history writes never enter the lossy telemetry queue.

| Resource | Hard cap / overflow |
| --- | --- |
| Global Responses History | 512 responses; insertion-order eviction |
| Usage Buckets | 100000 rows; deterministic oldest-key eviction |
| Operational Events | 512 rows; oldest event-ID eviction |
| Pending telemetry mutations | 1024; [type-specific loss policy](#telemetry) |
| Admin Sessions | 8; new bootstrap exchange returns Admin capacity error |
| Outstanding bootstrap tokens | 8; ninth mint returns capacity |
| Active device flows | 8; reject ninth; local lifetime at most 15 minutes |
| Admin SSE subscribers | 8; reject ninth |
| Each subscriber's pending events | 128 events **or** 1 MiB; disconnect slow subscriber |
| Operational `metadata_json` | 16 KiB; replace invalid/oversized metadata with a smaller fixed `metadata_rejected` event when capacity permits, not truncation |
| One complete JSONL record | 64 KiB including its final LF; use a fixed sanitized overflow record rather than emit an oversized record |
| JSONL retention | 10 MiB per file, at most 5 files, at most 7 days; count and age both apply |
| Control request body | 1 MiB; first excess byte cancels reader and returns `400 invalid_command` |
| Graceful shutdown | 10 seconds; record timeout if possible, then force resource close |
| Daemon readiness wait | 30 seconds; fail start, terminate verified child, clean its identity file |

Overflow counters have fixed labels and saturate at `Number.MAX_SAFE_INTEGER`.

## Persistence and durability

`state.db` holds nonsecret config/accounts/preferences, bridge history, usage and events. Use one main-thread
`better-sqlite3` connection, prepared statements and short transactions; finalize statements on close. Required PRAGMAs:
WAL, `synchronous=FULL`, foreign keys enabled, `busy_timeout=1000` ms, `wal_autocheckpoint=1000` pages and
`journal_size_limit=67108864` bytes. Transactions contain no network I/O or large JSON transformation. `node:sqlite`
is not substituted before it is stable. Consider moving this same implementation to a worker only after measured
event-loop p95 exceeds 10 ms; preserve protocol interfaces and rerun resident-memory gates.

The versioned [migration files](../src/persistence/migrations) own mechanical DDL:

| Migration | Durable schema/state invariant |
| --- | --- |
| [001 runtime config](../src/persistence/migrations/001_runtime_config.ts) | Singleton ID 1, revision, complete config JSON and update time; migration ledger has integer version PK, unique name, checksum and applied time. |
| [010 accounts](../src/persistence/migrations/010_accounts.ts) | Unique `(normalized_host,numeric_user_id)` identity; nullable login/display name/authenticated time/credential generation; `active/removing/removed` state. Gateway preference singleton references nullable default account. Per-account preference references account and carries independent revision, model ID, `valid/invalid`, catalog generation and update time. |
| [020 telemetry](../src/persistence/migrations/020_telemetry.ts) | Usage composite key is UTC hour/account/protocol/resolved model/outcome; account ID deliberately has **no cascading FK**, so usage survives account cleanup. Event ID is autoincrementing; severity is `info/warning/error`. Singleton telemetry state persists the two saturating drop counters and update time. |
| [030 history](../src/persistence/migrations/030_responses_history.ts) | History singleton has revision and monotonic next insertion sequence. Response ID is unique, insertion sequence separately unique; ordered calls have `(response_id,ordinal)` PK with cascading response deletion, call ID/kind/item JSON. |

Required query indexes: `responses(expires_at_ms)`, `response_calls(call_id)`, `usage_buckets(utc_hour_ms)` and
`operational_events(occurred_at_ms,event_id)`. Additional indexes may support documented queries but cannot change
ownership/retention. Millisecond storage timestamps and canonical public UTC timestamps must not change cutoff rules.

Migrations are forward-only immutable `{version,name,sql}` exports whose filenames begin with the matching three-digit
version. [Build-time discovery](../scripts/tooling/generate_migrations.ts) rejects filename/export mismatches, duplicates
and reuse of established version allocations; generates checksums and an ordered static manifest in uncommitted build
output. Production imports that manifest, with no runtime filesystem discovery or requirement to ship loose SQL assets.
Apply **every** embedded unapplied version transactionally in numeric order: gaps are valid, `max(version)` is not
the migration state, and a missing lower version must still run. Refuse checksum drift and applied versions unknown to
the binary; failed migration rolls back rather than leaving a partly upgraded schema.

### History and retention

[Responses history semantics](./codex_response_to_chat_completions.md#8-request-history) own enrichment, scoped versus
unique-global call lookup, supported call types, field precedence, TTL-from-first-record and checkpoint content.
SQLite is durable truth across restart; native IDs never resolve locally. Response, ordered calls and call-ID index
commit together; no read-through cache or cleanup timer is required for correctness.

History revision increments **once per transaction changing visible history**: new/updated checkpoint, nonstream record,
TTL cleanup, eviction or nonempty clear. No-op lookup/record/clear does not increment. Admin clear compares revision and
clears/increments in the same transaction. `next_insertion_seq` is monotonic and **never reset by clear**.
Nonstream bridge commits after full conversion but before success bytes. Stream checkpoint emissions carry minimal
history separately from ordinary events, so the endpoint synchronously commits before `response.output_item.done`
and final `response.completed`. Failure suppresses that checkpoint/terminal, not already-sent bytes. Unfinished token,
reasoning and argument fragments/live executions are never persisted or recovered; account removal does not clear history.

Cleanup runs at startup and in the owning read/write transaction, without relying on a timer:

| Store | Expiry first, then capacity eviction |
| --- | --- |
| History | Delete `expires_at_ms <= now_ms` before lookup/record, then lowest `insertion_seq` until at most 512. TTL reduction immediately cleans against first-record time; extending TTL cannot restore deleted data. |
| Usage | Delete `utc_hour_ms < floorToUtcHour(now_ms - retentionDays)`; then ascending `(utc_hour_ms,account_id,protocol,resolved_model,outcome)` until at most 100000. |
| Operational Events | Delete `occurred_at_ms <= now_ms - retentionDays`; then lowest `event_id` until at most 512. |

Config, account activation, secret replace and Semantic Checkpoint writes synchronously report failure.
Usage/events/JSONL are noncritical: short uncommitted batches may be lost on hard crash; graceful shutdown must flush
within its bounded grace period. A failed transaction is not a successful flush and cannot silently discard its batch.

<a id="github-environments"></a>
## GitHub environments, accounts and secrets

Users configure only GitHub domain or `domain:port`, not paths, queries, fragments or embedded credentials.
`GitHubEnvironmentResolver` derives OAuth/REST URLs with `URL`, not string concatenation. Stable `AccountId` is
`<normalized-host>/<canonical-decimal-user-id>`: lowercase ASCII/IDNA host, one trailing dot removed, default `:443`
omitted, explicit non-443 decimal port retained; positive immutable numeric user ID without leading zeroes.
Login/display-name changes do not change identity.

| Environment | Web base | REST base | OAuth client ID |
| --- | --- | --- | --- |
| `github.com` | `https://github.com` | `https://api.github.com` | `Iv1.b507a08c87ecfe98` |
| GHES | `https://<domain>` | `https://<domain>/api/v3` | `Ov23li8tweQw6odWQebz` |

Device-code and access-token paths are `/login/device/code` and `/login/oauth/access_token` on that web base.
REST base is not the Copilot CAPI endpoint. CAPI model URL literal `endpoint + "/models"`, discovery DTO/cache/fallback,
token `<60s` versus exactly 60s, GHES OAuth direct use, per-account refresh/discovery mutexes with in-lock rechecks,
fixed client headers and redirect stripping are owned by [Model listing](./github_copilot_model_listing_apis.md).
There is no global refresh polling interval or inbound override of fixed Copilot identity. Native-specific headers
remain in [Responses routing](./openai_responses_routing.md). Catalog serializers use one captured snapshot, with no
static list, sorting/deduplication or name/vendor capability guesses; success `fetchedAt` samples the clock once.
Production model-created time is `1677610602`, test-injectable, not runtime config or a cache key.

### Protected files

Resolved data directory contains SQLite/WAL/SHM, `credentials.json`, `daemon.json` and JSONL logs. Unix directory
mode is `0700`; Windows directory ACL is current-user-only. Credential/daemon paths **and same-directory staging
paths** must be regular files beneath that resolved directory with matching ownership. Symlinks, reparse points,
ownership mismatch or unverifiable permissions fail closed.

Secret/identity replacement is: create protected same-directory staging file → validate regular-file/owner/reparse
properties and permissions → write → **flush file before replace** → atomic replace → verify final protection.
Unix final files are `0600`; Windows grants file access only to the current user, removes inherited broad ACEs and
verifies ACL after replace. Permission/ACL/flush failure is fatal, never a weaker-file fallback.
OAuth/Copilot/admin/control secrets remain only in protected files and memory, never SQLite, logs, telemetry or
public errors. Admin's long random secret is generated on first initialization.

### Account generations and reconciliation

SQLite is activation authority; a secret generation's mere existence does not activate an account. Bound accounts are
immutable and select only active rows. Use a still-active saved default; otherwise fall back by
`authenticated_at DESC, accountId ASC`; absence is authentication failure. The authenticated-account cap is the
runtime registry's 8 default/32 hard maximum.

1. Login validates numeric identity, atomically writes a **new** secret generation while retaining the current one,
   commits metadata/new active generation in SQLite, then atomically prunes the old generation.
2. Failed SQLite commit leaves old generation usable and new one inert. Startup prunes generations unreferenced by
   active rows and resumes every durable `removing` row; it never reactivates one to hide cleanup failure.
3. Removal marks `removing`, increments account revision and clears default/model preference in one transaction;
   excludes it immediately from binding. Remove secrets and invalidate token/endpoint/catalog caches, then commit
   `removed` with another increment. Cleanup failure is reported and leaves its current revision visible.
4. Identity and Usage Buckets survive removal. Relogin of the same tuple installs a new generation, marks that identity
   active with a new revision and rejoins usage. A removed tombstone may be deleted only after its last retained bucket
   disappears; deterministic identity still permits later recreation. Global Responses History is unaffected.

| Removal state | CAS / retry behavior |
| --- | --- |
| `active` | Exact current revision required; transition to `removing` at revision + 1. |
| `removing` | Exact **current removing** revision required; retry external cleanup without another initial increment, then `removed` at +1 on success. Old active revision conflicts. |
| `removed` | Exact current revision is idempotent success without increment; stale revision conflicts. |

CLI retry rereads the current revision; Admin refreshes after failure. Neither may retry using the stale original
active revision. `auth logout` and account removal use this same operation.

`gateway_preferences.revision` independently protects default selection. Each model preference has its own revision;
absence is represented as revision 0 and nullable preference. Explicit set validates exact model/catalog generation
and increments transactionally. Refresh that removes a preferred ID changes `valid` → `invalid` and increments; it
does not choose a replacement. Only a later explicit set restores `valid` with another increment. Model listing's
invalidation performs one CAS attempt; config/CLI/Admin reuse domain validation rather than duplicate it.

<a id="daemon-control"></a>
## Daemon and local control

Foreground `serve` and detached `start` hold an exclusive identity-file creation lock and publish protected, versioned
`daemon.json` while running. Required fields are `managed:boolean`, `pid:number`, `processStartIdentity:string`,
`instanceNonce:string`, `controlToken:string`, `port:number`, `createdAt:string` plus format version.
Foreground uses `managed:false`; detached uses `true`.

| Platform | Canonical OS start identity |
| --- | --- |
| Linux | Kernel boot ID + `/proc/<pid>/stat` start ticks |
| Windows | Process creation FILETIME |
| macOS | `LC_ALL=C ps -o lstart= -p <pid>`, canonicalized to UTC seconds, plus nonce handshake as second factor |

All commands locate only `--data-dir > GHC_GATEWAY_DATA_DIR > ~/.ghc-gateway`; never scan other directories or
ports. `start` spawns **one** detached Node child running this package's `serve`, waits at most 30 seconds for an
authenticated **ready** handshake, then `unref()`s. Already verified running foreground or managed gateway is
idempotent success. Failed readiness terminates only the verified child and cleans its identity file.

Readiness is dynamic: valid startup config, SQLite open at current migration set, verified credential path, runtime
snapshot and a host accepting requests are required. Losing any required local dependency changes ready to not-ready.
No account, remote probe or performance result is required; degraded performance alone affects neither probe.
Exact bodies and headers belong to [probe contracts](./gateway_http_contracts.md#23-probe-routes).

`status` distinguishes `running`, `stopped`, `stale`, `conflict`, `unreachable`; remove an identity file only after
proving the recorded process no longer exists. A live PID with wrong start identity/nonce is not safe to control.
`stop/restart` require `managed:true` and refuse foreground termination. After authenticated identity verification,
request graceful close and wait 10 seconds; force termination only if the **same OS process identity** still exists.
Without verification return conflict/unreachable and never kill. Restart is verified stop then start with new
nonce/start identity. No PID-only termination, watchdog or automatic restart.

Close is idempotent: stop accepting requests (including mounts), abort in-flight work, and perform bounded
telemetry/log flush and persistence/transport cleanup. Close control before Admin, then persistence/transport:
control must stop minting/dispatching before Admin clears tokens/sessions/subscribers/heartbeat.
Force resource close after the 10-second grace limit, recording timeout when possible.
Foreground SIGINT/SIGTERM use the same graceful cleanup.

### Control HTTP

Control shares `127.0.0.1:<active-port>`, not a second listener. Every route requires exact protected
`X-GHCG-Control-Token` and `X-GHCG-Instance-Nonce`; clients verify returned
`instance = {pid:number,processStartIdentity:string,instanceNonce:string}` against the file and OS identity.
Reject browser credential modes; browser Admin cookies/CSRF are not control authentication. Control is excluded from
inference/Admin middleware and static fallback.

| Method/path under `/__ghcg/control/v1` | Body | Success |
| --- | --- | --- |
| `GET /status` | none | 200 `{data:{state:"running",instance}}` |
| `POST /stop` | none | 202 `{data:{instance}}` |
| `POST /admin-bootstrap` | none | 200 `{data:{token:string,expiresAt:string}}` |
| `POST /command` | `{operation,arguments}` | 200 `{data:<command-result>}` |

Validate exact operation/argument shapes from the CLI table below without coercion or unknown fields. Accept JSON
media type with optional UTF-8 charset and absent/single `identity` encoding for commands; reject query parameters.
No-body routes reject nonempty bodies. Command body is bounded at 1 MiB; first excess byte cancels reading.
Client abort cancels body/use-case work and emits no further bytes. Dispatch in-process through the same domain
modules/revision rules as Admin, never by spawning another `ghcg`.

All responses use `application/json; charset=utf-8` and `Cache-Control: no-store`.
Failures are `{error:{code,message}}` with fixed pairs:

| Condition | HTTP / code / message |
| --- | --- |
| Missing/wrong token | 401 / `unauthorized` / `unauthorized` |
| Nonce/identity mismatch | 409 / `instance_mismatch` / `instance mismatch` |
| Not ready, or bootstrap mint `capacity`/`closed` | 503 / `not_ready` / `not ready` |
| Malformed command/body | 400 / `invalid_command` / `invalid command` |

Application failures keep canonical CLI categories and safe messages, not exception text. `mintBootstrap()` returns
`issued` with token/expiry, `capacity` for the ninth outstanding token, or `closed`; control exposes no internal counts.

## CLI contract

Root help begins `Usage: ghcg [--data-dir <path>] [--json] <command>`; root/subcommand help comes from one immutable
command registry in this order. This is the complete command grammar (no `chat` command or legacy aliases):

```text
ghcg serve
ghcg start
ghcg stop
ghcg restart
ghcg status
ghcg auth login [--host <domain>]
ghcg auth login poll <flow-id>
ghcg auth logout [--account <account-id>]
ghcg auth status
ghcg accounts list
ghcg accounts use <account-id>
ghcg accounts remove <account-id>
ghcg models list [--account <account-id>]
ghcg models current
ghcg models set <model-id>
ghcg config get [key]
ghcg config set <key> <value>
ghcg admin open
```

All commands accept global `--json` and `--data-dir`; only `serve/start` additionally accept `--port` and `--log-level`.
Auth/accounts/models/config/admin commands require a running foreground or managed gateway and use protected control
only; they never open application SQLite or secret files in another process. An unavailable gateway is exit 5; the
operator remedy is `ghcg start` or `ghcg serve`. Wrong data-dir reports stopped/not-found rather than finding another
instance. `stop/restart` manage only detached instances.

Human success is two-space JSON encoding of `data` plus one LF on stdout; human error is exactly
`error: <safe message>\n` on stderr. JSON mode emits exactly one compact object plus LF:
`{ok:true,data:<value>}` or `{ok:false,error:{code,message}}`, with success/error stream separation.
Never print secrets, bootstrap URL/token or complete upstream endpoint. Foreground logs use stderr; daemon logs use
bounded JSONL. `admin open` sends the fragment URL directly to the OS browser launcher and returns only `{opened:true}`.

Interactive login is the only progress UI: exactly `Code: <userCode>`, `Open: <verificationUri>` and terminal
`Authenticated: <accountId>` lines, polling until terminal or interrupt. JSON login starts a flow, emits one pending
start DTO and exits 0 without polling; automation uses `ghcg --json auth login poll <flow-id>`. Pending polls do not
consume state; terminal result is observable once, then removed. `auth status` reports account authentication, not flows.

`CliLifecycleResult` has required fields
`{state:"running"|"stopped"|"stale"|"conflict"|"unreachable",managed:boolean|null,pid:number|null,
startedAt:string|null,port:number|null,dataDir:string}`.
`serve` emits running/managed-false after readiness once, then remains foreground without further stdout.
`start/restart` return running managed state (an already verified foreground `start` reports the actual instance);
`stop` returns stopped; `status` returns observed state.

| Exit | Required interpretation |
| ---: | --- |
| 0 | Success/idempotent desired state, including already-running start and already-stopped stop |
| 1 | Unclassified internal failure |
| 2 | Usage/input/config validation |
| 3 | Missing resource/state, application CAS conflict; `status` stopped returns lifecycle data with this exit |
| 4 | Security/permission failure |
| 5 | Remote/timeout/unavailable or stale/conflict/unreachable daemon |
| 130 | User interrupt |

Canonical errors below are not replaceable by generic `remote_error` or arbitrary exception text:

| Code | Exit | Exact safe message |
| --- | ---: | --- |
| `internal_error` | 1 | `internal error` |
| `usage_error` | 2 | `usage error` |
| `validation_error` | 2 | `validation error` |
| `not_found` | 3 | `not found` |
| `revision_conflict` | 3 | `revision conflict` |
| `permission_denied` | 4 | `permission denied` |
| `security_error` | 4 | `security error` |
| `remote_error` | 5 | `remote error` |
| `timeout` | 5 | `timeout` |
| `unavailable` | 5 | `gateway unavailable` |
| `daemon_stale` | 5 | `daemon stale` |
| `daemon_conflict` | 5 | `daemon conflict` |
| `daemon_unreachable` | 5 | `daemon unreachable` |
| `interrupted` | 130 | `interrupted` |

Control operations share [Admin DTOs](#admin-dtos); `?` denotes optional, not nullable:

| Operation | Arguments | `data` |
| --- | --- | --- |
| `auth.login.start` | `{host?:string}` | `DeviceFlowStart` |
| `auth.login.poll` | `{flowId:string}` | `DeviceFlowState` |
| `auth.logout` | `{accountId?:string}` | Final `AdminAccount`; absent account targets current default |
| `auth.status` | `{}` | `{defaultAccountId:string\|null,accounts:AdminAccount[]}` |
| `accounts.list` | `{}` | `AdminAccounts` |
| `accounts.use` | `{accountId:string}` | Updated `AdminAccounts` |
| `accounts.remove` | `{accountId:string}` | Final `AdminAccount` |
| `models.list` | `{accountId?:string}` | `AdminModels` |
| `models.current` | `{}` | `{accountId:string,preferredModel:Preference\|null}` |
| `models.set` | `{modelId:string}` | Updated `Preference` |
| `config.get` | `{key?:string}` | `AdminRuntimeConfig` or `{key:string,value:number,range:Range}` |
| `config.set` | `{key:string,value:string}` | Updated `AdminRuntimeConfig` |

Without a user-supplied revision the running dispatcher reads current revision and makes **one** CAS attempt.
Concurrent change returns exit 3 `revision_conflict`, not silent retry. Logout and remove share asynchronous,
idempotent account removal, preserving identity/usage but clearing credentials/preferences/caches.

## Admin contract

### Authentication and request handling

Control mints a 60-second single-use bootstrap token. Browser URL carries it only in the fragment; SPA removes the
fragment and exchanges once via `POST /admin/api/v1/auth/bootstrap`. Session/CSRF client state is memory-only, never
browser persistent storage. Cookie is `HttpOnly; SameSite=Strict; Path=/admin`; idle expiry is 30 minutes and absolute
expiry 12 hours. Restart invalidates every session/bootstrap. Bootstrap alone is exempt from existing session and
CSRF, but still requires the exact active listener Origin and unexpired single-use token, including race-safe consumption.
Every other mutation requires session, `X-GHCG-CSRF` and exact `http://127.0.0.1:<active-port>` Origin; missing, null
or alternate Origin fails closed. Session-authenticated GET/SSE routes are not a bootstrap bypass.

Admin owns bounded JSON parsing, TypeBox no-coercion validation, security, error envelopes and SSE, without inference
WireJson/presenters/admission. Mutations accept only `application/json` with optional UTF-8 charset and absent/single
`identity` encoding. Empty, malformed, non-object, unknown-field, unsupported-media and over-limit bodies are
`400 validation_failed`. Capture current `limits.requestBodyBytes` at request handling start; cancel on first excess
byte. No-body routes reject nonempty bodies; every route rejects unknown/duplicate query fields. Caller abort/close
cancels reader, catalog/device flow/use case/subscription and writes no more bytes.

JSON success is `{data:<value>}`; failure is `{error:{code:string,message:string,requestId:string}}`.
JSON is `application/json; charset=utf-8`; every JSON/SSE response has `Cache-Control: no-store` and gateway-generated
`x-request-id`, never an echoed inbound ID. HTTP 204 has no body.

| HTTP | Code | Exact message |
| ---: | --- | --- |
| 400 | `validation_failed` | `validation failed` |
| 401 | `unauthenticated` | `unauthenticated` |
| 403 | `forbidden` | `forbidden` |
| 404 | `not_found` | `not found` |
| 409 | `revision_conflict` | `revision conflict` |
| 503 | `capacity_exceeded` | `capacity exceeded` |
| 500 | `internal_error` | `internal error` |

### Routes

Paths below are relative to `/admin/api/v1`; success values are wrapped in `data` unless 204.

| Method/path | Input | Success |
| --- | --- | --- |
| `POST /auth/bootstrap` | `{token:string}` | 200 `AdminSession` + cookie |
| `GET /auth/session` | none | 200 `AdminSession` |
| `POST /auth/logout` | no body; CSRF/Origin | 204, invalidate current session |
| `GET /status` | none | `AdminStatus` |
| `GET /usage` | filters/cursor below | `AdminUsagePage` |
| `GET /accounts` | none | `AdminAccounts` |
| `POST /device-flows` | `{host:string}` | 201 `DeviceFlowStart` |
| `GET /device-flows/:flowId` | none | `DeviceFlowState` |
| `DELETE /accounts/:accountId` | `{expectedRevision:number}` | Final `AdminAccount` |
| `PUT /accounts/default` | `{accountId:string,expectedRevision:number}` | Updated default account and new default revision (`AdminAccounts`) |
| `GET /models` | optional `accountId`, otherwise current default | `AdminModels` |
| `POST /models/refresh` | `{accountId:string}` | Refreshed `AdminModels` with new generation |
| `PUT /models/preferred` | `{accountId:string,modelId:string,expectedRevision:number}` | Updated `Preference` |
| `GET /config` | none | `AdminRuntimeConfig` |
| `PUT /config` | `{expectedRevision:number,config:RuntimeConfig}` | Complete updated `AdminRuntimeConfig` |
| `GET /history` | none | `HistorySummary` |
| `DELETE /history` | `{expectedRevision:number}` | Cleared `HistorySummary` and transactional revision |
| `GET /events` | filters/cursor below | `AdminPage<AdminOperationalEvent>` |
| `GET /events/stream` | no query/body; optional `Last-Event-ID` | Authenticated monitoring SSE |

<a id="admin-dtos"></a>
### Stable DTOs

This compact type notation defines public fields, not an implementation sketch: all fields are required unless `?`;
`null` is explicit and distinct from omission. Times are UTC strings; counts/revisions/generations/limits are numbers.
`RuntimeConfig` is **exactly** the complete nested 15-key registry above; `ranges` is response-only.

| Type | Fields |
| --- | --- |
| `Range` | `{min:number,max:number,unit:string}` |
| `Preference` | `{revision:number,modelId:string,validity:"valid"\|"invalid"}` |
| `AdminSession` | `{csrfToken:string,idleExpiresAt:string,absoluteExpiresAt:string}` |
| `DeviceFlowStart` | `{flowId:string,userCode:string,verificationUri:string,expiresAt:string,pollIntervalSeconds:number}` |
| `DeviceFlowState` | `{state:"pending"}` or `{state:"complete",account:AdminAccount}` or `{state:"expired"}` or `{state:"failed"}` |
| `AdminAccount` | `{accountId:string,host:string,numericUserId:string,login:string\|null,displayName:string\|null,state:"active"\|"removing"\|"removed",revision:number,authenticatedAt:string\|null,preferredModel:Preference\|null}` |
| `AdminAccounts` | `{defaultRevision:number,defaultAccountId:string\|null,items:AdminAccount[]}` |
| `AdminModels` | `{accountId:string,catalogGeneration:number,fetchedAt:string,preferredModel:Preference\|null,items:AdminModel[]}` |
| `AdminModel` | `{id:string,name:string,vendor:string,maxInputTokens:number\|null,maxOutputTokens:number\|null}` |
| `AdminRuntimeConfig` | `{revision:number,config:RuntimeConfig,ranges:Record<string,Range>}` |
| `HistorySummary` | `{revision:number,count:number,oldestAt:string\|null,newestAt:string\|null,ttlDays:number,maxResponses:number}` |
| `UsageTotals` | `{requestCount:number,errorCount:number,inputTokens:number,outputTokens:number,cacheTokens:number,latencySumMs:number,latencyMaxMs:number}` |
| `AdminUsageBucket` | All `UsageTotals` fields plus `{utcHour:string,accountId:string,protocol:string,resolvedModel:string,outcome:string}`; protocol/outcome are the fixed telemetry enums below |
| `AdminUsagePage` | `{items:AdminUsageBucket[],nextCursor:string\|null,totals:UsageTotals}` |
| `AdminOperationalEvent` | `{eventId:string,occurredAt:string,kind:string,severity:"info"\|"warning"\|"error",metadata:Record<string,string\|number\|boolean\|null>}`; fixed kinds/per-kind allowlists below |
| `AdminPage<T>` | `{items:T[],nextCursor:string\|null}` |

`AdminStatus` has these exact fields:

| Field | Type |
| --- | --- |
| `version`, `uptimeMs`, `health` | `string`, `number`, literal `"ok"` |
| `performance`, `degradedSince?` | `"healthy"\|"degraded"`, optional `string` |
| `performanceMetrics` | Array of `{metric:"buffered_p95_ms"\|"stream_event_p95_ms"\|"checkpoint_p95_ms"\|"event_loop_p95_ms",state:"healthy"\|"degraded"\|"insufficient_data",actual:number\|null,threshold:number,samples:number,startedAt:string\|null}` |
| `admission` | `{activeRequests:number,activeStreams:number,queuedRequests:number,activeMax:number,queueMax:number}` |
| `storage` | `{historyCount:number,usageBucketCount:number,eventCount:number}` |
| `telemetry` | `{pendingMutations:number,droppedUsageUpdates:number,droppedOperationalEvents:number}` |
| `daemon` | `{managed:boolean,pid?:number,startedAt?:string}` |

`GET/PUT config` return complete config, revision and hard ranges; every config field is required on PUT. Account,
default, preference, history and config CAS remain independent. Device-flow state is memory-only except resulting
account/credential; at most eight flows exist, upstream expiry is locally capped at 15 minutes, and terminal flows
are removed after observation or expiry. Expose user code/verification URI, **never device code**.

### Queries and monitoring

`AdminTelemetry` owns read-only SQLite usage/event queries, opaque cursors, filtered totals, replay and sanitized
subscriptions while reusing the same retention/sanitizer. Admin owns browser subscriber caps/queues, replay/reset
ordering, heartbeat and slow-consumer disconnect. Optional observers do not alter recorder batching, cleanup or
performance results when absent.

Usage/events pagination has opaque `cursor`, integer `limit` default 100/range `1..500`; events also cannot exceed its
512-row store. Usage defaults to last 24 hours; accepts UTC `from`/`to` in the **90-day retained query range** and
optional exact `accountId`, `protocol`, `resolvedModel`, `outcome`. That query contract is not silently widened when
storage retention is configured above 90 days. Totals cover the entire filtered range, not the current page.
Events allow exact `kind`, `severity`, UTC `from`/`to`. Unknown/duplicate fields and malformed queries fail validation;
there is no implicit coercion.

Monitoring media type is `text/event-stream; charset=utf-8`. Compact UTF-8 JSON field order and LF framing are exact:

```text
id: <event-id>\n
event: operational\n
data: {"kind":"operational","event":<AdminOperationalEvent>}\n\n

event: performance\n
data: {"kind":"performance","status":<complete AdminStatus>}\n\n

event: reset\n
data: {"kind":"reset","reason":"history_unavailable","latestEventId":<string-or-null>}\n\n
```

Only operational events carry decimal `id`. No `Last-Event-ID`: one performance snapshot, then live events.
Retained decimal ID: replay later persisted events ascending, then snapshot/live. Malformed ID: 400. Valid
evicted/unknown ID: one reset, then snapshot/live. Reconnect never duplicates a persisted ID. Optional heartbeat
`: keep-alive\n\n` every 15 seconds is not queued as an event. Disconnect slow subscribers at 128 pending events or
1 MiB without a synthetic terminal; reject subscriber nine with capacity error. Closed Admin fails closed and releases
sessions/bootstrap/subscriptions/heartbeat.

### Six-view static UI

Exactly six primary views: **Overview**, **Accounts**, **Models**, **Configuration**, **Responses History**, **Events**.
They expose status/usage/performance, GitHub.com/GHES device login/default/removal, catalog refresh and explicit
preference recovery, complete config CAS, history summary/confirmed clear, and event pagination/SSE/recovery.
Browser event state is capped at 512; closing the page creates no new daemon persistent state (sessions still expire).
Keyboard navigation, labels, loading/error/alert states and destructive confirmation must work. Controls and links
need accessible names, unique IDs, one `main` landmark and one `h1`; expiry/restart lockout restores keyboard focus.
Semantic accessibility smoke is not a claim of full WCAG conformance or pixel equivalence.

Static package delivery includes index, Vite manifest, hashed JavaScript entry and CSS. Browser executable/profile,
Playwright reports/traces/results are excluded from npm. Browser memory is never daemon RSS. No client protocol/chat
console, SSR, extra primary view or second server.

<a id="telemetry"></a>
## Telemetry and privacy

Usage key is `(UTC hour,accountId,protocol,resolvedModel,outcome)`; fields are those of `UsageTotals`. Persist request/
error counts, input/output/cache tokens, latency sum/max, not per-request contents or request IDs. Fixed protocols:
`openai_chat`, `openai_responses_native`, `openai_responses_bridge`, `anthropic`, `ollama`. Fixed outcomes:
`success`, `client_error`, `authentication_error`, `overloaded`, `upstream_error`, `timeout`, `aborted`, `internal_error`.
Metric labels are bounded/fixed; request IDs, arbitrary model strings and user content cannot become unbounded labels.

Operational Events are diagnostics, not Responses History. Kinds are exactly `gateway_started`, `gateway_stopped`,
`request_failed`, `account_authenticated`, `account_removed`, `default_account_changed`, `preferred_model_changed`,
`runtime_config_changed`, `catalog_refreshed`, `performance_degraded`, `performance_recovered`, `telemetry_dropped`,
`metadata_rejected`, `daemon_start_failed`. Severity is `info|warning|error`. **Each kind has its own allowlist**;
the union of permitted metadata concepts is request/account IDs, protocol/status/category, revisions/counts, fixed
metric names and numeric actual/threshold. Values are only string/number/boolean/null, never nested JSON.
Login/display names, paths, arbitrary messages/exception text and complete upstream endpoints are excluded.

No Authorization/headers, OAuth/Copilot/admin/control tokens, real prompts/responses/tool payloads or complete upstream
error bodies enter telemetry, logs, public errors or fixtures. Logging uses classification, request ID, protocol/status
and sanitized upstream host only. Account identity/display metadata is returned only by the designated authenticated
management DTOs, not diagnostic spillover. Admin Events reads SQLite, never tails JSONL.

The one nonblocking telemetry writer batches short transactions with bounded `flush(signal)`. Saturation is deterministic:

1. Usage first coalesces an existing pending bucket key. On a full queue with a new key, evict oldest pending **Usage**
   update; if none exists drop the incoming update. Add the lost update's **request count** to `droppedUsageUpdates`.
2. An Operational Event on a full queue evicts oldest pending **Operational Event**; if none exists drop incoming.
   Increment `droppedOperationalEvents` once.
3. Neither type evicts the other. The next successful flush persists aggregate saturating counters in `telemetry_state`;
   expose both counters in Admin, without recursively creating one Operational Event per drop.
4. Transaction rollback retains pending work and counters for retry, without duplicate committed counts; abort/failure
   cannot masquerade as a successful flush. Critical writes bypass this queue. Hard crash may lose uncommitted
   noncritical batches; graceful shutdown flushes within ten seconds.

Apply [fixed metadata/JSONL bounds](#fixed-capacities) before emission and [deterministic retention](#history-and-retention)
in owning transactions. JSONL age and file-count limits both hold, including rotation boundaries; an exact 64-KiB
complete record is allowed, a 64-KiB payload plus newline is not.

## Performance contracts

Scripted local upstream, deterministic inputs/clock/UUID and isolated SQLite state measure gateway overhead, not
provider/network time. Exercise production composition, listener, all route/Admin/control mounts and real history
transactions; no constant/no-op substitute for measured work.

| Metric | Required gate |
| --- | ---: |
| Idle resident memory | ≤64 MiB |
| After 1000 completed/aborted streams and stabilization | ≤warmed baseline +16 MiB |
| Buffered request overhead p95 | ≤5 ms |
| Stream event conversion/forwarding p95 | ≤2 ms |
| Semantic Checkpoint SQLite commit p95 | ≤5 ms |
| Event-loop delay p95 | ≤10 ms |

Every metric must pass in **three consecutive runs**. p95 is nearest-rank
`sorted[ceil(0.95 * n) - 1]` on the documented sample set. Artifacts record environment/Node/platform, launch flags,
warm-up, sample counts, every value, p95, resident samples and per-run decisions; a past result is no current guarantee.
Use Windows Private Bytes, Linux RSS/PSS, macOS RSS, not V8 heapUsed, package bytes or browser memory.
The stream-stability workload warms 1000 executions, then measures 500 completed plus 500 client-aborted streams
before stabilization. Include idle/single/few-concurrent streams, history empty→512→cleanup and daemon Admin-assets
closed/open measurements; fetching assets without a browser measures daemon impact, not browser memory.

Current benchmark entrypoints are `npm run build`, `npm run bench -- baseline --repeat 3` and
`npm run bench -- full --repeat 3`; [benchmark tooling](../scripts/tooling/bench.ts) defines mechanical artifact paths.
Keep outbound network blocked with deterministic remotes.

Runtime uses 5-minute rolling windows for buffered/event/checkpoint/event-loop p95 at the same thresholds.
Buffered/event/checkpoint need ≥20 observations per window; otherwise `insufficient_data` neither advances nor clears
that metric's consecutive counter. Event-loop delay is continuously sampled. Three consecutive over-threshold
evaluations of a metric cause one healthy→degraded transition; a degraded metric clears only after three subsequently
evaluated healthy windows. Overall recovery requires the affected metrics recovered, not an insufficient-data window.
Admin reports actual, threshold and startedAt; emit one sanitized event on entering and one on clearing degradation.
Health/readiness and protocol semantics do not change; there is no automatic tuning. Investigate batching/serializer/
user-selected concurrency first; any persistence-worker evaluation must re-pass resident-memory gates.

<a id="fixture-contracts"></a>
## Verification and delivery contracts

Test through production interfaces: Fetch request → endpoint → scripted backend → response bytes. Backend captures
plan, URL, fixed headers (including vision/request-ID behavior), exact serialized body and logical call count; control
byte splits deterministically. Hono request tests cover buffered routing/middleware; real loopback listeners cover
streaming, disconnect, redirect, timeout and wire bytes. Fixed/sequence clocks and UUIDs replace randomness.
Credential tests may use memory adapter; history uses production code on isolated SQLite, never a divergent fake.
Ollama fallback token counting stays inside Ollama, with composition only wiring the seam.

### Golden ownership and required coverage

Every golden has stable English `caseId` and adjacent `manifest.json` fields `caseId`, `owner`, `source`, `input`,
`expected`, `encoder`. `source` must resolve to its retained normative section. Existing `RM-*` owner identifiers
in fixture metadata are stable provenance, not an active implementation sequence.

| Fixture family | Required coverage / normative source |
| --- | --- |
| `wire-json` | Lexemes/member order/duplicates, missing/null/false/0/empty, Unicode/surrogates/code-point sort, invalid UTF-8/JSON, compact output, depth/byte bounds; [Wire JSON](#101-wire-json) |
| `gateway-http-host` | Body read/limits, default and nondefault snapshots, admission/downshift, all timers, raw/duplicate headers, readiness loss, pre/post-commit and abort cleanup; [HTTP](./gateway_http_contracts.md) |
| `accounts` | Host/ID canonicalization, deterministic default fallback, caps, login/remove/relogin, generation crash/retry, owner/ACL/reparse/flush failures; [accounts](#github-environments) |
| `copilot-transport` | Refresh threshold/recheck, GHES, complete discovery DTO/cache/fallback, headers/redirect stripping, every SSE byte split/BOM/newline/multi-data/error/DONE/EOF, cancellation; [model listing](./github_copilot_model_listing_apis.md), [pipeline](#91-pipeline) |
| `model-catalog` | Strict CAPI fields, filtering/order/duplicates/empty, no-TTL/no-single-flight and generation races, three serializers/nullable limits/header-presence/error presenter; [model listing](./github_copilot_model_listing_apis.md) |
| `openai-chat` | Request capture/reserialization, model matrix/one resolution, buffered/SSE/usage, success-only DONE, comments/first payload, resource release, zero-upstream rejection/abort; [OpenAI Chat](./openai_chat_completions.md) |
| `ollama` | Request/nonstream/reducer/terminal, image/ordered tool arguments, sparse tools, token fallback, Go order/omitempty/HTML/Unicode/control/LF goldens; [Ollama](./ollama_chat_to_chat_completions.md) |
| `anthropic` | Header distinction, request/media/tool/schema/reasoning, nonstream/block lifecycle/usage/repair, finish-first/no-finish/exception, Python spacing/ASCII/SSE text; [Anthropic](./claude_messages_to_chat_completions.md) |
| `responses-history` | One decoder owner, control-field types/duplicates, enrichment/unique versus ambiguous calls, input shape, TTL/eviction/revision/sequence, restart/rollback/checkpoints; [history](./codex_response_to_chat_completions.md#8-request-history) |
| `responses-native` | Routing matrix and frozen metadata, exact URL/headers/body, only specified ID normalization, usage/outcome, invalid 2xx, SSE framing/type/terminal/EOF, no history/fallback; [routing](./openai_responses_routing.md) |
| `responses-bridge-request` | Input/tools/media/depth/clamp, ordered/canonical args, reasoning/history, namespace/custom/tool-search/collision first-wins and immutable contexts; [bridge](./codex_response_to_chat_completions.md#141-request-differential) |
| `responses-bridge-nonstream` | Complete envelope/all choices/defaults/items/images/tools/provider fields/usage/managed IDs, argument failure, cross-direction restoration; [bridge](./codex_response_to_chat_completions.md#142-response-differential) |
| `responses-bridge-stream` | Independent item lifecycles, added-before-delta/done, stable indices, sequence from 1, late tools, one-item pull-ahead, completed-only checkpoints, no synthetic failed; [bridge](./codex_response_to_chat_completions.md#11-streaming-chat-response) |
| `responses-endpoint` | Native/bridge Fetch integration, same plan/account, request capture, history failure-before-bytes, timeouts/abort/post-commit, namespace isolation, alias closure; [routing](./openai_responses_routing.md), [bridge](./codex_response_to_chat_completions.md) |

Expected bytes are committed; generators run only explicitly as
`npm run fixtures:generate -- --case <caseId> --accept`, with case IDs/reasons and human review. Verification
`npm run fixtures:verify` (or a documented owner-specific verifier) is reproducible offline and never updates
snapshots. Record pinned upstream commits and reference encoder versions/commands alongside fixture evidence;
Go/Python reference encoders complement object differentials. No local upstream checkout, live account,
random clock/UUID or remote API is a test dependency.

Management coverage includes exact CLI help/output/exit/locator/CAS and cancellation; daemon concurrent-start lock,
PID reuse/forgery/stale/corrupt/weak-permission/unreachable safety; bootstrap expiry/reuse/races, cookie/Origin/CSRF;
all independent revisions; flow/session/token/subscriber caps; opaque cursor/filtered totals; exact
operational/performance/reset/heartbeat/replay; active-request versus active-stream counts and slow disconnect;
SQLite empty/current/older/newer/checksum drift/lower-version gaps/rollback; config seed/no-coercion/failed swap;
mixed/usage-only/event-only saturation, persisted counters, rollback, metadata/record bounds, rotation and retention;
two/three/insufficient-data performance windows. Repeated completion/abort must return active scopes, permits,
listeners, timers, locks and sockets to zero/stable resident memory.

Admin Playwright uses exactly seven stable offline Chromium behavior flows: `bootstrap-and-session-expiry`,
`github-and-ghes-account-lifecycle`, `model-refresh-invalidates-preference`, `config-revision-and-security-rejection`,
`responses-history-inspect-and-clear`, `events-and-degraded-recovery`, `daemon-restart-invalidates-session`.
Record route/flow matrix, semantic accessibility output and failure-only traces. Fixture-intercepted UI tests prove
the SPA behavior, not a live backend integration or full accessibility certification.

### Offline gates and evidence

Current commands are `npm run typecheck`, `npm run lint`, targeted `npm test -- <paths>`, `npm run build`,
`npm run fixtures:verify`, `npm run e2e`, `npm run smoke:sqlite`, the benchmarks above and `npm run pack`.
Use applicable targeted validation for a change; release checks run the complete required matrix, not SDK suites
implicitly. PR evidence names commands, environment, artifacts and limits of the evidence; byte changes name cases
and reasons, hot-path/resource changes include measured deltas. Keep generated output/data out of commits and check
whitespace/link/anchor integrity for documentation.

Supported Node.js 24 platforms are Windows x64, Linux x64/arm64 and macOS x64/arm64. The current release matrix runs
typecheck/lint/build/tests/fixtures, seven Chromium flows, SQLite install/load/WAL smoke, three-run benchmarks and
installed-package smoke on **all five**, not just a configured matrix treated as proof of a pass.
One explicit dependency-provision phase may contact only the configured npm registry and Playwright browser artifact
source with lockfile and OS/arch/Node/npm/lockfile-keyed cache/provenance. Verify cached `npm ci --offline`.
After provisioning, build/test/fixtures/E2E/benchmark/package smoke have outbound network blocked; OAuth, GitHub REST,
CAPI, Chat and Responses are scripted and developer credentials are never read.

`npm run pack` builds clean `dist`, creates an actual tarball, verifies the exact package allowlist, manifest,
asset paths/hashes/sizes and tarball SHA-256, performs offline clean install, installed `ghcg --help`, foreground
health and detached start/status/stop. `prepack` builds server and Admin assets; package contains only intended
compiled runtime/assets, README and license, never test/browser artifacts. Preserve sanitized per-platform evidence
and a clean worktree after smoke. Fresh and partially migrated new-version databases must both work.

Apply the [review gate and deferral policy](../AGENTS.md#review-gate) after checking the change's behavior, structure,
shared seams, tests, fixtures and evidence. Default production paths have no stubs, TODO handlers, legacy fallback or
disabled failing tests. Required release gates cannot be waived by a follow-up issue. Release from a verified clean
commit, with maintainer-authorized publishing and a clean public-install check; historical tarball hashes and platform
results do not certify a new release.

### Manual-only official SDK boundaries

Lockfile-pinned `openai`, `@anthropic-ai/sdk`, `ollama` are dev dependencies. Both SDK suites are excluded from default
test patterns, CI, implementation acceptance and review reruns; writing/typechecking their files does **not** authorize
execution. A human must explicitly request each run.

- Offline: `GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk`, refusing without opt-in. Real loopback TCP listener,
  isolated state and scripted remotes; no SDK mocking or `app.request()` substitute; outbound blocked except loopback.
- Live: `GHC_GATEWAY_LIVE_TESTS=1 npm run test:live:sdk`, refusing without opt-in. Already-running local gateway at
  `GHC_GATEWAY_LIVE_BASE_URL` (default `http://127.0.0.1:31400`) uses the real Bound Account. No workflow sets either
  opt-in; no live execution in fixture generation.

Both tiers cover OpenAI models/Chat/Responses, Anthropic models/Messages, Ollama list/chat, nonstream and stream,
errors/request IDs and cancellation. Scenarios include system/ordinary multi-turn, PNG images, actual tool-result
second requests, mixed media/tools, streamed tools, reasoning, native and bridge Responses. SDK acceptance supplements
but cannot prove exact byte/order goldens; scripted captures still verify upstream requests.
Live uses minimal budgets, current catalog and optional explicit overrides
`GHC_GATEWAY_LIVE_CHAT_MODEL`, `GHC_GATEWAY_LIVE_VISION_MODEL`, `GHC_GATEWAY_LIVE_REASONING_MODEL`,
`GHC_GATEWAY_LIVE_RESPONSES_MODEL`. `GHC_GATEWAY_LIVE_NATIVE_RESPONSES_NOT_AVAILABLE=1` is permissible only after
verifying no native-capable catalog model; offline routing remains mandatory. Assert structure/order/nonempty terminal,
not nondeterministic prose. Retain only timestamp, sanitized GitHub host, SDK versions, selected model IDs and
pass/`not_available`, never content/credentials/full endpoints. An available-route failure blocks release; rerun
transient failures, never change goldens to hide them. Maintainers separately authorize SDK/live checks and publishing.
