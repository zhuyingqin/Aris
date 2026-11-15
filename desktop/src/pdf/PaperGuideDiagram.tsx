import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { renderMermaid } from "../chat/MermaidDiagram";
import type { BarChart, FlowDiagram, FlowNodeRole, TeachingDiagram } from "./paperReadingApi";
import PaperReadingContent from "./PaperReadingContent";

/** Inputs and outputs are rounded boxes: Mermaid's stadium shape costs tens
 * of kilobytes of path data per node. */
const SHAPES: Record<FlowNodeRole, [string, string]> = {
  input: ['("', '")'],
  output: ['("', '")'],
  step: ['["', '"]'],
  decision: ['{"', '"}'],
  data: ['[("', '")]'],
};

/** Plain label text as a quoted Mermaid string. Every character that could
 * end the quote, open a directive or markup, or start Markdown mode becomes
 * an entity code, and LaTeX delimiters are dropped (labels are plain text). */
function label(text: string): string {
  return text.replace(/\$/g, "").replace(/\s+/g, " ").trim()
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\|/g, "#124;");
}

/** Mermaid source for a validated flow. Node ids are regenerated, so a model
 * id such as `end` or `graph` can never collide with Mermaid keywords. */
export function flowToMermaid(flow: FlowDiagram): string {
  const ids = new Map(flow.nodes.map((node, index) => [node.id, `n${index}`]));
  const declare = (node: FlowDiagram["nodes"][number]) => {
    const [open, close] = SHAPES[node.role ?? "step"] ?? SHAPES.step;
    return `${ids.get(node.id)}${open}${label(node.label)}${close}`;
  };
  const grouped = new Set((flow.groups ?? []).flatMap(group => group.nodes));
  const lines = [`flowchart ${flow.direction === "TD" ? "TD" : "LR"}`];
  for (const node of flow.nodes) if (!grouped.has(node.id)) lines.push(`  ${declare(node)}`);
  (flow.groups ?? []).forEach((group, index) => {
    lines.push(`  subgraph g${index}["${label(group.label)}"]`);
    for (const id of group.nodes) {
      const node = flow.nodes.find(item => item.id === id);
      if (node) lines.push(`    ${declare(node)}`);
    }
    lines.push("  end");
  });
  for (const edge of flow.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const text = edge.label?.trim();
    lines.push(text ? `  ${from} -->|"${label(text)}"| ${to}` : `  ${from} --> ${to}`);
  }
  return lines.join("\n");
}

const nodeLabel = (flow: FlowDiagram, id: string) => flow.nodes.find(node => node.id === id)?.label ?? id;

/** Drawn width from the SVG's viewBox, or 0 when it has none. */
export function svgWidth(svg: string): number {
  const match = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*"/.exec(svg);
  const width = match ? Number(match[1]) : 0;
  return Number.isFinite(width) ? width : 0;
}

/** A wide flow may shrink to this share of its drawn width; beyond that the
 * frame scrolls sideways so labels stay readable in a narrow reader. */
const MIN_DIAGRAM_SCALE = 0.85;

/** Drawn with the app's Mermaid theme. If drawing fails, the same content is
 * listed as text, so the picture's information is never lost. */
function FlowFigure({ flow, english }: { flow: FlowDiagram; english: boolean }) {
  const theme = useStore(store => store.theme);
  const code = useMemo(() => flowToMermaid(flow), [flow]);
  const [drawn, setDrawn] = useState<{ svg: string; failed: boolean }>({ svg: "", failed: false });
  useEffect(() => {
    let active = true;
    setDrawn({ svg: "", failed: false });
    renderMermaid(code, theme)
      .then(svg => { if (active) setDrawn({ svg, failed: false }); })
      .catch(() => { if (active) setDrawn({ svg: "", failed: true }); });
    return () => { active = false; };
  }, [code, theme]);
  if (drawn.failed) {
    return <ol className="paper-essay-diagram-fallback" aria-label={english ? "Diagram as text" : "示意图（文字版）"}>
      {flow.edges.map((edge, index) => <li key={index}>{nodeLabel(flow, edge.from)} → {edge.label ? `${edge.label} → ` : ""}{nodeLabel(flow, edge.to)}</li>)}
    </ol>;
  }
  const width = svgWidth(drawn.svg);
  return <div className="paper-essay-diagram-canvas" role="img" aria-label={flow.title} aria-busy={!drawn.svg}>
    <div className="paper-essay-diagram-stage" style={width ? { minWidth: Math.round(width * MIN_DIAGRAM_SCALE) } : undefined}
      dangerouslySetInnerHTML={{ __html: drawn.svg }} />
  </div>;
}

function formatValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function BarFigure({ chart }: { chart: BarChart }) {
  const largest = Math.max(...chart.bars.map(bar => Math.abs(bar.value))) || 1;
  return <ul className="paper-essay-bars">
    {chart.bars.map((bar, index) => <li key={index} className={bar.highlight ? "is-highlight" : undefined}>
      <span className="paper-essay-bar-label">{bar.label}</span>
      <span className="paper-essay-bar-track" aria-hidden="true"><span className="paper-essay-bar-fill" style={{ width: `${(Math.abs(bar.value) / largest) * 100}%` }} /></span>
      <span className="paper-essay-bar-value">{formatValue(bar.value)}{chart.unit ? ` ${chart.unit}` : ""}</span>
    </li>)}
  </ul>;
}

/** A teaching picture with its provenance: a diagram drawn from the paper, or
 * numbers that are either the paper's own or invented for teaching. */
export default function PaperGuideDiagram({ diagram, english, eyebrow }: {
  diagram: TeachingDiagram; english: boolean; eyebrow: string;
}) {
  const provenance = diagram.kind === "flow"
    ? (english ? "Teaching diagram drawn from the paper, not an original figure" : "讲解示意图：根据原文整理，不是论文原图")
    : diagram.origin === "paper"
      ? (english ? "Values from the paper's original table" : "数值来自论文原始表格")
      : (english ? "Invented teaching data, not the paper's results" : "教学构造的数据，不是论文结果");
  return <figure className="paper-essay-diagram">
    <header className="paper-essay-diagram-head"><span className="paper-essay-eyebrow">{eyebrow}</span><strong>{diagram.title}</strong></header>
    {diagram.kind === "flow" ? <FlowFigure flow={diagram} english={english} /> : <BarFigure chart={diagram} />}
    <figcaption>
      <PaperReadingContent content={diagram.caption} />
      <p className="paper-essay-caption">{provenance}</p>
    </figcaption>
  </figure>;
}

/** The diagram as Markdown for saved notes. */
export function diagramMarkdown(diagram: TeachingDiagram): string {
  if (diagram.kind === "flow") return `**${diagram.title}**\n\n\`\`\`mermaid\n${flowToMermaid(diagram)}\n\`\`\`\n\n${diagram.caption}`;
  const rows = diagram.bars.map(bar => `| ${bar.label.replace(/\|/g, "\\|")} | ${formatValue(bar.value)} |`).join("\n");
  return `**${diagram.title}**\n\n| | ${diagram.unit || "value"} |\n| --- | --- |\n${rows}\n\n${diagram.caption}`;
}
