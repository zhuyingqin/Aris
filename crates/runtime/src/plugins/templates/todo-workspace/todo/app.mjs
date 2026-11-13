// The full Tasks page: list, board, calendar and timeline over one task list.
import { COPY, FILTERS, PRIORITIES, STATUSES, VIEWS, addDays, clean, cleanView, daysBetween, dueLabel, el, fromIso, iso, newId, parseQuick, rank, ring, stats, today, withStatus } from "pkg:todo/model.mjs";

const PATHS = {
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  board: "M4 4h4.5v16H4zM9.75 4h4.5v10h-4.5zM15.5 4H20v13h-4.5z",
  calendar: "M4 6.5h16V20H4zM4 10.5h16M8.5 3.5v4M15.5 3.5v4",
  timeline: "M3 6h9M7 12h12M5 18h8",
  check: "M5 12.5l4.2 4.2L19 7",
  close: "M6 6l12 12M18 6L6 18",
  trash: "M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13",
  sparkle: "M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z",
  steps: "M9 7h11M9 12h11M9 17h11M4 7l1 1 2-2M4 12l1 1 2-2M4 17l1 1 2-2",
  note: "M6 4h12v16H6zM9 9h6M9 13h6M9 17h3",
  chevronLeft: "M15 6l-6 6 6 6", chevronRight: "M9 6l6 6-6 6", chevronDown: "M6 9l6 6 6-6",
  empty: "M5 12.5l4.2 4.2L19 7M3 3h18v18H3z",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "icon");
  const path = document.createElementNS(ns, "path"); path.setAttribute("d", PATHS[name]); svg.append(path);
  return svg;
}

const $ = (id) => document.getElementById(id);
let copy = COPY.en, language = "en";
let tasks = [], prefs = cleanView(null), selected = null, base = today();
let month = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let showDone = false, openDay = null, shownView = null, writes = Promise.resolve();

// ── Saving ────────────────────────────────────────────────
function commit(next) {
  const before = tasks;
  tasks = next; render();
  writes = writes.then(() => somniq.set("tasks", tasks)).catch((error) => {
    tasks = before; render(); toast(copy.failed + error.message, { error: true });
  });
  return before;
}
const update = (id, patch) => commit(tasks.map((task) => task.id === id ? (typeof patch === "function" ? patch(task) : { ...task, ...patch }) : task));
function setPrefs(patch) {
  prefs = { ...prefs, ...patch }; render();
  somniq.set("view", prefs).catch(() => undefined);
}
let toastTimer;
function toast(text, { error = false, undo } = {}) {
  const node = $("toast");
  node.replaceChildren(el("span", { textContent: text }), undo ? el("button", { type: "button", textContent: copy.undo, onclick: () => { undo(); node.hidden = true; } }) : null);
  node.className = `toast${error ? " error" : ""}`; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6000 : 4000);
}

// ── What is shown ─────────────────────────────────────────
const open = (task) => task.status !== "done";
const FILTER = {
  all: () => true,
  today: (t) => t.due && t.due <= base && (open(t) || t.completed === base),
  week: (t) => open(t) && t.due && t.due <= addDays(base, 7),
  overdue: (t) => open(t) && t.due && t.due < base,
  done: (t) => !open(t),
};
const scoped = () => tasks.filter((task) => (!prefs.tag || task.tags?.includes(prefs.tag)) && FILTER[prefs.filter](task));

