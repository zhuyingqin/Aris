# Image left-click interactions

Image previews without an explicit local `openPath` used to be passive. This
included pasted attachments, remote images and data/blob previews. Repeated
remote-image references opened a separate browser window, and the Chat side
file viewer displayed a static image.

`ChatImagePreview` now opens the shared `ImageLightbox` for every supported
source. Local paths use the shared format/MIME table and local-link normalizer;
Unicode folders, POSIX paths, UNC paths and file URIs are recognized. Remote
query strings and percent-encoded inline image data remain opaque. Existing
captions retain their behavior; enabling clicks does not add attachment labels.

An explicit `onClick` owns navigation for custom galleries. `interactive={false}`
keeps an image inside a dedicated gallery from opening a second viewer. The
image workflow retains its existing comparison and previous/next controls.
Composer thumbnails pass the original attachment path and retain their compact
size and separate remove action. Side-file images reuse the same preview.
Repeated local and remote references both open in the app, with local paths
resolved against the project when the user clicks.

The shared viewer adds Copy image, Ctrl/Cmd+C when no text is selected, clipboard
progress/success/error feedback, loading retries and double-click to toggle
natural size versus fit. Copy path now reports success only after writing
succeeds. Escape, fit/zoom controls, panning, focus restoration and explicit
system actions reuse the existing viewer behavior. Loader retries stay in the
current viewer; temporary blob URLs are released even if loading finishes after
unmount. A replacement image clears the previous image's failure and zoom state.

Clipboard writing shares `imageClipboard.ts` with the Chat context menu. It can
read a local original or the displayed data/blob/remote source. A displayed URL
also serves as a fallback for attachments managed outside the active workspace.
PNG bytes remain intact; other formats are converted at natural dimensions.
Network sources still require the WebView/browser to permit fetching them;
failed writes show an actionable error.

Regression coverage includes the viewer, previews/references, sent and unsent
attachments, side-file images, Markdown and deduplication, Chat integration,
the existing right-click path and the image workflow. Run focused Vitest,
`npm run typecheck` and `npm run build` from `desktop/`. Current verification
records are under `.somniq/changes/image-left-click-2026-10-19/`.

Follow-up product additions worth considering are saving the original image
with a chosen filename, previous/next navigation across ordinary Chat images,
and attaching the viewed image to a new editing request. These are outside the
completed preview fixes. Native cross-application clipboard testing and an
installer update are separate from frontend verification.
