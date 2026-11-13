---
name: somniq-plugin-development
description: Use when the user asks to create, change, fix, review or explain a SomniQ plugin or plugin package, including a Chat sidebar panel or dashboard (tables, metrics, charts, forms and buttons the agent fills), a page with its own custom design or interaction (kanban, timeline, canvas, drag and drop), a reusable project skill shipped as a plugin, or wrapping a script or local service as an MCP tool the agent can call (做插件, 插件包, 侧栏面板, 把脚本包成工具, MCP 工具).
argument-hint: [what the plugin should do]
allowed-tools: PluginManager, PluginPanel, read_file, write_file, edit_file, glob_search, bash
---

# SomniQ plugins

A SomniQ plugin is a local package directory: `package.json` plus the files it
declares. It can contribute three things, alone or together:

| The user wants | Contribution | Template |
| --- | --- | --- |
| Something visible beside the chat: a checklist, notes, the agent's plan | `somniq.ui` panel in the Chat sidebar | `chat-panel` |
| A board of results the agent keeps current: tables, metrics, charts, lists, Markdown, progress, with buttons and forms that start work | `somniq.ui` panel, `schemaVersion` 2 | `data-panel` |
| Anything with its own look or interaction: a custom layout or visual style, a timeline, a canvas, a dashboard with charts, drag and drop, filtering, animation, as a page or a sidebar tab | `somniq.ui` panel with a `page`, `schemaVersion` 3 | `page-panel` |
| Tasks, a to-do list or a planner with real views (list, board, calendar, timeline) and a glance in the Chat's project summary | `somniq.ui` page + `chat.brief` glance sharing one store, `schemaVersion` 3 | `todo-workspace` |
| A small always-visible summary (progress, counts, the next few items) at the top of the Chat's project summary | `somniq.ui` panel in `chat.brief`, `schemaVersion` 3 | `todo-workspace` (its glance) |
| Instructions the agent should follow for a recurring task | Skills from a `dsh-skill-filesystem` row | `skill-pack` |
| A new action the agent can run: a script, a local service, a calculation | stdio MCP server from a `dsh-mcp-client` row | `mcp-stdio-python` |

What a package cannot do: run its own HTML, CSS or JavaScript anywhere except
a panel's `page` (sandboxed, below), add UI anywhere except the Chat
sidebar, the Chat's project summary and a page in the navigation rail, bring
its own rail icon image, load
anything from the network into a page, or connect to an HTTP MCP server. If the request needs one of these, say so and offer the closest
supported version.

## Panels: the package draws, you fill

A panel is declared, never programmed. `ui.json` names the widgets; SomniQ
draws them; the content of the data widgets comes from you, through the
`PluginPanel` tool, as ordinary data.

- **Where it appears.** `"slot": "chat.sidebar"` is a tab beside the
  conversation. `"slot": "nav.page"` gives the panel an icon in the app's
  navigation rail and a full page laid out in columns, the right choice when
  the user asks for "an app", "a page" or "a dashboard" of its own. A page
  must set `"scope": "project"`, may set `"icon"` to one of the names
  `inspect` lists (the package cannot ship an image), and cannot hold an
  `agent-plan` widget. Its buttons and forms take the user back to Chat with
  the prompt in the composer. The rail shows a project's first three pages
  and lists the rest under More, so prefer one page with several widgets to
  several pages. To turn the `data-panel` template into a page, change its
  `slot` and add an `icon`.
- **A glance in the project summary.** `"slot": "chat.brief"`
  (`schemaVersion` 3) puts a small card at the top of the project summary
  beside the chat, about 280-340 px wide, for what the user wants to see at
  all times: progress, counts, the next two to four items, a quick-add field.
  It must set `"scope": "project"` and takes only small widgets (`text`,
  `metrics`, `progress`, `list`, `markdown`, `button`, `todo-list`, `json`),
  or a `page`. The user can fold it. Keep it short: it shares the summary with
  the project's goal and status.
- **Scope.** `"scope": "session"` (default) keeps one copy per conversation;
  `"scope": "project"` keeps one board every conversation of the project
  shares, which is what a results board or experiment tracker wants.
