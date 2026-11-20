// The comparison matrix page: draws the model, takes the user's dimension edits, hands work to the agent.
import { COPY, pickLanguage } from "pkg:matrix/copy.mjs";
import {
  clean, cellOf, stateOf, addDimension, updateDimension, moveDimension, removeDimension, coverage, serialize,
} from "pkg:matrix/model.mjs";

const WIDGET = "matrix";
const LOCALE = { en: "en", cn: "zh-CN", es: "es" };
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}
const keyed = (node, key) => { node.dataset.key = key; return node; };
const button = (label, onclick, extra = {}) => el("button", { type: "button", textContent: label, onclick, ...extra });

let lang = "en";
let copy = COPY.en;
let model = clean(null);
let selected = null;   // { paper, dimension } ids
let editing = false;
let confirming = null; // id of the dimension whose delete waits for a second click
let confirmTimer = 0;
let deferred = false;  // data arrived while the user was typing in the editor
let draft = "";        // the add-dimension field, kept across redraws
let exportPath = "";

function status(message, alert = false) {
  const line = $("status");
  line.textContent = message;
  line.className = alert ? "alert" : "";
}

async function save(next) {
  if (next === model) return;
  const before = model;
  model = serialize(next);
  render();
  try {
    await somniq.set(WIDGET, model);
    status("");
  } catch (error) {
    model = before;
    render();
    status(copy.failed + (error && error.message ? error.message : String(error)), true);
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(LOCALE[lang], { dateStyle: "medium", timeStyle: "short" });
}

// ---- dimensions editor -------------------------------------------------------

function addForm() {
  const input = keyed(el("input", { value: draft, placeholder: copy.addPlaceholder, maxLength: 120, ariaLabel: copy.add }), "add");
  input.oninput = () => { draft = input.value; };
  return el("form", {
    className: "add",
    onsubmit: (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      draft = "";
      save(addDimension(model, input.value));
    },
  }, input, keyed(el("button", { type: "submit", textContent: copy.add }), "add-submit"));
}

function askDelete(id) {
  if (confirming === id) {
    confirming = null;
    if (selected && selected.dimension === id) selected = null;
    save(removeDimension(model, id));
    return;
  }
  confirming = id;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { confirming = null; render(); }, 4000);
  render();
}

function editorRow(d, index, count) {
  const name = keyed(el("input", { value: d.name, maxLength: 120, ariaLabel: `${copy.name} ${index + 1}` }), `name:${d.id}`);
  name.onchange = () => {
    if (name.value.trim() && name.value.trim() !== d.name) save(updateDimension(model, d.id, { name: name.value }));
    else name.value = d.name;
  };
  const hint = keyed(el("input", { value: d.hint ?? "", maxLength: 400, placeholder: copy.hint, ariaLabel: `${copy.hint}: ${d.name}` }), `hint:${d.id}`);
  hint.onchange = () => { if (hint.value.trim() !== (d.hint ?? "")) save(updateDimension(model, d.id, { hint: hint.value })); };
  const up = keyed(button("↑", () => save(moveDimension(model, d.id, -1)), { ariaLabel: `${copy.up}: ${d.name}`, title: copy.up, disabled: index === 0 }), `up:${d.id}`);
  const down = keyed(button("↓", () => save(moveDimension(model, d.id, 1)), { ariaLabel: `${copy.down}: ${d.name}`, title: copy.down, disabled: index === count - 1 }), `down:${d.id}`);
  const asking = confirming === d.id;
  const remove = keyed(button(asking ? copy.confirm : copy.remove, () => askDelete(d.id), {
    className: asking ? "danger confirm" : "danger", ariaLabel: `${asking ? copy.confirm : copy.remove}: ${d.name}`,
  }), `remove:${d.id}`);
  return el("li", {}, el("span", { className: "ordinal", textContent: String(index + 1).padStart(2, "0") }), name, hint,
    el("span", { className: "row-actions" }, up, down, remove));
}

function editor() {
  const dims = model.dimensions;
  return [
    el("h2", { textContent: copy.dims }),
    dims.length ? el("ol", { className: "dims" }, ...dims.map((d, i) => editorRow(d, i, dims.length))) : el("p", { className: "muted", textContent: copy.noDims }),
    addForm(),
  ];
}

// ---- matrix ----------------------------------------------------------------

