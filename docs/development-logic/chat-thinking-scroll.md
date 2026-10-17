# Chat thinking and streaming scroll stability

`ChatThread` compensates height changes only for rows whose previous end is at
or above the viewport top. A long assistant turn can begin above the viewport
while its answer or reasoning continues below the reader. Comparing its start
with the scroll offset treated every new line as an above-viewport change and
pulled the reader forward. A real Chromium reproduction moved `scrollTop` from
3592 to 5207 when 1615 pixels of answer text arrived. With the corrected boundary,
the same update keeps `scrollTop` at 3592. Fully preceding rows still receive
compensation, and the existing bottom-following behavior remains available.

The bounded thinking body follows incoming reasoning before paint. Scrolling up
inside it releases that following; returning to its bottom resumes it. Wheel
input belonging to an overflowing thinking body stays within that pane, so it
does not change the transcript's following state. A body without overflow still
allows the transcript to receive the input.

`desktop/scripts/test-chat-thinking-scroll.cjs` renders the real transcript,
message components, Markdown and application CSS with deterministic local
stream fixtures. Its eight checks cover a growing active answer, another thinking
update, initial reasoning alignment, reading earlier reasoning, resumed following,
painted-frame stability, thinking/answer/completion transitions, and a 390px
window. Results and screenshots are saved under
`.somniq/runtime/chat-thinking-scroll/`; the original failing reproduction is in
`.somniq/runtime/chat-thinking-scroll-before/`. Browser module and executable paths
can be provided with `SOMNIQ_BROWSER_TEST_NODE_MODULES` and
`SOMNIQ_BROWSER_TEST_EXECUTABLE`; `SOMNIQ_THINKING_SCROLL_OUTPUT` overrides the
artifact directory.

Validation also includes 109 focused Vitest checks, TypeScript checking, a
production frontend build, and the eight existing opening/history/bottom-alignment
browser checks in `desktop/scripts/test-chat-scroll.cjs`. The bounded streaming
capture observed 37 frames with zero page drift and zero inner bottom gap. These
checks use Chromium fixtures without model requests; an installed Tauri/WebView2
build and a new desktop installer have not been tested or produced.
