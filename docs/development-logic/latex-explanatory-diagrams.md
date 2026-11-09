# Explanatory diagrams in LaTeX and slides

The milestone is to make explanatory TikZ diagrams a discoverable, executable
SomniQ capability in papers and Beamer slides. Acceptance is a correctly routed
bundled skill, editable Chinese/math examples that compile in both document
contexts, and inspection of their actual PDF renders.

The inspected baseline already had TeX Live compilation, some TikZ slide examples,
bounding-box advice in `paper-slides`, and a lightweight graph-shaped TikZ editor
preview. It lacked a focused explanation workflow. Desktop's diagram instruction
preferred Mermaid without a LaTeX exception, while `paper-figure` described
architecture and pipeline diagrams as requiring manual creation. The editor
preview explicitly supports only a subset and is not a TeX renderer.

## Selection and construction

`latex-diagrams` is bundled through the existing runtime asset inventory; no new
tool, dependency or separate rendering service is needed. The shared system prompt
and Desktop route diagrams inside LaTeX/Beamer to native TikZ, while chat Mermaid
and requested editable SVG keep their existing workflows. `paper-slides`,
`paper-figure` and `figure-spec` point to the same capability.

The skill starts from a question and takeaway, known/unknown quantities, named
nodes, meaningful edges and source assumptions. It distinguishes transformation,
decision, feedback and separate-check diagrams. Branches and loops retain their
conditions and limits; a schematic never supplies an empirical result or a proof.
For slides, diagram semantics belong in the common content source alongside notes
and evidence, so a PPTX adapter can preserve the explanation.

The assets contain shared styles, four diagram body fragments and complete
`ctexbeamer`/`ctexart` wrappers using the TeX-distributed Fandol fonts. They remain
editable native math/TikZ. Full-width examples need reflow for narrow columns;
the skill recommends simplifying or splitting before shrinking labels.

## Reusing image generation

Desktop already registers and dispatches `SomniImage` when the account's drawing
model is available. The existing API stores images and `generation.json` with
the prompt/model, references and image hashes. Dynamic routing can expose the
tool through `ToolSearch`; this integration needs no new generation backend.

The explanatory skill and shared/Desktop prompts now distinguish exact TikZ
logic from conceptual scenes and hybrids. `references/image-generation.md`
documents the actual tool schema, local assets and provenance, native overlays,
final composition inspection, paid-request stopping rules and existing Figures
reconstruction when editable vectors are requested. Explicit pure-TikZ and
local-only requests remain authoritative. `paper-slides` and `paper-figure`
include this route; `figure-spec` no longer points to the unbundled
`paper-illustration` skill.

Generated artwork stays a schematic. It cannot replace source data, screenshots
or evaluated model samples. The selected image and its generation record belong
in the common slide content/source record, with `method` evidence role in the
quality manifest. Native notation and graph logic remain editable; raster or SVG
inclusion alone does not provide editable PowerPoint nodes. The final composition
retains the parent workflow's independent review.

## Verification and limits

Compile the containing root with SomniQ's existing `LaTeXCompile` tool, then
render and inspect the actual affected pages. The skill preserves the parent
workflow's independent Reviewer and repair budget. A successful build or an
editor approximation does not establish semantic correctness or readability.
An SVG/PDF diagram included in PPTX does not promise native editable PPTX shapes.

Local samples live in `output/slides/latex-diagrams-capability/`. Both wrappers
compiled with TeX Live 2025/XeLaTeX to four pages each. All eight pages were rendered
with PyMuPDF and visually inspected. The final logs have no overfull-box,
missing-character or unresolved-reference findings, and extracted text stays
inside each page. Inspection caught white edge-label backgrounds covering borders
and awkward decision-node wrapping; the shared styles were corrected and both
documents rebuilt and reinspected.

Detailed verification, source/output hashes and build logs are under
`.somniq/changes/latex-diagrams-2026-10-15/`. The 10 bundle extraction, 30 runtime
prompt and 9 Desktop prompt tests passed. The complete Rust workspace suite also
passed with serial test execution outside the sandbox. Its earlier sandbox run
could not start Bash/Jupyter child processes (access denied); an initial parallel
run also hit a browser test's one-second deadline, which passed in isolation and
in the final complete run. The verification record retains these distinctions.

These checks validate the instructions' integration and actual templates. They
are not a live evaluation of the configured agent models, and no independent
model review or paid model call was performed. The installed application has not
been repackaged or updated; the capability is present in repository builds.

The image-route follow-up has separate source hashes and verification records in
`.somniq/changes/latex-diagrams-images-2026-10-15/`. It checks resource bundling,
prompt assembly and existing native image-tool dispatch, with the full shared
workspace regression recorded there. The reference's image request is a recipe;
no paid image generation or real-model routing evaluation was performed. Existing
tool availability and external-action permissions still apply, including the
read-only autonomous workflow registry.
