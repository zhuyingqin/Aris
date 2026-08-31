---
name: web-design
description: MUST use when creating, redesigning, polishing, or visually validating a web page, web UI, dashboard, or frontend interaction.
allowed-tools: read_file, write_file, edit_file, bash, ToolSearch, mcp__playwright__*
---

# Web Design

Use this workflow for **$ARGUMENTS**. Treat the browser as a visual evidence
source, not as a text-only test runner. If a browser MCP is available, its
inline image results must be inspected as images by the model.

## Required workflow

1. Write a short design brief before changing code. Record the page goal,
   primary user, content hierarchy, visual direction, interaction states,
   responsive breakpoints, and acceptance criteria. Prefer existing product
   patterns unless the brief explicitly calls for a new direction.
2. Define a small design-token set before implementation: type scale and
   weights, spacing rhythm, colors and contrast targets, radii, elevation,
   container widths, and motion/interaction rules. Keep tokens in the
   project's existing styling system.
3. Implement the page and its states. Keep semantic HTML, keyboard access,
   focus visibility, loading/empty/error states, and responsive behavior in
   scope; do not optimize only for the first desktop screenshot.
4. Use `ToolSearch` to discover the currently available browser MCP tools.
   Do not assume a particular Playwright tool name. Navigate to the page and
   capture at least:
   - desktop: 1440×900;
   - mobile: 390×844.
5. Inspect the returned screenshots as images. Review hierarchy, alignment,
   spacing, typography, contrast, clipping/overflow, responsive composition,
   and the relevant interaction state. Read
   [visual-review-rubric.md](references/visual-review-rubric.md) when doing
   the review.
6. Fix blocking visual issues and recapture the affected viewport(s). Run at
   most three implementation → screenshot → review cycles in one turn. A
   cycle is complete only when the latest screenshots reflect the latest code.
7. Run the project's focused checks and build verification. Save the design
   brief, screenshot paths, review findings, and command results under
   `.somniq/reviews/web/<target>/<run-id>/`. Never put base64 image data in a
   text report or event log.

## Evidence and failure handling

- Prefer MCP inline `image` content or an image resource blob. Do not ask the
  model to infer a screenshot from a JSON serialization of image bytes.
- Keep textual diagnostics and image content as separate channels. A failed
  assertion may still have a valuable screenshot; retain and review it.
- If browser navigation or screenshot capture is unavailable, report the exact
  limitation and emit `VISUAL_VERIFICATION_UNAVAILABLE`. Do not claim visual
  verification passed and do not substitute a text-only description.
- The independent Reviewer remains a separate product role. Do not claim that
  `LlmReview` performed visual inspection unless the reviewer actually received
  the screenshot content.
