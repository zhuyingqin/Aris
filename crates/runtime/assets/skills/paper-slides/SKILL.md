---
name: paper-slides
description: "Generate a presentation deck (editable PPTX + PDF, optional Beamer) with speaker notes and a full talk script, from a paper, report, document, notes or a topic. Use when user says \"做PPT\", \"做幻灯片\", \"做汇报\", \"组会PPT\", \"make slides\", \"conference talk\", \"presentation slides\", \"生成slides\", \"写演讲稿\", or wants slides for a talk."
argument-hint: "[source: paper dir / pdf / docx / md / topic] [— talk_type: oral, minutes: 15, theme: academic, format: pptx|beamer] [— style-ref: <source>]"
allowed-tools: read_file, write_file, edit_file, glob_search, grep_search, bash, ToolSearch, SomniImage, LaTeXCompile, ReadMediaFile, LlmReview, Agent
---

# Paper Slides: From Source to a Finished Talk

Generate a presentation from: **$ARGUMENTS**

A good talk is a temporal story: each slide makes one point, and the audience
understands *why it matters* before seeing *what was done*.

## How decks are built (read first)

You write **content**; the bundled builder does **layout**.

1. All visible text, figures, tables, chart data, notes and timing live in one
   file: `slides/slides.json` ([schema](references/deck-schema.md)).
2. `tools/deck_builder.py` renders it into an editable PPTX with a consistent
   theme, measured text fitting (no overflow, largest readable size), aspect-
   correct figures, native tables/charts and speaker notes, and lints it.
3. `tools/render_deck.py` renders the actual PPTX (PowerPoint or LibreOffice) to
   page images and exports the PDF. You inspect every page and fix
   `slides.json`, not the PPTX.

**Forbidden** (each caused a delivered deck to fail before):

- Writing your own python-pptx / `generate_pptx.py` layout code with hard-coded
  coordinates.
- Converting Beamer/LaTeX/Markdown to PPTX with regex or text stripping (this
  leaked `[0.2cm]`, `0.5` and `[图表]` into slides and left the cover empty).
- Placeholders of any kind in a delivered deck (`[图表]`, `TODO`, "此处插入图片").
  Use a real figure, a native table/chart, a `process`/`cards` diagram, or drop
  the slide.
- Editing the PPTX by hand to hide a builder error.

## Delivery contract (required)

Read [the quality contract](references/quality-contract.md) before authoring. A
successful build or export is a draft, not acceptance. After export, render and
inspect **every page of the delivered PPTX** (and the PDF if it is produced
separately, e.g. by Beamer), including backup slides.

Keep each result's system, parameters, seed set, reference solver and source log
with its figure. An old figure from another system/run cannot illustrate the
current result. Redraw from the current log (native `chart`/`table`) or omit it.
Intentional comparisons need visible scenario labels. Distinguish measured
results, script self-reports, analytic expectations and experiments not run.
Do not upgrade evidence strength.

Record main-talk time separately from backup slides and reserve Q&A inside the
agreed slot unless the user says it is outside. Move detail to notes or backup
before reducing font size.

The final independent Reviewer must examine the current artifacts and their
rendered pages. `Needs revision`, unresolved blockers, skipped review, stale
review hashes, or missing render checks keep state at `needs_revision` or
`draft_pending_review`. Never label these `completed` or "ready to present".

## Constants

