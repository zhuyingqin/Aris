// Widgets an agent fills with `PluginPanel`, and the two that act on a click.
// The backend checked every value against its widget's shape before storing
// it, so these render what they are given; the casts below name that shape.
import { useId, useState } from "react";
import type { UiChartData, UiClick, UiField, UiListItem, UiMetric, UiProgress, UiTableCell, UiText, UiWidget } from "../api/plugins";
import { openExternalUrl } from "../api/tauri";
import MarkdownContent from "../chat/MarkdownContent";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import { WidgetSection } from "./ChatPluginSection";

const text = (value: UiText, language: Language) => typeof value === "string" ? value : value[language];

const COPY = {
  cn: {
    empty: "还没有内容。让 Agent 更新这个面板后，会显示在这里。", rows: (n: number) => `${n} 行`, items: (n: number) => `${n} 项`,
    openFile: "在侧栏打开", openLink: "在浏览器打开", showData: "查看数据", category: "类别", choose: "请选择…",
    yes: "是", no: "否", fills: "填入输入框", sends: "直接发送", opens: "打开文件",
  },
  en: {
    empty: "Nothing here yet. It appears once the agent updates this panel.", rows: (n: number) => `${n} rows`, items: (n: number) => `${n} items`,
    openFile: "Open in side panel", openLink: "Open in browser", showData: "View data", category: "Category", choose: "Choose…",
    yes: "yes", no: "no", fills: "Fills the composer", sends: "Sends right away", opens: "Opens the file",
  },
};

const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const show = (value: UiTableCell | undefined) => value == null ? "–" : typeof value === "number" ? number.format(value) : String(value);

/** What the panel can ask its host to do on a click. */
export interface PanelActions {
  /** Put text in the composer; with `send`, also send it when nothing else is pending. */
  onPrompt?: (text: string, send: boolean) => void;
  onOpenFile?: (path: string) => void;
}

/** `{{key}}` → the form's value. One pass: a value is never scanned again. */
export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match, key: string) => values[key.trim()] ?? "");
}

function runClick(action: UiClick, actions: PanelActions, values: Record<string, string> = {}) {
  if (action.type === "prompt") actions.onPrompt?.(fillPrompt(action.text, values).trim(), action.send === true);
  else actions.onOpenFile?.(action.path);
}
const clickHint = (action: UiClick, language: Language) => {
  const copy = COPY[language];
  return action.type === "open-file" ? `${copy.opens}: ${action.path}` : action.send ? copy.sends : copy.fills;
};
const clickable = (action: UiClick, actions: PanelActions) => action.type === "prompt" ? Boolean(actions.onPrompt) : Boolean(actions.onOpenFile);

function Empty({ language }: { language: Language }) {
  return <p className="chat-plugin-empty">{COPY[language].empty}</p>;
}

function TableWidget({ title, columns, rows, language }: {
  title: string; columns: { key: string; title: UiText }[]; rows: Record<string, UiTableCell>[] | undefined; language: Language;
}) {
  return <WidgetSection title={title} icon="grid" summary={rows?.length ? COPY[language].rows(rows.length) : undefined}>
    {!rows?.length ? <Empty language={language} /> : <div className="chat-plugin-table-scroll" tabIndex={0} role="group" aria-label={title}>
      <table className="chat-plugin-table">
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col">{text(column.title, language)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => {
          const value = row[column.key];
          return <td key={column.key} className={typeof value === "number" ? "is-number" : undefined}>{show(value)}</td>;
        })}</tr>)}</tbody>
      </table>
    </div>}
  </WidgetSection>;
}

