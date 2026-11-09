# Slide delivery evidence

The final gate prevents four concrete failures: a PDF passing while PPTX clips,
figures illustrating a different run, a talk using its entire slot before Q&A,
and a negative review being recorded as completion. It does not replace visual
inspection or independently establish scientific correctness.

## Content and provenance

Use `slides.json` as the common content model. Keep slide ID, purpose, visible
text, notes, equations, chart data, table values, main/backup role, seconds, and
source IDs together. Layout functions may differ across formats; scientific
content may not. Export notes and scripts from the same model. Check rendered
mathematical notation rather than leaving raw LaTeX commands in PowerPoint.

For every result, record system, parameter values, seeds, reference solver,
metric definition and source path. Preserve log and figure hashes. Name a run
identity narrowly enough to distinguish changed plants or reference solutions.
The source log's range must summarize the claimed system and seeds, not other
rows with similar numbers. Numeric error of a reference method cannot be
relabelled as the learned method's error. Report numerical thresholds as
numerical estimates within the tested search class unless a stronger result
has actually been proved.

When the right figure is missing, redraw the verified data as an editable chart
or table. Do not rerun long experiments that overwrite original evidence merely
to obtain a prettier figure. Preserve originals. Put derivation and detailed
paths in notes; keep caveats that change the conclusion visible on the slide.

## Visual acceptance

Render the actual exported PDF and actual exported PPTX, including backups. Use
an available renderer and record it. Review each page at projection size for:

- Readable title, body, equations, table cells, chart axes and legend.
- No overlap, clipping, excess wrapping or content below the bottom edge.
- Correct signs, units, scenarios and associations between claims and plots.
- Coherent order, one main point per page, and adequate main-talk/Q&A time.

A contact sheet supports flow review; it does not certify individual pages.
If the PPTX renderer cannot reproduce an element, fix or replace that element
and render again. Do not report native PowerPoint testing from a different
renderer. Do not embed each entire page as an image when editable PPTX was
requested. Native charts and tables should remain editable.

## QUALITY_MANIFEST.json

Paths below are relative to the manifest or absolute local paths. Every file
entry requires `path` and `sha256` of the actual bytes. Build stamps and review
records must be regenerated when the artifact changes. `content_sha256` records
the content version used in each build. It is a build declaration, not proof
that every claim was translated correctly; compare the rendered outputs.

```json
{
  "schema_version": 1,
  "status": "in_review",
  "requested_slide_count": 2,
  "content_source": {"path": "slides.json", "sha256": "<content hash>"},
  "timing": {"slot_seconds": 1500, "qa_seconds": 240},
  "sources": [
    {"id": "current-log", "path": "sources/arm-k2.log", "sha256": "<hash>", "kind": "log", "run_id": "arm-k2-g2-seeds012"},
    {"id": "current-plot", "path": "figures/arm-k2.png", "sha256": "<hash>", "kind": "figure", "run_id": "arm-k2-g2-seeds012"}
  ],
  "slides": [
    {
      "id": 1,
      "seconds": 1260,
      "run_id": "arm-k2-g2-seeds012",
      "evidence": [{"source_id": "current-log"}, {"source_id": "current-plot"}],
      "metrics": [{"source_id": "current-log", "kind": "measured", "quote": "<exact source excerpt containing the metric>"}]
    },
    {"id": 2, "seconds": 0, "backup": true}
  ],
  "artifacts": {
    "pdf": {"path": "main.pdf", "sha256": "<pdf hash>", "content_sha256": "<content hash>"},
    "pptx": {"path": "presentation.pptx", "sha256": "<pptx hash>", "content_sha256": "<content hash>"}
  },
  "rendered_artifact_sha256": {"pdf": "<pdf hash>", "pptx": "<pptx hash>"},
  "renders": {
    "pdf": [
      {"slide": 1, "path": "renders/pdf-01.png", "sha256": "<hash>"},
      {"slide": 2, "path": "renders/pdf-02.png", "sha256": "<hash>"}
    ],
    "pptx": [
      {"slide": 1, "path": "renders/pptx-01.png", "sha256": "<hash>"},
      {"slide": 2, "path": "renders/pptx-02.png", "sha256": "<hash>"}
    ]
  },
  "visual_review": {
    "pdf": {"artifact_sha256": "<pdf hash>", "renderer": "<renderer>", "pages": [{"slide": 1, "verdict": "pass", "issues": []}, {"slide": 2, "verdict": "pass", "issues": []}]},
    "pptx": {"artifact_sha256": "<pptx hash>", "renderer": "<renderer>", "pages": [{"slide": 1, "verdict": "pass", "issues": []}, {"slide": 2, "verdict": "pass", "issues": []}]}
  },
  "independent_review": {"path": "INDEPENDENT_REVIEW.json", "sha256": "<report hash>"}
}
```

The minimal example illustrates the schema, not a recommended two-slide timing.
An actual talk needs realistic time on every main slide. Backups have zero
scheduled seconds and remain part of the requested page count.

If Q&A is explicitly outside the slot, set `qa_policy: "outside_slot"` and
`agreement_note` to the user's actual timing agreement. Do not invent consent.

Source `kind` is `log`, `figure`, `script` or `document`; non-UTF-8 text may set
`encoding`. Script self-reports and design documents cannot substantiate metrics
labelled `measured`. Give derived quantities their exact input excerpts and
document the calculation in notes; the checker does not validate arithmetic.

Evidence defaults to `role: "primary"`. Primary logs/figures must match the
slide's `run_id`. For an intentional side-by-side comparison, use
`role: "comparison"` and `visible_label`; that exact label must appear in the
actual slide text. Method/background citations use `role: "method"`. Do not
use that role to conceal an incompatible empirical figure.

## Independent review record

Preserve the actual Reviewer response alongside its normalized record. The
record must identify the separate reviewer and executor, report `ready`, contain
no unresolved blockers, and name the exact current artifacts:

```json
{
  "reviewer": "<configured independent Reviewer identity>",
  "executor": "<Executor identity>",
  "verdict": "ready",
  "blockers": [],
  "artifact_sha256": {"pdf": "<current pdf hash>", "pptx": "<current pptx hash>"}
}
```

The record's declarations are auditable bookkeeping, not authentication. Do not
fabricate review results, impersonate a reviewer, or promote your own visual
check into independent review. Unavailable Reviewer means a useful draft with
`draft_pending_review`; `needs_revision` remains unresolved until revised and
reviewed again. User authorization within the conversation still takes priority
over workflow defaults, but must not be described as a review that never ran.

Run `tools/slide_quality.py QUALITY_MANIFEST.json --stage draft` while editing.
Run with `--stage final --report QUALITY_REPORT.json` after visual and independent
review. Exit 0 in final stage authorizes completed state. A draft pass never
does. Store validation files outside the user-facing slides themselves.
