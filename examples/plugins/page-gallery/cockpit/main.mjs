// The cockpit's logic, as a module that imports the package's chart kit.
import { area, ring } from "pkg:cockpit/charts.mjs";

const COPY = {
  en: { title: "Experiment cockpit", sample: "Sample data — ask the agent to load your real runs", done: "Runs finished", budget: "GPU budget used", best: "Best accuracy",
    loss: "Training loss", runs: "Runs", status: { running: "Running", done: "Done", failed: "Failed", queued: "Queued" }, ask: "Refresh from my results",
    prompt: "Read this project's experiment logs and results, and write every run to the Experiment cockpit panel (widget \"runs\") with PluginPanel. Each run: { id, name, status: running|done|failed|queued, accuracy (0..1), gpuHours, loss: [numbers per epoch] }. Also set \"budget\" in hours.", hours: "h", of: "of" },
  cn: { title: "实验驾驶舱", sample: "示例数据：请 AI 载入你的真实实验", done: "已完成实验", budget: "GPU 预算已用", best: "最佳准确率",
    loss: "训练损失", runs: "实验", status: { running: "运行中", done: "已完成", failed: "失败", queued: "排队中" }, ask: "按我的结果刷新",
    prompt: "读取这个项目的实验日志和结果，用 PluginPanel 把每次实验写入“实验驾驶舱”面板（组件 \"runs\"）。每次实验：{ id, name, status: running|done|failed|queued, accuracy (0..1), gpuHours, loss: [每个 epoch 的数值] }，并设置以小时计的 \"budget\"。", hours: "小时", of: "/" },
};
const PALETTE = ["#7c9cff", "#ff8a65", "#4dd0a8", "#f6c453", "#c792ea"];
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

function clean(value) {
  const source = value && typeof value === "object" ? value : {};
  const runs = (Array.isArray(source.runs) ? source.runs : []).filter((r) => r && typeof r.name === "string").map((r, i) => ({
    id: String(r.id ?? i), name: r.name, status: ["running", "done", "failed", "queued"].includes(r.status) ? r.status : "queued",
    accuracy: Number.isFinite(r.accuracy) ? r.accuracy : null, gpuHours: Number.isFinite(r.gpuHours) ? r.gpuHours : 0,
    loss: Array.isArray(r.loss) ? r.loss.map(Number).filter(Number.isFinite) : [] }));
  return { runs, budget: Number.isFinite(source.budget) && source.budget > 0 ? source.budget : 100 };
}

function gauge(label, value, text, color) {
  const card = el("section", { className: "gauge" });
  const dial = el("div", { className: "dial" }, ring(value, { color }), el("strong", { textContent: text }));
  dial.style.color = color;
  card.append(dial, el("span", { textContent: label }));
  return card;
}

function render(copy, model, sample) {
  const { runs, budget } = model;
  const done = runs.filter((r) => r.status === "done").length;
  const used = runs.reduce((sum, r) => sum + r.gpuHours, 0);
  const best = Math.max(0, ...runs.map((r) => r.accuracy ?? 0));
  $("title").textContent = copy.title;
  $("sample").textContent = sample ? copy.sample : "";
  $("sample").hidden = !sample;
  $("ask").textContent = copy.ask;
  $("gauges").replaceChildren(
    gauge(copy.done, runs.length ? done / runs.length : 0, `${done}${copy.of === "/" ? "/" : " of "}${runs.length}`, PALETTE[0]),
    gauge(copy.budget, used / budget, `${Math.round(used)}${copy.hours}`, PALETTE[1]),
    gauge(copy.best, best, `${(best * 100).toFixed(1)}%`, PALETTE[2]),
  );
  const plotted = runs.filter((r) => r.loss.length > 1).slice(0, PALETTE.length);
  $("chart-title").textContent = copy.loss;
  $("chart").replaceChildren(area(plotted.map((r) => ({ values: r.loss })), { colors: PALETTE }));
  $("legend").replaceChildren(...plotted.map((r, i) => el("span", {}, el("i", { style: `background:${PALETTE[i]}` }), r.name)));
  $("runs-title").textContent = copy.runs;
  $("runs").replaceChildren(...runs.map((r) => el("li", { className: r.status },
    el("b", { className: "status", title: copy.status[r.status] }),
    el("span", { className: "name", textContent: r.name }),
    el("span", { className: "acc", textContent: r.accuracy === null ? "—" : `${(r.accuracy * 100).toFixed(1)}%` }),
    el("span", { className: "hours", textContent: `${r.gpuHours}${copy.hours}` }))));
}

const { language, data } = await somniq.ready();
const copy = COPY[language] ?? COPY.en;
// A package data file fills the page until the agent writes real runs.
const seed = clean(JSON.parse(somniq.text("seed.json")));
$("mark").src = somniq.asset("mark.svg");
const show = (value) => { const model = clean(value); render(copy, model.runs.length ? model : seed, !model.runs.length); };
show(data.runs);
somniq.onData((next) => show(next.runs));
$("ask").onclick = () => somniq.prompt(copy.prompt);
