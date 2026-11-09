# Code 加载布局和工作区信任持久化

## 问题

Code 原来在工作台可显示且原生桥接确认就绪后才收起 SomniQ 顶部栏。加载、信任弹窗及桥接断线会重新显示一整行项目/账户栏，使编辑器上下跳动。

VSCodium Web 将工作区信任模型保存在当前浏览器 origin 的 IndexedDB。运行时使用空闲的本机端口，端口改变会产生新的 origin；模型中的 `vscode-remote` URI 也包含端口。同一文件夹因此可能再次被视为未信任。编辑器本身延迟刷新存储，刚确认就重载也可能来不及保存。

## 实现

- `App.tsx` 在 Code 页面直接使用两行布局：窗口栏和编辑器。`CodeShell.css` 随 App 加载，避免懒加载期间出现旧布局。项目和账户的备用入口位于窗口栏，原生入口就绪后收起；菜单打开期间保留它们。模块切换与桥接状态不改变 iframe 的 key。
- 主应用在稳定 origin 的 localStorage 使用 `somniq-code-workspace-trust-v1` 保存编辑器自己的显式信任模型。保留文件夹路径与父目录信任范围；不默认信任项目，不禁用 Workspace Trust。
- `CodePane` 给工作台 URL 添加主应用 origin，并安装消息监听。只接受当前 iframe 的 `contentWindow`、精确 origin 和固定协议频道；校验模型结构与大小。写入失败返回失败确认，编辑器继续使用自己的存储。
- Rust 将 `resources/code-workspace-trust.js` 嵌入程序，安装到工作台 bundle 旁边。启动前的模块 prelude 等待恢复 `vscode-web-state-db-global-shared` / `ItemTable` 的 `content.trust.model.key`，再初始化 VSCodium。只修改这一个键；已有存储且主应用没有记录时，可迁移该 origin 的已有显式选择。
- 恢复时将本机 `vscode-remote` URI 的旧端口替换为当前 authority，保持原路径。其他远程 authority 不改写。
- 在固定版本 `1.126.04524` 的 `saveTrustInfo` 中加入主应用保存确认，早于后续信任事件和延迟存储刷新。撤销后保存空列表，旧信任不会在下一次加载时恢复。缓存修订摘要包含补丁、prelude 和脚本内容。
- 新文件夹继续按 VSCodium 的信任规则询问。拒绝信任继续受限；本改动没有修改未信任文件夹的启动询问设置。单独打开的工作台没有主应用时沿用编辑器存储。

## 验证边界

聚焦测试覆盖跨端口恢复、空列表撤销、消息来源校验、损坏/过大模型、存储失败、URL 保留 token/文件夹、补丁幂等与初始化顺序，以及加载/断线/重连时的窗口栏和菜单行为。

隔离的真实 VSCodium 工作台与 App/CodePane 使用独立运行时副本、两个服务端口和两个测试文件夹。浏览器验证首次询问、确认后刷新与换端口恢复、服务重启恢复、新文件夹询问和拒绝后的受限模式、断线时备用菜单可用，以及模块切换。Tauri 调用及桥接后端由测试服务器适配；未操作用户的工作区或编辑器 profile。浏览器工具无法点击嵌套工作台的撤销按钮，所以实际撤销按钮流程未完成浏览器验收，保存空列表和恢复逻辑由测试验证。

测试与构建结果保存在 `.somniq/diagnostics/code-loading-verification.json`。原生 SomniQ 安装程序未重打包，生产 WebView2 窗口仍需安装新构建后验收。
