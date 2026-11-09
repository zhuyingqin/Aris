# Construction and integration

## Explain the problem

A useful diagram makes a relation visible that prose is making hard to track.
For an inverse problem, show observed quantities and the unknown being inferred.
For a solver, distinguish the supplied data, candidate construction, validation
and returned result. For a control problem, separate the controlled system from
the controller and label the signals. For comparisons, align corresponding
inputs and outputs; do not imply that two methods have identical assumptions.

Use concrete labels such as “expert demonstrations”, “candidate cost” and
“independent validation” instead of a sequence of “module 1/2/3”. Distinguish a
data-flow arrow from a logical implication or a time update. Define dashed lines
if they mean optional, unobserved or hypothetical; do not use the same appearance
for incompatible meanings. A return arrow is not enough to specify an algorithm:
identify what changes and when it stops.

The bundled examples are explanatory schematics. In particular, the pipeline's
`G\theta=b` presupposes a valid feature model and suitable optimality conditions;
solving it does not prove uniqueness, feasibility or global optimality. The
parallel checks establish different properties and do not imply success. Keep
these limits visible when adapting the example.

## Layout that survives integration

- Start with a dominant reading direction and place named nodes before edges.
  Group related nodes with `fit` and a background layer when grouping adds meaning.
- Use `positioning` for regular sequences and `calc`/coordinates for deliberate
  routing. Attach arrows to `.east`, `.west`, `.north` and `.south` anchors. Route
  return arrows outside the main path with `|-`, `-|` or explicit waypoints.
- Reserve room for edge labels and return paths. A crossing must not masquerade
  as a junction; a junction should be explicit when it matters.
- Bound text width and use `align=center` with deliberate line breaks. Keep a
  coherent font hierarchy and enough contrast; color alone should not encode
  branch outcomes. Use a diamond when a branch asks a real question.
- Measure against the containing `\linewidth`, which changes inside columns.
  The examples are full-width layouts. In a narrow paper column, reflow to a
  vertical/stacked layout or use a permitted full-width figure. Do not simply
  shrink a full-width example into half a slide.
- Beamer's `\small` is already small in many themes. If a fitting wrapper reduces
  labels further, shorten or split the figure. Check the rendered labels and
  arrowheads at the size the audience will see, including a two-column slide.

Required packages and libraries for the snippets live in
`../assets/diagram-styles.tex`. It belongs in the document preamble:

```latex
\input{diagrams/diagram-styles}
```

Place the snippet in the document body:

```latex
\begin{figure}[tb]
  \centering
  \input{diagrams/pipeline}
  \caption{Candidate construction under the stated feature and optimality
    assumptions; additional validation is needed.}
  \label{fig:candidate-construction}
\end{figure}
```

Inside Beamer, use `\centering\input{diagrams/pipeline}` in a frame. For a
multi-part explanation, reveal existing nodes/edges with `\uncover` or
`\visible` so their bounding boxes remain stable. Count and inspect all overlay
pages; multiple PDF pages may belong to one logical slide. The provided wrappers
use no overlays so the four diagram examples produce exactly four PDF pages.

## Math and Chinese

Use `$\theta$`, `$x_{t+1}$` and `$\|G\theta-b\|$` in labels; escape text characters
such as `%`, `_` and `&` outside math. Use `\\` only where the node's alignment
and text width support line breaks. Keep long derivations outside nodes.

Preserve the target document's CJK and font configuration. A new Chinese sample
can use `ctexbeamer` or `ctexart` with XeLaTeX/LuaLaTeX. The wrappers use the
TeX-distributed Fandol font set, avoiding a dependency on Windows-only fonts.
Latin-only documents can use ordinary `beamer`/`article` and the same styles.
The snippets themselves do not select a document class or compiler.

## Verify the real PDF

Compile the document root, not an input snippet. SomniQ's `LaTeXCompile` chooses
a suitable TeX Live engine and returns structured diagnostics. Preserve the
project's existing compiler preference. Do not enable shell escape or TikZ
externalization for ordinary flowcharts.

Check the log for overfull boxes, missing glyphs and unresolved references.
These are useful diagnostics but cannot establish correct routing or readable
labels. Render the actual affected PDF pages with a local tool such as Poppler
(`pdftoppm`) or PyMuPDF when available, then inspect the image bytes. Text
extraction alone and the editor's lightweight SVG preview do not validate TikZ.
If there is no renderer or no image-capable model, keep the source/PDF and state
that visual verification remains pending.

For a revision, inspect the affected pages plus relevant surrounding layout;
for a slide deck, follow its complete delivery gate. Bind a required independent
review to the current source/output; changing labels or edges invalidates review
of the earlier version. A compile pass is an execution check, not an independent
semantic or scientific review.
