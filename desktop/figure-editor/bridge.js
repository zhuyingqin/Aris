// Sandboxed frame: SVG-Edit never receives Tauri IPC, credentials or project paths.
// On Windows, wry injects every initialization script into child frames too, so
// Tauri's `ipc`, `isTauri` and `__TAURI_INTERNALS__` arrive here non-configurable.
// Hide what can be hidden, then cut the transport they share: the `ipc` custom
// protocol is outside this page's CSP connect-src, and the postMessage fallback
// only reaches native through chrome.webview. Refuse to start if that survives.
const channel = location.hash.slice(1);
const hide = (target, key) => {
  try { Object.defineProperty(target, key, { value: undefined, writable: false, configurable: false }); } catch { /* Verified below. */ }
};
for (const key of ['__TAURI_INTERNALS__', '__TAURI__', 'ipc', 'isTauri']) hide(window, key);
if (window.chrome?.webview !== undefined) hide(window.chrome, 'webview');
if (window.chrome?.webview !== undefined) hide(window, 'chrome');
if (window.chrome?.webview !== undefined) {
  parent.postMessage({ channel, type: 'error', message: 'The editor cannot start with native IPC exposed.' }, '*');
  throw new Error('Native IPC isolation failed');
}
// Opaque-origin frames cannot use browser storage. SVG-Edit reads the storage
// property during startup; keep it confined to this frame's lifetime.
for (const name of ['localStorage', 'sessionStorage']) {
  const values = new Map();
  Object.defineProperty(window, name, { value: {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)), clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; },
  } });
}
const { default: Editor } = await import('./Editor.js');
const { preserveGroupStyles } = await import('./preserve-group-styles.js');
const editor = new Editor(document.getElementById('container'));
editor.setConfig({
  allowInitialUserOverride: false, preventAllURLConfig: true,
  preventURLContentLoading: true, lockExtensions: true, noDefaultExtensions: true,
  extensions: ['ext-markers', 'ext-connector', 'ext-grid', 'ext-panning'], userExtensions: [], noStorageOnLoad: true,
  no_save_warning: true, canvasName: 'somniq-figure', imgPath: './images',
});
const send = (type, extra = {}) => parent.postMessage({ channel, type, ...extra }, '*');
let loading = false;
let loaded = false;
let baseline = '';
let lastNotified = '';
let autoFit = true;

