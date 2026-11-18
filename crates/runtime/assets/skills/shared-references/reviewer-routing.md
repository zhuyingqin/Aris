# Reviewer Routing

## The backend: `LlmReview`

All review calls go through the **`LlmReview`** tool. It is built into SomniQ —
no MCP server, no CLI, no extra install. It routes to whatever reviewer the user
configured in SomniQ settings.

```
LlmReview:
  prompt: |
    [role + task + the material to review + output schema]
```

That is the public call contract. The host selects the execution mode and uses
the user's configured Reviewer connection; skills do not create an Executor
child or choose a different backend themselves.

## Calling rules

1. **Omit `model`.** `LlmReview` uses the user's configured reviewer
   (`ARIS_REVIEWER_MODEL`). Only pass `model` when the user explicitly named a
   reviewer override in this conversation. A wrong override silently falls back
   to the configured reviewer anyway, so guessing buys nothing.

2. **Every call is self-contained.** Desktop Chat normally starts a fresh,
   isolated, read-only Reviewer sub-agent for each call. It can read and search
   the project over several model requests, using the configured Reviewer
   connection. It does not share the Executor's conversation or the Chat's
   automatic Reviewer conversation. There is no caller-visible conversation id
   or continuation call. For a multi-round review, each round sends a
   **fresh, complete prompt** that restates:
   - the material under review (or the file paths to read),
   - what the previous round found,
   - what changed since then,
   - what this round should judge.

3. **Pass file paths, not your own summaries**, wherever the reviewer can read
   the file itself. See `reviewer-independence.md` — summarizing for the
   reviewer is how confirmation bias leaks in. Paths must be inside the bound
   project workspace. The sub-agent cannot run tests, edit files or browse.
   Web reviewers, explicit `review_mode=oneshot` and hosts without a Chat agent
   tree keep the single-request route without project tools; include the
   relevant material inline in those modes.

4. **Long prompts go in a file.** When the material is more than a short note,
   write a dossier (e.g. `REVIEW_DOSSIER.md`) and send the path plus the
   questions, rather than pasting everything inline.

5. **Reasoning effort is a settings concern, not a call parameter.** If a review
   needs deeper reasoning, say so in the prompt ("think step by step, check each
   derivation line") and let the user pick a stronger reviewer model in
   settings.

## Failure handling

`LlmReview` returns an error string when the reviewer is unavailable:

| Error | Meaning | What the skill should do |
|-------|---------|--------------------------|
| `reviewer is disabled in SomniQ settings` | User turned the reviewer off | Stop and tell the user to configure a reviewer in Settings. Do not fake a review. |
| `ARIS_REVIEWER_AUTH_TOKEN not set` / `..._BASE_URL not set` | Reviewer configured but incomplete | Same — surface it, don't substitute your own judgement. |
| `<KEY>_API_KEY not set (needed for model '<m>')` | A `model` override routed to a provider with no key | Retry once **without** the `model` override. |
| `LlmReview sub-agent failed: ...` | The isolated review could not finish | Surface the failure. Do not silently rerun as a paid single request or self-review. A Reviewer endpoint without tool support can use the explicit `review_mode=oneshot` compatibility setting. |

Never silently self-review when `LlmReview` fails. A skill whose whole point is
independent review must report that it could not get one.

## Legacy call sites

Older skill text may name a Codex MCP tool (`mcp__codex__` + `codex` or
`codex-reply`), `mcp__oracle__consult`, or a `— reviewer:` directive. Those refer
to review backends SomniQ does not ship. Treat any such mention as meaning "call
`LlmReview`", and ignore `config: {"model_reasoning_effort": ...}` and
`threadId` fields — neither exists on `LlmReview`.
