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
  - Response-header wait `ARIS_RESPONSE_HEADER_TIMEOUT_SECS`: ordinary Chat defaults to **600s**; single-submission artifact clients default to **1800s**. An explicit value applies to both, clamped to [30, 3600]; `0` disables. Missing, blank or invalid values use the appropriate default.
  - Chunk idle `ARIS_STREAM_IDLE_TIMEOUT_SECS`: default **300s** (was 120s), clamp [10, 1800], `0` disables.
  - reqwest `read_timeout` is only a backstop: `max(header, idle) + 30s`. It is removed when either wait is disabled, so it never fires before the traced, cancellable waits.
- **Post-send timeouts are re-sent at most `api::MAX_TIMEOUT_RESENDS` (= 1) time per request**, across the send loop and all stream restarts. These are the header wait, stream idle, and reqwest read timeout without connect. The gateway accepted such a request and is usually still running and billing it, so re-sending does not make a slow model faster. Connect failures, 429 and 5xx keep their existing budgets.
- Single-submission artifact jobs are an exception: **zero resends** on any error, including header/idle timeout, HTTP rejection and endpoint negotiation. Changing their wait policy rebuilds the HTTP client so the old read backstop cannot still abort at the shorter Chat deadline. Their idle wait, provider output limit, low-reasoning request and connection/session routing retain their existing semantics.
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

## 2026-11-25: deadlines count output, not bytes

### Observed failure

A user saw "Waiting for the model · 23:20" with no error and no retry notice. Each retry adds a notice that resets the Chat clock, so this was one 23-minute stretch with nothing visible, longer than any single wait above. The chunk idle limit wrapped `response.chunk()`, so **any** body chunk restarted it: SSE comment pings (`: PING`, `: keep-alive`), empty deltas, `response.in_progress`, Anthropic `ping` events. Once a relay sent headers and then pinged, the header wait was already satisfied and the idle wait never fired. With no total deadline, the request waited for as long as the relay kept pinging. Comment lines are skipped before the raw-event trace, so the wire log could not tell this apart from a silent connection.

### Invariants

- `api::StreamWaitPolicy` keeps its meaning. `api::StreamProgressClock`, shared by the Anthropic stream and both OpenAI transports, adds **output deadlines** that output-free chunks never extend:
  - until the first output, `response_header_timeout` counted from when the attempt that got through was **sent**: the same time-to-first-output budget a relay that withholds headers gets (default 600s);
  - after that, at most `stream_idle_timeout` between outputs (default 300s).
  - Each chunk read waits `min(chunk idle, time left before the output deadline)`; the per-chunk idle limit is unchanged.
- Output means text, visible reasoning, or tool-call progress: Chat Completions `content` / `reasoning_content` / `tool_calls`; Responses text/refusal/reasoning deltas, function-call argument deltas, and output items other than a bare `reasoning` item; Anthropic events `event_is_meaningful_content` accepts.
- Expiry takes the existing timeout paths: no output yet → at most `MAX_TIMEOUT_RESENDS` resend, then an error that names the keep-alive chunks; output already streamed → `stream_error_after_partial_output`, never a resend.
- A timeout **after** the model finished (`finish_reason`, `[DONE]`, Anthropic `message_stop`) completes the response. It used to surface as a partial stop and trigger a needless continuation request.
- `llm.keepalive` (`chunksWithoutOutput`) is written to the wire trace when a stream had output-free chunks. Timeout retries carry `reason: no_output_timeout` and the chunk count.
- Trade-off, accepted on 2026-11-25: a model that reasons silently (no reasoning summary) for longer than the budget behind a pinging relay now fails where it used to eventually answer. Raise `ARIS_RESPONSE_HEADER_TIMEOUT_SECS` / `ARIS_STREAM_IDLE_TIMEOUT_SECS` for such models.
- **Total request limit** `StreamWaitPolicy::request_max_duration` (`ARIS_REQUEST_MAX_DURATION_SECS`):
  - Chat defaults to **1800s**; single-submission artifact jobs default to 3600s because their header wait alone is 1800s. Values are clamped to [60, 7200]; `0` disables the limit.
  - The limit counts from the first send through every resend, 5xx/connect retry and stream restart. Every header wait is shortened to what is left of it, and no attempt starts after it has passed.
  - The waits above bound each silence; this bounds their sum. Without it, 5xx and connect failures have their own 4-attempt budget, and each attempt can wait out a full header wait (a real 11-15 request took 13.5 minutes; the worst case was about 40).
  - On expiry the request is never re-sent: no output yet → an error that names the knob; output already streamed → `stream_error_after_partial_output`.
  - Trade-off: a single answer that is still streaming after 30 minutes is cut, but what it streamed is kept.