// Two or three to a row, never one card left alone on the last row.
const metricColumns = (count: number) => count <= 3 ? count : count === 4 ? 2 : 3;
const TONE_ICON = { good: "check", warn: "warning", bad: "error" } as const;
function MetricsWidget({ title, metrics, language }: { title: string; metrics: UiMetric[] | undefined; language: Language }) {
  return <WidgetSection title={title} icon="target">
    {!metrics?.length ? <Empty language={language} /> : <dl className="chat-plugin-metrics" style={{ gridTemplateColumns: `repeat(${metricColumns(metrics.length)}, minmax(0, 1fr))` }}>{metrics.map((metric, index) => <div key={index} className="chat-plugin-metric" data-tone={metric.tone}>
      <dt>{metric.label}</dt>
      {/* The tone is an icon as well as a color, so it never rests on hue alone. */}
      <dd>{metric.tone && <SvgIcon name={TONE_ICON[metric.tone]} size={13} />}{show(metric.value)}</dd>
      {metric.hint && <dd className="chat-plugin-metric-hint">{metric.hint}</dd>}
    </div>)}</dl>}
  </WidgetSection>;
}

function ListWidget({ title, items, language, actions }: { title: string; items: UiListItem[] | undefined; language: Language; actions: PanelActions }) {
  const copy = COPY[language];
  return <WidgetSection title={title} icon="list" summary={items?.length ? copy.items(items.length) : undefined}>
    {!items?.length ? <Empty language={language} /> : <ul className="chat-plugin-items">{items.map((item, index) => {
      const body = <><span className="chat-plugin-item-title">{item.title}{item.tag && <span className="chat-plugin-tag">{item.tag}</span>}</span>
        {item.detail && <span className="chat-plugin-item-detail">{item.detail}</span>}</>;
      // A path wins over a link: the file is the project's own evidence.
      if (item.path && actions.onOpenFile) return <li key={index}><button type="button" className="chat-plugin-item" title={`${copy.openFile}: ${item.path}`} onClick={() => actions.onOpenFile?.(item.path!)}>{body}<SvgIcon name="document" size={12} /></button></li>;
      if (item.url) return <li key={index}><button type="button" className="chat-plugin-item" title={`${copy.openLink}: ${item.url}`} onClick={() => void openExternalUrl(item.url!)}>{body}<SvgIcon name="externalLink" size={12} /></button></li>;
      return <li key={index}><div className="chat-plugin-item">{body}</div></li>;
    })}</ul>}
  </WidgetSection>;
}

function ProgressWidget({ title, progress, language }: { title: string; progress: UiProgress | undefined; language: Language }) {
  const percent = progress ? Math.round(Math.min(1, Math.max(0, progress.value)) * 100) : 0;
  return <WidgetSection title={title} icon="clock" summary={progress ? `${percent}%` : undefined}>
    {!progress ? <Empty language={language} /> : <>
      <div className="chat-plugin-progress is-data" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={progress.label ?? `${percent}%`}><span style={{ width: `${percent}%` }} /></div>
      {progress.label && <p className="chat-plugin-caption chat-plugin-progress-label">{progress.label}</p>}
    </>}
  </WidgetSection>;
}

// One y-axis, thin marks, a 2px gap between bars, series colors assigned in a
// fixed order (the palette is validated for both themes in the stylesheet's
// note). The plot is paired with a legend, a hover readout and a data table.
const W = 320, H = 150, LEFT = 34, RIGHT = 6, TOP = 8, BOTTOM = 20;

