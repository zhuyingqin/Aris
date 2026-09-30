import type { Language } from "../store";

export const KNOWLEDGE_COPY: Record<Language, {
  viewLabels: {
    fragments: string;
    review: string;
    confirmed: string;
  };
  fragmentKindLabels: {
    evidence: string;
    "answer-chain": string;
  };
  noLocatableEvidence: string;
  evidenceAnchorsCount: (count: number) => string;
  fragmentListEmpty: string;
  fragmentsSectionAriaLabel: string;
  fragmentSummaryBefore: string;
  fragmentSummaryAfter: string;
  progressLabel: (index: number, total: number) => string;
  pointLabel: string;
  answerLabel: string;
  saveDraft: string;
  cancel: string;
  confirmAction: string;
  editAction: string;
  rejectAction: string;
  relatedFallback: string;
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
      review: "待审核",
      confirmed: "已确认",
    },
    fragmentKindLabels: {
      evidence: "证据片段",
      "answer-chain": "问答结论",
    },
    noLocatableEvidence: "没有可定位证据。",
    evidenceAnchorsCount: (count) => `${count} 个证据锚点`,
    fragmentListEmpty: "暂无知识片段。先在阅读器中标注证据，或在“证据”页生成证据链。",
    fragmentsSectionAriaLabel: "知识片段",
    fragmentSummaryBefore: "已汇总",
    fragmentSummaryAfter: "个来自文献证据和问答证据链的知识片段。",
    progressLabel: (index, total) => `知识点 ${index}/${total}`,
    pointLabel: "知识点",
    answerLabel: "回答",
    saveDraft: "保存草稿",
    cancel: "取消",
    confirmAction: "确认",
    editAction: "修改",
    rejectAction: "丢弃",
    relatedFallback: "相关",
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
      review: "Review",
      confirmed: "Confirmed",
    },
    fragmentKindLabels: {
      evidence: "Evidence fragment",
      "answer-chain": "QA conclusion",
    },
    noLocatableEvidence: "No locatable evidence.",
    evidenceAnchorsCount: (count) => `${count} evidence anchors`,
    fragmentListEmpty: "No knowledge fragments yet. Annotate evidence in the reader, or generate evidence chains on the Evidence page.",
    fragmentsSectionAriaLabel: "Knowledge fragments",
    fragmentSummaryBefore: "Collected",
    fragmentSummaryAfter: "knowledge fragments from literature evidence and QA answer chains.",
    progressLabel: (index, total) => `Knowledge point ${index}/${total}`,
    pointLabel: "Knowledge point",
    answerLabel: "Answer",
    saveDraft: "Save draft",
    cancel: "Cancel",
    confirmAction: "Confirm",
    editAction: "Edit",
    rejectAction: "Discard",
    relatedFallback: "related",
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
    previewFragmentEvidenceTitle: "Result: reviewer screening time drops",
    previewFragmentEvidenceText: "Visual evidence shows that an agent verdict with a cited rationale cuts reviewer time per paper by 61%.",
    previewFragmentAnswerTitle: "What rule keeps agent claims trustworthy?",
    previewFragmentAnswerText: "Every generated assertion must resolve back to a verbatim evidence span in the source, so a claim without an anchor should never form.",
    pageEvidenceFallback: (page) => `Page ${page} evidence`,
    answerChainFallbackTitle: "Answer-chain conclusion",
  },
};
