import type { Language } from "../store";

export const CHAT_COPY: Record<Language, {
  newChat: string;
  scheduledTasks: string;
  closeSidebar: string;
  openSidebar: string;
  noMatchingChats: string;
  chatsCount: (count: number) => string;
  collapsed: string;
  expanded: string;
  pinnedSection: string;
  projectsSection: string;
  showMoreChats: string;
  showFewerChats: string;
  collapseProject: (project: string) => string;
  expandProject: (project: string) => string;
  newChatInProject: (project: string) => string;
  newChatInThisProject: string;
  unread: string;
  running: string;
  messagePlaceholder: string;
  configurePlaceholder: string;
  slashMenu: string;
  files: string;
  pickerHint: string;
  noMatches: string;
  recent: string;
  searchResults: string;
  dropFiles: string;
  removeAttachment: (name: string) => string;
  editingNotice: string;
  cancel: string;
  permissionMode: string;
  attachFiles: string;
  switchModel: string;
  switchModelNextTurn: string;
  activeModel: string;
  stopResponse: string;
  sendMessage: string;
  resendEditedMessage: string;
  permissionLabels: Record<string, string>;
  checking: string;
  settings: string;
  exportChat: string;
  exportDebugZip: string;
  undo: string;
  deleted: (title: string) => string;
  previewModel: string;
  browserProvider: string;
  previewPermissionDescription: string;
  previewCommandReply: string;
  previewResponse: string;
  emptyResponse: string;
  waitingForModel: string;
  modelWaitHint: string;
  modelWaitStalledHint: string;
  compactingContext: string;
  compactionHint: string;
  toolRunning: string;
  toolFailed: string;
  toolSucceeded: string;
  toolModified: string;
  inspectedFiles: (count: number) => string;
  inspectionDetails: string;
  thinking: string;
  thought: string;
  responseStopped: string;
  stoppedByUser: string;
  responseFailed: string;
  retry: string;
  copy: string;
  copied: string;
  editAndResend: string;
  expandMessage: string;
  collapseMessage: string;
  continue: string;
  image: string;
  file: string;
  /** Slash-menu group headings, keyed by the picker's internal group id. */
  slashGroups: Record<"System commands" | "Recent skills" | "All skills", string>;
}> = {
  cn: {
    newChat: "新建任务",
    scheduledTasks: "定时任务",
    closeSidebar: "关闭对话侧栏",
    openSidebar: "打开对话列表",
    noMatchingChats: "暂无对话",
    chatsCount: (count) => `${count} 个对话`,
    collapsed: "已折叠",
    expanded: "已展开",
    pinnedSection: "置顶",
    projectsSection: "项目",
    showMoreChats: "更多对话",
    showFewerChats: "收起对话",
    collapseProject: (project) => `收起项目 ${project}`,
    expandProject: (project) => `展开项目 ${project}`,
    newChatInProject: (project) => `在 ${project} 中新建任务`,
    newChatInThisProject: "在此项目中新建任务",
    unread: "未读",
    running: "运行中",
    messagePlaceholder: "给 SomniQ 发送消息",
    configurePlaceholder: "配置 API Key，或输入 /help",
    slashMenu: "斜杠菜单",
    files: "文件",
    pickerHint: "上下选择 · Enter 使用 · Esc 关闭",
    noMatches: "无匹配项",
    recent: "最近",
    searchResults: "搜索结果",
    dropFiles: "拖放文件以附加",
    removeAttachment: (name) => `移除 ${name}`,
    editingNotice: "正在编辑较早的消息。发送后会替换后续对话。",
    cancel: "取消",
    permissionMode: "权限模式",
    attachFiles: "附加文件",
    switchModel: "切换模型",
    switchModelNextTurn: "为下一轮切换模型",
    activeModel: "当前模型",
    stopResponse: "停止回复",
    sendMessage: "发送消息",
    resendEditedMessage: "重新发送编辑后的消息",
    permissionLabels: {
      "read-only": "计划",
      "workspace-write": "接受编辑",
      prompt: "询问",
      "danger-full-access": "自动批准",
    },
    checking: "检查中...",
    settings: "设置",
    exportChat: "导出当前对话",
    exportDebugZip: "导出故障调试包（运行中可用）",
    undo: "撤销",
    deleted: (title) => `已删除“${title}”`,
    previewModel: "预览",
    browserProvider: "浏览器",
    previewPermissionDescription: "自动批准工具调用；不会请求操作系统管理员权限",
    previewCommandReply: "桌面斜杠命令需要在 Tauri 应用内运行。",
    previewResponse: "浏览器预览回复。运行 Tauri 应用可使用实时对话。",
    emptyResponse: "模型返回了空回复。",
    waitingForModel: "等待模型响应 ·",
    modelWaitHint: "深度推理可能需要几分钟，可随时停止。",
    modelWaitStalledHint: "已超过默认的 10 分钟等待上限，模型可能卡住了，可以停止后重试。",
    compactingContext: "正在压缩上下文 ·",
    compactionHint: "对话较长，需要先总结较早的历史，可随时停止。",
    toolRunning: "运行中",
    toolFailed: "失败",
    toolSucceeded: "已完成",
    toolModified: "已修改文件",
    inspectedFiles: (count) => `已完成 ${count} 次读取与搜索`,
    inspectionDetails: "展开查看记录",
    thinking: "正在思考",
    thought: "已思考",
    responseStopped: "回复已停止",
    stoppedByUser: "已由用户停止。",
    responseFailed: "回复失败",
    retry: "重试",
    copy: "复制",
    copied: "已复制",
    editAndResend: "编辑并重新发送",
    expandMessage: "展开全文",
    collapseMessage: "收起",
    continue: "继续",
    image: "图片",
    file: "文件",
    slashGroups: { "System commands": "系统命令", "Recent skills": "最近使用的 Skill", "All skills": "全部 Skill" },
  },
  en: {
    newChat: "New task",
    scheduledTasks: "Scheduled tasks",
    closeSidebar: "Close chat sidebar",
    openSidebar: "Open chat list",
    noMatchingChats: "No chats yet",
    chatsCount: (count) => `${count} ${count === 1 ? "chat" : "chats"}`,
    collapsed: "collapsed",
    expanded: "expanded",
    pinnedSection: "Pinned",
    projectsSection: "Projects",
    showMoreChats: "Show more",
    showFewerChats: "Show less",
    collapseProject: (project) => `Collapse project ${project}`,
    expandProject: (project) => `Expand project ${project}`,
    newChatInProject: (project) => `New task in ${project}`,
    newChatInThisProject: "New task in this project",
    unread: "Unread",
    running: "Running",
    messagePlaceholder: "Message SomniQ",
    configurePlaceholder: "Configure an API key, or type /help",
    slashMenu: "Slash menu",
    files: "Files",
    pickerHint: "↑↓ to select · Enter to use · Esc to close",
    noMatches: "No matches",
    recent: "Recent",
    searchResults: "Search results",
    dropFiles: "Drop files to attach",
    removeAttachment: (name) => `Remove ${name}`,
    editingNotice: "Editing an earlier message. Sending will replace later turns.",
    cancel: "Cancel",
    permissionMode: "Permission mode",
    attachFiles: "Attach files",
    switchModel: "Switch model",
    switchModelNextTurn: "Switch model for the next turn",
    activeModel: "Active model",
    stopResponse: "Stop response",
    sendMessage: "Send message",
    resendEditedMessage: "Resend edited message",
    permissionLabels: {
      "read-only": "Plan",
      "workspace-write": "Accept edits",
      prompt: "Ask",
      "danger-full-access": "Auto-approve",
    },
    checking: "Checking…",
    settings: "Settings",
    exportChat: "Export current chat",
    exportDebugZip: "Export debug bundle (available while running)",
    undo: "Undo",
    deleted: (title) => `Deleted "${title}"`,
    previewModel: "Preview",
    browserProvider: "Browser",
    previewPermissionDescription: "Auto-approves tool calls; never requests OS administrator privileges",
    previewCommandReply: "Desktop slash commands run inside the Tauri app.",
    previewResponse: "Browser preview response. Run the Tauri app for live chat.",
    emptyResponse: "Model returned an empty response.",
    waitingForModel: "Waiting for the model ·",
    modelWaitHint: "Deep reasoning may take a few minutes. You can stop at any time.",
    modelWaitStalledHint: "This is past the default 10-minute wait limit. The model may be stuck; you can stop and retry.",
    compactingContext: "Compacting context ·",
    compactionHint: "This conversation is long, so earlier history is being summarized first. You can stop at any time.",
    toolRunning: "Running",
    toolFailed: "Failed",
    toolSucceeded: "Succeeded",
    toolModified: "Modified file",
    inspectedFiles: (count) => `Ran ${count} ${count === 1 ? "read or search" : "reads and searches"}`,
    inspectionDetails: "Show activity details",
    thinking: "Thinking",
    thought: "Thought",
    responseStopped: "Response stopped",
    stoppedByUser: "Stopped by user.",
    responseFailed: "Response failed",
    retry: "Retry",
    copy: "Copy",
    copied: "Copied",
    editAndResend: "Edit and resend",
    expandMessage: "Show more",
    collapseMessage: "Show less",
    continue: "Continue",
    image: "Image",
    file: "File",
    slashGroups: { "System commands": "System commands", "Recent skills": "Recent skills", "All skills": "All skills" },
  },
  es: {
    newChat: "Nueva tarea",
    scheduledTasks: "Tareas programadas",
    closeSidebar: "Cerrar la barra lateral de chats",
    openSidebar: "Abrir la lista de chats",
    noMatchingChats: "Aún no hay chats",
    chatsCount: (count) => `${count} ${count === 1 ? "chat" : "chats"}`,
    collapsed: "contraído",
    expanded: "expandido",
    pinnedSection: "Fijados",
    projectsSection: "Proyectos",
    showMoreChats: "Ver más",
    showFewerChats: "Ver menos",
    collapseProject: (project) => `Contraer el proyecto ${project}`,
    expandProject: (project) => `Expandir el proyecto ${project}`,
    newChatInProject: (project) => `Nueva tarea en ${project}`,
    newChatInThisProject: "Nueva tarea en este proyecto",
    unread: "No leído",
    running: "En ejecución",
    messagePlaceholder: "Escribe a SomniQ",
    configurePlaceholder: "Configura una clave de API o escribe /help",
    slashMenu: "Menú de barra",
    files: "Archivos",
    pickerHint: "↑↓ seleccionar · Enter usar · Esc cerrar",
    noMatches: "Sin coincidencias",
    recent: "Recientes",
    searchResults: "Resultados de búsqueda",
    dropFiles: "Suelta archivos para adjuntarlos",
    removeAttachment: (name) => `Quitar ${name}`,
    editingNotice: "Estás editando un mensaje anterior. Al enviarlo se reemplazarán los turnos posteriores.",
    cancel: "Cancelar",
    permissionMode: "Modo de permisos",
    attachFiles: "Adjuntar archivos",
    switchModel: "Cambiar modelo",
    switchModelNextTurn: "Cambiar el modelo para el siguiente turno",
    activeModel: "Modelo activo",
    stopResponse: "Detener respuesta",
    sendMessage: "Enviar mensaje",
    resendEditedMessage: "Reenviar el mensaje editado",
    permissionLabels: {
      "read-only": "Planificar",
      "workspace-write": "Aceptar ediciones",
      prompt: "Preguntar",
      "danger-full-access": "Aprobar automáticamente",
    },
    checking: "Comprobando…",
    settings: "Ajustes",
    exportChat: "Exportar el chat actual",
    exportDebugZip: "Exportar paquete de depuración (disponible durante la ejecución)",
    undo: "Deshacer",
    deleted: (title) => `Se eliminó "${title}"`,
    previewModel: "Vista previa",
    browserProvider: "Navegador",
    previewPermissionDescription: "Aprueba automáticamente las llamadas a herramientas; sin elevación de administrador del sistema",
    previewCommandReply: "Los comandos de barra del escritorio se ejecutan dentro de la app Tauri.",
    previewResponse: "Respuesta de vista previa del navegador. Ejecuta la app Tauri para usar el chat en vivo.",
    emptyResponse: "El modelo devolvió una respuesta vacía.",
    waitingForModel: "Esperando al modelo ·",
    modelWaitHint: "El razonamiento profundo puede tardar unos minutos. Puedes detenerlo en cualquier momento.",
    modelWaitStalledHint: "Se superó el límite de espera predeterminado de 10 minutos. Puede que el modelo esté bloqueado; puedes detenerlo y reintentar.",
    compactingContext: "Compactando el contexto ·",
    compactionHint: "La conversación es larga, así que primero se resume el historial anterior. Puedes detenerlo en cualquier momento.",
    toolRunning: "En ejecución",
    toolFailed: "Falló",
    toolSucceeded: "Completado",
    toolModified: "Archivo modificado",
    inspectedFiles: (count) => `${count} ${count === 1 ? "lectura o búsqueda completada" : "lecturas y búsquedas completadas"}`,
    inspectionDetails: "Ver detalles de la actividad",
    thinking: "Pensando",
    thought: "Pensado",
    responseStopped: "Respuesta detenida",
    stoppedByUser: "Detenido por el usuario.",
    responseFailed: "La respuesta falló",
    retry: "Reintentar",
    copy: "Copiar",
    copied: "Copiado",
    editAndResend: "Editar y reenviar",
    expandMessage: "Ver más",
    collapseMessage: "Ver menos",
    continue: "Continuar",
    image: "Imagen",
    file: "Archivo",
    slashGroups: { "System commands": "Comandos del sistema", "Recent skills": "Skills recientes", "All skills": "Todas las skills" },
  },
};
