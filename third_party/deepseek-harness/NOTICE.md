# DeepSeek Harness reuse

Source: https://github.com/deepseek-ai/deepseek-harness

Pinned revision: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (0.2.2-rc.1).

`crates/runtime/src/plugins/dsh.rs` adapts the `applyPatches` configuration
composition algorithm in `vendor/include/src/patch.ts` into Rust. This retains
ordered root/group insertions, depth-first id lookup, name-qualified overrides
and whole-field replacement. Unlike the upstream warning-and-continue host,
SomniQ blocks activation when a patch has an unresolved target or name mismatch.
It does not implement Cordis module loading, expression evaluation or lifecycle
services. The full upstream frontend is not bundled.

`desktop/src/extensions/uiSlots.ts` adapts the declared list-slot subset of
`packages/client/ui-slots/src/index.ts::SlotCore.register` / `entriesOfSlot`:
host-owned declaration, duplicate id rejection, stable order, and idempotent
disposal. This is a reduced data-descriptor adapter, not the full DSH slot
engine, component factories or React renderer. SomniQ owns rendering and local
state actions; `somniq.ui` is a SomniQ-specific manifest extension. DSH client
JavaScript entry points still require the DeepSeek frontend host.

`desktop/src/extensions/ChatPluginPanel.tsx` and its CSS adapt the compact
disclosure layout and per-status summary logic from
`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx` / its CSS
and the icon/title/summary disclosure pattern from
`packages/client/ui-primitives/src/DisclosureRow.tsx`. Hover/focus-only row
actions follow `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`.
The adaptation uses native buttons, SomniQ icons and theme tokens, retains
hidden drafts, groups completed personal todos and reads the existing SomniQ
agent plan. It does not include the upstream Cordis/store/locale dependencies.

The manifest contract follows `packages/util/package-manifest/src/types.ts`;
patch file ordering follows `bundlePatchFiles` / `composeEntries` in
`packages/boot/app-boot/src/profile.ts`. Capability adapters follow the static
configuration contracts of `@deepseek-ai/dsh-skill-filesystem` and
`@deepseek-ai/dsh-mcp-client`. This is a configuration-only compatibility subset,
not a DeepSeek host or general plugin runtime.

Copyright (c) 2026 DeepSeek. MIT License.
The adapted Cordis include code is Copyright (c) 2021-present Shigma. MIT License.

Full license notices ship with desktop resources:

- `desktop/src-tauri/resources/licenses/deepseek-harness-MIT.txt`
- `desktop/src-tauri/resources/licenses/cordis-include-MIT.txt`
