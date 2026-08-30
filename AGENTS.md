# Agent guide

## Sources of truth

- **Architecture or refactor work:** read `docs/architecture.md` before changing modules, interfaces, routes, runtime configuration, persistence, CLI behavior, or delivery workflow.
- **Implementation handoff:** read `docs/specs/refactor_master_spec.md` before claiming or implementing any refactor slice.
- **Gateway HTTP behavior:** read `docs/gateway_http_contracts.md` before changing listener, request parsing, admission, limits, timeouts, request IDs, or public errors.
- **OpenAI Chat:** read `docs/openai_chat_completions.md` before changing `/v1/chat/completions` request planning, native Chat responses, SSE, or model resolution.
- **OpenAI Responses routing:** read `docs/openai_responses_routing.md` before changing native Responses selection, Chat bridging, upstream URLs, streaming, IDs, or history ownership.
- **Responses conversion:** read `docs/codex_response_to_chat_completions.md` before changing Responses <-> Chat request, response, stream, tool, reasoning, or history behavior.
- **Anthropic conversion:** read `docs/claude_messages_to_chat_completions.md` before changing Messages <-> Chat behavior.
- **Ollama conversion:** read `docs/ollama_chat_to_chat_completions.md` before changing `/api/chat` behavior or bytes.
- **Model listing:** read `docs/github_copilot_model_listing_apis.md` before changing credentials, CAPI model fetching, caching, `/v1/models`, or `/api/tags`.

The production specifications above override the legacy JavaScript implementation. Do not preserve conflicting legacy behavior.

## Delivery workflow

- Start each refactor change from the latest `refactor` branch and merge it through a pull request targeting `refactor`.
- Keep `main` unchanged until the final `refactor` -> `main` pull request.
- Implement one coherent module or route at a time in the non-default TypeScript app. Keep the legacy default runtime intact until the master spec's atomic cutover slice removes it.
- Update `README.md` only after the runtime, CLI, and migration behavior are complete.

## Engineering guardrails

- Keep comments and code documentation in English.
- Keep credentials and request/response content out of commits, logs, metrics, and public errors.
- Treat exact protocol fields, ordering, terminal events, and wire bytes as observable behavior.
- Test through module interfaces; use deterministic clock/UUID inputs and protocol golden fixtures where required.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
