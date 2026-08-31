# ARIS-Code Changelog

## v0.4.59 (2026-09-02)

- **Literature search: shared SomniQ Research Gateway** — a SomniQ user
  can now search Bocha and Zhihu without configuring either one
  individually. `crates/tools/src/web.rs` adds the
  `SOMNIQ_RESEARCH_GATEWAY` enum variants (`SomniqGatewayBocha`,
  `SomniqGatewayZhihu`) that route through a shared proxy at
  `https://1312640372-g6j27ofl05.ap-hongkong.tencentscf.com`. The
  gateway owns the paid upstream credentials, so per-user key
  configuration for those two adapters becomes optional. Direct
  Bocha / Zhihu adapters stay for users who prefer to bring their
  own key. The same module carries the wider literature-search
  kernel rework that closes the 0.4.46 source-quality follow-ups.
- **Embedded VS Code runtime for the Code page** —
  `desktop/src-tauri/src/codeserver.rs` owns the runtime below the
  Code page: resolving, downloading, and verifying VSCodium
  (`reh-web`, MIT), launching the server on loopback, tearing it
  down. Three measured constraints: the iframe must address the
  server as `http://code.tauri.localhost:<port>` (a sibling like
  `aris-code.localhost` is a different site and the redirect-based
  `vscode-tkn` cookie would 403), the sub-domain label must not be
  `tauri` itself (wry routes anything matching `http://tauri.*` into
  Tauri's custom-protocol handler, so `http://code.tauri.localhost`
  is the only name that actually reaches us), and the server stays
  bound to loopback. New `tests/codeserver.rs` pins the constraints.
- **Research memory extractor + replay** —
  `crates/runtime/src/research_memory.rs` continues the schema
  work that the v0.4.46 freeze finally unblocked: typed atoms
  (preferences / decisions / constraints / experiment results /
  negative results / environment facts / methodological lessons /
  artifact pointers), episode cards consolidated from non-conflicting
  atoms, and a bounded project research constitution. The new
  `tests/research_memory.rs` (188 added lines) pins the extractor
  contract.
- **Chat side file viewer** — `desktop/src/chat/SideFileViewer.tsx`
  ships the file-view side panel the chat attachment surface points
  at: PDF / image / Markdown / text previews per attached file,
  project-root label, bilingual copy blocks, and the kind-aware
  renderer dispatch.
- **Auth login refresh** — `desktop/src/auth/login.css` (226
  added lines) and `desktop/src/auth/Login.tsx` ship the new login
  layout: language toggle, gateway-aware account-card, copy
  aligned with the v0.4.49 Account settings + v0.4.52 Language
  Choice surfaces.
- **Release workflow dependency** — `desktop/src-tauri/Cargo.toml`
  pins `rusqlite = { version = "0.32", features = ["bundled"] }`
  and the matching `Cargo.lock` to match the runtime SQLite used
  by the research-memory schema.

## v0.4.56 (2026-08-26)

- **Code workspace: embedded VS Code runtime** — the former Lab surface is
  replaced by an embedded VSCodium-based code workspace. Tauri now owns the
  local code-server lifecycle, browser preview, compute panel, and the
  `aris-code-bridge` extension used to connect notebook and assistant features
  back to the desktop runtime.
- **Runtime cleanup and skill catalog updates** — the legacy Lab/terminal
  surface and bundled TencentDB runtime are removed from the desktop bundle;
  the runtime skill registry and patent workflow assets are reorganized around
  the current local-first research workflow.
- **Desktop and site polish** — chat Markdown/file handling, profile/settings,
  Typeset, Image Assist, remote protocol, and landing-page copy receive the
  corresponding 0.4.56 integration updates with regression coverage.

## v0.4.55 (2026-08-25)

- **`LlmReview` is the default reviewer backend** — the system prompt
  now routes every "independent / external / cross-model review" request
  to SomniQ's `LlmReview` tool by default, which routes to the
  reviewer the user configured in Settings. Legacy skill text that
  names `mcp__codex__codex` or `mcp__codex__codex-reply` is treated as
  referring to the same reviewer backend; a Codex MCP tool is only used
  when it is actually present in the current tool list AND the user
  explicitly asked for that backend in this conversation. Removes the
  chance the model silently routes review work to an MCP backend the
  user did not ask for. `LlmReview` is single-shot: every call is
  self-contained, and multi-round reviews send a fresh prompt that
  restates the context.
- **Skills catalog refresh** — every bundled `SKILL.md` (65 files)
  is updated against the v0.4.55 kernel. Twenty-five skills are
  removed from the catalog: `comm-lit-review`, `exa-search`,
  `experiment-queue`, `feishu-notify`, `idea-discovery-robot`,
  `interview-cheatsheet`, `meta-optimize`, `paper-poster`,
  `pixel-art`, `qzcli`, `scopus-search`, `serverless-modal`,
  `system-profile`, the `openalex-search` family, and the
  `experiment-queue/scripts/` Python tools. Each removal matches the
  skills the project no longer uses in real research workflows; the
  kernel-side `crates/runtime/assets/skills/` registry is the source
  of truth, so removing a directory here is what stops it from
  surfacing in chat completions.
- **Chat retry notice** — new `desktop/src/chat/modelRetryNotice.ts`
  owns the retry state surface: whole-seconds countdown, attempt
  count, settled-or-live flag. `desktop/src/chat/Chat.tsx` and
  `desktop/src/chat/ChatMessage.tsx` route through it.
- **Marketing site: Pricing + Console i18n** — `site/src/components/
  Pricing.tsx` ships the live pricing page with token-quota display
  (DeepSeek / MiniMax / OpenAI logos, Windows badge, token-formatted
  quota). `site/src/consoleI18n.ts` extracts the dashboard's console
  copy into a dedicated i18n module so it can be unit-tested
  (`site/src/consoleI18n.test.ts`). `site/scripts/sync_release.cjs`
  keeps the landing-page release list in sync with the GitHub API.

## v0.4.54 (2026-08-25)

- **Chat: catastrophic-backtracking regex removed** — the previous tool-block
  image-link detector used nested / overlapping quantifiers
  (`[A-Za-z0-9_.-]+(?:[\\/]...)*` inside an alternation) inside a regex
  compiled into the main thread. A single slash / path-heavy tool output
  with no image extension could hang the main thread for minutes, freezing
  the whole conversation on open. A single greedy non-whitespace run with
  the image extension at the end replaces it; the same logic runs in
  microseconds. The interpreter that uses it lives in the new
  `desktop/src/chat/toolSummaries.ts` module, which is pure functions over
  `(ChatBlock, ChatTurn)` so the regex change is now testable in isolation.
- **Typeset: visual text-edit infrastructure** —
  `desktop/src/typeset/visualTextEdits.ts` owns the LaTeX source edits the
  visual (click-to-edit) PDF surface drives: retyping a text object,
  dragging it to a new position, and the TikZ scaffolding a moved object
  needs. `VISUAL_OBJECT_BEGIN` / `VISUAL_OBJECT_END` markers delimit
  the editable region so a drag does not corrupt surrounding source.
- **Typeset: panel layout extracted** —
  `desktop/src/typeset/useTypesetPanels.ts` removes 6 state slots, 4
  refs, and ~190 lines of pointer bookkeeping from `Typeset.tsx`. The
  three resizable regions (project tree, PDF preview, outline) keep their
  min / max widths, default sizes, and pointer / keyboard gestures.
- **Settings polish** — `AboutSettings.tsx` / `EnvironmentSettings.tsx`
  / `GeneralSettings.tsx` get the new copy and icons. The Settings nav
  reflects the new sections without breaking the two-view pattern.
- **Marketing site: Assist section** — `site/src/components/Assist.tsx`
  ships the landing-page copy for the Image Assist network: peer
  topology illustration, hand-shake / network / sparkles icons, peer
  selector, and the bilingual copy blocks. `site/src/i18n.ts` and
  `site/src/styles.css` carry the supporting copy and tokens.

## v0.4.53 (2026-08-24)

- **Three tests that were not earning their place** — the scanned-PDF OCR test
  returned early when poppler or Windows OCR was missing, so it reported green
  on every machine that could not run it; it is `#[ignore]`d with a reason now,
  like every other environment-gated test here, and a missing tool fails it
  instead of passing it. Two stylesheet tests were pinning implementation
  details by exact string — a font stack, `min-width: 96px;`, one keyframe name
  on five panels — where renaming a class broke the suite without any
  regression. Their real invariants are kept: no Workflow text below 11px, and
  `prefers-reduced-motion` still disables every entrance animation.

- **A failed web search no longer looks like a clean call** — `WebSearch`
  returns a well-formed payload when every provider refuses it, and the
  allow-list that decides whether a tool reported failed work never covered it.
  The repeat counter, compaction's dead-end pinning and the desktop's error
  badge all read that one flag, so a dead search was invisible to three
  consumers at once. It is classified now (all source attempts failed; one
  rate-limited provider out of five stays the coverage gap the payload already
  reports), and a new test in `tools` fails whenever a tool joins the inventory
  without a classification decision — that registry is hand-kept, and nothing
  used to force it to keep up. Adding the test immediately turned up eleven
  tools nobody had ruled on.

- **Compaction summaries stop being spent on a model that does not exist** —
  `default_summarizer_model` mapped any `gpt-5*` chat model to `gpt-5-mini`,
  but the managed gateway serves no `-mini` at all: every compaction paid three
  retries (1+2+4s) and then fell back to the deterministic summary, so the LLM
  summary effectively never ran there. The executor config now carries the
  model ids the gateway is known to serve, and a cheap sibling is only used when
  it is actually among them. A directly configured provider, which has no such
  list, keeps the previous optimistic behaviour.

- **Dead entry points removed** — six Tauri commands whose frontend wrappers
  had no caller anywhere (`compute_job_get`, `oracle_web_consult`,
  `oracle_web_generate_image`, `project_permission_get`/`_set`,
  `provider_test`), the eight wrappers themselves, and the private helpers and
  types that existed only for them. `oracle_web.rs` itself stays: the tools path
  uses it through `execute_bound_*`, only the two command entry points were
  dead. Also gone: the Image Assist per-request approval event and prompt struct
  left behind when that prompt was retired. The desktop crate's dead-code
  warnings are down from four to one, and the workspace builds without any.

- **2.3 GB of stale worktrees cleared out of the repo root** — a release
  worktree and two abandoned agent worktrees, none of them gitignored, so they
  showed up in `git status` one `git add -A` away from the history (and slowed
  every recursive search). `git worktree prune` also cleared a fourth entry
  whose directory was already gone. `.tmp-*` is ignored now.

- **Remote: one implementation per contract** — an audit of the remote path
  after the sign-in rework found the website and the PWA had grown separate
  copies of the same rules, and the production edge had grown routes nothing
  calls. The account plane of the gateway (device list, connect requests) is
  now a single `accountGateway.ts` that both surfaces call: it owns the
  credential, its renewal, and what counts as a valid device record — the
  dashboard used to re-implement all three with looser validation and no
  renewal. Pasted connection codes go through the QR module that already knew
  the format, so a link carrying no pairing fragment now says so instead of
  silently opening an empty pairing frame. A finished pairing is announced to
  the embedding dashboard (`somniq_pairing_complete`) rather than inferred by
  polling the device list every two seconds and diffing which computers are
  online, and both ends of that channel now check the message origin. The
  embedded workspace no longer carries the theme in its URL: changing themes
  re-created the iframe, tearing down a live remote session to restyle it.
  Sign-out drops the pre-rc.25 logout call that ran alongside the real
  revocation. On the edge, `/v1/user/token` (an unused reach into new-api's
  API-key management) and `/v1/auth/newapi/login` (a path the gateway has no
  route for) are gone, and the production Nginx server files are finally in the
  repo — they existed only on the host, so a rebuilt machine would have
  silently lost the routes the browser sign-in depends on.

- **Web: the sign-in stops expiring minutes after you make it** — the dashboard
  and the remote PWA kept only the short-lived access token new-api hands the
  browser at login, ignoring both the expiry it reports and the rotating
  HttpOnly refresh cookie that comes with it. Once that token died, every panel
  answered "登录状态已失效" and the only way out was retyping the password —
  while the desktop client, which has spoken the refresh protocol all along,
  stayed signed in for days. The browser now speaks it too: one shared renewal
  manager stores the expiry and session id, renews ~60s ahead (or on the first
  rejection, retrying the call once), collapses concurrent renewals onto a
  single request so two of them cannot invalidate each other's cookie, and
  renews when a backgrounded PWA returns to the foreground. Deployments must
  route `POST /api/user/auth/{refresh,logout}` to the account backend — the
  refresh cookie is scoped to that path, so an alias under `/v1/` would never
  receive it; both shipped Caddyfiles now do, and an edge that does not is
  treated as "cannot renew right now" rather than as a dead session. Along the
  way: the account panel no longer deletes the only credential it has before
  attempting a renewal that needed it, `/v1/user/self` failures no longer leave
  a signed-in-looking shell whose every request fails, signing out revokes the
  refresh session server-side instead of only forgetting it locally, and the
  dead code path that minted `sk-` API keys as "durable" website credentials
  (which `/v1/user/self` never accepted) is gone, along with the `console.debug`
  calls that printed token payloads.

- **Typeset: PDF → source jumps land where you clicked** — three defects, none
  of them geometric (a click's coordinate has been reaching SyncTeX correctly:
  75 of 76 probe markers, sampled at five heights each, resolve to the exact
  source line). First, `synctex` prints the path it recorded in the console code
  page, so a project under `F:\论文\…` came back as CP936 bytes; decoded as
  UTF-8 those became replacement characters, the hit resolved to no file, and
  the pane silently fell back to searching the document for the clicked text.
  It now uses the same `decode_process_text` the LaTeX compile does. Second,
  `synctex view` packs several result blocks into one begin/end pair — 40 of
  them for a line inside a `tabularx` — and the parser kept only the last,
  smallest box while the caller assumed it held the first. Third, that text
  fallback now announces itself instead of passing a guess off as a resolved
  jump, refuses targets too short to identify a place (a CJK build gives pdf.js
  one text item *per glyph*, so the target was a single character), and names
  the real cause when a PDF simply carries no SyncTeX data — usually one built
  outside Typeset.

- **Typeset: the Overleaf gaps that cost the most per day** — measured against
  the Overleaf frontend checkout, not from memory. Ten of them:
  - **Tabs.** Opening a second file no longer asks to discard the first: every
    open file gets a tab, an inactive one keeps its unsaved draft in memory
    (switching back restores it without re-reading the file), the dirty ones
    carry a dot, and only closing a tab can drop work — behind a confirm.
  - **Compile on save.** Ctrl+S writes *and* rebuilds. Overleaf recompiles a few
    seconds after you stop typing, which locally means a PDF reflowing under the
    reader mid-sentence; a save is the explicit "look at this now". The compile
    runs through the save rather than instead of it, so a second Ctrl+S during
    an in-flight write still queues the newer draft. Toggleable per project.
  - **Engine selection.** Detection (`% !TeX program`, then the preamble's
    packages) stays the default and is now overridable per project —
    pdflatex / xelatex / lualatex, still driven through latexmk so bibliography
    passes keep working.
  - **Main document.** Right-click any `.tex` → *Set as main document*, marked in
    the tree; TeX is pointed there no matter which chapter is open.
  - **New file / new folder / import** from the file-tree header or a folder's
    context menu, `typeset_import_file` copying a picked file into the project.
  - **Save the PDF as…**, `typeset_export_file` copying it out to a chosen path.
  - **Presentation mode** — full screen, one page at a time, arrow keys / click /
    wheel to advance, Esc to leave.
  - **Inverted PDF colours** for reading at night: the canvas inverts, the
    selection tint and the SyncTeX highlight do not.
  - **SyncTeX buttons** for both directions, so the jump is discoverable
    without knowing the double-click gesture.

- **Typeset: the PDF pane reads like a PDF again** — inverse search moved to a
  double click, as in Overleaf, SumatraPDF and TeXstudio. A single click now
  belongs to the reader: it keeps the keyboard in the pane, so ArrowLeft /
  ArrowRight turn the page instead of moving a caret in the source editor, and
  it can start a text selection. The per-word layer renders in reading mode as
  plain spans rather than buttons — a button takes focus on every click and its
  text cannot be dragged over, because `user-select: auto` is *used* as `none`
  on a UI element — while colour sampling, one `getImageData` per run, is now
  paid only in slide-edit mode where the text is actually drawn.

  Selecting then had to *look* right, which needed the rest of pdf.js's text
  layer. The layer is written in the UI font over glyphs the canvas painted in
  the document's font, so the same string is a different width: measured in
  Chromium, one line of a thesis was 502px of stand-in text over 416px of
  glyphs, and the highlight drifted further right with every word. Each run is
  now measured and squeezed with `scaleX` until the two widths agree (residual
  drift inside a run: 2px mean, 3px max at 16px type), the selection is tinted
  rather than filled and keeps `color: transparent` so the browser stops
  painting the stand-in text in white over the real glyphs, and items keep the
  space that follows them plus a break at end of line, so a selection spanning
  two runs no longer copies as `developstheliterature`.

