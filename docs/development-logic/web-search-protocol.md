# Web search protocol

SomniQ's built-in `WebSearch` is a bounded research retrieval protocol, not a
promise that the public web has been exhaustively enumerated.

## Contract

- Schema version: `3`.
- `maxResults` is selected by the LLM for each new search and is a per-batch
  context guard, not a total retrieval cap. Bounds outside `1..=50` are
  rejected; they are never silently clamped. The model may consume any number
  of batches before stopping when the evidence is sufficient.
- `maxResults` remains part of cursor identity. A cursor cannot be reused after the
  query, domain filters, language, provider set, query variants, or bound
  changes.
- Every response reports `totalHits`, `fetched`, `unique`, `exhausted`,
  `nextCursor`, and `truncatedReason`.
- `status=completed` is valid only when every attempted stream is exhausted and
  no requested provider failed or was skipped.
- An empty response is a definitive negative result only when
  `coverage.exhausted=true`. Unknown HTML layouts are parse failures, never
  successful empty searches.
- Every response includes `retrievalControl`. The LLM, rather than a fixed
  total-result target, owns the stopping decision. It evaluates direct
  relevance, source diversity, independent corroboration, authority, recency
  and unresolved evidence gaps, then either stops, continues `nextCursor`, or
  broadens to `providers=["all"]`.

## Providers

`auto` is a fallback chain:

1. `ARIS_WEB_SEARCH_BASE_URL` (legacy
   `CLAWD_WEB_SEARCH_BASE_URL` remains readable);
2. Brave when `BRAVE_SEARCH_API_KEY` exists;
3. Exa when `EXA_API_KEY` exists;
4. zero-configuration DuckDuckGo HTML.

`auto` remains the efficient first stage. When it stops after a usable
provider, configured providers that were not queried are returned in
`retrievalControl.availableUnsearchedProviders`; the response remains
`partial` with `truncatedReason=llm_sufficiency_checkpoint`. The model can stop
if the current evidence is sufficient, continue the current provider for
depth, or launch `providers=["all"]` for cross-provider diversity. Therefore a
50-result batch ceiling never prevents a longer search.

The desktop “Model services” settings page stores Brave Search and Exa keys as
masked secrets and exports them to `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY` in
the running process. Saving a key therefore applies to the next `WebSearch`
call without placing credentials in tool input or output.
Each provider row can test an unsaved draft key or clear a saved key. The test
uses a dedicated uncached provider probe, so it does not overwrite
process-global credentials while another search is running.

`providers=["all"]` runs every configured provider and fuses their preserved
source ranks. Missing optional credentials are explicit skipped attempts.

Brave follows its bounded page-offset contract. DuckDuckGo/custom HTML follows
the backend's next form/link and retains unconsumed results from the current
page in the opaque cursor. The HTML cursor also carries a bounded set of prior
result fingerprints so a live page reorder cannot repeat an already returned
URL. Exa's public search window has no continuation
cursor, so hitting that window is `provider_result_window`, not completion.
Provider pagination is restricted to the configured provider origin. A result
window with no provider continuation is partial but intentionally has no
`nextCursor`, avoiding a cursor that would repeat the last page.

## Ranking and filtering

The executor creates broad-keyword, exact-phrase, common-alias, and bilingual
research variants where applicable. Domain constraints are pushed into provider
queries/API parameters and enforced again after retrieval.

Results retain ranks for each provider/query stream. Canonical URL
normalization removes fragments and known tracking parameters before reciprocal
rank fusion. Final order is never derived from identifier sorting.

## Fetching pages

`WebFetch` schema version 3:

- permits only HTTP(S);
- blocks private/reserved destinations and redirect targets unless
  `allowPrivateNetwork=true`;
- pins the validated DNS addresses into the HTTP client so the connection cannot
  silently resolve to a different address after validation;
- caps redirects, response bytes, request duration, returned characters, and
  estimated tokens;
