# SomniQ Studio 0.4.89

This release builds on `codex/repair-updater-0.4.88` (open PR #113, which in
turn carries the 0.4.87 and 0.4.88 branches). The 0.4.89 PR targets
`aris-code` and includes those inherited commits.

## Changes

- Official plugins: Literature, LaTeX, Figures and Mail become switchable
  official plugins. See [official-plugins.md](official-plugins.md) for the
  switch precedence, the per-run frozen state and what each switch removes.
- Literature settings get their own Settings page; Typeset, Figures and Mail
  mount through official plugin page contributions; the PDF reading cluster
  lives in `desktop/src/pdf/` and must not import `literature/`.
- User plugins can declare `somniq.requires`; the model's file and shell tools
  refuse the project plugin store (`.somniq/plugins`).
- Research workflow fixes from 6ce5f060: billed Scopus school route, carried
  task plans for "continue" and plugin continuation, collapsed project brief,
  classified local file errors.

## Validation

Run on the source workspace before the version bump: runtime 984, tools 339,
aris-chat 68 and Vitest (`src`) 2386 passed; the desktop crate passed 1064 of
1065. The one failure,
`system_prompt::the_completion_contract_only_promises_a_reviewer_that_will_run`,
predates this release (31511e6e) and is not fixed here. TypeScript and the
production frontend build passed.

GitHub-hosted Actions do not start while the account is locked for billing, so
the Windows x64 NSIS installer is built locally. No macOS asset is built on this
Windows host.