function moveFocus(event, row, column) {
  const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
  if (!step) return;
  const target = document.querySelector(`[data-key="cell:${row + step[0]}:${column + step[1]}"]`);
  if (target) { event.preventDefault(); target.focus(); }
}

function cellButton(paper, dimension, row, column) {
  const cell = cellOf(model, paper.id, dimension.id);
  const state = stateOf(cell);
  const on = !!selected && selected.paper === paper.id && selected.dimension === dimension.id;
  const label = `${paper.title} · ${dimension.name}: ${state === "empty" ? copy.empty : cell.value}${state === "evidenced" ? "" : ` (${copy.noEvidence})`}`;
  const node = keyed(el("button", {
    type: "button", className: `cell ${state}${on ? " on" : ""}`, ariaPressed: String(on), ariaLabel: label,
    onclick: () => { selected = on ? null : { paper: paper.id, dimension: dimension.id }; render(); },
    onkeydown: (event) => moveFocus(event, row, column),
  }), `cell:${row}:${column}`);
  if (state !== "empty") node.append(el("span", { className: "value", textContent: cell.value }));
  if (state === "evidenced") node.append(el("span", { className: "source", textContent: cell.evidence }));
  else node.append(el("span", { className: "tag", textContent: copy.noEvidence }));
  return node;
}

function paperHeader(paper) {
  const title = paper.path
    ? keyed(el("button", { type: "button", className: "link", textContent: paper.title, title: `${copy.openPaper}: ${paper.path}`, onclick: () => somniq.openFile(paper.path) }), `paper:${paper.id}`)
    : el("span", { className: "title", textContent: paper.title });
  return el("th", { scope: "row", className: "paper" }, title,
    paper.year !== undefined ? el("span", { className: "year", textContent: String(paper.year) }) : null);
}

function matrix() {
  const dims = model.dimensions;
  const head = el("tr", {}, el("th", { scope: "col", className: "paper", textContent: copy.paper }),
    ...dims.map((d) => el("th", { scope: "col", title: d.hint ?? "" },
      el("span", { className: "dim", textContent: d.name }), d.hint ? el("span", { className: "hint", textContent: d.hint }) : null)));
  const rows = model.papers.map((paper, r) => el("tr", {}, paperHeader(paper),
    ...dims.map((d, c) => el("td", {}, cellButton(paper, d, r, c)))));
  if (!model.papers.length) rows.push(el("tr", { className: "note" }, el("td", { colSpan: dims.length + 1, textContent: copy.noPapers })));
  return el("div", { className: "scroll" },
    el("table", { className: "matrix" }, el("caption", { className: "sr", textContent: copy.title }), el("thead", {}, head), el("tbody", {}, ...rows)));
}

function emptyState() {
  return el("div", { className: "empty-state" },
    el("h2", { textContent: copy.emptyTitle }),
    el("p", { textContent: copy.emptyBody }),
    keyed(button(copy.fill, fill, { className: "primary" }), "empty-fill"),
    addForm());
}

function detail() {
  const box = $("detail");
  const paper = selected && model.papers.find((p) => p.id === selected.paper);
  const dimension = selected && model.dimensions.find((d) => d.id === selected.dimension);
  if (!paper || !dimension) {
    selected = null;
    box.className = "detail idle";
    box.replaceChildren(...(model.papers.length && model.dimensions.length ? [el("p", { textContent: copy.select })] : []));
    return;
  }
  const cell = cellOf(model, paper.id, dimension.id);
  const state = stateOf(cell);
  const actions = el("div", { className: "detail-actions" });
  if (cell && cell.path) actions.append(keyed(button(copy.openSource, () => somniq.openFile(cell.path), { title: cell.path, className: "primary" }), "open-source"));
  else if (paper.path) actions.append(keyed(button(copy.openPaper, () => somniq.openFile(paper.path), { title: paper.path }), "open-paper"));
  actions.append(keyed(button(copy.close, closeDetail), "close"));
  box.className = `detail ${state}`;
  box.replaceChildren(...[
    el("p", { className: "where" }, el("span", { className: "dim", textContent: dimension.name }), el("span", { className: "of", textContent: paper.title })),
    el("p", { className: state === "empty" ? "full none" : "full", textContent: state === "empty" ? copy.empty : cell.value }),
    cell && cell.evidence ? el("p", { className: "evidence" }, el("span", { className: "label", textContent: copy.evidence }), el("span", { textContent: cell.evidence })) : null,
    state === "evidenced" ? null : el("p", { className: "warn", textContent: state === "empty" ? copy.emptyCell : copy.unsupported }),
    dimension.hint ? el("p", { className: "hintline", textContent: dimension.hint }) : null,
    actions].filter(Boolean));
}

