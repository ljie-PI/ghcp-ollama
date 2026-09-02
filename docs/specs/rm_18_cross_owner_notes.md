# RM-18 cross-owner edit notes

RM-18 integrates the non-default foreground runtime and CLI against modules delivered by earlier slices. The following cross-owner edits are intentional and are limited to seams required by the RM-18 command dispatcher or foreground composition:

- `src/accounts/account_directory.ts`: adds read-only default-account state and explicit account binding helpers so CLI/Admin-facing code can use existing account ownership without reopening SQLite or credentials.
- `src/accounts/device_flow.ts`: threads cancellation through device-flow start/poll and exposes poll interval/terminal states required by the CLI contract.
- `src/accounts/model_preferences.ts`: adds expected-revision checking to preference invalidation so CLI model listing performs one CAS attempt.
- `src/config/schema.ts` and `src/config/runtime_config.ts`: centralize runtime config range metadata beside the TypeBox schema so CLI and later Admin code do not duplicate config domain rules.
- `src/copilot/credential_provider.ts`: provides production composition callbacks for the Copilot backend/model-source seams already owned by RM-07.
- `src/protocols/ollama_chat/token_counter.ts`: keeps Ollama token-count fallback logic inside the Ollama module while RM-18 only wires it into foreground composition.

These changes do not add legacy aliases, do not alter default published entrypoints, and are covered by RM-18 targeted CLI/foreground integration tests plus existing refactor gates.
