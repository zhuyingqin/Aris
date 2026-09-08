# Generation contract

Read this before creating a page or changing its visual direction. The goal is
to convert prose and visual references into an implementation-ready contract,
without hard-coding choices that the user did not request.

## 1. Extract the design logic

For each supplied reference, record only what changes the build:

- **Composition:** focal point, first-viewport balance, reading path, whitespace,
  persistent chrome, and foreground/background relationship.
- **Visual primitives:** type roles, palette, contrast, surfaces, borders,
  radii, icon language, image treatment, and recurring motifs.
- **Behavior:** navigation, reveal order, hover/focus feedback, scroll-linked
  behavior, state transitions, and reduced-motion equivalent.
- **Responsive invariants:** what must remain visible and legible, what stacks,
  reorders, collapses, scrolls, or becomes in-flow at each meaningful width.
- **Assets:** source, crop/focal point, loading strategy, license or ownership
  concern when known, and a credible missing/failed-media fallback.

Label uncertain observations as assumptions. Do not infer hidden pages or
interactions from a single screenshot.

## 2. Write the render contract

Keep it compact but executable:

```markdown
Page goal:
Primary user action:
Visual thesis: <one sentence naming the distinctive composition and mood>

First viewport:
- focal content and its anchor
- supporting content and primary action
- background/media relationship

Structure:
- route/section/component: responsibility and semantic element

Tokens:
- type roles; spacing rhythm; palette/contrast; radii/elevation; motion

Responsive transformations:
- narrow: explicit stack/order/visibility/edge padding/touch behavior
- medium: changes from narrow
- wide: max width, anchors, columns, and deliberate empty space

States and fallbacks:
- loading, empty, error, long content, media failure, reduced motion

Acceptance evidence:
- viewports, interaction states, and observable pass conditions
```

Exact text, media URLs, dimensions, timing, algorithms, and component APIs are
appropriate when the user or reference fidelity requires them. Prefer semantic
layout rules and shared tokens over long lists of framework-specific classes.

## 3. Protect quality while implementing

- Start from the content hierarchy and visual thesis, not a default landing-page
  template. Avoid interchangeable hero, gradient, and card patterns unless they
  are supported by the product or reference.
- Keep one clear primary action in the first viewport. Decorative motion must
  not compete with reading or input.
- Make scroll-linked media progressive: the page remains usable while assets
  load, after they fail, and when motion is reduced. Bound decoded frames,
  canvas resolution, and animation work for mobile devices.
- Preserve content and interaction parity across widths; responsive design is a
  deliberate recomposition, not merely smaller type and tighter padding.
- Treat external fonts and media as fallible. Use suitable system fallbacks and
  never make core content depend on a cross-origin asset loading successfully.
