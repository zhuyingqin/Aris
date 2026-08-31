# Visual review rubric

Use the latest screenshot for each viewport. Findings should name the
viewport, severity (`blocker`, `major`, or `minor`), evidence, and the smallest
useful correction.

## Review order

1. **Composition:** Is the primary action obvious? Does the visual hierarchy
   match the page goal? Are dense regions grouped and scannable?
2. **Layout:** Check container width, grid/flex alignment, spacing rhythm,
   baseline alignment, and safe-area/padding behavior.
3. **Type:** Check font loading/fallback, size, weight, line height, wrapping,
   truncation, and heading-to-body contrast.
4. **Color and affordance:** Check text/background contrast, action emphasis,
   disabled/hover/focus states, borders, shadows, and status semantics.
5. **Responsive behavior:** Compare desktop and mobile for overflow,
   accidental horizontal scrolling, collapsed navigation, touch target size,
   reordered content, and preserved primary actions.
6. **Content states:** Inspect loading, empty, error, and long-content cases
   when they are part of the requested surface.

## Acceptance gate

Visual verification passes only when no blocker or major issue remains in the
latest screenshots, focused checks pass, and the evidence directory records
the exact viewport, URL/route, timestamp or run id, and commands used.
