# Debugging the desktop UI in a plain browser

The Workflows tab can be driven from an ordinary browser against real Rust, with
no webview and no packaged app. Two processes:

```bash
npm --prefix desktop run dev
```

```bash
cargo run --manifest-path desktop/src-tauri/Cargo.toml --features devserver --bin aris-devserver -- --project <scratch-dir>
```

Then open `http://127.0.0.1:1420/?devBackend=1`.

The flag is sticky (stored in `localStorage` under `somniq-dev-backend`), so a
reload or an in-app navigation that drops the query string keeps the transport.
Clear that key to go back to the browser-preview fakes.

## What each piece does

`desktop/src/api/transport.ts` decides where `invoke`/`listen` go: the Tauri
bindings inside the app, or HTTP against the devserver. `tauri.ts` is the only
importer, so the whole IPC surface follows one switch.

`desktop/src-tauri/src/devserver.rs` implements `AppCtx` outside Tauri and
dispatches the same controller functions the `#[tauri::command]` shims call. It
is behind the `devserver` feature, so `cargo tauri build` never compiles it or
its HTTP stack.

Useful endpoints while debugging:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Bound project, derived project id, hosted command list |
| `GET /events?since=<seq>` | The event stream the UI polls — readable with `curl` |
| `POST /invoke/<command>` | Same contract as `invoke`; a rejection is `{"err": …}` in a 200 |

Every dispatch is logged to stderr with its arguments, so a failing UI click has
a matching server-side line.

## Executor turns

`run_workflow_turn` goes through the desktop Chat engine, which is bound to
`AppHandle` for permission prompts and streaming deltas, so the devserver cannot
reuse it. Executor turns are answered by `--executor` instead:

- `stub` (default) — a deterministic plan built from the run's own ledger
  binding. Offline, and a reproduction reproduces the same way twice.
- `--script <file>` — one response per non-empty line, replayed in order. A
  quoted line is read as a JSON string, so a captured multi-line model reply
  round-trips. Running out is an error, not a hang.
- `live` — real one-shot model calls. There is no persistent workflow Chat
  session behind these, so transcript continuity across turns is weaker than in
  the packaged app.

The independent Reviewer has no `AppHandle` dependency in the app either, so
that call is identical to what the packaged build makes.

## `review_workflow_save` is refused by default

That command accepts a whole run composed by the browser, including reviewer
gates. Stages with no Rust controller yet fall back to a frontend preview
heuristic that auto-approves its own gate — harmless against `localStorage`, but
against a real ledger it writes a reviewer approval nobody performed. The
devserver rejects the command with an explanation; pass `--allow-run-save` to
opt in deliberately.

This is why code choosing between the ledger and a preview fake must branch on
`hasNativeBackend()` rather than `isTauri()`. "Am I in a webview" and "is there a
backend" stopped being the same question once the devserver existed;
`Workflows.tsx` still has many `isTauri()` call sites that predate the split, and
several of them correctly mean "can I reach the network", so they are not
mechanically interchangeable.

## Scope

The devserver hosts only the `AppCtx`-ported commands — currently the sixteen
review-workflow ones, which cover the scope-and-plan stage end to end. Anything
else returns a "not hosted" error rather than failing silently. Extending
coverage means porting more commands to `AppCtx` (see
`desktop/src-tauri/src/app_ctx.rs`), not adding special cases here.
