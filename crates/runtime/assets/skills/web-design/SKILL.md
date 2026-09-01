---
name: web-design
description: MUST use when creating, redesigning, polishing, or visually validating a web page, web UI, dashboard, or frontend interaction.
allowed-tools: read_file, write_file, edit_file, bash, ToolSearch, mcp__playwright__*
---

# Web Design

Use this workflow for **$ARGUMENTS**. Treat the browser as a visual evidence
source, not as a text-only test runner. If a browser MCP is available, its
inline image results must be inspected as images by the model.

## Choose the mode

- **Generate or redesign:** before implementation, read
  [generation-contract.md](references/generation-contract.md) and turn the
  request and any visual references into an explicit render contract. Preserve
  an existing product's visual language unless the user asked for a new one.
- **Polish or validate:** inspect the current implementation first. Keep its
  sound design decisions and make the smallest corrections supported by visual
  evidence; a new aesthetic direction is out of scope unless requested.

When a reference page, image, or video is supplied, inspect it directly. Split
what you observe into composition, visual primitives, behavior, content, and
assets. Reproduce the requested experience and transferable design logic, not
incidental implementation details or unrequested branding.

## Required workflow

1. Write a short design brief before changing code. Record the page goal,
   primary user and task, content hierarchy, one-sentence visual thesis,
   interaction states, responsive invariants, asset plan, and acceptance
   criteria. Prefer existing product patterns unless the brief explicitly
   calls for a new direction.
2. For generation or redesign, write the render contract: page and component
   structure, first-viewport composition, layout anchors, type hierarchy,
   responsive transformations, motion sequence, and loading/error/fallback
   behavior. Be exact where fidelity or behavior depends on exactness, but do
   not dump framework classes when a semantic rule is clearer.
3. Define a small design-token set before implementation: type scale and
   weights, spacing rhythm, colors and contrast targets, radii, elevation,
   container widths, and motion/interaction rules. Keep tokens in the
   project's existing styling system. The finished page must have a deliberate
   visual signature rather than a generic hero-plus-card composition.
4. Implement the page and its states. Keep semantic HTML, keyboard access,
   focus visibility, loading/empty/error states, responsive behavior,
   `prefers-reduced-motion`, and asset failure fallbacks in scope; do not
   optimize only for the first desktop screenshot. For media-heavy or
   scroll-linked effects, bound memory and device-pixel-ratio work and clean up
   observers, animation frames, object URLs, and decoded media.
5. Use `ToolSearch` to discover the currently available browser MCP tools.
   Do not assume a particular Playwright tool name. Navigate to the page and
   capture at least:
   - desktop: 1440×900;
   - mobile: 390×844.
6. Inspect the returned screenshots as images. Review hierarchy, alignment,
   spacing, typography, contrast, clipping/overflow, responsive composition,
   and the relevant interaction state. Read
   [visual-review-rubric.md](references/visual-review-rubric.md) when doing
   the review.
7. Fix blocking visual issues and recapture the affected viewport(s). Run at
   most three implementation → screenshot → review cycles in one turn. A
   cycle is complete only when the latest screenshots reflect the latest code.
8. Run the project's focused checks and build verification. Save the design
   brief, render contract when used, screenshot paths, review findings, and
   command results under `.somniq/reviews/web/<target>/<run-id>/`. Never put
   base64 image data in a text report or event log.

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
