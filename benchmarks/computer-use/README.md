# Computer-use R0 fixtures

R0 of the [rollout plan](../../docs/development-logic/computer-use-rollout-plan.md): task definitions, judges, local fixtures, the current-pipeline baseline, and the UIA probe run. Findings: [computer-use-r0.md](../../docs/development-logic/computer-use-r0.md).

| File | What it is |
| --- | --- |
| `tasks.json` | Task definitions (design §9 C1–C8, S1–S4, plus the rollout plan's security cases) with the judge each uses |
| `judge.mjs` | Decides a task from end state: files, the fixture site's request log, fixture-window events. Claims are checked separately (`falseSuccess`) |
| `fixtures/publisher/` | Local mock publisher on 127.0.0.1: login + human-check handoff, identity mismatch, prompt injection, cross-origin mirror, submission form with preview, and a decoy origin |
| `fixtures/desktop/setup.mjs` | Fresh `%TEMP%\somniq-cu-r0\<run>` tree (Notepad file, dated PDFs, a .docx with a comment and tracked changes) plus a manifest of hashes |
| `fixtures/desktop/fixture-window.ps1` | WinForms test window; logs every change/click/activation. The only window the probe may act on |
| `run-browser-baseline.mjs` | Runs the shipped Playwright PDF worker against the publisher fixture and judges each task |
| `run-probe.mjs` | Runs `somniq-computer-probe` against the fixture window, Notepad, File Explorer and WPS, and demonstrates the Shell-tool bypass (S5) |

```powershell
cargo build -p computer --release
node benchmarks/computer-use/run-browser-baseline.mjs --evidence docs/development-logic/evidence/computer-use/r0-browser-baseline.json
node benchmarks/computer-use/run-probe.mjs --evidence docs/development-logic/evidence/computer-use/r0-uia-probe.json
```

`run-probe.mjs` opens real windows (it adds a tab to an open Notepad or WPS window). Raw control trees stay under `%TEMP%`; evidence files hold measurements and marker checks only. The fixture account in `fixtures/publisher/accounts.json` exists only for the local fixture.

Manual fixture use for a model-driven run:

```powershell
node benchmarks/computer-use/fixtures/publisher/server.mjs --log $env:TEMP\r0-requests.jsonl --pdf-disposition attachment
```

```powershell
node benchmarks/computer-use/judge.mjs --task C7-OA --log $env:TEMP\r0-requests.jsonl --output <project>\.somniq\papers --claim success
```
