# Research reference document provenance

`research-reference.docx` is a modified copy of Pandoc 3.13's default
`reference.docx`, exported with `pandoc --print-default-data-file reference.docx`.
The default reference is built from Pandoc's `data/docx` resources.

Pandoc copyright (C) 2006–2024 John MacFarlane and contributors.
Pandoc is licensed under GPL version 2 or later, with the exceptions described
in the accompanying upstream `pandoc-COPYRIGHT.md`. The `data/templates`
exception must not be assumed to cover the separate `data/docx` resources.
The accompanying `pandoc-COPYING.md` contains GPL version 2.

SomniQ modifications: A4 page settings, report paragraph/heading styles,
Times New Roman / 宋体 body fonts, spacing, widow and keep controls, and document
properties. The complete recipe is `tools/docx/build_reference.py`; no Pandoc
executable is bundled in this directory. Upstream source for the used release:
https://github.com/jgm/pandoc/tree/3.13/data/docx

These template data and upstream notices retain their upstream terms; the
repository's general license does not replace those terms.
