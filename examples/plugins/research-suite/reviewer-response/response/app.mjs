// The correspondence desk: one round at a time, each comment beside its response.
import { COPY, pickLanguage } from "pkg:response/copy.mjs";
import { STATUSES, KINDS, clean, serialize, counts, splitReview, snippet, uid } from "pkg:response/model.mjs";

const MAX_PROMPT = 3990; // the host drops a composer text longer than 4000 characters
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "data") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k.includes("-") || !(k in node)) node.setAttribute(k, v === true ? "" : String(v));
    else node[k] = v;
  }
  node.append(...kids.flat().filter((kid) => kid !== null && kid !== undefined && kid !== false));
  return node;
}
const fkey = (rid, cid, field) => JSON.stringify([rid, cid, field]);

let lang = "en", t = COPY.en;
let model = clean(null);
let current;                        // the round on screen (saved as activeRound)
const view = { reviewer: "", status: "" };
const declining = new Set();        // fkey(rid, cid, "") picked "declined", still waiting for a justification
const edits = new Map();            // fkey -> value typed here and not yet saved; survives live updates
let dirty = false, timer = null, phase = "idle", reason = "";
let composing = false, drawLater = false;
let intake = null;                  // the paste box while it is open
let letterFormat = "latex";
let confirming = null;              // the destructive button waiting for its second click
let fieldSeq = 0;

const currentRound = () => model.rounds.find((r) => r.id === current) ?? model.rounds[0];
const roundById = (rid) => model.rounds.find((r) => r.id === rid);
const commentOf = (rid, cid) => roundById(rid)?.comments.find((c) => c.id === cid);
const statusOf = (r) => (c) => (declining.has(fkey(r.id, c.id, "")) ? "declined" : c.status);

// --- Saving ----------------------------------------------------------------------------------
function put(target, field, value) {
  if (field.startsWith("change.")) target.change = { ...(target.change ?? {}), [field.slice(7)]: value };
  else target[field] = value;
}
function edit(rid, cid, field, value, now = false) {
  const target = cid ? commentOf(rid, cid) : roundById(rid);
  if (!target) return;
  put(target, field, value);
  edits.set(fkey(rid, cid, field), value);
  queue(now);
}
function queue(now = false) {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, now ? 0 : 700);
  showSave("pending");
}
async function flush() {
  clearTimeout(timer); timer = null;
  if (!dirty) return;
  dirty = false;
  const sent = new Map(edits);
  model.activeRound = current;
  showSave("saving");
  try {
    await somniq.set("rounds", serialize(model, current));
    for (const [k, v] of sent) if (edits.get(k) === v) edits.delete(k);
    if (!dirty) showSave("saved");
  } catch (error) {
    dirty = true;
    showSave("failed", error?.message ?? String(error));
  }
}
function showSave(next, why = "") {
  phase = next; reason = why;
  const node = $("save");
  node.className = `save ${phase}`;
  node.replaceChildren(phase === "idle" ? "" : t.save[phase], phase === "failed" ? reason : "");
  if (phase === "failed") node.append(" ", el("button", { type: "button", class: "link", textContent: t.retry, onclick: () => flush() }));
}

// The agent (or another view) changed the data: take it, then lay unsaved typing back on top.
function receive(raw) {
  const next = clean(raw);
  for (const [key, value] of edits) {
    const [rid, cid, field] = JSON.parse(key);
    const round = next.rounds.find((r) => r.id === rid);
    const target = cid ? round?.comments.find((c) => c.id === cid) : round;
    if (target) put(target, field, value); else edits.delete(key);
  }
  if (next.activeRound && next.activeRound !== model.activeRound) current = next.activeRound;
  model = next;
  if (!roundById(current)) current = model.activeRound;
  if (edits.size) queue();
  draw();
}