// ── Small parts ───────────────────────────────────────────
function checkButton(task, onToggle = () => update(task.id, (t) => withStatus(t, open(t) ? "done" : "todo", base))) {
  return el("button", { type: "button", className: "check", role: "checkbox", ariaChecked: !open(task), ariaLabel: task.title, dataset: { priority: task.priority ?? "" },
    onclick: (event) => { event.stopPropagation(); onToggle(); } }, icon("check"));
}
function dueChip(task) {
  if (!task.due) return null;
  const label = dueLabel(task.due, copy, language, base);
  const tone = open(task) ? label.tone : "later";
  return el("span", { className: `chip due-${tone}`, title: task.due }, icon("calendar"), label.text);
}
function metaChips(task) {
  const steps = task.steps ?? [];
  return [
    task.status === "doing" ? el("span", { className: "chip doing", textContent: copy.status.doing }) : null,
    ...(task.tags ?? []).map((tag) => el("span", { className: "chip tag", textContent: tag })),
    steps.length ? el("span", { className: "chip" }, icon("steps"), `${steps.filter((s) => s.done).length}/${steps.length}`) : null,
    task.note ? el("span", { className: "chip", title: task.note.slice(0, 200) }, icon("note")) : null,
  ];
}
function empty(text) {
  return el("div", { className: "empty" }, icon("empty"), el("p", { textContent: text }));
}
const draggable = (node, task) => {
  node.draggable = true;
  node.ondragstart = (event) => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; node.classList.add("dragging"); };
  node.ondragend = () => node.classList.remove("dragging");
  return node;
};
function dropZone(node, onDrop) {
  node.ondragover = (event) => { event.preventDefault(); node.classList.add("over"); };
  node.ondragleave = (event) => { if (!node.contains(event.relatedTarget)) node.classList.remove("over"); };
  node.ondrop = (event) => {
    event.preventDefault(); node.classList.remove("over");
    const id = event.dataTransfer.getData("text/plain");
    if (tasks.some((task) => task.id === id)) onDrop(id);
  };
  return node;
}

// ── Rail ──────────────────────────────────────────────────
function renderRail() {
  const s = stats(tasks, base);
  $("title").textContent = copy.title;
  $("summary").textContent = copy.summary(s.done, s.total);
  const fraction = s.total ? s.done / s.total : 0;
  $("ring").replaceChildren(ring(fraction, 40, 4), el("b", { textContent: s.total ? `${Math.round(fraction * 100)}` : "–" }));
  $("views").replaceChildren(...VIEWS.map((view) => el("button", { type: "button", ariaPressed: prefs.view === view, onclick: () => setPrefs({ view }) }, icon(view), copy.views[view])));
  $("filterLabel").textContent = copy.filterLabel;
  const counts = { all: s.open, today: tasks.filter(FILTER.today).length, week: tasks.filter(FILTER.week).length, overdue: s.overdue, done: s.done };
  $("filters").replaceChildren(...FILTERS.map((filter) => el("button", { type: "button", ariaPressed: prefs.filter === filter, dataset: { filter }, onclick: () => setPrefs({ filter }) },
    el("span", { className: "dot" }), copy.filters[filter], el("span", { className: `count${counts[filter] ? " has" : ""}`, textContent: counts[filter] || "" }))));
  $("tagLabel").textContent = copy.tagLabel;
  const tags = new Map();
  for (const task of tasks) for (const tag of task.tags ?? []) if (open(task)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  for (const task of tasks) for (const tag of task.tags ?? []) if (!tags.has(tag)) tags.set(tag, 0);
  $("tags").replaceChildren(...(tags.size ? [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) =>
    el("button", { type: "button", ariaPressed: prefs.tag === tag, onclick: () => setPrefs({ tag: prefs.tag === tag ? null : tag }) },
      el("span", { className: "hash", textContent: "#" }), tag, el("span", { className: "count", textContent: n || "" })))
    : [el("p", { className: "tags-empty", textContent: copy.noTags })]));
  $("plan").replaceChildren(icon("sparkle"), copy.plan);
}

// ── List ──────────────────────────────────────────────────
function listRow(task) {
  return el("li", { className: `row${open(task) ? "" : " done"}${selected === task.id ? " selected" : ""}`, onclick: () => select(task.id) },
    checkButton(task),
    el("div", { className: "row-main" }, el("div", { className: "row-title", textContent: task.title }), el("div", { className: "row-meta" }, ...metaChips(task))),
    el("div", { className: "row-side" }, open(task) ? dueChip(task) : null));
}
function renderList(list) {
  const todo = rank(list.filter(open), base), done = list.filter((t) => !open(t)).sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  const week = addDays(base, 7);
  const groups = [
    ["overdue", todo.filter((t) => t.due && t.due < base)],
    ["today", todo.filter((t) => t.due === base)],
    ["soon", todo.filter((t) => t.due && t.due > base && t.due <= week)],
    ["later", todo.filter((t) => t.due && t.due > week)],
    ["undated", todo.filter((t) => !t.due)],
  ].filter(([, items]) => items.length);
  const parts = groups.map(([key, items]) => el("section", { className: "group", dataset: { group: key } },
    el("h2", { className: "group-head" }, copy.groups[key], el("span", { className: "n", textContent: items.length })),
    el("ul", { className: "rows" }, ...items.map(listRow))));
  if (done.length) {
    const expanded = prefs.filter === "done" || showDone;
    parts.push(el("section", { className: "group", dataset: { group: "done" } },
      el("button", { type: "button", className: "group-head", ariaExpanded: expanded, onclick: () => { showDone = !showDone; render(); } },
        icon(expanded ? "chevronDown" : "chevronRight"), copy.groups.done, el("span", { className: "n", textContent: done.length })),
      expanded ? el("ul", { className: "rows" }, ...done.map(listRow)) : null));
  }
  return parts.length && (todo.length || prefs.filter === "done") ? parts : [empty(copy.empty[prefs.filter]), ...(done.length && prefs.filter === "all" ? parts : [])];
}

