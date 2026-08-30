# Make the GHC Gateway rename a clean break

The refactor publishes `@ljie-pi/ghc-gateway`, installs the `ghcg` executable, uses `~/.ghc-gateway` and `GHC_GATEWAY_`, and ultimately renames the GitHub repository to `ljie-PI/ghc-gateway`. It does not import old local state or retain `ghcp-ollama`, `ghcp-gateway`, `ghcpo`, or `ghcpo-server` runtime aliases; users authenticate and configure the new application again, which keeps the new storage and command contracts free of permanent migration branches.