function clean(source) {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG XML');
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (attr.namespaceURI && !['http://www.w3.org/2000/xmlns/', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'].includes(attr.namespaceURI)) node.removeAttributeNode(attr);
      else if (attr.name === 'class' && attr.value !== 'layer') node.removeAttributeNode(attr);
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

await editor.init();
preserveGroupStyles(editor.svgCanvas);
// SVG-Edit controls use open shadow roots. Theme only their chrome; the
// workarea and the document's SVG elements never enter this traversal.
const controlStyle = `
  :host { color: var(--somniq-text); font-family: var(--somniq-font-family); font-size: inherit; }
  img { filter: var(--somniq-icon-filter); }
  span, label { color: var(--somniq-muted) !important; font: inherit; }
  input, select, textarea, elix-input, elix-number-spin-box {
    color: var(--somniq-text); font: inherit;
    background-color: var(--somniq-raised);
    border: 1px solid var(--somniq-border); border-radius: 5px;
  }
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--somniq-accent); outline-offset: 1px;
  }
  div.pressed, .overall.pressed .menu-button, .overall.pressed .button-icon,
  .overall.pressed .handle {
    background: color-mix(in srgb, var(--somniq-accent) 14%, var(--somniq-surface)) !important;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--somniq-accent) 30%, transparent);
  }
  div:not(.small), .menu-button { border-radius: 6px; }
`;
function themeControls(root) {
  for (const element of root.querySelectorAll('*')) {
    if (!element.shadowRoot) continue;
    if (!element.shadowRoot.querySelector('style[data-somniq-control]')) {
      const style = document.createElement('style');
      style.dataset.somniqControl = '';
      const iconControl = ['se-button', 'se-flyingbutton', 'se-input', 'se-spin-input', 'se-list-item', 'se-zoom', 'se-list'].includes(element.localName);
      style.textContent = iconControl ? controlStyle : controlStyle.replace('img { filter: var(--somniq-icon-filter); }', '');
      element.shadowRoot.append(style);
    }
    themeControls(element.shadowRoot);
  }
}
for (const tray of document.querySelectorAll('#tools_top, #tools_left, #tools_bottom, #sidepanels')) {
  themeControls(tray);
  new MutationObserver(() => themeControls(tray)).observe(tray, { childList: true, subtree: true });
}
// In 7.4.2 the generic undo recorder compares getAttribute('#text'), which
// cannot observe textContent changes. Record those changes with its own public
// history commands while retaining native attribute editing and undo behavior.
const nativeChangeAttribute = editor.svgCanvas.changeSelectedAttribute.bind(editor.svgCanvas);
editor.svgCanvas.changeSelectedAttribute = (attribute, value, elements) => {
  if (attribute !== '#text') return nativeChangeAttribute(attribute, value, elements);
  const targets = (elements ?? editor.svgCanvas.getSelectedElements()).filter(Boolean);
  const previous = targets.map((element) => element.textContent);
  nativeChangeAttribute(attribute, value, elements);
  const { BatchCommand, ChangeElementCommand } = editor.svgCanvas.history;
  const command = new BatchCommand('Edit text');
  targets.forEach((element, index) => {
    if (element.textContent !== previous[index]) command.addSubCommand(new ChangeElementCommand(element, { '#text': previous[index] }, 'Edit text'));
  });
  if (!command.isEmpty()) {
    editor.svgCanvas.undoMgr.addCommandToHistory(command);
    editor.svgCanvas.call('changed', targets);
  }
};
// SVG-Edit's group-context double-click can leave the group selected while its
// text input edits a child. Select the actual SVG text before entering edit mode
// so text updates and undo apply to the label, including transformed/clip groups.
document.addEventListener('dblclick', (event) => {
  const text = event.target?.closest?.('text');
  if (!text || !editor.svgCanvas.getSvgContent().contains(text)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  editor.svgCanvas.selectOnly([text], true);
  editor.svgCanvas.textActions.start(text);
}, true);
function notifyChange() {
  if (loading || !loaded) return;
  const value = clean(editor.svgCanvas.getSvgString());
  if (value !== baseline && value !== lastNotified) { lastNotified = value; send('dirty'); }
}
const previousChanged = editor.svgCanvas.bind('changed', (win, elements) => {
  previousChanged?.(win, elements);
  requestAnimationFrame(notifyChange);
});
// Keep the initial overview fitted as the app docks/collapses panels. Once the
// user interacts with the editor, retain their zoom and pan through resizing.
for (const type of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(type, () => { if (loaded) autoFit = false; }, { capture: true, passive: true });
let fitFrame;
function fitOverview() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    if (!autoFit || !loaded || loading) return;
    try { editor.zoomChanged(window, 'canvas'); } catch { /* Preserve the current viewport. */ }
  });
}
window.addEventListener('resize', fitOverview);
// Some SVG-Edit group/clip drags change transforms without firing `changed`.
// Check the authoritative serialization after user interaction as well.
for (const type of ['pointerup', 'keyup', 'input', 'change']) document.addEventListener(type, () => requestAnimationFrame(notifyChange));
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.channel !== channel) return;
  const { type, requestId, svg } = event.data;
  if (type === 'theme') {
    const root = document.documentElement;
    root.dataset.theme = event.data.mode === 'light' ? 'light' : 'dark';
    for (const name of ['bg', 'surface', 'raised', 'border', 'text', 'muted', 'accent']) {
      const value = event.data.colors?.[name] ?? (name === 'accent' ? event.data.accent : undefined);
      root.style.removeProperty(`--somniq-${name}`);
      // Restrict values to literal colors, then let the CSS parser validate.
      if (typeof value === 'string' && value.length <= 160 && /^(#[\da-f]{3,8}|(?:rgb|rgba|color|color-mix)\([\w\s.,%/+\-#]+\))$/i.test(value) && CSS.supports('color', value)) root.style.setProperty(`--somniq-${name}`, value);
    }
    const size = event.data.fontSize;
    root.style.removeProperty('--somniq-font-size');
    if (typeof size === 'number' && Number.isFinite(size) && size >= 9 && size <= 24) root.style.setProperty('--somniq-font-size', `${size}px`);
    const family = event.data.fontFamily;
    root.style.removeProperty('--somniq-font-family');
    if (typeof family === 'string' && family.length < 300 && !/[;{}]/.test(family) && CSS.supports('font-family', family)) root.style.setProperty('--somniq-font-family', family);
    return;
  }
  try {
    if (type === 'load' && typeof svg === 'string' && svg.length <= 2 * 1024 * 1024) {
      loading = true;
      if (editor.svgCanvas.setSvgString(svg) === false) throw new Error('SVG-Edit could not load this SVG');
      loaded = true; autoFit = true; editor.updateCanvas();
      // Open with the whole figure in view; zoom is not part of the SVG.
      try { editor.zoomChanged(window, 'canvas'); } catch { /* Keep SVG-Edit's default zoom. */ }
      fitOverview();
      baseline = clean(editor.svgCanvas.getSvgString()); lastNotified = baseline;
      send('loaded', { requestId });
    } else if (type === 'serialize' && loaded) {
      send('serialized', { requestId, svg: clean(editor.svgCanvas.getSvgString()) });
    }
  } catch (error) { send('error', { requestId, message: String(error) }); }
  finally { loading = false; }
});
send('ready');
