// SVG-Edit 7.4.2 unwraps groups without transferring inherited presentation.
// Preserve only properties whose computed value changes when the group goes
// away. Relative font sizes are resolved before losing their original context.
const paint = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity',
  'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'clip-rule'];
const typography = ['font-family', 'font-size', 'font-style', 'font-weight',
  'font-stretch', 'text-anchor', 'letter-spacing', 'word-spacing', 'dominant-baseline'];
const graphicElements = new Set(['g', 'text', 'tspan', 'path', 'rect', 'circle',
  'ellipse', 'line', 'polyline', 'polygon', 'image', 'use']);

export function preserveGroupStyles(canvas) {
  const nativeUngroup = canvas.ungroupSelectedElement;
  canvas.ungroupSelectedElement = (...args) => {
    const group = canvas.getSelectedElements().filter(Boolean)[0];
    if (group?.localName !== 'g') return nativeUngroup.apply(canvas, args);
    const parent = group.parentNode;
    const snapshots = [...group.children].filter(el => graphicElements.has(el.localName)).map(el => {
      const properties = el.matches('g,text,tspan') ? [...paint, ...typography] : paint;
      const css = getComputedStyle(el);
      return { el, transform: el.getAttribute('transform'), values: Object.fromEntries(properties.map(key => [key, css.getPropertyValue(key)])) };
    });
    const { BatchCommand, ChangeElementCommand } = canvas.history;
    const batch = new BatchCommand('Ungroup Elements');
    const manager = canvas.undoMgr;
    const record = manager.addCommandToHistory;
    // Native ungroup may record several commands (e.g. opacity and transforms).
    // Collect those and the presentation changes into one reversible action.
    manager.addCommandToHistory = command => batch.addSubCommand(command);
    try {
      nativeUngroup.apply(canvas, args);
    } finally {
      manager.addCommandToHistory = record;
      if (!batch.isEmpty()) record.call(manager, batch);
    }
    for (const { el, values, transform } of snapshots) {
      if (el.parentNode !== parent) continue;
      const css = getComputedStyle(el);
      const changed = Object.entries(values).filter(([key, value]) => value !== css.getPropertyValue(key));
      const previous = {};
      // Native ungroup does not record child transforms for a pure rotation.
      // Snapshot them as well so undo never applies the group rotation twice.
      if (el.getAttribute('transform') !== transform) previous.transform = transform;
      if (!changed.length && !Object.keys(previous).length) continue;
      const oldStyle = el.getAttribute('style');
      for (const [key, value] of changed) {
        // SVG-Edit retains spacing/baseline attributes on text, but not groups.
        // Keep these as inline declarations on groups for save/reopen support.
        if (el.localName === 'g' && ['letter-spacing', 'word-spacing', 'dominant-baseline'].includes(key)) {
          el.style.setProperty(key, value);
        } else {
          previous[key] = el.getAttribute(key);
          el.style.removeProperty(key);
          el.setAttribute(key, value);
        }
      }
      if (el.getAttribute('style') !== oldStyle) {
        previous.style = oldStyle;
        if (!el.style.length) el.removeAttribute('style');
      }
      batch.addSubCommand(new ChangeElementCommand(el, previous, 'Preserve group appearance'));
    }
    // Refresh selection geometry after the styles have been restored.
    canvas.selectOnly(canvas.getSelectedElements().filter(Boolean), true);
    canvas.call('changed', snapshots.map(({ el }) => el));
  };
}
