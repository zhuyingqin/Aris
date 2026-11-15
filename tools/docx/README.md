# Native document acceptance

The production edit adapter uses python-docx 1.2.0 and odfpy 1.4.1. Pandoc
generates new documents; a private LibreOffice installation renders saved
snapshots. Install `requirements.txt` in the configured `SOMNIQ_PYTHON`
environment; `PYTHONPATH` may point to a project-private package directory.
Set `SOMNIQ_PANDOC` and `SOMNIQ_LIBREOFFICE` to the local executables.

Run Python boundary regressions with:

```powershell
python -m unittest tools.docx.test_format_docx tools.docx.test_native_structure tools.docx.test_office_structure tools.docx.test_request_evidence
cargo build -p tools --example docx_acceptance
Copy-Item target/debug/examples/docx_acceptance.exe .somniq/tmp/docx-acceptance.exe
python tools/docx/run_public_acceptance.py --corpus <pinned-corpus> --runner .somniq/tmp/docx-acceptance.exe --output <fresh-output>
python tools/docx/run_acceptance.py --runner .somniq/tmp/docx-acceptance.exe --output <fresh-output>
```

`fetch_public_corpus.py` pins the upstream tasks and assets. The runners check
all input hashes and call actual production tools. They record exact calls,
binary audit/undo evidence, PDF hashes and every rendered page. Public plans
are selected by an operator using the pinned input and gold, with explicit
text anchors. They do not replay the full OSWorld VM or a model conversation.
Visually inspect every final candidate page; renderer output alone does not
verify WPS or Microsoft Word.

Create `.somniq/tmp` before copying the driver. On Windows, use that copy so a
concurrent Cargo test/build can relink its original example executable. Run the
two acceptance suites sequentially because both exercise the workspace ledger.
Use repeatable `--task-prefix <eight-character-id>` arguments for focused public
reruns. Keep each run's source and driver hashes; mixed runs are not one binary
version. An intentional blank page uses `insert_blank_page` on a body paragraph
anchor; an inline page break is not a reliable substitute for an empty page.

Optional read-only OOXML schema verification reuses Open XML SDK 3.3.0:

```powershell
dotnet run --project tools/docx/validate -- candidate.docx original.docx
```

The validator reports existing baseline errors and additional candidate
errors separately. It verifies native file structure, not rendered layout.
Private document exports, backend logs and generated evidence belong under
`.somniq/` and must not be published as repository fixtures.

Daily office requirements are defined in `office_cases.json`. They cover notices,
minutes, contracts, merged expense forms, quotations, contact lists, pagination,
privacy metadata, long tables, sections, revisions, TOCs and content controls.
The inputs are authored anonymous fixtures; the linked public Microsoft pages
define the requested behaviors and are not customer task histories.

```powershell
python tools/docx/fetch_office_sources.py --output <fresh-source-cache>
python tools/docx/run_office_acceptance.py --runner <verified-driver> --build-manifest <driver-run-results.json> --sources <fresh-source-cache>/manifest.json --output <fresh-output>
```

`--build-manifest` is metadata from the exact reused driver and binds its binary
and production source hashes. The office runner verifies that they still match.
Build `tools/docx/validate` first. It performs read-only schema validation of all
candidate DOCX files after the production calls. The runner records full-task
passes, partial results and native contract gaps separately. Rejection protects
the input but does not satisfy the requested office task. Page observations must
be added separately after reviewing the final candidate PDFs; source diagnostic
pages are labelled separately from candidate pages. These tests do not establish
Word/WPS fidelity, independent Reviewer approval or model-conversation success.

After inspecting every saved page, check evidence integrity without rerunning any
document tools:

```powershell
python tools/docx/verify_office_evidence.py --run <saved-run> --observations <executor-page-observations.json> --runner <verified-driver>
```

This checks the complete run, original inputs, public snapshots, current source
and driver hashes, candidate/schema hashes, recorded undo calls, and exact page
observation coverage and bindings. It does not approve failed office requirements
or promote Executor observations to an independent Reviewer result. The dated
office report records production failures separately from expected contract probes.

The native office actions reuse python-docx for sections, header/footer parts and
tables, and bounded OOXML operations for inline revisions, native content controls
and personal properties. TOC pagination uses a private LibreOffice UNO instance:
set `SOMNIQ_LIBREOFFICE_PYTHON` to that installation's Python with `uno` available
(normally next to `soffice.com` on Windows). This is separate from `SOMNIQ_PYTHON`.
The original document is never published from a LibreOffice round trip: only its
index entries and page numbers are read, then cached inside a native TOC field.

For natural-language model acceptance, build the developer-only Desktop example:

```powershell
cargo build --manifest-path desktop/src-tauri/Cargo.toml --features memory-eval --example office_agent_acceptance
python tools/docx/run_agent_acceptance.py --agent <office_agent_acceptance.exe> --runner <docx_acceptance.exe> --output <fresh-output>
```

The example loads the Desktop model connection, product prompt, production builtin
tool catalog and dynamic tool routing. It records every model turn and actual
tool input/output; it never exports credentials. A local execution allowlist
excludes network tools and external messaging. The configured model API is still
called. Requests contain natural-language requirements and paths; the model must
read the input and choose tools, anchors and revisions itself. Use repeated
`--case` arguments for selected cases. Two cases derive from the previously
verified backend requirements: text-only output and a later instruction to change
eight people to seven and remove tables. Their inputs are anonymous examples,
not original customer files.

Choose a fresh `--output` directory outside the development Git checkout (for
example under the operating system temporary directory). The product prompt
includes the workspace's Git context and file searches respect ignore rules;
placing model workspaces below an ignored repository directory can hide fixtures
from discovery and include unrelated development diffs in the prompt. Preserve
the completed directory with its logs and artifacts when retaining evidence.

The evaluator verifies the resulting files, separately renders the final revision,
and runs Open XML SDK. `agentRenderedFinalRevision` describes evidence from the
model's own tool calls; evaluator rendering cannot satisfy that field. Inspect all
saved page images before recording visual observations. This exercises the shared
software runtime, without certifying the desktop UI, independent Reviewer or
Word/WPS. It does not change the installed application's binary.

Harness evidence is stored outside neutral, numbered model workspaces. Future
turns are sent from memory only when their turn begins and are not saved in a
readable request file beforehand. The complete request is saved after the run.
For the two-turn personnel task, the example snapshots `result.docx` after each
turn: the evaluator requires an actual eight-person native table first, then a
seven-person final document with five execution staff and no tables. Checking
only the final file cannot prove that a later instruction was followed.