// --- Drawing ---------------------------------------------------------------------------------
function draw() {
  if (composing) { drawLater = true; return; }
  const focused = document.activeElement;
  const key = focused?.dataset?.key;
  const sel = key && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  fieldSeq = 0;
  const r = currentRound();
  $("app").replaceChildren(...[masthead(r), intake ? intakeBox() : null, r ? roundView(r) : emptyState()].filter(Boolean));
  for (const area of document.querySelectorAll("textarea.grow")) fit(area);
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  if (key) focusKey(key, sel);
}
function focusKey(key, sel) {
  const node = [...document.querySelectorAll("[data-key]")].find((n) => n.dataset.key === key);
  if (!node) return;
  node.focus({ preventScroll: true });
  if (sel) try { node.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
}
function fit(area) { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; }
const fid = () => `f${++fieldSeq}`;
const button = (label, onclick, extra = {}) => el("button", { type: "button", textContent: label, onclick, ...extra });
const grow = (props) => el("textarea", { class: "grow", rows: 2, ...props, oninput: (e) => { fit(e.target); props.oninput?.(e); } });

function promptAgent(text, shorter) {
  somniq.prompt(text.length > MAX_PROMPT && shorter ? shorter() : text.slice(0, MAX_PROMPT));
}

function masthead(r) {
  return el("header", { class: "masthead" },
    el("div", { class: "brand" }, el("p", { class: "kicker", textContent: t.kicker }), el("h1", { textContent: t.title })),
    el("div", { class: "actions" },
      button(t.add, toggleIntake, { class: "primary", "aria-expanded": String(Boolean(intake)), data: { key: "act:add" } }),
      r ? el("div", { class: "letter" },
        el("select", { "aria-label": t.format, onchange: (e) => { letterFormat = e.target.value; } },
          ...["latex", "markdown"].map((f) => el("option", { value: f, selected: f === letterFormat, textContent: f === "latex" ? "LaTeX" : "Markdown" }))),
        button(t.letter, async () => { await flush(); promptAgent(t.prompts.letter(named(r), letterFormat)); }, { data: { key: "act:letter" } })) : null));
}
const named = (r) => ({ ...r, name: snippet(r.name, 80), id: snippet(r.id, 80) });

function emptyState() {
  return el("main", { class: "empty" }, el("div", { class: "sheet" },
    el("p", { class: "kicker", textContent: t.emptyKicker }),
    el("h2", { textContent: t.emptyTitle }),
    el("p", { textContent: t.emptyBody }),
    el("div", { class: "row" },
      intake ? null : button(t.paste, toggleIntake, { class: "primary" }),
      button(t.importReview, () => promptAgent(t.prompts.importReview(""))))));
}

function tabs() {
  const move = (e) => {
    const i = model.rounds.findIndex((r) => r.id === current);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? model.rounds.length - 1 : -2;
    if (j === -2 || !model.rounds[j]) return;
    e.preventDefault();
    select(model.rounds[j].id);
    focusKey(`tab:${current}`);
  };
  return el("nav", { class: "tabs", role: "tablist", "aria-label": t.rounds },
    ...model.rounds.map((r) => {
      const n = counts(r, statusOf(r));
      const on = r.id === current;
      return el("button", { type: "button", role: "tab", class: "tab", "aria-selected": String(on), tabIndex: on ? 0 : -1, data: { key: `tab:${r.id}` }, onclick: () => select(r.id), onkeydown: move },
        el("span", { class: "tab-name", textContent: r.name }),
        el("span", { class: "tab-count", textContent: `${n.answered + n.declined}/${n.total}` }));
    }));
}
function select(rid) {
  if (rid === current) return;
  current = rid; view.reviewer = ""; view.status = ""; confirming = null;
  draw();
}

function confirmButton(key, label, action) {
  if (confirming !== key) return button(label, () => { confirming = key; draw(); focusKey(`yes:${key}`); }, { class: "quiet", data: { key: `ask:${key}` } });
  return el("span", { class: "confirm" },
    button(t.confirm(label), () => { confirming = null; action(); }, { class: "danger", data: { key: `yes:${key}` } }),
    button(t.cancel, () => { confirming = null; draw(); focusKey(`ask:${key}`); }, { class: "quiet" }));
}

function roundView(r) {
  const reviewers = [...new Set(r.comments.map((c) => c.reviewer))];
  const numbers = new Map(), seen = new Map();
  for (const c of r.comments) {
    const who = reviewers.indexOf(c.reviewer) + 1;
    seen.set(who, (seen.get(who) ?? 0) + 1);
    numbers.set(c.id, `${who}.${seen.get(who)}`);
  }
  const shown = r.comments.filter((c) => (!view.reviewer || c.reviewer === view.reviewer) && (!view.status || statusOf(r)(c) === view.status));
  const n = counts(r, statusOf(r));
  const filter = (label, value, options, set) => el("select", { "aria-label": label, onchange: (e) => { set(e.target.value); draw(); } },
    ...options.map(([v, text]) => el("option", { value: v, selected: v === value, textContent: text })));
  return el("main", { class: "round" },
    tabs(),
    el("section", { class: "round-head", role: "tabpanel" },
      el("div", { class: "round-title" },
        el("input", { class: "name", value: r.name, placeholder: t.namePh, "aria-label": t.namePh, maxLength: 120, data: { key: fkey(r.id, "", "name") }, oninput: (e) => edit(r.id, "", "name", e.target.value) }),
        el("input", { class: "source", value: r.source, placeholder: t.sourcePh, "aria-label": t.sourcePh, maxLength: 200, data: { key: fkey(r.id, "", "source") }, oninput: (e) => edit(r.id, "", "source", e.target.value) })),
      el("div", { class: "tally" },
        el("div", { class: "meter", role: "img", "aria-label": t.progress(n) },
          ...["answered", "declined", "pending"].map((s) => { const seg = el("span", { class: `seg ${s}` }); seg.style.flexGrow = String(n[s]); return seg; })),
        el("p", { class: "legend" }, ...["answered", "declined", "pending"].map((s) => el("span", { class: `key ${s}` }, el("b", { textContent: String(n[s]) }), ` ${t.status[s]}`)))),
      el("div", { class: "tools" },
        r.comments.length ? filter(t.filterReviewer, view.reviewer, [["", t.allReviewers], ...reviewers.map((w) => [w, w || t.anonymous])], (v) => { view.reviewer = v; }) : null,
        r.comments.length ? filter(t.filterStatus, view.status, [["", t.allStatuses], ...STATUSES.map((s) => [s, t.status[s]])], (v) => { view.status = v; }) : null,
        el("span", { class: "spacer" }),
        confirmButton(`round:${r.id}`, t.deleteRound, () => removeRound(r.id)))),
    !r.comments.length ? el("div", { class: "quiet-note" }, el("p", { textContent: t.roundEmpty }),
      el("div", { class: "row" }, intake ? null : button(t.paste, toggleIntake), button(t.importReview, () => promptAgent(t.prompts.importReview("")))))
      : !shown.length ? el("p", { class: "quiet-note", textContent: t.noMatch })
      : el("ol", { class: "exchanges" }, ...shown.map((c) => exchange(r, c, numbers.get(c.id)))));
}

function exchange(r, c, number) {
  const key = (f) => fkey(r.id, c.id, f);
  const status = statusOf(r)(c);
  const responseId = fid();
  const draft = async () => {
    await flush();
    const make = (len) => t.prompts.draft(named(r), { ...c, id: snippet(c.id, 80), reviewer: snippet(c.reviewer, 80) }, snippet(c.text, len));
    promptAgent(make(480), () => make(120));
  };
  const openBtn = button(t.open, () => { const file = commentOf(r.id, c.id)?.change?.file?.trim(); if (file) somniq.openFile(file); },
    { class: "link", disabled: !c.change?.file?.trim() });
  const field = (cls, name, label, ph, extra = {}) => el("input", { class: cls, value: c.change?.[name] ?? "", placeholder: ph, "aria-label": label, data: { key: key(`change.${name}`) },
    oninput: (e) => edit(r.id, c.id, `change.${name}`, e.target.value), ...extra });
  return el("li", { class: `exchange ${status}` },
    el("div", { class: "said" },
      el("div", { class: "said-meta" },
        el("span", { class: "num", textContent: number }),
        el("span", { class: "who", textContent: c.reviewer || t.anonymous }),
        c.kind ? el("span", { class: `kind ${c.kind}`, textContent: t.kind[c.kind] }) : null),
      el("blockquote", { textContent: c.text }),
      el("div", { class: "said-tools" },
        button(t.draft, draft, { class: "agent", title: t.draftTip, data: { key: key("act:draft") } }),
        confirmButton(`comment:${r.id}:${c.id}`, t.remove, () => removeComment(r, c)))),
    el("div", { class: "reply" },
      el("label", { class: "label", htmlFor: responseId, textContent: t.response }),
      grow({ id: responseId, class: "grow response", value: c.response ?? "", placeholder: t.responsePh, data: { key: key("response") }, oninput: (e) => edit(r.id, c.id, "response", e.target.value) }),
      el("fieldset", { class: "where" },
        el("legend", { textContent: t.change }),
        el("div", { class: "where-row" },
          field("file", "file", t.file, t.filePh, { oninput: (e) => { edit(r.id, c.id, "change.file", e.target.value); openBtn.disabled = !e.target.value.trim(); } }),
          el("input", { class: "line", type: "number", min: 1, step: 1, inputMode: "numeric", value: c.change?.line ?? "", placeholder: t.linePh, "aria-label": t.line, data: { key: key("change.line") },
            oninput: (e) => { const v = Number.parseInt(e.target.value, 10); edit(r.id, c.id, "change.line", Number.isInteger(v) && v > 0 ? v : undefined); } }),
          openBtn),
        field("summary", "summary", t.summary, t.summaryPh)),
      el("div", { class: "states", role: "radiogroup", "aria-label": t.statusLabel },
        ...STATUSES.map((s) => el("label", { class: `state ${s}` },
          el("input", { type: "radio", name: `st-${key("")}`, value: s, checked: status === s, data: { key: key(`status:${s}`) }, onchange: () => setStatus(r, c, s) }),
          el("span", { textContent: t.status[s] })))),
      status === "declined" ? justification(r, c, key) : null));
}

function justification(r, c, key) {
  const id = fid(), hint = fid();
  const missing = !c.justification?.trim();
  return el("div", { class: "why" },
    el("label", { class: "label", htmlFor: id, textContent: t.justification }),
    grow({ id, value: c.justification ?? "", placeholder: t.justificationPh, required: true, "aria-invalid": String(missing), "aria-describedby": hint, data: { key: key("justification") },
      oninput: (e) => justify(r, c, e.target.value) }),
    el("p", { class: "hint", id: hint, hidden: !missing, textContent: t.needJustification }));
}

// "Declined" is only saved together with a reason; until then the comment stays pending.
function setStatus(r, c, s) {
  const k = fkey(r.id, c.id, "");
  if (s === "declined" && !c.justification?.trim()) {
    declining.add(k);
    if (c.status !== "pending") edit(r.id, c.id, "status", "pending", true);
    draw();
    focusKey(fkey(r.id, c.id, "justification"));
    return;
  }
  declining.delete(k);
  edit(r.id, c.id, "status", s, true);
  draw();
}
function justify(r, c, value) {
  const k = fkey(r.id, c.id, "");
  const has = Boolean(value.trim());
  edit(r.id, c.id, "justification", value);
  if (has && declining.has(k)) { declining.delete(k); edit(r.id, c.id, "status", "declined"); }
  else if (!has && c.status === "declined") { declining.add(k); edit(r.id, c.id, "status", "pending"); }
  else return;
  draw();
}

function removeComment(r, c) {
  r.comments = r.comments.filter((x) => x.id !== c.id);
  for (const k of [...edits.keys()]) { const [rid, cid] = JSON.parse(k); if (rid === r.id && cid === c.id) edits.delete(k); }
  queue(true); draw();
}
function removeRound(rid) {
  model.rounds = model.rounds.filter((r) => r.id !== rid);
  for (const k of [...edits.keys()]) if (JSON.parse(k)[0] === rid) edits.delete(k);
  current = model.rounds[0]?.id;
  queue(true); draw();
}

// --- The paste box ---------------------------------------------------------------------------
function toggleIntake() {
  intake = intake ? null : { text: "", reviewer: t.defaultReviewer, target: currentRound()?.id ?? "", name: t.roundName(model.rounds.length + 1), source: "", file: "", items: null };
  draw();
  if (intake) focusKey("intake:text");
}

function intakeBox() {
  const i = intake;
  const labelled = (label, input) => el("label", { class: "field" }, el("span", { textContent: label }), input);
  return el("section", { class: "intake", "aria-label": t.intakeTitle },
    el("div", { class: "intake-head" }, el("h2", { textContent: t.intakeTitle }), button(t.close, toggleIntake, { class: "quiet" })),
    el("div", { class: "intake-grid" },
      el("div", { class: "intake-paste" },
        el("p", { class: "hint", textContent: t.intakeHelp }),
        el("textarea", { class: "paste", rows: 9, value: i.text, placeholder: t.pastePh, "aria-label": t.intakeTitle, data: { key: "intake:text" }, oninput: (e) => { i.text = e.target.value; } }),
        el("div", { class: "row wrap" },
          labelled(t.reviewerLabel, el("input", { value: i.reviewer, maxLength: 80, oninput: (e) => { i.reviewer = e.target.value; } })),
          labelled(t.into, el("select", { data: { key: "intake:into" }, onchange: (e) => { i.target = e.target.value; draw(); } },
            ...model.rounds.map((r) => el("option", { value: r.id, selected: r.id === i.target, textContent: r.name })),
            el("option", { value: "", selected: !roundById(i.target), textContent: t.newRound }))),
          roundById(i.target) ? null : labelled(t.namePh, el("input", { value: i.name, maxLength: 120, oninput: (e) => { i.name = e.target.value; } })),
          roundById(i.target) ? null : labelled(t.sourcePh, el("input", { value: i.source, maxLength: 200, oninput: (e) => { i.source = e.target.value; } }))),
        el("div", { class: "row" }, button(t.split, () => {
          i.items = splitReview(i.text, i.reviewer.trim() || t.defaultReviewer);
          draw(); focusKey(i.items.length ? "intake:confirm" : "intake:text");
        }, { class: "primary" }))),
      el("aside", { class: "intake-agent" },
        el("h3", { textContent: t.agentTitle }),
        el("p", { textContent: t.agentBody }),
        labelled(t.fileLabel, el("input", { value: i.file, placeholder: t.reviewFilePh, maxLength: 500, oninput: (e) => { i.file = e.target.value; } })),
        button(t.ask, () => promptAgent(t.prompts.importReview(i.file.trim())), { class: "agent" }))),
    i.items ? preview(i) : null);
}

function preview(i) {
  return el("div", { class: "preview" },
    el("p", { class: "preview-head", role: "status", textContent: t.found(i.items.length) }),
    el("ol", {}, ...i.items.map((it, n) => el("li", { class: "piece" },
      el("div", { class: "piece-meta" },
        el("span", { class: "num", textContent: String(n + 1) }),
        el("input", { value: it.reviewer, "aria-label": t.reviewerLabel, maxLength: 80, oninput: (e) => { it.reviewer = e.target.value; } }),
        el("select", { "aria-label": t.kindLabel, onchange: (e) => { it.kind = e.target.value; } },
          ...["", ...KINDS].map((k) => el("option", { value: k, selected: k === it.kind, textContent: k ? t.kind[k] : t.kindNone }))),
        button(t.remove, () => { i.items.splice(n, 1); draw(); }, { class: "quiet" })),
      grow({ value: it.text, "aria-label": `${t.comment} ${n + 1}`, oninput: (e) => { it.text = e.target.value; } })))),
    i.items.length ? el("div", { class: "row" },
      button(t.addN(i.items.length), commitIntake, { class: "primary", data: { key: "intake:confirm" } }),
      button(t.cancel, () => { i.items = null; draw(); focusKey("intake:text"); }, { class: "quiet" })) : null);
}

function commitIntake() {
  const items = intake.items.filter((it) => it.text.trim());
  if (!items.length) return;
  let r = roundById(intake.target);
  if (!r) {
    r = { id: uid("round", model.rounds.map((x) => x.id)), name: intake.name.trim() || t.roundName(model.rounds.length + 1), source: intake.source.trim(), comments: [] };
    model.rounds.push(r);
  }
  const ids = r.comments.map((c) => c.id);
  for (const it of items) {
    const id = uid("c", ids);
    ids.push(id);
    r.comments.push({ id, reviewer: it.reviewer.trim() || t.defaultReviewer, text: it.text.trim(), kind: KINDS.includes(it.kind) ? it.kind : undefined, response: "", status: "pending" });
  }
  current = r.id; intake = null; view.reviewer = ""; view.status = "";
  queue(true); draw();
}

// --- Start -----------------------------------------------------------------------------------
const boot = await somniq.ready();
lang = pickLanguage(boot?.locale ?? boot?.language); // locale: "en" | "cn" | "es"; language: "en" | "cn" on older hosts
t = COPY[lang];
document.documentElement.lang = lang === "cn" ? "zh" : lang;
model = clean(boot?.data?.rounds);
current = model.activeRound;
somniq.onData((data) => receive(data?.rounds));
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; if (drawLater) { drawLater = false; draw(); } });
window.addEventListener("pagehide", () => { if (dirty) flush(); });
draw();
