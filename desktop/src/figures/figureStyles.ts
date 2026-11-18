import { tr, type Language } from "../language";
/** Scientific content and visual appearance are separate. The compiled contract
 * travels through the existing style string API and is frozen with each run. */
export type Copy = [cn: string, en: string, es: string];
/** The copy for `language` from a [cn, en, es] tuple. */
export const pickCopy = (copy: Copy, language: Language) => tr(language, copy[0], copy[1], copy[2]);
export type StyleFamily = "schematic" | "theory" | "panels" | "tensors" | "narrative" | "illustration";
export type StyleLayout = "auto" | "horizontal" | "vertical";
export type StylePalette = "muted" | "vivid" | "mono";
export type StyleDensity = "balanced" | "compact" | "spacious";
export interface FigureStyleSpec {
  family: StyleFamily;
  layout: StyleLayout;
  palette: StylePalette;
  density: StyleDensity;
  print: boolean;
}
interface Family {
  key: StyleFamily;
  label: Copy;
  summary: Copy;
  use: Copy;
  rules: string;
}

// These are SomniQ's visual families, not venue standards or paper authors' presets.
export const STYLE_FAMILIES: Family[] = [
  { key: "schematic", label: ["技术框图", "Technical schematic", "Esquema técnico"], summary: ["语义形状 · 输入输出端口", "Semantic shapes · ports", "Formas semánticas · puertos"],
    use: ["适合算法、系统架构与训练流程；数据、运算和判断使用不同形状。", "For algorithms, architectures and training; distinguish data, operations and decisions by shape.", "Para algoritmos, arquitecturas y entrenamiento; distingue datos, operaciones y decisiones por su forma."],
    rules: "Geometry: flat data sheets/stacks, rectangular process blocks with ports, diamonds only for stated decisions/comparisons. Uniform fine outlines, no shadows. Hierarchy: aligned primary blocks, small secondary annotations. Connectors: short orthogonal routes and consistent arrowheads." },
  { key: "theory", label: ["抽象关系图", "Abstract graph", "Grafo abstracto"], summary: ["节点算子 · 开放连线", "Nodes/operators · open edges", "Nodos/operadores · aristas abiertas"],
    use: ["适合理论关系、状态转移与算子流程；用节点和边表达关系。", "For theoretical relations, state transitions and operators; communicate through nodes and edges.", "Para relaciones teóricas, transiciones de estado y operadores; comunica mediante nodos y aristas."],
    rules: "Geometry: open circles or compact operator vertices, plain edges, no pictograms or enclosing cards. Use diamonds only when semantically justified. Hierarchy: primary vertices versus fine annotations in open whitespace. Connectors: direct edges; deliberate bends only to prevent crossings." },
  { key: "panels", label: ["模块分区", "Modular panels", "Paneles modulares"], summary: ["层级容器 · 阶段分组", "Nested groups · stages", "Grupos anidados · etapas"],
    use: ["适合多阶段方法与复杂模块；先看整体，再看组内关系。", "For multi-stage methods and complex modules; reveal the whole before relationships within groups.", "Para métodos de varias etapas y módulos complejos; muestra el conjunto antes que las relaciones dentro de cada grupo."],
    rules: "Geometry: rounded modules within lightly filled parent panels; distinct parent/child boundaries. Hierarchy: group only relationships supported by requirements; overview/detail callouts only if justified. Align repeated modules. Connectors: route between named groups without obscuring internal paths." },
  { key: "tensors", label: ["张量与空间", "Tensor & spatial", "Tensores y espacio"], summary: ["层叠矩阵 · 等轴几何", "Matrix stacks · isometric forms", "Pilas de matrices · formas isométricas"],
    use: ["适合特征图、张量与空间处理；层叠、切面和透视展示结构。", "For feature maps, tensors and spatial processing; use stacks, cutaways and perspective to expose structure.", "Para mapas de características, tensores y procesamiento espacial; usa pilas, cortes y perspectiva para mostrar la estructura."],
    rules: "Geometry: stacked planes, gridded matrices and shallow isometric volumes where supported; one projection and consistent depth. No invented tensor dimensions or layers. Hierarchy: dominant data objects, small operation marks. Labels stay horizontal, never in perspective. Connectors: separate visible arrows from object edges." },
  { key: "narrative", label: ["图标叙事", "Pictogram narrative", "Narrativa con pictogramas"], summary: ["语义图标 · 阅读路径", "Semantic icons · reading path", "Iconos semánticos · ruta de lectura"],
    use: ["适合智能体与工具工作流；通过文档、计算和输出图标快速识别角色。", "For agent and tool workflows; document, computation and output icons make roles recognizable.", "Para flujos de agentes y herramientas; los iconos de documentos, cálculo y salidas hacen reconocibles los roles."],
    rules: "Geometry: coherent line-and-fill semantic pictograms with labels below, not generic rectangles around every object. Consistent icon detail, scale and stroke. Hierarchy: main roles form a clear reading path with subordinate annotations. No mascots or brand marks. Connectors: simple directed paths around icons." },
  { key: "illustration", label: ["科学图解", "Scientific illustration", "Ilustración científica"], summary: ["对象剖面 · 引线注释", "Object cutaways · leader labels", "Cortes de objetos · etiquetas con líneas guía"],
    use: ["适合机制解释与图形摘要；用对象内部结构和引线解释过程。", "For mechanisms and graphical abstracts; explain processes through object detail and leader labels.", "Para mecanismos y resúmenes gráficos; explica los procesos con el detalle de los objetos y etiquetas con líneas guía."],
    rules: "Geometry: vector-friendly contour illustrations, selective cutaways and translucent flat layers when supported. No invented anatomy, mechanisms or physical structure. Avoid generic cards and photorealistic textures. Hierarchy: dominant object silhouettes, restrained internal detail. Use leader labels; distinguish leaders from directed process arrows." },
];

