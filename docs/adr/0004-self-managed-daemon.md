# Use a self-managed daemon

The `ghcg` executable provides foreground `serve` plus `start`, `stop`, `restart`, and `status` commands backed by one detached process, a PID file, process start time, instance nonce, and authenticated local control endpoint. It does not require an external or operating-system supervisor and does not keep a watchdog process for automatic restart, trading crash recovery for simpler installation and a lower memory footprint while protecting against stale-PID process termination.
