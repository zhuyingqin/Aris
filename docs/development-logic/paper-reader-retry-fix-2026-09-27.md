# Paper reader parse / outline interruption fix

## Observed failure

Read-only inspection of the saved run for *The Rise of Diffusion Models in Time-Series Forecasting* (32 pages, MiniMax-M3) found 31 completed pages and no teaching lessons. Page 32 returned invalid JSON with unescaped quotation marks in an uncertainty string. The outline returned nine original-page citations in its evidence section, all supplied to the model, but validation imposed an undocumented eight-citation maximum. Both errors were durable task failures; the scheduler did not automatically retry rejected structured output.

## Changes

- Overview citations may span all supplied original evidence; uniqueness and source membership remain enforced. Per-topic image limits remain unchanged.
- Overview validation identifies the invalid field and explains its constraint.
- Page perception, outline, and teaching tasks automatically retry rejected model output within the existing three-attempt total budget. Transport failures do not trigger this automatic retry.
- Every retry receives verified original sources and the previous validation error, in a fresh isolated Chat turn. The failed draft is never promoted to source evidence.
- Completed work, failure history, cancellation checks, and durable writes remain intact. No independent Reviewer has been enabled.

## Verification

Regression coverage includes nine supplied citations, missing evidence rejection, recovery without reprocessing completed pages, bounded retries, transport failure exclusion, and cancellation. User database and running application are untouched. Successful parsing does not establish teaching correctness; end-to-end model quality remains a separate acceptance step.

Verified results: focused runtime tests 28 passed; desktop paper-reading tests 7 passed; workspace suite 1213 passed / 5 ignored (before the final additional outline-recovery test, included in the focused 28). Frontend release build passed. Offline replay of the actual saved outline succeeded with 4 overview sections and 6 teaching topics. No fresh model generation or full-paper quality acceptance was performed in this diagnosis.

Release EXE rebuilt successfully; isolated WebView startup passed with embedded frontend and no page errors. Existing preview package updated in desktop/.somniq/builds/paper-reader-20260926/app; SHA-256: 4f18c3a1296fe3484b0878802608af320aa5a8f4b67af5cc34309e821d140a04.


## Follow-up: cited cautions and recoverable attempt batches

A later saved run completed all 32 PDF pages, then failed two more outline attempts with `invalid type: map, expected a string`. Both model replies encoded `cautions` as objects with `content` and `sourcePages`, whereas the original contract required strings. Increasing automatic retries alone did not resolve this deterministic mismatch; the lifetime attempt cap then disabled continuation.

The parser now accepts either plain caution strings or the exact cited-caution shape. Cited cautions retain their content and original page numbers in the stored Markdown text. Page membership, uniqueness, nonempty text, size limits, unknown-key rejection and all other schema validation remain enforced. Arbitrary objects in other string fields are not flattened. Outline and lesson prompts now explicitly describe caution element types.

Tasks persist an `attemptLimit`, defaulting to three for existing saved records. An explicit user continuation can grant exhausted unfinished tasks another batch of three attempts. Automatic retries cannot extend this limit; completed work and all historical attempts are retained. The UI no longer permanently disables continuation at the first exhausted batch.

The paper-guide landing panel now separates page coverage from generated teaching topics, uses a single primary continuation action, presents failures in a recovery card with collapsed technical details, and moves processing logs below the reading content. Unplanned topic totals display as pending rather than misleading `0/0`. The argument is expanded by default when available. Initial, failed, narrow and dark appearances were inspected in a local development preview using fixture data; no release executable was compiled or replaced.

Validation: all three actual saved outline outputs replay successfully (6/5/6 topics respectively). Focused runtime tests: 32 passed. Desktop host paper-reading tests: 7 passed. UI/PDF tests: 38 passed. TypeScript check passed. Browser preview: no page errors or horizontal overflow at 390px viewport. This is parser/recovery verification, not a new model-generated full-paper teaching acceptance run. The user's database and running application were not changed.

Follow-up workspace suite: 1218 passed, 0 failed, 5 ignored.
