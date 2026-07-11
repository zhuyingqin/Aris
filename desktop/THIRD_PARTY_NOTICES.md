# Third-Party Notices

SomniQ Studio's shared editor kernel (`desktop/src/editor/`) and the Code/Typeset
surfaces built on it use the following third-party packages. All are MIT
licensed and used unmodified as npm dependencies (no vendored/forked source).

Copyright (C) 2018 by Marijn Haverbeke `<marijn@haverbeke.berlin>` and others,
for every `@codemirror/*` and `@lezer/*` package listed below, unless noted
otherwise. Full license text: https://opensource.org/licenses/MIT

| Package | Version | Repository |
| --- | --- | --- |
| `@codemirror/autocomplete` | 6.20.3 | https://github.com/codemirror/autocomplete |
| `@codemirror/commands` | 6.10.4 | https://github.com/codemirror/commands |
| `@codemirror/lang-css` | 6.3.1 | https://github.com/codemirror/lang-css |
| `@codemirror/lang-html` | 6.4.11 | https://github.com/codemirror/lang-html |
| `@codemirror/lang-javascript` | 6.2.5 | https://github.com/codemirror/lang-javascript |
| `@codemirror/lang-json` | 6.0.2 | https://github.com/codemirror/lang-json |
| `@codemirror/lang-markdown` | 6.5.0 | https://github.com/codemirror/lang-markdown |
| `@codemirror/lang-python` | 6.2.1 | https://github.com/codemirror/lang-python |
| `@codemirror/lang-rust` | 6.0.2 | https://github.com/codemirror/lang-rust |
| `@codemirror/lang-sql` | 6.10.0 | https://github.com/codemirror/lang-sql |
| `@codemirror/lang-yaml` | 6.1.3 | https://github.com/codemirror/lang-yaml |
| `@codemirror/language` | 6.12.4 | https://github.com/codemirror/language |
| `@codemirror/legacy-modes` | 6.5.3 | https://github.com/codemirror/legacy-modes |
| `@codemirror/search` | 6.7.1 | https://github.com/codemirror/search |
| `@codemirror/state` | 6.7.1 | https://github.com/codemirror/state |
| `@codemirror/view` | 6.43.6 | https://github.com/codemirror/view |
| `@lezer/common` | 1.5.2 | https://github.com/lezer-parser/common |
| `@lezer/css` | 1.3.4 | https://github.com/lezer-parser/css |
| `@lezer/highlight` | 1.2.3 | https://github.com/lezer-parser/highlight |
| `@lezer/html` | 1.3.13 | https://github.com/lezer-parser/html |
| `@lezer/javascript` | 1.5.4 | https://github.com/lezer-parser/javascript |
| `@lezer/json` | 1.0.3 | https://github.com/lezer-parser/json |
| `@lezer/lr` | 1.4.10 | https://github.com/lezer-parser/lr |
| `@lezer/markdown` | 1.7.1 | https://github.com/lezer-parser/markdown |
| `@lezer/python` | 1.1.19 | https://github.com/lezer-parser/python |
| `@lezer/rust` | 1.0.2 | https://github.com/lezer-parser/rust |
| `@lezer/yaml` | 1.0.4 | https://github.com/lezer-parser/yaml |

`@codemirror/legacy-modes` supplies MATLAB (`mode/octave`), LaTeX
(`mode/stex`), Bash (`mode/shell`), PowerShell (`mode/powershell`), and INI
(`mode/properties`) tokenizing for languages without a dedicated
`@codemirror/lang-*` package — these are CodeMirror 5 modes ported by the
CodeMirror project itself, under the same license and copyright as above.
