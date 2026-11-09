# Chat image copying

Chat image previews expose their original local path through `data-image-path`.
The chat context-menu handler resolves that path before inspecting nearby text,
so captions, tool output and Unicode or absolute filenames cannot redirect a copy.
The same path is present on enlarged images rendered through the viewer portal.

The file menu offers **Copy image** for recognized image paths and explicitly
identified image previews (including older uploads with misleading extensions).
It disables duplicate writes while copying, closes after a successful write,
and keeps an error visible with a retry action after failure. Escape dismisses
the menu before the image viewer underneath it.

`imageClipboard.ts` reads the original file using the existing scoped file API,
or a displayed data/blob/remote URL when copying from the shared viewer. The
viewer can use its displayed URL if a managed attachment is outside the active
workspace. Remote fetching follows the browser/WebView access rules.
PNG bytes are forwarded intact. Other supported browser image formats are
rendered to PNG at their natural dimensions, preserving alpha. Temporary object
URLs are always released. Desktop sends the PNG as binary IPC to
`clipboard_write_image`, which uses the existing native clipboard plugin.
Screenshot copying shares the same native byte-to-clipboard helper. Browser
preview uses `ClipboardItem` with a PNG promise so clipboard writing begins
within the user gesture.

Validation covers PNG byte fidelity, natural dimensions during conversion,
alpha preservation after native decode, copy failures and retries, duplicate
clicks, image targeting, preview and enlarged-image menu flows, and chat and
screenshot regressions. The desktop frontend must also pass TypeScript checking
and its production build.