- **TALK_TYPE = `oral`** — `oral` (15-20 min), `spotlight` (5-8), `poster-talk` (3-5), `invited` (30-45), `group-meeting` (20-30, with discussion), `lecture` (40-90, course/teaching deck).
- **TALK_MINUTES = 15** — Overrides the type's default. An explicit user slide count wins and includes cover and backup.
- **FORMAT = `pptx`** — `pptx`: PPTX + PDF exported from it (default; no LaTeX needed). `beamer`: additionally a Beamer PDF generated from the same `slides.json` (only when the user asks for LaTeX/Beamer or the venue requires it).
- **THEME = `academic`** — `academic`, `teal`, `crimson`, `graphite`, `violet`, `forest`; a venue (`NeurIPS`, `ICML`, `ICLR`, `CVPR`, `ACL`…) selects one automatically.
- **LANGUAGE** — the user's language unless they ask otherwise.
- **SPEAKER_NOTES = true**, **OUTPUT_DIR = `slides/`**, **REVIEWER_MODEL = configured reviewer** (via `LlmReview`).
- **OUTLINE_CHECKPOINT = auto** — Stop for outline approval only if the user asked to see the outline first, or a missing decision would change the whole deck (audience, length, language). Otherwise show the outline and continue in the same turn. The user asked for a deck, not for a questionnaire.

> 💡 `/paper-slides "paper/" — talk_type: oral, minutes: 20, theme: teal, format: pptx`

## Execution policy: finish the deck in one run

A deck missing its inspection, review or script is what users experience as
"incomplete". Run Phases 0–8 back to back in the same turn. **Do not stop to ask
"shall I continue?"** after a build, a render or a fix — continuing is the
default. Stop early only when:

- the user asked to approve the outline first, or a decision only the user can
  make blocks progress (missing source file, contradictory requirements);
- a required tool is missing and cannot be installed (then deliver what exists
  and state exactly what is pending).

If context is running short, finish the current phase, write
`SLIDES_STATE.json` with the next phase and resume immediately; do not hand
the remaining phases back to the user as a question.

## Tool resolution

```bash
DECK_BUILDER="${ARIS_CACHE_DIR:-$HOME/.aris/cache}/skills/paper-slides/tools/deck_builder.py"
DECK_RENDER="${ARIS_CACHE_DIR:-$HOME/.aris/cache}/skills/paper-slides/tools/render_deck.py"
SLIDE_QUALITY_TOOL="${ARIS_CACHE_DIR:-$HOME/.aris/cache}/skills/paper-slides/tools/slide_quality.py"
ls "$DECK_BUILDER" "$DECK_RENDER" || echo "bundled slide tools missing: reinstall/restart SomniQ"
python3 -c "import pptx, PIL" 2>/dev/null || python3 -m pip install python-pptx pillow
python3 -c "import matplotlib" 2>/dev/null || python3 -m pip install matplotlib   # equation layout
python3 -c "import fitz" 2>/dev/null || python3 -m pip install pymupdf           # PDF figures/pages
```

On Windows, if `python3` is unavailable use `python`.

## Optional: Style reference (`— style-ref: <source>`, opt-in)

Default OFF. Only when `— style-ref: <source>` appears in `$ARGUMENTS`, run:

```bash
STYLE_HELPER=""
for candidate in "$HOME/.config/SomniQ/tools/extract_paper_style.py" "${ARIS_CACHE_DIR:-.}/tools/extract_paper_style.py" "tools/extract_paper_style.py"; do
  [ -f "$candidate" ] && { STYLE_HELPER="$candidate"; break; }
done
[ -n "$STYLE_HELPER" ] || { echo "ERROR: extract_paper_style.py not resolved; --style-ref cannot be satisfied." >&2; exit 1; }
STYLE_STATUS=0
CACHE=$(python3 "$STYLE_HELPER" --source "<source>") || STYLE_STATUS=$?
case "$STYLE_STATUS" in
  0) ;;                                       # use $CACHE/style_profile.md as structural guidance
  2) echo "warning: style-ref skipped (missing optional dep)" >&2 ;;
  *) echo "error: style-ref failed; aborting slides" >&2 ; exit 1 ;;
esac
```

Use `style_profile.md` only for section budget and density. Never copy titles,
notes or examples from it, and never pass it to the reviewer.

## Talk type → slide count

