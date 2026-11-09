# Windows shell contract

The `bash` tool previously fell back to `cmd /C` when no usable POSIX shell
was detected. This changed the command language without telling the model:
POSIX variables, quoting, pipelines, and utilities could fail or behave differently.

The shared runtime now returns a pre-execution error instead. Both foreground
and background launches use the same fallible command preparation. The error
directs the caller to the `PowerShell` tool or installing Git Bash; it never
automatically translates or replays a command in a different interpreter.

Windows environment context and tool descriptions prefer `PowerShell` and
explain that it runs pwsh or Windows PowerShell, independently of the parent
terminal. Commands should remain compatible with Windows PowerShell when the
version is unknown (no `&&`/`||`; explicitly check exit codes for dependencies).
An explicit user shell preference takes priority.

Regression coverage includes missing POSIX shell selection, preserving an
available interpreter, Windows-only environment guidance, tool descriptions,
and existing foreground/background shell execution tests. This change applies
to the shared Desktop/CLI runtime; it does not change the embedded editor's
interactive terminal or internal commands that deliberately invoke CMD.