/** Round axis ends and the ticks between them (steps of 1, 2, 2.5 or 5 × 10ⁿ). */
export function niceTicks(low: number, high: number): number[] {
  if (low === high) { low -= 1; high += 1; }
  const raw = (high - low) / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const first = Math.floor(low / step + 1e-9), last = Math.ceil(high / step - 1e-9);
  return Array.from({ length: last - first + 1 }, (_unused, index) => Number(((first + index) * step).toPrecision(12)));
}
function ChartWidget({ title, kind, data, language }: { title: string; kind: "bar" | "line"; data: UiChartData | undefined; language: Language }) {
  const [hover, setHover] = useState<number | null>(null);
  const copy = COPY[language];
  const labels = data?.labels ?? [];
  const series = data?.series ?? [];
  const values = series.flatMap((item) => item.values).filter((value): value is number => typeof value === "number");
  const icon = kind === "bar" ? "barChart" : "lineChart";
  if (!labels.length || !values.length) return <WidgetSection title={title} icon={icon}><Empty language={language} /></WidgetSection>;

  // Bars start at zero. A line uses its height for the change it shows, and
  // keeps zero only when the data already sits next to it.
  const low = Math.min(...values), high = Math.max(...values);
  const zero = kind === "bar" || low >= 0 && low <= (high - low) / 4;
  const ticks = niceTicks(zero ? Math.min(0, low) : low, kind === "bar" ? Math.max(0, high) : high);
  const min = ticks[0], max = ticks[ticks.length - 1];
  const y = (value: number) => TOP + (max - value) / (max - min) * (H - TOP - BOTTOM);
  const band = (W - LEFT - RIGHT) / labels.length;
  const x = (index: number) => LEFT + band * (index + 0.5);
  // Thin the x labels to what fits; the hover readout names the rest.
  const step = Math.max(1, Math.ceil(labels.length / 5));
  const group = Math.max(1, band - Math.min(8, band * 0.3));
  const barWidth = Math.max(1, group / series.length - (group / series.length > 4 ? 2 : 0));

  return <WidgetSection title={title} icon={icon}>
    <svg className="chat-plugin-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${series.map((item) => item.name).join(", ")}`} onMouseLeave={() => setHover(null)}>
      {ticks.map((tick, index) => <g key={index}>
        <line className="chat-plugin-chart-grid" x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} />
        <text className="chat-plugin-chart-axis" x={LEFT - 5} y={y(tick) + 3} textAnchor="end">{number.format(tick)}</text>
      </g>)}
      {labels.map((label, index) => index % step === 0 && <text key={index} className="chat-plugin-chart-axis" x={x(index)} y={H - 6} textAnchor="middle">{label.length > 9 ? `${label.slice(0, 8)}…` : label}</text>)}
      {hover != null && <rect className="chat-plugin-chart-hover" x={LEFT + band * hover} y={TOP} width={band} height={H - TOP - BOTTOM} />}
      {series.map((item, s) => kind === "bar"
        ? <g key={s} className={`chat-plugin-series-${s + 1}`}>{item.values.map((value, index) => {
          if (typeof value !== "number") return null;
          const top = Math.min(y(value), y(0)), height = Math.max(1, Math.abs(y(value) - y(0)));
          return <rect key={index} x={LEFT + band * index + (band - group) / 2 + s * (group / series.length)} y={top} width={barWidth} height={height} rx={Math.min(3, barWidth / 2, height / 2)} />;
        })}</g>
        : <g key={s} className={`chat-plugin-series-${s + 1}`}>
          {/* A null breaks the line instead of being drawn as zero. */}
          <path fill="none" d={item.values.map((value, index) => typeof value === "number" ? `${index > 0 && typeof item.values[index - 1] === "number" ? "L" : "M"}${x(index)} ${y(value)}` : "").join(" ")} />
          {(labels.length <= 24 || hover != null) && item.values.map((value, index) => typeof value === "number" && (labels.length <= 24 || index === hover) && <circle key={index} cx={x(index)} cy={y(value)} r={hover === index ? 4 : 2.5} />)}
        </g>)}
      {labels.map((_label, index) => <rect key={index} className="chat-plugin-chart-hit" x={LEFT + band * index} y={0} width={band} height={H} onMouseEnter={() => setHover(index)} />)}
    </svg>
    <p className="chat-plugin-chart-readout" aria-live="off">{hover != null
      ? <><strong>{labels[hover]}</strong>{series.map((item, s) => <span key={s}><i className={`chat-plugin-swatch chat-plugin-series-${s + 1}`} />{series.length > 1 ? `${item.name} ` : ""}{show(item.values[hover])}</span>)}</>
      // One series needs no legend: the readout names it.
      : series.map((item, s) => <span key={s}><i className={`chat-plugin-swatch chat-plugin-series-${s + 1}`} />{item.name}</span>)}</p>
    <details className="chat-plugin-chart-data">
      <summary>{copy.showData}</summary>
      <div className="chat-plugin-table-scroll" tabIndex={0} role="group" aria-label={`${title} · ${copy.showData}`}>
        <table className="chat-plugin-table">
          <thead><tr><th scope="col">{copy.category}</th>{series.map((item, s) => <th key={s} scope="col">{item.name}</th>)}</tr></thead>
          <tbody>{labels.map((label, index) => <tr key={index}><th scope="row">{label}</th>{series.map((item, s) => <td key={s} className="is-number">{show(item.values[index])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  </WidgetSection>;
}

function FormWidget({ title, fields, submit, language, actions }: {
  title: string; fields: UiField[]; submit: { label: UiText; action: UiClick }; language: Language; actions: PanelActions;
}) {
  const copy = COPY[language];
  const base = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const set = (key: string, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));
  return <WidgetSection title={title} icon="edit">
    <form className="chat-plugin-form" onSubmit={(event) => {
      event.preventDefault();
      runClick(submit.action, actions, Object.fromEntries(fields.map((field) => {
        const value = values[field.key];
        return [field.key, field.input === "checkbox" ? (value === true ? copy.yes : copy.no) : String(value ?? "").trim()];
      })));
    }}>
      {fields.map((field) => {
        const id = `${base}-${field.key}`;
        const label = text(field.label, language);
        const value = values[field.key];
        if (field.input === "checkbox") return <label key={field.key} className="chat-plugin-check"><input type="checkbox" checked={value === true} onChange={(event) => set(field.key, event.target.checked)} /><span>{label}</span></label>;
        return <div key={field.key} className="chat-plugin-field">
          <label htmlFor={id}>{label}</label>
          {field.input === "textarea" ? <textarea id={id} rows={2} maxLength={4000} value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)} />
            : field.input === "select" ? <select id={id} value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)}>
              <option value="">{copy.choose}</option>
              {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            : <input id={id} type={field.input === "number" ? "number" : "text"} step="any" maxLength={500} value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />}
        </div>;
      })}
      <div className="chat-plugin-form-actions"><span className="chat-plugin-caption">{clickHint(submit.action, language)}</span>
        <button type="submit" className="chat-plugin-button chat-plugin-action" disabled={!clickable(submit.action, actions)}>{text(submit.label, language)}</button>
      </div>
    </form>
  </WidgetSection>;
}