| Talk type | Duration | Slides | Content depth |
|---|---|:-:|---|
| `poster-talk` | 3-5 min | 5-8 | Problem, 1 method, 1-2 results, takeaway |
| `spotlight` | 5-8 min | 8-12 | Problem, 2 method, 2-3 results, takeaway |
| `oral` | 15-20 min | 14-20 | Motivation, method detail, experiments, analysis |
| `group-meeting` | 20-30 min | 16-24 + backup | Progress, evidence, open questions, next steps |
| `invited` | 30-45 min | 25-40 | Background, deep method, extensive results |
| `lecture` | 40-90 min | 25-50 | Concepts, examples, cases, exercises, summary |

Roughly 45–75 s per main content slide. Section/statement slides ≈ 10–20 s.

## Workflow

### Phase 0: Setup

1. Resolve tools (above). Create `slides/`, `slides/figures/`. If `slides/`
   already has a deck, copy it to `slides-backup-{timestamp}/` first.
2. Identify the source and read **all** of it before outlining:
   - LaTeX paper: `main.tex`, `sections/*.tex`, `figures/`.
   - PDF: extract text and the figures you need with PyMuPDF
     (`page.get_pixmap(dpi=220, clip=rect)` for a figure region, or
     `doc.extract_image(xref)` for embedded images) into `slides/figures/`.
   - DOCX/Markdown/notes: read text; extract images if present.
   - Topic only: research it (literature/web tools) and keep sources for notes.
3. Convert every figure you will use to PNG (≥ 200 dpi). Builder accepts
   PNG/JPG only. Check each image with `ReadMediaFile` before using it — know
   what each panel shows.
4. Resume: if `slides/SLIDES_STATE.json` says `in_progress` within 24 h, resume.

**State**: `SLIDES_STATE.json` → `{"phase": 0, "status": "in_progress", ...}`

### Phase 1: Outline

Write `slides/SLIDE_OUTLINE.md`: one row per slide with id, assertion title,
layout, the evidence/figure it uses, seconds, main/backup.

Story template (oral): title → (agenda) → motivation/problem (1–2) → key
insight → method (3–5, at least one `process`/figure) → results (3–6, each with
a figure/chart/table) → analysis/ablation → limitations → takeaway
(`statement` or `bullets` with `takeaway`) → closing → backups.

Rules:
- Every content slide has **one message**, written as its title.
- Plan the **form** of each slide from its content: numbers → `table`/`chart`/
  `metrics`; steps → `process`; parallel ideas → `cards`; comparison →
  `two_column`; a result plot → `figure`/`figure_text`. Plain `bullets` for
  ≤ 60% of content slides.
- Every result slide cites its evidence (figure file, table, log) — no orphan
  claims, no figure from another run.
- Count matches the request; times sum to the slot minus Q&A.

Show the outline as a compact table. Apply `OUTLINE_CHECKPOINT` (above): unless
a stop is warranted, continue directly to Phase 2.

**State**: `phase: 1`.

### Phase 2: Author `slides.json`

Write `slides/slides.json` following [the schema](references/deck-schema.md).

Content rules (enforced by review):

| Rule | Detail |
|---|---|
| Assertion titles | "Routing cuts RMSE by 22%" not "Results". ≤ 2 lines |
| Short visible text | ≤ 6 bullets, ≤ 2 lines each. Chinese: ≤ ~40 字 per bullet. Put explanation in `notes` |
| Concrete | Real numbers with units, bold the key number: `**93.4%**` |
| Readable evidence | One relevant panel per slide (`crop`), or redraw as native `chart`/`table` from the source data |
| Notes on every content slide | 2–4 spoken sentences, timing hint, transition to the next slide |
| Opening hook | Slides 2–3 start from the problem or a provocative question, never "In this paper we…" |
| Takeaway | Final content slide states the one thing to remember |
| No fabrication | Every number traces to the source; cite only works cited in the source |
| Unicode maths in text | θ, ≤, x⁺, Θ₁₂; real equations go to the `equation` layout |
| No AI filler | Remove "delve", "cutting-edge", "赋能", "全方位" style words |

