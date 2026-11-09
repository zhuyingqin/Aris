# Reasoning input across tool continuations

The exported `conversation-export-9-1792117383256` failed with HTTP 400 from
`deepseek-v4.1-flash`: “The `reasoning_content` in the thinking mode must be
passed back to the API.” The desktop's generic error formatter hid that cause
because the provider's JSON envelope exceeded its safe display length.

The failure followed an automatic context checkpoint. Its compacted request
contained a continuation summary and four complete assistant/tool exchanges.
The first three assistant messages retained their tagged thinking blocks and
sent `reasoning_content`; the last provider response had emitted a tool call
without thinking. Conversion omitted the field entirely for that message.
Compaction preserved the original blocks correctly. It changed the conversation
boundary and left a request with one required protocol field absent.

A related request-conversion budget also omitted the newest reasoning after
128,000 bytes of older reasoning had been replayed. The preceding request had
reached 128,318 bytes and omitted newer tagged reasoning. That omission could
break tool continuation independently of compaction. A separate persistence cap
also truncated reasoning from a single streamed response at 32,000 characters.

For supported Chat Completions reasoning families, the shared executor now:

- Replays all tagged reasoning on every retained assistant exchange, verbatim.
  Runtime context accounting and compaction manage overall request size by
  removing complete exchanges.
- Sends `reasoning_content: ""` for a tool call when no replayable thinking was
  returned. This supplies the protocol field without fabricating reasoning or
  reusing another provider's display-only thinking. Existing saved tool-only
  messages receive the same treatment on their next request.
- Persists replayable streamed reasoning in full. The display-only reasoning
  cap and Responses encrypted-reasoning handling retain their existing behavior.

The change is limited to the families that already accept `reasoning_content`
as request input. Other models keep their existing request shape. No tool is
re-executed to repair history, and the failed session's stored files are untouched.

The desktop maps this specific rejection to a short Chinese or English
explanation with retry/model-switch guidance. Raw provider dumps, endpoints and
credentials remain excluded from the error card.

Regression coverage includes an actual local HTTP/SSE client, a long Chinese
reasoning response exceeding the former persistence cap, a tool-only response,
runtime compaction to the four-exchange tail, durable session save/load, and a
fresh client continuing through a strict mock provider. The provider rejects a
tool-call assistant message without a string `reasoning_content`. Additional
checks cross the old aggregate budget while preserving already-sent request
prefixes and confirm that display-only thinking is not replayed.

Run `cargo test -p aris-executor reasoning` and `cargo test --workspace` from the
repository root. Frontend checks are
`npx vitest run src/errorMessage.test.ts src/chat/tests/useChatStream.test.tsx --maxWorkers=2 --minWorkers=1`,
`npm run typecheck`, and `npm run build` from `desktop/`. Windows sandboxing can
block loopback sockets with error 10013; these mock-provider tests require a
local environment that permits loopback connections.

Structural diagnosis and verification are saved in
`.somniq/changes/reasoning-continuation-2026-10-15/`. They contain no copied
prompt, tool output, reasoning text, credential or endpoint. Validation makes no
real model requests; the installed desktop runtime and installer are not updated
by these source changes.
