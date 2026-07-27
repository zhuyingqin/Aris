import type { Language } from "../store";

export const LAB_COPY: Record<Language, {
  // Terminal.tsx
  terminalFailedToOpen: (error: string) => string;
  terminalProcessExited: string;

  // outputs.tsx
  collapseOutput: string;
  showFullOutput: string;
  cellOutputAlt: string;

  // Shared AI-diff review banner (Lab.tsx notebook-level + FileEditorPane.tsx file-level)
  aiChangesDetected: string;
  keepAiChanges: string;
  keepAiChangesTitle: string;
  restoreLabel: string;
  restoreFileTitle: string;
  restoreNotebookTitle: string;
  linesChangedAria: (added: number, removed: number) => string;
  moreRemovedLines: (count: number) => string;
  addedCount: (count: number) => string;
  modifiedCount: (count: number) => string;
  removedCount: (count: number) => string;
  emptyCellPlaceholder: (cellType: string) => string;
  moreRemovedCells: (count: number) => string;

  // FileEditorPane.tsx
  runPythonFileTitle: string;
  runSelectionLineLabel: string;
  selectInterpreterKernelTitle: string;
  noKernelsFound: string;
  noInterpreter: string;
  cannotCompleteAction: string;
  loadingFile: string;
  startTypingPlaceholder: string;
  selectFileToOpenHint: string;
  outputLabel: string;
  readyLabel: string;
  clearOutputTitle: string;
  runToSeeOutputHint: string;
  variablesLabel: string;
  kernelScopeLabel: string;
  liveCount: (count: number) => string;
  refreshVariablesTitle: string;
  noVariablesCaptured: string;

  // Lab.tsx — top-level / no-backend notice
  labBackendRequiredPrefix: string;
  labBackendRequiredSuffix: string;

  // Lab.tsx — kernel chip title
  kernelBusy: string;
  kernelStarting: string;
  kernelReady: string;
  kernelNotRunning: string;

  // Lab.tsx — editor tab fallback labels
  notebookFallbackLabel: string;
  fileFallbackLabel: string;

  // Lab.tsx — activity bar
  workbenchViewsAria: string;
  filesTab: string;
  notebookTab: string;
  runtimeTab: string;
  terminalTab: string;
  assistantTab: string;
  hideLabel: (name: string) => string;
  showLabel: (name: string) => string;

  // Lab.tsx — side panel
  explorerTitle: string;
  refreshLabel: string;
  openNotebookTitle: string;
  noNotebooksFound: string;
  openNotebookOption: string;
  newNotebookPathPlaceholder: string;
  newLabel: string;
  runHeading: string;
  kernelWord: string;
  noKernelWordLower: string;
  runAllTitle: string;
  runningProgressEllipsis: (done: number, total: number) => string;
  runAllCellsLabel: string;
  restartRunAllTitle: string;
  restartRunAllLabel: string;
  interruptTitle: string;
  interruptLabel: string;
  clearAllOutputsTitle: string;
  clearOutputsLabel: string;
  contentsHeading: string;
  inspectingLabel: string;
  runCellThenRefreshHint: string;
  runsHeading: string;
  noRunsYet: string;
  openExecutedLabel: string;
  parameterSweepHeading: string;
  workingLabel: string;
  runSweepLabel: string;
  exportManifestLabel: string;
  sweepRecorded: (id: string, ran: number, total: number) => string;
  manifestLabel: string;
  clearLabel: string;
  interpreterHeading: string;
  selectInterpreterNotebookTitle: string;
  activeLabel: string;
  noInterpreterSelected: string;
  kernelHintText: string;
  notebookKernelHeading: string;
  restartLabel: string;
  stopLabel: string;
  startKernelLabel: string;
  kernelsHeading: string;
  noKernelsDiscovered: string;
  resizeSidePanelAria: string;
  resizeSidePanelTitle: string;

  // Lab.tsx — editor tabs
  openEditorsAria: string;
  noEditorsOpen: string;
  previewTabTitle: (path: string) => string;
  pathTabTitle: (path: string, dirty: boolean) => string;
  unsavedCloseTitle: string;
  closeEditorTitle: string;
  closeLabel: string;
  closeOthersLabel: string;
  closeAllLabel: string;

  // Lab.tsx — empty workspace state
  startFromResearchFile: string;
  openNotebookOrCodeHint: string;
  openNotebookLabel: string;
  browseFilesLabel: string;
  askSomniqLabel: string;
  pythonJupyterHint: string;

  // Lab.tsx — empty notebook state
  thisNotebookEmpty: string;
  addCodeCellLabel: string;

  // Lab.tsx — terminal dock
  resizeTerminalAria: string;
  hideTerminalDockTitle: string;
  startingTerminalFallback: string;

  // Lab.tsx — assistant panel resize handle
  resizeAssistantAria: string;

  // Lab.tsx — status bar
  cellOfTotal: (selected: number, total: number) => string;
  cellsCount: (count: number) => string;
  runningProgressStatus: (done: number, total: number) => string;
  noKernelWordCapital: string;
  dismissLabel: string;

  // Lab.tsx — sweep spec validation errors
  sweepSpecMustBeObject: string;
  sweepSpecRequiresNotebook: string;
  seedsMustBeArray: string;
  paramsMustBeObject: string;
  paramKeyMustBeArray: (key: string) => string;
  stopOnErrorMustBeBoolean: string;
  timeoutSecsMustBeNumber: string;

  // Lab.tsx — CellView
  executionCountTitle: string;
  aiAddedCellTitle: string;
  aiModifiedCellTitle: string;
  cellActionsAria: string;
  runShiftEnterTitle: string;
  moveUpTitle: string;
  moveDownTitle: string;
  duplicateTitle: string;
  convertToMarkdownTitle: string;
  convertToCodeTitle: string;
  deleteCellTitle: string;
  doubleClickToEditTitle: string;
  emptyMarkdownCellHint: string;
  typeCodeHerePlaceholder: string;
  typeMarkdownHerePlaceholder: string;

  // Lab.tsx — InsertBar
  insertCodeCellTitle: string;
  insertMarkdownCellTitle: string;
  codeLabel: string;
  markdownLabel: string;

  // LabAssistant.tsx
  permissionOptionLabels: Record<"read-only" | "workspace-write" | "prompt" | "danger-full-access", string>;
  emptyAssistantResponse: string;
  labPreviewResponse: string;
  continueFromStoppedLabel: string;
  historyToggleTitle: string;
  newChatTitle: string;
  historyTitle: string;
  historyEmpty: string;
  historyMeta: (date: string, count: number) => string;
  chatTabLabel: string;
  modelFallbackLabel: string;
  checkingModelLabel: string;
  previewStatusModelLabel: string;
  browserProviderLabel: string;
  askAboutNotebookHint: string;
  explainNotebookStarter: string;
  explainNotebookPrompt: string;
  inspectProjectFilesStarter: string;
  inspectProjectFilesPrompt: string;
  modifyCodeStarter: string;
  modifyCodePrompt: string;
  labAssistantTabsAria: string;
  editingEarlierMessage: string;
  cancelLabel: string;
  askSomniqPlaceholder: string;
  configureModelFirstPlaceholder: string;
  noItemLabel: string;
  toolPermissionModeTitle: string;
  permissionFallbackOption: string;
  stopResponseTitle: string;
  sendMessageTitle: string;
  removeAttachmentAria: (name: string) => string;

  // LabFiles.tsx
  projectFallbackLabel: string;
  newFileTitle: string;
  newFolderTitle: string;
  refreshFilesTitle: string;
  openProjectFolderTitle: string;
  loadingLabel: string;
  emptyLabel: string;
  latexBuildFilesLabel: string;
  generatedFilesTitle: (count: number) => string;
  attachToAssistantLabel: string;
  renameOrMoveLabel: string;
  deleteLabel: string;
  newFilePathPrompt: string;
  newFolderPathPrompt: string;
  renameOrMoveToPrompt: string;
  deleteConfirm: (kind: string, path: string) => string;
  folderWord: string;
  fileWord: string;
  clickToPreviewHint: (path: string) => string;
  newExperimentComment: string;
  notesHeading: string;
  configurationComment: string;
}> = {
  cn: {
    terminalFailedToOpen: (error) => `打开终端失败: ${error}`,
    terminalProcessExited: "[进程已退出]",

    collapseOutput: "收起输出",
    showFullOutput: "显示完整输出",
    cellOutputAlt: "cell 输出",

    aiChangesDetected: "检测到 AI 修改",
    keepAiChanges: "保留",
    keepAiChangesTitle: "保留 AI 修改",
    restoreLabel: "恢复",
    restoreFileTitle: "恢复修改前内容",
    restoreNotebookTitle: "恢复修改前的 notebook",
    linesChangedAria: (added, removed) => `新增 ${added} 行，移除 ${removed} 行`,
    moreRemovedLines: (count) => `还有 ${count} 行删除`,
    addedCount: (count) => `+${count} 新增`,
    modifiedCount: (count) => `~${count} 修改`,
    removedCount: (count) => `-${count} 删除`,
    emptyCellPlaceholder: (cellType) => `(空 ${cellType} cell)`,
    moreRemovedCells: (count) => `还有 ${count} 个被删除的 cell`,

    runPythonFileTitle: "运行 Python 文件",
    runSelectionLineLabel: "运行所选/当前行",
    selectInterpreterKernelTitle: "选择 Python 解释器 / Jupyter 内核",
    noKernelsFound: "未找到内核",
    noInterpreter: "无解释器",
    cannotCompleteAction: "无法完成此 Lab 操作。",
    loadingFile: "正在加载文件...",
    startTypingPlaceholder: "开始输入...",
    selectFileToOpenHint: "从文件列表中选择一个文本文件以在此打开。",
    outputLabel: "输出",
    readyLabel: "就绪",
    clearOutputTitle: "清除输出",
    runToSeeOutputHint: "运行此 Python 文件或所选内容以在此查看内核输出。",
    variablesLabel: "变量",
    kernelScopeLabel: "内核作用域",
    liveCount: (count) => `${count} 个实时变量`,
    refreshVariablesTitle: "刷新变量",
    noVariablesCaptured: "尚未捕获任何变量。",

    labBackendRequiredPrefix: "Lab 需要通过桌面后端运行 Jupyter notebook。使用",
    labBackendRequiredSuffix: "启动应用以使用它。",

    kernelBusy: "内核繁忙",
    kernelStarting: "内核启动中...",
    kernelReady: "内核就绪",
    kernelNotRunning: "没有正在运行的内核",

    notebookFallbackLabel: "Notebook",
    fileFallbackLabel: "文件",

    workbenchViewsAria: "Lab 工作台视图",
    filesTab: "文件",
    notebookTab: "笔记本",
    runtimeTab: "运行时",
    terminalTab: "终端",
    assistantTab: "助手",
    hideLabel: (name) => `隐藏${name}`,
    showLabel: (name) => `显示${name}`,

    explorerTitle: "资源管理器",
    refreshLabel: "刷新",
    openNotebookTitle: "打开笔记本",
    noNotebooksFound: "未找到笔记本",
    openNotebookOption: "打开笔记本...",
    newNotebookPathPlaceholder: "notebooks/new-notebook.ipynb",
    newLabel: "新建",
    runHeading: "运行",
    kernelWord: "内核",
    noKernelWordLower: "无内核",
    runAllTitle: "从上到下运行所有代码 cell",
    runningProgressEllipsis: (done, total) => `运行中 ${done}/${total}...`,
    runAllCellsLabel: "运行所有 cell",
    restartRunAllTitle: "重启内核后运行所有 cell",
    restartRunAllLabel: "重启并运行全部",
    interruptTitle: "中断内核",
    interruptLabel: "中断",
    clearAllOutputsTitle: "清除所有输出",
    clearOutputsLabel: "清除输出",
    contentsHeading: "目录",
    inspectingLabel: "检查中...",
    runCellThenRefreshHint: "运行一个 cell，然后刷新以检查内核变量。",
    runsHeading: "运行记录",
    noRunsYet: "暂无运行记录。",
    openExecutedLabel: "打开已执行文件",
    parameterSweepHeading: "参数扫描",
    workingLabel: "处理中...",
    runSweepLabel: "运行扫描",
    exportManifestLabel: "导出清单",
    sweepRecorded: (id, ran, total) => `扫描 ${id}：已记录 ${ran}/${total} 次运行。`,
    manifestLabel: "清单",
    clearLabel: "清除",
    interpreterHeading: "解释器",
    selectInterpreterNotebookTitle: "选择 Python 解释器 / 笔记本内核",
    activeLabel: "当前",
    noInterpreterSelected: "未选择解释器",
    kernelHintText: "Lab 使用已安装的 Jupyter kernelspec。Python 文件在文件级内核会话中运行；笔记本会将此选择持久化到 nbformat 元数据中。",
    notebookKernelHeading: "笔记本内核",
    restartLabel: "重启",
    stopLabel: "停止",
    startKernelLabel: "启动内核",
    kernelsHeading: "内核列表",
    noKernelsDiscovered: "未发现内核。",
    resizeSidePanelAria: "调整 Lab 侧栏大小",
    resizeSidePanelTitle: "调整侧栏大小",

    openEditorsAria: "已打开的编辑器",
    noEditorsOpen: "未打开任何编辑器",
    previewTabTitle: (path) => `${path}（预览 — 双击以固定）`,
    pathTabTitle: (path, dirty) => `${path}${dirty ? "（未保存）" : ""}`,
    unsavedCloseTitle: "有未保存的更改 — 点击关闭",
    closeEditorTitle: "关闭编辑器",
    closeLabel: "关闭",
    closeOthersLabel: "关闭其他",
    closeAllLabel: "关闭全部",

    startFromResearchFile: "从一个研究文件开始",
    openNotebookOrCodeHint: "打开一个笔记本或代码文件，让 SomniQ 帮你检查、运行并改进它。",
    openNotebookLabel: "打开笔记本",
    browseFilesLabel: "浏览文件",
    askSomniqLabel: "询问 SomniQ",
    pythonJupyterHint: "Python · Jupyter Notebook · 项目文件",

    thisNotebookEmpty: "此笔记本为空。",
    addCodeCellLabel: "添加代码 cell",

    resizeTerminalAria: "调整终端大小",
    hideTerminalDockTitle: "隐藏终端",
    startingTerminalFallback: "正在启动终端…",

    resizeAssistantAria: "调整 Lab 助手大小",

    cellOfTotal: (selected, total) => `第 ${selected} 个 cell，共 ${total} 个`,
    cellsCount: (count) => `${count} 个 cell`,
    runningProgressStatus: (done, total) => `运行中 ${done}/${total}`,
    noKernelWordCapital: "无内核",
    dismissLabel: "关闭",

    sweepSpecMustBeObject: "扫描参数必须是一个 JSON 对象。",
    sweepSpecRequiresNotebook: "扫描参数需要指定 notebook。",
    seedsMustBeArray: "seeds 必须是数字数组。",
    paramsMustBeObject: "params 必须是一个由数组值组成的对象。",
    paramKeyMustBeArray: (key) => `params.${key} 必须是一个数组。`,
    stopOnErrorMustBeBoolean: "stop_on_error 必须是布尔值。",
    timeoutSecsMustBeNumber: "timeout_secs 必须是数字。",

    executionCountTitle: "执行计数",
    aiAddedCellTitle: "AI 新增的 cell",
    aiModifiedCellTitle: "AI 修改的 cell",
    cellActionsAria: "cell 操作",
    runShiftEnterTitle: "运行 (Shift+Enter)",
    moveUpTitle: "上移",
    moveDownTitle: "下移",
    duplicateTitle: "复制",
    convertToMarkdownTitle: "转换为 Markdown (m)",
    convertToCodeTitle: "转换为代码 (y)",
    deleteCellTitle: "删除 (dd)",
    doubleClickToEditTitle: "双击以编辑",
    emptyMarkdownCellHint: "空的 Markdown cell - 双击以编辑",
    typeCodeHerePlaceholder: "在此输入代码...",
    typeMarkdownHerePlaceholder: "在此输入 Markdown...",

    insertCodeCellTitle: "在此插入代码 cell",
    insertMarkdownCellTitle: "在此插入 Markdown cell",
    codeLabel: "代码",
    markdownLabel: "Markdown",

    permissionOptionLabels: {
      "read-only": "计划",
      "workspace-write": "接受编辑",
      prompt: "询问",
      "danger-full-access": "自动批准",
    },
    emptyAssistantResponse: "模型返回了空回复。",
    labPreviewResponse: "浏览器预览回复。运行 Tauri 应用可使用实时 Lab 助手。",
    continueFromStoppedLabel: "从上次停止的地方继续。",
    historyToggleTitle: "Lab 对话历史",
    newChatTitle: "新建 Lab 对话",
    historyTitle: "历史记录",
    historyEmpty: "暂无 Lab Chat 历史",
    historyMeta: (date, count) => `${date} · ${count} 条消息`,
    chatTabLabel: "对话",
    modelFallbackLabel: "模型",
    checkingModelLabel: "检查模型中...",
    previewStatusModelLabel: "预览",
    browserProviderLabel: "浏览器",
    askAboutNotebookHint: "询问当前笔记本或工作区的相关问题。",
    explainNotebookStarter: "解释这个笔记本",
    explainNotebookPrompt: "解释当前笔记本，并指出下一步值得进行的实验。",
    inspectProjectFilesStarter: "检查项目文件",
    inspectProjectFilesPrompt: "检查当前项目文件，并建议下一步代码改动应在何处进行。",
    modifyCodeStarter: "修改代码",
    modifyCodePrompt: "修改此 Lab 工作流所需的代码，然后总结已更改的文件。",
    labAssistantTabsAria: "Lab 助手标签页",
    editingEarlierMessage: "正在编辑较早的消息",
    cancelLabel: "取消",
    askSomniqPlaceholder: "让 SomniQ 解释、检查或修改代码...",
    configureModelFirstPlaceholder: "请先在设置中配置模型",
    noItemLabel: "无项目",
    toolPermissionModeTitle: "工具权限模式",
    permissionFallbackOption: "权限",
    stopResponseTitle: "停止回复",
    sendMessageTitle: "发送消息",
    removeAttachmentAria: (name) => `移除 ${name}`,

    projectFallbackLabel: "项目",
    newFileTitle: "新建文件",
    newFolderTitle: "新建文件夹",
    refreshFilesTitle: "刷新文件",
    openProjectFolderTitle: "在外部打开项目文件夹",
    loadingLabel: "加载中...",
    emptyLabel: "空",
    latexBuildFilesLabel: "LaTeX 构建文件",
    generatedFilesTitle: (count) => `${count} 个由 LaTeX 编译生成的文件`,
    attachToAssistantLabel: "附加到助手",
    renameOrMoveLabel: "重命名 / 移动",
    deleteLabel: "删除",
    newFilePathPrompt: "新文件路径",
    newFolderPathPrompt: "新文件夹路径",
    renameOrMoveToPrompt: "重命名或移动到",
    deleteConfirm: (kind, path) => `删除${kind} "${path}"？`,
    folderWord: "文件夹",
    fileWord: "文件",
    clickToPreviewHint: (path) => `${path}\n点击预览，双击以固定。右键查看更多操作。`,
    newExperimentComment: "# 新实验\n",
    notesHeading: "# 笔记\n",
    configurationComment: "# 配置\n",
  },
  en: {
    terminalFailedToOpen: (error) => `Failed to open terminal: ${error}`,
    terminalProcessExited: "[process exited]",

    collapseOutput: "Collapse output",
    showFullOutput: "Show full output",
    cellOutputAlt: "cell output",

    aiChangesDetected: "AI changes detected",
    keepAiChanges: "Keep",
    keepAiChangesTitle: "Keep AI changes",
    restoreLabel: "Restore",
    restoreFileTitle: "Restore content from before the change",
    restoreNotebookTitle: "Restore the notebook from before the change",
    linesChangedAria: (added, removed) => `${added} lines added, ${removed} lines removed`,
    moreRemovedLines: (count) => `${count} more removed lines`,
    addedCount: (count) => `+${count} added`,
    modifiedCount: (count) => `~${count} modified`,
    removedCount: (count) => `-${count} deleted`,
    emptyCellPlaceholder: (cellType) => `(empty ${cellType} cell)`,
    moreRemovedCells: (count) => `${count} more deleted cells`,

    runPythonFileTitle: "Run Python File",
    runSelectionLineLabel: "Run Selection/Line",
    selectInterpreterKernelTitle: "Select Python interpreter / Jupyter kernel",
    noKernelsFound: "No kernels found",
    noInterpreter: "No interpreter",
    cannotCompleteAction: "Cannot complete this Lab action.",
    loadingFile: "Loading file...",
    startTypingPlaceholder: "Start typing...",
    selectFileToOpenHint: "Select a text file from Files to open it here.",
    outputLabel: "Output",
    readyLabel: "Ready",
    clearOutputTitle: "Clear output",
    runToSeeOutputHint: "Run this Python file or a selection to see kernel output here.",
    variablesLabel: "Variables",
    kernelScopeLabel: "Kernel scope",
    liveCount: (count) => `${count} live`,
    refreshVariablesTitle: "Refresh variables",
    noVariablesCaptured: "No variables captured yet.",

    labBackendRequiredPrefix: "The Lab runs Jupyter notebooks through the desktop backend. Launch the app with",
    labBackendRequiredSuffix: "to use it.",

    kernelBusy: "Kernel busy",
    kernelStarting: "Kernel starting...",
    kernelReady: "Kernel ready",
    kernelNotRunning: "No kernel running",

    notebookFallbackLabel: "Notebook",
    fileFallbackLabel: "File",

    workbenchViewsAria: "Lab workbench views",
    filesTab: "Files",
    notebookTab: "Notebook",
    runtimeTab: "Runtime",
    terminalTab: "Terminal",
    assistantTab: "Assistant",
    hideLabel: (name) => `Hide ${name}`,
    showLabel: (name) => `Show ${name}`,

    explorerTitle: "Explorer",
    refreshLabel: "Refresh",
    openNotebookTitle: "Open notebook",
    noNotebooksFound: "No notebooks found",
    openNotebookOption: "Open notebook...",
    newNotebookPathPlaceholder: "notebooks/new-notebook.ipynb",
    newLabel: "New",
    runHeading: "Run",
    kernelWord: "kernel",
    noKernelWordLower: "no kernel",
    runAllTitle: "Run every code cell top to bottom",
    runningProgressEllipsis: (done, total) => `Running ${done}/${total}...`,
    runAllCellsLabel: "Run all cells",
    restartRunAllTitle: "Restart the kernel, then run all cells",
    restartRunAllLabel: "Restart & Run all",
    interruptTitle: "Interrupt the kernel",
    interruptLabel: "Interrupt",
    clearAllOutputsTitle: "Clear all outputs",
    clearOutputsLabel: "Clear outputs",
    contentsHeading: "Contents",
    inspectingLabel: "Inspecting...",
    runCellThenRefreshHint: "Run a cell, then refresh to inspect kernel variables.",
    runsHeading: "Runs",
    noRunsYet: "No runs yet.",
    openExecutedLabel: "Open executed",
    parameterSweepHeading: "Parameter sweep",
    workingLabel: "Working...",
    runSweepLabel: "Run sweep",
    exportManifestLabel: "Export manifest",
    sweepRecorded: (id, ran, total) => `Sweep ${id}: ${ran}/${total} runs recorded.`,
    manifestLabel: "Manifest",
    clearLabel: "Clear",
    interpreterHeading: "Interpreter",
    selectInterpreterNotebookTitle: "Select Python interpreter / notebook kernel",
    activeLabel: "Active",
    noInterpreterSelected: "No interpreter selected",
    kernelHintText: "Lab uses installed Jupyter kernelspecs. Python files run against a file-scoped kernel session; notebooks persist this choice into nbformat metadata.",
    notebookKernelHeading: "Notebook Kernel",
    restartLabel: "Restart",
    stopLabel: "Stop",
    startKernelLabel: "Start kernel",
    kernelsHeading: "Kernels",
    noKernelsDiscovered: "No kernels discovered.",
    resizeSidePanelAria: "Resize Lab side panel",
    resizeSidePanelTitle: "Resize side panel",

    openEditorsAria: "Open editors",
    noEditorsOpen: "No editors open",
    previewTabTitle: (path) => `${path} (preview — double-click to keep open)`,
    pathTabTitle: (path, dirty) => `${path}${dirty ? " (unsaved)" : ""}`,
    unsavedCloseTitle: "Unsaved changes — click to close",
    closeEditorTitle: "Close editor",
    closeLabel: "Close",
    closeOthersLabel: "Close others",
    closeAllLabel: "Close all",

    startFromResearchFile: "Start from a research file",
    openNotebookOrCodeHint: "Open a notebook or code file, then let SomniQ help you inspect, run, and improve it.",
    openNotebookLabel: "Open notebook",
    browseFilesLabel: "Browse files",
    askSomniqLabel: "Ask SomniQ",
    pythonJupyterHint: "Python · Jupyter Notebook · project files",

    thisNotebookEmpty: "This notebook is empty.",
    addCodeCellLabel: "Add a code cell",

    resizeTerminalAria: "Resize terminal",
    hideTerminalDockTitle: "Hide terminal",
    startingTerminalFallback: "Starting terminal…",

    resizeAssistantAria: "Resize Lab Assistant",

    cellOfTotal: (selected, total) => `Cell ${selected} of ${total}`,
    cellsCount: (count) => `${count} cells`,
    runningProgressStatus: (done, total) => `Running ${done}/${total}`,
    noKernelWordCapital: "No kernel",
    dismissLabel: "dismiss",

    sweepSpecMustBeObject: "Sweep spec must be a JSON object.",
    sweepSpecRequiresNotebook: "Sweep spec requires notebook.",
    seedsMustBeArray: "seeds must be an array of numbers.",
    paramsMustBeObject: "params must be an object of value arrays.",
    paramKeyMustBeArray: (key) => `params.${key} must be an array.`,
    stopOnErrorMustBeBoolean: "stop_on_error must be a boolean.",
    timeoutSecsMustBeNumber: "timeout_secs must be a number.",

    executionCountTitle: "Execution count",
    aiAddedCellTitle: "Cell added by AI",
    aiModifiedCellTitle: "Cell modified by AI",
    cellActionsAria: "Cell actions",
    runShiftEnterTitle: "Run (Shift+Enter)",
    moveUpTitle: "Move up",
    moveDownTitle: "Move down",
    duplicateTitle: "Duplicate",
    convertToMarkdownTitle: "Convert to Markdown (m)",
    convertToCodeTitle: "Convert to Code (y)",
    deleteCellTitle: "Delete (dd)",
    doubleClickToEditTitle: "Double-click to edit",
    emptyMarkdownCellHint: "Empty markdown cell - double-click to edit",
    typeCodeHerePlaceholder: "Type code here...",
    typeMarkdownHerePlaceholder: "Type Markdown here...",

    insertCodeCellTitle: "Insert code cell here",
    insertMarkdownCellTitle: "Insert markdown cell here",
    codeLabel: "Code",
    markdownLabel: "Markdown",

    permissionOptionLabels: {
      "read-only": "Plan",
      "workspace-write": "Accept edits",
      prompt: "Ask",
      "danger-full-access": "Auto-approve",
    },
    emptyAssistantResponse: "Model returned an empty response.",
    labPreviewResponse: "Browser preview response. Run the Tauri app for live Lab Assistant.",
    continueFromStoppedLabel: "Continue from where you stopped.",
    historyToggleTitle: "Lab chat history",
    newChatTitle: "New Lab chat",
    historyTitle: "History",
    historyEmpty: "No Lab chat history yet",
    historyMeta: (date, count) => `${date} · ${count} messages`,
    chatTabLabel: "CHAT",
    modelFallbackLabel: "Model",
    checkingModelLabel: "Checking model...",
    previewStatusModelLabel: "Preview",
    browserProviderLabel: "Browser",
    askAboutNotebookHint: "Ask about the current notebook or workspace.",
    explainNotebookStarter: "Explain this notebook",
    explainNotebookPrompt: "Explain the current notebook and identify the next useful experiment.",
    inspectProjectFilesStarter: "Inspect project files",
    inspectProjectFilesPrompt: "Inspect the current project files and suggest where to implement the next code change.",
    modifyCodeStarter: "Modify code",
    modifyCodePrompt: "Modify the code needed for this Lab workflow, then summarize the changed files.",
    labAssistantTabsAria: "Lab assistant tabs",
    editingEarlierMessage: "Editing earlier message",
    cancelLabel: "Cancel",
    askSomniqPlaceholder: "Ask SomniQ to explain, inspect, or change code...",
    configureModelFirstPlaceholder: "Configure a model in Settings first",
    noItemLabel: "No item",
    toolPermissionModeTitle: "Tool permission mode",
    permissionFallbackOption: "Permission",
    stopResponseTitle: "Stop response",
    sendMessageTitle: "Send message",
    removeAttachmentAria: (name) => `Remove ${name}`,

    projectFallbackLabel: "Project",
    newFileTitle: "New file",
    newFolderTitle: "New folder",
    refreshFilesTitle: "Refresh files",
    openProjectFolderTitle: "Open project folder externally",
    loadingLabel: "Loading...",
    emptyLabel: "Empty",
    latexBuildFilesLabel: "LaTeX build files",
    generatedFilesTitle: (count) => `${count} generated files created by LaTeX compilation`,
    attachToAssistantLabel: "Attach to assistant",
    renameOrMoveLabel: "Rename / Move",
    deleteLabel: "Delete",
    newFilePathPrompt: "New file path",
    newFolderPathPrompt: "New folder path",
    renameOrMoveToPrompt: "Rename or move to",
    deleteConfirm: (kind, path) => `Delete ${kind} "${path}"?`,
    folderWord: "folder",
    fileWord: "file",
    clickToPreviewHint: (path) => `${path}\nClick to preview, double-click to keep open. Right-click for more actions.`,
    newExperimentComment: "# New experiment\n",
    notesHeading: "# Notes\n",
    configurationComment: "# Configuration\n",
  },
};
