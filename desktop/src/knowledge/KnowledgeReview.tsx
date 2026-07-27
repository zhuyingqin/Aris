import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { literatureLlm } from "../api/tauri";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import { useKnowledgeStore } from "./knowledgeStore";
import {
  type KnowledgeEvidence,
  type KnowledgeFragment,
  type KnowledgePoint,
  type KnowledgeSearchHit,
} from "./knowledgeTypes";
import "./Knowledge.css";

type KnowledgeView = "fragments" | "graph" | "review" | "confirmed";
type PaperKnowledgeView = Exclude<KnowledgeView, "graph">;
type KnowledgeMode = "paper" | "globalGraph";

const VIEW_LABELS: Record<KnowledgeView, string> = {
  fragments: "知识片段",
  graph: "知识图谱",
  review: "待审核",
  confirmed: "已确认",
};

const PAPER_VIEW_IDS: PaperKnowledgeView[] = ["fragments", "review", "confirmed"];

const FRAGMENT_KIND_LABELS: Record<KnowledgeFragment["kind"], string> = {
  evidence: "证据片段",
  "answer-chain": "问答结论",
};

type GraphItemKind = KnowledgeFragment["kind"] | "confirmed";

interface GraphItem {
  id: string;
  kind: GraphItemKind;
  title: string;
  text: string;
  source: string;
}

interface GraphSubcategory {
  label: string;
  itemIds: string[];
}

interface GraphCategory {
  label: string;
  children: GraphSubcategory[];
}

interface GraphTaxonomy {
  categories: GraphCategory[];
}

interface VisualNode {
  id: string;
  label: string;
  meta?: string;
  kind: "root" | "category" | "subcategory" | GraphItemKind;
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VisualEdge {
  id: string;
  from: string;
  to: string;
}

const GRAPH_SYSTEM =
  "You rebuild a project-level literature knowledge graph. Create a top-down taxonomy from broad categories to narrow subcategories, then attach existing knowledge item ids. Do not invent item ids.";

const GRAPH_ITEM_KIND_LABELS: Record<GraphItemKind, string> = {
  evidence: "证据片段",
  "answer-chain": "问答结论",
  confirmed: "已确认知识点",
};

const cleanLabel = (value: unknown, fallback: string): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 48) : fallback;
};

const toGraphItems = (
  fragments: KnowledgeFragment[],
  confirmed: KnowledgePoint[],
): GraphItem[] => [
  ...fragments.map((fragment) => ({
    id: fragment.id,
    kind: fragment.kind,
    title: fragment.title,
    text: fragment.text,
    source: `${fragment.paperTitle}${fragment.page ? ` p.${fragment.page}` : ""}`,
  })),
  ...confirmed.map((point) => {
    const first = point.evidence[0];
    return {
      id: point.id,
      kind: "confirmed" as const,
      title: point.statement,
      text: `${point.question}\n${point.answer}`,
      source: first?.paperId ? `${first.paperId}${first.page ? ` p.${first.page}` : ""}` : point.sourcePaperId ?? "unknown",
    };
  }),
];

const classifyBroadCategory = (item: GraphItem): string => {
  const text = `${item.title} ${item.text}`.toLowerCase();
  if (/limit|limitation|risk|failure|局限|限制|风险|失败/.test(text)) return "局限与风险";
  if (/result|finding|accuracy|performance|improve|结果|发现|性能|提升|实验/.test(text)) return "结果与发现";
  if (/method|algorithm|model|framework|pipeline|方法|算法|模型|框架|流程/.test(text)) return "方法与机制";
  if (/problem|question|motivation|why|问题|动机|为什么|挑战/.test(text)) return "问题与动机";
  return "背景与概念";
};

const heuristicTaxonomy = (items: GraphItem[]): GraphTaxonomy => {
  const byCategory = new Map<string, Map<string, string[]>>();
  for (const item of items) {
    const category = classifyBroadCategory(item);
    const subcategory = GRAPH_ITEM_KIND_LABELS[item.kind];
    if (!byCategory.has(category)) byCategory.set(category, new Map());
    const children = byCategory.get(category)!;
    children.set(subcategory, [...(children.get(subcategory) ?? []), item.id]);
  }
  return {
    categories: Array.from(byCategory.entries()).map(([label, children]) => ({
      label,
      children: Array.from(children.entries()).map(([childLabel, itemIds]) => ({
        label: childLabel,
        itemIds,
      })),
    })),
  };
};

