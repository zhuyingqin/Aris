/**
 * A deliberately small, lossless TikZ previewer for the Visual editor.
 *
 * This is not a TeX engine. It renders the graph-shaped subset that appears
 * most often in research figures (`\node`, `\draw`/`\path`, named-node
 * positioning, coordinates, labels, arrows, and basic box/circle styles).
 * Unsupported TikZ remains editable in Code view instead of being silently
 * rewritten or presented as if the preview were a faithful TeX compilation.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const UNIT = 48;
const PADDING = 34;

type Point = { x: number; y: number };
type Shape = "rectangle" | "circle";

type PreviewNode = {
  id: string | null;
  label: string;
  point: Point;
  width: number;
  height: number;
  shape: Shape;
  rounded: boolean;
  fill: string;
  stroke: string;
  text: string;
};

type PreviewEdge = {
  points: Point[];
  arrow: boolean;
  dashed: boolean;
  stroke: string;
  label: string;
};

type TikzStatement = {
  kind: "node" | "draw" | "path";
  source: string;
};

const DEFAULT_STROKE = "var(--visual-accent-bright)";
const DEFAULT_FILL = "var(--visual-widget-bg)";
const DEFAULT_TEXT = "var(--visual-text)";

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    if ((char === "," || index === value.length) && braces === 0 && brackets === 0 && parens === 0) {
      const item = value.slice(start, index).trim();
      if (item) result.push(item);
      start = index + 1;
    }
  }
  return result;
}

function optionValue(options: string, key: string): string | null {
  const prefix = `${key}=`;
  const item = splitTopLevel(options).find((entry) => entry.trimStart().startsWith(prefix));
  return item ? item.trim().slice(prefix.length).trim() : null;
}

function dimension(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const match = /-?(?:\d+\.?\d*|\.\d+)/.exec(value);
  const number = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function color(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const base = value.trim().split("!")[0].toLowerCase();
  const colors: Record<string, string> = {
    primary: "var(--visual-accent-bright)",
    accent: "var(--visual-accent)",
    good: "var(--green)",
    warn: "var(--yellow)",
    bad: "var(--red)",
    muted: "var(--visual-muted)",
    white: "#ffffff",
    black: "#171b1d",
    red: "#c84b4b",
    blue: "#437ec5",
    green: "#4a9b65",
    orange: "#c67a24",
    purple: "#8664bc",
  };
  if (colors[base]) return colors[base];
  if (/^#[0-9a-f]{3,8}$/i.test(base)) return base;
  return fallback;
}

function groups(value: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "{") continue;
    const start = index + 1;
    let depth = 1;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] === "\\") {
        index += 1;
        continue;
      }
      if (value[index] === "{") depth += 1;
      else if (value[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          result.push(value.slice(start, index));
          break;
        }
      }
    }
  }
  return result;
}

function labelText(value: string): string {
  return value
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:color|textcolor)\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:small|tiny|footnotesize|scriptsize|Huge|huge|Large|LARGE)\b/g, "")
    .replace(/\$([^$]*)\$/g, "$1")
    .replace(/\\[A-Za-z@]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statements(source: string): TikzStatement[] {
  const result: TikzStatement[] = [];
  const command = /\\(node|draw|path)\b/g;
  let match: RegExpExecArray | null;
  while ((match = command.exec(source))) {
    let braces = 0;
    let brackets = 0;
    let parens = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "\\") {
        end += 1;
        continue;
      }
      if (char === "{") braces += 1;
      else if (char === "}") braces = Math.max(0, braces - 1);
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "(") parens += 1;
      else if (char === ")") parens = Math.max(0, parens - 1);
      else if (char === ";" && braces === 0 && brackets === 0 && parens === 0) break;
    }
    result.push({ kind: match[1] as TikzStatement["kind"], source: source.slice(match.index, Math.min(source.length, end + 1)) });
    command.lastIndex = Math.min(source.length, end + 1);
  }
  return result;
}

function nodeParts(source: string): { options: string; id: string | null; at: Point | null; label: string } {
  const optionMatch = /^\\node\s*(?:\[([^\]]*)\])?/.exec(source);
  const options = optionMatch?.[1] ?? "";
  const rest = source.slice(optionMatch?.[0].length ?? 0);
  const id = /^\s*\(\s*([A-Za-z][\w:.-]*)\s*\)/.exec(rest)?.[1] ?? null;
  const atMatch = /\bat\s*\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)/.exec(rest);
  const at = atMatch ? { x: Number(atMatch[1]), y: Number(atMatch[2]) } : null;
  const body = groups(source).at(-1) ?? "";
  return { options, id, at, label: labelText(body) };
}

function positionReference(options: string): { direction: string; distance: number; id: string } | null {
  const match = /\b(right|left|above|below)(?:\s*=\s*(?:(-?(?:\d+\.?\d*|\.\d+))\s*cm\s*)?of\s+([A-Za-z][\w:.-]*))/i.exec(options);
  if (!match) return null;
  return { direction: match[1].toLowerCase(), distance: match[2] ? Number(match[2]) : 2.2, id: match[3] };
}

function nodeStyle(options: string): Omit<PreviewNode, "id" | "label" | "point"> {
  const lower = options.toLowerCase();
  return {
    width: dimension(optionValue(options, "minimum width"), 2.2),
    height: dimension(optionValue(options, "minimum height"), 0.72),
    shape: lower.includes("circle") ? "circle" : "rectangle",
    rounded: lower.includes("rounded corners"),
    fill: color(optionValue(options, "fill"), DEFAULT_FILL),
    stroke: color(optionValue(options, "draw") ?? optionValue(options, "color"), DEFAULT_STROKE),
    text: color(optionValue(options, "text"), DEFAULT_TEXT),
  };
}

function resolveNodePositions(nodes: PreviewNode[], references: Array<ReturnType<typeof positionReference>>, nodeDistance: number) {
  for (let pass = 0; pass < nodes.length + 1; pass += 1) {
    let changed = false;
    for (let index = 0; index < nodes.length; index += 1) {
      const reference = references[index];
      if (!reference) continue;
      const target = nodes.find((node) => node.id === reference.id);
      if (!target) continue;
      const distance = (reference.distance || nodeDistance) * (reference.distance === 2.2 ? nodeDistance / 2.2 : 1);
      const next = { ...target.point };
      if (reference.direction === "right") next.x += target.width / 2 + nodes[index].width / 2 + distance;
      if (reference.direction === "left") next.x -= target.width / 2 + nodes[index].width / 2 + distance;
      if (reference.direction === "above") next.y += target.height / 2 + nodes[index].height / 2 + distance;
      if (reference.direction === "below") next.y -= target.height / 2 + nodes[index].height / 2 + distance;
      if (nodes[index].point.x !== next.x || nodes[index].point.y !== next.y) {
        nodes[index].point = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function edgePoints(source: string, nodeMap: Map<string, PreviewNode>): Point[] {
  const points: Point[] = [];
  const token = /\(\s*([^()]+?)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    const value = match[1].trim();
    const coordinate = /^(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))$/.exec(value);
    if (coordinate) {
      points.push({ x: Number(coordinate[1]), y: Number(coordinate[2]) });
      continue;
    }
    const id = value.split(".")[0].trim();
    const node = nodeMap.get(id);
    if (node) points.push(node.point);
  }
  return points;
}

function edgeStyle(source: string): Pick<PreviewEdge, "arrow" | "dashed" | "stroke" | "label"> {
  const options = /^\\(?:draw|path)\s*(?:\[([^\]]*)\])?/.exec(source)?.[1] ?? "";
  const lower = `${source}\n${options}`.toLowerCase();
  const hasCustomArrow = /(?:->|stealth|latex|arrow|\barr\b)/.test(lower);
  const edgeGroups = /\bnode\b/.test(lower) ? groups(source).at(-1) ?? "" : "";
  return {
    arrow: hasCustomArrow,
    dashed: lower.includes("dashed"),
    stroke: color(optionValue(options, "color") ?? optionValue(options, "draw"), DEFAULT_STROKE),
    label: labelText(edgeGroups),
  };
}

function setAttr(element: SVGElement, name: string, value: string | number) {
  element.setAttribute(name, String(value));
}

function svgText(text: string, x: number, y: number, className: string): SVGTextElement {
  const element = document.createElementNS(SVG_NS, "text");
  setAttr(element, "x", x);
  setAttr(element, "y", y);
  setAttr(element, "text-anchor", "middle");
  setAttr(element, "dominant-baseline", "middle");
  element.setAttribute("class", className);
  element.textContent = text;
  return element;
}

/** Render a best-effort SVG preview, or null when the source has no graph data. */
export function renderTikzPreview(source: string): SVGSVGElement | null {
  if (typeof document === "undefined") return null;
  const parsed = statements(source);
  const nodeStatements = parsed.filter((statement) => statement.kind === "node");
  const nodes: PreviewNode[] = [];
  const references: Array<ReturnType<typeof positionReference>> = [];
  const nodeDistance = dimension(/node distance\s*=\s*([^,\]]+)/i.exec(source)?.[1] ?? null, 2.2);

  for (const [index, statement] of nodeStatements.entries()) {
    const parts = nodeParts(statement.source);
    const style = nodeStyle(parts.options);
    nodes.push({
      ...style,
      id: parts.id,
      label: parts.label,
      point: parts.at ?? { x: index * nodeDistance, y: 0 },
    });
    references.push(parts.at ? null : positionReference(parts.options));
  }

  resolveNodePositions(nodes, references, nodeDistance);
  const nodeMap = new Map(nodes.filter((node) => node.id).map((node) => [node.id!, node]));
  const edges: PreviewEdge[] = parsed
    .filter((statement) => statement.kind === "draw" || statement.kind === "path")
    .map((statement) => ({ points: edgePoints(statement.source, nodeMap), ...edgeStyle(statement.source) }))
    .filter((edge) => edge.points.length >= 2);

  if (nodes.length === 0 && edges.length === 0) return null;
  const allPoints = [
    ...nodes.flatMap((node) => [
      { x: node.point.x - node.width / 2, y: node.point.y - node.height / 2 },
      { x: node.point.x + node.width / 2, y: node.point.y + node.height / 2 },
    ]),
    ...edges.flatMap((edge) => edge.points),
  ];
  const minX = Math.min(...allPoints.map((point) => point.x));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const minY = Math.min(...allPoints.map((point) => point.y));
  const maxY = Math.max(...allPoints.map((point) => point.y));
  const width = Math.max(260, (maxX - minX) * UNIT + PADDING * 2);
  const height = Math.max(110, (maxY - minY) * UNIT + PADDING * 2);
  const pointToSvg = (point: Point) => ({
    x: (point.x - minX) * UNIT + PADDING,
    y: (maxY - point.y) * UNIT + PADDING,
  });

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "cm-vis-diagram-preview");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "TikZ diagram preview");
  setAttr(svg, "viewBox", `0 0 ${width} ${height}`);
  setAttr(svg, "width", width);
  setAttr(svg, "height", height);

  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "cm-vis-tikz-arrow");
  setAttr(marker, "markerWidth", 8);
  setAttr(marker, "markerHeight", 8);
  setAttr(marker, "refX", 7);
  setAttr(marker, "refY", 4);
  setAttr(marker, "orient", "auto");
  const arrow = document.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M0,0 L8,4 L0,8 Z");
  arrow.setAttribute("fill", DEFAULT_STROKE);
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);

  for (const edge of edges) {
    const path = document.createElementNS(SVG_NS, "polyline");
    const coordinates = edge.points.map(pointToSvg).map((point) => `${point.x},${point.y}`).join(" ");
    setAttr(path, "points", coordinates);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", edge.stroke);
    setAttr(path, "stroke-width", 1.7);
    if (edge.dashed) path.setAttribute("stroke-dasharray", "6 4");
    if (edge.arrow) path.setAttribute("marker-end", "url(#cm-vis-tikz-arrow)");
    svg.append(path);
    if (edge.label) {
      const middle = pointToSvg(edge.points[Math.floor(edge.points.length / 2)]);
      svg.append(svgText(edge.label, middle.x, middle.y - 10, "cm-vis-diagram-edge-label"));
    }
  }

  for (const node of nodes) {
    const center = pointToSvg(node.point);
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "cm-vis-diagram-node");
    if (node.shape === "circle") {
      const circle = document.createElementNS(SVG_NS, "circle");
      setAttr(circle, "cx", center.x);
      setAttr(circle, "cy", center.y);
      setAttr(circle, "r", Math.max(node.width, node.height) * UNIT / 2);
      circle.setAttribute("fill", node.fill);
      circle.setAttribute("stroke", node.stroke);
      setAttr(circle, "stroke-width", 1.7);
      group.append(circle);
    } else {
      const rectangle = document.createElementNS(SVG_NS, "rect");
      setAttr(rectangle, "x", center.x - node.width * UNIT / 2);
      setAttr(rectangle, "y", center.y - node.height * UNIT / 2);
      setAttr(rectangle, "width", node.width * UNIT);
      setAttr(rectangle, "height", node.height * UNIT);
      setAttr(rectangle, "rx", node.rounded ? 8 : 3);
      rectangle.setAttribute("fill", node.fill);
      rectangle.setAttribute("stroke", node.stroke);
      setAttr(rectangle, "stroke-width", 1.7);
      group.append(rectangle);
    }
    const text = svgText(node.label || node.id || "", center.x, center.y, "cm-vis-diagram-node-label");
    text.setAttribute("fill", node.text);
    group.append(text);
    svg.append(group);
  }

  return svg;
}
