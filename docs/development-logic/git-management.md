# Desktop Git management

SomniQ's Git surface is a local project workbench, not a second shell. It gives
the user a reviewable path from a working-tree change to a local commit while
keeping network and destructive actions outside the first delivery.

## First delivery

The Desktop module supports:

- Git availability and repository detection for the active registered project;
- current branch, local branches, upstream, and ahead/behind metadata;
- porcelain status parsing for staged, unstaged, untracked, renamed, and
  conflicted files;
- working-tree and staged textual diffs with a bounded UI payload;
- repository initialization, staging, unstaging, committing, and local branch
  creation/switching.

The React surface calls typed Tauri commands. The Rust boundary resolves the
active project from `ProjectState`; the frontend never supplies an arbitrary
workspace path. Git is launched directly with an argument vector, never through
a shell, and file operands use literal pathspecs plus repository-relative path
validation.

## Safety boundary

The first delivery intentionally excludes:

- `discard`, `reset --hard`, cleaning, or file deletion;
- `fetch`, `pull`, `push`, remote creation, or credential handling;
- automatic commits or branch switches initiated by an agent.

Commit and checkout hooks remain normal repository-owned Git behavior and only
run after the user explicitly invokes the corresponding action. A later remote
phase should show the exact remote/ref operation, require explicit confirmation,
and record the result in the local audit trail. Destructive worktree actions
should additionally preview affected paths and provide a recoverable strategy
where Git permits one.
