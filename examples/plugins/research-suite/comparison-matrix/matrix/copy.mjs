// Interface text and the prompts handed to the agent, in English, Chinese and Spanish.
const WHERE = "plugin @local/comparison-matrix, panel comparison-matrix, widget matrix";
// The composer takes at most 4000 characters, so the list of dimensions is kept short.
const listDims = (dims, none) => {
  const all = dims.map((d) => (d.hint ? `${d.name} (${d.hint})` : d.name)).join("; ");
  return !all ? none : all.length > 1200 ? `${all.slice(0, 1200)}…` : all;
};

const en = {
  title: "Comparison matrix",
  summary: (p, d) => `${p} ${p === 1 ? "paper" : "papers"} × ${d} ${d === 1 ? "dimension" : "dimensions"}`,
  updated: "Updated", fill: "Fill from the library", export: "Export as LaTeX table",
  exportPath: "File for the table, e.g. tables/comparison.tex", edit: "Edit dimensions", doneEdit: "Done",
  dims: "Dimensions", name: "Name", hint: "Hint (what to extract)", add: "Add dimension", addPlaceholder: "New dimension…",
  up: "Move earlier", down: "Move later", remove: "Delete", confirm: "Delete with its cells?",
  paper: "Paper", noEvidence: "no evidence", empty: "Empty",
  evidence: "Evidence", unsupported: "This value has no evidence yet: treat it as unverified.",
  emptyCell: "No value yet. Ask the agent to fill it from the library, or leave it empty.",
  openSource: "Open source", openPaper: "Open paper", close: "Close",
  select: "Select a cell to read its value and evidence.",
  coverage: "Coverage", coverageNote: "Papers with an evidenced value, per dimension. Thin columns are marked.",
  evidenced: (n, of) => `${n} of ${of} evidenced`, loose: (n) => `${n} without evidence`, gap: "Gap",
  failed: "Could not save: ",
  emptyTitle: "An empty matrix",
  emptyBody: "Rows are the papers of this project; columns are the dimensions you compare them on. Add the dimensions you care about, then ask the agent to fill every cell from the library, each with the file and page it comes from.",
  noPapers: "No papers yet. Fill from the library to add them as rows.",
  noDims: "No dimensions yet. Add one above to start comparing.",
  fillPrompt: (dims) => `Fill the comparison matrix of this project (${WHERE}). First read its current value with PluginPanel. Then go through the project's literature library and its PDFs and fill every empty cell as { "value", "evidence", "path" }: value is a short answer (a short categorical label when the dimension allows it), evidence names the file and page it comes from (e.g. "papers/file.pdf p.4"), path is that project-relative file. If a paper does not state it, leave the cell empty rather than guessing. If the papers list is empty, add the papers of the library as rows { "id", "title", "year", "path" }. Keep every dimension the user defined (id, name, hint and order) and every cell already filled. If there are no dimensions, propose 4 to 6 that fit the project's research question. Write the whole value back with PluginPanel write (it replaces the widget), keeping "version": 1 and setting "updatedAt".\nCurrent dimensions: ${listDims(dims, "none yet")}.`,
  exportPrompt: (path) => `Export the comparison matrix of this project (${WHERE}) as a LaTeX table. Read it with PluginPanel, then write a booktabs table (\\toprule, \\midrule, \\bottomrule, no vertical rules) to the file ${path || "[write the file path here]"}: one row per paper, one column per dimension in the matrix's order, each cell its value, empty cells as --. Cite each paper with \\cite{key} using the keys in the project's .bib files when the paper can be matched by title, year or DOI; keep the title for the ones you cannot match and tell me which they are. Mark values without evidence with a footnote symbol and a note under the table. Do not change the matrix itself.`,
};

const cn = {
  title: "文献对比矩阵",
  summary: (p, d) => `${p} 篇文献 × ${d} 个维度`,
  updated: "更新于", fill: "从文献库填充", export: "导出为 LaTeX 表格",
  exportPath: "表格文件，例如 tables/comparison.tex", edit: "编辑维度", doneEdit: "完成",
  dims: "维度", name: "名称", hint: "提示（要提取什么）", add: "添加维度", addPlaceholder: "新维度…",
  up: "前移", down: "后移", remove: "删除", confirm: "连同单元格删除？",
  paper: "文献", noEvidence: "无证据", empty: "空",
  evidence: "证据", unsupported: "这个值还没有证据，请视为未核实。",
  emptyCell: "还没有值。可以让 AI 从文献库填充，或保持为空。",
  openSource: "打开出处", openPaper: "打开文献", close: "关闭",
  select: "选择一个单元格，查看它的值和证据。",
  coverage: "覆盖情况", coverageNote: "每个维度中有证据支持的文献数；覆盖薄弱的维度会标出。",
  evidenced: (n, of) => `${n} / ${of} 有证据`, loose: (n) => `${n} 个无证据`, gap: "缺口",
  failed: "保存失败：",
  emptyTitle: "矩阵还是空的",
  emptyBody: "行是本项目的文献，列是你用来比较它们的维度。先添加你关心的维度，再让 AI 从文献库填满每个单元格，每个值都注明出自哪个文件、哪一页。",
  noPapers: "还没有文献。从文献库填充即可把它们加为行。",
  noDims: "还没有维度。在上方添加一个就可以开始比较。",
  fillPrompt: (dims) => `填充本项目的文献对比矩阵（${WHERE}）。先用 PluginPanel 读取它当前的值。然后阅读项目的文献库及其中的 PDF，把每个空单元格填成 { "value", "evidence", "path" }：value 是简短的回答（维度允许时用简短的类别标签），evidence 写明出处文件和页码（例如 "papers/file.pdf p.4"），path 是该文件相对项目的路径。文献中没有写明的，宁可留空也不要猜测。如果 papers 列表为空，把文献库中的文献加为行 { "id", "title", "year", "path" }。保留用户定义的每个维度（id、name、hint 和顺序）以及已填好的单元格。如果还没有维度，按本项目的研究问题提出 4 到 6 个。最后用 PluginPanel write 写回完整的值（它会替换整个组件），保持 "version": 1 并设置 "updatedAt"。\n当前维度：${listDims(dims, "暂无")}。`,
  exportPrompt: (path) => `把本项目的文献对比矩阵（${WHERE}）导出为 LaTeX 表格。先用 PluginPanel 读取它，然后把 booktabs 表格（\\toprule、\\midrule、\\bottomrule，不用竖线）写入文件 ${path || "[在此填写文件路径]"}：每篇文献一行，每个维度一列并按矩阵中的顺序，单元格为其值，空单元格写 --。能按标题、年份或 DOI 匹配到项目 .bib 文件中的条目时，用 \\cite{key} 引用该文献；匹配不到的保留标题，并告诉我是哪些。没有证据的值用脚注符号标出，并在表下说明。不要修改矩阵本身。`,
};