- **Literature search: result ordering** — reciprocal-rank fusion combines
  *rankings*, so its only signal is agreement between providers, and Scopus,
  OpenAlex, Crossref and arXiv agree far less than they appear to. With no
  agreement to weigh, fusion was degenerating into round-robin: measured on
  `retrieval augmented generation for large language models`, every source's
  first result scored identically (16,393,442) and the merged list was just the
  three provider lists interleaved — a Wiley volume's front matter in first
  place, the field's most-cited survey (704 citations) in third, and four book
  chapter stubs in the top eleven. Two changes:
  - Crossref is now asked only for real literature (`journal-article`,
    `proceedings-article`, `posted-content`, `book-chapter`); its unfiltered top
    four for that query were all `type: "other"` book front matter. OpenAlex
    excludes only `paratext` — an allow-list there is actively harmful, because
    `type:article|preprint|review` dropped three of the most relevant results:
    OpenAlex files conference papers under `conference-paper`, and computer
    science lives at conferences.
  - Fusion scores are multiplied by a relevance term built from how much of the
    question the title covers and an age-normalised citation impact. A missing
    citation count is treated as *unknown*, never as zero, so preprints are not
    demoted for a number arXiv does not publish; the signals are persisted on
    each ranked record so a surprising order can be explained without re-running
    the search.

  Same query, after: the 704-citation survey first, then the 366-, 193- and
  172-citation papers. Every book-chapter stub is gone from the result set.

- **Literature search: query compilation rebuilt** — the planner used to send
  every source the same three streams and split the result budget evenly
  between them. Measured against OpenAlex for one ordinary question, the
  quoted-sentence stream matched 0 works and the flat `OR` expansion matched
  82,736,946 — so two thirds of every request bought nothing. Phrase streams
  are now emitted only for a quoted phrase or a title-shaped query; the alias
  expansion widens one term (`… AND (retrieval OR search)`) instead of
  disjoining all of them; Crossref and Semantic Scholar, whose query
  parameters match words rather than boolean expressions, get one stream
  instead of three near-copies; and Scopus streams are always conjunctive,
  because adjacent words inside `TITLE-ABS-KEY(...)` are read there as a
  phrase. Budget and reciprocal-rank weight now both follow stream quality.
- **Literature search: non-English questions** — a Chinese question reached
  the providers as one unsegmented token. It is now segmented against a
  research glossary and translated into the index language, with the caller's
  own wording kept as a separate low-weight stream for OpenAlex and Crossref,
  which do carry non-English records. Anything the glossary could not
  translate is named in the variant rationale rather than dropped silently.
  Measured on arXiv, the same question went from 0 matching preprints to
  7,676. The old pre-flight that failed the *whole* call because Scopus
  refuses CJK — while Scopus joins the default source set whether or not its
  key is configured — is gone; a source that cannot express a question now
  records a coverage gap like any other.
- **Literature search: sources run concurrently, under a deadline** — the five
  providers are independent services and were being asked one after another,
  so a pass cost the sum of their latencies (measured: 6.5s sequential vs 3.8s
  for the same three-source search). Each pass also now has a wall-clock
  budget, overridable with `ARIS_LITERATURE_SEARCH_TIMEOUT_SECONDS`; running
  out of time is recorded like a user stop, so the run stays `partial` and
  `continueRunId` resumes it.
- **Literature search: `timeWindow` and `sortOrder`** — every adapter already
  implemented a publication-date filter, but the one-shot `LiteratureSearch`
  tool had no field for it, so "papers since 2023" required the three-step
  protocol workflow. Both are now inputs, validated before any network call,
  and both take part in the duplicate-call fingerprint.
- **Literature search: Semantic Scholar credentials** — its anonymous pool
  answers HTTP 429 rather than results, and the adapter spent three retries
  per query variant proving it on every run. Without `SEMANTIC_SCHOLAR_API_KEY`
  the source is now reported as a missing-credential coverage gap, the way
  Scopus already was. `Retry-After` is also parsed in both of its defined
  forms; only the delay-seconds form was understood before.
- **Literature search: duplicate arXiv records** — identity folded DOI case
  *after* matching the arXiv DOI prefix, so the canonical `10.48550/arXiv.<id>`
  spelling matched neither the lower- nor the upper-case branch and the same
  preprint was filed twice. The store also gained the DOI→arXiv identity
  alias, so a Crossref record and an arXiv record for one preprint no longer
  depend on an exact title match to merge.
- **`LibraryRetrieve`** — full-text search over the PDFs a project already
  holds was reachable only from the desktop Literature view, so an agent asked
  about a paper the user had open still went to the network and answered from
  an abstract. It is now a read-only chat tool returning page-anchored
  passages.
- **Failed searches are visible to the agent** — `tool_output_reports_failure`
  only classified shell, REPL and notebook payloads, so a literature run whose
  every source was refused was recorded as a successful call: the repeat
  counter could not see a model re-running the same dead search, and the
  desktop showed no error.

## v0.4.52 (2026-08-20)

- **Image Assist: tighter transport isolation** — every approved match now
  carries an explicit `session_id`. Reads are answered only on that session,
  so a second brokered channel cannot name someone else's request id and
  pull their images. The desktop-side transport reservation was renamed
  from "approval" to "acceptance" to reflect that the local user accepts
  a *match*, and the consent flag moved from a per-approval dialog state
  to a Settings-level toggle that survives across matches.
- **Image Assist: relay rejection diagnostics** — the gateway now exposes
  the specific reason a relay rejection occurred (timeout, peer-unavailable,
  mismatch, rate-limit) so the desktop can surface an actionable error
  instead of "relay failed". Wired end-to-end through
  `site/server/src/lib.rs` and `desktop/src-tauri/src/remote.rs`.
- **Image Assist: decoupled from new-api** — the 0.4.51 implementation
  relied on the new-api gateway's account-bootstrap path for the helper's
  account availability check. That coupling is removed: the helper's
  image-assist availability now reads from the local desktop's own
  ChatGPT-account state, so the two integrations stay independent and a
  new-api outage cannot disable image-assist matching.
- **Image Assist: revision 6 protocol doc** — `docs/development-logic/
  image-assist-network.md` updated to revision 6, recording the
  reachability-based matching change, the explicit departure path, and
  the end-of-exchange semantics that stopped a successful transfer from
  reporting itself as a failure.
- **Chat session controller** — `desktop/src/chat/useChatSessionController.ts`
  consolidates session-state bookkeeping that was previously scattered
  across `useChatRun` and `useChatStream`. The new tests in
  `tests/Chat.test.tsx` and `tests/ProjectBriefCard.test.tsx` exercise
  the consolidated state machine.

## v0.4.51 (2026-08-17)

- **Image Assist network** — M0 lands. A SomniQ user with no ChatGPT image
  capability can ask the gateway for help; the gateway matches them with a
  different user who has explicitly volunteered and whose own ChatGPT Web
  account is ready. The image is generated on the helper's computer, using
  the helper's account, and only the resulting image files travel back.
  This release adds the closed wire protocol
  (`crates/remote-protocol/src/image_assist.rs`), the brokered peer
  reservation on the desktop (`desktop/src-tauri/src/image_assist.rs`), the
  requester's manifest sanitisation + artifact import + request authorisation +
  daily allowance, the match transcript with domain-separated preview key,
  host/mDNS ICE suppression, the helper policy switch, the approval dialog
  (`desktop/src/remote/ImageAssistApproval.tsx`, `ImageAssistRoster.tsx`,
  `imageAssistLocation.ts`, `imageAssistActivity.ts`), and the
  `site/server/` match state machine with its three
  authorisation gates. Both desktops expose each match as a visible
  process-local temporary session from matching through acceptance,
  connection, generation, transfer, and completion / failure. A failed
  direct WebRTC attempt requests the single gateway-minted encrypted relay
  fallback and repeats transcript exchange under the relay session id.
  End-to-end verification against two live desktops has not been performed.
- **Image-Assist transport isolation** — the brokered peer has no pairing
  edge, no persisted record, and no scope grant beyond `ImageAssist`, so it
  must never reach `compute::handle_peer_message` or
  `remote::execute_control_request`. Image Assist defines a closed
  message set whose serde tags do not overlap any compute or control tag,
  so a payload from one protocol cannot decode as the other even before
  type-level routing is considered.
- **Remote gateway (site/server)** — the single-instance P0/P2
  gateway for SomniQ's remote-control transport gains the Image-Assist
  match state machine, the encrypted relay fallback, and the WebSocket
  surface for brokered peer signalling. New `reqwest` dependency for the
  outbound side of the gateway. The gateway durably retains completed
  device metadata and bearer-token hashes only; presence and signal / relay
  frames are ephemeral, and project content never enters durable state.
- **Bundled Playwright runtime** — the desktop installer now ships the
  Playwright runtime under `desktop/src-tauri/resources/bin/aris-playwright-mcp`
  (Unix + Windows scripts), and a long-lived publisher-PDF browser worker
  `desktop/src-tauri/src/playwright_pdf.rs` uses it. Replaces the earlier
  per-spawn approach so a generation run can amortize browser startup.
- **NewAPI managed login** — `desktop/src-tauri/src/newapi.rs` continues the
  [[project_newapi_managed_login]] work: the desktop moves off user-pasted
  API keys to login via the self-hosted new-api gateway
  (`106.53.28.124:18080`). `newapi_login` / `newapi_models` /
  `newapi_bootstrap` drive new-api's existing API (no shim / fork); Settings
  is now a projection of server state (account / plan / quota / models),
  while theme / cache stays local. PATCH /me/settings remains deferred.
- **Literature library** — `crates/tools/src/literature.rs` and
  `desktop/src-tauri/src/literature.rs` gain the auto-literature mail /
  literature ingestion path (`auto_literature.rs`) and the deeper
  search-architecture layering from
  [[project_literature_skill_orchestration_gap]]: Scopus / OpenAlex as
  the core sources with arXiv-supplement priority ordering, Scopus
  pagination, and the kernel ceiling at 50 / 100 results.

## v0.4.50 (2026-08-16)

- **Settings modularization** — `desktop/src/settings/Settings.tsx` (2,445
  lines) splits into per-section files: `AboutSettings.tsx`,
  `AccountSettings.tsx`, `GeneralSettings.tsx`, `ModelsSettings.tsx`,
  `EnvironmentSettings.tsx`, `KeyInput.tsx`, `PresetTextInput.tsx`,
  `TestDetail.tsx`, and `settingsFormatters.ts` (shared formatters). The
  monolithic `RuntimeAccess.tsx` (311 lines) is gone. The two-view Settings
  pattern from [[project_settings_providers]] is preserved, now with one
  file per side. New unit-test files for each split (`SettingsConnection`,
  `MemorySettingsBackend`, `OracleWebSettings`).
- **Builtin research memory schema v4** — `crates/runtime/src/research_memory.rs`
  bumps `SCHEMA_VERSION` from 2 → 4 (the prior bumps were intentionally
  deferred while the v0.4.46 freeze was being repaired). A new
  `EXTRACTOR_VERSION: "builtin_rules_v3"` is stamped on every R1 atom so a
  change to the extraction rules surfaces as
  `ResearchMemoryStore::stale_extractor_atoms` and prompts the user to
  replay the library. Episode and recall limits gain explicit constants
  (`EPISODE_MAX_ATOMS`, `EPISODE_SUMMARY_CHAR_LIMIT`, `RECALL_TEXT_CHAR_LIMIT`,
  `RESEARCH_RESTATEMENT_MIN_CHARS`, `ACKNOWLEDGEMENT_PREFIX_CHARS`) so the
  capture path and the recall path can no longer drift on size thresholds.
  New 540-line test file in `tests/research_memory.rs` pins the
  extraction-replay contract.
- **MCP server configuration UI** — `desktop/src-tauri/src/mcp.rs` (+868
  lines) exposes the full stdio server input surface: name, command, args,
  env, persistence to `config.toml`, and the desktop-side chrome that lets
  the user add / edit / remove a server without leaving the Settings panel.
  Pair with the `McpServerManager` from the kernel and the new
  `docs/mcp.md` updates.
- **Image workflow panel** — `desktop/src/chat/ImageWorkflowPanel.tsx`
  gains the production surface for the Oracle-Web `chatgpt_image` MCP
  tool: model picker, prompt, iteration history, output preview, retry
  with feedback. The new `imageWorkflowModel.ts` module owns the
  per-attempt state machine. `ChatMessage.tsx` slots it in between the
  user prompt and the assistant reply.
- **Extensions panel modularization** — `desktop/src/extensions/Extensions.tsx`
  (+279 lines) gains the formal MCP-connector surface that mirrors the
  Settings modularization: per-server card, transport (stdio / http), auth,
  capability list. New `Extensions.test.tsx` covers the new rendering.
- **Chat prompt + project intent** — `crates/chat/src/lib.rs` and
  `crates/runtime/src/project_intent.rs` adjust the system prompt to keep
  the new settings modularization transparent: project-intent inference
  no longer relies on the old settings-side-effect flags. New test files
  in `tests/project_intent.rs` (46 lines) and `tests/config.rs` (56 lines)
  pin the new behavior.
- **Oracle account isolation follow-on** — the v0.4.49 isolation rules now
  apply uniformly to all three Oracle MCP tools (`consult`, `reviewer`,
  `image`): every account has its own persistent isolated browser user,
  the Oracle worker runs from the account-local directory, and project
  configuration cannot widen browser access.

## v0.4.49 (2026-08-16)

- **Desktop Git workbench** — `desktop/src-tauri/src/git.rs` adds typed Tauri
  commands for repository detection, current-branch / upstream / ahead-behind
  metadata, porcelain status parsing (staged, unstaged, untracked, renamed,
  conflicted), bounded UI diff payloads (750 kB cap per side), repository
  initialization, staging, unstaging, committing (20 kB message cap), and
  local branch creation / switching. The matching React workbench
  (`desktop/src/git/GitWorkspace.tsx`) shows a reviewable path from a
  working-tree change to a local commit while keeping network and destructive
  actions outside the first delivery. Network operations and force-pushes are
  explicitly out of scope.
- **Oracle Web integration** — `desktop/src-tauri/src/oracle_web.rs` adds three
  narrowly scoped ChatGPT-website capabilities without an OpenAI API key:
  explicit Chat consultation, image generation, and independent review. The
  integration discovers an installed Edge / Chrome / Brave / Chromium /
  Vivaldi executable and never bundles a browser. Oracle + Node.js 24 are
  excluded from the main installer and downloaded on explicit user opt-in
  from Settings, with the Node.js archive SHA-verified against the official
  `nodejs.org` `SHASUMS256.txt` and the `@steipete/oracle@0.18.0` package
  installed with development dependencies and install scripts disabled.
  Every Oracle account owns a persistent isolated browser user, so the user
  chooses a ChatGPT account once and later Chat calls reuse it. SomniQ never
  attaches to a daily Chrome profile, copies cookies, or trusts inherited
  remote/credential inputs, and runs the managed Oracle worker from its
  account-local directory so project configuration cannot widen browser access.
- **Retrieval-guard opt-out for toolless turns** —
  `ConversationRuntime::without_retrieval_guard()` turns off the per-turn
  coverage verdict for toolless utility turns whose prompt merely *quotes* a
  research request — chat-title inference and intent inference both fit, and
  both need the bare model output because they cannot retrieve anything. The
  guard still gates every other turn.
- **Research memory + session index fixes** — `research_memory.rs` gains
  several correctness fixes (see tests). `session_index.rs` schema-version
  handling now respects a per-project migration path so re-indexing never
  silently drops rows from older indexes. The v0.4.46 schema-bump freeze
  fix carries forward.
- **MCP stdio hardening** — `crates/runtime/src/mcp_stdio.rs` tightens
  per-process lifecycle (timeout-bound `wait_timeout`, deterministic
  `drop` cleanup so a child left running by a crash is reaped on the
  next reconnect). See the new tests in
  `crates/runtime/src/tests/mcp_stdio.rs`.
- **Chat UI rewire** — `desktop/src/chat/ChatMessage.tsx` gains an
  `ImageWorkflowPanel` slot for the new image-generation pathway;
  `useChatRun` and `useChatStream` adopt the canonical
  `with_project_execution_context` scope from v0.4.47 so the new
  ChatGPT-image turn stays bound to the active project even when the
  desktop has switched to a different one. `Settings → Oracle Web` and
  `Settings → Memory` get the new surfaces.
- **Styles refresh** — `desktop/src/styles.css` gains the design tokens
  for the Git workbench, the Oracle Web settings panel, the image
  workflow panel, and the new chat attachments panel.

## v0.4.48 (2026-08-13)