- **Widgets you fill** (`table`, `metrics`, `list`, `markdown`, `progress`,
  `chart`; also `todo-list` and `notes`, which the user edits too): call
  `PluginPanel` `{"action": "list"}` for each widget's exact `value` shape,
  then `{"action": "write", "plugin", "panel", "widget", "value"}`. A write
  replaces that widget's whole value; `read` first to change part of it. Values
  outside the shape are refused, and nothing in them is executed: Markdown is
  rendered as Markdown, list entries open a project file (`path`) or an http(s)
  link (`url`).
- **Widgets that act** (`button`, `form`): each has one action. `prompt` puts
  its `text` in the user's composer, with a form's `{{field-key}}` values
  filled in (a checkbox becomes yes/no); `"send": true` also sends it when the
  composer was empty. `open-file` opens a project-relative file beside the
  chat. That is the whole list: a click never runs a tool or a command by
  itself. To make a button "do" something, write the prompt that asks you to
  do it, e.g. "Re-read results/ and update the Experiment board panel".
- A panel is empty until someone fills it. After the user enables a new data
  panel, fill it in the verification turn with real content from the project,
  or tell the user it will fill when they press its button. Never invent
  numbers to make a board look complete.
- Writing panel data needs no approval card and works in unattended runs, so
  a scheduled task can keep a project board current. Declaring or changing
  the panel itself is a package change and follows the workflow below.

## Pages that draw themselves

When the user wants a panel with its own look or interaction, and not the
host's column of cards, give it a `page`: an `.html` file of the package that
draws everything. The page owns the whole area: layout, typography, colors,
motion and interaction are yours to design. Nothing about the host's widgets
applies. `nav.page` gives it a full page; `chat.sidebar` gives it a narrow
tab beside the conversation (design for about 320-480 px wide). Start from
the `page-panel` template; `examples/plugins/page-gallery` in the SomniQ
repository shows three pages with nothing in common (an editorial timeline,
a pannable idea canvas, a chart dashboard built from modules).

- **Split it into files as you like.** The page may link other files of the
  package by relative path, and SomniQ puts them in before the page loads:
  `<link rel="stylesheet" href="style.css">` (with its `@import` and `url()`),
  `<script src="app.js">`, `<img src="img/x.png">`, `srcset`, `poster`, CSS
  fonts. Vendor any library you need (a chart library, D3, a Markdown
  renderer) as a file in the package and link it the same way; there is no
  CDN and no `npm install`. ES modules use `.mjs` files and import each other
  by `pkg:` + package-relative path, e.g.
  `import { draw } from "pkg:ui/lib/chart.mjs"`, and the page loads its
  entry with `<script type="module" src="main.mjs">`; relative module imports
  (`./x.mjs`) do not resolve. Script reads other files with
  `somniq.asset(path)` (a `data:` URL for an image, font or media) and
  `somniq.text(path)` (the text of a JSON, CSV or Markdown file), path
  relative to the page. All of these files together may be up to 12 MiB.
- **Nothing comes from the network.** The page runs in a sandboxed frame:
  `fetch`, remote images, fonts and scripts, sockets and navigation all
  silently fail, and `localStorage` throws. Write plain modern JavaScript;
  there is no build step.
- **Data lives in the panel's widgets.** Declare one or more `json` widgets
  (any JSON you choose, up to 256 KB each) and document their shape in a
  comment at the top of the page, because you fill them later with
  `PluginPanel` exactly like any other widget. A page may also declare
  `todo-list`, `notes` or the data widgets and read them the same way.
- **The page talks to SomniQ only through `window.somniq`:**
  `await somniq.ready()` gives `{ language, theme, data }`;
  `await somniq.set(widgetId, value)` saves (it rejects with the reason when
  the value does not fit the widget, so show that to the user);
  `somniq.onData(fn)` is called when you or another view change the data, so
  the page updates live; `somniq.prompt(text)` puts text in the Chat composer
  (the user sends it: a page never sends a message or runs a tool);
  `somniq.openFile(path)` opens a project file beside the chat;
  `somniq.openPanel(panelId)` opens a `nav.page` panel of the same package;
  `somniq.resize(px)` sets a `chat.brief` glance's height (40-320 px; call it
  from a `ResizeObserver` on `<body>` so the glance is exactly as tall as its
  content).
