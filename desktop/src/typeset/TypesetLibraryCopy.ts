import type { TypesetCompileState, TypesetDocumentKind } from "../api/tauri";
import type { Language } from "../store";

export type TypesetLibraryScope = "all" | "recent" | "favorites" | "article" | "beamer" | "poster" | "report" | "ready" | "needs-compile" | "archived";
export type TypesetTemplate = TypesetDocumentKind;

export const TYPESET_LIBRARY_TEMPLATES: Array<{ kind: TypesetTemplate; folder: string }> = [
  { kind: "article", folder: "papers" },
  { kind: "beamer", folder: "slides" },
  { kind: "report", folder: "reports" },
  { kind: "poster", folder: "posters" },
];

const EN_COPY = {
  libraryLabel: "LaTeX document library",
  categoriesLabel: "Document categories",
  newDocument: "New LaTeX document",
  groups: {
    library: "Library",
    documentType: "Document type",
    buildStatus: "Build status",
  },
  scopes: {
    all: "All documents",
    recent: "Recently modified",
    favorites: "Favorites",
    article: "Articles",
    beamer: "Presentations",
    poster: "Posters",
    report: "Reports",
    ready: "Ready to review",
    "needs-compile": "Needs compilation",
    archived: "Archived documents",
  },
  navigation: {
    all: "All documents",
    recent: "Recent",
    favorites: "Favorites",
    article: "Articles",
    beamer: "Presentations",
    poster: "Posters",
    report: "Reports",
    ready: "Ready",
    "needs-compile": "Needs compile",
    archived: "Archived",
  },
  rootDocumentsOnly: "Root documents only",
  scanning: "Scanning local workspace…",
  documentCount: (count: number) => `${count} document${count === 1 ? "" : "s"}`,
  refresh: "Refresh",
  refreshLibrary: "Refresh document library",
  latexMissingTitle: "System LaTeX is not installed",
  latexMissingBody: "Open Chat to choose an installation method, review the required download, and verify the toolchain when it is ready.",
  installInChat: "Install with Chat",
  searchPlaceholder: "Search by title or path",
  sort: "Sort",
  sortDocuments: "Sort documents",
  sortModified: "Last modified",
  sortTitle: "Title",
  selectVisible: "Select visible documents",
  table: {
    document: "Document",
    type: "Type",
    modified: "Last modified",
    status: "Status",
    actions: "Actions",
  },
  projectRoot: "Project root",
  kinds: {
    article: "Article",
    beamer: "Presentation",
    poster: "Poster",
    report: "Report",
  },
  compileStates: {
    fresh: "Compiled",
    stale: "Needs compile",
    missing: "Not compiled",
  },
  selectDocument: (title: string) => `Select ${title}`,
  actionsFor: (title: string) => `Actions for ${title}`,
  open: "Open document",
  openDocument: (title: string) => `Open ${title}`,
  reveal: "Show in folder",
  revealDocument: (title: string) => `Show ${title} in folder`,
  addFavorite: "Add favorite",
  removeFavorite: "Remove favorite",
  favoriteDocument: (title: string, favorite: boolean) => `${favorite ? "Remove" : "Add"} ${title} ${favorite ? "from favorites" : "to favorites"}`,
  archive: "Archive document",
  restore: "Restore document",
  archiveDocument: (title: string, archived: boolean) => `${archived ? "Restore" : "Archive"} ${title}`,
  emptyRootTitle: "No LaTeX root documents found",
  emptyRootBody: "Create a document or add a .tex file containing \\documentclass.",
  emptyViewTitle: "No documents match this view",
  emptyViewBody: "Try another search or category.",
  dialogLabel: "New LaTeX document",
  dialogEyebrow: "New LaTeX document",
  dialogTitle: "Choose a starting point",
  closeDialog: "Close new document dialog",
  documentTitle: "Document title",
  titlePlaceholder: "Untitled research note",
  templateLabel: "Document template",
  templates: {
    article: { label: "Article", description: "Paper, note, or manuscript" },
    beamer: { label: "Presentation", description: "16:9 Beamer slide deck" },
    report: { label: "Report", description: "Multi-chapter research report" },
    poster: { label: "Poster", description: "A1 Beamer poster" },
  },
  cancel: "Cancel",
  create: "Create document",
};