- **Typeset visual editor — CodeMirror-6 decoration pass** — the visual editor
  rewrite continues. The hard work moves out of `Typeset.tsx` into four new
  modules that each have one job: `desktop/src/editor/latexComplete.ts` owns
  the autocomplete catalogue and per-document label / citation-key harvest;
  `desktop/src/editor/latexLint.ts` owns the lint-gutter extensions that
  underline undeclared `\ref` labels, double-defined labels, and missing
  `\cite` keys, alongside the compiler errors pushed in after a build;
  `desktop/src/editor/latexBib.ts` reads hand-maintained `.bib` files
  tolerantly (a malformed halfway should still contribute the entries before
  and after the damage); `desktop/src/typeset/outlineModel.ts` derives the
  project outline across `\input` boundaries, applies LaTeX's own numbering
  rules (starred headings and `\paragraph` get no number; `\appendix`
  restarts the top level at A), and exposes a pure-function model the
  outline panel reads. `desktop/src/typeset/ToolIcon.tsx` and
  `TypesetOutlinePanel.tsx` finish the panel + toolbar split. Net effect:
  `Typeset.tsx` shrinks from 7563 → 5997 lines despite the new behaviour.
- **OpenAI tool-call id collision fix** — `crates/executor/src/openai.rs`
  used the provider's opaque tool-call id verbatim in outbound history.
  Compatible providers occasionally reuse an id across turns, and the
  OpenAI Responses API rejects the replayed history with
  `Duplicate 'call_id'` 400. The executor now assigns a deterministic
  per-turn synthetic id (stable for a given history so the prompt-cache
  prefix is preserved) while keeping the local session id for in-process
  bookkeeping. Plus the matching 93-line openai.rs test that pins both the
  deterministic-id property and the local-id preservation.
- **SomniQ identity disclosure** — `crates/chat/src/lib.rs` rewrites the
  system prompt so the assistant always identifies itself as "SomniQ"
  (the product identity) rather than directly leading with the underlying
  model ID. The exact underlying model ID and developer are surfaced
  explicitly so the model can answer specific questions about itself when
  asked, without ever claiming to be Claude merely because SomniQ or a
  tool mentions Claude.
- **LaTeX document context command** — `desktop/src-tauri/src/typeset.rs`
  gains `latex_document_context(source_path)` which returns the source /
  root / output paths the editor needs to resolve `\input` boundaries and
  trigger rebuilds. Runs on a blocking thread (matching the v0.4.46
  memory-command fix).

## v0.4.47 (2026-08-13)

- **Project execution context** — every Chat turn that runs a tool or reads a
  file now carries an immutable `runtime::ProjectExecutionContext` (cwd + env
  vars), so the model sees the right project even when the desktop has since
  switched to a different visible project. `desktop/src-tauri/src/state.rs`
  stops calling `std::env::set_var` / `std::env::set_current_dir` and instead
  hands the context through the tool run path; `engine.rs` drops the old
  `PROJECT_ENV_VARS` static list and the snapshot/restore boilerplate around
  it. `crates/runtime/src/execution_context.rs` owns the new struct, plus a
  thread-safe `with_project_execution_context(&ctx, || { ... })` scope helper
  so the tool runner can run a closure under the right env without leaking
  process-wide state.
- **Prompt-cache prefix cap (git diff section)** — `crates/runtime/src/prompt.rs`
  was rendering an unbounded working-tree diff into the request prefix, so any
  user with uncommitted churn churned the OpenAI prompt-cache key on every
  turn (this is the upstream-replay half of the prompt-cache diagnosis on
  gpt-5.x / kimi / mimo). A new `MAX_GIT_DIFF_CHARS: 8_000` budget cuts the
  diff on a line boundary (so a truncated hunk still reads as a diff, not as a
  severed line); the unstaged half is prioritized over staged, since the
  unstaged is the work actually in progress. The budget buys orientation
  ("what is being worked on"), not a reviewable patch — the model can always
  run `git diff` when it needs the full text.
- **Permissions summary in the prompt** — `prompt.rs::render_config_section`
  now echoes the active `permissions` allow / deny rules, but only by tool
  identifier (`Bash`, `Write`, …) and never by argument. This keeps hooks
  like `Bash(curl -H "Authorization: Bearer xxx" …)` from being smuggled
  through the system-prompt echo, where the bearer token would have been
  visible to every subsequent turn.
- **Auth → LanguageChoice** — pre-login flow now opens a dedicated
  `LanguageChoice.tsx` step that picks `zh` / `en` before `NewAPI` login.
  Pairs with the new `login.css` and the `setLanguage` action on the
  desktop store.

