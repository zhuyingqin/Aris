// The claim checker page: a galley of cited sentences, each with its verdict,
// its background task and the passage that decided it. Stored values are
// untrusted: everything is built with createElement and textContent.
import { pickCopy } from "pkg:claims/copy.mjs";
import { BUSY, VERDICTS, groupClaims, readClaims, tally, taskView, verdictOf, withTaskId } from "pkg:claims/model.mjs";

const MARKS = { supported: "✓", partial: "≈", unsupported: "✗", "no-source": "?", unchecked: "·" };
const $ = (id) => document.getElementById(id);
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
};

let copy, lang;
let raw = null;                      // the claims widget exactly as stored
let doc = readClaims(null);          // the same, cleaned for drawing
let summary = "";
let filter = "all";
let board = new Map(), known = false; // the task board's records of this page's tasks
const local = new Map();             // claim id -> { taskId?, status? } this page knows in memory
let asking = false;                  // one task proposal at a time

function showError(message) { $("error").textContent = message || ""; }
const when = (date) => date ? new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(date) : "";

function button(label, className, onClick, key) {
  const node = el("button", className, label);
  node.type = "button";
  if (key) node.dataset.key = key;
  node.addEventListener("click", onClick);
  return node;
}

// ---------- top bar ----------

function renderMeta() {
  const parts = [];
  if (doc.manuscript) parts.push(`${copy.manuscript}: ${doc.manuscript}`);
  if (doc.extractedAt) parts.push(`${copy.extracted} ${when(doc.extractedAt)}`);
  $("meta").textContent = parts.join(" · ");
  $("meta").hidden = !parts.length;
}

function renderTally() {
  const counts = tally(doc.claims), total = doc.claims.length;
  const done = total - counts.unchecked;
  const bar = $("bar"); bar.replaceChildren();
  for (const verdict of VERDICTS) {
    if (!counts[verdict]) continue;
    const segment = el("span", "segment"); segment.dataset.verdict = verdict;
    segment.style.width = `${(counts[verdict] / total) * 100}%`;
    bar.append(segment);
  }
  bar.setAttribute("aria-label", copy.checked(done, total));
  $("progress").textContent = copy.checked(done, total);
  const filters = $("filters"); filters.replaceChildren();
  for (const key of ["all", ...VERDICTS, "unchecked"]) {
    const count = key === "all" ? total : counts[key];
    const chip = button("", "chip", () => { filter = key; render(); }, `filter:${key}`);
    chip.dataset.verdict = key;
    chip.setAttribute("aria-pressed", String(filter === key));
    chip.append(el("span", "chip-mark", key === "all" ? "∑" : MARKS[key]), el("span", "chip-label", key === "all" ? copy.all : copy.verdicts[key]), el("span", "chip-count", String(count)));
    filters.append(chip);
  }
  $("tally").hidden = !total;
}

// ---------- the galley ----------

function renderTask(claim, view) {
  const block = el("div", "task");
  if (!view.state || view.state === "asking") return null;
  block.dataset.state = view.state;
  const head = el("p", "task-state");
  head.append(el("span", "task-label", copy.states[view.state] || view.state));
  const task = view.task;
  const detail = task && task.state === "active" ? task.phase : task && (task.state === "failed" || task.state === "waiting") ? task.error : "";
  if (detail) head.append(el("span", "task-detail", detail));
  block.append(head);
  if (task && task.review && task.review.verdict) {
    const review = el("p", "task-review");
    review.append(el("span", "review-label", `${copy.review} · ${task.review.verdict}`));
    if (task.review.summary) review.append(el("span", "review-text", task.review.summary));
    block.append(review);
  }
  if (task && task.result && (task.result.summary || task.result.filesChanged)) {
    const more = el("details", "task-result");
    const label = task.result.filesChanged ? `${copy.result} · ${task.result.filesChanged} ${copy.files}` : copy.result;
    more.append(el("summary", null, label), el("p", null, task.result.summary || ""));
    block.append(more);
  }
  return block;
}

function renderClaim(claim) {
  const verdict = verdictOf(claim);
  const view = taskView(claim, board, known, local.get(claim.id));
  const slip = el("article", "slip"); slip.dataset.verdict = verdict;

  const margin = el("div", "margin");
  margin.append(el("span", "line-no", claim.line ? `L${claim.line}` : "—"));

  const body = el("div", "body");
  body.append(el("p", "sentence", claim.text));
  const refs = el("p", "refs");
  for (const key of claim.cites) refs.append(el("span", "cite", `[${key}]`));
  if (claim.file) {
    const go = button(claim.line ? `${claim.file}:${claim.line}` : claim.file, "link", () => somniq.openFile(claim.file), `open:${claim.id}`);
    go.title = copy.open; refs.append(go);
  }
  body.append(refs);

  if (claim.quote || claim.page) {
    const quote = el("blockquote", "quote");
    if (claim.quote) quote.append(el("span", "quote-text", `“${claim.quote}”`));
    if (claim.page) quote.append(el("span", "quote-page", ` — ${copy.page} ${claim.page}`));
    body.append(quote);
  }
  if (claim.note) {
    const note = el("p", "note"); note.append(el("span", "label", `${copy.note}: `), claim.note); body.append(note);
  }
  if (claim.source || claim.checkedAt) {
    const meta = el("p", "source");
    if (claim.source) {
      meta.append(el("span", "label", `${copy.source}: `), button(claim.source, "link", () => somniq.openFile(claim.source), `source:${claim.id}`));
    }
    if (claim.checkedAt) meta.append(el("span", "checked", `${copy.checkedAt} ${when(claim.checkedAt)}`));
    body.append(meta);
  }
  const task = renderTask(claim, view);
  if (task) body.append(task);

  const mark = el("div", "mark");
  const stamp = el("span", "stamp"); stamp.dataset.verdict = verdict;
  stamp.append(el("span", "stamp-glyph", MARKS[verdict]), el("span", "stamp-word", copy.verdicts[verdict]));
  mark.append(stamp);
  const busy = view.state === "asking" || BUSY.has(view.state);
  const label = view.state === "asking" ? copy.asking : claim.verdict ? copy.again : copy.investigate;
  const send = button(label, claim.verdict ? "action" : "action primary", () => investigate(claim), `task:${claim.id}`);
  send.disabled = asking || busy;
  if (busy && view.state !== "asking") send.textContent = copy.states[view.state];
  mark.append(send);

  slip.append(margin, body, mark);
  return slip;
}

