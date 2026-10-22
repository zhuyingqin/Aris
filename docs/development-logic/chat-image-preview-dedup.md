# Chat image preview deduplication

The generation → `ReadMediaFile` verification → final Markdown sequence used
to show the same artifact three times. Each tool card and each Markdown image
or image link independently created a `ChatImagePreview`.

`ChatMessage` now computes a deterministic presentation plan for each assistant
turn. The first occurrence of an image source keeps its preview; subsequent
occurrences become compact, clickable image references. Tool inputs, outputs,
model image content, session storage and the independent review loop are unchanged.
The plan is reconstructed from the turn, so streaming, StrictMode and history
virtualization do not depend on component mount order or a global registry.

Local image identities resolve against the current project, normalize Windows
separators, drive/filename case, dot segments, URI encodings and editor locations.
Remote URL queries, POSIX path case and embedded image bytes remain distinct.
This is source deduplication; identical pixels saved under different filenames
are separate artifacts. A later assistant turn and user attachments have their
own presentation scope.

Markdown source discovery uses the same remark parser, GFM/math extensions and
text preparation as rendering. It supports inline images and image links as well
as reference definitions. Thinking, code, raw HTML and oversized plain-text
previews do not claim image sources. `unified` and `remark-parse`, already in the
lockfile through `react-markdown`, are declared as direct dependencies.

Consecutive tool calls retain their audit grouping. Their unique image previews
remain visible outside the collapsed details, and expanding the group does not
create another preview inside each call.

Regression coverage lives in `ChatImageDeduplication.test.tsx` and
`imagePreviewIdentity.test.ts`; existing ChatMessage, MarkdownContent,
ChatImagePreview, tool summary and ChatThread checks also apply. Run focused
Vitest, `npm run typecheck` and `npm run build` from `desktop/`.

## Opening image references (2026-10-16)

The compact `View image` reference previously used the generic Chat file opener,
which classified image files as LaTeX assets and switched workspace tabs. Local
references now open the shared `ImageLightbox` directly. `LocalImageLightbox`
loads the selected file on demand, shows loading/read-error states in that
viewer, and releases browser object URLs on close, including late completions.
The selected path resolves against the project when clicked. Zoom, fit, Escape,
focus restoration and explicit system actions reuse the existing image viewer.

Generic image file links and tool-card paths now have an `image` open target and
use Chat's image side viewer. TeX sources retain their LaTeX route. The side
viewer uses the shared image type/MIME table and offers workspace navigation
only for Code and LaTeX sources, so an image has no misleading LaTeX action.

Seven focused Vitest suites passed 116 tests, including reference opening,
image deduplication, viewer lifecycle and file routing. Full TypeScript checking
and the production frontend build passed. Evidence and source hashes are in
`.somniq/changes/chat-image-open-2026-10-16/verification.json`. These checks did
not include a native WebView2 interaction run or an installed-app update.

## Earlier deduplication verification

Verification on 2026-10-08: eight focused suites passed 136 tests; the final
edge-case rerun passed eight tests, including one additional regression case.
Strict TypeScript checking for the changed Chat components/tests and their
dependencies passed with the project's existing settings. The Desktop build
passed. The last full-project typecheck encountered an unrelated concurrent
change: unused `beforeSvg` in `figures/FigureRasterEditor.tsx:37` (TS6133).
That file was not changed by this fix. Logs and the exact validation scope are
saved under `.somniq/runtime/chat-image-dedup-*`; the native installer has not
been rebuilt or restarted.
