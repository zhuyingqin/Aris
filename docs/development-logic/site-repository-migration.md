# Site repository extraction

The full `site/` directory and `deploy/newapi/` moved to `F:/Agent/Site`.
Repository: https://github.com/zhuyingqin/SomniQ-Site (private).
The new repository retains `site/` as its application directory.
The New API compatibility workflow moved with those services.

Desktop and shared Rust crates remain in Aris. `remote-protocol` is consumed
by the extracted gateway through a pinned Git revision. Desktop releases stay
in Aris; the site repository owns website builds and deployment tooling.
Existing historical site documents describe paths in the new repository.

A pre-migration source snapshot and working-tree patch were saved locally in
`.codex/site-migration/`. No unrelated desktop changes were committed by this migration.