const extractJsonObject = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{")) return JSON.parse(fenced);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("agent did not return a JSON object");
};

const normalizeAgentTaxonomy = (raw: string, items: GraphItem[]): GraphTaxonomy => {
  const parsed = extractJsonObject(raw) as { categories?: unknown };
  if (!Array.isArray(parsed.categories)) {
    throw new Error("agent graph JSON must include categories[]");
  }
  const itemIds = new Set(items.map((item) => item.id));
  const used = new Set<string>();
  const categories: GraphCategory[] = [];

  for (const rawCategory of parsed.categories) {
    const category = rawCategory as { label?: unknown; children?: unknown };
    const children: GraphSubcategory[] = [];
    if (Array.isArray(category.children)) {
      for (const rawChild of category.children) {
        const child = rawChild as { label?: unknown; itemIds?: unknown; items?: unknown };
        const idsRaw = Array.isArray(child.itemIds) ? child.itemIds : child.items;
        const ids = (Array.isArray(idsRaw) ? idsRaw : [])
          .map((value) => typeof value === "string" ? value : (value as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string" && itemIds.has(id));
        const uniqueIds = Array.from(new Set(ids));
        if (uniqueIds.length === 0) continue;
        uniqueIds.forEach((id) => used.add(id));
        children.push({ label: cleanLabel(child.label, "未命名小类"), itemIds: uniqueIds });
      }
    }
    if (children.length > 0) {
      categories.push({ label: cleanLabel(category.label, "未命名大类"), children });
    }
  }

  const missing = items.map((item) => item.id).filter((id) => !used.has(id));
  if (missing.length > 0) {
    categories.push({ label: "未归类", children: [{ label: "待整理节点", itemIds: missing }] });
  }
  if (categories.length === 0) throw new Error("agent graph JSON did not assign any known item ids");
  return { categories };
};

const buildGraphPrompt = (items: GraphItem[]): string => {
  const payload = items.slice(0, 120).map((item) => ({
    id: item.id,
    type: GRAPH_ITEM_KIND_LABELS[item.kind],
    title: item.title,
    text: item.text,
    source: item.source,
  }));
  return `Rebuild a global literature knowledge graph from these items.

Goal:
- project-level global graph, not per-paper grouping
- broad categories first, narrow subcategories second, existing item ids as leaves
- categories should reflect research concepts, methods, findings, limitations, assumptions, or applications
- keep 3-7 broad categories when possible

Return ONLY JSON:
{"categories":[{"label":"broad category","children":[{"label":"narrow subcategory","itemIds":["existing-id"]}]}]}

Items:
${JSON.stringify(payload, null, 2)}`;
};

const buildVisualGraph = (taxonomy: GraphTaxonomy, items: GraphItem[], showItems: boolean) => {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const nodes: VisualNode[] = [];
  const edges: VisualEdge[] = [];
  const pushNode = (
    id: string,
    label: string,
    kind: VisualNode["kind"],
    level: number,
    meta?: string,
  ) => {
    const width = level === 0 ? 190 : level === 3 ? 230 : 190;
    const height = level === 3 ? 74 : 58;
    nodes.push({ id, label, meta, kind, level, x: 0, y: 0, width, height });
  };

  pushNode("root", "全局知识图谱", "root", 0, `${items.length} 个知识节点`);
  taxonomy.categories.forEach((category, categoryIndex) => {
    const categoryId = `cat-${categoryIndex}`;
    const categoryCount = category.children.reduce((sum, child) => sum + child.itemIds.length, 0);
    pushNode(categoryId, category.label, "category", 1, `${categoryCount} 个节点`);
    edges.push({ id: `root-${categoryId}`, from: "root", to: categoryId });

    category.children.forEach((child, childIndex) => {
      const childId = `sub-${categoryIndex}-${childIndex}`;
      pushNode(childId, child.label, "subcategory", 2, `${child.itemIds.length} 个节点`);
      edges.push({ id: `${categoryId}-${childId}`, from: categoryId, to: childId });

      if (!showItems) return;
      child.itemIds.forEach((itemId, itemIndex) => {
        const item = itemById.get(itemId);
        if (!item) return;
        const nodeId = `item-${categoryIndex}-${childIndex}-${itemIndex}-${item.id}`;
        pushNode(nodeId, item.title, item.kind, 3, item.source);
        edges.push({ id: `${childId}-${nodeId}`, from: childId, to: nodeId });
      });
    });
  });

  const byLevel = new Map<number, VisualNode[]>();
  nodes.forEach((node) => byLevel.set(node.level, [...(byLevel.get(node.level) ?? []), node]));
  const maxCount = Math.max(...Array.from(byLevel.values()).map((levelNodes) => levelNodes.length));
  const width = showItems ? 1220 : 860;
  const height = Math.max(520, maxCount * 104 + 80);
  const xByLevel = showItems ? [34, 300, 590, 900] : [34, 300, 590];
  for (const [level, levelNodes] of byLevel.entries()) {
    const gap = height / (levelNodes.length + 1);
    levelNodes.forEach((node, index) => {
      node.x = xByLevel[level] ?? 900 + (level - 3) * 280;
      node.y = Math.round(gap * (index + 1) - node.height / 2);
    });
  }
  return { nodes, edges, width, height };
};

const citation = (item: KnowledgeEvidence): string =>
  item.page ? `${item.paperId} p.${item.page}` : item.paperId;

const pointBelongsToPaper = (point: KnowledgePoint | KnowledgeSearchHit, paperId: string): boolean =>
  point.sourcePaperId === paperId || point.evidence.some((item) => item.paperId === paperId);

function EvidenceList({ evidence }: { evidence: KnowledgeEvidence[] }) {
  if (evidence.length === 0) {
    return <p className="kb-evidence-empty">没有可定位证据。</p>;
  }
  return (
    <ul className="kb-evidence">
      {evidence.map((item, index) => (
        <li key={`${item.annotationId ?? item.evidenceId ?? index}`}>
          <span className="kb-cite">[{citation(item)}]</span>
          {item.quote && <span className="kb-quote">"{item.quote}"</span>}
        </li>
      ))}
    </ul>
  );
}

function FragmentCard({ fragment }: { fragment: KnowledgeFragment }) {
  return (
    <article className={`kb-fragment-card ${fragment.kind}`}>
      <div className="kb-fragment-head">
        <span className="kb-kind">{FRAGMENT_KIND_LABELS[fragment.kind]}</span>
        <span className="kb-cite">
          [{fragment.paperTitle}{fragment.page ? ` p.${fragment.page}` : ""}]
        </span>
      </div>
      <p className="kb-statement">{fragment.title}</p>
      {fragment.text !== fragment.title && <p className="kb-fragment-text">{fragment.text}</p>}
      {fragment.quote && <p className="kb-fragment-quote">"{fragment.quote}"</p>}
      <div className="kb-fragment-meta">
        {fragment.status && <span>{fragment.status}</span>}
        {fragment.source && <span>{fragment.source}</span>}
        {fragment.evidenceIds && fragment.evidenceIds.length > 0 && (
          <span>{fragment.evidenceIds.length} 个证据锚点</span>
        )}
      </div>
    </article>
  );
}

function FragmentList({ fragments }: { fragments: KnowledgeFragment[] }) {
  if (fragments.length === 0) {
    return (
      <p className="kb-empty">
        暂无知识片段。先在阅读器中标注证据，或在“证据”页生成证据链。
      </p>
    );
  }
  return (
    <section className="kb-fragments" aria-label="知识片段">
      <div className="kb-fragment-summary">
        已汇总 <strong>{fragments.length}</strong> 个来自文献证据和问答证据链的知识片段。
      </div>
      <div className="kb-fragment-list">
        {fragments.map((fragment) => (
          <FragmentCard key={fragment.id} fragment={fragment} />
        ))}
      </div>
    </section>
  );
}

function KnowledgeGraph({
  fragments,
  confirmed,
  taxonomy,
  rebuilding,
  error,
  onRebuild,
}: {
  fragments: KnowledgeFragment[];
  confirmed: KnowledgePoint[];
  taxonomy: GraphTaxonomy | null;
  rebuilding: boolean;
  error: string | null;
  onRebuild: () => void;
}) {
  const items = useMemo(() => toGraphItems(fragments, confirmed), [fragments, confirmed]);
  const [showItems, setShowItems] = useState(false);
  const effectiveTaxonomy = useMemo(
    () => taxonomy ?? heuristicTaxonomy(items),
    [items, taxonomy],
  );
  const visual = useMemo(
    () => buildVisualGraph(effectiveTaxonomy, items, showItems),
    [effectiveTaxonomy, items, showItems],
  );

  // Zoom & pan state
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Reset view whenever the graph layout changes
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [visual.width, visual.height]);

  // Non-passive wheel listener so we can preventDefault and zoom
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const step = event.deltaY > 0 ? -0.12 : 0.12;
      setScale((prevScale) => {
        const nextScale = Math.max(0.2, Math.min(3, prevScale + step));
        if (nextScale === prevScale) return prevScale;
        const ratio = nextScale / prevScale;
        setOffset((prev) => ({
          x: mouseX - (mouseX - prev.x) * ratio,
          y: mouseY - (mouseY - prev.y) * ratio,
        }));
        return nextScale;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Window-level drag tracking so the cursor can leave the wrap without
  // stalling the pan.
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setOffset({
        x: start.offsetX + (event.clientX - start.x),
        y: start.offsetY + (event.clientY - start.y),
      });
    };
    const onUp = () => {
      setDragging(false);
      dragStartRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const beginDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    setDragging(true);
    dragStartRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
  };

  const zoomAround = (factor: number) => {
    setScale((prevScale) => {
      const nextScale = Math.max(0.2, Math.min(3, prevScale * factor));
      if (nextScale === prevScale) return prevScale;
      const ratio = nextScale / prevScale;
      const rect = wrapRef.current?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 0;
      const cy = rect ? rect.height / 2 : 0;
      setOffset((prev) => ({
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }));
      return nextScale;
    });
  };

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const fitView = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) {
      resetView();
      return;
    }
    const padding = 56;
    const nextScale = Math.max(
      0.2,
      Math.min(1.4, (rect.width - padding) / visual.width, (rect.height - padding) / visual.height),
    );
    setScale(nextScale);
    setOffset({
      x: Math.max(20, Math.round((rect.width - visual.width * nextScale) / 2)),
      y: Math.max(20, Math.round((rect.height - visual.height * nextScale) / 2)),
    });
  };

  if (items.length === 0) {
    return (
      <p className="kb-empty">
        暂无可绘制的知识图谱。需要先有文献证据片段或已确认知识点。
      </p>
    );
  }

  const nodeById = new Map(visual.nodes.map((node) => [node.id, node]));
  const edgePath = (edge: VisualEdge): string => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return "";
    const sx = from.x + from.width;
    const sy = from.y + from.height / 2;
    const tx = to.x;
    const ty = to.y + to.height / 2;
    const mid = sx + Math.max(52, (tx - sx) / 2);
    return `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
  };

  return (
    <section className="kb-graph" aria-label="知识图谱">
      <div className="kb-graph-toolbar">
        <div className="kb-graph-toolbar-copy">
          <strong>全局知识图谱</strong>
          <span>
            从左到右整理所有知识碎片：全局图谱、大类和小类
            {showItems ? "，以及知识节点。" : "。知识节点已隐藏，可展开查看。"}
          </span>
        </div>
        <div className="kb-graph-toolbar-actions">
          <button
            type="button"
            className={`kb-graph-toggle${showItems ? " active" : ""}`}
            onClick={() => setShowItems((value) => !value)}
          >
            {showItems ? "隐藏知识节点" : "显示知识节点"}
          </button>
          <span className="kb-graph-zoom-label" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="kb-graph-zoom-btn"
            onClick={() => zoomAround(1 / 1.25)}
            disabled={scale <= 0.21}
            title="缩小（Ctrl + 滚轮向下）"
            aria-label="缩小"
          >
            <SvgIcon name="minus" size={17} />
          </button>
          <button
            type="button"
            className="kb-graph-zoom-btn"
            onClick={() => zoomAround(1.25)}
            disabled={scale >= 2.99}
            title="放大（Ctrl + 滚轮向上）"
            aria-label="放大"
          >
            <SvgIcon name="plus" size={17} />
          </button>
          <button
            type="button"
            className="kb-graph-zoom-btn"
            onClick={fitView}
            title="适配视图"
            aria-label="适配视图"
          >
            <SvgIcon name="fit" size={17} />
          </button>
          <button
            type="button"
            className="kb-graph-zoom-btn"
            onClick={resetView}
            title="重置视图"
            aria-label="重置视图"
          >
            <SvgIcon name="reset" size={17} />
          </button>
          <span className="kb-graph-zoom-hint">滚轮缩放 · 拖动平移</span>
          <button type="button" className="kb-primary" onClick={onRebuild} disabled={rebuilding}>
            {rebuilding ? "Agent 重构中..." : "Agent 重构图谱"}
          </button>
        </div>
      </div>
      {error && <div className="kb-banner">{error}</div>}
      <div
        className={`kb-graph-canvas-wrap${dragging ? " dragging" : ""}`}
        ref={wrapRef}
        onMouseDown={beginDrag}
        role="presentation"
      >
        <div
          className="kb-graph-canvas"
          style={{
            width: visual.width,
            height: visual.height,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          <svg
            className="kb-graph-edges"
            viewBox={`0 0 ${visual.width} ${visual.height}`}
            aria-hidden="true"
          >
            {visual.edges.map((edge) => (
              <path key={edge.id} d={edgePath(edge)} />
            ))}
          </svg>
          {visual.nodes.map((node) => (
            <div
              key={node.id}
              className={`kb-graph-node ${node.kind}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                minHeight: node.height,
              }}
            >
              <strong>{node.label}</strong>
              {node.meta && <span>{node.meta}</span>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReviewCard({
  point,
  index,
  total,
  onConfirm,
  onReject,
  onRefine,
}: {
  point: KnowledgePoint;
  index: number;
  total: number;
  onConfirm: () => void;
  onReject: () => void;
  onRefine: (patch: Partial<Pick<KnowledgePoint, "question" | "answer" | "statement">>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(point.statement);
  const [answer, setAnswer] = useState(point.answer);

  // Reset the inline editor whenever a different card surfaces.
  useEffect(() => {
    setEditing(false);
    setStatement(point.statement);
    setAnswer(point.answer);
  }, [point.id, point.statement, point.answer]);

  const save = () => {
    onRefine({ statement: statement.trim() || point.statement, answer: answer.trim() || point.answer });
    setEditing(false);
  };

  return (
    <article className="kb-card">
      <div className="kb-card-head">
        {point.kind && <span className="kb-kind">{point.kind}</span>}
        <span className="kb-progress">知识点 {index + 1}/{total}</span>
      </div>

      {editing ? (
        <div className="kb-edit">
          <label>
            知识点
            <textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={2} />
          </label>
          <label>
            回答
            <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} />
          </label>
          <div className="kb-edit-actions">
            <button type="button" className="kb-primary" onClick={save}>保存草稿</button>
            <button type="button" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <p className="kb-statement">{point.statement}</p>
          <p className="kb-question"><span>Q</span>{point.question}</p>
          <p className="kb-answer"><span>A</span>{point.answer}</p>
          <EvidenceList evidence={point.evidence} />
        </>
      )}

      {!editing && (
        <div className="kb-card-actions">
          <button type="button" className="kb-confirm" onClick={onConfirm}>
            确认 <kbd>A</kbd>
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            修改 <kbd>E</kbd>
          </button>
          <button type="button" className="kb-reject" onClick={onReject}>
            丢弃 <kbd>X</kbd>
          </button>
        </div>
      )}
    </article>
  );
}

function ConfirmedCard({ point }: { point: KnowledgePoint | KnowledgeSearchHit }) {
  const relations = point.relations ?? [];
  return (
    <article className="kb-confirmed-card">
      <p className="kb-statement">{point.statement}</p>
      <p className="kb-question"><span>Q</span>{point.question}</p>
      <p className="kb-answer"><span>A</span>{point.answer}</p>
      <EvidenceList evidence={point.evidence} />
      {relations.length > 0 && (
        <ul className="kb-relations">
          {relations.map((relation, index) => (
            <li key={`${relation.dstId}-${index}`}>
              <span className="kb-relation-kind">{relation.kind ?? "related"}</span>
              {relation.statement ?? relation.dstId}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

interface KnowledgeProps {
  initialPaperId?: string;
  initialView?: KnowledgeView;
  mode?: KnowledgeMode;
}

export default function Knowledge({
  initialPaperId,
  initialView = "fragments",
  mode = "paper",
}: KnowledgeProps = {}) {
  const currentProject = useStore((state) => state.currentProject);
  const points = useKnowledgeStore((state) => state.points);
  const fragments = useKnowledgeStore((state) => state.fragments);
  const sourcePapers = useKnowledgeStore((state) => state.sourcePapers);
  const loaded = useKnowledgeStore((state) => state.loaded);
  const error = useKnowledgeStore((state) => state.error);
  const generatingPaperId = useKnowledgeStore((state) => state.generatingPaperId);
  const searchQuery = useKnowledgeStore((state) => state.searchQuery);
  const searchHits = useKnowledgeStore((state) => state.searchHits);
  const load = useKnowledgeStore((state) => state.load);
  const generate = useKnowledgeStore((state) => state.generate);
  const confirm = useKnowledgeStore((state) => state.confirm);
  const reject = useKnowledgeStore((state) => state.reject);
  const refine = useKnowledgeStore((state) => state.refine);
  const search = useKnowledgeStore((state) => state.search);

  const isGlobalGraph = mode === "globalGraph";
  const [view, setView] = useState<KnowledgeView>(
    isGlobalGraph ? "graph" : initialView === "graph" ? "fragments" : initialView,
  );
  const [reviewIndex, setReviewIndex] = useState(0);
  const [selectedPaper, setSelectedPaper] = useState(initialPaperId ?? "");
  const [graphTaxonomy, setGraphTaxonomy] = useState<GraphTaxonomy | null>(null);
  const [graphRebuilding, setGraphRebuilding] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    setReviewIndex(0);
    void load(projectId);
  }, [load, projectId]);

  useEffect(() => {
    if (initialPaperId) setSelectedPaper(initialPaperId);
  }, [initialPaperId]);

  useEffect(() => {
    setView(isGlobalGraph ? "graph" : initialView === "graph" ? "fragments" : initialView);
  }, [initialView, isGlobalGraph]);

  const scopedPaperId = mode === "paper" ? initialPaperId ?? "" : "";
  const visibleFragments = useMemo(
    () => scopedPaperId ? fragments.filter((fragment) => fragment.paperId === scopedPaperId) : fragments,
    [fragments, scopedPaperId],
  );
  const visiblePoints = useMemo(
    () => scopedPaperId ? points.filter((point) => pointBelongsToPaper(point, scopedPaperId)) : points,
    [points, scopedPaperId],
  );
  const drafts = useMemo(() => visiblePoints.filter((point) => point.status === "draft"), [visiblePoints]);
  const confirmed = useMemo(
    () => visiblePoints.filter((point) => point.status === "confirmed"),
    [visiblePoints],
  );
  const globalConfirmed = useMemo(
    () => points.filter((point) => point.status === "confirmed"),
    [points],
  );

  const safeIndex = Math.min(reviewIndex, Math.max(0, drafts.length - 1));
  const current = drafts[safeIndex];

  const handleConfirm = useCallback(() => {
    if (current) void confirm(current.id);
  }, [current, confirm]);
  const handleReject = useCallback(() => {
    if (current) void reject(current.id);
  }, [current, reject]);

  // Duolingo-style keyboard triage, only while a card is showing.
  useEffect(() => {
    if (view !== "review" || !current) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (event.key === "a" || event.key === "A" || event.key === "Enter") {
        event.preventDefault();
        handleConfirm();
      } else if (event.key === "x" || event.key === "X") {
        event.preventDefault();
        handleReject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, current, handleConfirm, handleReject]);

  const eligible = sourcePapers.filter((paper) =>
    paper.hasReading && (!initialPaperId || paper.id === initialPaperId),
  );
  const generating = generatingPaperId !== null;
  const selectedPaperValue = eligible.some((paper) => paper.id === selectedPaper)
    ? selectedPaper
    : "";

  const onGenerate = async () => {
    const paperId = selectedPaperValue || eligible[0]?.id;
    if (!paperId) return;
    await generate(paperId);
    setView("review");
    setReviewIndex(0);
  };

  const confirmedList: (KnowledgePoint | KnowledgeSearchHit)[] = searchQuery.trim()
    ? scopedPaperId
      ? searchHits.filter((point) => pointBelongsToPaper(point, scopedPaperId))
      : searchHits
    : confirmed;

  const graphItems = useMemo(
    () => toGraphItems(fragments, globalConfirmed),
    [fragments, globalConfirmed],
  );
  const graphItemsKey = useMemo(
    () => graphItems.map((item) => item.id).join("|"),
    [graphItems],
  );

  useEffect(() => {
    setGraphTaxonomy(null);
    setGraphError(null);
  }, [graphItemsKey]);

  const rebuildGraph = useCallback(async () => {
    if (graphItems.length === 0 || graphRebuilding) return;
    setGraphRebuilding(true);
    setGraphError(null);
    try {
      const raw = await literatureLlm(GRAPH_SYSTEM, buildGraphPrompt(graphItems));
      setGraphTaxonomy(normalizeAgentTaxonomy(raw, graphItems));
    } catch (err) {
      setGraphError(`Agent 重构失败，已保留本地分类图：${String(err)}`);
      setGraphTaxonomy(null);
    } finally {
      setGraphRebuilding(false);
    }
  }, [graphItems, graphRebuilding]);

  const viewCount = (id: KnowledgeView): number => {
    if (id === "fragments") return visibleFragments.length;
    if (id === "graph") return graphItems.length;
    return id === "review" ? drafts.length : confirmed.length;
  };

  if (isGlobalGraph) {
    return (
      <div className="kb kb-global-graph">
        <header className="kb-header">
          <div className="kb-title">
            <h1>全局知识图谱</h1>
            <p>这里不从单篇文献生成知识；这里只把所有文献中已经得到的知识碎片重构为全局分类图。</p>
          </div>
        </header>

        {error && <div className="kb-banner">{error}</div>}

        <KnowledgeGraph
          fragments={fragments}
          confirmed={globalConfirmed}
          taxonomy={graphTaxonomy}
          rebuilding={graphRebuilding}
          error={graphError}
          onRebuild={rebuildGraph}
        />
      </div>
    );
  }

  return (
    <div className="kb kb-paper-knowledge">
      <header className="kb-header">
        <div className="kb-title">
          <h1>单篇文献知识点</h1>
          <p>从当前文献的证据、问答链和标注中沉淀知识片段，并在这里审核为可检索知识点。</p>
        </div>
        <div className="kb-views">
          {PAPER_VIEW_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`kb-view-tab${view === id ? " active" : ""}`}
              onClick={() => setView(id)}
            >
              {VIEW_LABELS[id]}
              <span className="kb-count">{viewCount(id)}</span>
            </button>
          ))}
        </div>
      </header>

      {error && <div className="kb-banner">{error}</div>}

      <div className="kb-generator">
        <select
          value={selectedPaperValue}
          onChange={(event) => setSelectedPaper(event.target.value)}
          disabled={eligible.length === 0 || generating}
        >
          {eligible.length === 0 ? (
            <option value="">还没有带阅读记录的文献</option>
          ) : (
            <>
              <option value="">选择文献...</option>
              {eligible.map((paper) => (
                <option key={paper.id} value={paper.id}>{paper.title}</option>
              ))}
            </>
          )}
        </select>
        <button
          type="button"
          className="kb-primary"
          onClick={() => void onGenerate()}
          disabled={eligible.length === 0 || generating}
        >
          {generating ? "生成中..." : "生成知识点"}
        </button>
      </div>

      {view === "fragments" && <FragmentList fragments={visibleFragments} />}

      {view === "review" && (
        <section className="kb-review">
          {!loaded ? (
            <p className="kb-empty">加载中...</p>
          ) : drafts.length === 0 ? (
            <p className="kb-empty">
              暂无待审核知识点。可以从上方已阅读文献生成候选知识点。
            </p>
          ) : current ? (
            <ReviewCard
              key={current.id}
              point={current}
              index={safeIndex}
              total={drafts.length}
              onConfirm={handleConfirm}
              onReject={handleReject}
              onRefine={(patch) => void refine(current.id, patch)}
            />
          ) : null}
        </section>
      )}

      {view === "confirmed" && (
        <section className="kb-confirmed">
          <input
            type="search"
            className="kb-search"
            placeholder="搜索已确认知识点..."
            value={searchQuery}
            onChange={(event) => void search(event.target.value)}
          />
          {confirmedList.length === 0 ? (
            <p className="kb-empty">
              {searchQuery.trim()
                ? "没有匹配的已确认知识点。"
                : "还没有已确认知识点。请先在待审核中确认候选知识点。"}
            </p>
          ) : (
            <div className="kb-confirmed-list">
              {confirmedList.map((point) => (
                <ConfirmedCard key={point.id} point={point} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
