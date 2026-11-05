# 安装教程

> 适用版本：SomniQ Studio v0.4.86 · [返回目录](README.md)

本文介绍如何在 Windows 和 macOS 上下载、安装、更新和卸载 SomniQ Studio，以及首次启动时可能遇到的系统安全提示。

## 1. 系统要求

| 项目 | Windows | macOS |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11，64 位（x64） | macOS 12 Monterey 及以上 |
| 处理器 | x64 | Apple 芯片（M 系列）与 Intel 均可（通用安装包） |
| 系统组件 | Microsoft Edge WebView2 Runtime（Windows 11 自带；缺失时安装程序会自动安装） | 无额外要求 |
| 安装包大小 | 约 130 MB | 约 390 MB |
| 网络 | 登录账号、调用模型、检索文献和检查更新都需要联网 | 同左 |

窗口最小尺寸为 1024 × 680，建议在 1440 × 900 及以上分辨率下使用。

你还需要一个 **SomniQ 账号**。当前版本的模型调用全部经由 SomniQ 账号完成，不再支持在应用里填写第三方 API Key。账号的注册、会员与额度见 [账号、会员与模型](account-and-models.md)。

## 2. 下载安装包

**方式一：GitHub Releases（推荐）**

打开 <https://github.com/zhuyingqin/Aris/releases/latest>，在页面底部的 **Assets** 中下载对应文件：

| 系统 | 下载这个文件 |
| --- | --- |
| Windows | `SomniQ.Studio_<版本号>_x64-setup.exe` |
| macOS | `SomniQ.Studio_<版本号>_universal.dmg` |

同一页面中的其他文件（`latest.json`、`*.sig`、`SomniQ.Studio.app.tar.gz`）是应用内自动更新用的，**不需要手动下载**。`SomniQ.Studio.app.zip` 是 macOS 应用本体的压缩包，仅在 DMG 无法挂载时作为备选。

**方式二：官网**

访问 SomniQ 官网 <https://ensuanx.com>，下载对应系统的安装包。应用内的“前往官网下载”按钮打开的也是这个地址。如果访问 GitHub 较慢，可以优先使用官网。

## 3. 在 Windows 上安装

1. 双击下载好的 `SomniQ.Studio_<版本号>_x64-setup.exe`。
2. 如果出现蓝色窗口 **“Windows 已保护你的电脑”**：这是因为安装包尚未使用商业代码签名证书，并不代表文件有问题。点击 **“更多信息”**，再点击 **“仍要运行”**。
3. 按安装向导完成安装。默认安装到当前用户目录（`%LOCALAPPDATA%\SomniQ Studio`），**不需要管理员权限**。
4. 如果系统缺少 WebView2 Runtime，安装程序会在后台自动下载安装，这一步需要联网。
5. 安装完成后，从开始菜单或桌面快捷方式启动 **SomniQ Studio**。

> 杀毒软件拦截时，请确认安装包来自上面两个官方渠道，再将其加入信任列表。

## 4. 在 macOS 上安装

1. 双击下载好的 `SomniQ.Studio_<版本号>_universal.dmg`，在弹出的窗口中把 **SomniQ Studio** 拖入 **“应用程序”（Applications）** 文件夹。
2. 第一次打开会被系统拦截，因为本应用目前没有 Apple 开发者 ID 签名和公证。按系统版本操作：
   - **macOS 15 Sequoia 及以上**：双击应用后出现“未打开‘SomniQ Studio’”提示时，点击“完成”。然后打开 **系统设置 → 隐私与安全性**，在页面下方的“安全性”区域找到关于 SomniQ Studio 的提示，点击 **“仍要打开”**，输入登录密码确认。
   - **macOS 12 – 14**：在“应用程序”文件夹中按住 Control 点按（或右键点按）SomniQ Studio，选择 **“打开”**，在弹窗中再次点击 **“打开”**。
3. 以上操作只需要做一次，之后可以正常双击启动。

**如果提示“已损坏，无法打开”**：这通常是下载时附加的隔离标记导致的。确认安装包来自官方渠道后，在“终端”中执行下面的命令，然后重新打开应用：

```bash
xattr -dr com.apple.quarantine "/Applications/SomniQ Studio.app"
```

**关于文件夹访问权限**：当你打开位于“文稿”“桌面”“下载”或外接磁盘中的项目时，macOS 会询问是否允许 SomniQ Studio 访问，请点击“允许”。截至 v0.4.86，macOS 发布包使用临时（ad-hoc）签名，授权在重启后仍然有效，但 **每次升级到新版本后，系统可能会重新询问一次**，这是预期行为。

## 5. 首次启动

1. 启动后进入登录页，用 SomniQ 账号登录；没有账号可以在登录页切换到 **注册**（详见 [快速上手](quick-start.md)）。
2. 首次登录后会出现 **设置工作区** 卡片，选择界面语言（简体中文 / English）和主题（浅色 / 深色），点击 **开始使用**。这两项之后都可以在设置中修改。
3. 进入主界面后会出现 4 步新手引导，依次介绍左侧图标栏、对话、项目切换器和设置，可以点 **跳过**。
4. 在页面顶部的项目切换器中选择 **添加本地项目…**，选一个文件夹作为项目，就可以开始在 **对话** 中工作了。

