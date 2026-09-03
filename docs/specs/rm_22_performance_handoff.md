# RM-22 performance benchmark evidence

## Command

```text
npm run build:refactor
npm run bench:refactor -- full --repeat 3
```

The benchmark runs the compiled production gateway composition with all public routes, Admin/control mounts, a real
loopback listener, and isolated SQLite WAL state. Copilot and model catalog remotes are deterministic scripted adapters;
the network guard rejects outbound connections. Browser memory is not started or measured.

Raw launch flags, warm-up counts, every sample, nearest-rank p95 values, resident-memory samples, environment, and per-run decisions
are written to `dist-refactor/bench/rm-22-full.json`.

## Windows x64 result

Node.js `v24.13.0`, Windows x64, September 3, 2026:

| Run | Idle Private Bytes | Stable stream delta | Buffered p95 | Event p95 | Checkpoint p95 | Event-loop p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 32.438 MiB | 0.523 MiB | 1.394 ms | 0.291 ms | 0.471 ms | 1.632 ms |
| 2 | 32.016 MiB | 0.000 MiB | 1.282 ms | 0.216 ms | 0.465 ms | 1.602 ms |
| 3 | 32.055 MiB | 0.258 MiB | 1.220 ms | 0.286 ms | 0.498 ms | 1.538 ms |

Every metric passed in every run. Each stream-memory run warms 1,000 executions, then measures 500 completed and 500
client-aborted executions before stabilization. Latency samples exercise gateway request parsing and response handling,
incremental SSE conversion/forwarding, the production `SqliteResponsesHistory.record` transaction, and event-loop
check-phase delay rather than constants or no-op substitutes.
