# slides.json schema (deck_builder.py)

`slides.json` is the single content source. `tools/deck_builder.py` turns it
into an editable PPTX: geometry, fonts, text fitting, figure fitting, native
tables/charts, page numbers and speaker notes are deterministic. **Do not write
python-pptx layout code; author content and pick a layout.**

Visible text is plain Unicode. `**bold**` marks emphasis (rendered bold in the
accent colour). Write maths in Unicode (θ, ≤, x⁺, Θ₁₂, ∂Q/∂u, ≈) or use the
`equation` layout. Never put LaTeX commands, `$...$`, `\\`, `[0.2cm]`, column
widths, `[图表]`/`TODO` placeholders or HTML in visible text — the builder
rejects them.

## Top level

(`//` comments below are explanations only — real JSON has no comments.)

```json
{
  "meta": {
    "title": "Deck title",
    "subtitle": "One-line framing",
    "author": "Name", "affiliation": "Lab / University", "date": "Venue · 2026-11-15",
    "footer": "short title shown bottom-left",
    "language": "zh | en",
    "theme": "academic | teal | crimson | graphite | violet | forest",
    "venue": "NeurIPS",              // optional; picks a theme when `theme` is absent
    "talk_minutes": 15,             // optional; main (non-backup) seconds must fit
    "slide_count": 16,              // optional; must equal len(slides) when given
    "colors": {"accent": "#2F6FDE"},// optional overrides: primary accent accent2 text muted light line bg
    "fonts": {"latin": "Calibri", "ea": "Microsoft YaHei"}, // optional
    "min_body_pt": 16               // optional floor for body text fitting
  },
  "slides": [ { "id": "s01", "layout": "title", ... }, ... ]
}
```

Fields common to every slide:

| field | meaning |
|---|---|
| `id` | stable unique id |
| `layout` | one of the layouts below |
| `notes` | speaker notes: what to say (2–4 sentences), timing hint, transition. Required on every content slide |
| `seconds` | planned speaking time; `0` for backup |
| `backup` | `true` for backup slides after the closing |
| `source` | small provenance line above the footer, e.g. `来源：Table 2；logs/run_k2.log` |
| `lead` | optional one-sentence framing under the title (content layouts) |
| `takeaway` | optional one-sentence conclusion in a highlighted band at the bottom (content layouts) |
| `source_ids` | optional ids into the quality manifest; not rendered |

