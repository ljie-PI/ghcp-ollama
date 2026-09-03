# RM-22 performance benchmark evidence

## Command

```text
npm run build
npm run bench -- full --repeat 3
```

The benchmark runs the compiled production gateway composition with all public routes, Admin/control mounts, a real
loopback listener, and isolated SQLite WAL state. Copilot and model catalog remotes are deterministic scripted adapters;
the network guard rejects outbound connections. Browser memory is not started or measured.

Raw launch flags, warm-up counts, every sample, nearest-rank p95 values, resident-memory samples, environment, and per-run decisions
are written to the ignored `artifacts/bench/rm-22-full.json`.

## Windows x64 result

Node.js `v24.13.0`, Windows x64, September 3, 2026:

| Run | Idle Private Bytes | Stable stream delta | Buffered p95 | Event p95 | Checkpoint p95 | Event-loop p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 32.473 MiB | 0.000 MiB | 1.252 ms | 0.298 ms | 0.483 ms | 1.594 ms |
| 2 | 32.508 MiB | 0.516 MiB | 1.204 ms | 0.283 ms | 0.475 ms | 1.555 ms |
| 3 | 31.676 MiB | 0.258 MiB | 1.260 ms | 0.310 ms | 0.459 ms | 1.585 ms |

Every metric passed in every run. Each stream-memory run warms 1,000 executions, then measures 500 completed and 500
client-aborted executions before stabilization. Latency samples exercise gateway request parsing and response handling,
incremental SSE conversion/forwarding, the production `SqliteResponsesHistory.record` transaction, and event-loop
check-phase delay rather than constants or no-op substitutes.
