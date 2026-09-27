# Local web reading for paper explanations

The existing source-bound guide now offers a full-width web reading mode inside the desktop PDF reader. It reuses saved guide data and the existing Markdown/math renderer; no separate remote site or model-generated executable HTML is introduced. Switching modes does not start another model task.

Completed guides emphasize the paper and article rather than generation counters. Topic navigation does not move the PDF; explicit original-page buttons exit web reading and restore PDF comparison. Original-page thumbnails render only when expanded. Articles expose a local section navigation for intuition, steps, evidence and self-check, with numbered reasoning steps and distinct teaching-origin labels. Incomplete tasks retain existing progress and recovery controls. Independent review remains paused and draft status remains visible.

Verification: 39 focused reader/UI tests passed; TypeScript check passed. Browser checks confirmed PDF hiding, source-link return, no horizontal overflow at a 390px viewport, and no page errors. The screenshot in desktop/.somniq/ui-reading-recovery/web-reading-example.png uses fixture explanations and an original Attention Is All You Need PDF, not a completed user analysis. No EXE or release frontend bundle was built, per the user's standing instruction.
