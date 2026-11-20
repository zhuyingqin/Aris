# LaTeX source environment folding

The source editor offers CodeMirror's native gutter arrow on a multiline
`\begin{...}` / `\end{...}` pair. Clicking the arrow collapses the body into
an ellipsis while retaining the delimiters; clicking the arrow or ellipsis
expands it. Existing fold/unfold and fold-all/unfold-all shortcuts also work.
Nested environments retain their own fold state when an outer fold reopens.

`editor/latexFolding.ts` reuses `scanLatexStructure` for nested, starred and
custom environments, comments, escaped commands, inline verbatim and raw
environments. Raw environments themselves can fold, while their example tags
cannot. Incomplete pairs and pairs contained on one line do not get an arrow.
Multiline opening options, such as TikZ parameters, fold from the opening line
so the arrow remains attached to the `\begin` command.

The shared scanner now also indexes `\verb` and `\verb*` as raw ranges bounded
by their literal delimiter or the line end. Editing their delimiter or body
invalidates the incremental structure cache, since an ordinary character may
change where raw text ends.

Fold lookup is cached by the immutable CodeMirror document in a weak map.
Selection changes and scrolling reuse the lookup; document edits recompute it.
The lazy language loader keys LaTeX by editor surface and adds folding only to
the source surface, preserving Visual mode's rendering decorations. Changing
languages on the existing editor reconfigures the same compartment.

Folding only creates view decorations: it does not edit the document or affect
formula rendering, saved files or PDF compilation. Verification covered 223
related tests, including 21 folding and three inline-verbatim regression tests;
TypeScript checking and the production frontend build passed. Native browser clicks
verified nested folds, ellipsis expansion, starred math, multiline TikZ and raw
environments with source text unchanged. Dark/light screenshots are saved under
`.somniq/changes/latex-environment-folding-2026-10-27/`.
