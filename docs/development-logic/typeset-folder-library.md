# LaTeX library folder navigation

The Typeset landing page uses the scanner's existing project boundaries and
retains the real source-directory hierarchy inside each project. It builds the
folder tree from the discovered root documents; included chapters remain in the
editor's file explorer. No files are moved or rewritten.

- Multi-document projects and nested folders start collapsed. A project with
  one directly contained document keeps its small preview for quick access.
- Each folder shows its matching root-document count. The scanner's total
  `.tex` count, which also includes chapter files, appears only on project rows.
- Folder shortcuts prefer a `main.tex` directly inside the folder, then a
  descendant main document, then the first sorted document.
- Folder expansion is saved locally per workspace under
  `somniq-typeset-library-folders:<workspace>`, including when returning from the
  editor. Refreshing the document list retains expansion for existing paths.
- Search opens matching ancestors automatically. Search-only disclosure changes
  are temporary; clearing search restores the saved browsing state.
- Expand/collapse all applies to the current filtered hierarchy. Select visible
  documents applies only to document rows currently displayed.
- Include-only projects remain listed without a misleading empty-library
  message. Projects containing only archived documents leave the active view.

Validation covers nested traversal, exact source paths, main-document shortcuts,
workspace restoration, search, filtering and file actions, Windows separators,
natural folder order, and localization. Chromium exercises 122 documents and
light/dark layouts at 1360, 960, 720 and 390 pixels; narrow tables scroll within
the library. Evidence is stored under
`.somniq/changes/latex-folder-library-2026-10-16/`.