- **One store, several views.** A page panel may set
  `"dataPanel": "<id of another panel of this package>"` (same scope) and
  declare no widgets: its page then reads and writes that panel's widgets.
  This is how a full page and its glance in the summary show the same tasks;
  a save in one reaches the other through `onData`. When you fill such a
  panel with `PluginPanel`, write to the panel that owns the widgets (the one
  `list` shows with widgets, not the one with `dataPanel`). Put shared code
  (the data model, copy, formatting) in a `.mjs` module both pages import.
- **Theme: blend in or stand out, but handle both modes.** The app's
  colors arrive as CSS variables on `<html>` (`--somniq-bg`,
  `--somniq-surface`, `--somniq-raised`, `--somniq-border`, `--somniq-text`,
  `--somniq-muted`, `--somniq-accent`, `--somniq-font`) with
  `data-theme="light"` or `"dark"`. A page that should feel native uses
  them; a page with its own identity may use its own palette and fonts, as
  long as it defines a light and a dark variant keyed on `data-theme`. Write
  both `en` and `cn` text and pick by `language`.
- **Treat stored data as untrusted.** Build DOM with `textContent` and
  `createElement`, never `innerHTML` with widget values, and tolerate missing
  or malformed entries: the data outlives versions of the page.
- **Design it, deliberately.** Match the design to what the user asked for
  rather than defaulting to a grid of cards: decide the layout, type scale,
  palette and the one interaction that matters most, then build that. Give
  it a clear hierarchy, real spacing, an empty state, keyboard focus styles,
  and a layout that still works at 700 px wide (320 px in the sidebar). You cannot see the
  page: say so, and ask the user to tell you what to adjust.
- The approval card tells the user this panel runs the package's own page
  code. Changing the page is a package change: raise the version and upgrade.

## Who does what

You write, check and install the package. **Only the user approves it**: a
package runs only after they click approve on the card `request_enable`
shows. Nothing you write in the workspace makes a package run, and you cannot
approve one. Never write into `.somniq/plugins/` or the SomniQ config
directory, never try to install by other means than `PluginManager`, and never
tell the user a plugin is enabled until a tool result says so.

Every change-making result has an `application` field. Act on it, not on
guesses: `none` changed nothing that runs; `next-turn` means approved (or
disabled, removed) and it applies from the next turn; `rejected` means the user
declined; `blocked` means diagnostics stop it from being enabled.

## Workflow

Deliver one small working version first; refine after the user has it.

1. **Decide the result.** Pick the contribution(s) from the table. An
   unspecified visual request means a Chat sidebar panel. Choose sensible
   names, titles and widgets yourself instead of asking.
2. **Read the rules once.** Call `PluginManager` with `{"action": "inspect"}`.
   It returns the exact limits, accepted fields, slots, widget types and the
   built-in skill names you must not reuse. Do not guess them.
3. **Start from a template.** Call `{"action": "template", "template": "<id>"}`
   and write every returned file with `write_file` under
   `.somniq/plugin-drafts/<short-name>/` (or the directory the user names).
   Then make it the user's plugin: a package name like `@local/<short-name>`,
   a real description, ids, and titles and text in both `en` and `cn`. Never
   leave template wording in a delivered package. To combine contributions,
   merge the templates' `package.json` fields and patch rows into one package.
4. **For an MCP server**, write the tools in `server.py` with the standard
   library unless the user agrees to install packages. Never print to stdout
   except protocol replies; put no secrets in the package (env values are
   stored as plain text). Check the server before previewing:
   `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python server.py`
   (`python3` on macOS/Linux) must print one JSON line listing your tools.
5. **Preview until clean.** Call
   `{"action": "preview", "source": ".somniq/plugin-drafts/<short-name>"}`.
   Fix every diagnostic: each has `file`, `path` and a `hint`. Repeat until
   `canEnable` is true and `diagnostics` is empty. If the result has an
   `upgrade` field, a package with this name is already installed: raise
   `version`, read the capability diff, and use step 8 instead of installing.