For diagrams beyond `process`/`cards`, generate a PNG: `/figure-spec` (export
SVG → PNG), `/mermaid-diagram`, matplotlib, or `SomniImage` for conceptual
illustrations (label schematics as such; never for results).

**State**: `phase: 2`.

### Phase 3: Build (loop until clean)

```bash
python3 "$DECK_BUILDER" slides/slides.json -o slides/presentation.pptx \
  --report slides/deck_report.json --notes-md slides/speaker_notes.md
```

- Exit 1 → read every `ERROR` line and fix `slides.json`: shorten text, split a
  dense slide in two, fix image paths/convert formats, remove markup residue,
  correct table/series shapes. Rebuild. Repeat until exit 0.
- Then fix warnings that matter: `small_text`, `dense_slide`, `small_figure`,
  `low_resolution`, `missing_notes`, `monotone_layouts`, `duplicate_title`.
- A slide that still overflows after shortening must be split, not shrunk.

**State**: `phase: 3`.

### Phase 4: Render and inspect every page

```bash
python3 "$DECK_RENDER" slides/presentation.pptx --out slides/renders --pdf slides/presentation.pdf
```

Inspect **every page**: open each `slides/renders/review-NN.png` (2×2 grid, 4
slides per image, readable size) with `ReadMediaFile`, then open the full-size
`slide-NN.png` for every figure, table, chart and equation page and for anything
doubtful. `contact-sheet.png` is for flow only. Check:

- Title states the point; text readable; nothing clipped or overlapping.
- Figure is the right one (system/run), large enough, axes/legend legible.
- Table/chart numbers match the source; units and highlight correct.
- No placeholder, no empty area that should hold evidence, no stray markup.
- Order and transitions make a story; cover and closing look finished.

Fix in `slides.json` → rebuild → re-render the changed pages. Record each page's
verdict in `slides/SLIDES_STATE.json` (`render_checks`). If no renderer exists,
say PPTX visual validation is pending and keep draft status — never claim a
renderer you did not run.

**State**: `phase: 4`.

### Phase 5: Draft content review

Send the outline, `slides.json`, the evidence map and the rendered page images
to the independent Reviewer:

```
LlmReview:
  prompt: |
    Review this [TALK_TYPE] presentation ([TALK_MINUTES] min) for [AUDIENCE/VENUE].
    Score 1-5: story arc; slide density/readability; time budget (main + Q&A);
    figure/evidence visibility and correctness; opening hook; takeaway;
    visual consistency and completeness (no placeholders, cover/closing finished).
    Give the top 5 actionable fixes, each naming the slide id.
    Overall: Ready to present? (Yes / Needs revision / Major issues)
```

Apply fixes to `slides.json`, rebuild, re-render changed pages. Save the review
to `slides/SLIDES_REVIEW.md`. If `LlmReview` is unavailable, continue and record
`draft_pending_review`; never present a self-check as independent.

**State**: `phase: 5`.

### Phase 6: PDF and optional Beamer

- `FORMAT = pptx`: `slides/presentation.pdf` from Phase 4 is the PDF.
- `FORMAT = beamer`: generate `slides/main.tex` **from `slides.json`** (a small
  script that maps each layout to a frame; never a second hand-maintained copy
  of the content). Use `xelatex` for CJK. Rules:
  - `\documentclass[aspectratio=169]{beamer}`, no navigation symbols, frame
    numbers, theme colours from `slides.json`.
  - Wrap TikZ in columns with `\adjustbox{max width=\linewidth, max totalheight=0.65\textheight}{...}`;
    page-level TikZ with `\resizebox{0.90\textwidth}{!}{...}`; never `\large` inside `p{}` table columns.
  - Any `Overfull \hbox`/`\vbox` in `main.log` is a blocker (`grep -F "Overfull" main.log`).
  - Render the Beamer PDF (`render_deck.py main.pdf --out slides/renders-beamer`) and inspect every page.

**State**: `phase: 6`.

