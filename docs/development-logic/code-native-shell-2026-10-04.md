# Code 页使用 VS Code 原生导航

目标：将 Code 页重复的 SomniQ 顶部栏合并进嵌入式 VSCodium，保留模块切换、SomniQ 项目选择及账户操作。

- `aris-code-bridge` 使用稳定的状态栏 API 与 Quick Pick：左侧的 SomniQ Code 打开模块选择，项目名打开项目选择，右侧账户入口显示套餐、剩余额度、设置和退出登录。
- 项目入口也贡献到原生资源管理器标题栏，以及远程指示器菜单；所有入口可从命令面板访问。原生 Accounts 菜单没有稳定的扩展贡献点，因此账户使用原生状态栏入口与 Quick Pick，不修改 VSCodium 的内部 DOM，也不向其他扩展提供 SomniQ 登录凭据。
- 原生菜单将模块或项目 ID 发回经过认证的现有桥接。Desktop 根据最新列表校验 ID，再调用原有模块切换、项目切换、添加项目、打开文件夹、设置和退出逻辑。项目路径不是命令参数。
- 编辑器内切换或添加项目之前，用户可以保存未保存的文本与 Notebook；取消或保存失败不切换。Desktop 的 LaTeX 未保存保护继续适用。
- Code 页的 SomniQ Code 模块菜单始终固定在 Desktop 窗口栏左上角，直接调用原有页面切换逻辑，不依赖编辑器连接。Desktop 等待带版本号的 `shell-ready` 确认后才收起重复顶部栏；初始化、断线、桥接缺失及故障时恢复项目与账号顶部栏。连接状态变化不会移动或重建已经打开的模块菜单。窗口拖动、关闭、更新与伴写入口仍由 Desktop 管理。其他模块布局不变。
- 账户快照仅包含显示名称、套餐名称和已格式化额度，凭据留在 Desktop。账户刷新、语言变化、项目列表和忙碌状态会同步到原生菜单。
- Shell DTO 的唯一来源为 `crates/remote-protocol/src/code_bridge.rs`。运行 `node desktop/scripts/generate-code-shell-types.cjs` 更新 TypeScript；回归测试使用 `--check` 检查生成内容。

API 依据：[VS Code 状态栏和 Quick Pick](https://code.visualstudio.com/api/references/vscode-api)、[菜单贡献点](https://code.visualstudio.com/api/references/contribution-points)。沿用稳定扩展 API，无需修改或重打包编辑器运行时。

导航验证覆盖实际 App 的原生事件接收、切回对话、返回 Code、左上角模块菜单及断线重连期间菜单保持打开。浏览器验证使用隔离的真实 VSCodium 工作台与 App、CodePane、样式和 Tauri 前端事件适配器；桥接后端用测试服务器代替，目标页面内容用占位组件代替，以核对页面可见性及 iframe 隐藏。生产 Rust 桥接与协议另由聚焦测试验证。

## 从对话打开程序文件

原先文件入口先向桥接发送 `open-file`，再切换到 Code。首次进入 Code 时编辑器尚未挂载，或连接已断开时，Rust 发送返回 `false`，但命令没有将结果传给前端，导致只切换页面而丢失目标文件。

- 文件入口将目标存入 `pendingCodeFilePath` 后切换页面。相对路径立即按点击时的项目解析，保留绝对路径、UNC、中文和空格。
- CodePane 等工作台可显示且桥接已连接才发送。Rust 命令返回是否成功进入连接的发送队列；失败保留目标，连接事件或状态轮询确认恢复后重试。
- 只允许当前目标的发送结果清空请求，避免连续点击时旧结果清掉新目标。退出登录清空目标。连接查询也检查期间是否收到新事件，避免旧查询覆盖更新的连接状态。
- 已覆盖首次进入、编辑器未就绪、发送失败重连、连续点击、过期连接查询和路径解析。169 项相关前端测试、TypeScript 检查、前端构建和 12 项 Rust 桥接测试通过。
- 隔离浏览器实测使用真实 VSCodium 打开 Python、项目外的 Rust，以及断线重连后的 MATLAB 文件，并检查实际内容；Python 路径包含中文和空格。实测使用 App、CodePane 和文件入口，Rust 调用适配器由测试服务器替代，生产 Rust 的发送结果另由聚焦测试验证。这里的发送成功表示命令已入队，不是新增的编辑器打开确认协议。
