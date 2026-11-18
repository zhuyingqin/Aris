import type { Language } from "../../language";
import type { ReviewCountBranch, WorkflowBatchJobKind, WorkflowLiveActivityStatus } from "../workflowTypes";

type StageText = Record<string, { title: string; description: string }>;

/** Vocabulary shared by every Workflows panel: statuses, phases, stages, gates. */
const cn = {
  /** BCP 47 locale for dates and numbers. */
  locale: "zh-CN",
  status: {
    draft: "草稿",
    awaiting_plan_approval: "等待确认",
    running: "运行中",
    completed: "已完成",
    not_started: "未开始",
    ready: "可开始",
    // Not "运行中": durable ledger state meaning "started and waiting for its
    // next action", which is what a stage looks like after an action failed.
    in_progress: "进行中 · 待继续",
    waiting_user: "等待确认",
    waiting_reviewer: "等待 Reviewer",
    revision_required: "需要修订",
    blocked: "受阻",
    partial: "覆盖不完整",
    passed: "已通过",
  } as Record<string, string>,
  branch: {
    unknown: {
      label: "尚未分支",
      detail: "检索覆盖未耗尽时，不根据当前数量作出结论。",
    },
    insufficient: {
      label: "少于 10 篇：返回检索审查",
      detail: "先区分数据源失败与检索式过窄，再一次只放宽一个维度。",
    },
    focused: {
      label: "10–49 篇：直接分析空白",
      detail: "逐篇分析近五年综述的趋势、主题演变与未覆盖问题。",
    },
    broad: {
      label: "50 篇以上：先聚类再分析",
      detail: "先按主题、方法、应用、时间与综述类型聚类，再分析簇内和跨簇空白。",
    },
  } as Record<ReviewCountBranch, { label: string; detail: string }>,
  activityStatus: {
    running: "进行中",
    completed: "完成",
    failed: "失败",
  } as Record<WorkflowLiveActivityStatus, string>,
  llmPhase: {
    started: "准备中",
    thinking: "推演中",
    text: "生成中",
    tool: "调用工具",
  } as Record<string, string>,
  searchPhase: {
    started: "检索中",
    restarting: "重试中",
    skipped: "已跳过",
    completed: "完成",
    failed: "失败",
  } as Record<string, string>,
  batchJob: {
    eligibility: "综述资格核验",
    landscape: "综述格局分批分析",
    grading: "A/B/C/D 分级",
    mapping: "论文到章节映射",
    outline: "大纲主题聚类",
    query_quality: "试检误检分析",
    "primary-select": "候选相关性筛选",
  } as Record<WorkflowBatchJobKind, string>,
  artifactKind: {
    search_protocol: "检索协议",
    coverage_snapshot: "覆盖快照",
    query_quality_sample: "试检样本",
    query_quality_iteration: "试检轮次",
    primary_library_snapshot: "文献库快照",
  } as Record<string, string>,
  fullTextStrategy: {
    retrieve_relevant_sections_on_demand: "按需读取相关章节，不把整篇论文送进模型",
  } as Record<string, string>,
  reviewerGate: {
    pending: "待审查",
    approved: "已通过",
    rejected: "已退回",
    not_required: "不需要",
    skipped: "未经审查",
  } as Record<string, string>,
  phase: {
    recon: "综述侦察与方向发现",
    decide: "定题",
    corpus: "建库",
    organise: "组织",
    write: "成稿与投稿",
  } as Record<string, string>,
  stageReopen: {
    "direction-selection": "重新选择方向",
    outline: "重新打开并提出修改意见",
    "primary-library": "重新构建原始文献库",
  } as Record<string, string>,
  coverageReason: {
    provider_has_more_results: "Scopus 仍有下一页",
    protocol_max_results: "已达到本批获取上限",
    protocol_variant_bound: "部分矩阵路径尚未执行",
    protocol_path_budget: "已完成各路径首批，后续分页已保留",
    query_variant_error: "部分矩阵路径执行失败",
    adapter_request_failed: "Scopus 请求失败",
    continuation_unavailable: "Scopus 未提供可续读游标",
    provider_result_window: "已达到 Scopus 可访问结果窗口",
  } as Record<string, string>,
  coverageExhausted: "Scopus 全部矩阵路径均已遍历完成",
  coverageMoreAvailable: "Scopus 仍有可续读结果",
  /** Separator between joined reasons/issues. */
  listSep: "；",
  /**
   * Stage titles and descriptions by stage id. Empty in Chinese on purpose:
   * the run persists the Chinese template text, which is then shown as stored.
   */
  stageText: {} as StageText,
  /**
   * Display labels for the persisted Scopus syntax-check strings (Chinese
   * identifiers mirrored by the Rust driver). Empty in Chinese: shown as stored.
   */
  syntaxCheck: {} as Record<string, string>,
  unknownSectionId: "Reviewer 使用了大纲中不存在的章节 ID。",
  duplicateGradeRecords: "A/B/C/D 分级包含重复的文献记录。",
  invalidGrade: (recordId: string, grade: string) => `文献 ${recordId} 的分级“${grade}”无效。`,
  gradedMissingFromLibrary: (count: number) => `有 ${count} 篇分级文献不在本地文献库中，无法同步 A/B/C/D 分类。`,
  precisionBelowFloor: (percent: number) => `估计查准率 ${percent}%，低于约 50% 的进入下限。`,
  reviewOffRevisionSummary: "独立审查已关闭；当前轮由确定性质量门禁与 Executor 误检分析判定需要修订。",
  pilotQualityInsufficient: "试检质量不足，需要修订矩阵策略。",
  skippedGateReviewer: "已关闭独立审查",
  skippedGateSummary: "该工作流关闭了审核模型，此阶段未经独立 Reviewer 审查。",
};

