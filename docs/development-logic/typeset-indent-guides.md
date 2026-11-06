# LaTeX source indentation guides

The LaTeX source canvas uses the app's CSS theme while the shared CodeMirror
view can retain its default light facet. The indentation-marker extension then
resolved its light colours on a dark canvas, producing near-white vertical
rules. The dedicated source editor now resolves the marker's inactive and
active colours from its own dark/light palette.

The extension also paints each marker over the full logical line height. A
wrapped line starts its continuation at the left edge, so those rules crossed
the continuation text. The LaTeX source editor limits the marker pseudo-element
to `1lh`, preserving guides in the first visual row's indentation and adapting
to the current line height. This CSS leaves document text and transactions
untouched.

Browser validation reproduced the bright rules crossing a deeply indented,
wrapped TikZ line. After the fix the 49.6px line has a 24.8px guide; at a larger
font the 102.3px line has a 34.1px guide. Dark and light palettes, live theme
switching and disabling/re-enabling guides were verified, with the source
unchanged. The existing Typeset CSS and shared editor suites passed 42 tests;
the desktop production build passed.
