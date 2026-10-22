# Slide generation: one content source and final delivery evidence

The 22-page IRL group-meeting deck exposed separate failures in content selection,
layout, provenance and completion state. The original PDF/PPTX duplicated the talk
in TeX and a handwritten Python array. The PPTX had text over a plot (page 16),
text below the canvas (page 18), and overlapping table headers (page 20). Multi-panel
figures had unreadable labels. The schedule consumed the full slot before Q&A.
An independent review said `Needs revision`, yet the workflow could still record
completion after file generation.

Some visual problems also concealed scientific mismatches: the arm k=2 refusal
table was paired with a linear-system plot; a k=1 image illustrated k=2 results;
reference-method errors were relabelled as data-only errors; and an action-error
range mixed systems and omitted arm seeds. A clean export alone cannot catch these.

## Bundled workflow changes

`crates/runtime/assets/skills/paper-slides/SKILL.md` now requires:

- One `slides.json` for visible content, chart/table values, notes and script.
- Explicit main/backup timing and Q&A within the user-agreed slot.
- Source hashes, system/run identity and exact metric excerpts. Script self-reports,
  analytical expectations and experiments not run remain distinct from measured logs.
- Actual PDF and exported PPTX renders, inspected page by page. A contact sheet
  supports flow review but does not certify individual pages.
- Final independent review of the current artifacts. Missing, negative or stale
  review keeps the deck in `draft_pending_review` or `needs_revision`.
- Nonzero exit on LaTeX overfull boxes. Completion is controlled by the final gate,
  not merely by generating a talk script.

`tools/slide_quality.py` checks hashes, actual page order/counts, timing, declared
run identity, exact quoted evidence, basic object bounds, all rendered pages and
current independent-review hashes. The contract is in
`references/quality-contract.md`. Draft checks never authorize completed state.
The report writer also accepts an explicitly null pending-review record.

The gate checks declarations and local files. It cannot authenticate reviewer
identities, establish scientific truth, or detect every text/chart/group clipping
case; independent review and full-size visual inspection remain necessary.

## Actual deck optimization and validation

Evidence is under `.somniq/changes/slide-quality-2026-10-15/` and delivery files
under `output/slides/irl-group-meeting-optimized/`.

The new deck has 18 main pages plus 4 backups, preserving 22 total pages. Main
time is 20:40; discussion is 4:00; total is 24:40 in a 25-minute slot. It uses
7 native editable tables and 4 native editable charts. Two original figures are
retained as images; the neural example is cropped to the relevant arm panel.
The final PDF was exported by PowerPoint from the delivered PPTX.

The main results were checked against frozen logs and the final native chart
caches against the common content source. No experiments or model calls were
run. All 21 original source files remained unchanged. Numerical HJI and refusal
results retain their tested-region/search-class limitations.

Local verification:

- 18 focused Python regressions pass, including pending-review report generation.
- 10 runtime cache/bundle tests pass; bundled helper extraction is covered.
- Finalizer: 22 slides, 7 tables, 4 chart workbooks, no structural/layout findings.
- Native PowerPoint 16.0: 22 slide images and PDF exported; all pages visually checked.
- Actual draft gate passes. Actual final gate fails only for absent independent
  review, as intended. The optimized artifact remains `draft_pending_review`.

The changes are bundled source assets. The installed desktop application and its
runtime have not been repackaged or updated by this task. This is a workflow
contract/checker improvement, not a new Rust runtime-level completion-state guard.
