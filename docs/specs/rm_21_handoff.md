# RM-21 Delivery Handoff

## Scope and identity

RM-21 delivers the six-view Svelte Admin SPA, its static-serving seam, and delivery evidence. The refactor dry-run package includes `dist-refactor/admin/`, but the default package identity remains `@ljie-pi/ghcp-ollama@0.1.6`, legacy `main`, and legacy bins until RM-22 performs the atomic cutover.

No browser executable, browser profile, Playwright report, trace, or test result is included in the npm package. Browser process memory is excluded from daemon RSS evidence.

## Flow-to-route matrix

| Playwright flow | Admin routes exercised | Evidence focus |
| --- | --- | --- |
| `bootstrap-and-session-expiry` | `POST /auth/bootstrap`, `GET /auth/session`, `GET /status`, `GET /usage`, `GET /events/stream` | fragment removal, memory-only CSRF/session, semantic accessibility audit, expiry focus |
| `github-and-ghes-account-lifecycle` | common bootstrap/status routes, `GET /accounts`, `POST /device-flows`, `GET /device-flows/:flowId`, `PUT /accounts/default`, `DELETE /accounts/:accountId` | GHES login, default CAS, CSRF, removal |
| `model-refresh-invalidates-preference` | common bootstrap/status routes, `GET /accounts`, `GET /models`, `POST /models/refresh`, `PUT /models/preferred` | catalog refresh and explicit preference recovery |
| `config-revision-and-security-rejection` | common bootstrap/status routes, `GET /config`, `PUT /config` | revision conflict and CSRF/security rejection |
| `responses-history-inspect-and-clear` | common bootstrap/status routes, `GET /history`, `DELETE /history` | summary, confirmation, revisioned clear |
| `events-and-degraded-recovery` | common bootstrap/status routes, `GET /events`, `GET /events/stream` | degraded/recovered state and 512-event browser bound |
| `daemon-restart-invalidates-session` | common bootstrap/status routes followed by rejected `GET /accounts` | restart invalidation, no persisted secret, focused lockout |

Routes in the table are relative to `/admin/api/v1`. `common bootstrap/status routes` means the bootstrap exchange plus initial session data requests made by the SPA.

## Asset and package evidence

Canonical command: `npm run pack:refactor`.

The command runs `build:refactor`, reads `dist-refactor/admin/.vite/manifest.json`, requires one hashed JavaScript entry and one hashed CSS asset, and verifies the index, manifest, JS, and CSS paths against `npm pack --dry-run --json`. It writes `dist-refactor/pack-smoke.json` containing:

- Vite manifest contents;
- per-file path, bytes, SHA-256, and `packaged` status;
- Admin bytes, tarball bytes, unpacked bytes, and total file count;
- `defaultCutoverIdentityPreserved: true`;
- `browserArtifactsIncluded: false`.

Windows x64 evidence on Node `v24.13.0`:

| Measurement | Result |
| --- | ---: |
| npm package files | 109 |
| tarball bytes | 205,499 |
| unpacked bytes | 924,599 |
| required Admin asset bytes | 83,761 |
| required Admin assets packaged | 4 of 4 |

The generated hashes and filenames remain in `dist-refactor/pack-smoke.json`; they are intentionally generated from the current build rather than copied into this handoff.

## Accessibility evidence

`bootstrap-and-session-expiry` audits the rendered authenticated shell for accessible names on every button, input, select, textarea, and link; duplicate IDs; one `main` landmark; and one `h1`. The flow also proves keyboard-focus recovery by requiring the lockout heading to receive focus after expiry. Form labels, loading state, alerts, and view operations are exercised by the seven role/label-based flows.

The Chromium run writes `artifacts/refactor-ci/rm-21-accessibility.json`. The latest run reported 8 named controls, zero unnamed controls, zero duplicate IDs, one `main`, one `h1`, and `passed: true`.

This is a deterministic semantic smoke check, not a claim of full WCAG conformance or a pixel audit.

## Daemon RSS evidence

Canonical command: `npm run bench:refactor -- baseline --repeat 3`.

The benchmark loads the built production gateway and Admin static modules in one constrained Node process, records the daemon before an Admin request, reads the Admin index plus referenced assets, then records the same daemon after the page assets open. It never starts a browser. Results are written to `dist-refactor/bench/baseline.json` with `browserIncluded: false`.

Windows x64 Private Bytes from the latest three-run proof:

| Run | Admin closed | Admin open | Open delta |
| ---: | ---: | ---: | ---: |
| 1 | 35,454,976 | 70,197,248 | 34,742,272 |
| 2 | 35,905,536 | 70,885,376 | 34,979,840 |
| 3 | 35,815,424 | 70,168,576 | 34,353,152 |

The 64 MiB idle gate remains enforced by the separate baseline samples. The Admin comparison is evidence of the static page request's resident impact, not a substitute for that idle gate or the stream-stabilization gate. Browser memory is neither sampled nor substituted for process-resident memory.

## Verification

- `npm run typecheck:refactor`: passed.
- package/static/benchmark targeted Vitest: 11 passed.
- `npm run test:e2e:refactor -- tests/refactor/e2e/admin.spec.ts`: exactly 7 passed; traces retained only on failure.
- `npm run pack:refactor`: passed with all required Admin assets packaged.
- `npm run bench:refactor -- baseline --repeat 3`: passed; Admin closed/open evidence recorded with browser excluded.
