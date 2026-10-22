# Chat reopening and bottom alignment

Goal: opening or returning to Chat shows the latest message after history and
the viewport are ready. Once the reader scrolls into history, message updates
preserve their reading position.

The main Chat pane stays mounted while other product pages are visible. Its
transcript therefore receives an explicit `visible` flag; a session-only landing
guard cannot detect a return to the same conversation. Embedded Chat uses its
host surface and checks actual viewport dimensions.

`ChatThread` resets the landing guard when the session or visibility changes.
The landing waits for loaded turns, an animation frame, and nonzero viewport
dimensions. A temporary ResizeObserver retries when a hidden layout becomes
available. Hidden widths do not invalidate transcript height estimates.

Row measurements may grow the virtual list before React commits its new height.
Immediate scroll compensation can be clamped to the previous DOM maximum and
lose the composer inset. While following, a layout effect aligns the final row
after that height commits. Upward reader input releases following and supersedes
the programmatic-scroll grace period and any pending virtualizer target.

Validation: focused Chat Vitest tests, TypeScript checking, and desktop production
build. `desktop/scripts/test-chat-scroll.cjs` exercises the real virtualizer in
headless Chromium with 80 variable-height message fixtures: hidden-page return,
async history restoration, delayed layout, row growth, remounting, and real wheel
input followed by new messages. It checks zero bottom gap, preserved reader
position, and no accidental earlier-history loads. Browser paths can be provided
through `SOMNIQ_BROWSER_TEST_NODE_MODULES` and `SOMNIQ_BROWSER_TEST_EXECUTABLE`.
This fixture does not exercise an installed Tauri/WebView2 build.
