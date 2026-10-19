# Long user messages

Sent user text defaults to a ten-line preview. `UserMessageText` measures the
full content inside a clipped viewport and shows an expand/collapse button only
when that content exceeds ten rendered lines. A `ResizeObserver` updates the
decision after width or font changes, including narrow chat panes. The CSS limit
uses the same line count and the message's actual line height.

The full text remains in the turn and DOM. Copy and edit actions receive the
original text, while attachments stay outside the preview. Controls support
Chinese and English, keyboard activation, and `aria-expanded`/`aria-controls`.

Expansion uses the existing bounded disclosure cache, keyed by turn and block,
so virtualized rows retain the reader's choice when unmounted and restored.
`transcriptMetrics` estimates collapsed text using the same preview limit and
accounts for remembered expansion, avoiding full-text estimates for collapsed
prompts. Assistant output keeps its existing rendering.

Validation: 89 focused Vitest checks, TypeScript checking, a production frontend
build, and 12 Chromium checks passed. Browser checks cover the ten/eleven-line
boundary, full-text copy/edit, attachments, 390px wrapping, English controls,
and real virtualized scrolling. Evidence and screenshots are under
`.somniq/changes/chat-user-message-collapse-2026-10-16/`. The installed desktop
application was not repackaged or tested in WebView2.
