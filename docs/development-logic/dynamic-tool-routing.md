# Dynamic tool routing

Ordinary Desktop Chat keeps a complete executable tool catalog but sends only
a bounded, task-relevant schema projection to the model. This reduces repeated
request-prefix cost without changing what the permission system authorizes.

## Invariants

- Routing controls model visibility only. The full tool catalog remains the
  source for execution and permission checks.
- Autonomous workflow stages keep their existing explicit allowlists and do
  not use dynamic routing.
- `ToolSearch` is always part of the core projection and is never evicted.
  Matches from the full chat catalog are activated before the next provider
  request in the same turn.
- Unknown names returned by a tool are ignored; routing can activate only names
  that were present in the turn's original catalog.
- No tool is statically excluded from the search corpus. Visibility is decided
  per turn, so a permanent exclusion list would make exactly the routed-away
  core tools (`write_file`, `edit_file`, …) unrecoverable.
- Every initial decision is written to the wire trace as `tool.routing`.
  Provider `llm.tools_snapshot` events record the schemas actually sent.

## Rollout and rollback

`ARIS_DYNAMIC_TOOL_ROUTING` is resolved once when the process starts:

- `on` (default): send the routed subset and allow ToolSearch expansion.
- `shadow`: compute and trace the proposed subset, but send the full catalog.
- `off`: retain the legacy full-catalog behavior.

The initial active set is capped at 20 tools when the catalog is larger than
that. It always includes core file/search/continuity tools and adds profiles for
code changes, browser/UI work, research, web retrieval, compute, media, mail,
and explicit agent/skill or Oracle requests.

## Budget

Two separate bounds:

- **20** schema slots in the first request of a turn.
- **24** live tools at any point in the turn, including everything `ToolSearch`
  activates afterwards. The headroom lets one search land a whole capability
  family before anything has to be evicted.

Allocation order inside the initial 20: pinned core → tools the prompt names
outright → the *required* bundle of every matched intent → the secondary core
set → optional extras round-robin across intents. Required-before-optional is
what keeps a mixed request ("fix the UI, then verify in the browser") from
having its second half starved by the first.

Each intent declares what it cannot execute without:

| intent | required |
| --- | --- |
| create a file | `write_file` |
| modify a file | `read_file`, `edit_file`, `multi_edit` |
| multi-file investigation | `read_files`, `glob_search`, `grep_search` |
| browser acceptance | `*browser_navigate`, `*browser_snapshot`, `*browser_click`, `*browser_evaluate` |

## Eviction

Past 24 live tools, the conversation runtime evicts by least-recent use. Pinned
tools (core plus anything the prompt named or the matched intents require) and
tools activated by the call currently running are never victims, so the cap can
be briefly exceeded rather than discarding what the model just asked for.

Eviction removes a schema, never an authorization: an evicted tool is still
executable, and calling it re-activates it.

## Search

`ToolSearch` ranks by tier — exact name, then name substring, then description —
so a tool named outright always outranks one that merely mentions it in its
description. Underscore normalization is a fuzzy aid for spelling variants and
cannot displace an exact match. MCP tools match on their trailing segment, so
`browser_click` finds `mcp__playwright__browser_click`.

The kernel catalog and the discovered MCP tools are ranked as one list rather
than concatenated and truncated. A `select:name_a,name_b,…` list is honored in
order and is not truncated below what it asked for, and a capability keyword
returns the whole family, so one call covers a step instead of one call per
tool.

## Observability

The `tool.routing` event records the mode, selected profile, catalog size,
active/deferred/pinned sets, the hard cap, and routing reasons — including when
a browser intent matched but MCP discovery produced no browser tool. A
successful `ToolSearch` result contains `activated`, `active_tool_count`, any
`deactivated` names, and `pending_mcp_servers` for configured servers that
produced no tools this turn.