- treats non-2xx responses and unsupported binary content as tool failures;
- decodes BOM, HTTP charset and HTML/XML charset declarations before falling
  back to UTF-8, GB18030 for HTML, or Windows-1252 for other text;
- parses HTML with an HTML5 DOM, removes script, style, navigation, and other
  page chrome, and converts the selected `article`/`main`/`body` subtree to
  Markdown while retaining headings, tables, code blocks, lists, images and
  resolved links;
- treats fetched content as untrusted evidence, removes non-HTTP(S) link
  targets, and redacts common credential query parameters from model-visible
  URLs and metadata;
- reports a static JavaScript application shell as `incomplete` with
  `truncatedReason=dynamic_render_required`, rather than claiming full page
  coverage;
- checks cancellation between retries and streamed response chunks.

Every successful initial fetch writes two project-local records:

- `.somniq/web-fetch/objects/<artifact-id>/` is an immutable,
  content-addressed raw response plus complete normalized Markdown;
- `.somniq/web-fetch/captures/<capture-id>/metadata.json` is an immutable
  observation record with capture time, request/final URL hashes, redacted
  redirect chain, selected response headers, encoding, decode status, HTTP
  status, extraction completeness, warnings, and object hashes.

Identical bytes may reuse an object, but every HTTP observation receives a new
capture record, so later fetches cannot overwrite the evidence referenced by an
earlier cursor. The raw representation is the decoded HTTP entity body returned
by the client (for example, after transfer compression), and metadata labels it
accordingly. Raw content and complete Markdown are never copied into the tool
result.

The model-visible result uses two independent bounds:

- `maxChars` defaults to and is capped at 50,000 characters;
- `maxTokens` defaults to 10,000 estimated tokens and is capped at 25,000;
- desktop execution may lower `maxTokens` to one quarter of the active model's
  compaction budget, clamped to 4,000..=25,000.

The character cap follows Kimi CLI's ordinary 50,000-character tool-result
limit. The token cap and local spill/continuation pattern follow Claude Code's
token-aware context management and oversized-output handling. A character-only
limit is not universal: CJK text, source code, JSON and prose have different
token densities, while model context windows differ. The protocol therefore
uses the lower of the character and token budgets and keeps the full evidence
outside the conversation.

Chunking respects headings and keeps split tables independently readable by
repeating their headers. Split fenced code blocks are re-fenced so every window
remains valid Markdown. Prompt-relevant chunks are ranked first with a
BM25-style score and heading/phrase bonuses; all remaining chunks stay
available exactly once. `coverage.totalHits` is the number of Markdown chunks,
while `fetched`/`unique` count chunks already returned in the current cursor
chain. Until every statically extracted chunk has been returned:

- `status` is `partial`;
- `coverage.exhausted` is false;
- `coverage.truncatedReason` is `context_window`;
- `coverage.nextCursor` is non-null.

Continuation requires the same URL, prompt, `maxChars`, and `maxTokens`. The
cursor is HMAC-authenticated and bound to the request, capture, immutable
object, reading order and bounds. Continuation validates the object metadata
and Markdown hash, reads the next unique chunk from disk, and performs no new
network request. Missing, modified, forged, escaped or cross-query cursors fail
explicitly.

The evidence store has a hard default quota of 2 GiB. It can be raised with
`ARIS_WEB_FETCH_STORE_MAX_BYTES`; a fetch fails explicitly instead of silently
dropping raw evidence when the quota is exceeded.

Design references:

- [Kimi CLI source](https://github.com/MoonshotAI/kimi-cli)
- [Claude Code context-window documentation](https://code.claude.com/docs/en/context-window)
- [Claude Code MCP output-limit documentation](https://code.claude.com/docs/en/mcp)

The desktop tool card must display incomplete coverage, provider
failed/skipped states, query variants, and cited result links. Research
workflows may count web search as a contributing source only when
`coverage.unique > 0`; incomplete coverage must remain labelled partial.
