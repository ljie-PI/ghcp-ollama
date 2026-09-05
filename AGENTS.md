# Agent guide

## Sources of truth

- **Runtime and management contracts:** read `docs/architecture.md` before changing module ownership, configuration, persistence, account lifecycle, CLI/daemon/control behavior, Admin APIs, telemetry, or resource limits.
- **Gateway HTTP behavior:** read `docs/gateway_http_contracts.md` before changing listener, request parsing, admission, limits, timeouts, request IDs, or public errors.
- **OpenAI Chat:** read `docs/openai_chat_completions.md` before changing `/v1/chat/completions` request planning, native Chat responses, SSE, or model resolution.
- **OpenAI Responses routing:** read `docs/openai_responses_routing.md` before changing native Responses selection, Chat bridging, upstream URLs, streaming, IDs, or history ownership.
- **Responses conversion:** read `docs/codex_response_to_chat_completions.md` before changing Responses <-> Chat request, response, stream, tool, reasoning, or history behavior.
- **Anthropic conversion:** read `docs/claude_messages_to_chat_completions.md` before changing Messages <-> Chat behavior.
- **Ollama conversion:** read `docs/ollama_chat_to_chat_completions.md` before changing `/api/chat` behavior or bytes.
- **Model listing:** read `docs/github_copilot_model_listing_apis.md` before changing credentials, CAPI model fetching, caching, `/v1/models`, or `/api/tags`.

Choose authority by responsibility: the owning protocol contract defines wire behavior; architecture defines shared runtime and management contracts. Preserve each protocol's pinned-source priority and resolve conflicting requirements explicitly before changing behavior. Legacy implementation and passing tests do not override these contracts.

## Delivery workflow

- Start focused maintenance branches from the latest `main` and submit pull requests targeting `main`.
- Keep `main` unchanged until the reviewed pull request merges.
- Keep user-facing documentation aligned with the delivered runtime and CLI. Track task status and handoffs in GitHub Issues, not per-task specification files.

## Engineering guardrails

- Keep comments and code documentation in English.
- Keep credentials and request/response content out of commits, logs, metrics, and public errors.
- Treat exact protocol fields, ordering, terminal events, and wire bytes as observable behavior.
- Test through module interfaces; use deterministic clock/UUID inputs and protocol golden fixtures where required.
- Use the validation and fixture contracts in `docs/architecture.md`; official SDK suites require separate explicit authorization, including the offline suite.

## Review gate

Review the change against its owning contracts before opening a PR. Block changes that introduce or conceal:

- Spec-visible status, headers, payload, ordering, terminal, model-resolution, or history-ownership drift.
- Disclosure of credentials, request/response content, or unsafe upstream diagnostics.
- Unbounded state or unsafe cancellation, timeout, commit, and resource-cleanup paths.
- Missing required behavioral, byte-golden, or performance evidence.
- Broken shared interfaces or state ownership that makes dependent modules unsafe.
- Unreasonable structure: duplicated protocol state machines, misleading abstractions, hidden coupling, or control flow that obscures lifecycle boundaries.

Classify findings as must-fix, safe-to-defer, or no-action. A safe deferral requires a linked follow-up issue recording the finding, affected files, safety rationale and concrete acceptance criteria; list it in the PR's deferred follow-ups and leave no broken or fail-open dependency. Record source-backed reasons for false positives; clarify normative gaps before implementing behavior that depends on them.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
