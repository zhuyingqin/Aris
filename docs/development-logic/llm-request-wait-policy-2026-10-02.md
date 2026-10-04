# LLM request wait policy (header wait, stream idle, timeout resends)

## Observed failure

Users reported GPT turns that "hang without responding". Route: Aris → New API (China) → Sub2API (Mexico) → OpenAI, reasoning effort `max`. Gateway logs showed `client_gone / context canceled` at ~120s, and requests of the same size repeated about every two minutes. Sub2API still logged those requests as "success", because it keeps reading upstream to account usage after the client leaves.

Local wire traces (`*.wire.jsonl`, same gateway) show the client side:

- In the slow cases the relay sends **no HTTP headers until the model's first event**. `response.created` arrives 0.0–0.8s after the headers. For xhigh/max reasoning, "waiting for headers" is time-to-first-output: 143–166s in the report, and heavily censored at 120s locally.
- reqwest `read_timeout(120s)` fired first ("operation timed out") and the send loop retried up to 4×. One trace: `+120.0s`, `+241.1s`, `+363.2s` timeouts, then a 4th send. That is ~8 minutes of silence and 4 billed upstream requests.
- The same 120s read timeout also cut streams mid-body (`body_abort … error decoding response body`) after `response.created`, which restarted the whole request.
- Desktop Stop only sets the per-turn observer cancel flag. The OpenAI send phase (header wait, backoff, restart send) only checked the global `runtime::is_interrupted()`, so **Stop did nothing during the whole wait**.
- An idle timeout before any output, with the restart budget spent, emitted `stream_error_after_partial_output`. The runtime treats that as recoverable and auto-sent a continuation: another hidden, billed resend.

## Invariants

- **One shared wait policy** (`api::StreamWaitPolicy`) for the Anthropic and OpenAI-compatible clients:
  - Response-header wait `ARIS_RESPONSE_HEADER_TIMEOUT_SECS`: default **600s**, clamp [30, 3600], `0` disables.
  - Chunk idle `ARIS_STREAM_IDLE_TIMEOUT_SECS`: default **300s** (was 120s), clamp [10, 1800], `0` disables.
  - reqwest `read_timeout` is only a backstop: `max(header, idle) + 30s`. It is removed when either wait is disabled, so it never fires before the traced, cancellable waits.
- **Post-send timeouts are re-sent at most `api::MAX_TIMEOUT_RESENDS` (= 1) time per request**, across the send loop and all stream restarts. These are the header wait, stream idle, and reqwest read timeout without connect. The gateway accepted such a request and is usually still running and billing it, so re-sending does not make a slow model faster. Connect failures, 429 and 5xx keep their existing budgets.
- When the budget is exhausted, the error says the request is not re-sent again and why, and names the two env knobs.
- An idle timeout with **nothing emitted** is an error, never a "partial output" stop reason.
- The OpenAI send phase, backoff sleeps and restart sends are all cancellable through the observer (`select!` on `wait_for_stream_cancel`), matching the Anthropic executor.

## Verification

- New mock-gateway regression tests in `crates/executor/src/tests/openai.rs`:
  - a header wait that never ends → exactly 2 requests, then an explanatory error;
  - an idle stream before any output → exactly 2 requests, then an error, with no continuation;
  - Stop during a 60s header wait → returns in ~0.3s.
- With the fixes temporarily disabled, the same tests fail with 4 requests, 3 requests, and a 60s wait respectively.
- Parser and backstop tests: `crates/api/src/tests/client.rs`.
- `cargo test --workspace`: 1241 passed, 0 failed, 5 ignored.
- `cargo check` of `desktop/src-tauri` passes.

## Waiting clock in Chat

A streaming assistant turn that has produced nothing new for 3s shows "Waiting for the model · 2:31" (`ModelWaitIndicator`). After 60s it adds a line saying deep reasoning can take minutes and Stop is available.

- The clock counts from the turn's **last visible activity**. Every stream patch goes through `patchLastAssistantTurn`, which stamps the new `blocks` array in a module `WeakMap` (`modelWait.ts`); `assistantTurn()` stamps it at send time. The clock is therefore right after virtualized unmounts and session switches, and the stamp is never persisted.
- It stays hidden while the turn waits on something that already shows its own status: a running tool or question, a pending permission, an active Reviewer phase, or a retry backoff countdown.
- Tests: `desktop/src/chat/tests/ModelWaitIndicator.test.tsx` (10). Chat Vitest suite: 31 files / 417 tests passed. `tsc --noEmit` and `npm run build` passed. Verified visually in a temporary harness page (en/cn, dark/light), which was then removed.

No live run against the production gateway was performed. Gateway-side settings (New API / Sub2API streaming timeouts, keep-alive pings) were not inspected or changed.