// ── Board ─────────────────────────────────────────────────
function renderBoard(list) {
  return [el("div", { className: "board" }, ...STATUSES.map((status) => {
    const items = status === "done" ? list.filter((t) => t.status === status).sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? "")) : rank(list.filter((t) => t.status === status), base);
    const column = el("section", { className: "column", dataset: { status } },
      el("header", { className: "column-head" }, el("i"), copy.status[status], el("span", { className: "n", textContent: items.length })),
      ...items.map((task) => {
        const steps = task.steps ?? [];
        return draggable(el("article", { className: `card${open(task) ? "" : " done"}`, dataset: { priority: task.priority ?? "" }, tabindex: "0", onclick: () => select(task.id), onkeydown: (event) => { if (event.key === "Enter") select(task.id); } },
          el("div", { className: "card-title", textContent: task.title }),
          el("div", { className: "card-meta" }, open(task) ? dueChip(task) : null, ...(task.tags ?? []).map((tag) => el("span", { className: "chip tag", textContent: tag }))),
          steps.length ? el("div", { className: "steps-bar" }, el("span", { style: { width: `${steps.filter((s) => s.done).length / steps.length * 100}%` } })) : null), task);
      }));
    return dropZone(column, (id) => update(id, (task) => task.status === status ? task : withStatus(task, status, base)));
  }))];
}

// ── Calendar ──────────────────────────────────────────────
function pill(task) {
  return draggable(el("button", { type: "button", className: `pill${open(task) ? "" : " done"}`, dataset: { priority: task.priority ?? "" }, title: task.title, onclick: (event) => { event.stopPropagation(); select(task.id); } },
    el("i"), el("span", { textContent: task.title })), task);
}
function renderCalendar(list) {
  const y = month.getFullYear(), m = month.getMonth();
  const start = new Date(y, m, 1); start.setDate(1 - ((start.getDay() + 6) % 7));
  const head = el("div", { className: "cal-head" },
    el("h2", { textContent: copy.month(y, m) }),
    el("button", { type: "button", ariaLabel: "‹", onclick: () => { month = new Date(y, m - 1, 1); render(); } }, icon("chevronLeft")),
    el("button", { type: "button", textContent: copy.today, onclick: () => { const d = new Date(); month = new Date(d.getFullYear(), d.getMonth(), 1); render(); } }),
    el("button", { type: "button", ariaLabel: "›", onclick: () => { month = new Date(y, m + 1, 1); render(); } }, icon("chevronRight")));
  const cells = copy.weekdays.map((name) => el("div", { className: "cal-dow", textContent: name }));
  const weeks = Math.ceil((new Date(y, m + 1, 0).getDate() + ((new Date(y, m, 1).getDay() + 6) % 7)) / 7);
  for (let i = 0; i < weeks * 7; i++) {
    const date = new Date(start); date.setDate(start.getDate() + i);
    const day = iso(date);
    const items = rank(list.filter((t) => t.due === day), base);
    const expanded = openDay === day, shown = expanded ? items : items.slice(0, 3);
    const cell = el("div", { className: `day${date.getMonth() !== m ? " other" : ""}${day === base ? " today" : ""}${[0, 6].includes(date.getDay()) ? " weekend" : ""}`,
      title: day, ondblclick: () => { const input = $("quickInput"); input.value = `${input.value.replace(/\s*@\S+/g, "").trim()} @${day} `.trimStart(); input.focus(); previewQuick(); } },
      el("span", { className: "day-n", textContent: date.getDate() }), ...shown.map(pill),
      items.length > shown.length ? el("button", { type: "button", className: "day-more", textContent: copy.more(items.length - shown.length), onclick: () => { openDay = day; render(); } }) : null);
    cells.push(dropZone(cell, (id) => update(id, { due: day })));
  }
  const undated = rank(list.filter((t) => !t.due && open(t)), base);
  const tray = dropZone(el("aside", { className: "tray" }, el("h3", { textContent: `${copy.unscheduled} · ${undated.length}` }), el("p", { textContent: copy.dropHere }), ...undated.map(pill)),
    (id) => update(id, (task) => { const next = { ...task }; delete next.due; return next; }));
  return [head, el("div", { className: "cal-wrap" }, el("div", { className: "cal" }, ...cells), tray)];
}

