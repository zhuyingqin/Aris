---
name: latex-diagrams
description: "Build explanatory TikZ diagrams for LaTeX papers or Beamer slides, optionally combining generated concept illustrations with native labels. Use for LaTeX流程图、问题解释图、算法框架、条件分支、反馈回路 and mathematical diagrams. Compile and inspect the final rendering."
allowed-tools: read_file, write_file, edit_file, glob_search, grep_search, bash, ToolSearch, SomniImage, LaTeXCompile, ReadMediaFile, LlmReview
---

# LaTeX diagrams for explanation

Produce an explanation whose logic can be read from the diagram, together with
editable diagram source integrated into the user's document. A diagram can explain
how a problem is posed, what is known or unknown, where a decision is made, or
how a method transforms its inputs. It need not always be an algorithm pipeline.

Use this skill for explanations in LaTeX/Beamer. Keep Mermaid for chat diagrams
and `figure-spec` for a requested editable SVG. Keep existing project notation,
paths and visual style when revising a document.

## Choose the medium

| Explanatory need | Preferred construction |
|---|---|
| Exact flow, branches, feedback signals, equations or dense labels | Native TikZ with editable labels and edges |
| Physical scene, spatial intuition or a conceptual illustration | Existing `SomniImage` generation when available and appropriate to the request |
| A scene plus exact variables, labels or causal arrows | Generated illustration with native TikZ/LaTeX overlays |
| Measured results, screenshots or evaluated model samples | Actual data or source assets |

Respect explicit choices such as pure TikZ, local-only construction or a requested
image-generation route. For image or hybrid construction, read
[the image-generation guide](references/image-generation.md) for the existing
tool, prompt design, source records and document integration. A generated image
remains a raster asset; native overlays preserve the editability of its labels.

## Choose the explanation before its geometry

Read the relevant problem or method and the containing document. Establish a
small diagram brief in working notes, or in the deck's common content model:

- The one question the diagram should answer and its intended takeaway.
- Known inputs, unknown quantities, outputs and assumptions.
- Named nodes and directed edges, including what each arrow carries or means.
- Branch conditions, feedback state, termination conditions and relevant sources.

Do not add a causal arrow, a parallel execution claim, an optimization guarantee,
or a successful experiment simply to complete a visually pleasing graph. Mark
illustrative assumptions as such. A training loop must distinguish training from
inference; a feedback arrow must identify the returned signal or updated state.
An iterative procedure needs a stopping condition and an exhausted-budget path
when the described method has one. If the source leaves an essential relation
unknown, show that uncertainty or request the missing fact instead of inventing it.

Choose the form by the question: a pipeline for transformation, labelled branches
for decisions, a feedback loop for interaction, fork/join for independent checks,
or paired diagrams to compare a forward and an inverse problem. Use a small
overview plus detail views when a single diagram becomes hard to follow.

## Build from tested patterns

Read [the construction and integration guide](references/construction.md) for
layout, math, CJK and rendering. These source assets provide adaptable patterns:

| Asset | What it explains |
|---|---|
| [pipeline.tex](assets/pipeline.tex) | From observations to candidate parameters; distinguishes a condition from a proof |
| [decision-loop.tex](assets/decision-loop.tex) | Validation, bounded revision, successful exit and exhausted-budget exit |
| [feedback-loop.tex](assets/feedback-loop.tex) | Negative feedback with explicit control, measurement and disturbance signals |
| [parallel-checks.tex](assets/parallel-checks.tex) | Two checks of the same candidate supporting different conclusions |

[diagram-styles.tex](assets/diagram-styles.tex) supplies shared TikZ styles.
[examples-beamer.tex](assets/examples-beamer.tex) and
[examples-article.tex](assets/examples-article.tex) are compilable Chinese/math
wrappers for all four snippets. Copy the needed assets into the user's document
directory and adapt their actual semantics; sample notation is not evidence for
the user's method. Use `\input{}` to retain separate editable sources.

Resolve resources relative to the loaded skill directory. Bundled supporting
files are extracted under `$ARIS_CACHE_DIR/skills/latex-diagrams/`; the repository
development source is `crates/runtime/assets/skills/latex-diagrams/`. Check the
actual available path rather than guessing a versioned cache directory.

Prefer named nodes, relative positioning, explicit anchors and routed edges.
Keep node labels short; put derivations in nearby equations, captions or notes.
Use native math mode for formulas and load the required TikZ libraries. Avoid
automatic whole-diagram shrinking as the first response to overflow: reflow,
shorten labels, change orientation or split the explanation first.

## Compile, inspect, revise

1. Compile the actual containing root with `LaTeXCompile`; use the reported
   diagnostics for minimal repairs. Use the configured compiler fallback only
   if that tool is unavailable or the environment explicitly requires it.
2. Render the resulting PDF pages locally with an available PDF renderer, then
   read the actual images with `ReadMediaFile`. Inspect at final page/column size:
   labels, math signs, branch labels, arrow endpoints, crossings, clipping and
   the visual reading order. The Visual editor's approximate preview is not a
   TeX renderer. Do not report visual inspection if the model cannot see images.
3. Check the render against the brief: correct input/output roles, edge direction,
   decision labels, feedback signal and logical limits. Repair concrete issues
   and rerender the affected pages. This local repair loop does not authorize
   repeated paid image requests. Use the existing workflow's repair budget;
   for an isolated diagram, allow at most three repair passes before reporting
   the remaining issue with the editable source.
4. Preserve the containing workflow's independent Reviewer. When enabled or
   required, give that Reviewer the brief, current source and actual renders;
   distinguish execution checks from independent review. Missing or negative
   required review keeps the artifact a draft.

Deliver links to the containing source, diagram snippets and compiled PDF, with
the diagram's takeaway and actual validation status. If the diagram is also
exported to PPTX, preserve its meaning and inspect that export separately; a
vector image alone does not promise editable PowerPoint nodes or connectors.