export const STYLE_LAYOUTS: { key: StyleLayout; label: Copy; rule: string }[] = [
  { key: "auto", label: ["跟随内容", "Follow content", "Según el contenido"], rule: "Layout: follow explicitly requested positions/directions; otherwise choose a clear reading path from the content." },
  { key: "horizontal", label: ["优先横向", "Prefer horizontal", "Preferir horizontal"], rule: "Layout: prefer left-to-right flow unless requirements specify otherwise; route existing feedback separately, never add stages." },
  { key: "vertical", label: ["优先纵向", "Prefer vertical", "Preferir vertical"], rule: "Layout: prefer top-to-bottom flow unless requirements specify otherwise; route existing feedback separately, never add stages." },
];
export const STYLE_PALETTES: { key: StylePalette; label: Copy; rule: string }[] = [
  { key: "muted", label: ["克制配色", "Muted colors", "Colores sobrios"], rule: "Palette: restrained indigo #4F46E5, teal #0F766E, amber #B45309 and neutral #334155; light fills, dark labels; stable role colors." },
  { key: "vivid", label: ["鲜明配色", "Vivid colors", "Colores vivos"], rule: "Palette: clear blue #0072B2, orange #D55E00, teal #009E73 and neutral #334155; stable role colors, dark text on light fills." },
  { key: "mono", label: ["黑白灰", "Grayscale", "Escala de grises"], rule: "Palette: black/gray strokes on white; distinguish roles with geometry, dash patterns and labels instead of color." },
];
export const STYLE_DENSITIES: { key: StyleDensity; label: Copy; rule: string }[] = [
  { key: "balanced", label: ["均衡", "Balanced", "Equilibrado"], rule: "Spacing: balanced padding and repeated gaps on a common alignment grid." },
  { key: "compact", label: ["紧凑", "Compact", "Compacto"], rule: "Spacing: reduce unused gaps, never shrink required text, merge distinct nodes or obscure arrows." },
  { key: "spacious", label: ["宽松", "Spacious", "Amplio"], rule: "Spacing: generous padding and gaps; avoid scattered disconnected islands." },
];
export const DEFAULT_STYLE_SPEC: FigureStyleSpec = { family: "schematic", layout: "auto", palette: "muted", density: "balanced", print: false };
const PREFIX = "SomniQ style v1: ";

/** Keep the complete human-readable rules, not just IDs: native runs and model
 * logs remain interpretable without the frontend catalog. Native limit: 2000 bytes. */