// ── Timeline ──────────────────────────────────────────────
function renderTimeline(list) {
  const dated = list.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due) || (open(a) ? -1 : 1));
  if (!dated.length) return [empty(copy.timelineEmpty)];
  const first = [base, ...dated.map((t) => t.created ?? t.due)].sort()[0];
  const from = addDays(first < addDays(base, -14) ? addDays(base, -14) : first, -2);
  const span = Math.max(28, Math.min(120, daysBetween(from, dated[dated.length - 1].due) + 4));
  const to = addDays(from, span - 1), dayWidth = 42;
  const clamp = (day) => day < from ? from : day > to ? to : day;
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const head = el("div", { className: "tl-days" }, ...days.map((day) => {
    const date = fromIso(day);
    return el("div", { className: `tl-day${day === base ? " today" : ""}${[0, 6].includes(date.getDay()) ? " weekend" : ""}` },
      date.toLocaleDateString(language === "cn" ? "zh-CN" : "en", { weekday: "narrow" }), el("b", { textContent: date.getDate() }));
  }));
  const rows = dated.flatMap((task) => {
    const end = clamp(task.due), begin = clamp(task.created && task.created < task.due ? task.created : task.due);
    const left = daysBetween(from, begin) * dayWidth + 8, width = Math.max(14, (daysBetween(begin, end)) * dayWidth + dayWidth - 22);
    const late = open(task) && task.due < base;
    return [
      el("div", { className: `tl-label${open(task) ? "" : " done"}`, onclick: () => select(task.id) }, checkButton(task), el("span", { textContent: task.title })),
      el("div", { className: "tl-track", style: { width: `${span * dayWidth}px` } },
        el("div", { className: `tl-bar${late ? " late" : ""}${open(task) ? "" : " done"}`, title: `${task.title} · ${task.due}`, style: { left: `${left}px`, width: `${width}px` }, onclick: () => select(task.id) })),
    ];
  });
  const now = el("div", { className: "tl-now", style: { left: `${240 + daysBetween(from, base) * dayWidth + dayWidth / 2}px` } });
  const undated = list.filter((t) => !t.due && open(t)).length;
  return [el("div", { className: "tl", style: { "--day": `${dayWidth}px` } }, now, el("div", { className: "tl-grid" }, el("div", { className: "tl-corner" }), head, ...rows)),
    undated ? el("p", { className: "tl-note", textContent: copy.undatedNote(undated) }) : null];
}