## v0.4.46 (2026-08-12)
- Release: [`v0.4.46`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.46) · [PR #70](https://github.com/zhuyingqin/Aris/pull/70) · published 2026-08-12

- **WebFetch reads PDFs and stops failing on large bodies** — `application/pdf`
  used to be rejected outright ("PDF content requires the literature/PDF
  reader"), and a single 5 MB ceiling rejected any response on `Content-Length`
  before a byte was read, so every paper or supplementary-material URL in a
  crawl failed twice over. PDFs are now read through the kernel's text-layer
  extractor (`runtime::extract_pdf_text_from_bytes`, split out of `read_file`'s
  PDF path), including bodies mislabelled `application/octet-stream`, which the
  magic bytes catch. The download ceiling is now separate from the textual one:
  32 MB by default, overridable through `ARIS_WEB_FETCH_MAX_DOWNLOAD_BYTES`
  (clamped to 5 MB–256 MB), while textual bodies past 5 MB are truncated with
  `extraction.complete=false` and a warning instead of failing. Scanned
  image-only PDFs report `pdf_no_text_layer` rather than an error.
  Known limitation: the text extractor merges every embedded font's ToUnicode
  CMap into one table, so PDFs that subset several fonts (typical LaTeX papers
  with math) come back with scrambled glyphs. This predates the change and
  affects `read_file` on local PDFs identically.
- **Intelligent Memory settings no longer freeze the window** — `memory_status`
  and the other memory commands were synchronous Tauri commands, so they ran on
  the main thread; opening the page could block the whole window for ~42s
  because reading the R0 counts also triggered a full Session projection
  rebuild (v0.4.45 bumped `INDEX_SCHEMA_VERSION`, which flags every older index
  as stale). Every memory command now runs on a blocking thread, and
  `session_index_stats` / `recent_session_messages` are read-only: a stale
  projection is reported through the new `session_index_reindex_state` and
  rebuilt by the existing background repair thread, which the page shows as
  `starting` with live progress.
- **TencentDB Agent Memory integration removed** — the Memory Core sidecar,
  its HTTP adapter, delivery outbox, migration engine, vendored build manifest,
  build/smoke/verify/e2e scripts, release-workflow verification step, and the
  `memory_search` / `memory_read_scenario` tools are gone. Builtin research
  memory (R0–R3) is the only memory backend, so the settings page drops the two
  provider selectors, the extraction-model selector, the hybrid recall
  strategy, and the start/stop/restart/connection-test controls; the layer
  browser, recall preview, and Session backfill remain. The
  `memory_provider_mode`, `memory_project_modes`, `memory_model`, and
  `memory_recall_strategy` config keys are no longer read.
- **Retrieval convergence guard** — `crates/runtime/src/retrieval_guard.rs`
  splits the per-turn retrieval bound into two layers: a deterministic
  *corpus seal* (epistemic; freezes the candidate set during screening so
  discovery cannot reopen mid-screening) and a *total-call budget* (cost; applies
  to every turn). Uses deterministic signals only — blocks exact-duplicate
  WebFetch windows, prevents repeated fresh downloads of a snapshot already
  searchable with the ordinary file tools, and turns a long discovery tail into
  candidate verification before the global turn budget fires.
- **Benchmark harnesses** — `benchmarks/autoresearchbench` and
  `benchmarks/pseudobench-official` provide reproducible eval pipelines for
  retrieval convergence and pseudoscience refusal respectively. `devserver`'s
  `autorun-*.txt` fixtures ship the bounded Deep Research and the safety
  smoke prompt.

## v0.4.45 (2026-08-11)
- Release: [`v0.4.45`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.45) · [PR #69](https://github.com/zhuyingqin/Aris/pull/69) · published 2026-08-11

- **Builtin research memory (R0–R3)** — adds `crates/runtime/src/research_memory.rs`,
  a derived continuity layer over the authoritative Session log. R0 is the
  existing incremental Session SQLite/FTS rows. R1 captures reviewed final
  turns into typed researcher atoms (preferences, decisions, constraints,
  experiment results, negative results, environment facts, methodological
  lessons, artifact pointers) with confidence, validity, status, and an
  optional superseded atom. R2 consolidates active non-conflicting R1 atoms
  from the same Session into one episode card. R3 projects stable R1 atoms
  into a bounded project research constitution. Soft deletion only — the
  authoritative chat is never mutated through the memory surface.
- **TencentDB Agent Memory optional integration** — new
  `desktop/src-tauri/src/memory.rs` owns the optional local Memory Core
  sidecar, strict-isolation HTTP adapter, and the durable delivery/migration
  ledger that feeds filtered Executor turns into that sidecar. SomniQ
  remains the authority for complete Session event logs; this module adds
  a derived offline-aware layer for cross-session recall.
- **Settings → Memory** — new `MemorySettings.tsx`, `MemoryExplorer.tsx`,
  and `MemoryRecallPreview.tsx`. The Settings sidebar gains a `memory` item
  (extension of the 0.4.45 settings layout from
  [[project_settings_sidebar_refactor]]). Profile recall now flows from the
  memory surface rather than re-deriving from the wire log each time.
- **Session index expansion** — `crates/runtime/src/session_index.rs` grows
  per-layer recall paths and bounded cross-session lookup; tests in
  `tests/session_index.rs` reflect the new keys.
- **Workflow driver hardening** — `crates/runtime/src/review_workflow_driver.rs`
  records per-stage memory handoffs and persists a single canonical
  `current_stage` snapshot, removing the ambiguity the driver had when two
  stages both claimed latest-write.
- **Authenticode + live memory verification in the release workflow** —
  the Windows installer is now signed with an Authenticode certificate
  (imported from the `WINDOWS_CERTIFICATE` secret) in addition to the
  existing Tauri updater signature. A live Memory Core smoke test runs
  against `SOMNIQ_MEMORY_LIVE_*` secrets before the release is published.
- **Resource bundle** — desktop installs now ship the TencentDB Memory Core
  sidecar under `desktop/src-tauri/resources/memory/tencentdb/` (build
  artifact, gitignored; the manifest at `desktop/resources/tencentdb-memory/`
  is the working-directory input).

> **Release workflow requires new secrets.** Without `WINDOWS_CERTIFICATE`,
> `WINDOWS_CERTIFICATE_PASSWORD`, `SOMNIQ_MEMORY_LIVE_BASE_URL`,
> `SOMNIQ_MEMORY_LIVE_API_KEY`, and `SOMNIQ_MEMORY_LIVE_MODEL` the
> `Import Windows Authenticode certificate` and live-memory smoke test
> steps will fail.

## v0.4.44 (2026-08-08)
- Release: [`v0.4.44`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.44) · [PR #68](https://github.com/zhuyingqin/Aris/pull/68) · published 2026-08-08

- **Process ownership for shell commands** — every spawned process now joins a
  per-tree `ManagedJob` (Windows Job Object with `KILL_ON_JOB_CLOSE`,
  `setpgid(0)` on Unix), so a `start /b` / `&`-reparented service cannot
  outlive the app. A crash now closes the job handle and the OS kills every
  descendant — no more leaked dev servers after a desktop crash.
- **Background-process capture logs** — `run_in_background` writes its child's
  stdout/stderr to `.somniq/tmp/background/<id>.log` instead of `Stdio::null()`,
  so the start-up banner, the port, and any crash are readable with `read_file`
  while the service runs. The model no longer reaches for `npm run dev &` in
  the foreground just to see why a server failed to bind.
- **System prompt rebuilt from a cache key** — `desktop/src-tauri/src/system_prompt.rs`
  factorizes prompt assembly: model, workspace, memory, project goal, and the
  independent-review toggle all enter the cache key, so OpenAI-compatible
  prompt caching engages on a byte-identical prefix instead of churning it on
  every turn (the upstream replay that was eating cache on gpt-5.x / kimi).
- **Tool-output shaping split out** — `tool_output.rs` owns the three
  transforms every tool result needs (compact for context, compact for the UI,
  spill to disk when too large). Pure functions over `(tool_name, output)` plus
  an optional artifact, no session or app-handle plumbing, so it tests without
  a running app.
- **Workflow + chat wiring** — the workflow lane shares the prompt assembler
  with chat so its scope prefix and the chat prefix stay visibly adjacent.
  ProjectBriefCard rehydrates from the cached value instead of re-fetching on
  every turn.
- **Remote mobile history + reconnect** — `site/remote` grows a
  chat-history cursor, reconnect backoff, and inline question prompts so the
  mobile shell keeps up after a dropped websocket.

> **Note:** `engine.rs` is bigger in line count than 0.4.43 even after the
> system-prompt and tool-output extraction, because the workflow lane and the
> managed-job callers each grew. Net: more code, more boundaries.

## v0.4.43 (2026-08-08)
- Release: [`v0.4.43`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.43) · [PR #67](https://github.com/zhuyingqin/Aris/pull/67) · published 2026-08-08

- **Terminal shell removed** - deletes the `aris-cli` terminal front end along
  with the `commands` and `compat-harness` crates and the desktop CLI-bundling
  script (~11,600 lines). SomniQ Studio now ships two shells: the Tauri desktop
  app and the mobile remote. No kernel crate changed, because no kernel crate
  ever knew a terminal existed.
- **Slash commands become a desktop surface** - command specs, parsing, and help
  rendering move to `desktop/src-tauri/src/slash_commands.rs`. The domain
  behavior behind each command (compaction, session listing, config inspection,
  cost summaries) stays in the kernel and is merely invoked by the command.
- **Tool-failure visibility** - adds `crates/runtime/src/tool_outcome.rs` so an
  execution tool's failure is classified in one shared place instead of a single
  ad-hoc allow list, keeping failed tool calls visible to the turn loop.
- **Architecture guidance** - replaces `cli-desktop-architecture.md` with
  `shell-runtime-architecture.md`, which states the one-kernel/many-shells rule
  that made this removal a deletion rather than a refactor.

> **Note:** removing the terminal shell also removes the headless entry point
> (`-p` / `--print`) and the `meta_opt` hook installer. Automation that shelled
> out to `aris` must move to the desktop app or the remote gateway.

## v0.4.42 (2026-08-07)
- Release: [`v0.4.42`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.42) · [PR #66](https://github.com/zhuyingqin/Aris/pull/66) · published 2026-08-07

- **Durable review workflow** - adds the first end-to-end workflow surface for
  research planning, independent review, evidence screening, and resumable
  stage progress in SomniQ Desktop.
- **Literature workflow continuity** - persists workflow events, transcripts,
  handoffs, and reviewer outputs so interrupted runs can resume from their
  last durable checkpoint.
- **Release baseline alignment** - carries forward the GitHub v0.4.39-v0.4.41
  session, model, and Zhihu search changes before building the 0.4.42 assets.

## v0.4.41 (2026-08-03)
- Release: [`v0.4.41`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.41) · [PR #65](https://github.com/zhuyingqin/Aris/pull/65) · published 2026-08-04

- **Reliable NewAPI session renewal** — modern gateways now persist only their
  documented `new_api_refresh` credential in the operating-system credential
  store and renew short-lived browser access tokens without writing them to
  `config.json`.
- **No logout during concurrent checks** — account, group, and model checks
  share a single refresh operation, preventing a rotated cookie from being
  reused by a sibling request. Legacy gateways continue to use the durable
  management-token flow.
- **Safer session lifecycle** — recognized NewAPI session-expiry responses
  clear local credentials consistently; explicit logout clears the device
  immediately before attempting best-effort server-side revocation.

## v0.4.40 (2026-08-02)
- Release: [`v0.4.40`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.40) · [PR #64](https://github.com/zhuyingqin/Aris/pull/64) · published 2026-08-02

- **Managed login durability** — desktop sign-in now exchanges a short-lived
  dashboard JWT for the NewAPI management token while the fresh login cookie is
  available. Account refreshes and API-key checks therefore persist past the
  dashboard JWT lifetime instead of clearing the local session. Existing users
  need to sign in once after updating so the durable token can be saved.

## v0.4.39 (2026-08-02)
- Release: [`v0.4.39`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.39) · [PR #63](https://github.com/zhuyingqin/Aris/pull/63) · published 2026-08-02

This release improves the desktop research workspace's continuity and remote
execution reliability while adding first-class compatibility for DeepSeek V4's
Responses API.

- **DeepSeek V4 Responses support** — setup now uses the official
  `https://api.deepseek.com/v1` endpoint with an OpenAI-compatible executor.
  Streaming tool calls are recovered safely when compatible gateways omit the
  usual terminal tool-call events.
- **Durable project activity** — project briefs can persist a refreshable,
  reviewer-curated view of the active research focus, related work, session
  cursors, and context checkpoints instead of relying on wall-clock refreshes.
- **Main-line focus tracing** — deterministic session signals now surface
  repeated file operations, recurring failures, and prolonged tool runs, carry
  those facts through compaction, and prompt the agent to check whether work
  remains on the project's main line before it continues.
- **Remote compute hardening** — compute credentials are cached to avoid
  repeated keychain failures, remote capabilities require explicit opt-in, and
  session/engine handling has expanded regression coverage.
- **macOS icon alignment** — the packaged macOS icon now includes a transparent
  safe margin so its Dock size aligns with neighboring applications.

The GitHub **Release** workflow builds signed Windows and universal macOS
artifacts, generates updater manifests, and publishes a GitHub Release whenever
a `v*` tag is pushed after this branch is merged.

## v0.4.15 (2026-05-29)
- Release: [`v0.4.15`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.15) · [PR #42](https://github.com/zhuyingqin/Aris/pull/42) · published 2026-07-11

A focused **OpenAI-compatible streaming robustness** hotfix. Closes
issue [#249](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/249):
MiniMax (and other OpenAI-compatible providers / proxies) were
effectively unusable because aris-code treated the `data: [DONE]` SSE
sentinel as the *only* authoritative stream-completion signal.

Seeded by a read-only streaming-interop audit (5-agent workflow) and
cross-reviewed by Codex MCP (gpt-5.5 xhigh) over 3 rounds
(GO-WITH-NITS → GO-WITH-NITS → GO). All changes live in one file
(`crates/aris-cli/src/openai_executor.rs`); the Anthropic SSE path is
untouched.

### 🔴 #249 — `finish_reason` is a valid completion signal

The OpenAI Chat Completions spec defines a non-empty
`choices[].finish_reason` as the model's terminal chunk; `data: [DONE]`
is an SSE-transport convention that **not every compatible provider
emits**. MiniMax sends `finish_reason: "stop"` then closes the
connection without `[DONE]`, so the clean-EOF branch — which only broke
on `observed_done` — fell through to a hard
`OpenAI stream ended prematurely without [DONE] sentinel` error on
*every* successful completion.

The clean-EOF decision is now a pure, unit-tested function:

```
stream_eof_action(observed_done, observed_finish_reason,
                  nothing_emitted, retries_remaining)
    -> { Complete, Restart, Truncated }
```

A response is **complete** when *either* `[DONE]` OR a non-empty
`finish_reason` arrived. Crucially the read loop is **not** stopped
early at `finish_reason` — a trailing usage-only chunk (emitted under
`stream_options.include_usage` between the finish_reason chunk and
`[DONE]`) is still consumed, so `/cost` accounting is unaffected.
`finish_reason` only re-classifies an *already-reached* clean EOF from
"truncated" to "complete". A genuine mid-response truncation (neither
signal seen + content already emitted) still hard-errors, and a
proxy abort before any output still restarts within the
`ARIS_STREAM_RETRY` budget. This mirrors the lenience the Anthropic
path already had (synthesize-terminal-on-missing-MessageStop).

### Coupled robustness fixes (same SSE path)

- **OE7** — `finish_reason` is now read *before* the `delta` guard. A
  terminal choice carrying only `finish_reason` and no `delta` was
  previously skipped wholesale, which would have defeated the
  completion check above.
- **OE2** — pending tool calls flush on *any* non-empty `finish_reason`,
  not just `stop`/`tool_calls`. Compatible providers send
  `length` / `content_filter` / `max_output` / `sensitive`; flushing
  here preserves in-stream ordering and per-tool terminal rendering
  (`length` / `content_filter` also print a truncated/filtered hint).
- **OE4** — a mid-stream error envelope (top-level non-null `error`,
  no `choices`) now hard-errors instead of being silently dropped by
  the `choices` guard. This closes the regression window where an
  error arriving *after* a `finish_reason` would otherwise be misjudged
  a success. Only `message` + `code`/`type` are surfaced — never the
  whole envelope.
- **OE3** — SSE `data:` parsing tolerates a missing space after the
  colon (`data:{...}`, which W3C EventSource permits and some
  compatible providers emit). The old `strip_prefix("data: ")` silently
  dropped such lines.

### Tests

`cargo test -p aris-cli`: 82 passed (was 77 at v0.4.14; **+5**).
New coverage extracts the previously-untested SSE completion logic into
pure helpers: `stream_eof_action` truth table (11 cases),
`stream_error_detail` (9), `choice_finish_reason` (6),
`accumulate_tool_call`, `sse_data_payload` (12). Mirrors the
`api/src/client.rs` `should_retry_on_premature_eof` truth-table pattern.

### Deferred to v0.4.16

The same audit surfaced lower-priority / larger siblings left for the
next release: **CL2** (Anthropic `MessageDelta.stop_reason` symmetry —
the Anthropic path is already lenient so no user is blocked), **OE6**
(tool-call slot routing by `id` for parallel calls), **OE5** (usage
field-name fallbacks), **OE8** (SSE `event:` field). The
ProviderFamily resolver (P7) and Subagent provider parity (P8) remain
v0.4.16 scope. A separate pre-existing test-isolation issue (the
`api` crate's `read_api_key_*` tests read the user's real
`~/.config/aris/config.json` instead of an isolated temp dir, poisoning
`env_lock` locally — CI is unaffected) is also tracked for v0.4.16.

## v0.4.14 (2026-05-25)
- Release: [`v0.4.14`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.14) · [PR #41](https://github.com/zhuyingqin/Aris/pull/41) · published 2026-07-11

A **security-hygiene** release closing the top items from the v0.4.13
codex audit (gpt-5.5 xhigh, 6/10 NEEDS-REWORK verdict): one P0 (config
secret leak in system prompt), one P1 trivial (DeepSeek help doc), one
P1 documentation (MCP experimental status), one P2 reliability (stream
idle timeout). No headlining new feature.

Codex MCP cross-review: 4 rounds (NO-GO → GO-WITH-NITS → NO-GO →
**GO**). Findings + fixes captured in
`idea-stage/v0.4.14/audit-followup-plan.md`.

### 🔴 S9 (P0 security) — config redaction in system prompt

Before v0.4.14, `render_config_section()` dumped the merged
`settings.json` value verbatim into the system prompt sent to the LLM
provider. Anything you put in `settings.json` — `env` maps,
`mcpServers.<name>.headers.Authorization` Bearer tokens, hook command
env, `apiKey` fields, signed URL parameters — would round-trip through
the model's context window. For users running an OpenAI-compatible
proxy executor with Anthropic-format settings, that is a real
cross-vendor token leak path.

`render_config_section()` now:

- Renders a **whitelist** of top-level fields (`model`,
  `permissionMode`, `theme`, `outputStyle`, `permissions`, `sandbox`)
  with values intact, recursing into sub-trees to redact sensitive keys.
- Recursively replaces values under sensitive keys with `"[REDACTED]"`.
  Sensitive keys are matched case-insensitively on substring (`apikey`,
  `token`, `secret`, `password`, `authorization`, `headers`, `env`) and
  suffix (`_KEY`, `_SECRET`, `_TOKEN`).
- For non-whitelisted top-level fields, prints a type indicator
  (`<object: N keys>`, `<string: N chars>`, `<array: N items>`) so users
  can see the structure without leaking values.
- For `mcpServers`: shows server name + transport + a fixed
  `command=<configured>` / `command=<empty>` / `command=<unrecognized
  shape>` placeholder, plus `origin=<scheme://host[:port]>` only.
  `args`, `env`, `headers`, full URL (path/query/userinfo/fragment) are
  never rendered. URL parsing is hand-rolled with strict scheme +
  host + port validation; anything malformed → `<redacted: ...>`.
- For `hooks`: shows event name + hook count per event. Hook command
  strings are **never rendered** (they routinely embed `curl -H
  'Authorization: Bearer ...'`-style invocations).

Regression test exercises 9 distinct leak surfaces (top-level
`apiKey`/`env`, MCP `headers`/`command`/`url`-userinfo/`url`-query/
`args`, hook `command`/`env`, nested `sandbox.env`/`sandbox.apiKey`),
asserting that none of the 9 mock secrets appear in the rendered
output while whitelist fields remain visible.

URL redaction has its own targeted test covering happy paths (DNS,
IPv4, IPv6, ports) plus 7 smuggling attempts (no scheme, suspect
scheme, backslash/whitespace/control-char host, non-ASCII host,
non-digit port, empty port, IPv6 trailing garbage, IPv6 non-digit
port). MCP `command` summary and hook count both have dedicated
branch-coverage tests too.

### 🟡 P9 (P1 trivial) — DeepSeek help line pointed at the wrong path

`aris --help` printed:

```
DeepSeek:  EXECUTOR_PROVIDER=anthropic-compat EXECUTOR_BASE_URL=... aris --model deepseek-v4-pro
```

but `resolve_openai_executor_config()` only honors
`EXECUTOR_PROVIDER=openai`; the `anthropic-compat` path is configured
through `aris setup` and is **menu option 7** (not the placeholder
"option 6" the round-1 fix briefly used). Help text now points users at
`aris setup → option 7 (DeepSeek) → base URL https://api.deepseek.com/anthropic`,
which actually wires up `executor_provider="anthropic-compat"`,
`ANTHROPIC_AUTH_TOKEN`, and the correct base URL.

### 🟡 M1/M2 (P1 doc) — MCP experimental status surfaced

The v0.4.13 stdio reliability fixes (per-server timeout, JSON-RPC
notifications skip) are real, but `McpServerManager` is **not** wired
into `CliToolExecutor`'s tool dispatch yet — meaning `mcpServers`
configured in `settings.json` will be parsed, validated, and shown in
`aris doctor`, but their tool calls do not reach the LLM context. Codex
audit M1/M2 finding.

v0.4.14 surfaces this honestly:

- `aris doctor`'s MCP section now prints a yellow experimental warning
  whenever `mcpServers.len() > 0` saying full dispatch is planned for
  v0.4.16.
- README + README_CN both gain an `🔌 MCP servers (experimental)` /
  `🔌 MCP servers（实验性）` section with the same callout, plus a note
  that the Codex MCP reviewer is the exception (it goes through the
  dedicated reviewer path, not the generic MCP dispatch).

Full MCP tool dispatch is on the v0.4.16 roadmap.

### 🟢 C11 (P2 reliability) — stream idle timeout

Both streaming pipelines (Anthropic `MessageStream` and OpenAI SSE
loop) now wrap `response.chunk().await` in `tokio::time::timeout`,
configurable via `ARIS_STREAM_IDLE_TIMEOUT_SECS` (default `120`,
clamped to `[10, 1800]`; setting `0` or a negative value disables the
timeout). On idle the stream takes the same path as a mid-body
abort: restart the request if no meaningful content has been emitted
yet (Anthropic gates on `has_emitted_meaningful_content`, OpenAI on
`nothing_emitted_yet()`), otherwise return an idle-timeout error.

Closes the "aris hangs forever with no output" symptom when an upstream
HTTPS proxy holds a connection open without sending keepalives. The
parsed-env helper has 9 unit cases covering default, valid, clamp
bounds, zero/negative, parse failure, and edge boundaries.

### 🟢 H11 (P2 trivial) — sync script hint version bump

`tools/sync_main_skills.sh` final hint and inline NOTE both rolled
from `v0.4.11` (when the sync infrastructure first landed) to
`v0.4.13` (current bundle generation). Cosmetic.

### Late bundle sync (post-release `357a418`)

Tag `v0.4.14` also includes a same-day sync to main HEAD
[`7e3ab67`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/commit/7e3ab67)
that picks up:

- `tools/meta_opt/check_ready.sh` upstream fix — extracts `"ts"`
  field with `match()` before comparison (closes the same `$0 > ts`
  always-true bug ARIS-Code flagged in v0.4.13 audit followup, plus
  a pre-existing `grep -c X || echo 0` two-line-output crash that
  ARIS-Code's first patch hadn't caught — main's codex-round-1 did).
- New `/wiki-enrich` skill (fills paper TODO sections left by
  `ingest_paper`).
- Two minor SKILL.md / script refreshes (`auto-review-loop-llm`,
  `render-html`).

Bundle inventory: 76 → **77 skills**, 54 helpers unchanged. All 9
cache drift tests pass; `SKILLS_SOURCE_COMMIT` pin updated.

### Test inventory

`cargo test -p runtime --lib`: 117 passed (3 new prompt tests +
existing 9 v0.4.13 regression backfill).
`cargo test -p api --lib`: 19 passed (1 new stream-idle helper test).
`cargo test -p aris-cli`: 77 passed.
`cargo test -p tools --lib`: 35 passed.
`cargo test -p commands --lib`: 5 passed.

### Excluded from v0.4.14

Three items from the audit are deferred to follow-up releases by design
(see `idea-stage/v0.4.14/audit-followup-plan.md`):

- **P7 ProviderFamily resolver** centralization (5+ scattered
  `contains()`/`provider_match()`/`EXECUTOR_PROVIDER==openai` /
  `starts_with()` checks) — v0.4.15, scoped as a real refactor not a
  hotfix.
- **P8 Subagent provider parity** (`build_agent_runtime()` always
  binds `AnthropicRuntimeClient`) — v0.4.15.
- **Hook schema preservation** (matcher/timeout/async fields
  currently dropped) + **MCP manager production wiring** (M1/M2 real
  fix) — v0.4.16.

OpenSSL → rustls switch (L1), full sandbox hardening (S1-S6), JSON
parser standardization (C10), and provider abstraction trait remain
v0.5.0 scope. Per the v0.4.14 audit-followup plan.

## v0.4.13 (2026-05-25)
- Release: [`v0.4.13`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.13) · [PR #40](https://github.com/zhuyingqin/Aris/pull/40) · published 2026-07-10

A residue-cleanup release closing every codex-audit P1 left over from
v0.4.10 through v0.4.12 plus the long-tail regression tests. No
headlining new feature — the goal is to make the existing per-server
MCP / hook / streaming code paths actually behave the way the docs
already say they do.

### 🟡 v0.4.10 audit P1.D — per-server MCP timeout

`McpStdioServerConfig` gains `request_timeout_secs: Option<u64>`,
parsed from `settings.json` as `mcpServers.<name>.requestTimeoutSecs`.
Per-server override > `MCP_REQUEST_TIMEOUT_SECS` env > 300 s default,
clamped 1..=1800 s. Useful when one Codex MCP agent legitimately
needs 5 min while a filesystem MCP must error out in 5 s — the
global env couldn't serve both.

### 🟡 v0.4.10 known limitation — JSON-RPC notifications skip

`McpStdioProcess::request()` now skips frames with absent / null
`id` (JSON-RPC notification semantics, used by `notifications/log` /
`notifications/progress`), prints
`aris mcp: notification skipped: method=…` to stderr, and continues
reading until the correlated response arrives. id-mismatch on a
response frame is still fatal (kills the child).

### 🟢 meta_opt hook deploy via `aris init`

`tools/meta_opt/{log_event,check_ready}.sh` are now bundled. `aris
init` deploys them to `~/.claude/hooks/` as
**`aris-meta-opt-log-event.sh`** and **`aris-meta-opt-check-ready.sh`**
(ARIS-namespaced — codex round-1 #1 caught that plain names would
silently clobber user hooks). Entries are merged into
`~/.claude/settings.json`'s `hooks.PostToolUse` /
`PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` /
`SessionEnd` array (de-duped against existing — idempotent).
Backups go to `settings.json.bak.<unix-millis>` with hard-fail
semantics (codex round-1 #2: never silently destroy state). Final
rewrite is atomic via tempfile + rename.

### 🧪 v0.4.12 targeted regression coverage (9 new tests)

Codex's v0.4.12 round-3 left a debt of "no targeted tests for the new
fixes". Closed here:

- `sandbox::tests`: `strict_mode_overrides_llm_disable`,
  `strict_mode_ignores_all_five_llm_overrides`,
  `default_non_strict_honors_llm_overrides`
- `config::tests`: `parses_sandbox_strict_mode`
- `usage::tests`: `provider_match_distinguishes_real_vs_userdefined`
- `openai_executor::tests`: `word_match_handles_provider_prefixes`,
  `is_stream_options_unknown_field_error_classification`
- `client::tests`: `event_is_meaningful_content_classification` +
  v0.4.13 `should_retry_on_premature_eof_truth_table` (codex round-1
  #3 closed the "end-to-end retry trigger" gap by extracting the
  5-condition retry guard into a pure fn so the truth table is
  directly testable without mocking `reqwest::Response`)
- `tools::tests`: `reviewer_word_match_provider_prefix`

### 📦 Skills source-of-truth Gemini fix (`origin/main`)

The `auto-gemini-3` MCP alias fix v0.4.11 and v0.4.12 had to re-apply
to the bundle after every `sync_main_skills.sh` run is now in
`origin/main` (`fedf361`): `skills/gemini-search/SKILL.md`
DEFAULT_MODEL + literal in the Gemini-search MCP call,
`skills/research-lit/SKILL.md` Gemini source MCP call. Next sync
stays correct. `SKILLS_SOURCE_COMMIT` advanced from `d5f450c` to
`fedf3612b696bd34f21d349d1859668983e6f4aa`.

### 📦 Bundle

`Embedded 76 bundled skills, 54 helper resources` (+2 from
`meta_opt/{log_event,check_ready}.sh`).

### 📐 Cross-model review

Codex MCP (gpt-5.5 xhigh):
- subagent dispatch + parallel implementation → 4 commits (plan +
  3 subagent outputs c7afa95 / ffff3fa / b8cbcbd)
- round-1 final diff: NO-GO + 3 findings (hook clobber, settings.json
  non-atomic + best-effort backup, missing EOF-retry regression test)
- round-2 (after `428b73f`): NO-GO + release-metadata-not-bumped —
  fixed in this commit
- round-3: post-bump confirmation pending

### ⚠️ Known limitations deferred to v0.4.14

- `tools/meta_opt/check_ready.sh` uses `awk '$0 > ts'` to filter
  events since the last optimize, which compares whole JSONL lines
  (start with `{`) against an ISO timestamp string and effectively
  always matches. The bundled file is byte-exact from `origin/main`,
  so the fix needs to go to main first then sync.
- #240 README chapter numbering / further compression.
- v0.5.0+ architectural work (provider abstraction, OpenAI Responses
  API, complete MCP transport stack, sandbox hardening).

## v0.4.12 (2026-05-22)
- Release: [`v0.4.12`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.12) · [PR #39](https://github.com/zhuyingqin/Aris/pull/39) · published 2026-07-09

A bug-fix + small-feature release polishing several rough edges that
surfaced in v0.4.10's Codex audit + community-reported issues since
v0.4.11 shipped. Headlining the sandbox-config priority fix (#238),
plus the four streaming/pricing P1 follow-ups deferred from v0.4.10.

### 🚨 P0 — user-reported bugs

- **#238 `sandbox.strictMode` config option** — `SandboxConfig` gains
  `strict_mode: Option<bool>` (parsed from `settings.json` as
  `sandbox.strictMode`). When `true`, `resolve_request()` ignores **all**
  LLM-supplied overrides — `dangerouslyDisableSandbox`,
  `namespaceRestrictions`, `isolateNetwork`, `filesystemMode`,
  `allowedMounts` — and uses only what the user configured. Closes the
  gap where a LLM could silently bypass the user's strict sandbox by
  passing `dangerouslyDisableSandbox: true`. Default is `false`
  (opt-in) for backward compatibility; explicitly set `strictMode: true`
  to hard-lock. The bash tool schema now documents this on the
  `dangerouslyDisableSandbox` field, and `aris doctor` reports the
  effective sandbox configuration. A one-shot per-process stderr
  warning fires when a strict config silently overrides an LLM request.

- **#232 `auto-review-loop-llm` DeepSeek deprecation** — Provider table
  and config examples updated from `deepseek-chat` / `deepseek-reasoner`
  to `deepseek-v4-flash` / `deepseek-v4-pro`. DeepSeek announced the
  legacy aliases deprecate 2026-07-24, and R1-class reasoner models
  reject `tool_choice` (which the auto-review loop requires). The
  `aris setup` reviewer menu was also updated.

### 🟡 P1 — v0.4.10 audit follow-ups (Codex GPT-5.5 xhigh)

- **P1.A Anthropic stream retry coverage** — `MessageStream` gains
  `has_emitted_meaningful_content: bool` next to the existing
  `events_emitted` counter. The whole-stream retry now triggers when
  no meaningful content has been emitted, not just when *no* event
  has. This means a stream that only sent `MessageStart` before EOF
  is now retry-eligible. Meaningful = non-empty text/thinking, any
  `InputJsonDelta`, any `ContentBlockStop`, or any `ContentBlockStart`
  for `ToolUse`/non-empty Text/non-empty Thinking. `ToolUse` start
  is conservatively counted (per Codex round-3) because the caller
  commits `pending_tool` state on receipt.

- **P1.B o-series reasoning effort detection (provider-prefixed)** —
  Both the executor (`openai_executor.rs::supports_reasoning_effort`)
  and the reviewer mirror (`tools/lib.rs::reviewer_supports_reasoning_effort`)
  now use word-boundary matching (boundary = `-_/:` + start/end).
  `openai/o3-mini`, `proxy:o4` and similar provider-prefixed names
  are now recognised. Previously `starts_with("o3")` missed them and
  the request omitted `reasoning_effort`.

- **P1.C `stream_options.include_usage` proxy fallback** — When the
  OpenAI executor's request returns `400` with an error body that
  fingers `stream_options` as an unknown/extra field (strict
  matcher: JSON `error.param.starts_with("stream_options")` OR body
  containing both `stream_options` and one of
  `unknown`/`unrecognized`/`extra`/`additional`/`unsupported`/
  `not allowed`/`invalid field`), the executor retries once without
  the field. Sacrifices prefix-cache token reporting for
  compatibility with compat-mode proxies. Real OpenAI, vLLM, SGLang,
  OpenRouter all accept `stream_options` so this only fires on
  noncompliant proxies.

- **P2 pricing match precision** — `runtime/usage.rs` switched from
  `contains()` to a new `provider_match()` helper for `kimi`,
  `moonshot`, `mimo`, `qwen`, `glm`, `minimax`, `doubao`. The new
  helper matches at the start of the model name or after a `/`/`:`
  provider separator. This catches `qwen3.6-plus`, `kimi-k2.5`,
  `glm-4-plus` etc. (which the boundary-based `has_word` would have
  missed because digits aren't word boundaries), while rejecting
  mid-word matches like `my-kimi-clone`.

### 🔧 v0.4.11 follow-ups

- **`build.rs` skills-codex glob** — `EXCLUDED_SKILL_PREFIXES` exact
  match list collapsed to a single `EXCLUDED_SKILL_PREFIX = "skills-codex"`
  with `starts_with()` semantics. Future `skills-codex-*` mirror
  variants are now auto-excluded without code change.

- **`build.rs` ALLOWED_EXTS gains `html`** — Required because the
  newly bundled `/render-html` skill ships `.html` template files
  under `skills/render-html/scripts/templates/`. Without this, the
  templates didn't make it into the binary and `/render-html
  --template academic` would fail at runtime.

- **CI `fetch-depth: 0` + origin/main fetch** — Both `ubuntu` and
  `macos` jobs in `.github/workflows/ci.yml` now do a full-depth
  checkout and explicitly fetch `origin/main` so the
  `skills_source_commit_pin_present_and_well_formed` drift test's
  optional ancestor check actually runs in CI (was silently skipping
  before due to shallow checkout).

### 📦 Skills sync追新

`SKILLS_SOURCE_COMMIT` advanced from v0.4.11's `ed638f3` to the
current `main` HEAD. Inventory:

- **Bundle skills**: 74 → 76 (+`/interview-cheatsheet`, +`/render-html`)
- **Helper resources**: 49 → 52 (+`render_html.py`,
  +`academic.html`, +`dashboard.html` under
  `skills/render-html/scripts/`)
- **Gemini MCP alias re-applied** — `gemini-search` and `research-lit`
  v0.4.11's `auto-gemini-3` patch was reverted by sync (rsync
  `--delete` overwriting hand-patched files). Re-applied; main-branch
  PR pending.

### 📐 Cross-model review

Codex MCP (gpt-5.5 xhigh) reviewed four rounds:
- round-1: plan v1 → GO-WITH-CAUTION + 8 findings → plan v2
- round-2: plan v2 → GO-WITH-CAUTION + 3 implementation precision
  findings → plan v3
- round-3: final diff → NO-GO + 5 findings → all addressed
  (`ContentBlockStart::ToolUse` conservative classification,
  Cargo/CHANGELOG/README version bump, untracked new skills tracked,
  doctor multi-field detection, setup UI DeepSeek alias fixed)
- round-4: post-fix confirmation → GO

Plan committed at `idea-stage/v0.4.12/plan.md` (round-1/2/3 review
history recorded inline as `v2 修订` / `v3 修订` sections).

### ⚠️ Known limitations deferred to v0.4.13

- P1.D per-server MCP timeout (per-`ScopedMcpServerConfig` field)
- JSON-RPC server notifications (`id == null` skip) in `mcp_stdio.rs`
- `meta_opt/{log_event,check_ready}.sh` hook deploy via CLI init
- #240 README章节层级 + 进一步精简
- Comprehensive new-fix unit tests (current coverage: cache 9/9 +
  sandbox 5/5 pass, but P1.A/B/C/P2/#238 changes don't yet have
  targeted regression tests)

## v0.4.11 (2026-05-18)
- Release: [`v0.4.11`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.11) · [PR #38](https://github.com/zhuyingqin/Aris/pull/38) · published 2026-07-09

The skills bundle refresh / research workflow sync release. The binary
runtime behaviour is essentially unchanged from v0.4.10 — what shipped
new is the **embedded skills set** catching up to the current state of
the `main` skills branch. Closes the gap that built up during the
v0.4.5 → v0.4.10 maintenance cycle (only ~6 of 56 main commits in
`skills/` had been cherry-picked into the bundle).

### 📦 Bundle inventory

**Embedded skills**: 65 → 74 user-facing skills (+10 new, refreshed
46 existing SKILL.md files). New skills:

- `/citation-audit` — fourth-layer bibliography audit (existence +
  metadata + cited-context coverage)
- `/experiment-queue` — SSH job queue for multi-seed / multi-config
  experiments with OOM-aware retry, stale-screen cleanup, wave
  transitions
- `/gemini-search` — Gemini-backed broad literature discovery
- `/kill-argument` — two-thread adversarial review (reject memo →
  defence → unresolved critical issues)
- `/openalex` — OpenAlex API source for open citation graph + funding
- `/overleaf-sync` — two-way sync between local paper directory and
  an Overleaf project via the Git bridge (token-safe via Keychain)
- `/paper-talk` — end-to-end conference talk pipeline (outline →
  Beamer + PPTX → per-page polish → assurance)
- `/qzcli` — manage Qizhi (启智) platform GPU jobs (kubectl-style)
- `/resubmit-pipeline` — W5 workflow: text-only paper resubmit to a
  different venue under hard constraints + kill-argument gate
- `/slides-polish` — per-page Codex review + targeted python-pptx /
  Beamer fixes for academic talk slides

**Embedded helpers**: 34 → 49 helper resources. tools/ goes 9 → 18:
the 9 baseline helpers are *refreshed* (notably `research_wiki.py`
grew 315 → 767 lines with the canonical `ingest_paper` API) and 9
new helpers ship for the new skills:

- `extract_paper_style.py` — used by 7 paper-series skills when
  `— style-ref: <source>` is passed
- `figure_renderer.py` — used by `/figure-spec`
- `paper_illustration_image2.py` — used by `/paper-illustration-image2`
- `overleaf_setup.sh` + `overleaf_audit.sh` — `/overleaf-sync`
  Premium-feature integration
- `verify_wiki_coverage.sh` — wiki coverage helper
- `watchdog.py` — `/experiment-queue` watchdog
- `experiment_queue/build_manifest.py` +
  `experiment_queue/queue_manager.py` — `/experiment-queue`
  orchestration

`shared-references/` gains `assurance-contract.md` and
`wiki-helper-resolution.md`; the existing 5 shared references all
refreshed.

### 🔧 Sync infrastructure (new)

- `tools/sync_main_skills.sh` — automated rsync from `origin/main`
  with symlink pre-flight, deterministic codex-mirror prune,
  full-helper whitelist, source-commit SHA pinning.
- `crates/runtime/assets/SKILLS_SOURCE_COMMIT` — records the main
  commit that this bundle was rsync'd from, so drift between
  releases can be tracked.
- New CI drift tests in `crates/runtime/src/cache.rs`:
  - `skills_source_commit_pin_present_and_well_formed` — hard-fails
    if the source-commit file is missing or malformed; best-effort
    ancestor check when `origin/main` is resolvable.
  - `skill_md_aris_tools_and_repo_refs_resolve_to_bundled` —
    extends existing inventory test to `.aris/tools/<helper>` and
    `${ARIS_REPO}/tools/<helper>` resolver patterns (codex
    round-3 caught these were uncovered).
  - `skill_md_cross_skill_references_bundled_warn_only` —
    warn-only scan for inter-skill `/<name>` references; run with
    `-- --nocapture` to see the warnings.

### 🔧 Gemini alias correction

`research-lit/SKILL.md` Gemini MCP call now passes
`model: 'auto-gemini-3'` instead of the historical `gemini-2.5-pro`
(silently routed through OAuth-personal capacity exhaustion since
gemini-3 GA). The 5 references in `paper-illustration/SKILL.md`
are direct REST URLs (`generativelanguage.googleapis.com/...`)
where `auto-gemini-3` is not a server-side model ID, so those
stay on the explicit `gemini-3-pro-preview` / `gemini-3-pro-image-preview`.

### ⚠️ What did NOT change in v0.4.11

- **No CLI runtime / API client changes.** v0.4.10 audit's 4 P1
  follow-ups (Anthropic stream retry coverage, o-series reasoning
  effort, OpenAI `stream_options` proxy fallback, per-server MCP
  timeout) are still pending — pushed to v0.4.12.
- **No reviewer default change.** `gpt-5.5` has been the CLI
  default since v0.4.5 (commit `87e1088`); main's `d43d77a`
  brought `skills/` docs in line with that, so the bundle now
  consistently shows `REVIEWER_MODEL = gpt-5.5` in SKILL.md
  examples. Users who pin `ARIS_REVIEWER_MODEL=gpt-5.4` continue
  to override unchanged.
- **No `meta_opt/` hook bundling.** `tools/meta_opt/log_event.sh`
  and `check_ready.sh` are SessionEnd hooks that need a deploy
  mechanism, not on-demand extraction. Deferred to v0.4.12
  alongside a CLI hook-install path.
- **No skills-codex mirror in binary.** The 3 `skills-codex*/`
  directories in main are for the Codex CLI agent install path,
  not user-facing skills. `build.rs` already excludes them and
  `sync_main_skills.sh` prunes them post-rsync.

### 📐 Cross-model review

Codex MCP (gpt-5.5 xhigh) reviewed every step:
- round-1 (plan): REQUEST CHANGES (8 findings)
- round-2 (plan v2): APPROVE WITH NITS (7 nits)
- round-3 (plan + sync_script + drift_tests drafts): NO-GO
  (5 blocking findings — missing baseline helper refresh,
  incomplete drift coverage, fetch race, draft notation,
  stale paths)
- round-3.5 (after fixes): GO with 4 watch-outs (all addressed)

Three drift-test cross-skill warnings remain (informational, warn-only
test). They are not bundle misses:

- `/experiment-bridge -> /codex` — refers to the `mcp__codex__codex`
  MCP tool name, not an ARIS skill (regex false positive).
- `/paper-compile -> /codex` — same.
- `/kill-argument -> /peer-review` — `/peer-review` is a planned
  v0.5.0+ skill, intentionally referenced in the rebuttal pipeline
  before it ships.

## v0.4.10 (2026-05-17)
- Release: [`v0.4.10`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.10) · [PR #37](https://github.com/zhuyingqin/Aris/pull/37) · published 2026-07-08

The stream + MCP reliability release. Closes three classes of stalls
and degraded UX users reported against v0.4.8 and v0.4.9: the
`#228`-style "error decoding response body" mid-stream loop, the
`#151` / `#172` "Calling codex..." MCP hangs, and silently inaccurate
cache / cost reporting after v0.4.5+ when more providers were added.

### 🚨 Fix (streaming reliability — C6)

- **Whole-stream restart on chunk abort / premature EOF** —
  `MessageStream::next_event` (Anthropic) and the OpenAI executor's
  SSE loop now both detect (a) chunk decode failure mid-flight and
  (b) Ok(None) before any terminal sentinel (`MessageStop` /
  `[DONE]`), and restart the *whole request* from scratch. Restart
  budget is `ARIS_STREAM_RETRY` (default 2, clamped 0..=5 via
  `u32.min(5) as u8`), and only fires when `events_emitted == 0` so
  the user never sees torn output. Backoff is 500 ms between
  attempts. `stream_chunk_error_is_retryable()` predicate gates on
  `is_request / is_connect / is_timeout / is_body / is_decode`.

### 🚨 Fix (MCP stdio reliability — M3)

- **Default 300 s read timeout via `tokio::time::timeout`** wrapping
  both `send_request` and `read_response`. Override via
  `MCP_REQUEST_TIMEOUT_SECS` env, clamped to 1..=1800 s. Default
  raised from the codex-audit-suggested 60 s to 300 s because the
  most common MCP servers users wire in are agent-style (codex,
  oracle) and 60-180 s of model think time before the first
  response byte is normal.
- **`response.id ↔ request.id` correlation check**. Mismatch returns
  `InvalidData` and kills the child so the connection respawns
  clean.
- **Dead-process detection in `ensure_server_ready()`** via
  `try_wait()`. Crashed / OOM-killed / timed-out MCP servers are
  transparently respawned on the next call instead of stalling on a
  dead pipe.
- **All failure paths use `kill().await`** (not `start_kill()`) so
  the child is reaped, no zombie window where the manager could see
  `Ok(None)` from `try_wait` and reuse a poisoned pipe.
- 3 new regression tests:
  `rejects_response_with_mismatched_id`,
  `times_out_when_server_does_not_respond`,
  `manager_respawns_dead_server_on_next_discovery`.
- Known limitation deferred to v0.4.11: server-initiated JSON-RPC
  notifications (`notifications/log`, `notifications/progress`)
  are currently treated as invalid responses; a read loop that
  skips frames without an `id` until the correlated response
  arrives is the v0.4.11 follow-up.

### 🚨 Fix (cache token accounting — C8 / P4)

- **OpenAI streaming requests** now include
  `stream_options: { include_usage: true }`. Without this the SSE
  default omits the usage block entirely. The chunk parser now
  reads `prompt_tokens_details.cached_tokens` and routes it to
  `cache_read_input_tokens` so REPL prompt-cache reporting works
  for gpt-5.5 / gpt-5.4 / -mini.
- **Anthropic streaming** stashes `MessageStart.message.usage`
  (carries `input_tokens` + `cache_read_input_tokens` +
  `cache_creation_input_tokens`) and merges it with
  `MessageDelta.usage.output_tokens` at end-of-stream. Previously
  only the delta was read, so the input/cache halves were silently
  dropped.
- `Usage` struct fields are now `#[serde(default)]` so Anthropic's
  partial usage payloads (e.g. delta carrying only output) parse
  cleanly without losing the surrounding event.

### ✨ Feature (multi-provider pricing registry — C9)

`pricing_for_model()` extended from "Sonnet + Opus default" to a
full registry:

- **OpenAI**: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano,
  gpt-4o, gpt-4o-mini, o1, o3, o4 — cache_read = input × 0.1
  per the actual OpenAI prefix-cache discount (previously the
  generic fallback used 50%, overstating savings 5×).
- **Gemini**: 2.5-pro, 2.5-flash, 2.0-flash.
- **DeepSeek**: V3 / V4 (cache_read 0.07) and R1 / reasoner
  (cache_read 0.14), with explicit cache-hit vs cache-miss tiers
  per DeepSeek's published rates.
- **OSS / regional**: GLM, MiniMax, Kimi / Moonshot, MiMo, Qwen,
  Doubao.
- `has_word()` boundary matcher treats `-_/:` as word boundaries
  so `openai/o3-mini`, `provider/gpt-5.5-turbo`, and
  `anthropic-compat/claude-sonnet-4.5` route to the right tier.
- Helpers `openai_pricing(input, output)` and `generic_pricing()`
  factor out the common cache-read tier maths.

### 🧹 Cleanup

- **Nine dead-code warnings cleared** across the workspace:
  `aris setup` removed `run_setup()` + `configure_codex_mcp()`
  (these advertised "install skills, configure MCP" but only
  routed to `config::run_interactive_setup`); deleted
  `has_executor_key()`, `buf_display_width()`,
  `chat_completions_url()`; renamed `error` → `_error` in
  `runtime::config` legacy branch.
- **`aris setup` user-facing strings** synced with actual
  behaviour: help text now says "Configure API keys / model /
  language (interactive)" and doctor's MCP-not-configured branch
  points users at `~/.claude.json` direct edit or
  `claude mcp add`.
- `cargo fmt` over the seven v0.4.10-touched files (other
  baseline drift left alone so this release stays scoped).

### 🧪 Tests

- `cargo test -p runtime --lib mcp_stdio --test-threads=1`: 16
  passing (13 pre-existing + 3 M3 regressions).
- Pre-existing macOS-only `api` crate `PoisonError` test residuals
  are unchanged (Linux CI clean).

### 📐 Cross-model review

Codex MCP (gpt-5.5 xhigh) reviewed every step plus a final
`v0.4.9..HEAD` cross-cutting audit. Verdict: READY TO SHIP.
Four P1 follow-ups (Anthropic retry coverage, o-series
reasoning-effort detection, `stream_options` proxy fallback,
per-server MCP timeout) and one P2 (pricing substring matchers)
are captured in `idea-stage/v0.4.10/v0.4.11_followups.md`.

## v0.4.9 (2026-05-17)
- Release: [`v0.4.9`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.9) · published 2026-07-06

The "v0.4.8 second half" release — closes the three Codex v0.4.7
cross-cutting audit residuals (L1 TLS double-stack, L3 reasoning
cache misalignment, L4 reasoning replay unbounded + no provider
gate), syncs two missing main-branch skills with `scripts/`
helpers, promotes `research_wiki.py` to the shared `tools/`
namespace, finishes the SKILL.md fallback-chain migration started
in v0.4.8, and lays down the regression test surface that v0.4.8
had deferred.

### 🚨 Fix (Codex T16 audit residuals)

- **L1: TLS double-stack** — `crates/tools/Cargo.toml` switches reqwest
  features from `rustls-tls` to `native-tls`. Now all three reqwest
  consumers (`api`, `aris-cli`, `tools`) use platform TLS uniformly.
  Previously v0.4.7 #225 only switched `api` + `aris-cli`, leaving
  the `LlmReview` reviewer path on the rustls fingerprint and
  DashScope-class endpoints still 405-able via reviewer. `cargo
  tree -i hyper-rustls` now returns "did not match any packages".
  `.github/workflows/release.yml` gains a Linux-only step that
  installs `libssl-dev` + `pkg-config` for openssl-sys's
  compile-time headers.

- **L3: reasoning_cache compaction misalignment** — `ApiClient` trait
  gains `on_session_compacted(removed_count)` default-no-op.
  `maybe_auto_compact()` in `crates/runtime/src/conversation.rs`
  notifies the client after replacing the session.
  `OpenAIRuntimeClient` clears its message-index-keyed
  `kimi_reasoning_cache` on compaction so re-injected reasoning
  aims at the right turn after the index shift.

- **L4: reasoning replay no cap + no gate** — Two changes:
  (a) split predicate `supports_reasoning_content_replay` as a
  superset of `supports_reasoning_effort` (adds Kimi / Moonshot /
  Xiaomi MiMo / DeepSeek-R1 — providers that emit reasoning_content
  but don't accept reasoning_effort as a request field, which is
  the reason this cache exists). (b) Per-turn cap
  `MAX_REASONING_CHARS_PER_TURN = 32_000` (UTF-8-safe char-boundary
  truncate) + total cap `MAX_REASONING_CACHE_TOTAL_CHARS = 128_000`
  with oldest-eviction. Drops vestigial `supports_reasoning: bool`
  parameter from `convert_messages_openai`.

### 🆕 Skill helper subsystem completion

- **Bundle 2 new skills with `scripts/` subdir**: `/figure-spec`
  (`scripts/figure_renderer.py`, 29.9KB) and `/paper-illustration-image2`
  (`scripts/paper_illustration_image2.py`, 8.7KB). Both follow
  main-branch ARIS's Phase 3 Arch C ("single-owner helpers in
  `skills/<owner>/scripts/`"). Their SKILL.md resolvers gain a new
  **Layer 0b**: `$ARIS_CACHE_DIR/skills/<name>/scripts/<helper>.py`,
  the primary path under the aris-code single-binary distribution.
  Bundle inventory: 64 skills + 36 helpers (was 62 + 34 in v0.4.8).

- **Promote `research_wiki.py` to shared `tools/`** — used by 9+
  skills (idea-creator, research-lit, result-to-claim, future
  `/research-wiki` redesign). Moved from `skills/research-wiki/`
  to `tools/research_wiki.py` so the policy table in
  `shared-references/integration-contract.md` correctly classifies
  it as "shared cross-skill helper" per the Repo A contract.
  14 callsites across 3 SKILL.md updated to
  `python3 "${ARIS_CACHE_DIR:-.}/tools/research_wiki.py"`.

- **5 more SKILL.md migrated to 4-layer fallback chain**:
  `/exa-search` (Policy A — gate), `/semantic-scholar` (Policy D1 —
  primary cascade to inline-urllib fallback), `/arxiv` (Policy D1 —
  expanded inline-Python candidate list with `$ARIS_CACHE_DIR`),
  `/idea-creator` (5 callsites). `/research-lit` + `/deepxiv`
  migrated in v0.4.8.

### 🧪 Tests (closes the v0.4.8 deferred T9-T12 work)

- **`cache::tests::bundle_inventory_skill_md_refs_resolve_to_bundled_resources`**
  (cargo test, every CI invocation). Scans every `BUNDLED_SKILLS`
  prompt for `$ARIS_CACHE_DIR/<key>` and bare `python3
  tools/<helper>.{py,sh}` references; asserts every captured key
  exists in `BUNDLED_RESOURCES`. Closes the H6 regression class.

- **`idea-stage/v0.4.9/skill_helper_smoke.sh`** — release-binary
  smoke test in isolated `$HOME`/`$cwd`: validates cache layout, 9
  shared helpers present, each Python helper passes `python3 -m
  py_compile`, shell helpers pass `sh -n`, and **cwd has zero
  pollution** (H6 regression guard: v0.4.7 wrote helpers to
  `cwd/<skill_name>/`).

### Provenance

- 8 commits, all individually reviewed by Codex 5.5 xhigh. Final
  audit (T30) caught one **Hold** blocker — the new figure-spec /
  image2 skills used Repo A's `$CLAUDE_SKILL_DIR` resolver which
  doesn't exist under the aris-code bundle. Fixed by adding Layer 0b.
  Final ship verdict: **B / ship** (not A because provider routing
  split + Responses API support are v0.5.0 work; not a v0.4.9
  blocker).

## v0.4.8 (2026-05-17)
- Release: [`v0.4.8`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.8) · published 2026-07-02

The skill-helper subsystem rewrite. v0.4.7 was the last release where bundled helper scripts (`tools/*.py`, `templates/*.tex`) extracted into the user's current working directory and where SKILL.md files hardcoded `python3 tools/foo.py` paths that frequently silent-exit-2'd because `tools/` didn't exist there. v0.4.8 materialises the bundle into a versioned global cache (`~/.config/aris/cache/<version>/`), surfaces the materialisation report to the model on every Skill invocation, and ships a four-layer fallback chain documented in a new integration contract. Plus two community-reported bug fixes that landed on the way through.

### 🚨 Fix

- **gpt-5.5 / o3 / o4 + tools 400 on OpenAI** ([executor 400 bug](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues)) — Switching the executor to gpt-5.5 (or o3/o4) on `api.openai.com` caused immediate `OpenAI API error 400: Function tools with reasoning_effort are not supported for gpt-5.5 in /v1/chat/completions. Please use /v1/responses instead`. The intersection of `tools` + `reasoning_effort` + reasoning-model on the chat-completions endpoint is server-rejected. v0.4.5 added `reasoning_effort='xhigh'` for executor without realising the executor always sends `tools` (agent loop), and the bug shipped silent for reviewer because the LlmReview path doesn't send tools. v0.4.8 strips `reasoning_effort` on the gated path (gpt-5.5/5.6/o3*/o4* + tools + api.openai.com), with a one-shot stderr warning explaining the gate. Override via `ARIS_FORCE_REASONING_WITH_TOOLS=1` for compatible third-party proxies. Proper fix (OpenAI Responses API support) tracked for v0.4.9.

- **Custom reviewer reset to gpt-5.5 every restart** (Windows-reported community bug) — `/setup` Custom reviewer (menu option 9) didn't persist `reviewer_model` because the model-selection branch in `config.rs` checked `reviewer_choice == "8"` (which is "Skip"), not `"9"`. Custom fell through to the else branch and set `reviewer_model = Some("")`, which round-tripped through config.json and reset the reviewer on every launch. Three layered fixes: (1) `config.rs:577` corrected to `"9"`, (2) `LlmReview` custom branch refuses to fall back to gpt-5.5 when the user has a Custom provider but model is empty — returns a clear error pointing to `/setup`, (3) `/reviewer` menu now shows "Custom reviewer configured" with current endpoint and model instead of the misleading "No reviewer API key found" error when items list is empty.

### 🆕 New — skill-helper subsystem rewrite

- **Global versioned cache** at `~/.config/aris/cache/<CARGO_PKG_VERSION>/` (Windows: `%USERPROFILE%\.config\aris\cache\<version>\`) — bundled helpers extract here at startup, not into cwd. `runtime::ExtractionReport` captures `extracted` / `failed` / `paths_tried` / `hard_error`; stored once in a `OnceLock` and accessible via `runtime::extraction_report()`. Atomic-replace via tmp-then-rename (Unix atomic, Windows first-writer-wins with content equality check — same bundle bytes = success). Falls back to `std::env::temp_dir()/aris-cache-<version>/` if home cache unavailable. Sets `$ARIS_CACHE_DIR` to the actually-used directory (or unsets it if both home and temp failed), forward-slash normalised for cross-platform shell compatibility.

- **`SkillOutput.helperReport` field** — every Skill tool invocation now returns per-skill scoped extraction report (cache dir, available helpers with absolute paths, failed helpers with error messages, `cacheUsable` flag). Runtime injects a resolver-chain preamble in front of the SKILL.md prompt text so the model sees the four-layer fallback explicitly: active skill dir → `~/.config/aris/<bundle-key>` → `$ARIS_CACHE_DIR/<bundle-key>` → project workspace. Forward-slash normalised paths on Windows for shell compatibility.

- **`/skills export` now copies bundled helpers** along with SKILL.md. Previously only the SKILL.md was exported; the filesystem skill then took precedence over the bundled one but lost its helpers (templates/, scripts/, etc.) — a silent regression. Now iterates `BUNDLED_RESOURCES` filtered by `skills/<canonical_name>/` prefix, preserves subdirectory structure, skips files that already exist (user edits survive re-export). Case-insensitive `find_skill_content` matching is now resolved to the canonical bundled name BEFORE building the export prefix, so `/skills export Research-Wiki` correctly lands at `~/.config/aris/skills/research-wiki/` with all helpers.

- **8 shared cross-skill helpers bundled** into `assets/tools/`: `arxiv_fetch.py`, `deepxiv_fetch.py`, `exa_search.py`, `semantic_scholar_fetch.py`, `openalex_fetch.py`, `save_trace.sh`, `verify_papers.py`, `verify_paper_audits.sh`. Synced from main-branch ARIS. `BUNDLED_RESOURCES` count now 34 (17 shared-references + 9 skill-local + 8 shared tools).

- **`shared-references/integration-contract.md`** — new canonical document for SKILL authors. Defines the 4-layer resolver chain and 6 failure policies (A gate / B side-effect / C forensic / D1 cascade / D2 multi-source / E diagnostic) for binding helper invocations to the cost of their silent failure. Adapted from main-branch ARIS contract but rewritten for aris-code's bundled-binary distribution. Skills authored after v0.4.8 should declare the policy of every helper invocation alongside the resolver block.

- **`/research-lit` and `/deepxiv` migrated** to the canonical fallback chain as proof-of-concept (Policy D2 for /research-lit's three fetchers, D1 primary cascade for /deepxiv). The runtime resolver preamble covers other SKILL.md files in the meantime; full SKILL.md sweep (5+ remaining) tracked for v0.4.9.

### 🛠 Build / internals

- **build.rs recursive walk** — replaces flat `fs::read_dir` with `walkdir` traversal under `assets/tools/` and `assets/skills/<name>/`, preserving subdirectories. Strict namespace migration to three prefixes: `tools/<rel>`, `skills/<name>/<rel>`, `shared-references/<rel>`. Symlinks rejected at every level (top-level `assets/`, SKILL.md, recursive entries). WalkDir errors panic instead of silently filtering. Allow-listed extensions: `md`, `py`, `sh`, `tex`, `cls`, `bst`, `toml`, `yaml`, `yml`, `json`. 512KB per-file cap (allow-listed files exceeding cap panic at build time; never silently skipped). Sanitised OUT_DIR filenames include hash prefix to defeat key collisions.

- **`skills-codex*` review-snapshot mirrors excluded** from BUNDLED_RESOURCES — `skills-codex/`, `skills-codex-claude-review/`, `skills-codex-gemini-review/` were accidentally getting README.md emitted into the bundle. They're review-format mirrors of the same skills, not user-facing — removing the noise saves ~thousands of would-be-entries if recursion were enabled. Users wanting them can clone the repo and copy under `~/.config/aris/skills/`.

- **`paper-write/templates/`** (8 LaTeX files including 275KB IEEEtran.cls) now bundled correctly. The flat scanner in v0.4.7 silently dropped them; v0.4.8's recursive walker picks them up under `skills/paper-write/templates/` key prefix.

### 🧹 Cleanup

- **`bundled_resource()` vestigial getter** in `runtime/lib.rs` deleted. Zero workspace references (consumers iterate `BUNDLED_RESOURCES` directly). 9 lines down.

- **`extract_bundled_helpers()` cwd-based extractor** in `tools/src/lib.rs` deleted. Startup eager extract via `runtime::extract_bundle` replaces it cleanly; cwd pollution gone.

### Credits

- Two community bug reports: gpt-5.5+tools 400 (executor) and Custom-reviewer-resets-to-gpt-5.5 (Windows). Thank you for the reproduction steps.

## v0.4.7 (2026-05-16)
- Release: [`v0.4.7`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.7) · published 2026-07-01

A community-driven release. [@GetIT-Sunday](https://github.com/GetIT-Sunday) followed through on the v0.4.5 commitment to land DashScope Coding Plan support and added a nice reasoning-content generalization on top of v0.4.5's `reasoning_effort='xhigh'` work. Bundled with a sweep of pre-rename dead code and a legacy branding cleanup.

### Fix

- **DashScope Coding Plan returning 405 ([#159](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/159))** — Switched reqwest's TLS backend from `rustls-tls` to `native-tls` for the `api` and `aris-cli` crates, plus added a DashScope Coding Plan endpoint hint in `/setup`. `native-tls` uses platform TLS (SecureTransport on macOS, OpenSSL on Linux, SChannel on Windows), which DashScope's Coding Plan endpoint accepts where rustls did not. Credit [@GetIT-Sunday](https://github.com/GetIT-Sunday) ([#225](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/225)).
- **Hardcoded `user_agent("aris/0.4.5")` follow-up** — Now derived from `CARGO_PKG_VERSION` at build time so it tracks the binary version automatically.

### New

- **`reasoning_content` replay for all reasoning-capable providers**, not just Kimi — Previously the assistant-message replay cache that preserves multi-turn reasoning traces was gated behind an `is_kimi` check. Generalized so OpenAI o1/o3/o4-family, DeepSeek-R1, and any future reasoning model that returns `reasoning_content` keeps its chain-of-thought visible across turns. Pairs with v0.4.5's `reasoning_effort='xhigh'` (request-side) — together they make multi-turn reasoning conversations actually coherent. Credit [@GetIT-Sunday](https://github.com/GetIT-Sunday) ([#226](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/226)).

### Cleanup / removed

- **Dead-code removal**: `crates/runtime/src/sse.rs` (128-line generic SSE parser never wired in — `runtime/lib.rs` had no `mod sse`), `crates/aris-cli/src/app.rs` + `crates/aris-cli/src/args.rs` (398 + 108 lines of `rusty-claude-cli` prototype code with no references). Each verified by Codex audit before deletion (zero workspace references).
- **Dropped unused `rustyline = "15"` dependency** from `aris-cli/Cargo.toml`. The interactive editor in `input.rs` has used `crossterm` for several versions; the rustyline crate was scaffolding never consumed.
- **User-facing "Claw Code" → "ARIS-Code" rebranding** in three strings the user actually sees: the `.gitignore` section title written by `aris init`, the `CLAUDE.md` template body line, and the `Config` tool description (LLM-visible). Deliberately did **not** rename `CLAWD_*` env vars, the `claw-code-guide` subagent type string, or the `compat-harness` upstream vendor paths — those are API surface and need a separate v0.5.0 transition with `ARIS_*` aliases.

### Docs

- `compat-harness` crate header doc clarifying it is a static manifest extractor (driven by `aris dump-manifests`), not a runtime regression harness.

### Credits

- [@GetIT-Sunday](https://github.com/GetIT-Sunday) — native-tls for DashScope Coding Plan ([#225](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/225)) + reasoning_content for all providers ([#226](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/226)) — second contribution after the v0.4.5 Xiaomi/Qwen/Doubao cherry-pick

## v0.4.6 (2026-05-14)
- Release: [`v0.4.6`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.6) · published 2026-07-01

A small but high-impact follow-up to v0.4.5. Two critical fixes that were
shipping silently broken for multiple releases, plus a third community-driven
feature ([@Anduin9527](https://github.com/Anduin9527)'s reworked PR #221/#222
landing as a custom OpenAI-compatible provider).

### Fix

- **🚨 `PermissionMode::Prompt` was silently granting every tool** — The
  `PermissionMode` enum derived `Ord` with `Prompt` placed *above*
  `DangerFullAccess` (positions 4 vs 3), so the short-circuit
  `current_mode >= required_mode` inside `authorize()` was always true when
  the active mode was `Prompt`, and the prompter branch was unreachable.
  Users who explicitly chose "ask me before every tool" were getting silent
  approval for every request — the exact opposite of the intent. Fix splits
  the `Allow` short-circuit from the Ord comparison and excludes `Prompt`
  from the latter, with two new regression tests pinning the corrected
  behavior. ([permissions.rs:97-108](crates/runtime/src/permissions.rs#L97))
- **🚨 System prompt hard-coded `current_date = "2026-03-31"`** — Every
  conversation (main + subagent) injected that frozen date into the
  Anthropic system prompt via `ProjectContext::current_date`, so the model
  literally believed today was 2026-03-31 forever. Real data from later
  dates was rejected as "future / prompt injection" — including a user's own
  arXiv paper submitted after the cutoff, which the model loudly flagged as
  fabricated. Added `runtime::today_iso()` (reusing the existing
  chrono-free `days_to_ymd` algorithm) and threaded it through all 5 prompt
  call-sites (`aris-cli/main.rs:529, 2707, 2856, 3232`,
  `tools/lib.rs` subagent date). The `aris --version` "Build date" still
  uses the old constant — that one is *supposed* to be frozen.

### New

- **Custom OpenAI-compatible provider** (`/setup` option **11**, reviewer
  option **9**) — Plug ARIS into any OpenAI-compatible endpoint that isn't
  in the built-in menu: OpenRouter, self-hosted LLM gateways, internal
  inference servers, small Chinese vendors, etc. Stores `provider="custom"`
  internally but maps to the same OpenAI-compat HTTP path as the built-in
  presets at runtime, so existing routing / `reasoning_effort` allow-list
  still applies. Reviewer "Custom" uses `ARIS_REVIEWER_AUTH_TOKEN` /
  `ARIS_REVIEWER_BASE_URL` so it doesn't collide with the executor's
  `OPENAI_API_KEY`. Banner now reports "Custom" rather than mislabeling it
  as "OpenAI". Credit [@Anduin9527](https://github.com/Anduin9527)
  ([#221](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/221)).
- **Dynamic `/models` discovery for custom providers** — When the user
  selects the Custom provider in `/setup` (or invokes `/model`), ARIS calls
  the provider's `GET /v1/models` endpoint to populate the interactive
  picker with the actual available model list. We added a 10s connect
  timeout + 20s total timeout so a bad URL / TLS stall / half-open
  connection can no longer hang the wizard, and we clear stale
  `executor_model` / `reviewer_model` on menu-switch so the manual-entry
  fallback prompt always fires when the fetch fails. The new
  `crates/aris-cli/src/openai_compat.rs` carries 3 `TcpListener`-based
  offline tests so CI never hits `api.openai.com`. Credit
  [@Anduin9527](https://github.com/Anduin9527)
  ([#222](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/222)).

### Credits

- [@Anduin9527](https://github.com/Anduin9527) — Custom OpenAI-compatible provider + dynamic `/models` discovery (PR [#121](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/121) reworked into [#221](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/221) + [#222](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/222), then cherry-picked with three small follow-up adjustments)

## v0.4.5 (2026-05-13)
- Release: [`v0.4.5`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.5) · [PR #36](https://github.com/zhuyingqin/Aris/pull/36) · published 2026-06-29

A reasoning-model + multi-provider release. The headline is **first-class support for thinking-content models** (DeepSeek V4 Pro, OpenAI o1/o3/o4 family, GPT-5.5 with `reasoning_effort='xhigh'`) — both the wire-format plumbing and the interactive setup were missing pieces. Bundled with that: 3 new Chinese provider presets (Xiaomi MiMo / Qwen 3.6 / Doubao), object-style hooks parser, default model bump to Claude Opus 4.7 + GPT-5.5, and a stack of REPL input fixes (multi-line wrap, bracketed paste, CJK wide-char layout).

### New

- **Thinking content blocks** — Full pipeline now handles models that return reasoning/thinking output. Adds `Thinking` variants to `OutputContentBlock` / `InputContentBlock` / `ContentBlockDelta` / session `ContentBlock` / runtime `AssistantEvent`, threads them through stream decoding, session persistence, and `convert_messages` so they're handed back to the API on follow-up turns. **Fixes [#161](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/161)** (unknown variant `thinking` deserialization) and the consequent 400 Bad Request when reasoning models expect their thinking to be echoed back. Credit [@GO-player-hhy](https://github.com/GO-player-hhy) ([#186](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/186)).
- **`reasoning_effort='xhigh'`** is now actually sent on requests for reasoning-capable models (`gpt-5.5`, `gpt-5.6`, `o1*`, `o3*`, `o4*`, `*-reasoner`, `*-thinking`). Both the executor (`openai_executor.rs`) and the reviewer (`LlmReview` in `tools/lib.rs`) attach the field. Before this, the banner advertised "Claude x GPT-5.5 xhigh" but the field was never on the wire, so OpenAI servers defaulted to `medium` effort. Override the tier with `ARIS_REASONING_EFFORT={none|minimal|low|medium|high|xhigh}`.
- **DeepSeek V4 Pro in `/setup`** — Executor option 7 + reviewer option 7, via `anthropic-compat` provider against `https://api.deepseek.com/anthropic` with default model `deepseek-v4-pro`. The anthropic-compat path is chosen over openai-compat specifically because it preserves DeepSeek's thinking content blocks. Credit [@GO-player-hhy](https://github.com/GO-player-hhy) ([#186](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/186)).
- **Xiaomi MiMo / Qwen 3.6 / Doubao** in `/setup` wizard as options 8/9/10 and in `/model` interactive picker. Endpoints: `xiaomimimo.com/v1`, `dashscope.aliyuncs.com/compatible-mode/v1`, `ark.cn-beijing.volces.com/api/v3`. Default models: `mimo-v2.5-pro`, `qwen3.6-plus` (1M context), `doubao-pro-4k` (Ark API format). Partial cherry-pick of [@GetIT-Sunday](https://github.com/GetIT-Sunday)'s [#216](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/216); the openai-compat DeepSeek alternative and native-tls swap from that PR are deferred to v0.4.6.
- **Claude Code object-style hooks** parser — `settings.json` / `.claude.json` can now use the richer hook syntax `{ "matcher": ".*", "hooks": [ { "type": "command", "command": "..." } ] }` in addition to the legacy string-array form. Object-style hooks are flattened to commands internally so the rest of `HookRunner` is unchanged. Credit [@Jxy-yxJ](https://github.com/Jxy-yxJ) ([#171](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/171)).
- **Default model bump** — `DEFAULT_MODEL`, `/setup` wizard defaults, `/model` and `/reviewer` interactive picker top entries all upgraded to `claude-opus-4-7` (Anthropic) and `gpt-5.5` with the new `xhigh reasoning` label (OpenAI). Previous flagships (`gpt-5.4`, `gpt-5.4-mini`, `-nano`) remain as fallback options in the menu.
- **CI workflow** — `.github/workflows/ci.yml` runs `cargo build --workspace --all-targets` + `cargo test --workspace -- --test-threads=1` on Ubuntu and `cargo build --workspace --all-targets` on macOS for every push/PR to `aris-code` or `main`. Serialized test runner avoids a pre-existing ubuntu cwd race in tools integration tests. clippy/fmt/macos-test will tighten in follow-up PRs.

### Fix

- **Multi-tool result grouping** — When a single assistant turn issued multiple parallel tool calls, each `ToolResult` used to be emitted as its own `ConversationMessage`, which the next API call would then reject with `tool_use_ids_without_tool_result`. All tool results from one turn are now grouped into a single message (role `MessageRole::Tool`, mapped to Anthropic's `user` role at the adapter boundary via `convert_messages`). Credit [@GO-player-hhy](https://github.com/GO-player-hhy) ([#186](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/186)).
- **REPL input duplicated forever when buffer wrapped multiple rows** — Pasting a long API key (e.g. `sk-ant-api03-...` over the terminal width) used to make every subsequent keystroke re-print the entire buffer below the previous render. Root cause: `redraw()` ran `MoveToColumn(0)` + `Clear(FromCursorDown)` from the *last* physical row of the wrapped block, so the prior wrap rows survived and the new block stacked underneath. Now a per-read `RenderState` tracks the previously drawn cursor row and `redraw` jumps back to the top of the input area before clearing.
- **Cmd+V multi-line paste fired one prompt per line** — Without bracketed paste mode, the pasted byte stream was delivered to the raw-mode editor character-by-character, and every `\n` parsed as `KeyCode::Enter` triggered submit. A 5-line paste became 5 separate prompts to Claude. Now `EnableBracketedPaste` is queued after `enable_raw_mode()` (with graceful fallback for terminals that report Unsupported), and `Event::Paste(String)` inserts the whole block at the cursor as a single edit. Newlines / tabs / control chars inside the paste are flattened to spaces (single-line editor; multi-line buffer is a v0.5.x feature).
- **CJK wide chars at the right edge collapsed the cursor** — Typing Chinese at the end of an already-wrapped buffer would make the previously-typed character visually disappear (data was preserved, but redraw clobbered the cell). Root cause: cursor row was derived from `display_width / terminal_width`, which puts the cursor in the middle of a wide-cell at exactly the wrap boundary. `RenderState` now stores `cursor_row` directly and `layout_position()` simulates actual terminal cell layout (pre-wrap before drawing a wide char if it would partially overflow; pending-wrap when a narrow char exactly fills the last column).
- **`settings.json` object-style hooks made the entire feature_config fall back to default** — When the hooks parser saw a non-string-array hook value it returned a load error, and the CLI's load-error path silently swapped in `RuntimeFeatureConfig::default()`, which wiped user-configured MCP servers / OAuth / sandbox / permissionMode too. Object-style hooks are now parsed natively. Credit [@Jxy-yxJ](https://github.com/Jxy-yxJ) ([#171](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/171)).
- **DeepSeek user identifying as "developed by Anthropic"** — The ARIS identity line in the system prompt hard-coded `developed by Anthropic`. `friendly_name` map now covers `deepseek-v4-pro`, `mimo-*`, `qwen3.6-*`, `doubao-*-4k`, and the vendor is derived from a prefix-map (`mimo-→Xiaomi`, `deepseek-→DeepSeek`, `qwen-`/`qwen3.→Alibaba`, `doubao-→ByteDance`, `gpt-`/`o1`/`o3`/`o4→OpenAI`, `gemini-→Google`, `GLM→Zhipu`, `MiniMax→MiniMax`, `kimi-`/`moonshot-→Moonshot`).

### Improved

- **Banner provider label** recognizes Xiaomi / Doubao base URLs and shows the correct family name on startup.
- **Compaction summary** continuation uses `MessageRole::Tool` for tool results (mapped through `convert_messages`), restoring the v0.4.2 fix for OpenAI-compat executors that drop System-role messages.

### Skipped / planned for v0.4.6 (intentional)

- **DeepSeek openai-compat alternative path** (PR [#216](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/216) `a1fbea8`) — conflicts with the anthropic-compat path we landed in v0.4.5; v0.4.6 will decide whether to support both with a sub-option.
- **native-tls swap for DashScope Coding Plan 405** ([#159](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/159), PR [#216](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/216) `033f2cd`) — cross-cutting change (replaces rustls with native-tls for *all* HTTPS, affecting OAuth / MCP / OpenAI / Anthropic / OpenRouter), needs per-platform release-binary validation; will land in its own release.
- **Custom OpenAI-compatible provider rework** ([#121](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/121)) — author rework needed (split into 3 PRs + preserve v0.4.4 routing invariants); tracked.
- **Provider abstraction layer, MCP timeout/restart, bash sandbox hardening, Permission Ord bug, file_ops workspace boundary, dead code cleanup** (`app.rs` / `args.rs` / `run_setup` / `rustyline` dep) — slated for v0.4.6 architectural pass.

### Credits

- [@GO-player-hhy](https://github.com/GO-player-hhy) — Thinking blocks + multi-tool grouping + DeepSeek `/setup` ([#186](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/186))
- [@Jxy-yxJ](https://github.com/Jxy-yxJ) — Claude Code object-style hooks ([#171](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/171))
- [@GetIT-Sunday](https://github.com/GetIT-Sunday) — Xiaomi / Qwen 3.6 / Doubao provider presets (partial cherry-pick of [#216](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/216))

## v0.4.4 (2026-04-20)
- Release: [`v0.4.4`](https://github.com/zhuyingqin/Aris/releases/tag/v0.4.4) · published 2026-06-26

Setup UX + reviewer-routing fixes surfaced by issues [#158](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/158) and [#162](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/162) (Claude / ModelScope third-party proxies returning "暂不支持" / 403).

- **Fix**: **`/setup` no longer forces Anthropic custom-URL users into Bearer mode** — previously, picking "Anthropic" + entering a custom base URL auto-switched the provider to `anthropic-compat` (Bearer token), which made `x-api-key`-only proxies (ModelScope, Claude-Code-compatible proxies like `code.newcli.com/claude`) unreachable. Now those users stay on `provider=anthropic` and ARIS sends `x-api-key` — matching how vanilla Claude Code authenticates against the same proxies. Users who genuinely need Bearer mode and were already on `anthropic-compat` are preserved across re-runs of `/setup` (no silent downgrade).
- **Fix**: **Stale state leaking across provider switches in `/setup`** — switching the executor menu from Kimi → OpenAI (etc.) would keep the old provider's API key under the new env var, and the old base URL ("https://api.moonshot.cn/v1") would be shown as the new provider's "default". Same issue on the reviewer side (Kimi reviewer URL persisted after switching to OpenAI reviewer). Menu-option change now clears `executor_api_key` (and for reviewer also `reviewer_api_key` + `reviewer_base_url`). Detection compares the concrete menu choice, not just `executor_provider`, because OpenAI/Gemini/GLM/MiniMax/Kimi all serialize as `"openai"`.
- **Fix**: **Custom base URL silently wiped on `/setup` re-run** — previously, re-entering setup with the same menu option would overwrite `executor_base_url` with the provider's built-in default, nuking any custom URL the user had saved (e.g. an OpenRouter or newcli.com proxy). Base URL is now only overwritten when the user actually switches menu options.
- **Fix**: **LlmReview silently failed when executor guessed wrong `model`** — the tool's description only listed `OpenAI/Gemini/GLM/MiniMax` (no Kimi, no Anthropic), so a Kimi-executor would call LlmReview with `model="gpt-4o"`, route to the unset `OPENAI_API_KEY`, and fail. `resolve_reviewer_model()` now falls back to the user's configured reviewer model when (a) the requested model's API key is missing, or (b) the requested model routes to a different provider than the configured reviewer. Provider consistency is derived from `configured_model`, not `ARIS_REVIEWER_PROVIDER` — so `/reviewer <model>` works correctly even if it doesn't re-sync the provider env var. Tool description and schema hint updated to list all supported reviewer families and to tell the executor to prefer omitting `model`.
- **New**: **Provider-aware proxy URL hints in `/setup`** — before the "Proxy base URL" prompt, ARIS now prints examples of known-working third-party proxies for the chosen provider. For Anthropic: `https://code.newcli.com/claude`, `https://api-inference.modelscope.cn`. For OpenAI: `https://openrouter.ai/api/v1`, `https://api.deepseek.com/v1`, `https://dashscope.aliyuncs.com/compatible-mode/v1`. Pure UX — input-URL logic unchanged.
- **Improved**: Prompt text now says `"Enter to keep"` (truthful) instead of `"Enter for default"` (misleading — pressing Enter preserves the current value, not the provider's built-in default).
- **Improved**: `aris doctor` reviewer-API check now covers all six supported auth env vars (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `ARIS_REVIEWER_AUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`). `/reviewer` slash-command summary updated similarly.

**Known limitations (planned for v0.4.5 / v0.5.0):**
- Reviewer-side Claude proxy is still Bearer-only (`tools/src/lib.rs` anthropic-compat branch). Fix coming with a provider-aware auth-mode option for the reviewer path.
- DashScope Anthropic-format (Coding Plan) needs a tier-specific request header we don't emit yet — issue [#159](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/issues/159). Intentionally omitted from the Anthropic URL hints until the header is implemented.

## v0.4.3 (2026-04-17)

- **Fix**: **Third-party Anthropic-compatible proxies (Bedrock, etc.) rejected beta headers** — providers that emulate the Anthropic Messages API do not recognize Anthropic-specific beta flags (`oauth-2025-04-20`, `claude-code-20250219`, `interleaved-thinking-2025-05-14`, `context-1m-2025-08-07`), causing `400 Bad Request: invalid beta flag`. Introduced `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` env var (read via new `api::read_send_betas()`); when set, the Anthropic client omits the `anthropic-beta` header on OAuth requests. The flag is auto-enabled when a custom `executor_base_url` is configured for `anthropic` or `anthropic-compat` providers, and auto-cleared when switching back to the official API.
- **Fix**: **Custom `executor_base_url` ignored for `anthropic` provider** — previously only the `anthropic-compat` path propagated `executor_base_url` to `ANTHROPIC_BASE_URL`. A user who selected `provider=anthropic` with a proxy URL would silently hit `api.anthropic.com` and fail with `401 Unauthorized`. Now both `anthropic` and `anthropic-compat` propagate the URL.

Credit: [@screw-44](https://github.com/screw-44) ([#156](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/156)).

## v0.4.2 (2026-04-16)

- **Fix**: **Auto-compaction corrupted session after skill runs** — `assistant stream produced no content` after `[auto-compacted: removed N messages]` when the preservation window started mid-tool-chain or with a non-User message. Compaction now scans forward to the nearest User message as the boundary, avoiding dangling `tool_use`/`tool_result` pairs that caused the API to return an empty stream. Messages skipped during the forward scan are now correctly included in the summary instead of being silently dropped from both summary and tail. Symptom: after skills produced many tool calls, the next user prompt would fail; closing and reopening restored the ability to talk.
- **Fix**: **Compaction summary silently lost on OpenAI-compatible executors** — `openai_executor::convert_messages_openai` explicitly skips `MessageRole::System` messages inside the messages array, so the compaction continuation message (role=System) was erased before hitting the API. Changed continuation role from `System` to `User` so the summary survives for all executors. Added regression tests.
- **Fix**: **Custom executor base URL ignored when setup runs mid-launch** — if the saved `config.json` already had `executor_base_url` set to an old value, the startup `apply_to_env()` populated `EXECUTOR_BASE_URL` first; the post-setup `apply_to_env(force=false)` then skipped overwriting it because the env var was "already set." User would type `https://gmncode.cn` in setup but the CLI kept hitting `api.openai.com/v1`. Fixed by using `force_apply_to_env()` after the mid-launch setup wizard. Reviewer URL was unaffected because the reviewer API key setter always writes unconditionally.
- **Fix**: **Shell-provided `OPENAI_API_KEY` no longer erased on launch** — the mid-launch "no API key found" guard only checked `ANTHROPIC_API_KEY` / `EXECUTOR_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, not `OPENAI_API_KEY`, even though `resolve_openai_executor_config` accepts the latter as a fallback. A user who set `EXECUTOR_PROVIDER=openai` + `OPENAI_API_KEY=...` in their shell would be wrongly routed through setup, and then `force_apply_to_env()` would clear their shell-provided key. Guard now also recognizes `OPENAI_API_KEY` when `EXECUTOR_PROVIDER=openai`, and saved Anthropic OAuth credentials count only when the selected executor is Anthropic (not OpenAI-compat).
- **Fix**: **Mid-launch setup no longer wipes shell reviewer keys** — when startup setup ran to populate an executor key, it previously called `force_apply_to_env()`, which also cleared reviewer env vars (`OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.). Users with a shell-provided reviewer key who pressed Enter to keep the existing value lost reviewer access for the rest of the process. Added `force_apply_executor_env()`, which clears only executor-related env vars; the mid-launch path uses it. REPL `/setup` keeps the full clear since the user explicitly reconfigures everything there.
- **Fix**: Empty or whitespace-only `EXECUTOR_BASE_URL` env var now correctly falls back to the provider default and trims legitimate values to avoid malformed URLs.

## v0.4.1 (2026-04-15)

- **New**: **Robust reviewer/executor retries** — transient network errors, HTTP 429 rate limits, and 5xx server errors now auto-retry (up to 4 attempts, exponential backoff, honors `Retry-After`). Ctrl+C interrupts the backoff instantly.
- **Fix**: **Stale interrupt flag** — after a Ctrl+C mid-tool, subsequent tool calls no longer fail with "interrupted by user" forever. Every interrupt check now consumes the flag.
- **Fix**: **Broken connection pool on reviewer** — LlmReview builds a fresh HTTP client per attempt with `pool_max_idle_per_host=0`, avoiding reuse of dead TCP/TLS connections. Adds 15s connect timeout + 180s total timeout.
- **Improved**: Network error messages now include full `caused by:` chain (DNS / TLS / connection reset) so failures are diagnosable instead of opaque "error sending request".

## v0.4.0 (2026-04-15)

- **New**: **Plan mode** — `/plan <task>` enters read-only execution (Read/Grep/Glob/WebSearch only, no Edit/Write/Bash). `/plan execute` switches back to normal permissions. `/plan exit` cancels. Transactional state transitions: if runtime rebuild fails, previous state is preserved. Inspired by claw-code.
- **New**: **Cooperative Ctrl+C interrupt** — single Ctrl+C aborts the current in-flight operation and returns to REPL instead of killing the process. Works across Anthropic streaming, OpenAI-compatible streaming, conversation loops, and reviewer calls.
- **Fix**: **API errors no longer exit the REPL** — network failures, 4xx/5xx responses, and malformed responses are caught at the REPL boundary; user can retry or `/model` to switch.
- **New**: **Tool output folding** — WebSearch / WebFetch / LlmReview / Skill tool results get dedicated compact formats; default truncation tightened from 200 → 120 chars.
- **Sync**: 62 skills synced from main ARIS branch, plus 16 shared-references bundled as embedded resources. Auto-extracted to cwd on first skill invocation; `../shared-references/` paths rewritten to cwd-relative for bundled skills.
- **Fix**: **Windows `fs::rename`** — credentials save (oauth.rs) and Codex MCP config write now remove target before rename (Windows doesn't overwrite).
- **Fix**: **Stale reviewer env vars** — `force_apply_to_env` now clears `ARIS_REVIEWER_PROVIDER` / `ARIS_REVIEWER_AUTH_TOKEN` when switching reviewer config.

## v0.3.11 (2026-04-13)

- **New**: **Reviewer Anthropic-compatible mode** — LlmReview now supports Anthropic-compatible endpoints as reviewer (e.g., Claude via proxy). Set `ARIS_REVIEWER_PROVIDER=anthropic-compat` or select "Anthropic Proxy" in `/setup`.
- **New**: `/setup` adds option 6 "Anthropic Proxy" for reviewer, enabling Claude-as-reviewer via proxy services.

## v0.3.10 (2026-04-11)

- **Fix**: **Windows compatibility overhaul** — all path resolution now uses `USERPROFILE` fallback (previously only checked `HOME` which doesn't exist on Windows, causing crashes). Bash tool uses `cmd /C` on Windows. `fs::rename` handles existing target files.
- **Fix**: `/setup` "Skip reviewer" now properly clears `reviewer_model`. Force setup clears all reviewer env vars to prevent stale state.

## v0.3.9 (2026-04-11)

- **New**: **Proxy / custom base URL support** — `/setup` now asks for proxy base URL for ALL providers (Executor + Reviewer). Supports API proxy services (CCSwitch, CCVibe, etc.) and local models (LM Studio, Ollama). Leave blank for default — zero behavior change for existing users.
- **New**: Anthropic proxy mode — entering a custom URL for Anthropic automatically switches to Bearer token auth (compatible with Chinese API proxy services).
- **New**: `reviewer_base_url` field — LlmReview tool now respects custom reviewer proxy URL via `ARIS_REVIEWER_BASE_URL`.

## v0.3.8 (2026-04-09)

- **Fix**: `/setup` and `/model` now rebuild system prompt with new model identity. Previously the model would still identify as the old model (e.g., "I am Claude" after switching to GPT).

## v0.3.7 (2026-04-09)

- **Fix**: `/setup` provider switch now clears stale env vars. Switching from OpenAI to Anthropic no longer sends Claude model names to the OpenAI endpoint (404 error).
- **Fix**: OpenAI-compatible streaming tool calls no longer lose their name when a later delta sends an empty string. Fixes "assistant stream produced no content" for some providers.

## v0.3.6 (2026-04-08)

- **Fix**: Tab completion crash when skill descriptions contain CJK characters (Chinese/Japanese/Korean). The `clip()` function was slicing bytes instead of chars, causing a panic on multi-byte UTF-8 boundaries. Fixes #124.

## v0.3.5 (2026-04-08)

- **New**: **Research Wiki** — persistent research knowledge base with papers, ideas, experiments, claims, and typed relationship graph. Python helper with auto-fallback to direct LLM execution.
- **New**: **Bundled helper resources** — `build.rs` now embeds `.py`/`.sh` files alongside SKILL.md, auto-extracted on first invocation.
- **New**: Skills integration — `idea-creator`, `research-lit`, `result-to-claim` now auto-ingest to research-wiki when it exists (skip silently if not).

## v0.3.4 (2026-04-08)

- **New**: **Workflow M: Meta-Optimize** — ARIS can now optimize its own skills based on usage patterns. Passive event logging (`ARIS_META_LOGGING=metadata`), usage analysis, LlmReview-gated patch proposals, and safe `/meta-optimize apply N` with Rust-enforced path validation.
- **New**: **EventSink** — pluggable runtime event logging (tool calls, skill invocations, user prompts). Three levels: `off` (default), `metadata`, `content`.
- **New**: **Session atomic writes** — sessions now saved via temp file + rename to prevent data loss on crash. Files exceeding 256 KB are automatically rotated (3 archives).
- **New**: **Bash command pre-validation** — dangerous patterns (`rm -rf /`, `sudo rm`, `mkfs`, fork bombs) are blocked before execution.
- **New**: **Windows support (experimental)** — CI now builds `aris-code-windows-x64.zip` via GitHub Actions.
- **Fix**: Skill resolution now searches `~/.config/aris/skills/` (highest priority), fixing split-brain between `/skills export` and the Skill tool.
- **Security**: Symlink rejection added to skill loader (same as memories). Path traversal (`..`, `/`) blocked in skill names. Reviewer independence protocol bundled.
- **New**: **Research Wiki** — persistent research knowledge base (papers, ideas, experiments, claims + relationship graph). Python helper auto-extracted with fallback to direct LLM execution if Python unavailable.
- **New**: **Bundled helper resources** — `build.rs` now embeds `.py`/`.sh` files alongside SKILL.md. Skills can ship deterministic helper scripts.

## v0.3.3 (2026-04-04)

- **Fix**: Catch config loading errors in ALL code paths (system prompt + runtime config). Users with incompatible Claude Code hooks settings no longer crash — ARIS shows a warning and continues with defaults.

## v0.3.2 (2026-04-04)

- **Fix**: Gracefully handle incompatible Claude Code hooks configuration (PreToolUse object format). Now falls back to default config instead of crashing.
- **Fix**: Install instructions now include `chmod +x` to fix `permission denied` on first run.

## v0.3.1 (2026-04-04)

- **Fix**: StructuredOutput tool schema now compatible with OpenAI API (added missing `properties` field). Previously caused `400 Bad Request` when using OpenAI/Kimi as executor.

## v0.3.0 (2026-04-03)

- **Multi-file Memory Index**: Memories now stored as individual files in `~/.config/aris/memories/` with YAML frontmatter. System prompt gets a catalog (name + description), model loads specific memories on demand via read_file. Old `memory.md` auto-migrated.
- **Rich Task System (TodoWrite)**: Tasks now use the structured TodoWrite tool with JSON storage (`~/.config/aris/tasks.json`). Supports pending/in_progress/completed status. `/tasks` shows formatted task list.
- **Security hardening**: Symlink rejection in memory directory, prompt injection sanitization for memory fields.

## v0.2.2 (2026-04-03)

- **`/plan` command**: Create step-by-step research plans before executing. Model presents numbered steps and waits for confirmation.
- **`/tasks` command**: Persistent task tracking via `~/.config/aris/tasks.md`. Auto-managed by the model with `- [ ]` / `- [x]` checklist format. Use `/tasks` to view, `/tasks clear` to reset.

## v0.2.1 (2026-04-03)

- **Persistent Memory**: ARIS now remembers context across sessions via `~/.config/aris/memory.md`. Say "remember this" and it persists. No extra setup needed.
- **Kimi K2.5 thinking mode fix**: Multi-turn tool calls now work correctly with Kimi's reasoning mode (reasoning_content preserved and replayed).
- **CJK cursor fix**: Chinese/Japanese/Korean input cursor positioning now correct in the REPL.
- **Banner box frame**: Startup banner wrapped in a clean box frame (like Claude Code).

## v0.2.0 (2026-04-02)

- **Open source release** on `aris-code` branch.
- **CI/CD**: GitHub Actions auto-builds for macOS ARM64, macOS x64, Linux x64.
- **Kimi K2.5 support**: New executor/reviewer provider via Moonshot API.
- **MiniMax M2.7**: OpenAI-compat endpoint (`api.minimax.chat/v1`).
- **GLM-5**: Zhipu AI via OpenAI-compat endpoint.
- **Smart LlmReview routing**: Routes by model name (gemini/glm/minimax/kimi/openai), not by which API key exists.
- **Expanded setup**: 6 executor providers, 6 reviewer providers, auto-set best model per provider.
- **Language setting**: CN/EN preference in setup, injected into system prompt.

## v0.1.0 (2026-04-02)

- **Initial release** (macOS ARM64 only).
- **Multi-executor**: Anthropic Claude / OpenAI / Gemini / GLM / MiniMax.
- **Multi-reviewer**: LlmReview tool for adversarial cross-model review.
- **42 bundled research skills**: paper-write, research-review, auto-review-loop, etc.
- **Interactive setup**: `aris` first-run wizard, persistent config at `~/.config/aris/config.json`.
- **Runtime switching**: `/model`, `/reviewer`, `/permissions` interactive menus.
- **Customizable skills**: `/skills list|show|export`, three-tier priority (ARIS > Claude > bundled).
- **Pixel art banner**: Claude (blue) and GPT (green/sunglasses) characters.
- **Anti-hallucination**: System prompt includes exact model identity.
- **UI improvements**: `●` indicators, `❯` prompt, turn separators, compact tool display.
- Based on [claw-code](https://github.com/ultraworkers/claw-code) Rust version.
