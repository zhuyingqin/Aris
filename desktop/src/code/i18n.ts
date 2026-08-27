import type { Language } from "../store";

export const CODE_COPY: Record<
  Language,
  {
    frameTitle: string;
    installTitle: string;
    installBody: string;
    installAction: string;
    downloading: (percent: number) => string;
    extracting: string;
    installingExtensions: string;
    starting: string;
    cancel: string;
    retry: string;
    failedTitle: string;
    crashedTitle: string;
    noProject: string;
    trustTitle: string;
    trustBody: string;
    trustAck: string;
    desktopOnly: string;
    askPrompt: (file: string, lines: string) => string;
    askTruncated: string;
    computeTitle: string;
    computeShow: string;
    computeHide: string;
  }
> = {
  cn: {
    frameTitle: "VS Code 编辑器",
    installTitle: "首次使用需要准备编辑器运行时",
    installBody:
      "Windows 安装包已内置运行时，首次使用会在本机解包并校验；之后可从 Open VSX 安装插件。",
    installAction: "准备并启动",
    downloading: (percent) => `正在下载运行时… ${percent}%`,
    extracting: "正在解压运行时…",
    installingExtensions: "正在安装 Python / Jupyter / MATLAB 扩展…",
    starting: "正在启动编辑器…",
    cancel: "取消",
    retry: "重试",
    failedTitle: "编辑器启动失败",
    crashedTitle: "编辑器已停止运行",
    noProject: "请先选择一个项目文件夹。",
    // The Code page hands the user a real terminal and unrestricted extension
    // installs, which sit outside the chat permission modes. Saying so once is
    // the whole mitigation, so the wording has to be plain.
    trustTitle: "关于权限",
    trustBody:
      "编辑器内置终端和第三方插件以你的账户身份运行，不受对话权限档位的限制。打开尚未信任的项目文件夹时，VS Code 还会要求你选择“信任”或保持受限模式。请只安装你信任的插件。",
    trustAck: "继续",
    desktopOnly: "编辑器仅在桌面应用中可用。",
    askPrompt: (file, lines) => `关于 ${file} 第 ${lines} 行：`,
    askTruncated: "（选区过长，以下内容已截断）",
    computeTitle: "算力",
    computeShow: "显示算力面板",
    computeHide: "收起算力面板",
  },
  en: {
    frameTitle: "VS Code editor",
    installTitle: "The editor runtime needs to be prepared once",
    installBody:
      "The Windows installer already contains the runtime; the first use extracts and verifies it locally. After that you can install extensions from Open VSX.",
    installAction: "Prepare and start",
    downloading: (percent) => `Downloading runtime… ${percent}%`,
    extracting: "Extracting runtime…",
    installingExtensions: "Installing the Python, Jupyter and MATLAB extensions…",
    starting: "Starting the editor…",
    cancel: "Cancel",
    retry: "Retry",
    failedTitle: "The editor failed to start",
    crashedTitle: "The editor stopped running",
    noProject: "Pick a project folder first.",
    trustTitle: "About permissions",
    trustBody:
      "The editor's built-in terminal and any third-party extension run as you, outside the chat permission modes. When a project folder is not yet trusted, VS Code will ask you to trust it or stay in Restricted Mode. Only install extensions you trust.",
    trustAck: "Continue",
    desktopOnly: "The editor is only available in the desktop app.",
    askPrompt: (file, lines) => `About ${file}, line${lines.includes("-") ? "s" : ""} ${lines}:`,
    askTruncated: "(the selection was long, so it is truncated below)",
    computeTitle: "Compute",
    computeShow: "Show the compute panel",
    computeHide: "Hide the compute panel",
  },
};
