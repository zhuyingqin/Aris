// Sandboxed frame: SVG-Edit never receives Tauri IPC, credentials or project paths.
const channel = location.hash.slice(1);
for (const key of ['__TAURI_INTERNALS__', '__TAURI__', 'ipc']) {
  try { Object.defineProperty(window, key, { value: undefined, writable: false, configurable: false }); } catch { /* Check the actual binding below. */ }
  if (window[key] !== undefined) {
    parent.postMessage({ channel, type: 'error', message: 'The editor cannot start with native IPC exposed.' }, '*');
    throw new Error('Native IPC isolation failed');
  }
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
// Some SVG-Edit group/clip drags change transforms without firing `changed`.
// Check the authoritative serialization after user interaction as well.
for (const type of ['pointerup', 'keyup', 'input', 'change']) document.addEventListener(type, () => requestAnimationFrame(notifyChange));
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.channel !== channel) return;
  const { type, requestId, svg } = event.data;
  try {
    if (type === 'load' && typeof svg === 'string' && svg.length <= 2 * 1024 * 1024) {
      loading = true;
      if (editor.svgCanvas.setSvgString(svg) === false) throw new Error('SVG-Edit could not load this SVG');
      loaded = true; editor.updateCanvas();
      baseline = clean(editor.svgCanvas.getSvgString()); lastNotified = baseline;
      send('loaded', { requestId });
    } else if (type === 'serialize' && loaded) {
      send('serialized', { requestId, svg: clean(editor.svgCanvas.getSvgString()) });
    }
  } catch (error) { send('error', { requestId, message: String(error) }); }
  finally { loading = false; }
});
send('ready');