// ── Drawer ────────────────────────────────────────────────
function select(id) { selected = selected === id ? null : id; render(); }
function segment(values, current, label, onPick) {
  return el("div", { className: "seg", role: "group", ariaLabel: label }, ...values.map(([value, text]) =>
    el("button", { type: "button", ariaPressed: current === value, dataset: { value }, onclick: () => onPick(value) }, value && PRIORITIES.includes(value) ? el("i") : null, text)));
}
function renderDrawer() {
  const drawer = $("drawer");
  const task = tasks.find((t) => t.id === selected);
  if (!task) { selected = null; drawer.hidden = true; drawer.replaceChildren(); return; }
  // Keep what the user is typing: an agent's write lands when they leave the field.
  if (!drawer.hidden && drawer.dataset.task === task.id && drawer.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  drawer.hidden = false; drawer.dataset.task = task.id;
  const d = copy.detail;
  const title = el("textarea", { className: "drawer-title", rows: 1, value: task.title, maxLength: 300, ariaLabel: d.title,
    onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); event.target.blur(); } },
    onchange: (event) => { const value = event.target.value.trim(); if (value && value !== task.title) update(task.id, { title: value }); else event.target.value = task.title; } });
  requestAnimationFrame(() => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; });
  title.oninput = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  const tagInput = el("input", { placeholder: d.addTag, maxLength: 40, ariaLabel: d.addTag,
    onkeydown: (event) => {
      if ((event.key === "Enter" || event.key === ",") && !event.isComposing) {
        event.preventDefault();
        const tag = event.target.value.trim().replace(/^#/, "");
        if (tag && !(task.tags ?? []).includes(tag)) update(task.id, { tags: [...(task.tags ?? []), tag] });
        event.target.value = "";
      }
    } });
  const steps = task.steps ?? [];
  const setSteps = (next) => update(task.id, (t) => { const out = { ...t, steps: next }; if (!next.length) delete out.steps; return out; });
  const stepInput = el("input", { className: "text-in", placeholder: d.addStep, maxLength: 300, ariaLabel: d.addStep,
    onkeydown: (event) => {
      if (event.key === "Enter" && !event.isComposing && event.target.value.trim()) { setSteps([...steps, { title: event.target.value.trim(), done: false }]); event.target.value = ""; requestAnimationFrame(() => $("drawer").querySelector(".field-steps input")?.focus()); }
    } });
  let noteTimer;
  const note = el("textarea", { className: "note", value: task.note ?? "", placeholder: d.notePlaceholder, maxLength: 4000, ariaLabel: d.note,
    oninput: (event) => { clearTimeout(noteTimer); const value = event.target.value; noteTimer = setTimeout(() => update(task.id, (t) => { const out = { ...t, note: value.trim() }; if (!out.note) delete out.note; return out; }), 700); } });
  drawer.replaceChildren(el("div", { className: "drawer-inner" },
    el("div", { className: "drawer-head" }, checkButton(task), title, el("button", { type: "button", className: "icon-btn", ariaLabel: d.close, title: d.close, onclick: () => select(task.id) }, icon("close"))),
    el("div", { className: "field" }, el("span", { className: "label", textContent: d.status }),
      segment(STATUSES.map((s) => [s, copy.status[s]]), task.status, d.status, (status) => update(task.id, (t) => withStatus(t, status, base)))),
    el("div", { className: "field" }, el("span", { className: "label", textContent: d.priority }),
      segment([["", copy.priority.none], ...PRIORITIES.map((p) => [p, copy.priority[p]])], task.priority ?? "", d.priority,
        (priority) => update(task.id, (t) => { const out = { ...t, priority }; if (!priority) delete out.priority; return out; }))),
    el("div", { className: "field" }, el("span", { className: "label", textContent: d.due }),
      el("div", { className: "date-row" },
        el("input", { type: "date", className: "date-in", value: task.due ?? "", ariaLabel: d.due, onchange: (event) => { if (event.target.value) update(task.id, { due: event.target.value }); } }),
        task.due ? el("button", { type: "button", className: "ghost", textContent: d.clearDue, onclick: () => update(task.id, (t) => { const out = { ...t }; delete out.due; return out; }) }) : null)),
    el("div", { className: "field" }, el("span", { className: "label", textContent: d.tags }),
      el("div", { className: "tag-edit" }, ...(task.tags ?? []).map((tag) => el("span", { className: "chip tag" }, tag,
        el("button", { type: "button", ariaLabel: `${d.close} ${tag}`, textContent: "×", onclick: () => update(task.id, (t) => { const out = { ...t, tags: t.tags.filter((x) => x !== tag) }; if (!out.tags.length) delete out.tags; return out; }) }))), tagInput)),
    el("div", { className: "field field-steps" }, el("span", { className: "label", textContent: steps.length ? `${d.steps} · ${steps.filter((s) => s.done).length}/${steps.length}` : d.steps }),
      el("ul", { className: "steps" }, ...steps.map((step, index) => el("li", { className: step.done ? "done" : "" },
        el("button", { type: "button", className: "check", role: "checkbox", ariaChecked: step.done, ariaLabel: step.title, onclick: () => setSteps(steps.map((s, i) => i === index ? { ...s, done: !s.done } : s)) }, icon("check")),
        el("span", { textContent: step.title }),
        el("button", { type: "button", className: "icon-btn", ariaLabel: `${d.remove}: ${step.title}`, onclick: () => setSteps(steps.filter((_, i) => i !== index)) }, icon("close"))))),
      stepInput),
    el("div", { className: "field" }, el("label", { textContent: d.note }), note),
    el("div", { className: "drawer-foot" },
      el("button", { type: "button", className: "plan", onclick: () => somniq.prompt(copy.breakPrompt(task)) }, icon("sparkle"), copy.breakDown),
      el("button", { type: "button", className: "danger", onclick: () => {
        selected = null;
        const before = commit(tasks.filter((t) => t.id !== task.id));
        toast(copy.deleted, { undo: () => commit(before) });
      } }, d.remove))));
}

