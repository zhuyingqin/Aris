import { useStore, type Language } from "./store";

export type InstallableEnvironmentId = "python" | "jupyter" | "latex";

const INSTALL_PROMPTS: Record<Language, Record<InstallableEnvironmentId, string>> = {
  cn: {
    python: "请检查当前系统的 Python 3 环境。如果尚未安装，请为当前操作系统选择可靠的官方安装方式，安装 Python 3 和 pip，并确保 python、python3 或 py 以及 pip 位于 PATH。涉及下载、管理员权限或系统级修改时，请先说明具体操作并请求我的确认。完成后请运行版本检查，并验证 SomniQ 可以调用 Python。",
    jupyter: "请检查当前系统的 Python 与 Jupyter 环境。如果缺少 Jupyter，请在合适的 Python 环境中安装 JupyterLab、Notebook 和 ipykernel，确保 jupyter 命令可用，并创建或验证 Python 内核。涉及下载、管理员权限或系统级修改时，请先说明具体操作并请求我的确认。完成后请运行版本和内核检查，验证 SomniQ 的 Notebook 功能可以使用。",
    latex: "请检查当前系统的 LaTeX 工具链。如果尚未安装，请为当前操作系统选择可靠的 TeX Live 安装方式，并确保 latexmk、xelatex、pdflatex 或 lualatex 至少有一个位于 PATH。涉及大体积下载、管理员权限或系统级修改时，请先说明安装方案、预计下载量并请求我的确认。完成后请运行版本检查，并编译一个最小 LaTeX 文档验证 SomniQ 可以使用。",
  },
  en: {
    python: "Check the Python 3 environment on this system. If it is missing, choose a reliable official installation method for the current operating system, install Python 3 and pip, and make sure python, python3, or py plus pip are available on PATH. Before any download, administrator access, or system-level change, explain the exact action and ask for my approval. When finished, run version checks and verify that SomniQ can invoke Python.",
    jupyter: "Check the Python and Jupyter environment on this system. If Jupyter is missing, install JupyterLab, Notebook, and ipykernel in an appropriate Python environment, make sure the jupyter command is available, and create or verify a Python kernel. Before any download, administrator access, or system-level change, explain the exact action and ask for my approval. When finished, check versions and kernels and verify that SomniQ Notebook can use them.",
    latex: "Check the LaTeX toolchain on this system. If it is missing, choose a reliable TeX Live installation method for the current operating system and ensure at least one of latexmk, xelatex, pdflatex, or lualatex is available on PATH. Before a large download, administrator access, or system-level change, explain the installation plan and estimated download size and ask for my approval. When finished, run version checks and compile a minimal LaTeX document to verify that SomniQ can use it.",
  },
};

export function isInstallableEnvironment(id: string): id is InstallableEnvironmentId {
  return id === "python" || id === "jupyter" || id === "latex";
}

export function environmentInstallPrompt(id: InstallableEnvironmentId, language: Language): string {
  return INSTALL_PROMPTS[language][id];
}

/** Switch to Chat with a reviewable installation request; Chat does not run it
 * automatically, so downloads and system changes still require user approval. */
export function handoffEnvironmentInstall(id: InstallableEnvironmentId, language: Language): void {
  const { setPendingChatInput, setTab } = useStore.getState();
  setPendingChatInput(environmentInstallPrompt(id, language));
  setTab("chat");
}
