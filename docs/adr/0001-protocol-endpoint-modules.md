# Use protocol endpoint modules

Each client protocol is implemented as a deep Protocol Endpoint Module rather than through a shared `BaseAdapter` or reversible canonical message model. OpenAI Chat, Responses, Anthropic, and Ollama share transport capabilities, but their field defaults, state transitions, terminal behavior, errors, and exact bytes are materially different; keeping those rules local prevents a common abstraction from becoming a protocol switchboard and limits cross-protocol regressions.
