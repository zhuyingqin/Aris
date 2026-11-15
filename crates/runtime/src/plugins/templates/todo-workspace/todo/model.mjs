// The task model both views share: copy, cleaning, dates, ranking and the
// quick-add syntax. Imported as "pkg:todo/model.mjs".
//
// The "tasks" widget holds an array of
//   { id, title, status: "todo" | "doing" | "done", priority?: "high" | "medium" | "low",
//     due?: "YYYY-MM-DD", tags?: [string], note?: string, steps?: [{ title, done }],
//     created?: "YYYY-MM-DD", completed?: "YYYY-MM-DD" }
// and the "view" widget { view: "list" | "board" | "calendar" | "timeline", filter, tag? }.

export const PLUGIN = "@local/project-tasks";
export const STATUSES = ["todo", "doing", "done"];
export const PRIORITIES = ["high", "medium", "low"];
export const VIEWS = ["list", "board", "calendar", "timeline"];
export const FILTERS = ["all", "today", "week", "overdue", "done"];
const MAX_TASKS = 500;

export const COPY = {
  en: {
    title: "Tasks",
    views: { list: "List", board: "Board", calendar: "Calendar", timeline: "Timeline" },
    filters: { all: "All open", today: "Today", week: "Next 7 days", overdue: "Overdue", done: "Completed" },
    filterLabel: "Focus", tagLabel: "Tags", noTags: "Add #tags to tasks to group them here.",
    status: { todo: "To do", doing: "In progress", done: "Done" },
    priority: { high: "High", medium: "Medium", low: "Low", none: "None" },
    groups: { overdue: "Overdue", today: "Today", soon: "Next 7 days", later: "Later", undated: "No date", done: "Completed" },
    summary: (done, total) => total ? `${done} of ${total} done` : "Nothing planned yet",
    quick: "Add a task…  #tag  !high  @tomorrow",
    hint: "Enter to add · #tag · !high / !medium / !low · @today, @fri, @11-20",
    today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday",
    overdueBy: (n) => `${n} day${n === 1 ? "" : "s"} overdue`, inDays: (n) => `in ${n} days`,
    empty: { all: "Nothing open. Add a task above, or ask the agent to plan the next steps.", today: "Nothing due today.", week: "Nothing due in the next 7 days.", overdue: "Nothing overdue. Nice.", done: "Completed tasks show up here." },
    plan: "Plan with AI", planPrompt: "Look at this project's current state and propose the next tasks. Write them with PluginPanel to plugin @local/project-tasks, panel \"tasks\", widget \"tasks\": an array of { id, title, status: todo | doing | done, priority?: high | medium | low, due?: YYYY-MM-DD, tags?, note?, steps?: [{ title, done }] }. Keep every task that is already there.",
    breakDown: "Break it down with AI", breakPrompt: (task) => `Break the task "${task.title}" (id ${task.id}) into concrete steps. Write them with PluginPanel to plugin @local/project-tasks, panel "tasks", widget "tasks": change only that task's "steps" ([{ title, done }]) and keep every other task as it is.`,
    detail: { title: "Task", status: "Status", priority: "Priority", due: "Due", tags: "Tags", addTag: "Add a tag…", steps: "Steps", addStep: "Add a step…", note: "Notes", notePlaceholder: "Context, links, what done looks like…", remove: "Delete task", close: "Close", clearDue: "Clear" },
    month: (y, m) => new Date(y, m, 1).toLocaleDateString("en", { month: "long", year: "numeric" }),
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    unscheduled: "Unscheduled", dropHere: "Drag tasks onto a day to schedule them.", more: (n) => `+${n} more`,
    undatedNote: (n) => n ? `${n} open task${n === 1 ? "" : "s"} without a date ${n === 1 ? "is" : "are"} not on the timeline.` : "",
    timelineEmpty: "Give tasks a due date to see them on the timeline.",
    failed: "Could not save: ", saved: "Saved", deleted: "Task deleted", undo: "Undo",
    glance: { done: (d, t) => `${d} / ${t} done`, overdue: (n) => `${n} overdue`, dueToday: (n) => `${n} due today`, clear: "All clear", empty: "No tasks yet.", ask: "Ask AI for next steps", add: "Add a task…", allDone: "Everything is done.", open: "Open tasks" },
  },
  cn: {
    title: "任务",
    views: { list: "列表", board: "看板", calendar: "日历", timeline: "时间线" },
    filters: { all: "全部未完成", today: "今天", week: "未来 7 天", overdue: "已逾期", done: "已完成" },
    filterLabel: "聚焦", tagLabel: "标签", noTags: "给任务加上 #标签，就能在这里分组查看。",
    status: { todo: "待办", doing: "进行中", done: "已完成" },
    priority: { high: "高", medium: "中", low: "低", none: "无" },
    groups: { overdue: "已逾期", today: "今天", soon: "未来 7 天", later: "以后", undated: "未定日期", done: "已完成" },
    summary: (done, total) => total ? `已完成 ${done} / ${total}` : "还没有安排任务",
    quick: "添加任务…  #标签  !高  @明天",
    hint: "回车添加 · #标签 · !高 / !中 / !低 · @今天、@周五、@11-20",
    today: "今天", tomorrow: "明天", yesterday: "昨天",
    overdueBy: (n) => `逾期 ${n} 天`, inDays: (n) => `${n} 天后`,
    empty: { all: "没有未完成的任务。在上方添加，或让 AI 规划下一步。", today: "今天没有到期的任务。", week: "未来 7 天没有到期的任务。", overdue: "没有逾期任务，保持得不错。", done: "完成的任务会显示在这里。" },
    plan: "让 AI 规划", planPrompt: "查看此项目当前的状态，提出接下来的任务。用 PluginPanel 写入插件 @local/project-tasks 的面板 \"tasks\"、组件 \"tasks\"：一个数组，每项 { id, title, status: todo | doing | done, priority?: high | medium | low, due?: YYYY-MM-DD, tags?, note?, steps?: [{ title, done }] }。保留已有的全部任务。",
    breakDown: "让 AI 拆解", breakPrompt: (task) => `把任务“${task.title}”（id ${task.id}）拆成具体可执行的步骤。用 PluginPanel 写回插件 @local/project-tasks 的面板 "tasks"、组件 "tasks"：只修改这个任务的 "steps"（[{ title, done }]），其它任务保持不变。`,
    detail: { title: "任务", status: "状态", priority: "优先级", due: "截止日期", tags: "标签", addTag: "添加标签…", steps: "步骤", addStep: "添加步骤…", note: "备注", notePlaceholder: "背景、链接、怎样算完成…", remove: "删除任务", close: "关闭", clearDue: "清除" },
    month: (y, m) => `${y} 年 ${m + 1} 月`,
    weekdays: ["一", "二", "三", "四", "五", "六", "日"],
    unscheduled: "未安排", dropHere: "把任务拖到某一天即可安排日期。", more: (n) => `还有 ${n} 项`,
    undatedNote: (n) => n ? `另有 ${n} 项未定日期的任务没有显示在时间线上。` : "",
    timelineEmpty: "给任务设置截止日期后，就会出现在时间线上。",
    failed: "保存失败：", saved: "已保存", deleted: "已删除任务", undo: "撤销",
    glance: { done: (d, t) => `已完成 ${d} / ${t}`, overdue: (n) => `${n} 项逾期`, dueToday: (n) => `今天到期 ${n} 项`, clear: "没有紧急事项", empty: "还没有任务。", ask: "让 AI 列出下一步", add: "添加任务…", allDone: "全部完成了。", open: "打开任务" },
  },
};