## 6. 可选的外部工具

SomniQ Studio 的核心功能开箱即用；以下工具只在使用对应功能时才需要：

| 功能 | 是否需要额外安装 | 说明 |
| --- | --- | --- |
| LaTeX 编译与 PDF ↔ 源码跳转 | 需要 TeX Live | 本机需安装 TeX Live，并确保 `latexmk`、`xelatex`、`pdflatex`、`lualatex` 中至少一个位于 PATH；正反向跳转还需要随 TeX Live 一起安装的 `synctex`。未安装时 LaTeX 页面会提示“尚未安装系统 LaTeX”。详见 [LaTeX 写作](latex.md)。 |
| 浏览器自动化（Playwright 插件） | macOS 需要 Chrome | 安装包内置 Node 运行时和 Playwright MCP。Windows 上调用系统自带的 Microsoft Edge；macOS 上调用 Google Chrome，需要事先安装。详见 [插件、邮箱与手机远程](plugins-mail-remote.md)。 |
| Jupyter 笔记本 / Python 实验 | 需要 Python | 在“代码”页使用 Python 内核时需要本机已安装 Python 与 Jupyter。详见 [代码与实验](code.md)。 |
| MATLAB 内核 | 需要 MATLAB | 应用会自动发现本机已安装的 MATLAB。 |

可以在 **设置 → 关于与环境 → 本地环境检查** 中查看 Python、Jupyter、MATLAB、LaTeX 等工具的检测结果（可用 / 需检查 / 未检测到），缺失时点击 **前往对话安装**，让助手在对话中帮你安装；也可以在这里指定首选的 Python / Conda 环境。

## 7. 更新

- **自动检查**：应用在启动时以及之后每 30 分钟检查一次新版本。发现新版本后，左侧图标栏（或没有图标栏的页面的顶部）会出现一个下载图标（悬停提示“发现更新 vX，点击安装。”），点击即可安装；安装完成后再点一次重启。
- **在设置中更新**：打开 **设置 → 关于与环境 → 应用更新**，点击 **检查更新** → **下载并安装** → **重启应用**。有可用更新时这里会显示更新说明。
- **更新来源**：界面语言为中文时从 SomniQ 国内镜像下载更新，为英文时从 GitHub Releases 下载。
- **手动更新**：下载新版本安装包，直接覆盖安装即可，本地的项目、会话和配置都会保留。
- **“当前版本已停止服务”**：过旧的客户端会被 SomniQ 服务拒绝，界面顶部出现该横幅。点击 **立即更新** 自动升级；如果找不到可用更新，按钮会变成 **前往官网下载**。

## 8. 卸载

**Windows**：打开 **设置 → 应用 → 已安装的应用**，找到 SomniQ Studio，点击“卸载”。

**macOS**：退出应用后，把“应用程序”文件夹中的 SomniQ Studio 移到废纸篓。

卸载程序 **不会删除** 你的配置和项目数据。Windows 卸载向导中如果勾选“Delete the application data”（删除应用数据），只会清除应用内置浏览器存储的界面偏好和头像（`%LOCALAPPDATA%\com.aris.studio`），下表中的数据仍会保留。如需彻底清除，可在卸载后手动删除：

| 内容 | 位置 |
| --- | --- |
| 应用配置、项目列表、所有项目的对话记录与运行状态、记忆、技能、邮箱连接 | 用户主目录下的 `.config/SomniQ`（Windows 为 `C:\Users\<用户名>\.config\SomniQ`） |
| 某个项目的文献库、文件编辑历史、临时文件 | 该项目文件夹内的 `.somniq/` 目录 |

> 项目文件夹本身（论文、代码、数据）属于你的研究文件，卸载应用不会动它们。删除 `.config/SomniQ` 会丢失全部对话历史；删除某个项目的 `.somniq/` 会丢失该项目的文献库和编辑历史，请先备份再操作。

## 9. 从源码构建（开发者）

普通用户无需阅读本节。

**准备环境**

- Node.js 22
- Rust stable 工具链（Windows 上使用 MSVC 目标，并安装 Visual Studio C++ 生成工具）
- Windows：WebView2 Runtime；macOS：Xcode Command Line Tools

**开发模式运行**

```bash
git clone https://github.com/zhuyingqin/Aris.git
```

```bash
cd Aris/desktop && npm ci && npm run tauri dev
```

**构建安装包**

```bash
cd Aris/desktop && npm run tauri build
```

构建前会自动执行 `npm run build:resources`，准备内置的 Playwright MCP 和代码编辑器资源，这一步需要联网，耗时较长。Windows 产物位于 `desktop/src-tauri/target/release/bundle/nsis/`。
