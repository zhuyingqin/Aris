import type { Language } from "../store";

export const CHAT_COPY: Record<Language, {
  newChat: string;
  scheduledTasks: string;
  closeSidebar: string;
  searchChats: string;
  noMatchingChats: string;
  chatsCount: (count: number) => string;
  collapsed: string;
  expanded: string;
  newChatInProject: (project: string) => string;
  newChatInThisProject: string;
  unread: string;
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
  undo: string;
  deleted: (title: string) => string;
  previewModel: string;
  browserProvider: string;
  previewPermissionDescription: string;
  disabledCommand: string;
  previewCommandReply: string;
  previewResponse: string;
  emptyResponse: string;
  responseStopped: string;
  stoppedByUser: string;
  responseFailed: string;
  retry: string;
  copy: string;
  copied: string;
  editAndResend: string;
  continue: string;
  image: string;
  file: string;
}> = {
  cn: {
    newChat: "新线程",
    scheduledTasks: "定时任务",
    closeSidebar: "关闭对话侧栏",
    searchChats: "搜索对话",
    noMatchingChats: "无匹配对话",
    chatsCount: (count) => `${count} 个对话`,
    collapsed: "已折叠",
    expanded: "已展开",
    newChatInProject: (project) => `在 ${project} 中新建对话`,
    newChatInThisProject: "在此项目中新建对话",
    unread: "未读",
    messagePlaceholder: "向 SomniQ 发送消息",
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
    undo: "撤销",
    deleted: (title) => `已删除“${title}”`,
    previewModel: "预览",
    browserProvider: "浏览器",
    previewPermissionDescription: "自动批准工具调用；不会请求操作系统管理员权限",
    disabledCommand: "此桌面命令在当前构建中已禁用。",
    previewCommandReply: "桌面斜杠命令需要在 Tauri 应用内运行。",
    previewResponse: "浏览器预览回复。运行 Tauri 应用可使用实时对话。",
    emptyResponse: "模型返回了空回复。",
    responseStopped: "回复已停止",
    stoppedByUser: "已由用户停止。",
    responseFailed: "回复失败",
    retry: "重试",
    copy: "复制",
    copied: "已复制",
    editAndResend: "编辑并重新发送",
    continue: "继续",
    image: "图片",
    file: "文件",
  },
  en: {
    newChat: "New chat",
    scheduledTasks: "Scheduled tasks",
    closeSidebar: "Close chat sidebar",
    searchChats: "Search chats",
    noMatchingChats: "No matching chats",
    chatsCount: (count) => `${count} chats`,
    collapsed: "collapsed",
    expanded: "expanded",
    newChatInProject: (project) => `New chat in ${project}`,
    newChatInThisProject: "New chat in this project",
    unread: "Unread",
    messagePlaceholder: "Message SomniQ",
    configurePlaceholder: "Configure an API key, or type /help",
    slashMenu: "Slash menu",
    files: "Files",
    pickerHint: "Up/Down select · Enter use · Esc close",
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
    checking: "Checking...",
    settings: "Settings",
    exportChat: "Export current chat",
    undo: "Undo",
    deleted: (title) => `Deleted "${title}"`,
    previewModel: "Preview",
    browserProvider: "Browser",
    previewPermissionDescription: "Auto-approve tool calls; no OS administrator elevation",
    disabledCommand: "This desktop command is disabled in this build.",
    previewCommandReply: "Desktop slash commands run inside the Tauri app.",
    previewResponse: "Browser preview response. Run the Tauri app for live Chat.",
    emptyResponse: "Model returned an empty response.",
    responseStopped: "Response stopped",
    stoppedByUser: "Stopped by user.",
    responseFailed: "Response failed",
    retry: "Retry",
    copy: "Copy",
    copied: "Copied",
    editAndResend: "Edit and resend",
    continue: "Continue",
    image: "Image",
    file: "File",
  },
};
