# Web search protocol

SomniQ's built-in `WebSearch` is a bounded research retrieval protocol, not a
promise that the public web has been exhaustively enumerated.

## Contract

- Schema version: `2`.
- Bounds outside `1..=50` are rejected; they are never silently clamped.
- `maxResults` is part of cursor identity. A cursor cannot be reused after the
  query, domain filters, language, provider set, query variants, or bound
  changes.
- Every response reports `totalHits`, `fetched`, `unique`, `exhausted`,
  `nextCursor`, and `truncatedReason`.
- `status=completed` is valid only when every attempted stream is exhausted and
  no requested provider failed or was skipped.
- An empty response is a definitive negative result only when
  `coverage.exhausted=true`. Unknown HTML layouts are parse failures, never
  successful empty searches.

## Providers

`auto` is a fallback chain:

1. `ARIS_WEB_SEARCH_BASE_URL` (legacy
   `CLAWD_WEB_SEARCH_BASE_URL` remains readable);
2. Brave when `BRAVE_SEARCH_API_KEY` exists;
3. Exa when `EXA_API_KEY` exists;
4. zero-configuration DuckDuckGo HTML.

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

`WebFetch`:

- permits only HTTP(S);
- blocks private/reserved destinations and redirect targets unless
  `allowPrivateNetwork=true`;
- pins the validated DNS addresses into the HTTP client so the connection cannot
  silently resolve to a different address after validation;
- caps redirects, response bytes, request duration, and returned characters;
- treats non-2xx responses and unsupported binary content as tool failures;
- removes script, style, navigation, and other page chrome before selecting
  prompt-relevant passages;
- checks cancellation between retries and streamed response chunks.

The desktop tool card must display incomplete coverage, provider
failed/skipped states, query variants, and cited result links. Research
workflows may count web search as a contributing source only when
`coverage.unique > 0`; incomplete coverage must remain labelled partial.