6. **Install and ask.** Call `{"action": "install", "source": "<draft>",
   "digest": "<digest from that preview>"}`; it installs disabled. Then call
   `{"action": "request_enable", "name": "<package name>"}`. Before that call,
   tell the user in one or two sentences what the plugin adds and, for MCP,
   the command it will run: the card shows the same facts, and they decide on
   it. The call waits for their click.
7. **After the decision.** On `next-turn`, end this turn: tell the user it is
   approved and what to check (new tools and skills are attached when a turn
   starts, so they are not callable yet). SomniQ then starts one verification
   turn by itself, shown as "插件已启用，继续验证"; do not ask the user to say
   "continue". In that turn, call `{"action": "list"}` and confirm the
   package's `lifecycle.state` is `enabled` or `running`, then use it the way
   the user will: call the new `mcp__…` tool; load the skill with the Skill
   tool; for a panel, fill its data widgets with `PluginPanel` (a successful
   `write` is the proof the panel accepts them) and tell them where it is: under the
   Chat sidebar's plugin button, or for a `nav.page` panel its icon in the
   left navigation rail (you cannot see the screen, so say that you
   could not check it visually).
   `check_mcp` reports MCP health without a turn boundary when the session has
   full access. `PluginManager` results are the authority on plugin state:
   never read SomniQ's configuration, plugin store or session files (such as
   `~/.config/SomniQ`) to verify a plugin, and never open other conversations. On `rejected`, do not ask again in the same turn; ask what to
   change. Report what worked, what you could not verify, and where the draft is.
8. **Fix in place.** Repair problems in the same draft directory, raise the
   version, preview again and call `{"action": "upgrade", "source": "<draft>",
   "digest": "<new digest>"}`. If the installed version is running, the user
   approves the upgrade on a card and the new version replaces it from the
   next turn; if it is stopped, the upgrade installs disabled and you call
   `request_enable`. Do not create a second package under a new name, and do
   not build HTML previews, mock-ups or variants instead of the package itself.

`disable` turns a package off without a card; `remove` asks the user to
confirm. In a work task, scheduled run or review workflow, and in Plan mode,
only `inspect`, `template`, `preview`, `list` and `check_mcp` work: describe
the change and leave it for an interactive chat.

## Changing a plugin the user already has

Users redesign their plugins by asking, often from the "改这个界面 / Change
this view" button, which drafts a message naming the plugin, the panel and
where it is. Treat it as a change to that installed package, never as a new
plugin:

1. **Start from what runs.** Call `{"action": "checkout", "name": "<package>"}`.
   It writes the installed files into `.somniq/plugin-drafts/<short-name>/`
   and lists them. `unchanged` means the draft already is the installed
   version; `exists` means the draft holds other edits: if they are yours
   from this conversation keep going, otherwise call checkout again with
   `"replace": true` (the old draft is moved aside, not deleted). Never
   rebuild the plugin from a template to change it.
2. **Change what was asked, keep the rest.** Read the files you will change
   before editing them. Keep the panel ids, the widget ids and the shape of
   the data the user already has, so their tasks, notes and boards survive.
   If a new design needs another shape, read the data from the old shape in
   the page (tolerate both) rather than dropping it. Make the visual change
   real: a new layout, type, palette or interaction, not a recolor, when
   that is what was asked.
3. **Raise the version, preview until clean, then `upgrade`.** On the card
   the user can try every new page with their real data (nothing they do
   there is saved) and read each changed file line by line before they
   approve. Tell them in one sentence what you changed and that they can try
   it on the card.
4. **Going back is theirs.** Every upgrade keeps the version it replaced.
   The Plugins page lists earlier versions with the original marked, and the
   user can return to any of them. If they say the old one was better, point
   them there, or check out again and change it the way they want.

## Reviewing a plugin

When the user asks to review or explain a package rather than build one,
preview it and report the diagnostics and what it would run (skills, panels,
MCP command lines and environment variable names). Do not edit files unless
asked.
