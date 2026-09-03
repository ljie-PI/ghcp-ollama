# RM-22 Release Handoff

## Coding-agent result

RM-22 promotes the TypeScript gateway, local control, Admin API, and Svelte Admin application to the only packaged runtime. The implementation PR targets `refactor`; it does not publish, promote to `main`, rename the GitHub repository, or run the live provider suite.

## Package evidence

Canonical command: `npm run pack`.

The package gate builds from a clean `dist/`, creates an actual tarball, verifies an exact allowlisted manifest, computes SHA-256, performs an offline clean install, runs installed `ghcg --help`, probes foreground `/healthz`, and exercises detached start/status/stop. The latest local tarball SHA-256 was:

```text
ca5ab37b90bebcc6ee1cc2146213f24fe7dd7f4266799d73d31d0b7d160dd1a9
```

The exact manifest, sizes, asset hashes, installed CLI result, foreground health result, and daemon lifecycle result are written to `artifacts/ci/package-smoke.json`. CI uploads that file for each platform.

## Route and composition evidence

- Public routes: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, `/api/chat`, `/api/tags`, `/api/version`.
- Probes: `/healthz`, `/readyz`.
- Admin API matching precedes Admin static fallback.
- Local control matching precedes protocol routes.
- Gateway Foundation is the sole `/api/version` owner.
- Local control and Admin HTTP share one `AdminModule` instance.
- Shutdown closes control before Admin, then persistence and transport resources.
- Alias and trailing-slash closure is covered by the default test suite.

## Verification evidence

- Default typecheck, lint, build, and test commands passed.
- Default test suite: 367 passed with 3 platform-specific skips in the latest local run.
- Fixture verification: 54 generated/verified entries.
- Admin Playwright: exactly 7 offline flows passed.
- Guarded offline official SDK suite: 12 tests passed during implementation.
- Live official SDK suite was not run.
- Three-run full benchmark passed all documented RSS, stream-stability, buffered, stream-event, checkpoint, and event-loop thresholds. Raw local values are in `rm_22_performance_handoff.md` and generated benchmark artifacts.
- Fresh and partially migrated new-v1 databases passed the production migration set.
- Official-registry `npm ci` and `npm ci --offline` passed.

## Five-platform gate

The final CI matrix is:

- Windows x64
- Linux x64
- Linux arm64
- macOS x64
- macOS arm64

Each platform runs default typecheck, lint, build, tests, fixtures, seven Admin E2E flows, SQLite smoke, three-run benchmark, and installed-package smoke. The RM-22 PR check URL is the authoritative five-platform record and must be attached after the branch is pushed; this local handoff does not claim remote evidence before it exists.

## Maintainer checklist

1. Check out the merged `refactor` commit in a clean workspace.
2. Rerun all default gates and retain package, benchmark, route, daemon, and Admin evidence.
3. Run `GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk` with scripted remotes.
4. Run `GHC_GATEWAY_LIVE_TESTS=1 npm run test:live:sdk` only in the approved live environment and retain the sanitized result.
5. Review and merge the single `refactor` to `main` promotion.
6. Rename the repository to `ljie-PI/ghc-gateway` and verify redirects/default branch/remote metadata.
7. Publish `@ljie-pi/ghc-gateway@0.1.0` from the verified promoted commit.
8. Verify a clean public install and announce the clean break and reauthentication requirement.
