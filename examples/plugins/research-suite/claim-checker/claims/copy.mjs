// Every word the page shows, and the prompts it hands to the agent, in the
// three interface languages. Prompts are written in the reader's language.
const PLUGIN = "@local/claim-checker";
const PANEL = "checker";
const where = (claim) => claim.file ? (claim.line ? `${claim.file}:${claim.line}` : claim.file) : "";
const clip = (text, max) => text.length > max ? text.slice(0, max - 1) + "…" : text;
/** The tag a task title carries, so a task can be found again from its claim. */
export const marker = (id) => `[${clip(String(id), 24)}]`;

export const COPY = {
  en: {
    title: "Claim checker",
    lede: "Every cited sentence of the manuscript, set like a galley proof. Send each one to be checked against the source it cites.",
    manuscript: "Manuscript", extracted: "extracted",
    extract: "Extract claims from the manuscript", summarize: "Summary",
    all: "All", verdicts: { supported: "Supported", partial: "Partial", unsupported: "Unsupported", "no-source": "No source", unchecked: "Unchecked" },
    checked: (done, total) => `${done} of ${total} checked`,
    open: "Open at this line", page: "p.", note: "Note", source: "Source", checkedAt: "checked",
    investigate: "Investigate in the background", again: "Check again", asking: "Waiting for your answer…",
    states: { todo: "On the task board", active: "Investigating", waiting: "Needs attention", ready: "Ready to accept", done: "Task done", failed: "Task failed", canceled: "Task canceled", gone: "Task deleted", unknown: "Task on the board", declined: "Proposal declined" },
    review: "Reviewer", result: "Task summary", files: "files changed",
    busy: "Another task proposal is still waiting for your answer. Decide on that one first.",
    lost: "The task started, but its id could not be saved on this claim:",
    deskNotes: "Desk notes", noSummary: "No summary yet. Press “Summary” and the agent writes here which claims need fixing.",
    emptyTitle: "No claims on the desk yet",
    empty: "Press “Extract claims from the manuscript”. The agent finds the project's main manuscript, collects every sentence that carries a citation and lists them here. Then send each sentence to be checked against its source.",
    noMatch: "No claim has this verdict.",
    unknownFile: "(no file)",
    extractPrompt: [
      `Find this project's main manuscript (the .tex or .md file that holds the body of the text; follow \\input, \\include and similar to the files it pulls in).`,
      `Extract every sentence that carries a citation (\\cite, \\citep, \\citet, \\parencite, \\autocite, [@key] and similar) and write them with the PluginPanel tool into widget claims of panel ${PANEL} of plugin ${PLUGIN}.`,
      `Read the widget's current value first. The value is {"version": 1, "manuscript": "<project-relative path of the main file>", "extractedAt": "<ISO time>", "claims": [...]}, each claim {"id", "text", "file", "line", "section", "cites": [bib keys]}: text is the sentence as written, with citation commands removed; file is project-relative; section is the heading it falls under.`,
      `For every sentence whose text and cite keys are unchanged, keep its existing entry as it is (id, verdict, quote, page, note, source, taskId, checkedAt). Give new sentences new ids that never reuse an old one. Drop sentences that are no longer in the manuscript.`,
      `If the cited paper is in the project's literature library, set source to the project-relative path of its PDF. Do not change any project file, and write only what the manuscript contains.`,
    ].join("\n"),
    summaryPrompt: [
      `With the PluginPanel tool, read widget claims of panel ${PANEL} of plugin ${PLUGIN}, then write a Markdown report into widget summary of the same panel.`,
      `Start with the count of claims per verdict. Then list the claims to fix: unsupported first, then partial, then no-source. For each give its location (file:line), the sentence, what the source actually says (quote and page) and a suggested fix (narrow the wording, cite another source, or remove the claim). End with the claims not checked yet.`,
      `Base the report only on the stored verdicts and quotes; do not change any project file.`,
    ].join("\n"),
    taskTitle: (claim) => clip(`Check claim ${marker(claim.id)}: ${claim.text}`, 110),
    taskPrompt: (claim) => [
      `Check whether one cited sentence of this project's manuscript is supported by the source it cites.`,
      `Claim id: ${claim.id}`,
      `Sentence: "${clip(claim.text, 1500)}"`,
      where(claim) ? `Location: ${where(claim)}` : "",
      `Cited bib keys: ${claim.cites.length ? claim.cites.join(", ") : "(none recorded)"}`,
      claim.source ? `Source found earlier: ${claim.source}` : "",
      ``,
      `1. Find each cited source: look the bib key up in the project's bibliography (.bib) and find the matching paper in the project's literature library (its PDF or full text).${claim.source ? " Start with the source found earlier." : ""}`,
      `2. Read the relevant part of the source and decide one verdict: supported (the source states this), partial (it supports only part of the sentence, or a weaker or narrower version), unsupported (it does not say this, or says otherwise), no-source (the source could not be found or read in the project).`,
      `3. Copy the passage that decides it word for word (at most three sentences) and its page number.`,
      `Change no project file: not the manuscript, the bibliography or the library.`,
      ``,
      `Report: with the PluginPanel tool, read widget claims of panel ${PANEL} of plugin ${PLUGIN}. Change only the entry whose id is "${claim.id}": set verdict, quote, page, note (one or two sentences on why, naming which key you checked), source (project-relative path of the file you read) and checkedAt (ISO time). Keep every other field and every other entry exactly as you read them, and write the whole value back. If the entry is gone, do not recreate it; say so in your final message.`,
    ].filter((line) => line !== "").join("\n"),
  },

  cn: {
    title: "论断核查",
    lede: "稿件里每一句带引用的话，排成校样。把每一句派去和它引用的文献逐一对照。",
    manuscript: "稿件", extracted: "提取于",
    extract: "从稿件提取论断", summarize: "汇总",
    all: "全部", verdicts: { supported: "有支撑", partial: "部分支撑", unsupported: "无支撑", "no-source": "找不到来源", unchecked: "未核查" },
    checked: (done, total) => `已核查 ${done} / ${total}`,
    open: "打开到这一行", page: "第", note: "说明", source: "来源", checkedAt: "核查于",
    investigate: "派到后台核查", again: "重新核查", asking: "等你确认…",
    states: { todo: "已在任务看板", active: "核查中", waiting: "需要处理", ready: "待验收", done: "任务完成", failed: "任务失败", canceled: "任务已取消", gone: "任务已删除", unknown: "任务在看板上", declined: "已拒绝提议" },
    review: "审查", result: "任务总结", files: "个文件有改动",
    busy: "还有一个任务提议在等你确认，请先处理那一个。",
    lost: "任务已启动，但没能把任务编号存到这条论断上：",
    deskNotes: "核查札记", noSummary: "还没有汇总。点“汇总”，AI 会在这里写出哪些论断需要修改。",
    emptyTitle: "案头还没有论断",
    empty: "点“从稿件提取论断”。AI 会找到项目的主稿件，收集每一句带引用的话列在这里；之后可以把每一句派去和来源对照。",
    noMatch: "没有这个结论的论断。",
    unknownFile: "（无文件）",
    extractPrompt: [
      `找到本项目的主稿件（正文所在的 .tex 或 .md 文件；顺着 \\input、\\include 等找到它引入的文件）。`,
      `提取其中每一句带引用的句子（\\cite、\\citep、\\citet、\\parencite、\\autocite、[@key] 等），用 PluginPanel 工具写入插件 ${PLUGIN} 面板 ${PANEL} 的组件 claims。`,
      `先读取该组件的当前值。值的形状是 {"version": 1, "manuscript": "<主文件的项目相对路径>", "extractedAt": "<ISO 时间>", "claims": [...]}，每条为 {"id", "text", "file", "line", "section", "cites": [bib 键]}：text 是原句（去掉引用命令），file 用项目相对路径，section 是所在小节标题。`,
      `原文和引用键都没变的句子，原样保留已有条目（id、verdict、quote、page、note、source、taskId、checkedAt）。新句子用新 id，不得复用旧 id。稿件里已经不存在的句子删掉。`,
      `如果被引文献在项目的文献库里，把 source 设为其 PDF 的项目相对路径。不要修改任何项目文件，只写稿件里真实存在的内容。`,
    ].join("\n"),
    summaryPrompt: [
      `用 PluginPanel 工具读取插件 ${PLUGIN} 面板 ${PANEL} 的组件 claims，然后把一份 Markdown 报告写入同一面板的组件 summary。`,
      `先写各结论的数量；再列出需要修改的论断：先无支撑，再部分支撑，再找不到来源。每条写明位置（文件:行）、原句、来源实际怎么说（引文和页码），以及修改建议（收窄措辞、改引其他文献或删去）。最后列出尚未核查的论断。`,
      `只依据已存的结论和引文，不要修改任何项目文件。`,
    ].join("\n"),
    taskTitle: (claim) => clip(`核查论断 ${marker(claim.id)}：${claim.text}`, 80),
    taskPrompt: (claim) => [
      `核查本项目稿件中的一句引用句是否得到其所引文献的支撑。`,
      `论断 id：${claim.id}`,
      `原句：「${clip(claim.text, 1500)}」`,
      where(claim) ? `位置：${where(claim)}` : "",
      `引用的 bib 键：${claim.cites.length ? claim.cites.join("、") : "（未记录）"}`,
      claim.source ? `此前找到的来源：${claim.source}` : "",
      ``,
      `1. 找到每篇被引文献：在项目的参考文献（.bib）中查这个键，再在项目的文献库中找到对应论文（PDF 或全文）。${claim.source ? "先看此前找到的来源。" : ""}`,
      `2. 阅读文献的相关部分，给出一个结论：supported（文献明确这样说）、partial（只支撑一部分，或只支撑更弱、更窄的说法）、unsupported（文献没这样说，或说法相反）、no-source（在项目里找不到或读不了该文献）。`,
      `3. 逐字摘录决定结论的那段原文（最多三句）及其页码。`,
      `不要修改任何项目文件：稿件、参考文献和文献库都不动。`,
      ``,
      `写回：用 PluginPanel 工具读取插件 ${PLUGIN} 面板 ${PANEL} 的组件 claims，只修改 id 为 "${claim.id}" 的那一条：设置 verdict、quote、page、note（一两句说明理由，并写明核查的是哪个键）、source（所读文件的项目相对路径）和 checkedAt（ISO 时间）。其他字段和其他条目一律按读到的原样保留，再把整个值写回。如果这一条已经不在了，不要重建，在最后的回复里说明。`,
    ].filter((line) => line !== "").join("\n"),
  },

  es: {
    title: "Verificador de afirmaciones",
    lede: "Cada frase citada del manuscrito, compuesta como una galerada. Envía cada una a contrastar con la fuente que cita.",
    manuscript: "Manuscrito", extracted: "extraído",
    extract: "Extraer afirmaciones del manuscrito", summarize: "Resumen",
    all: "Todas", verdicts: { supported: "Respaldada", partial: "Parcial", unsupported: "Sin respaldo", "no-source": "Sin fuente", unchecked: "Sin verificar" },
    checked: (done, total) => `${done} de ${total} verificadas`,
    open: "Abrir en esta línea", page: "p.", note: "Nota", source: "Fuente", checkedAt: "verificada",
    investigate: "Investigar en segundo plano", again: "Verificar de nuevo", asking: "Esperando tu respuesta…",
    states: { todo: "En el tablero de tareas", active: "Investigando", waiting: "Requiere atención", ready: "Lista para aceptar", done: "Tarea terminada", failed: "La tarea falló", canceled: "Tarea cancelada", gone: "Tarea eliminada", unknown: "Tarea en el tablero", declined: "Propuesta rechazada" },
    review: "Revisor", result: "Resumen de la tarea", files: "archivos cambiados",
    busy: "Otra propuesta de tarea sigue esperando tu respuesta. Decide primero sobre esa.",
    lost: "La tarea empezó, pero no se pudo guardar su id en esta afirmación:",
    deskNotes: "Notas de la mesa", noSummary: "Aún no hay resumen. Pulsa «Resumen» y el agente escribirá aquí qué afirmaciones hay que corregir.",
    emptyTitle: "Aún no hay afirmaciones en la mesa",
    empty: "Pulsa «Extraer afirmaciones del manuscrito». El agente busca el manuscrito principal del proyecto, reúne cada frase que lleva una cita y las lista aquí. Después envía cada frase a contrastar con su fuente.",
    noMatch: "Ninguna afirmación tiene este veredicto.",
    unknownFile: "(sin archivo)",
    extractPrompt: [
      `Busca el manuscrito principal de este proyecto (el archivo .tex o .md con el cuerpo del texto; sigue \\input, \\include y similares hasta los archivos que incluye).`,
      `Extrae cada frase que lleve una cita (\\cite, \\citep, \\citet, \\parencite, \\autocite, [@clave] y similares) y escríbelas con la herramienta PluginPanel en el widget claims del panel ${PANEL} del plugin ${PLUGIN}.`,
      `Lee primero el valor actual del widget. El valor es {"version": 1, "manuscript": "<ruta del archivo principal relativa al proyecto>", "extractedAt": "<hora ISO>", "claims": [...]}, cada afirmación {"id", "text", "file", "line", "section", "cites": [claves bib]}: text es la frase tal como está escrita, sin los comandos de cita; file es relativa al proyecto; section es el título bajo el que aparece.`,
      `Para cada frase cuyo texto y claves no hayan cambiado, conserva su entrada tal cual (id, verdict, quote, page, note, source, taskId, checkedAt). Da a las frases nuevas ids nuevos que nunca reutilicen uno antiguo. Elimina las frases que ya no están en el manuscrito.`,
      `Si el artículo citado está en la biblioteca de literatura del proyecto, pon en source la ruta de su PDF relativa al proyecto. No cambies ningún archivo del proyecto y escribe solo lo que contiene el manuscrito.`,
    ].join("\n"),
    summaryPrompt: [
      `Con la herramienta PluginPanel, lee el widget claims del panel ${PANEL} del plugin ${PLUGIN} y escribe un informe en Markdown en el widget summary del mismo panel.`,
      `Empieza con el número de afirmaciones por veredicto. Luego lista las que hay que corregir: primero las sin respaldo, luego las parciales, luego las sin fuente. Para cada una indica su ubicación (archivo:línea), la frase, lo que dice realmente la fuente (cita y página) y una corrección sugerida (acotar la redacción, citar otra fuente o eliminarla). Termina con las afirmaciones aún sin verificar.`,
      `Básate solo en los veredictos y citas guardados; no cambies ningún archivo del proyecto.`,
    ].join("\n"),
    taskTitle: (claim) => clip(`Verificar afirmación ${marker(claim.id)}: ${claim.text}`, 110),
    taskPrompt: (claim) => [
      `Comprueba si una frase citada del manuscrito de este proyecto está respaldada por la fuente que cita.`,
      `Id de la afirmación: ${claim.id}`,
      `Frase: «${clip(claim.text, 1500)}»`,
      where(claim) ? `Ubicación: ${where(claim)}` : "",
      `Claves bib citadas: ${claim.cites.length ? claim.cites.join(", ") : "(ninguna registrada)"}`,
      claim.source ? `Fuente encontrada antes: ${claim.source}` : "",
      ``,
      `1. Busca cada fuente citada: localiza la clave en la bibliografía del proyecto (.bib) y el artículo correspondiente en la biblioteca de literatura del proyecto (su PDF o texto completo).${claim.source ? " Empieza por la fuente encontrada antes." : ""}`,
      `2. Lee la parte pertinente de la fuente y decide un veredicto: supported (la fuente lo afirma), partial (respalda solo una parte, o una versión más débil o más estrecha), unsupported (no lo dice, o dice otra cosa), no-source (la fuente no se pudo encontrar ni leer en el proyecto).`,
      `3. Copia literalmente el pasaje que lo decide (como mucho tres frases) y su número de página.`,
      `No cambies ningún archivo del proyecto: ni el manuscrito, ni la bibliografía, ni la biblioteca.`,
      ``,
      `Informe: con la herramienta PluginPanel, lee el widget claims del panel ${PANEL} del plugin ${PLUGIN}. Cambia solo la entrada cuyo id es "${claim.id}": pon verdict, quote, page, note (una o dos frases sobre el porqué, indicando qué clave comprobaste), source (ruta relativa al proyecto del archivo que leíste) y checkedAt (hora ISO). Conserva exactamente como los leíste todos los demás campos y todas las demás entradas, y escribe el valor completo. Si la entrada ya no existe, no la vuelvas a crear; dilo en tu mensaje final.`,
    ].filter((line) => line !== "").join("\n"),
  },
};

export function pickCopy(language) {
  const key = typeof language === "string" ? language.toLowerCase() : "";
  if (key === "cn" || key.startsWith("zh")) return { lang: "zh", copy: COPY.cn };
  if (key.startsWith("es")) return { lang: "es", copy: COPY.es };
  return { lang: "en", copy: COPY.en };
}