function closeDetail() {
  if (!selected) return;
  const row = model.papers.findIndex((p) => p.id === selected.paper);
  const column = model.dimensions.findIndex((d) => d.id === selected.dimension);
  selected = null;
  render();
  const cell = document.querySelector(`[data-key="cell:${row}:${column}"]`);
  if (cell) cell.focus();
}

// ---- coverage ----------------------------------------------------------------

function coverageView() {
  const section = $("coverage");
  section.hidden = !model.papers.length || !model.dimensions.length;
  if (section.hidden) { section.replaceChildren(); return; }
  const rows = coverage(model).map((c) => {
    const meter = el("div", { className: "meter", ariaHidden: "true" }, el("span"));
    meter.firstChild.style.width = `${Math.round(c.ratio * 100)}%`;
    const count = copy.evidenced(c.evidenced, c.total) + (c.unsupported ? ` · ${copy.loose(c.unsupported)}` : "");
    return el("li", { className: c.gap ? "gap" : "" },
      el("div", { className: "line" },
        el("span", { className: "name", textContent: c.dimension.name }),
        c.gap ? el("span", { className: "badge", textContent: copy.gap }) : null,
        el("span", { className: "count", textContent: count })),
      meter,
      c.chips.length ? el("ul", { className: "chips" }, ...c.chips.map((chip) =>
        el("li", {}, el("span", { textContent: chip.label }), el("b", { textContent: String(chip.count) })))) : null);
  });
  section.replaceChildren(el("h2", { textContent: copy.coverage }), el("p", { className: "muted", textContent: copy.coverageNote }),
    el("ol", { className: "coverage-list" }, ...rows));
}

// ---- the whole page ----------------------------------------------------------

function render() {
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  const blank = !model.dimensions.length && !model.papers.length;
  document.documentElement.lang = lang === "cn" ? "zh" : lang;
  $("title").textContent = copy.title;
  $("summary").textContent = copy.summary(model.papers.length, model.dimensions.length);
  $("updated").textContent = model.updatedAt ? `${copy.updated} ${formatDate(model.updatedAt)}` : "";
  $("fill").textContent = copy.fill;
  $("fill").hidden = blank;
  $("edit").textContent = editing ? copy.doneEdit : copy.edit;
  $("edit").setAttribute("aria-expanded", String(editing));
  $("edit").hidden = blank;
  $("export").textContent = copy.export;
  $("export-path").placeholder = copy.exportPath;
  $("export-path").setAttribute("aria-label", copy.exportPath);
  $("export-form").hidden = blank;
  const showEditor = !blank && (editing || !model.dimensions.length);
  $("editor").hidden = !showEditor;
  $("editor").replaceChildren(...(showEditor ? editor() : []));
  $("body").replaceChildren(blank ? emptyState() : matrix());
  detail();
  coverageView();
  if (focused) {
    const again = document.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    if (again && again !== document.activeElement) again.focus();
  }
}

function fill() { somniq.prompt(copy.fillPrompt(model.dimensions)); }

$("fill").onclick = fill;
$("edit").onclick = () => { editing = !editing; confirming = null; render(); };
$("export-path").oninput = (event) => { exportPath = event.target.value; };
$("export-form").onsubmit = (event) => { event.preventDefault(); somniq.prompt(copy.exportPrompt(exportPath.trim())); };
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && selected) closeDetail(); });
// A redraw while the user types would drop what they typed: wait until they leave the editor.
$("editor").addEventListener("focusout", () => setTimeout(() => {
  if (deferred && !$("editor").contains(document.activeElement)) { deferred = false; render(); }
}));

const initial = await somniq.ready();
lang = pickLanguage(initial.locale ?? initial.language);
copy = COPY[lang];
model = clean(initial.data ? initial.data[WIDGET] : null);
render();
somniq.onData((data) => {
  model = clean(data ? data[WIDGET] : null);
  const typing = document.activeElement && document.activeElement.tagName === "INPUT" && $("editor").contains(document.activeElement);
  if (typing) deferred = true;
  else render();
});