export type CommonCopy = typeof cn;

const en: CommonCopy = {
  locale: "en",
  status: {
    draft: "Draft",
    awaiting_plan_approval: "Awaiting confirmation",
    running: "Running",
    completed: "Completed",
    not_started: "Not started",
    ready: "Ready to start",
    in_progress: "In progress · waiting to continue",
    waiting_user: "Awaiting confirmation",
    waiting_reviewer: "Waiting for Reviewer",
    revision_required: "Revision required",
    blocked: "Blocked",
    partial: "Incomplete coverage",
    passed: "Passed",
  },
  branch: {
    unknown: {
      label: "Not branched yet",
      detail: "While search coverage is not exhausted, no conclusion is drawn from the current count.",
    },
    insufficient: {
      label: "Fewer than 10: back to search review",
      detail: "First tell source failures apart from an overly narrow query, then widen one dimension at a time.",
    },
    focused: {
      label: "10–49: analyze gaps directly",
      detail: "Analyze each review from the last five years for trends, topic evolution and uncovered questions.",
    },
    broad: {
      label: "50 or more: cluster first, then analyze",
      detail: "Cluster by topic, method, application, period and review type, then analyze gaps within and across clusters.",
    },
  },
  activityStatus: {
    running: "In progress",
    completed: "Done",
    failed: "Failed",
  },
  llmPhase: {
    started: "Preparing",
    thinking: "Reasoning",
    text: "Generating",
    tool: "Calling tool",
  },
  searchPhase: {
    started: "Searching",
    restarting: "Retrying",
    skipped: "Skipped",
    completed: "Done",
    failed: "Failed",
  },
  batchJob: {
    eligibility: "Review eligibility check",
    landscape: "Batched review landscape analysis",
    grading: "A/B/C/D grading",
    mapping: "Paper-to-section mapping",
    outline: "Outline topic clustering",
    query_quality: "Pilot false-positive analysis",
    "primary-select": "Candidate relevance screening",
  },
  artifactKind: {
    search_protocol: "Search protocol",
    coverage_snapshot: "Coverage snapshot",
    query_quality_sample: "Pilot sample",
    query_quality_iteration: "Pilot round",
    primary_library_snapshot: "Library snapshot",
  },
  fullTextStrategy: {
    retrieve_relevant_sections_on_demand: "Read relevant sections on demand instead of sending whole papers to the model",
  },
  reviewerGate: {
    pending: "Pending review",
    approved: "Approved",
    rejected: "Sent back",
    not_required: "Not required",
    skipped: "Not reviewed",
  },
  phase: {
    recon: "Review scouting and direction discovery",
    decide: "Choose the topic",
    corpus: "Build the corpus",
    organise: "Organize",
    write: "Write and submit",
  },
  stageReopen: {
    "direction-selection": "Choose the direction again",
    outline: "Reopen and request changes",
    "primary-library": "Rebuild the primary library",
  },
  coverageReason: {
    provider_has_more_results: "Scopus has another page",
    protocol_max_results: "Reached this batch's fetch limit",
    protocol_variant_bound: "Some matrix paths have not run yet",
    protocol_path_budget: "First batch of every path done; later pages kept",
    query_variant_error: "Some matrix paths failed",
    adapter_request_failed: "Scopus request failed",
    continuation_unavailable: "Scopus returned no continuation cursor",
    provider_result_window: "Reached the limit of results Scopus makes accessible",
  },
  coverageExhausted: "Every Scopus matrix path has been searched to the end",
  coverageMoreAvailable: "Scopus has more results to fetch",
  listSep: "; ",
  stageText: {
    "scope-and-plan": {
      title: "Research scope and search plan",
      description: "Clarify the topic, generate multilingual, broad, precise and synonym queries, and have them checked by the independent Reviewer.",
    },
    "review-landscape-search": {
      title: "Full search of reviews from the last five years",
      description: "Run a resumable search until every source is exhausted or its failures, skips and truncations are recorded; the independent Reviewer first checks the quality of what came back.",
    },
    "review-eligibility": {
      title: "Genuine review eligibility check",
      description: "Check candidates in batches by title, abstract, document type and time window; only confirmed review papers count toward the branch.",
    },
    "coverage-and-branch": {
      title: "Coverage check and count branch",
      description: "Count only genuine reviews whose eligibility check is complete and whose coverage is exhausted; fewer than 10 goes back to search review.",
    },
    "gap-analysis": {
      title: "Trends and review gaps",
      description: "Cover the state of the field, topic evolution, gap exploration and a three-month feasibility analysis.",
    },
    "direction-selection": {
      title: "Direction and research question",
      description: "You confirm a direction from 3–5 candidates, which freezes the scope, boundaries and research question.",
    },
    "matrix-strategy": {
      title: "Scopus matrix strategy",
      description: "Break the topic into A/B/C entities, build full semantic groups and four executable paths, then run deterministic syntax checks and independent review.",
    },
    "query-quality-loop": {
      title: "Pilot search and false-positive loop",
      description: "Take the first 100 records with abstracts by date, find common false-positive patterns and iterate the query, balancing recall and precision.",
    },
    "primary-library": {
      title: "High-quality primary library",
      description: "Run the approved strategy in full, continue, deduplicate and keep coverage state to form an auditable core library.",
    },
    "batch-grading": {
      title: "A/B/C/D batch grading",
      description: "Assess each paper's relevance and extract 1–2 sentences of key findings, keeping order, method and batch checkpoints intact.",
    },
    outline: {
      title: "Data-driven review outline",
      description: "Combine the views, topics and evidence density of high-value papers into a complete writing outline down to x.x level.",
    },
    "section-mapping": {
      title: "Paper-to-section mapping",
      description: "Map each paper to its direct and indirect subsections, with a one-sentence core contribution and use.",
    },
    "evidence-synthesis": {
      title: "Full-text evidence and synthesis",
      description: "Read full-text passages on demand per the outline and build evidence cards, quality ratings, claim boundaries, figures and traceable citations.",
    },
    manuscript: {
      title: "Evidence-bound manuscript",
      description: "Write section by section from the evidence-mapped outline; every key claim links to evidence cards and primary sources.",
    },
    "independent-review": {
      title: "Independent review and revision loop",
      description: "The Reviewer checks coverage, bias, evidence, argument, citations and reporting standards; the Executor revises round by round.",
    },
    "submission-package": {
      title: "Submission package",
      description: "Export the manuscript, references, figures, supplementary material, protocol, screening log, checklists and cover letter.",
    },
  },
  syntaxCheck: {
    "括号配对通过": "Parentheses balanced",
    "括号配对失败": "Parentheses unbalanced",
    "TITLE-ABS-KEY 字段通过": "TITLE-ABS-KEY field present",
    "缺少 TITLE-ABS-KEY": "TITLE-ABS-KEY missing",
    "布尔运算符通过": "Boolean operators present",
    "缺少布尔运算符": "Boolean operators missing",
    "未发现中文": "No Chinese text",
    "发现中文": "Chinese text found",
    "未发现占位符": "No placeholders",
    "发现占位符": "Placeholder found",
  },
  unknownSectionId: "The Reviewer used a section ID that does not exist in the outline.",
  duplicateGradeRecords: "The A/B/C/D grading contains duplicate paper records.",
  invalidGrade: (recordId, grade) => `Paper ${recordId} has an invalid grade "${grade}".`,
  gradedMissingFromLibrary: (count) => `${count} graded ${count === 1 ? "paper is" : "papers are"} not in the local library, so the A/B/C/D grades cannot be synced.`,
  precisionBelowFloor: (percent) => `Estimated precision is ${percent}%, below the roughly 50% entry floor.`,
  reviewOffRevisionSummary: "Independent review is off; the deterministic quality gate and the Executor's false-positive analysis decided this round needs revision.",
  pilotQualityInsufficient: "Pilot quality is not good enough; the matrix strategy needs revising.",
  skippedGateReviewer: "Independent review off",
  skippedGateSummary: "The review model is off for this workflow, so this stage was not checked by an independent Reviewer.",
};

