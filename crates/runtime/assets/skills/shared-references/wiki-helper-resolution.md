# Wiki helper resolution chain

Canonical resolution chain for the research-wiki helper. Used by every
SKILL that touches the wiki — never hard-code `python3 tools/research_wiki.py`,
because a paper project almost never has a `tools/` directory on disk. That
is exactly the failure mode that left a real user's `research-wiki/` empty
for a week.

## The chain

```bash
WIKI_SCRIPT=""
for candidate in "$HOME/.config/SomniQ/tools/research_wiki.py" "${ARIS_CACHE_DIR:-.}/tools/research_wiki.py" "tools/research_wiki.py"; do
  [ -f "$candidate" ] && { WIKI_SCRIPT="$candidate"; break; }
done
```

After the chain runs, exactly one of two outcomes:

- `[ -f "$WIKI_SCRIPT" ]` → helper located, use as `python3 "$WIKI_SCRIPT" <subcommand>`
- `[ ! -f "$WIKI_SCRIPT" ]` → helper missing; pick a variant below

## Variant A — hard-fail (for `/research-wiki` itself)

The skill **is** the wiki tool. If the helper is missing, fail loudly.

```bash
[ -n "$WIKI_SCRIPT" ] || {
  echo "ERROR: research_wiki.py not found. Checked ~/.config/SomniQ/tools/, \$ARIS_CACHE_DIR/tools/, and ./tools/." >&2
  echo "       Fix: reinstall SomniQ so the bundled helpers extract, or drop a copy at ~/.config/SomniQ/tools/research_wiki.py." >&2
  exit 1
}
```

## Variant B — warn + skip (for caller skills)

Used by `/idea-creator`, `/result-to-claim`, `/research-lit`, `/arxiv`,
`/openalex`, `/literature-search`. The
skill's primary output (idea ranking, claim verdict, paper summary)
must still be delivered to the user; only the wiki side-effect is
skipped.

```bash
[ -n "$WIKI_SCRIPT" ] || {
  echo "WARN: research_wiki.py not found. Checked ~/.config/SomniQ/tools/, \$ARIS_CACHE_DIR/tools/, and ./tools/." >&2
  echo "      Primary output will still be produced; wiki update is skipped." >&2
  echo "      Fix: reinstall SomniQ so the bundled helpers extract, or drop a copy at ~/.config/SomniQ/tools/research_wiki.py." >&2
  WIKI_SCRIPT=""
}
```

After Variant B, every helper invocation must be guarded:

```bash
[ -n "$WIKI_SCRIPT" ] && python3 "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$id"
```

## Why three locations and not one

Each layer covers a distinct, legitimate situation:

| Location | When applicable |
|---|---|
| `~/.config/SomniQ/tools/research_wiki.py` | The user dropped in their own copy to shadow the bundled one — wins so a local patch survives an app update |
| `$ARIS_CACHE_DIR/tools/research_wiki.py` | The copy SomniQ extracts from its own bundle at startup. Present in any normal install; this is the layer that actually fires |
| `tools/research_wiki.py` | Project-local copy, or running a SKILL from inside a repo that vendors the helper |

Order matters: the override wins so a user can patch a helper without
rebuilding; the bundled cache is the reliable default; the project-local
copy is last because it is the easiest to leave stale.

## What NOT to add

- ❌ A layer that searches up the directory tree for `tools/` — too much
  path magic, surprising failure modes.
- ❌ A layer at `~/.local/share/aris/...` or `/usr/local/share/...` — no
  installer precedent.

If a fourth layer is genuinely needed in the future, add an explicit
env var (`ARIS_WIKI_SCRIPT=<path>`) rather than another implicit
location.

## Strict-mode safety

The chain above is safe under `set -e` and `set -u`: it only runs `[ -f ]`
tests, assigns literals, and initialises `WIKI_SCRIPT=""` before the loop.
There is no command substitution whose exit code could trip `set -e`.

(The previous chain was not safe — it read the install manifest with
`${ARIS_REPO:-$(awk ...)}`, and `awk` returns non-zero when its input file
is missing, which was the common case. Under `set -e` the block exited
silently before reaching any `[ -f ]` test. That construct is gone.)

## See also

- [`integration-contract.md`](integration-contract.md) §2 — canonical-helper invariant
- `skills/research-wiki/SKILL.md` — the wiki tool itself; uses Variant A