### Compaction is not a model wait

Preflight auto-compaction can summarize a long history for minutes (up to 24 sequential summarizer calls). Desktop showed that as "Waiting for the model", because only remote clients got a `compacting` signal. It now emits `chat-compaction` (`started` / `finished`, recorded as `compaction_progress`). Chat shows "Compacting context · m:ss" and restarts the model-wait clock when compaction ends. Stop no longer waits for preflight to finish: the turn polls its cancel flag every 100ms and returns, and the abandoned compaction thread checks the flag before it records anything.

2026-11-26, from a GPT session's wire log: one compaction there took 7–15 minutes, and Stop did not end it.

- **Reasoning level.** The summarizer (`gpt-5.6-luna`) inherited the chat's `reasoning_effort: "max"`. It thought for 24–162 s before its first word on each of the 4–6 sequential Map-Reduce calls, 43–304 s per call. Summaries now ask for `low` (`aris_chat::DEFAULT_SUMMARIZER_REASONING_LEVEL`, overridable with `ARIS_SUMMARIZER_REASONING_EFFORT`), narrowed per model like any level. This applies to both the OpenAI and the Anthropic client (`with_reasoning_level`).
- **Stop ends the summary.** The summarizer used to run on a never-cancelled observer. It now watches the turn observer's `cancel_probe()`, and the runtime checks for cancellation before every summary call.
  - A cancelled compaction leaves the session untouched; no deterministic fallback replaces history the next turn can still summarize.
  - The turn returns "interrupted" before sending the uncompacted request.
  - A singleflight leader that was cancelled marks its flight `Abandoned`, so a waiting caller summarizes the slice itself instead of inheriting the non-answer.
- **Mid-turn progress.** Compaction between tool steps emits `EventType::CompactionProgress`. The main turn's sink forwards it as the same `chat-compaction` event (wire: `context.compaction`), so it also shows "Compacting context".

After 10 minutes (the default first-output budget) with nothing new, the Chat hint changes from "deep reasoning may take a few minutes" to "past the default 10-minute wait limit; the model may be stuck".

### Verification

- `crates/executor/src/tests/openai.rs`:
  - keep-alive comments, empty deltas and `response.in_progress` with no output → 2 requests, then an error;
  - keep-alives after output → partial stop, 1 request;
  - keep-alives after `finish_reason` → complete;
  - steady output past the first-output budget → succeeds;
  - an endless stream → cut at the total limit with its output kept, 1 request;
  - slow 503 answers → stopped at the total limit instead of 4 attempts plus backoff.
  - Before the fix, the first case was still waiting after 5s with a 300ms idle limit.
- `crates/api/src/tests/client.rs`:
  - Anthropic pings without output → 2 requests, then an error;
  - pings after `message_stop` → complete;
  - an endless stream → cut at the total limit;
  - env parser truth table for `ARIS_REQUEST_MAX_DURATION_SECS`.
- `desktop/src/chat/tests/ModelWaitIndicator.test.tsx` and `useChatStream.test.tsx`: compaction state and the 10-minute hint.