const es: CommonCopy = {
  locale: "es-ES",
  status: {
    draft: "Borrador",
    awaiting_plan_approval: "Pendiente de confirmación",
    running: "En ejecución",
    completed: "Completado",
    not_started: "Sin empezar",
    ready: "Listo para empezar",
    in_progress: "En curso · pendiente de continuar",
    waiting_user: "Pendiente de confirmación",
    waiting_reviewer: "Esperando al Revisor",
    revision_required: "Requiere revisión",
    blocked: "Bloqueado",
    partial: "Cobertura incompleta",
    passed: "Aprobado",
  },
  branch: {
    unknown: {
      label: "Aún sin rama",
      detail: "Mientras la cobertura de la búsqueda no esté agotada, no se saca ninguna conclusión del recuento actual.",
    },
    insufficient: {
      label: "Menos de 10: volver a revisar la búsqueda",
      detail: "Primero distingue los fallos de las fuentes de una consulta demasiado estrecha y luego amplía una sola dimensión cada vez.",
    },
    focused: {
      label: "10–49: analizar vacíos directamente",
      detail: "Analiza una por una las revisiones de los últimos cinco años: tendencias, evolución temática y cuestiones sin cubrir.",
    },
    broad: {
      label: "50 o más: agrupar primero y luego analizar",
      detail: "Agrupa por tema, método, aplicación, periodo y tipo de revisión, y después analiza los vacíos dentro de cada grupo y entre grupos.",
    },
  },
  activityStatus: {
    running: "En curso",
    completed: "Hecho",
    failed: "Error",
  },
  llmPhase: {
    started: "Preparando",
    thinking: "Razonando",
    text: "Generando",
    tool: "Llamando a una herramienta",
  },
  searchPhase: {
    started: "Buscando",
    restarting: "Reintentando",
    skipped: "Omitido",
    completed: "Hecho",
    failed: "Error",
  },
  batchJob: {
    eligibility: "Verificación de elegibilidad de revisiones",
    landscape: "Análisis por lotes del panorama de revisiones",
    grading: "Clasificación A/B/C/D",
    mapping: "Asignación de artículos a secciones",
    outline: "Agrupación temática del esquema",
    query_quality: "Análisis de falsos positivos de la búsqueda piloto",
    "primary-select": "Cribado de relevancia de candidatos",
  },
  artifactKind: {
    search_protocol: "Protocolo de búsqueda",
    coverage_snapshot: "Instantánea de cobertura",
    query_quality_sample: "Muestra piloto",
    query_quality_iteration: "Ronda piloto",
    primary_library_snapshot: "Instantánea de la biblioteca",
  },
  fullTextStrategy: {
    retrieve_relevant_sections_on_demand: "Lee las secciones relevantes cuando hagan falta, sin enviar artículos completos al modelo",
  },
  reviewerGate: {
    pending: "Pendiente de revisión",
    approved: "Aprobado",
    rejected: "Devuelto",
    not_required: "No necesario",
    skipped: "Sin revisar",
  },
  phase: {
    recon: "Exploración de revisiones y búsqueda de dirección",
    decide: "Elegir el tema",
    corpus: "Construir el corpus",
    organise: "Organizar",
    write: "Redacción y envío",
  },
  stageReopen: {
    "direction-selection": "Volver a elegir la dirección",
    outline: "Reabrir y pedir cambios",
    "primary-library": "Reconstruir la biblioteca primaria",
  },
  coverageReason: {
    provider_has_more_results: "Scopus aún tiene otra página",
    protocol_max_results: "Se alcanzó el límite de obtención de este lote",
    protocol_variant_bound: "Algunas rutas de la matriz aún no se han ejecutado",
    protocol_path_budget: "Primer lote de cada ruta hecho; las páginas siguientes se conservan",
    query_variant_error: "Algunas rutas de la matriz fallaron",
    adapter_request_failed: "Falló la solicitud a Scopus",
    continuation_unavailable: "Scopus no devolvió un cursor para continuar",
    provider_result_window: "Se alcanzó la ventana de resultados accesible de Scopus",
  },
  coverageExhausted: "Se han recorrido por completo todas las rutas de la matriz en Scopus",
  coverageMoreAvailable: "Scopus aún tiene resultados por leer",
  listSep: "; ",
  stageText: {
    "scope-and-plan": {
      title: "Alcance de la investigación y plan de búsqueda",
      description: "Aclara el tema, genera consultas multilingües, amplias, precisas y con sinónimos, y haz que las revise el Revisor independiente.",
    },
    "review-landscape-search": {
      title: "Búsqueda completa de revisiones de los últimos cinco años",
      description: "Ejecuta una búsqueda reanudable hasta agotar cada fuente o registrar sus fallos, omisiones y truncamientos; el Revisor independiente revisa primero la calidad de lo recuperado.",
    },
    "review-eligibility": {
      title: "Verificación de elegibilidad de revisiones reales",
      description: "Verifica los candidatos por lotes según título, resumen, tipo de documento y ventana temporal; solo las revisiones confirmadas cuentan para la rama.",
    },
    "coverage-and-branch": {
      title: "Verificación de cobertura y rama por recuento",
      description: "Cuenta solo las revisiones reales con la elegibilidad verificada y la cobertura agotada; con menos de 10 se vuelve a revisar la búsqueda.",
    },
    "gap-analysis": {
      title: "Tendencias y vacíos en las revisiones",
      description: "Cubre el estado del campo, la evolución temática, la exploración de vacíos y un análisis de viabilidad a tres meses.",
    },
    "direction-selection": {
      title: "Dirección y pregunta de investigación",
      description: "Confirmas una dirección entre 3–5 candidatas, lo que fija el alcance, los límites y la pregunta de investigación.",
    },
    "matrix-strategy": {
      title: "Estrategia matricial en Scopus",
      description: "Descompón el tema en entidades A/B/C, construye grupos semánticos completos y cuatro rutas ejecutables, y pasa comprobaciones sintácticas deterministas y la revisión independiente.",
    },
    "query-quality-loop": {
      title: "Búsqueda piloto y ciclo de falsos positivos",
      description: "Toma los primeros 100 registros con resumen por fecha, identifica patrones comunes de falsos positivos e itera la consulta equilibrando exhaustividad y precisión.",
    },
    "primary-library": {
      title: "Biblioteca primaria de alta calidad",
      description: "Ejecuta la estrategia aprobada por completo, continúa, elimina duplicados y conserva el estado de cobertura para formar una biblioteca central auditable.",
    },
    "batch-grading": {
      title: "Clasificación A/B/C/D por lotes",
      description: "Evalúa la relevancia de cada artículo y extrae 1–2 frases de hallazgos clave, conservando el orden, el método y los puntos de control de cada lote.",
    },
    outline: {
      title: "Esquema de revisión basado en datos",
      description: "Combina las ideas, los temas y la densidad de evidencia de los artículos más valiosos en un esquema de redacción completo hasta el nivel x.x.",
    },
    "section-mapping": {
      title: "Asignación de artículos a secciones",
      description: "Asigna cada artículo a sus subsecciones directas e indirectas, con una frase sobre su contribución principal y su aplicación.",
    },
    "evidence-synthesis": {
      title: "Evidencia de texto completo y síntesis",
      description: "Lee fragmentos de texto completo cuando el esquema lo pida y construye fichas de evidencia, valoraciones de calidad, límites de las afirmaciones, figuras y citas trazables.",
    },
    manuscript: {
      title: "Manuscrito ceñido a la evidencia",
      description: "Redacta sección por sección a partir del esquema con evidencia asignada; cada afirmación clave enlaza a fichas de evidencia y fuentes primarias.",
    },
    "independent-review": {
      title: "Revisión independiente y ciclo de correcciones",
      description: "El Revisor comprueba cobertura, sesgo, evidencia, argumentación, citas y normas de publicación; el Ejecutor corrige ronda a ronda.",
    },
    "submission-package": {
      title: "Paquete de envío",
      description: "Exporta el manuscrito, las referencias, las figuras, el material complementario, el protocolo, el registro de cribado, las listas de verificación y la carta de presentación.",
    },
  },
  syntaxCheck: {
    "括号配对通过": "Paréntesis equilibrados",
    "括号配对失败": "Paréntesis desequilibrados",
    "TITLE-ABS-KEY 字段通过": "Campo TITLE-ABS-KEY presente",
    "缺少 TITLE-ABS-KEY": "Falta TITLE-ABS-KEY",
    "布尔运算符通过": "Operadores booleanos presentes",
    "缺少布尔运算符": "Faltan operadores booleanos",
    "未发现中文": "Sin texto en chino",
    "发现中文": "Se encontró texto en chino",
    "未发现占位符": "Sin marcadores de posición",
    "发现占位符": "Se encontró un marcador de posición",
  },
  unknownSectionId: "El Revisor usó un ID de sección que no existe en el esquema.",
  duplicateGradeRecords: "La clasificación A/B/C/D contiene registros de artículos duplicados.",
  invalidGrade: (recordId, grade) => `El artículo ${recordId} tiene una clasificación no válida: "${grade}".`,
  gradedMissingFromLibrary: (count) => `${count} ${count === 1 ? "artículo clasificado no está" : "artículos clasificados no están"} en la biblioteca local, así que no se pueden sincronizar las clasificaciones A/B/C/D.`,
  precisionBelowFloor: (percent) => `La precisión estimada es del ${percent}%, por debajo del umbral de entrada de aproximadamente el 50%.`,
  reviewOffRevisionSummary: "La revisión independiente está desactivada; el control de calidad determinista y el análisis de falsos positivos del Ejecutor decidieron que esta ronda necesita revisión.",
  pilotQualityInsufficient: "La calidad de la búsqueda piloto no es suficiente; hay que revisar la estrategia matricial.",
  skippedGateReviewer: "Revisión independiente desactivada",
  skippedGateSummary: "Este flujo de trabajo desactivó el modelo de revisión, así que esta etapa no la revisó un Revisor independiente.",
};

export const COMMON_COPY: Record<Language, CommonCopy> = { cn, en, es };
