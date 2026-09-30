# Window titlebar visibility

Goal: Keep minimize, maximize, and close controls visible while navigating the paper reader.

Success criteria: Topic and section navigation scrolls only the explanation panel; the desktop shell cannot be programmatically scrolled out of view; focused reader tests and the desktop build pass.

The existing `.somniq/project-goal.json` tracks an unrelated gateway security milestone and is preserved.

The guide used `scrollIntoView({ block: "start" })`, which can scroll all ancestors, including containers with `overflow: hidden`. This can clip the custom window titlebar. Guide navigation now computes the target position within `.lit-paper-analysis` and scrolls that panel directly. The document and app shell use `overflow: clip` to prevent programmatic scrolling of window chrome.

Validation: 18 focused Vitest tests passed across PaperGuideView, PaperReadingPanel, and motionWiring. The guide regression test checks panel-relative scrolling without invoking ancestor-scrolling navigation. Native desktop visual verification remains outstanding.
