import type { Language } from "../store";
import type { MailAccount, MailFolder, MailMessageFull, MailMessageSummary } from "../types";

interface MailFolderLabels {
  inbox: string;
  sent: string;
  drafts: string;
  archive: string;
  spam: string;
  trash: string;
  starred: string;
  important: string;
  /** Fallback label when no folder is resolved yet (list-tabs default). */
  genericMail: string;
}

interface MailDemoData {
  accountDisplayName: string;
  /** Must match the label text used in `messages` for the "important" tag,
   *  so the browser-preview folder filter keeps working per language. */
  importantLabel: string;
  messages: MailMessageSummary[];
  fullMessages: Record<string, MailMessageFull>;
}

interface MailCopyShape {
  folderLabels: MailFolderLabels;
  compose: string;
  composeNewTitle: string;
  folderNavAriaLabel: string;
  settingsNav: string;
  overviewKicker: string;
  unreadLabel: string;
  foldersLabel: string;
  overviewSummary: (folderLabel: string, count: number) => string;
  overviewSummaryEmpty: string;
  assistantTitle: string;
  assistantSidebarDesc: string;
  searchAriaLabel: string;
  searchPlaceholder: string;
  previewBadge: string;
  toggleAssistant: (open: boolean) => string;
  notifications: string;
  help: string;
  refresh: string;
  mailCountSuffix: (count: number) => string;
  noMatchingMail: string;
  emptyFolder: string;
  tryDifferentKeyword: string;
  newMailHint: string;
  loadingMail: string;
  loadMore: string;
  resizeListLabel: string;
  resizeAssistantLabel: string;
  noPreviewContent: string;
  noBodyText: string;
  unreadBadge: string;
  starredBadge: string;
  toggleStar: (starred: boolean) => string;
  openingMail: string;
  selectMailPrompt: string;
  forwardOpenedNotice: string;
  snoozeNotice: string;
  quickReplyPlaceholder: (replyAll: boolean) => string;
  recipientsLine: (to: string, cc: string) => string;
  reply: string;
  replyAll: string;
  forward: string;
  snooze: string;
  moreMailActionsAria: string;
  toggleUnreadLabel: (unread: boolean) => string;
  archive: string;
  deleteAction: string;
  attachmentsHeading: (count: number) => string;
  moreAttachmentActionsTitle: string;
  viewAttachment: string;
  viewAttachmentNotice: string;
  downloadAll: string;
  downloadAllNotice: string;
  send: string;
  cancel: string;
  replySentNotice: (replyAll: boolean) => string;
  back: string;
  mark: string;
  more: string;
  toggleReadStatus: string;
  prevMail: string;
  nextMail: string;
  mailBodyIframeTitle: string;
  closeAssistantAria: string;
  mailInfoHeading: string;
  subjectLabel: string;
  fromLabel: string;
  attachmentsLabel: string;
  attachmentsCount: (count: number) => string;
  assistantEmptyHint: string;
  quickActionsHeading: string;
  replyToMailTitle: string;
  archiveMailTitle: string;
  toggleStarActionTitle: string;
  starActionLabel: (starred: boolean) => string;
  askAboutMailPlaceholder: string;
  sendToAssistantAria: string;
  assistantContextNotice: string;
  closeAria: string;
  toFieldPlaceholder: string;
  ccFieldPlaceholder: string;
  subjectFieldPlaceholder: string;
  bodyPlaceholder: string;
  sending: string;
  currentMailFallback: string;
  noTitleMail: string;
  quotedBodyTemplate: (sender: string, fromEmail: string, date: string, subject: string, body: string) => string;
  loadingMailboxTitle: string;
  loadingMailboxDesc: string;
  previewNoMailboxTitle: string;
  connectMailboxTitle: string;
  previewNoMailboxDesc: string;
  connectMailboxDesc: string;
  openMailSettings: string;
  notFoundInPreview: string;
  demo: MailDemoData;
}

export type MailCopy = MailCopyShape;

