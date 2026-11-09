# macOS input-method confirmation in Chat

The chat textarea previously treated every unshifted Enter as submission, before
checking input-method composition. The same key could also execute a slash
command or choose a skill/file suggestion. Confirming a Chinese IME candidate,
including a Latin word in mixed Chinese/English text, could therefore send the
draft before the user intended to submit it.

`useMacImeGuard` is enabled only when the existing platform detector identifies
macOS. It checks the composition lifecycle, native `isComposing`, and WebKit's
IME key code 229 before either picker or submit handling. WebKit may dispatch
`compositionend` before the confirming Enter with `isComposing=false`; a
zero-delay boundary covers that event turn. An Enter recognized as IME input
remains protected through repeats until keyup. A fresh non-repeating Enter also
clears the hold, so a missing keyup cannot block later submissions. Blur resets
the state, and the
temporary boundary is cleared on the next timer task, so a mouse/space commit
does not require an extra Enter later. No fixed typing-delay window is added.

IME keystrokes are left unprevented so the input method can commit text and
navigate candidates. A subsequent Enter sends normally, Shift+Enter retains
newline behavior, and clicking Send remains explicit submission. Windows follows
the original key handler without composition suppression or delayed submission.
The shared ChatComposer covers the main chat and its companion window.

Regression tests dispatch both common composition orderings, native-only IME
flags, repeats, picker shortcuts, blur, normal submission, and Windows behavior.
Browser event simulation validates the frontend handler; actual macOS IME and
WKWebView behavior must be distinguished from simulation on a Windows host.
