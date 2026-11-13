# Research DOCX reference

`research-reference.docx` is built by `tools/docx/build_reference.py` from Pandoc
3.13's default reference document, then styled through python-docx. It is a
research-report default, not a claim of compliance with a government or journal
standard. A supplied `reference_doc` is the design authority for those outputs.

The template uses A4, 25.4 mm margins, Times New Roman / 宋体 body at 12 pt,
1.5 line spacing, black heading styles, and widow control. Font installation is
separate; a valid DOCX does not prove the requested fonts were used in rendering.

Pandoc is GPL-2.0-or-later and python-docx is MIT. Engines are separately installed
and versioned; the application does not embed their executable code here. See
`docs/development-logic/docx-open-source-selection.md` for pinned upstream sources
and distribution considerations. Keep the original Pandoc reference data notice
when redistributing its template data. Existing ODT highlighting uses odfpy
1.4.1 (its style API source declares LGPL-2.1-or-later); it is an external Python dependency.

`NOTICE.md`, `pandoc-COPYRIGHT.md` and `pandoc-COPYING.md` accompany the modified
reference data. The generator delegates parsing, math and pagination to upstream
engines. Bounded character formatting uses python-docx's font APIs; structure
edits use its table, picture, break and footer APIs. Small OOXML adapters add
native fields/bookmarks and borders when an imported file lacks a table style.
The Rust host owns exact revisions, verified image resources, isolated engine
jobs and atomic audited publication. Original package parts are copied unchanged
unless the selected operation needs to modify them. See `tools/docx/README.md`
for dependencies and reproducible checks. Word/WPS compatibility requires
evidence from those editors and is separate from LibreOffice rendering.