`title` on content slides is an **assertion** ("TD residual carries no
information about Θ"), not a topic label ("TD residual"). ≤ 2 lines.

## Layouts

Pick the layout from the shape of the content. A deck that is >60% `bullets`
gets a warning.

| layout | use for | required fields | optional |
|---|---|---|---|
| `title` | cover | (meta.title) | `title`, `subtitle`, `author`, `affiliation`, `date`, `image` |
| `section` | part divider | `title` | `number` ("01"), `subtitle` |
| `agenda` | outline | `items` (2–10 strings) | `title`, `current` (1-based index to highlight) |
| `bullets` | argument in 3–6 points | `title`, `bullets` | `lead`, `takeaway` |
| `figure` | one large figure / plot | `title`, `image` | `caption`, `crop`, `takeaway` |
| `figure_text` | figure + 3–5 explanatory points | `title`, `image`, `bullets` | `image_side` (`left`/`right`), `image_ratio` (0.4–0.7), `caption`, `crop` |
| `two_column` | comparison / before-after / problem-solution | `title`, `left`, `right` each `{heading, bullets}` | `highlight` on a side |
| `cards` | 2–6 parallel ideas, contributions, findings | `title`, `cards: [{title, text}]` | `badge` per card, `muted` |
| `metrics` | 1–4 headline numbers | `title`, `metrics: [{value, label}]` | `note` per metric |
| `process` | pipeline, method steps, timeline (2–6) | `title`, `steps: [{title, text}]` | `badge`, `muted` per step |
| `table` | exact numbers, ablations, comparisons | `title`, `columns`, `rows` | `highlight_row` (1-based data row) or `highlight_rows`, `caption` |
| `chart` | trends / magnitudes that should be seen | `title`, `chart` | `bullets` (shown right of the chart) |
| `equation` | 1–3 key equations | `title`, `equations` (LaTeX math, no `$`) | `explanation` bullets, `image` |
| `statement` | one memorable sentence | `statement` | `subtitle` / `attribution` |
| `closing` | thanks / Q&A | — | `title`, `subtitle`, `contacts` (list of strings) |

### Bullets

A bullet is a string, or `{"text": "...", "sub": ["...", "..."]}` for one level
of sub-points. Keep ≤ 6 top-level bullets and ≤ 2 lines per bullet; detail
belongs in `notes`. The builder picks the largest font (≤ 28pt) that fits and
reports an error if even the minimum overflows — then split the slide.

### Images

`image` is a path relative to `slides.json` (PNG/JPG). Convert PDF/SVG figures
to PNG at ≥ 200 dpi first (`pdftoppm -png -r 220 fig.pdf out`, or PyMuPDF).
Images keep their aspect ratio and are centred in their box. For a multi-panel
paper figure, show only the panel that supports the slide's claim:

```json
"crop": {"left": 0.5, "top": 0.0, "right": 0.0, "bottom": 0.5}
```

(fractions of the original removed from each side). Missing images are errors.

### Equations

`equations` entries are LaTeX math without `$`, rendered by matplotlib
mathtext. The builder already rewrites the common unsupported forms (`\ge`,
`\le`, `\tfrac`, `\bm`, `\big(`, `\displaystyle`, `\limits`, `\lVert`,
`&`, `\tag{}`), and a `\\` line break becomes separate lines. Keep 1–3
short relations per slide; a long equation shrinks to unreadable size (the
builder warns). Not supported: `\begin{...}` environments, `\mathbbm`,
macros defined in the paper — expand them by hand. Remember JSON escaping:
write `"\\frac{a}{b}"` in the file for `\frac{a}{b}`.

### Charts

```json
"chart": {
  "type": "column | bar | stacked_column | line | pie | doughnut",
  "categories": ["A", "B", "C"],
  "series": [{"name": "Ours", "values": [0.91, 0.87, 0.95]},
             {"name": "Baseline", "values": [0.84, 0.80, 0.90]}],
  "y_label": "Accuracy", "x_label": "Dataset",
  "number_format": "0.00", "label_format": "0.0%",
  "labels": true, "y_min": 0.7, "y_max": 1.0, "title": "optional"
}
```

Values are numbers with full precision; formatting is display-only.

### Tables

```json
{"layout": "table", "title": "Ours wins on 3 of 4 benchmarks",
 "columns": ["Method", "CIFAR-10", "ImageNet", "Params"],
 "rows": [["Baseline", "91.2", "76.1", "25M"], ["**Ours**", "**93.4**", "**77.0**", "24M"]],
 "highlight_row": 2, "caption": "Top-1 accuracy (%), mean of 3 seeds"}
```

≤ 10 data rows and ≤ 7 columns for projection; move the rest to a backup slide.

## Running

```bash
DECK_BUILDER="${ARIS_CACHE_DIR:-$HOME/.aris/cache}/skills/paper-slides/tools/deck_builder.py"
python3 "$DECK_BUILDER" slides/slides.json -o slides/presentation.pptx \
  --report slides/deck_report.json --notes-md slides/speaker_notes.md
```

Exit 0 = built cleanly. Exit 1 = read every `ERROR` line, fix `slides.json`
(shorten, split, fix paths) and rerun. Never bypass by editing the PPTX by hand
or by writing your own python-pptx script. Warnings (`small_text`,
`dense_slide`, `low_resolution`, `small_figure`, `missing_notes`,
`monotone_layouts`) should normally be fixed too.

`--check` lints and measures without writing the PPTX.

## Minimal example

```json
{
  "meta": {"title": "Physics-informed routing for earthquake forecasting",
           "author": "A. Author", "affiliation": "Lab", "date": "ICML 2026",
           "language": "en", "theme": "academic", "talk_minutes": 12},
  "slides": [
    {"id": "title", "layout": "title", "seconds": 15, "notes": "Introduce yourself and the problem in one sentence."},
    {"id": "gap", "layout": "bullets", "title": "Large earthquakes are where data is thinnest",
     "bullets": ["M≥6 events are **<1%** of the catalog", "Regional regimes differ; one global model averages them away"],
     "takeaway": "We need to know **when** domain knowledge should override the model",
     "seconds": 60, "notes": "Start from the failure case ... Transition: so how do we route?"},
    {"id": "method", "layout": "process", "title": "Route first, then correct per zone",
     "steps": [{"title": "Statistics", "text": "b-value, Lv, Cv per window"},
               {"title": "ST-GAT router", "text": "posterior over 4 zones"},
               {"title": "Zone experts", "text": "MLP + ANFIS residual"}],
     "seconds": 75, "notes": "..."},
    {"id": "result", "layout": "chart", "title": "Routing cuts magnitude error by 22%",
     "chart": {"type": "column", "categories": ["MLP", "MLP+ANFIS", "Ours"],
               "series": [{"name": "RMSE", "values": [0.391, 0.323, 0.297]}], "y_label": "RMSE"},
     "bullets": ["Gain comes from ANFIS correction", "Static + dynamic rules are complementary"],
     "source": "Table 3", "seconds": 70, "notes": "..."},
    {"id": "end", "layout": "closing", "contacts": ["github.com/org/repo"], "seconds": 10, "notes": "Take questions."}
  ]
}
```