export function compileFigureStyle(spec: FigureStyleSpec): string {
  const family = STYLE_FAMILIES.find((item) => item.key === spec.family)!;
  return [
    `${PREFIX}family=${spec.family}; layout=${spec.layout}; palette=${spec.palette}; density=${spec.density}; print=${spec.print ? "on" : "off"}`,
    `Visual family: ${family.label[1]}. ${family.rules}`,
    STYLE_LAYOUTS.find((item) => item.key === spec.layout)!.rule,
    STYLE_PALETTES.find((item) => item.key === spec.palette)!.rule,
    STYLE_DENSITIES.find((item) => item.key === spec.density)!.rule,
    "Typography: one readable sans-serif label family; serif math only for supplied notation; consistent sizes for primary/secondary labels. Uniform strokes and arrowheads; never use color alone to encode meaning.",
    spec.print ? "Print: white background, dark text, stronger strokes; preserve hierarchy in grayscale and at small size without tiny details." : "Screen: white background, crisp strokes and clear label contrast.",
    "Priority: explicit scientific requirements override visual preferences. Preserve labels, relations and arrow directions; never invent data or claims. For reconstruction or later edits, the approved image/current document is authoritative; do not restyle unaffected content.",
  ].join("\n");
}

export const LEGACY_STYLES = [
  { value: "Clean academic diagram, flat vectors, readable labels, restrained colors", label: ["学术扁平", "Academic", "Académico"] as Copy, spec: { ...DEFAULT_STYLE_SPEC } },
  { value: "Minimal line diagram, monochrome strokes, generous whitespace, sans-serif labels", label: ["极简线框", "Minimal", "Minimalista"] as Copy, spec: { ...DEFAULT_STYLE_SPEC, family: "theory", palette: "mono", density: "spacious" } as FigureStyleSpec },
  { value: "Soft pastel grouped panels, rounded modules, clear arrows, consistent spacing", label: ["柔和分区", "Soft panels", "Paneles suaves"] as Copy, spec: { ...DEFAULT_STYLE_SPEC, family: "panels" } as FigureStyleSpec },
  { value: "High-contrast print-safe diagram, bold outlines, colorblind-safe palette", label: ["印刷高对比", "Print", "Impresión"] as Copy, spec: { ...DEFAULT_STYLE_SPEC, print: true } },
];

/** Unknown free text and future versions remain custom; opening old runs never
 * rewrites them. Only an explicit selection compiles a new contract. */
export function parseFigureStyle(value: string): FigureStyleSpec | null {
  const legacy = LEGACY_STYLES.find((item) => item.value === value);
  if (legacy) return { ...legacy.spec };
  const match = value.split(/\r?\n/, 1)[0].match(/^SomniQ style v1: family=(\w+); layout=(\w+); palette=(\w+); density=(\w+); print=(on|off)$/);
  if (!match || !STYLE_FAMILIES.some((item) => item.key === match[1]) || !STYLE_LAYOUTS.some((item) => item.key === match[2])
    || !STYLE_PALETTES.some((item) => item.key === match[3]) || !STYLE_DENSITIES.some((item) => item.key === match[4])) return null;
  return { family: match[1] as StyleFamily, layout: match[2] as StyleLayout, palette: match[3] as StylePalette, density: match[4] as StyleDensity, print: match[5] === "on" };
}

export function styleLabel(value: string, language: Language): string {
  const legacy = LEGACY_STYLES.find((item) => item.value === value);
  if (legacy) return pickCopy(legacy.label, language);
  const spec = parseFigureStyle(value);
  if (!spec) return value;
  const family = STYLE_FAMILIES.find((item) => item.key === spec.family)!;
  return [pickCopy(family.label, language), pickCopy(STYLE_PALETTES.find((item) => item.key === spec.palette)!.label, language),
    ...(spec.print ? [tr(language, "印刷适配", "Print-ready", "Apto para impresión")] : [])].join(" · ");
}

export const STYLE_PRESETS = STYLE_FAMILIES.map((family) => ({ ...family, value: compileFigureStyle({ ...DEFAULT_STYLE_SPEC, family: family.key }) }));
