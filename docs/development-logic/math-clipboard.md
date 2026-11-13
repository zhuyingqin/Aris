# Copy rendered formulas as LaTeX

Rendered KaTeX formulas retain their source in the MathML annotation. The shared
`math/mathClipboard.ts` handler uses that source during a normal selection copy,
including keyboard and browser context-menu copying. It is installed by the
desktop root, so Chat, its companion window and literature reading share it.

Inline formulas copy as `$...$`; display formulas copy as `$$` blocks. A selection
that starts or ends inside a formula copies the complete formula without changing
the visible selection. Mixed selections keep prose, paragraph and list breaks,
code whitespace and table rows/columns, including empty edge cells. Toolbar
labels and code line numbers are omitted. Copying without formulas, from an
editable surface, or after an existing handler has handled the event retains
the existing behavior.

Both clipboard formats contain the formula source. The HTML payload retains
formatting and valid table context, with `data-somniq-math` on formula source
elements. The visual LaTeX editor's HTML paste converter recognizes those
elements so it does not escape the source again.

Validation covers partial formula selection, both formula boundaries, mixed
prose, display spacing, tables, empty cells, literal TeX characters, editable
surfaces and HTML round trips into the visual LaTeX editor. The focused copy,
Markdown, literature and visual-editor suites passed 119 tests. TypeScript
checking and the desktop production build passed. A local browser check confirmed actual Ctrl+C and
Ctrl+V into plain-text and rich-text fields.