function renderGalley() {
  const galley = $("galley"); galley.replaceChildren();
  if (!doc.claims.length) {
    const empty = el("div", "empty");
    empty.append(el("h2", null, copy.emptyTitle), el("p", null, copy.empty), button(copy.extract, "action primary", extract, "empty:extract"));
    galley.append(empty);
    return;
  }
  const groups = groupClaims(doc.claims, filter);
  if (!groups.length) { galley.append(el("p", "empty-filter", copy.noMatch)); return; }
  for (const group of groups) {
    const sheet = el("section", "sheet");
    const head = el("header", "sheet-head");
    head.append(group.file ? button(group.file, "file", () => somniq.openFile(group.file), `file:${group.file}`) : el("span", "file", copy.unknownFile));
    sheet.append(head);
    for (const part of group.sections) {
      if (part.section) sheet.append(el("h3", "section", part.section));
      for (const claim of part.claims) sheet.append(renderClaim(claim));
    }
    galley.append(sheet);
  }
}

// ---------- desk notes: the summary widget, drawn as text ----------

function renderSummary() {
  const box = $("summary"); box.replaceChildren();
  if (!summary.trim()) { box.append(el("p", "muted", copy.noSummary)); return; }
  let list = null, para = [];
  const flush = () => { if (para.length) box.append(el("p", null, para.join(" "))); para = []; };
  const plain = (line) => line.replace(/\*\*|__|`/g, "");
  for (const line of summary.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading || item || !line.trim()) flush();
    if (!item) list = null;
    if (heading) box.append(el("h3", null, plain(heading[1])));
    else if (item) {
      if (!list) { list = el("ul"); box.append(list); }
      list.append(el("li", null, plain(item[1])));
    } else if (line.trim()) para.push(plain(line.trim()));
  }
  flush();
}

function render() {
  // Rows are rebuilt on every change; keep the keyboard where it was.
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  renderMeta(); renderTally(); renderGalley(); renderSummary();
  if (focused) {
    const again = [...document.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focused);
    if (again && !again.disabled) again.focus();
  }
}

// ---------- actions ----------

function extract() { showError(""); somniq.prompt(copy.extractPrompt); }
function summarize() { showError(""); somniq.prompt(copy.summaryPrompt); }

async function saveTaskId(claim, taskId) {
  const next = claim.hasId ? withTaskId(raw, claim.id, taskId) : null;
  if (!next) { showError(`${copy.lost} ${taskId}`); return; }
  try {
    await somniq.set("claims", next);
    raw = next; doc = readClaims(raw);
  } catch (error) {
    showError(`${copy.lost} ${taskId} (${error && error.message ? error.message : String(error)})`);
  }
}

async function investigate(claim) {
  showError("");
  if (asking) { showError(copy.busy); return; }
  const before = local.get(claim.id) || {};
  asking = true;
  local.set(claim.id, { taskId: before.taskId, status: "asking" });
  render();
  try {
    const outcome = await somniq.task({ title: copy.taskTitle(claim), prompt: copy.taskPrompt(claim), reportTo: "claims" });
    if (outcome && outcome.taskId && outcome.status !== "declined") {
      local.set(claim.id, { taskId: outcome.taskId });
      await saveTaskId(claim, outcome.taskId);
    } else {
      local.set(claim.id, { taskId: before.taskId, status: "declined" });
    }
  } catch (error) {
    local.set(claim.id, { taskId: before.taskId });
    const message = error && error.message ? error.message : String(error);
    showError(/already waiting/i.test(message) ? copy.busy : message);
  } finally {
    asking = false;
    render();
  }
}

function applyData(data) {
  raw = data && data.claims !== undefined ? data.claims : null;
  doc = readClaims(raw);
  summary = data && typeof data.summary === "string" ? data.summary : "";
  render();
}

function applyTasks(list) {
  board = new Map((Array.isArray(list) ? list : []).filter((task) => task && typeof task.taskId === "string").map((task) => [task.taskId, task]));
  known = true;
  render();
}

const { language, locale, data } = await somniq.ready();
({ copy, lang } = pickCopy(locale ?? language));
document.documentElement.lang = lang;
document.title = copy.title;
$("title").textContent = copy.title;
$("lede").textContent = copy.lede;
$("notes-title").textContent = copy.deskNotes;
$("filters").setAttribute("aria-label", copy.all);
$("extract").textContent = copy.extract;
$("summarize").textContent = copy.summarize;
$("extract").addEventListener("click", extract);
$("summarize").addEventListener("click", summarize);
applyData(data || {});
somniq.onData(applyData);
somniq.onTasks(applyTasks);
// Outside the desktop app there is no board: rows then keep their stored task id.
somniq.tasks().then(applyTasks, () => undefined);
