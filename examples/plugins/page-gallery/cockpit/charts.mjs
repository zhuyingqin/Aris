// A tiny SVG chart kit, shipped with the package and imported as a module:
//   import { ring, area } from "pkg:cockpit/charts.mjs";
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** A progress ring: `value` from 0 to 1, drawn with an animated sweep. */
export function ring(value, { size = 132, stroke = 11, color = "currentColor" } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value || 0));
  const root = svg("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: "ring" });
  root.append(svg("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "currentColor", "stroke-opacity": 0.12, "stroke-width": stroke }));
  const arc = svg("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: color, "stroke-width": stroke, "stroke-linecap": "round",
    "stroke-dasharray": c, "stroke-dashoffset": c, transform: `rotate(-90 ${size / 2} ${size / 2})` });
  arc.style.transition = "stroke-dashoffset 900ms cubic-bezier(.2,.8,.2,1)";
  root.append(arc);
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", c * (1 - v))));
  return root;
}

/** An area chart of one or more series sharing an x axis. */
export function area(series, { width = 720, height = 240, pad = 28, colors = [] } = {}) {
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "area", preserveAspectRatio: "none" });
  if (!all.length) return root;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => pad + (i / Math.max(1, n - 1)) * (width - pad * 2);
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);
  for (let i = 0; i <= 4; i++) {
    const gy = pad + (i / 4) * (height - pad * 2);
    root.append(svg("line", { x1: pad, x2: width - pad, y1: gy, y2: gy, stroke: "currentColor", "stroke-opacity": 0.08 }));
  }
  series.forEach((s, index) => {
    const color = colors[index % colors.length] || "currentColor";
    const id = `fade${index}`;
    const gradient = svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.35 }), svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
    const defs = svg("defs"); defs.append(gradient); root.append(defs);
    const points = s.values.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null)).filter(Boolean);
    if (points.length < 2) return;
    const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    root.append(svg("path", { d: `${line} L${points.at(-1)[0]},${height - pad} L${points[0][0]},${height - pad} Z`, fill: `url(#${id})` }));
    root.append(svg("path", { d: line, fill: "none", stroke: color, "stroke-width": 2.4, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
    const [lx, ly] = points.at(-1);
    root.append(svg("circle", { cx: lx, cy: ly, r: 4.5, fill: color }));
  });
  return root;
}