// `json` belongs to a panel's own page; the host has nothing to draw for it.
type DataWidget = Exclude<UiWidget, { type: "todo-list" | "notes" | "agent-plan" | "text" | "json" }>;
export const isDataWidget = (widget: UiWidget): widget is DataWidget =>
  !["todo-list", "notes", "agent-plan", "text", "json"].includes(widget.type);

export function DataWidgetView({ widget, value, language, actions }: { widget: DataWidget; value: unknown; language: Language; actions: PanelActions }) {
  if (widget.type === "button") return <button type="button" className="chat-plugin-button chat-plugin-action chat-plugin-standalone" title={clickHint(widget.action, language)} disabled={!clickable(widget.action, actions)} onClick={() => runClick(widget.action, actions)}>
    <SvgIcon name={widget.action.type === "open-file" ? "document" : widget.action.send ? "send" : "sparkle"} size={12} />{text(widget.label, language)}
  </button>;
  const title = text(widget.title, language);
  switch (widget.type) {
    case "table": return <TableWidget title={title} columns={widget.columns} rows={value as Record<string, UiTableCell>[] | undefined} language={language} />;
    case "metrics": return <MetricsWidget title={title} metrics={value as UiMetric[] | undefined} language={language} />;
    case "list": return <ListWidget title={title} items={value as UiListItem[] | undefined} language={language} actions={actions} />;
    case "progress": return <ProgressWidget title={title} progress={value as UiProgress | undefined} language={language} />;
    case "chart": return <ChartWidget title={title} kind={widget.chart} data={value as UiChartData | undefined} language={language} />;
    case "form": return <FormWidget title={title} fields={widget.fields} submit={widget.submit} language={language} actions={actions} />;
    case "markdown": return <WidgetSection title={title} icon="document">
      {typeof value === "string" && value.trim() ? <div className="chat-plugin-markdown"><MarkdownContent text={value} /></div> : <Empty language={language} />}
    </WidgetSection>;
  }
}
