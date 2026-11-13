# SomniQ Studio 0.4.88

This release adds native Word document tools and their shared Agent routing on
top of the 0.4.87 branch. PR #111 for that baseline is still separate; the 0.4.88
PR targets `aris-code` and includes those inherited commits.

## Changes

New Word documents use Pandoc; existing documents use bounded python-docx/OOXML
edits. LibreOffice supplies PDF pagination and native index calculation. The
shared Rust runtime enforces file permissions, exact revisions, atomic candidates,
audit and undo. These are tool implementations as well as prompt/routing changes.

Daily office actions cover native tables and repeated headers, cover/body page
numbering, selected-section orientation, supported inline revision acceptance,
native text/dropdown controls, scoped author properties and updatable TOC fields.

## Evidence

- [Shared Agent natural-language cases](docx-agent-acceptance.md): 10 automated
  cases with the actual configured model and production Chat/tool routing.
- [Office file cases](docx-office-acceptance.md): 14 automated cases; 14 originals
  unchanged, 16 undo checks and 20 final page images.
- [Backend-derived criteria](docx-user-acceptance.md): anonymous derivatives;
  original customer attachments and complete customer tasks are not certified.
- [Upstream choices](docx-open-source-selection.md) and
  [reproduction/dependencies](../../tools/docx/README.md).

The release build and final verification logs are retained locally under
`.somniq/research/release-0.4.88-20261111` in the source workspace. The uploaded
build manifest binds the installer to its exact Git commit and records checks.

## Local engines and remaining limits

Install Pandoc, LibreOffice and Python with `python-docx==1.2.0` and
`odfpy==1.4.1` separately. Configure the engines through PATH or the `SOMNIQ_*`
environment variables documented in the tool README; automatic TOC calculation
also requires a Python runtime with LibreOffice UNO. The installer includes the
adapters and reference data, not those engine executables.

This Windows asset is a manual installer without an updater signature. No macOS
asset is built by this Windows host. Desktop UI, Word/WPS, independent visual
Reviewer and binary `.doc` are not established by these document tests. An input
title glyph defect and a model explanation's inconsistent paragraph count remain
recorded. Concurrent task-plan and plugin-continuation edits in the source
workspace are excluded from this release.