const es = {
  title: "Matriz comparativa",
  summary: (p, d) => `${p} ${p === 1 ? "artículo" : "artículos"} × ${d} ${d === 1 ? "dimensión" : "dimensiones"}`,
  updated: "Actualizada", fill: "Rellenar desde la biblioteca", export: "Exportar como tabla LaTeX",
  exportPath: "Archivo para la tabla, p. ej. tables/comparison.tex", edit: "Editar dimensiones", doneEdit: "Listo",
  dims: "Dimensiones", name: "Nombre", hint: "Pista (qué extraer)", add: "Añadir dimensión", addPlaceholder: "Nueva dimensión…",
  up: "Mover antes", down: "Mover después", remove: "Eliminar", confirm: "¿Eliminar con sus celdas?",
  paper: "Artículo", noEvidence: "sin evidencia", empty: "Vacía",
  evidence: "Evidencia", unsupported: "Este valor aún no tiene evidencia: trátalo como no verificado.",
  emptyCell: "Aún sin valor. Pide al agente que la rellene desde la biblioteca, o déjala vacía.",
  openSource: "Abrir fuente", openPaper: "Abrir artículo", close: "Cerrar",
  select: "Selecciona una celda para leer su valor y su evidencia.",
  coverage: "Cobertura", coverageNote: "Artículos con un valor respaldado por evidencia, por dimensión. Se marcan las columnas débiles.",
  evidenced: (n, of) => `${n} de ${of} con evidencia`, loose: (n) => `${n} sin evidencia`, gap: "Hueco",
  failed: "No se pudo guardar: ",
  emptyTitle: "Una matriz vacía",
  emptyBody: "Las filas son los artículos de este proyecto; las columnas, las dimensiones con que los comparas. Añade las dimensiones que te interesan y pide al agente que rellene cada celda desde la biblioteca, cada una con el archivo y la página de donde procede.",
  noPapers: "Aún no hay artículos. Rellena desde la biblioteca para añadirlos como filas.",
  noDims: "Aún no hay dimensiones. Añade una arriba para empezar a comparar.",
  fillPrompt: (dims) => `Rellena la matriz comparativa de este proyecto (${WHERE}). Primero lee su valor actual con PluginPanel. Después recorre la biblioteca de literatura del proyecto y sus PDF y rellena cada celda vacía como { "value", "evidence", "path" }: value es una respuesta breve (una etiqueta categórica corta cuando la dimensión lo permita), evidence indica el archivo y la página de donde procede (p. ej. "papers/file.pdf p.4") y path es ese archivo relativo al proyecto. Si un artículo no lo dice, deja la celda vacía en lugar de adivinar. Si la lista de artículos está vacía, añade los artículos de la biblioteca como filas { "id", "title", "year", "path" }. Conserva cada dimensión definida por el usuario (id, name, hint y orden) y cada celda ya rellenada. Si no hay dimensiones, propón de 4 a 6 que encajen con la pregunta de investigación del proyecto. Escribe el valor completo con PluginPanel write (reemplaza el widget), manteniendo "version": 1 y fijando "updatedAt".\nDimensiones actuales: ${listDims(dims, "ninguna todavía")}.`,
  exportPrompt: (path) => `Exporta la matriz comparativa de este proyecto (${WHERE}) como tabla LaTeX. Léela con PluginPanel y escribe una tabla booktabs (\\toprule, \\midrule, \\bottomrule, sin líneas verticales) en el archivo ${path || "[escribe aquí la ruta del archivo]"}: una fila por artículo, una columna por dimensión en el orden de la matriz, cada celda con su valor y las vacías como --. Cita cada artículo con \\cite{clave} usando las claves de los archivos .bib del proyecto cuando el artículo pueda emparejarse por título, año o DOI; conserva el título de los que no puedas emparejar y dime cuáles son. Marca los valores sin evidencia con un símbolo de nota y una nota bajo la tabla. No modifiques la matriz.`,
};

export const COPY = { en, cn, es };

/** The host's language code to one of ours: "es", "es-ES"… → es; "cn", "zh…" → cn; anything else → en. */
export function pickLanguage(language) {
  const code = String(language ?? "").toLowerCase();
  if (code.startsWith("es")) return "es";
  if (code === "cn" || code.startsWith("zh")) return "cn";
  return "en";
}
