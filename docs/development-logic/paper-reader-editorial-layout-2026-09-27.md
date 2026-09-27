# Paper reader editorial layout

The reader-facing guide has been rebuilt around a reading path and an article, replacing the previous stacked overview cards, topic tiles and task dashboard. `PaperGuideView` owns a lightweight chapter selection, original-page inspection and previous/next navigation. It consumes the existing source-bound outline/lesson schema; no backend protocol, model execution or saved result has been replaced.

- Wide screens use a sticky contents column and a bounded article column. Narrow readers switch to a labeled chapter selector.
- The default chapter introduces the paper and its argument. Topic chapters separate intuition, notation/assumptions, reasoning steps, teaching examples, evidence and self-checks.
- Figure and experiment topics open a full original-page viewer. Formula topics prioritize reasoning, with an explicit local image toggle. Full pages are rendered from the loaded PDF, without invented crops or remote images. Rendering is bounded and cancelled on navigation/unmount.
- Original source links restore PDF comparison. Selecting chapters alone does not move the PDF or launch another model request.
- Completed results get a compact reader toolbar. Incomplete results retain generation status, cancellation and retry; processing coverage remains available below the article. Draft / unreviewed labels stay visible.
- Single-line display equations embedded between prose paragraphs now render as display math. Fenced code remains unchanged.

Validation: 41 focused reader tests passed; TypeScript check passed. Browser checks confirmed source return to PDF, mobile chapter selection, retry availability after failure, no page errors and no horizontal overflow. Wide, narrow, light and dark renderings were inspected. Development screenshots use explicitly labeled fixture explanations and the local Attention Is All You Need PDF; they do not establish real-model teaching acceptance. No EXE or release bundle was built, as requested.

Preview artifacts: `desktop/.somniq/ui-reading-recovery/editorial-overview.png`, `editorial-formula.png`, `editorial-source.png`, `editorial-narrow.png`, `editorial-dark.png`.