const CN_COPY: typeof EN_COPY = {
  libraryLabel: "LaTeX 文档库",
  categoriesLabel: "文档分类",
  newDocument: "新建 LaTeX 文档",
  groups: {
    library: "文档库",
    documentType: "文档类型",
    buildStatus: "编译状态",
  },
  scopes: {
    all: "全部文档",
    recent: "最近修改",
    favorites: "收藏文档",
    article: "论文与文章",
    beamer: "演示文稿",
    poster: "学术海报",
    report: "研究报告",
    ready: "可供审阅",
    "needs-compile": "需要编译",
    archived: "已归档文档",
  },
  navigation: {
    all: "全部文档",
    recent: "最近修改",
    favorites: "收藏",
    article: "论文与文章",
    beamer: "演示文稿",
    poster: "学术海报",
    report: "研究报告",
    ready: "编译完成",
    "needs-compile": "需要编译",
    archived: "已归档",
  },
  rootDocumentsOnly: "仅显示根文档",
  scanning: "正在扫描本地工作区…",
  documentCount: (count: number) => `${count} 个文档`,
  refresh: "刷新",
  refreshLibrary: "刷新文档库",
  latexMissingTitle: "尚未安装系统 LaTeX",
  latexMissingBody: "可以转到对话，由 SomniQ 选择安装方式、说明下载内容，并在安装后验证工具链。",
  installInChat: "前往对话安装",
  searchPlaceholder: "按标题或路径搜索",
  sort: "排序",
  sortDocuments: "文档排序",
  sortModified: "最近修改",
  sortTitle: "标题",
  selectVisible: "选择当前可见文档",
  table: {
    document: "文档",
    type: "类型",
    modified: "最近修改",
    status: "状态",
    actions: "操作",
  },
  projectRoot: "项目根目录",
  kinds: {
    article: "论文",
    beamer: "演示文稿",
    poster: "海报",
    report: "报告",
  },
  compileStates: {
    fresh: "已编译",
    stale: "需要编译",
    missing: "尚未编译",
  },
  selectDocument: (title: string) => `选择 ${title}`,
  actionsFor: (title: string) => `${title} 的操作`,
  open: "打开文档",
  openDocument: (title: string) => `打开 ${title}`,
  reveal: "在文件夹中显示",
  revealDocument: (title: string) => `在文件夹中显示 ${title}`,
  addFavorite: "添加收藏",
  removeFavorite: "取消收藏",
  favoriteDocument: (title: string, favorite: boolean) => `${favorite ? "取消收藏" : "收藏"} ${title}`,
  archive: "归档文档",
  restore: "恢复文档",
  archiveDocument: (title: string, archived: boolean) => `${archived ? "恢复" : "归档"} ${title}`,
  emptyRootTitle: "没有找到 LaTeX 根文档",
  emptyRootBody: "新建文档，或添加包含 \\documentclass 的 .tex 文件。",
  emptyViewTitle: "当前视图没有匹配文档",
  emptyViewBody: "可以尝试其他关键词或分类。",
  dialogLabel: "新建 LaTeX 文档",
  dialogEyebrow: "新建 LaTeX 文档",
  dialogTitle: "选择一个起始模板",
  closeDialog: "关闭新建文档窗口",
  documentTitle: "文档标题",
  titlePlaceholder: "未命名研究文档",
  templateLabel: "文档模板",
  templates: {
    article: { label: "论文与文章", description: "适合论文、笔记和普通文稿" },
    beamer: { label: "演示文稿", description: "16:9 Beamer 幻灯片" },
    report: { label: "研究报告", description: "多章节研究报告" },
    poster: { label: "学术海报", description: "A1 Beamer 学术海报" },
  },
  cancel: "取消",
  create: "创建文档",
};

export const TYPESET_LIBRARY_COPY: Record<Language, typeof EN_COPY> = {
  en: EN_COPY,
  cn: CN_COPY,
};

export function documentKindLabel(kind: TypesetDocumentKind, language: Language): string {
  return TYPESET_LIBRARY_COPY[language].kinds[kind];
}

export function documentCompileLabel(state: TypesetCompileState, language: Language): string {
  return TYPESET_LIBRARY_COPY[language].compileStates[state];
}

export function documentRelativeTime(epochMs: number, language: Language): string {
  const elapsed = Math.max(0, Date.now() - epochMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (language === "cn") {
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(epochMs));
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(epochMs));
}