export const MAIL_INBOX_COPY: Record<Language, MailCopyShape> = {
  cn: {
    folderLabels: {
      inbox: "收件箱",
      sent: "已发送",
      drafts: "草稿",
      archive: "已归档",
      spam: "垃圾邮件",
      trash: "已删除",
      starred: "星标邮件",
      important: "重要邮件",
      genericMail: "邮件",
    },
    compose: "写邮件",
    composeNewTitle: "新邮件",
    folderNavAriaLabel: "邮箱文件夹",
    settingsNav: "设置",
    overviewKicker: "邮箱概览",
    unreadLabel: "未读",
    foldersLabel: "文件夹",
    overviewSummary: (folderLabel, count) => `${folderLabel}：${count} 封已加载`,
    overviewSummaryEmpty: "选择文件夹查看邮件。",
    assistantTitle: "邮件助手",
    assistantSidebarDesc: "选择邮件后显示上下文操作。",
    searchAriaLabel: "搜索",
    searchPlaceholder: "搜索邮件、联系人或关键词",
    previewBadge: "浏览器示例数据",
    toggleAssistant: (open) => (open ? "关闭邮箱助手" : "打开邮箱助手"),
    notifications: "通知",
    help: "帮助",
    refresh: "刷新",
    mailCountSuffix: (count) => `${count} 封`,
    noMatchingMail: "没有匹配的邮件",
    emptyFolder: "这个文件夹是空的",
    tryDifferentKeyword: "换个关键词再试试。",
    newMailHint: "新邮件到达后会显示在这里。",
    loadingMail: "正在加载邮件...",
    loadMore: "查看更多邮件",
    resizeListLabel: "调整邮件列表宽度",
    resizeAssistantLabel: "调整邮件助手宽度",
    noPreviewContent: "这封邮件没有预览内容。",
    noBodyText: "这封邮件没有正文。",
    unreadBadge: "未读",
    starredBadge: "星标",
    toggleStar: (starred) => (starred ? "取消星标" : "添加星标"),
    openingMail: "正在打开邮件...",
    selectMailPrompt: "从左侧选择一封邮件开始处理。",
    forwardOpenedNotice: "已打开转发邮件窗口。",
    snoozeNotice: "已标记为稍后处理。",
    quickReplyPlaceholder: (replyAll) => (replyAll ? "快速回复所有收件人..." : "快速回复..."),
    recipientsLine: (to, cc) => `收件人：${to}${cc ? `，抄送：${cc}` : ""}`,
    reply: "回复",
    replyAll: "回复全部",
    forward: "转发",
    snooze: "稍后处理",
    moreMailActionsAria: "更多邮件操作",
    toggleUnreadLabel: (unread) => (unread ? "标为已读" : "标为未读"),
    archive: "归档",
    deleteAction: "删除",
    attachmentsHeading: (count) => `附件（${count}）`,
    moreAttachmentActionsTitle: "更多附件操作",
    viewAttachment: "查看附件",
    viewAttachmentNotice: "附件预览会在桌面端下载能力接入后启用。",
    downloadAll: "下载全部",
    downloadAllNotice: "附件下载会在桌面端下载能力接入后启用。",
    send: "发送",
    cancel: "取消",
    replySentNotice: (replyAll) => (replyAll ? "已发送回复全部。" : "已发送回复。"),
    back: "返回",
    mark: "标记",
    more: "更多",
    toggleReadStatus: "切换已读状态",
    prevMail: "上一封",
    nextMail: "下一封",
    mailBodyIframeTitle: "邮件正文",
    closeAssistantAria: "关闭助手",
    mailInfoHeading: "邮件信息",
    subjectLabel: "主题",
    fromLabel: "发件人",
    attachmentsLabel: "附件",
    attachmentsCount: (count) => `${count} 个`,
    assistantEmptyHint: "选择邮件后显示发件人、主题、附件和可用操作。",
    quickActionsHeading: "快捷操作",
    replyToMailTitle: "回复当前邮件",
    archiveMailTitle: "归档当前邮件",
    toggleStarActionTitle: "切换星标状态",
    starActionLabel: (starred) => (starred ? "取消" : "星标"),
    askAboutMailPlaceholder: "对这封邮件临时提问",
    sendToAssistantAria: "发送给邮件助手",
    assistantContextNotice: "已把当前邮件作为临时上下文交给助手，不保存到聊天历史。",
    closeAria: "关闭",
    toFieldPlaceholder: "收件人",
    ccFieldPlaceholder: "抄送",
    subjectFieldPlaceholder: "主题",
    bodyPlaceholder: "撰写邮件...",
    sending: "发送中...",
    currentMailFallback: "当前邮件",
    noTitleMail: "无标题邮件",
    quotedBodyTemplate: (sender, fromEmail, date, subject, body) =>
      `\n\n---------- 转发邮件 ----------\n发件人：${sender} <${fromEmail}>\n日期：${date}\n主题：${subject}\n\n${body}`,
    loadingMailboxTitle: "正在打开邮箱",
    loadingMailboxDesc: "正在读取已连接账号和文件夹，请稍等。",
    previewNoMailboxTitle: "浏览器预览无法读取邮箱",
    connectMailboxTitle: "连接一个邮箱账号",
    previewNoMailboxDesc:
      "当前页面运行在 Vite 浏览器预览中，没有桌面端邮箱后端。请在 SomniQ 桌面应用的 Mail 标签查看真实 Gmail/IMAP/Outlook 内容。",
    connectMailboxDesc:
      "添加 IMAP、Gmail 或 Outlook 账号后，SomniQ Mail 会在这里展示真实收件箱、阅读区和邮件助手。",
    openMailSettings: "打开邮箱设置",
    notFoundInPreview: "浏览器示例数据中没有找到这封邮件。",
    demo: {
      accountDisplayName: "浏览器预览邮箱",
      importantLabel: "重要",
      messages: [
        {
          id: "preview-1",
          threadId: "preview-thread-1",
          from: "lin.xiaoman@example.com",
          fromName: "林小满",
          to: "preview.mail@aris.local",
          subject: "Q3 合作项目进度同步",
          snippet: "项目里程碑已经完成，市场调研报告也已确认，想同步一下下周安排。",
          date: "2026-06-18T09:28:00-05:00",
          unread: true,
          starred: true,
          hasAttachments: true,
          labels: ["重要", "客户"],
        },
        {
          id: "preview-2",
          threadId: "preview-thread-2",
          from: "security@example.com",
          fromName: "安全通知",
          to: "preview.mail@aris.local",
          subject: "登录安全提醒",
          snippet: "检测到新设备登录，如果不是你本人操作，请尽快检查账号安全。",
          date: "2026-06-18T08:05:00-05:00",
          unread: true,
          starred: false,
          hasAttachments: false,
          labels: [],
        },
        {
          id: "preview-3",
          threadId: "preview-thread-3",
          from: "ops@example.com",
          fromName: "运营团队",
          to: "preview.mail@aris.local",
          subject: "本周上线清单确认",
          snippet: "请确认邮件模块、项目设置和会话列表三项改动的上线顺序。",
          date: "2026-06-17T17:40:00-05:00",
          unread: false,
          starred: false,
          hasAttachments: false,
          labels: ["内部"],
        },
        {
          id: "preview-4",
          threadId: "preview-thread-4",
          from: "newsletter@example.com",
          fromName: "产品更新",
          to: "preview.mail@aris.local",
          subject: "6 月产品更新摘要",
          snippet: "这封示例邮件用于浏览器端测试归档、删除和阅读布局。",
          date: "2026-06-16T13:10:00-05:00",
          unread: false,
          starred: false,
          hasAttachments: false,
          labels: [],
        },
      ],
      fullMessages: {
        "preview-1": {
          id: "preview-1",
          threadId: "preview-thread-1",
          from: "lin.xiaoman@example.com",
          fromName: "林小满",
          to: "preview.mail@aris.local",
          cc: "team@example.com",
          subject: "Q3 合作项目进度同步",
          date: "2026-06-18T09:28:00-05:00",
          unread: true,
          starred: true,
          labels: ["重要", "客户"],
          bodyHtml: null,
          bodyText:
            "你好，\n\nQ3 合作项目的关键里程碑已经完成，市场调研报告也已确认。\n\n需要你确认三件事：\n1. 下周二的项目对齐会是否照常进行；\n2. 是否需要把附件里的预算表同步给财务；\n3. 对外邮件是否按当前版本发送。\n\n谢谢。",
          attachments: [
            {
              id: "preview-attachment-1",
              filename: "Q3项目计划.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 1184000,
            },
            {
              id: "preview-attachment-2",
              filename: "市场调研报告.pdf",
              mimeType: "application/pdf",
              size: 2432000,
            },
          ],
        },
        "preview-2": {
          id: "preview-2",
          threadId: "preview-thread-2",
          from: "security@example.com",
          fromName: "安全通知",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "登录安全提醒",
          date: "2026-06-18T08:05:00-05:00",
          unread: true,
          starred: false,
          labels: [],
          bodyHtml:
            "<main style='font-family:Arial,sans-serif;line-height:1.7;color:#202124;max-width:680px;margin:0 auto;padding:28px'><h2>登录安全提醒</h2><p>我们检测到你的账号从一台新设备登录。</p><p>如果这是你本人操作，可以忽略这封邮件；如果不是，请尽快修改密码并检查安全设置。</p><p><a href='#' style='display:inline-block;background:#111827;color:white;padding:10px 16px;border-radius:6px;text-decoration:none'>查看活动</a></p></main>",
          bodyText: "我们检测到你的账号从一台新设备登录。如果不是你本人操作，请尽快检查账号安全。",
          attachments: [],
        },
        "preview-3": {
          id: "preview-3",
          threadId: "preview-thread-3",
          from: "ops@example.com",
          fromName: "运营团队",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "本周上线清单确认",
          date: "2026-06-17T17:40:00-05:00",
          unread: false,
          starred: false,
          labels: ["内部"],
          bodyHtml: null,
          bodyText:
            "本周上线清单请确认：\n\n- 邮件模块浏览器预览数据\n- 邮件阅读区回复交互\n- 删除和归档的乐观更新\n\n确认后我会安排打包。",
          attachments: [],
        },
        "preview-4": {
          id: "preview-4",
          threadId: "preview-thread-4",
          from: "newsletter@example.com",
          fromName: "产品更新",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "6 月产品更新摘要",
          date: "2026-06-16T13:10:00-05:00",
          unread: false,
          starred: false,
          labels: [],
          bodyHtml: null,
          bodyText: "这是一封用于浏览器预览的示例邮件，方便验证空状态、阅读区和列表操作。",
          attachments: [],
        },
      },
    },
  },
  en: {
    folderLabels: {
      inbox: "Inbox",
      sent: "Sent",
      drafts: "Drafts",
      archive: "Archive",
      spam: "Spam",
      trash: "Trash",
      starred: "Starred",
      important: "Important",
      genericMail: "Mail",
    },
    compose: "Compose",
    composeNewTitle: "New message",
    folderNavAriaLabel: "Mail folders",
    settingsNav: "Settings",
    overviewKicker: "Mailbox overview",
    unreadLabel: "Unread",
    foldersLabel: "Folders",
    overviewSummary: (folderLabel, count) => `${folderLabel}: ${count} loaded`,
    overviewSummaryEmpty: "Select a folder to view mail.",
    assistantTitle: "Mail Assistant",
    assistantSidebarDesc: "Contextual actions appear here once you select a mail.",
    searchAriaLabel: "Search",
    searchPlaceholder: "Search mail, contacts, or keywords",
    previewBadge: "Browser sample data",
    toggleAssistant: (open) => (open ? "Close mail assistant" : "Open mail assistant"),
    notifications: "Notifications",
    help: "Help",
    refresh: "Refresh",
    mailCountSuffix: (count) => `${count} ${count === 1 ? "message" : "messages"}`,
    noMatchingMail: "No matching mail",
    emptyFolder: "This folder is empty",
    tryDifferentKeyword: "Try a different keyword.",
    newMailHint: "New mail will show up here when it arrives.",
    loadingMail: "Loading mail...",
    loadMore: "Load more mail",
    resizeListLabel: "Resize mail list width",
    resizeAssistantLabel: "Resize mail assistant width",
    noPreviewContent: "This mail has no preview content.",
    noBodyText: "This mail has no body.",
    unreadBadge: "Unread",
    starredBadge: "Starred",
    toggleStar: (starred) => (starred ? "Unstar" : "Star"),
    openingMail: "Opening mail...",
    selectMailPrompt: "Select a mail on the left to get started.",
    forwardOpenedNotice: "Opened the forward mail window.",
    snoozeNotice: "Marked for later.",
    quickReplyPlaceholder: (replyAll) => (replyAll ? "Quick reply to all recipients..." : "Quick reply..."),
    recipientsLine: (to, cc) => `To: ${to}${cc ? `, Cc: ${cc}` : ""}`,
    reply: "Reply",
    replyAll: "Reply all",
    forward: "Forward",
    snooze: "Snooze",
    moreMailActionsAria: "More mail actions",
    toggleUnreadLabel: (unread) => (unread ? "Mark as read" : "Mark as unread"),
    archive: "Archive",
    deleteAction: "Delete",
    attachmentsHeading: (count) => `Attachments (${count})`,
    moreAttachmentActionsTitle: "More attachment actions",
    viewAttachment: "View attachments",
    viewAttachmentNotice: "Attachment preview will be available once desktop download support ships.",
    downloadAll: "Download all",
    downloadAllNotice: "Attachment download will be available once desktop download support ships.",
    send: "Send",
    cancel: "Cancel",
    replySentNotice: (replyAll) => (replyAll ? "Sent reply to all." : "Sent reply."),
    back: "Back",
    mark: "Mark",
    more: "More",
    toggleReadStatus: "Toggle read status",
    prevMail: "Previous mail",
    nextMail: "Next mail",
    mailBodyIframeTitle: "Mail body",
    closeAssistantAria: "Close assistant",
    mailInfoHeading: "Mail info",
    subjectLabel: "Subject",
    fromLabel: "From",
    attachmentsLabel: "Attachments",
    attachmentsCount: (count) => `${count} item${count === 1 ? "" : "s"}`,
    assistantEmptyHint: "Select a mail to see its sender, subject, attachments, and available actions.",
    quickActionsHeading: "Quick actions",
    replyToMailTitle: "Reply to this mail",
    archiveMailTitle: "Archive this mail",
    toggleStarActionTitle: "Toggle star",
    starActionLabel: (starred) => (starred ? "Unstar" : "Star"),
    askAboutMailPlaceholder: "Ask something about this mail",
    sendToAssistantAria: "Send to mail assistant",
    assistantContextNotice: "Sent the current mail to the assistant as temporary context; not saved to chat history.",
    closeAria: "Close",
    toFieldPlaceholder: "To",
    ccFieldPlaceholder: "Cc",
    subjectFieldPlaceholder: "Subject",
    bodyPlaceholder: "Write your message...",
    sending: "Sending...",
    currentMailFallback: "Current mail",
    noTitleMail: "Untitled mail",
    quotedBodyTemplate: (sender, fromEmail, date, subject, body) =>
      `\n\n---------- Forwarded message ----------\nFrom: ${sender} <${fromEmail}>\nDate: ${date}\nSubject: ${subject}\n\n${body}`,
    loadingMailboxTitle: "Opening mailbox",
    loadingMailboxDesc: "Loading connected accounts and folders, please wait.",
    previewNoMailboxTitle: "Browser preview can't read your mailbox",
    connectMailboxTitle: "Connect a mailbox account",
    previewNoMailboxDesc:
      "This page is running in the Vite browser preview, which has no desktop mail backend. Open the Mail tab in the SomniQ desktop app to see real Gmail/IMAP/Outlook content.",
    connectMailboxDesc:
      "After you add an IMAP, Gmail, or Outlook account, SomniQ Mail will show your real inbox, reading pane, and mail assistant here.",
    openMailSettings: "Open mail settings",
    notFoundInPreview: "This mail wasn't found in the browser sample data.",
    demo: {
      accountDisplayName: "Browser Preview Mailbox",
      // Not "Important": that literal collides with the Gmail-system-label
      // filter in `visibleLabels` (SYSTEM_LABELS has "IMPORTANT"), which would
      // silently hide this demo tag from the UI.
      importantLabel: "Priority",
      messages: [
        {
          id: "preview-1",
          threadId: "preview-thread-1",
          from: "lin.xiaoman@example.com",
          fromName: "Xiaoman Lin",
          to: "preview.mail@aris.local",
          subject: "Q3 Partnership Project Sync",
          snippet:
            "Project milestones are done and the market research report is confirmed — let's sync on next week's plan.",
          date: "2026-06-18T09:28:00-05:00",
          unread: true,
          starred: true,
          hasAttachments: true,
          labels: ["Priority", "Client"],
        },
        {
          id: "preview-2",
          threadId: "preview-thread-2",
          from: "security@example.com",
          fromName: "Security Notice",
          to: "preview.mail@aris.local",
          subject: "Sign-in Security Alert",
          snippet:
            "A new device sign-in was detected. If this wasn't you, please review your account security right away.",
          date: "2026-06-18T08:05:00-05:00",
          unread: true,
          starred: false,
          hasAttachments: false,
          labels: [],
        },
        {
          id: "preview-3",
          threadId: "preview-thread-3",
          from: "ops@example.com",
          fromName: "Ops Team",
          to: "preview.mail@aris.local",
          subject: "This Week's Release Checklist",
          snippet: "Please confirm the release order for the mail module, project settings, and chat list changes.",
          date: "2026-06-17T17:40:00-05:00",
          unread: false,
          starred: false,
          hasAttachments: false,
          labels: ["Internal"],
        },
        {
          id: "preview-4",
          threadId: "preview-thread-4",
          from: "newsletter@example.com",
          fromName: "Product Updates",
          to: "preview.mail@aris.local",
          subject: "June Product Update Summary",
          snippet: "This sample email is used to test archive, delete, and reading layout in the browser preview.",
          date: "2026-06-16T13:10:00-05:00",
          unread: false,
          starred: false,
          hasAttachments: false,
          labels: [],
        },
      ],
      fullMessages: {
        "preview-1": {
          id: "preview-1",
          threadId: "preview-thread-1",
          from: "lin.xiaoman@example.com",
          fromName: "Xiaoman Lin",
          to: "preview.mail@aris.local",
          cc: "team@example.com",
          subject: "Q3 Partnership Project Sync",
          date: "2026-06-18T09:28:00-05:00",
          unread: true,
          starred: true,
          labels: ["Priority", "Client"],
          bodyHtml: null,
          bodyText:
            "Hi,\n\nThe key milestones for the Q3 partnership project are done, and the market research report has been confirmed.\n\nCould you confirm three things:\n1. Whether Tuesday's project alignment meeting is still on;\n2. Whether the budget sheet in the attachment needs to go to Finance;\n3. Whether the external email should go out in its current form.\n\nThanks.",
          attachments: [
            {
              id: "preview-attachment-1",
              filename: "Q3-Project-Plan.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 1184000,
            },
            {
              id: "preview-attachment-2",
              filename: "Market-Research-Report.pdf",
              mimeType: "application/pdf",
              size: 2432000,
            },
          ],
        },
        "preview-2": {
          id: "preview-2",
          threadId: "preview-thread-2",
          from: "security@example.com",
          fromName: "Security Notice",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "Sign-in Security Alert",
          date: "2026-06-18T08:05:00-05:00",
          unread: true,
          starred: false,
          labels: [],
          bodyHtml:
            "<main style='font-family:Arial,sans-serif;line-height:1.7;color:#202124;max-width:680px;margin:0 auto;padding:28px'><h2>Sign-in Security Alert</h2><p>We detected a sign-in to your account from a new device.</p><p>If this was you, you can ignore this email. If not, please change your password and review your security settings as soon as possible.</p><p><a href='#' style='display:inline-block;background:#111827;color:white;padding:10px 16px;border-radius:6px;text-decoration:none'>View activity</a></p></main>",
          bodyText:
            "We detected a sign-in to your account from a new device. If this wasn't you, please review your account security right away.",
          attachments: [],
        },
        "preview-3": {
          id: "preview-3",
          threadId: "preview-thread-3",
          from: "ops@example.com",
          fromName: "Ops Team",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "This Week's Release Checklist",
          date: "2026-06-17T17:40:00-05:00",
          unread: false,
          starred: false,
          labels: ["Internal"],
          bodyHtml: null,
          bodyText:
            "Please confirm this week's release checklist:\n\n- Mail module browser preview data\n- Mail reading pane reply interaction\n- Optimistic updates for delete and archive\n\nOnce confirmed I'll schedule the build.",
          attachments: [],
        },
        "preview-4": {
          id: "preview-4",
          threadId: "preview-thread-4",
          from: "newsletter@example.com",
          fromName: "Product Updates",
          to: "preview.mail@aris.local",
          cc: "",
          subject: "June Product Update Summary",
          date: "2026-06-16T13:10:00-05:00",
          unread: false,
          starred: false,
          labels: [],
          bodyHtml: null,
          bodyText:
            "This is a sample email for the browser preview, used to verify empty states, the reading pane, and list actions.",
          attachments: [],
        },
      },
    },
  },
};

export type { MailAccount, MailFolder, MailMessageFull, MailMessageSummary };