const pad = (n) => String(n).padStart(2, "0");
export const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const today = () => iso(new Date());
export const fromIso = (text) => { const [y, m, d] = text.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (text, n) => { const date = fromIso(text); date.setDate(date.getDate() + n); return iso(date); };
export const daysBetween = (from, to) => Math.round((fromIso(to) - fromIso(from)) / 86400000);
const validDate = (text) => typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) && iso(fromIso(text)) === text;
const str = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

export const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Tasks come from disk and from the agent: keep only what this page understands. */
export function clean(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, MAX_TASKS).flatMap((task, index) => {
    if (!task || typeof task !== "object") return [];
    const title = str(task.title ?? task.text, 300);
    if (!title) return [];
    let id = str(task.id, 64) || `t${index}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    const status = STATUSES.includes(task.status) ? task.status : task.completed === true ? "done" : "todo";
    const out = { id, title, status };
    if (PRIORITIES.includes(task.priority)) out.priority = task.priority;
    if (validDate(task.due)) out.due = task.due;
    const tags = Array.isArray(task.tags) ? [...new Set(task.tags.map((tag) => str(tag, 40).replace(/^#/, "")).filter(Boolean))].slice(0, 12) : [];
    if (tags.length) out.tags = tags;
    const note = str(task.note, 4000);
    if (note) out.note = note;
    const steps = Array.isArray(task.steps) ? task.steps.flatMap((step) => {
      const text = str(typeof step === "string" ? step : step?.title, 300);
      return text ? [{ title: text, done: step?.done === true }] : [];
    }).slice(0, 50) : [];
    if (steps.length) out.steps = steps;
    if (validDate(task.created)) out.created = task.created;
    if (validDate(task.completed)) out.completed = task.completed;
    return [out];
  });
}

export function cleanView(value) {
  const view = value && typeof value === "object" ? value : {};
  return {
    view: VIEWS.includes(view.view) ? view.view : "list",
    filter: FILTERS.includes(view.filter) ? view.filter : "all",
    tag: typeof view.tag === "string" && view.tag ? view.tag.slice(0, 40) : null,
  };
}

const PRIORITY_WORDS = { h: "high", high: "high", "1": "high", "高": "high", m: "medium", med: "medium", medium: "medium", "2": "medium", "中": "medium", l: "low", low: "low", "3": "low", "低": "low" };
const WEEKDAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0, "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 0, "周天": 0 };

function dateWord(word, base) {
  const lower = word.toLowerCase();
  if (["today", "今天", "今日"].includes(lower)) return base;
  if (["tomorrow", "tmr", "明天"].includes(lower)) return addDays(base, 1);
  if (["后天"].includes(lower)) return addDays(base, 2);
  if (lower in WEEKDAYS) {
    const now = fromIso(base).getDay();
    const ahead = (WEEKDAYS[lower] - now + 7) % 7 || 7;
    return addDays(base, ahead);
  }
  if (validDate(word)) return word;
  const short = word.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (short) {
    const year = fromIso(base).getFullYear();
    let candidate = `${year}-${pad(Number(short[1]))}-${pad(Number(short[2]))}`;
    if (!validDate(candidate)) return null;
    if (candidate < base) candidate = `${year + 1}${candidate.slice(4)}`;
    return validDate(candidate) ? candidate : null;
  }
  return null;
}

/** "Write intro #paper !high @fri" -> { title: "Write intro", tags: ["paper"], priority: "high", due: "<that friday>" } */
export function parseQuick(text, base = today()) {
  const out = { title: "", tags: [] };
  const words = [];
  for (const token of text.trim().split(/\s+/)) {
    if (/^#[^#\s]{1,40}$/.test(token)) out.tags.push(token.slice(1));
    else if (/^[!！]\S+$/.test(token) && PRIORITY_WORDS[token.slice(1).toLowerCase()]) out.priority = PRIORITY_WORDS[token.slice(1).toLowerCase()];
    else if (/^[@＠]\S+$/.test(token) && dateWord(token.slice(1), base)) out.due = dateWord(token.slice(1), base);
    else words.push(token);
  }
  out.title = words.join(" ").trim();
  out.tags = [...new Set(out.tags)];
  return out;
}

/** The order open tasks are worked in: overdue, then by date, then by priority. */
export function rank(tasks, base = today()) {
  const weight = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    const da = a.due ?? "9999-99-99", db = b.due ?? "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    const pa = weight[a.priority] ?? 3, pb = weight[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    if ((a.status === "doing") !== (b.status === "doing")) return a.status === "doing" ? -1 : 1;
    return 0;
  });
}

/** "Today", "Tomorrow", "3 days overdue", "Nov 20"… and whether it is late. */
export function dueLabel(due, copy, language, base = today()) {
  const days = daysBetween(base, due);
  if (days === 0) return { text: copy.today, tone: "today" };
  if (days === 1) return { text: copy.tomorrow, tone: "soon" };
  if (days < 0) return { text: copy.overdueBy(-days), tone: "late" };
  if (days < 7) return { text: fromIso(due).toLocaleDateString(language === "cn" ? "zh-CN" : "en", { weekday: "short" }), tone: "soon" };
  const sameYear = due.slice(0, 4) === base.slice(0, 4);
  return { text: fromIso(due).toLocaleDateString(language === "cn" ? "zh-CN" : "en", sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }), tone: "later" };
}

export function stats(tasks, base = today()) {
  const open = tasks.filter((task) => task.status !== "done");
  return {
    total: tasks.length,
    done: tasks.length - open.length,
    open: open.length,
    overdue: open.filter((task) => task.due && task.due < base).length,
    today: open.filter((task) => task.due === base).length,
  };
}

/** A task moved to `status`, with its completion date kept in step. */
export function withStatus(task, status, base = today()) {
  const next = { ...task, status };
  if (status === "done") next.completed = task.completed ?? base;
  else delete next.completed;
  return next;
}

/** A small SVG progress ring, built with DOM calls only. */
export function ring(fraction, size, stroke) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", size); svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  for (const [cls, dash] of [["ring-track", c], ["ring-value", c * Math.max(0, Math.min(1, fraction))]]) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", size / 2); circle.setAttribute("cy", size / 2); circle.setAttribute("r", r);
    circle.setAttribute("fill", "none"); circle.setAttribute("stroke-width", stroke);
    circle.setAttribute("stroke-linecap", "round");
    circle.setAttribute("stroke-dasharray", `${dash} ${c}`);
    circle.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
    svg.append(circle);
  }
  return svg;
}

/** `el("div", { className: "x" }, child, "text")`: DOM without innerHTML. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    // aria-* keep "false": a checkbox that is not checked says so.
    if (/^aria[A-Z]/.test(key)) node.setAttribute(key.replace(/^aria([A-Z])/, (_, c) => `aria-${c.toLowerCase()}`), String(value));
    else if (value === false) continue;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") {
      for (const [name, css] of Object.entries(value)) name.startsWith("--") ? node.style.setProperty(name, css) : (node.style[name] = css);
    }
    else if (key === "role" || key === "for" || key === "tabindex") node.setAttribute(key, String(value));
    else node[key] = value;
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}