// ── Quick add ─────────────────────────────────────────────
function previewQuick() {
  const text = $("quickInput").value;
  const hint = $("hint");
  if (!text.trim()) { hint.textContent = copy.hint; return; }
  const parsed = parseQuick(text, base);
  hint.replaceChildren(
    parsed.priority ? el("span", { className: "chip", textContent: `${copy.detail.priority} ${copy.priority[parsed.priority]}` }) : null,
    parsed.due ? el("span", { className: `chip due-${dueLabel(parsed.due, copy, language, base).tone}` }, icon("calendar"), dueLabel(parsed.due, copy, language, base).text) : null,
    ...parsed.tags.map((tag) => el("span", { className: "chip tag", textContent: tag })));
  if (!hint.childNodes.length) hint.textContent = copy.hint;
}
$("quick").onsubmit = (event) => {
  event.preventDefault();
  const input = $("quickInput");
  const parsed = parseQuick(input.value, base);
  if (!parsed.title) return;
  const task = { id: newId(), title: parsed.title, status: "todo", created: base };
  if (parsed.priority) task.priority = parsed.priority;
  if (parsed.due) task.due = parsed.due;
  else if (prefs.filter === "today") task.due = base;
  const tags = parsed.tags.length ? parsed.tags : prefs.tag ? [prefs.tag] : [];
  if (tags.length) task.tags = tags;
  if (prefs.filter === "done" || prefs.filter === "overdue") prefs = { ...prefs, filter: "all" };
  commit([task, ...tasks]);
  input.value = ""; previewQuick();
};
$("quickInput").oninput = previewQuick;
$("plan").onclick = () => somniq.prompt(copy.planPrompt);
document.addEventListener("keydown", (event) => {
  const typing = event.target.matches?.("input, textarea, select");
  if (event.key === "Escape" && selected) { selected = null; render(); }
  else if (!typing && (event.key === "/" || event.key === "n")) { event.preventDefault(); $("quickInput").focus(); }
});

// ── Render ────────────────────────────────────────────────
function render() {
  base = today();
  renderRail();
  $("quickInput").placeholder = copy.quick;
  const list = scoped();
  const view = { list: renderList, board: renderBoard, calendar: renderCalendar, timeline: renderTimeline }[prefs.view];
  const scroll = $("content").scrollTop;
  $("content").replaceChildren(...view(list).flat().filter(Boolean));
  $("content").scrollTop = scroll;
  // Opening the timeline puts today a third of the way in, with the past to its left.
  if (prefs.view === "timeline" && shownView !== "timeline") {
    const now = $("content").querySelector(".tl-now");
    if (now) $("content").scrollLeft = Math.max(0, now.offsetLeft - $("content").clientWidth / 3);
  }
  shownView = prefs.view;
  renderDrawer();
}

somniq.ready().then(({ language: lang, data }) => {
  language = lang === "cn" ? "cn" : "en"; copy = COPY[language];
  document.documentElement.lang = language === "cn" ? "zh-CN" : "en";
  tasks = clean(data.tasks); prefs = cleanView(data.view);
  render(); previewQuick();
  somniq.onData((next) => { tasks = clean(next.tasks); render(); });
});
