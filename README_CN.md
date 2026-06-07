# ARIS Studio

ARIS Studio 是面向科研自动化的本地桌面工作台，用于智能体团队工作流、对抗式 Review、论文与项目协作。

它继承了 ARIS 原来的 Executor / Reviewer 思路，但把日常入口从命令行迁移到桌面端：聊天、项目切换、技能、工作流设计、运行监控、会话、设置，以及可以被自动 Review 流程读取的 PDF 附件。

本 README 只描述 ARIS Studio 桌面端。旧的 ARIS CLI 不再作为产品入口；仓库中的 CLI / runtime 相关 crate 主要作为桌面端复用的底层库存在。

[English README](README.md)

## 核心能力

- 在桌面 Chat 中与 ARIS Executor 对话，支持流式工具调用和持久化会话。
- 在 Settings 中配置 Executor / Reviewer 的 provider、model、base URL、API key 和语言。
- 浏览内置科研 Skills，并在 Chat 中通过 slash skill 直接调用研究流程。
- 在 Chat 中附加本地文件。文本型 PDF 可由 `read_file` 工具读取，因此自动 Review 可以直接检查论文 PDF。
- 支持多个本地项目。每个项目拥有独立的 sessions、run state、agents、workflows 和用户工作流草稿。
- 在 Workflow Studio 中用可视化画布和 ARIS workflow DSL 设计工作流。
- 启动、暂停、恢复、取消并监控工作流运行，查看 phase、agent、event、task 和 mailbox 状态。

PDF 支持是文本提取，不是 OCR。扫描版或纯图片 PDF 仍需要先做 OCR，ARIS 才能理解其中内容。

## 当前状态

- 产品名：ARIS Studio
- 桌面端版本：`0.2.0`
- 技术栈：Tauri 2 + React + Vite
- 主要打包目标：Windows NSIS installer
- 数据策略：本地优先，配置与项目运行数据保存在用户机器上

## 快速开始

依赖：

- Windows 10/11，并安装 WebView2 Runtime
- Node.js 18 或更高版本
- Rust stable，使用 MSVC toolchain
- Visual Studio Build Tools，并安装 C++ build tools

从源码运行：

```powershell
git clone https://github.com/zhuyingqin/Aris.git
cd Aris\desktop
npm install
npm run tauri dev
```

构建 Windows 桌面安装包：

```powershell
cd desktop
npm run tauri build
```

构建产物位置：

- 主程序：`desktop\src-tauri\target\release\aris-desktop.exe`
- 安装包：`desktop\src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

## 模型配置

打开 ARIS Studio 的 Settings，可以配置：

- Executor provider、model、base URL、API key
- Reviewer provider、model、base URL、API key
- UI / 输出语言
- 对当前模型配置进行连通性检查

配置文件保存在本地：

```text
~/.config/aris/config.json
```

API key 在 UI 中只显示脱敏结果。Tauri 后端会在本地读写密钥，前端不会拿到原始密钥。

## 项目数据

默认情况下，ARIS Studio 使用：

```text
~/.config/aris/desktop-workspace
~/.config/aris/desktop-runtime
```

每个项目的运行数据保存在：

```text
~/.config/aris/desktop-runtime/projects/<project-id>/
```

项目目录通常包含：

- `sessions/`：桌面端聊天会话
- `run-state/`：工作流运行事件和状态
- `agents/`：agent / task 状态
- `workflows/`：保存的工作流计划
- `user-workflows/`：用户编写的工作流草稿

可以在桌面端顶部的项目选择器中添加或切换项目。高级本地部署可以通过 `ARIS_WORKSPACE_ROOT` 覆盖默认 workspace root。

## 自动 Review 与 PDF

桌面端现在会把本地 PDF 附件保留为文件路径附件。用户在 Chat 或 skill 中要求 Review 论文时，agent 可以对附加的 `.pdf` 调用 `read_file`，runtime 会从常见的文本型 PDF stream 中提取正文，包括 Flate 压缩 stream 和 ToUnicode 字符映射。

这意味着 paper review、paper improvement、literature review 等流程可以直接使用桌面端附加的本地 PDF。加密 PDF、特殊编码 PDF、扫描版 PDF 仍可能需要手动提取文本或 OCR。

## 开发与构建

常用命令：

```powershell
cd desktop
npm run test
npm run typecheck
npm run build
npm run tauri dev
npm run tauri build
```

Rust 检查：

```powershell
cd desktop\src-tauri
cargo check
```

PDF 读取回归测试在仓库根目录运行：

```powershell
cargo test -p runtime reads_pdf
```

## 仓库结构

```text
desktop/             React / Tauri 桌面应用
desktop/src/         Chat、settings、skills、sessions、studio、monitor、teams
desktop/src-tauri/   Tauri commands 和桌面端后端
crates/runtime/      文件系统、权限、session、PDF 文本读取
crates/tools/        agent 与桌面命令共用的工具注册表
crates/executor/     agent 执行引擎
crates/chat/         Chat stream 基础能力
crates/commands/     共享命令处理
docs/                截图和辅助文档
```

## 设计说明

ARIS Studio 复用 ARIS coordination kernel，而不是在前端重复实现 agent 逻辑。桌面 UI 通过 Tauri backend 调用本地 Rust crate，完成工具调用、会话、skills、chat 执行和 workflow state 管理。

旧的终端版 ARIS CLI 文档已从 README 中移除。这个仓库现在面向用户的主入口是 ARIS Studio。