### Phase 7: Talk script

Generate `slides/TALK_SCRIPT.md` from `slides.json` (same ids, same order): a
word-for-word script per slide with `[start – end]` timestamps, transitions, a
time-budget table (main total vs slot, Q&A reserved), and 6–8 anticipated Q&A
with answers grounded in the source. `speaker_notes.md` is already exported by
the builder from the same notes.

**State**: `phase: 7`.

### Phase 8: Final visual and independent review gate

1. Build `slides/QUALITY_MANIFEST.json` per
   [the quality contract](references/quality-contract.md): hashes of
   `slides.json`, PPTX, PDF, sources; per-page render records for both formats
   (`render_deck.py presentation.pdf --out slides/renders-pdf` gives the PDF
   pages); visual verdicts.
2. Independent Reviewer inspects the current rendered PPTX/PDF pages, order,
   timing, evidence identity and unresolved findings; preserve its report and
   artifact hashes. Revise and repeat for blockers within the agreed scope.
3. Run the checker:

   ```bash
   python3 "$SLIDE_QUALITY_TOOL" slides/QUALITY_MANIFEST.json --stage final --report slides/QUALITY_REPORT.json
   ```

   `--stage draft` while iterating. Exit 1 blocks completion; fix the cause,
   never edit hashes or verdicts to pass.
4. Only after a passing final report set `phase: 8, status: "completed"`.
   Otherwise deliver the useful deck with its accurate status and open issues.

### Completeness checklist (before reporting)

- [ ] Every outline slide exists in `slides.json` and in the PPTX, same order; count matches the request.
- [ ] Cover has title, subtitle/author/date; closing slide present.
- [ ] Builder exit 0; `deck_report.json` has 0 errors.
- [ ] Every page rendered and inspected; issues fixed or listed.
- [ ] Every content slide has notes; `speaker_notes.md` and `TALK_SCRIPT.md` exist.
- [ ] Main-talk seconds + Q&A fit the slot.
- [ ] Review status stated truthfully.

### Final output summary

```
📊 Deck [completed / draft pending review / needs revision]
- [TALK_TYPE], [N] slides ([M] main + [B] backup), [main time] + Q&A [x] min, theme [THEME]
- Files: slides/presentation.pptx · slides/presentation.pdf · slides/slides.json ·
  slides/speaker_notes.md · slides/TALK_SCRIPT.md · slides/SLIDE_OUTLINE.md ·
  slides/SLIDES_REVIEW.md · slides/renders/
- Rendered with: [renderer]; pages inspected: [N/N]
- Open issues: [...]
To revise: edit slides/slides.json and rerun the builder (never edit coordinates by hand).
```

## Recommended follow-up: `/slides-polish`

Only for decks not produced by this builder (external PPTX/Beamer). For
builder decks, polish by editing `slides.json` and rebuilding — the builder
already enforces font floors, fit and figure aspect.

## Key rules

- **Content in `slides.json`, layout in the builder.** No hand-written layout code, no regex conversion, no placeholders.
- **One message per slide**; assertion titles; ≤ 6 bullets.
- **Fit by editing, not shrinking**: overflow → shorten or split.
- **Figures are evidence**: correct run, readable panel, cited source.
- **Both inspection and review are required** before "completed".
- **Do NOT fabricate data or citations.**
- **Large file handling**: if writing `slides.json` in one call fails, write it in parts with bash heredoc and concatenate; do not ask the user.

## Parameter pass-through

| Parameter | Default | Description |
|---|---|---|
| `talk_type` | oral | poster-talk / spotlight / oral / group-meeting / invited / lecture |
| `minutes` | 15 | talk length |
| `slides` | auto | exact slide count (includes cover + backup) |
| `theme` | academic | academic / teal / crimson / graphite / violet / forest |
| `venue` | — | picks a theme |
| `format` | pptx | pptx / beamer |
| `language` | user's | zh / en |
| `notes` | true | speaker notes |
