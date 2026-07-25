import type { Language } from "../store";

export const KNOWLEDGE_COPY: Record<Language, {
  viewLabels: {
    fragments: string;
    graph: string;
    review: string;
    confirmed: string;
  };
  fragmentKindLabels: {
    evidence: string;
    "answer-chain": string;
  };
  graphItemKindLabels: {
    evidence: string;
    "answer-chain": string;
    confirmed: string;
    "retrieval-card": string;
  };
  categoryLabels: {
    limitationsAndRisks: string;
    resultsAndFindings: string;
    methodsAndMechanisms: string;
    problemsAndMotivation: string;
    backgroundAndConcepts: string;
  };
  unnamedSubcategory: string;
  unnamedCategory: string;
  uncategorized: string;
  pendingNodes: string;
  retrievalCardFallbackTitle: string;
  recallHintFallback: string;
  nonEvidenceTag: string;
  noLocatableEvidence: string;
  evidenceAnchorsCount: (count: number) => string;
  fragmentListEmpty: string;
  fragmentsSectionAriaLabel: string;
  fragmentSummaryBefore: string;
  fragmentSummaryAfter: string;
  graphEmptyState: string;
  graphSectionAriaLabel: string;
  globalGraphTitle: string;
  globalGraphDescription: string;
  graphToolbarDescriptionBase: string;
  graphToolbarDescriptionWithItems: string;
  graphToolbarDescriptionWithoutItems: string;
  showKnowledgeNodes: string;
  hideKnowledgeNodes: string;
  zoomOutTitle: string;
  zoomOutLabel: string;
  zoomInTitle: string;
  zoomInLabel: string;
  fitViewLabel: string;
  resetViewLabel: string;
  zoomPanHint: string;
  graphRebuilding: string;
  graphRebuildAction: string;
  rootNodesMeta: (count: number) => string;
  nodesMeta: (count: number) => string;
  progressLabel: (index: number, total: number) => string;
  pointLabel: string;
  answerLabel: string;
  saveDraft: string;
  cancel: string;
  confirmAction: string;
  editAction: string;
  rejectAction: string;
  relatedFallback: string;
  retrievalCardsLoadFailed: (cause: unknown) => string;
  paperKnowledgeTitle: string;
  paperKnowledgeDescription: string;
  noEligiblePapers: string;
  selectPaperPlaceholder: string;
  generatingLabel: string;
  generateAction: string;
  loadingLabel: string;
  noDraftsEmptyState: string;
  searchPlaceholder: string;
  noSearchMatches: string;
  noConfirmedYet: string;
  graphRebuildFailed: (message: string) => string;
  previewFragmentEvidenceTitle: string;
  previewFragmentEvidenceText: string;
  previewFragmentAnswerTitle: string;
  previewFragmentAnswerText: string;
  pageEvidenceFallback: (page: number | string) => string;
  answerChainFallbackTitle: string;
}> = {
  cn: {
    viewLabels: {
      fragments: "知识片段",
      graph: "知识图谱",
      review: "待审核",
      confirmed: "已确认",
    },
    fragmentKindLabels: {
      evidence: "证据片段",
      "answer-chain": "问答结论",
    },
    graphItemKindLabels: {
      evidence: "证据片段",
      "answer-chain": "问答结论",
      confirmed: "已确认知识点",
      "retrieval-card": "检索卡（非证据）",
    },
    categoryLabels: {
      limitationsAndRisks: "局限与风险",
      resultsAndFindings: "结果与发现",
      methodsAndMechanisms: "方法与机制",
      problemsAndMotivation: "问题与动机",
      backgroundAndConcepts: "背景与概念",
    },
    unnamedSubcategory: "未命名小类",
    unnamedCategory: "未命名大类",
    uncategorized: "未归类",
    pendingNodes: "待整理节点",
    retrievalCardFallbackTitle: "检索卡",
    recallHintFallback: "召回提示",
    nonEvidenceTag: "非证据",
    noLocatableEvidence: "没有可定位证据。",
    evidenceAnchorsCount: (count) => `${count} 个证据锚点`,
    fragmentListEmpty: "暂无知识片段。先在阅读器中标注证据，或在“证据”页生成证据链。",
    fragmentsSectionAriaLabel: "知识片段",
    fragmentSummaryBefore: "已汇总",
    fragmentSummaryAfter: "个来自文献证据和问答证据链的知识片段。",
    graphEmptyState: "暂无可绘制的知识图谱。需要先有文献证据片段、已确认知识点或检索卡。",
    graphSectionAriaLabel: "知识图谱",
    globalGraphTitle: "全局知识图谱",
    globalGraphDescription: "汇总所有文献的知识碎片与检索卡；检索卡仅用于召回导航，不属于已确认知识或回答证据。",
    graphToolbarDescriptionBase: "从左到右整理知识碎片和非证据检索提示：全局图谱、大类和小类",
    graphToolbarDescriptionWithItems: "，以及知识节点。",
    graphToolbarDescriptionWithoutItems: "。知识节点已隐藏，可展开查看。",
    showKnowledgeNodes: "显示知识节点",
    hideKnowledgeNodes: "隐藏知识节点",
    zoomOutTitle: "缩小（Ctrl + 滚轮向下）",
    zoomOutLabel: "缩小",
    zoomInTitle: "放大（Ctrl + 滚轮向上）",
    zoomInLabel: "放大",
    fitViewLabel: "适配视图",
    resetViewLabel: "重置视图",
    zoomPanHint: "滚轮缩放 · 拖动平移",
    graphRebuilding: "Agent 重构中...",
    graphRebuildAction: "Agent 重构图谱",
    rootNodesMeta: (count) => `${count} 个知识节点`,
    nodesMeta: (count) => `${count} 个节点`,
    progressLabel: (index, total) => `知识点 ${index}/${total}`,
    pointLabel: "知识点",
    answerLabel: "回答",
    saveDraft: "保存草稿",
    cancel: "取消",
    confirmAction: "确认",
    editAction: "修改",
    rejectAction: "丢弃",
    relatedFallback: "相关",
    retrievalCardsLoadFailed: (cause) => `检索卡载入失败：${String(cause)}`,
    paperKnowledgeTitle: "单篇文献知识点",
    paperKnowledgeDescription: "从当前文献的证据、问答链和标注中沉淀知识片段，并在这里审核为可检索知识点。",
    noEligiblePapers: "还没有带阅读记录的文献",
    selectPaperPlaceholder: "选择文献...",
    generatingLabel: "生成中...",
    generateAction: "生成知识点",
    loadingLabel: "加载中...",
    noDraftsEmptyState: "暂无待审核知识点。可以从上方已阅读文献生成候选知识点。",
    searchPlaceholder: "搜索已确认知识点...",
    noSearchMatches: "没有匹配的已确认知识点。",
    noConfirmedYet: "还没有已确认知识点。请先在待审核中确认候选知识点。",
    graphRebuildFailed: (message) => `Agent 重构失败，已保留本地分类图：${message}`,
    previewFragmentEvidenceTitle: "结果：审稿时间下降",
    previewFragmentEvidenceText: "视觉证据显示，带引用理由的 agent verdict 让 reviewer 每篇论文花费时间减少 61%。",
    previewFragmentAnswerTitle: "什么规则保证 agent claim 可信？",
    previewFragmentAnswerText: "每个生成断言都必须能回到原文逐字证据 span，因此无锚点就不应形成 claim。",
    pageEvidenceFallback: (page) => `第 ${page} 页证据`,
    answerChainFallbackTitle: "证据链结论",
  },
  en: {
    viewLabels: {
      fragments: "Fragments",
      graph: "Graph",
      review: "Review",
      confirmed: "Confirmed",
    },
    fragmentKindLabels: {
      evidence: "Evidence fragment",
      "answer-chain": "QA conclusion",
    },
    graphItemKindLabels: {
      evidence: "Evidence fragment",
      "answer-chain": "QA conclusion",
      confirmed: "Confirmed knowledge point",
      "retrieval-card": "Retrieval card (non-evidence)",
    },
    categoryLabels: {
      limitationsAndRisks: "Limitations & risks",
      resultsAndFindings: "Results & findings",
      methodsAndMechanisms: "Methods & mechanisms",
      problemsAndMotivation: "Problems & motivation",
      backgroundAndConcepts: "Background & concepts",
    },
    unnamedSubcategory: "Unnamed subcategory",
    unnamedCategory: "Unnamed category",
    uncategorized: "Uncategorized",
    pendingNodes: "Nodes to sort",
    retrievalCardFallbackTitle: "Retrieval card",
    recallHintFallback: "recall hint",
    nonEvidenceTag: "non-evidence",
    noLocatableEvidence: "No locatable evidence.",
    evidenceAnchorsCount: (count) => `${count} evidence anchors`,
    fragmentListEmpty: "No knowledge fragments yet. Annotate evidence in the reader, or generate evidence chains on the Evidence page.",
    fragmentsSectionAriaLabel: "Knowledge fragments",
    fragmentSummaryBefore: "Collected",
    fragmentSummaryAfter: "knowledge fragments from literature evidence and QA answer chains.",
    graphEmptyState: "No knowledge graph to draw yet. You need literature evidence fragments, confirmed knowledge points, or retrieval cards first.",
    graphSectionAriaLabel: "Knowledge graph",
    globalGraphTitle: "Global knowledge graph",
    globalGraphDescription: "Aggregates knowledge fragments and retrieval cards across all papers; retrieval cards are for recall navigation only, not confirmed knowledge or answer evidence.",
    graphToolbarDescriptionBase: "Left to right: knowledge fragments and non-evidence retrieval hints organized into a global graph, broad categories, and subcategories",
    graphToolbarDescriptionWithItems: ", plus knowledge nodes.",
    graphToolbarDescriptionWithoutItems: ". Knowledge nodes are hidden; expand to view them.",
    showKnowledgeNodes: "Show knowledge nodes",
    hideKnowledgeNodes: "Hide knowledge nodes",
    zoomOutTitle: "Zoom out (Ctrl + scroll down)",
    zoomOutLabel: "Zoom out",
    zoomInTitle: "Zoom in (Ctrl + scroll up)",
    zoomInLabel: "Zoom in",
    fitViewLabel: "Fit view",
    resetViewLabel: "Reset view",
    zoomPanHint: "Scroll to zoom - drag to pan",
    graphRebuilding: "Rebuilding with agent...",
    graphRebuildAction: "Rebuild graph with agent",
    rootNodesMeta: (count) => `${count} knowledge nodes`,
    nodesMeta: (count) => `${count} nodes`,
    progressLabel: (index, total) => `Knowledge point ${index}/${total}`,
    pointLabel: "Knowledge point",
    answerLabel: "Answer",
    saveDraft: "Save draft",
    cancel: "Cancel",
    confirmAction: "Confirm",
    editAction: "Edit",
    rejectAction: "Discard",
    relatedFallback: "related",
    retrievalCardsLoadFailed: (cause) => `Failed to load retrieval cards: ${String(cause)}`,
    paperKnowledgeTitle: "Paper knowledge points",
    paperKnowledgeDescription: "Distill knowledge fragments from this paper's evidence, answer chains, and annotations, then review them here into retrievable knowledge points.",
    noEligiblePapers: "No papers with reading material yet",
    selectPaperPlaceholder: "Select a paper...",
    generatingLabel: "Generating...",
    generateAction: "Generate knowledge points",
    loadingLabel: "Loading...",
    noDraftsEmptyState: "No knowledge points pending review yet. Generate candidates from a paper you've read above.",
    searchPlaceholder: "Search confirmed knowledge points...",
    noSearchMatches: "No matching confirmed knowledge points.",
    noConfirmedYet: "No confirmed knowledge points yet. Confirm candidates in Review first.",
    graphRebuildFailed: (message) => `Agent rebuild failed; kept the local classification graph: ${message}`,
    previewFragmentEvidenceTitle: "Result: reviewer screening time drops",
    previewFragmentEvidenceText: "Visual evidence shows that an agent verdict with a cited rationale cuts reviewer time per paper by 61%.",
    previewFragmentAnswerTitle: "What rule keeps agent claims trustworthy?",
    previewFragmentAnswerText: "Every generated assertion must resolve back to a verbatim evidence span in the source, so a claim without an anchor should never form.",
    pageEvidenceFallback: (page) => `Page ${page} evidence`,
    answerChainFallbackTitle: "Answer-chain conclusion",
  },
};
