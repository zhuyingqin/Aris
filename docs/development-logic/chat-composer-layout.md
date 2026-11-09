# Chat composer layout stability

The composer toolbar uses the input card's inline size to choose its layout.
A split pane can be narrow even when the application window is wide, so viewport
breakpoints cannot determine whether the controls fit. Previously, the left
group's content size and wrapping competed with the model/context/action group.
Changing labels could add a toolbar row and resize the composer.

`ChatComposerLayout.css` owns the toolbar's flex sizing and named
`chat-composer` container queries. Model styling no longer supplies competing
toolbar layout rules. The model selector shrinks and truncates its name while
the context meter and send/stop button retain their sizes.

- Above 40rem, the toolbar uses one row with a truncating Git branch label.
- Between 28rem and 40rem, Git uses a compact icon entry to make space for the
  model. Its existing title, accessible name and menu preserve the full label.
- At or below 28rem, the two groups each occupy a full row. The second row puts
  context on the left and the model/action controls on the right. Label changes
  cannot introduce another row. At exactly 28rem, the two-row rule takes priority.

At the reproduced 504px card width, the toolbar changes from 72.84px/two rows to
32.14px/one row, and card height changes from 137.25px to 96.55px. Changing context
from 0% through 100% or selecting a long model name preserves that height.

`desktop/scripts/test-chat-composer-layout.cjs` renders the real composer and
application CSS in Chromium with deterministic local props. It records 11
scenarios covering the screenshot state, context changes, long labels, Chinese,
English, dark theme, narrow panes and larger text. It also checks 32 combinations
of eight pane widths and four root font sizes. The checks assert control
containment, stable height across label changes, a square action button, and
working model/Git/permission menus plus send/stop callbacks.

Run from `desktop/` with `node scripts/test-chat-composer-layout.cjs`. Optional
`SOMNIQ_BROWSER_TEST_NODE_MODULES` and `SOMNIQ_BROWSER_TEST_EXECUTABLE` select the
Playwright module directory and Chromium executable;
`SOMNIQ_COMPOSER_LAYOUT_OUTPUT` selects the artifact directory. The default is
`.somniq/runtime/chat-composer-layout/`, with verification, geometry and
screenshots. The original failing geometry and screenshot are preserved in
`.somniq/runtime/chat-composer-layout-before/`.

Validation includes 57 focused composer/reasoning Vitest tests, TypeScript
checking and a production frontend build. The browser fixture makes no model
requests. An installed Tauri/WebView2 build was not exercised and no installer
was rebuilt.
