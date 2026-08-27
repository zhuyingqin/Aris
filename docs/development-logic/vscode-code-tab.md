# Code 页替换为可装插件的 VS Code

> 状态：Code 页已是嵌入式 VS Code（唯一引擎，旧 Lab 已删除）· M0–M5 完成 · 2026-08-26 · 目标分支 `0.4.56`
>
> 范围：把 `desktop/src/lab/`（导航里的 "Code" / "代码" 页）换成嵌入式 VS Code，
> 支持从 Open VSX 安装真插件；Notebook / 内核 / AI 助手通过自研 VSIX 桥接保留。

---

## 1. 结论

**运行时选 VSCodium 的 `reh-web` 服务端**（MIT，自带 Node，商店指向 Open VSX），
由 Tauri 拉起本地 loopback 进程，前端嵌入渲染，
Aris 自己的能力（Notebook 内核、AI 助手、算力面板）通过一个自研扩展 `aris-code-bridge` 反向接回 Rust。

三个候选的实测对比（2026-08-26 拉取 release 元数据）：

| 方案 | 最新版 | Windows 产物 | 维护 | 结论 |
|---|---|---|---|---|
| **VSCodium reh-web** | 1.126.04524 (2026-07-07) | ✅ `vscodium-reh-web-win32-x64` 103.2 MB | repo 2026-08-12 有推送 | **选它** |
| openvscode-server | 1.109.5 (2026-02-20) | ❌ 近 12 个 release 全 linux | 半年未发版 | 否 |
| code-server | 4.134.0 (2026-08-24) | ❌ 只有 linux + macos | 活跃 | 否 |
| monaco-vscode-api | 36.2.1 | 无需服务端 | 活跃 | 备胎（只支持 web 扩展主机） |

---

## 2. M0 探针实测结果（已完成）

下载 `vscodium-reh-web-win32-x64-1.126.04524.tar.gz`，sha256 校验通过，
解包后在 `127.0.0.1:39217` 起服务并用 Chromium 内核浏览器加载。

### 2.1 通过项

| 检查 | 结果 |
|---|---|
| sha256 校验 | ✅ `43f15c8e…62b333` OK |
| 自带运行时 | ✅ `node.exe v24.15.0`，**不依赖系统 Node** |
| 解包体积 | 336 MB（tar.gz 103 MB） |
| 内置扩展 | 94 个，含 **`ipynb`**、`notebook-renderers`、`markdown-*`、`mermaid-markdown-features` |
| 商店指向 | ✅ `product.json.extensionsGallery` → `https://open-vsx.org/vscode/gallery` |
| 无代理装插件 | ✅ `mechatroner.rainbow-csv` 11s；`ms-python.python` 2026.4.0 + `debugpy` + `vscode-python-envs` 13s |
| Workbench 启动 | ✅ `.monaco-workbench windows web chromium`，资源管理器/搜索/SCM/调试/扩展面板齐全 |
| 扩展主机 | ✅ `bootstrap-fork --type=extensionHost` 进程存在；Welcome 页出现 Python 扩展贡献的 walkthrough |
| **Windows 终端** | ✅ `bootstrap-fork --type=ptyHost` 进程存在；面板出现 `powershell - spike-workspace`，`.xterm` 已挂载 |
| Token 鉴权 | ✅ 无 token 403，有 token 302 |
| **Webview 离线** | ✅ workbench HTML **零** `vscode-cdn.net` / `vscode-webview.net` 引用；`webview/browser/pre/index.html` 本地 200 |

进程拓扑（Windows 实测）：`server-main` + `extensionHost` + `ptyHost` 三个 node 进程。

### 2.2 跨站 Cookie 问题（M0.5 已闭环）

服务端签发的是：

```
Set-Cookie: vscode-tkn=<token>; Max-Age=604800; SameSite=Lax
```

访问 `/?tkn=X` 会 **302 到 `/`**，token 从 URL 转存进 Cookie。
`SameSite=Lax` 意味着**跨站的 iframe 拿不到这个 Cookie**，302 之后就是 403。

**M0.5 用 `http://tauri.localhost:39218` 复刻了真实 Tauri 前端 origin，
把 iframe target 作为唯一变量做了 A/B/C 对照**（每次都先清 Cookie；
判据是从父页读 `iframe.contentWindow.length` —— workbench 有 ≥1 个子 iframe，403 纯文本页为 0）：

| 父 origin | iframe target | 子 frame 数 | 结果 |
|---|---|---|---|
| `tauri.localhost:39218` | `127.0.0.1:39217` | 0 | ❌ 主文档 **403 Forbidden** |
| `tauri.localhost:39218` | `aris-code.localhost:39217` | 0 | ❌ 同样 403（`*.localhost` 兄弟域**不同站**） |
| `tauri.localhost:39218` | **`code.tauri.localhost:39217`** | **1** | ✅ **workbench 完整加载** |
| `127.0.0.1:39218`（对照） | `127.0.0.1:39217` | 1 | ✅ 同站，本来就能过 |

成功那一组服务端日志：

```
[ManagementConnection] New connection established.
[ExtensionHostConnection] New connection established.
[ExtensionHostConnection] <29836> Launched Extension Host Process.
```

WebSocket、扩展主机全部起来了 —— 整条链路在真实 origin 下打通。

#### 结论：iframe 可用，但**必须**用 `code.tauri.localhost` 寻址

Chromium 把 `localhost` 当 public suffix，所以 `code.tauri.localhost` 与
`tauri.localhost` 的注册域同为 `tauri.localhost` → **同站** → Lax Cookie 正常流转。
而 `aris-code.localhost` 与 `tauri.localhost` 是**兄弟**，属于不同站，过不去。

三条硬约束：

1. **子域名前缀不能是 `tauri.`**。wry 的 WebView2 拦截过滤器是 `http://tauri.*`
   （`wry-0.55.1/src/custom_protocol_workaround.rs:41-42`，判定见同文件
   `is_work_around_uri`：只要 URI 以 `http://tauri.` 开头就被自定义协议处理器吞掉）。
   `http://code.tauri.localhost` 以 `http://code.` 开头，**不匹配**，安全。
2. 服务端仍绑 `127.0.0.1`（`code.tauri.localhost` 由 Chromium 内置规则解析到 loopback）。
   顺带发现：**VS Code server 不校验 Host 头**（任意 `*.localhost` 都回 302），
   这正是本方案成立的原因，但也意味着必须靠 bind 地址而不是 Host 来做边界。
3. 校验环境是 Chromium 内核浏览器；WebView2 同为 Chromium、Cookie 栈一致，
   但**首次在真 app 里跑通前，这一条按"高置信度未终验"记**。

#### 因此不需要的东西

- ~~Tauri 子 webview~~：`Window::add_child` 在 tauri 2.11.2 被
  `#[cfg(all(desktop, feature = "unstable"))]` 门控（`tauri-2.11.2/src/window/mod.rs:1127`），
  本可作为退路，但现在**不必开 `unstable`**。
- ~~Rust 侧同源反向代理~~：不需要代理 WebSocket。
- ~~`--without-connection-token`~~：**永远不要**。WS 不受 CORS 保护，
  等于任意网页可连上拿本机代码执行权。

已排除的假绕法：`--server-base-path /<随机串>` **不是**访问门禁
（实测加了之后 `/` 仍 200、`/<随机串>/` 反而 404，它只用于反代前缀声明）。

---

## 3. 目标架构

```
┌─ Tauri 主窗口 (React) ─────────────────────────────────┐
│ 左侧导航  │  ┌── VSCodium Workbench ─────────────┐ │ Aris │
│ Chat      │  │  资源管理器 / 编辑器 / 终端        │ │ 助手 │
│ Code ★    │  │  Notebook UI（内置 ipynb 扩展）     │ │ 面板 │
│ LaTeX     │  │  aris-code-bridge.vsix ◄──────────┼─┼──┐  │
└───────────┴──┴───────────────────────────────────┴─┴──┼──┘
                            │ 子进程(隐藏窗口)           │ WS
                   ┌────────▼────────────────────────────▼──┐
                   │ Rust: codeserver.rs + bridge (axum)     │
                   │  ├ 下载/校验/解包/起停/健康检查         │
                   │  └ JSON-RPC: 内核执行·上下文·保存事件   │
                   ├─────────────────────────────────────────┤
                   │ crates/notebook (ZMQ + MATLAB) / chat   │
                   └─────────────────────────────────────────┘
```

**VS Code 只当编辑器外壳。** Aris 的大脑一个都不搬进去，全部通过桥接调用。

---

## 4. 关键设计决策

### 4.1 Windows 安装包内置运行时

**实测体积账**（2026-08-26）：

| 项 | 数值 |
|---|---|
| 当前 Windows 安装包 `SomniQ Studio_0.4.55_x64-setup.exe` | **141.2 MB** |
| 当前已打包资源 `src-tauri/resources`（Tectonic + Typst + Playwright MCP） | 328 MB → 压后 61.6 MB（≈5.3:1） |
| VSCodium 载荷解包后 | 336 MB |
| 同载荷 LZMA2 -mx9 solid 压缩（NSIS 同款算法，实测） | **55.7 MB** |
| 砍掉 mermaid 扩展 + source maps + microsoft-authentication 后 | 48.9 MB（**只省 6.8 MB**） |

载荷构成：`node.exe` 91.7 MB / `node_modules` 104 MB / `extensions` 111 MB
（其中 `mermaid-markdown-features` 一个就 59 MB，是同一份 mermaid bundle 存了三遍，
LZMA solid 会把它压到近乎为零——**所以裁剪内置扩展不划算，别做**）。

因此 Windows 默认 release 采用随包分发：

- **构建机下载并校验 103 MB 的 gzip tarball**，解压成纯 tar 放入被 Git 忽略的
  `desktop/src-tauri/resources/code/<version>/`；NSIS 再把它压到约 56 MB，随安装包发布。
- **本次实测安装包为 141.2 MB**（历史基线 61.6 MB，增加约 79.6 MB；其中 Code
  运行时的 NSIS 压缩载荷约 55.7 MB）；用户首次点击 Code 时只做本地解包和校验，
  不再需要网络下载，运行时落在 `%LOCALAPPDATA%\SomniQ\code\<version>\`，占盘约 336 MB。
- 开发构建或没有生成资源的非 Windows 构建仍保留已校验的下载兜底。

- **优先在 somni.chat 做镜像**，并保留官方 GitHub fallback；**重新打包不要沿用
  VSCodium 的 gzip tar**：
同样内容 gzip 是 103 MB、LZMA 是 56 MB，白白多传 46%。
下载/校验/解包所需依赖在树内：`reqwest`(blocking+rustls)、`sha2`、`tar`、`flate2`
（`desktop/src-tauri/Cargo.toml:32-39`）。构建脚本只负责把可信 gzip tarball
转成 NSIS 更容易压缩的纯 tar；运行时仍由同一条解包、校验和 patch 路径安装。

### 4.2 进程必须隐藏窗口

用现成的 `crate::process::hidden_command`（`desktop/src-tauri/src/process.rs:7`），
禁止裸 `Command::new`，否则每次启动 Code 页闪控制台
（jupyter-zmq-client 踩过同样的坑）。

### 4.3 Notebook 走自研 NotebookController

内置 `ipynb` 扩展已提供 `.ipynb` 的编辑 UI 与序列化。
`aris-code-bridge` 注册两个 controller：

- `Aris Python` → 现有 ZMQ 内核管理器
- `Aris MATLAB` → 现有 file-IPC 后端

执行请求经 WS 打到 `crates/notebook`。**不装 `ms-toolsai.jupyter`**——
它接不了我们的 MATLAB 后端，自研 controller 反而是差异化能力。

补全 / inspect 复用现有 `lab_complete` / `lab_inspect` 通道。

### 4.4 权限模型（已决策：接受）

Chat 的四档权限（`read-only` / `workspace-write` / `prompt` / `danger-full-access`）
只约束 **AI 发起**的动作，不约束用户自己。
内置终端和任意插件安装会给用户完整本地执行权，这是刻意接受的。
**首次启动 Code 页必须明确告知。**

### 4.5 编辑历史要接上影子 Git

现有回滚设计钩在 Typeset 的 `save()` 上，VS Code 的保存完全绕开它。
桥接必须：

- 监听 `onDidSaveTextDocument` → 喂给同一个提交池；
- AI 回合开始前 `saveAll`，结束后触发 reload，
  避免「AI 改磁盘 vs 编辑器脏 buffer」的老问题。

### 4.6 协议类型单一来源

wire 类型定义在 `crates/remote-protocol`，TS 侧生成而非手抄。
（审计已记「wire 类型三处手写是最高漂移风险」，不要加第四处。）

### 4.7 旧代码：能删的和不能删的

（M5 已执行，实际处置见 §12。）

| 文件 | 处置 |
|---|---|
| `desktop/src/lab/CodeEditor.tsx` | **保留** — `desktop/src/typeset/Typeset.tsx:56` 依赖 |
| `desktop/src/lab/labEditorCore.ts` | **保留** — chat 四处依赖（`FilePathMenu` / `openChatFile` / `SideFileViewer` / `sidePanelFiles`） |
| `desktop/src/lab/Lab.tsx` (2176 行) | 退役 |
| `LabFiles.tsx` / `FileEditorPane.tsx` / `Terminal.tsx` | 退役 |
| `desktop/src-tauri/src/terminal.rs` | 退役 — 仅 `lab/Terminal.tsx` 使用 |
| `LabAssistant.tsx` / `ComputePanel.tsx` | 保留为应用侧面板，先不搬进 VS Code |

---

## 5. 里程碑

| | 内容 | 验收标准 | 工期 |
|---|---|---|---|
| ~~M0~~ | ~~go/no-go 探针~~ | ✅ **已通过** | 已完成 |
| ~~M0.5~~ | ~~真机 origin 嵌入验证~~ | ✅ **已通过** — iframe 走 `code.tauri.localhost` 打通 WS + 扩展主机 | 已完成 |
| ~~M1~~ | ~~运行时生命周期 `codeserver.rs`~~ | ✅ **已落地** — 见 §7 | 已完成 |
| ~~M2~~ | ~~外壳接入~~ | ✅ **已落地** — 见 §8 | 已完成 |
| ~~M3~~ | ~~桥接 + `aris-code-bridge`~~ | ✅ **已落地** — 见 §9 | 已完成 |
| ~~M4~~ | ~~Notebook 对等~~ | ⛔ **不做** — 改为装官方插件，见 §10 | 已决策 |
| ~~M5~~ | ~~退役旧 Lab~~ | ✅ **已落地** — `src/lab/` 与 `lab.rs`/`terminal.rs` 已删，flag 已去，见 §12 | 已完成 |

合计约 **5–7 周**。

---

## 6. 不可逆点 / 风险

1. **Open VSX 天花板**：Pylance、C/C++（`ms-vscode.cpptools` 实测不在 Open VSX）、
   C#、Remote-SSH 永远不会有。Python 语言服务要用 basedpyright / Jedi 顶替 Pylance。
   这是本方案最大的功能代价。
2. **当前安装包实测 141.2 MB，用户磁盘增加约 336 MB**。构建机仍需从镜像或 GitHub
   下载约 103 MB 的源 tarball；用户安装后不需要首次联网下载，但 NSIS 更新会重复携带这部分载荷。
3. **网页版连带影响**：云端托管路线下这个服务端要**每租户一份**
   （Node 进程 + 336 MB 磁盘 + 完整 shell），成本模型与现在完全不同。
4. **VSCodium 跟版节奏**：1.126 距今约 7 周，可接受，但要有版本 pin + 升级验证流程。

---

## 7. M1 实现记录（已落地）

新增 `desktop/src-tauri/src/codeserver.rs` + `src/tests/codeserver.rs`，
在 `lib.rs` 注册 `CodeServerState`、三个命令与退出清理钩子。
新增依赖 `tar` + `flate2`（两者本来就在 lock 里当传递依赖，无新增编译单元）。

### 7.1 命令面

| 命令 | 行为 |
|---|---|
| `code_server_status` | 只读快照，无副作用，可轮询 |
| `code_server_ensure(folder?)` | 幂等：装（首次）→ 起 → 健康检查 → 返回 iframe 用的 URL；已就绪时只换 workspace |
| `code_server_stop` | 停服务 + 杀子进程树，并**取消进行中的下载** |

`Phase` = `idle · downloading · extracting · starting · ready · failed`。
`idle` 只表示"没在跑"，**是否装好由 `installed` 字段单独从磁盘读**。

### 7.2 落进代码的关键决策

- **绕开 `bin/codium-server.cmd`**，直接 `hidden_command(node.exe) out/server-main.js`。
  那个 `.cmd` 只是转发；走它就得起 `cmd.exe`（`CreateProcess` 不能直接跑 `.cmd`，
  而且会闪控制台窗口）。
- **`--port 0` + 从 stdout 解析实际端口**（`Server bound to 127.0.0.1:<port>`），
  不猜端口，避免和机器上其它进程抢。stdout/stderr 各有一个常驻读取线程，
  否则管道写满后服务端会卡死。
- **安装是原子的**：下到 `<version>.staging` → 校验 sha256 → 解包 → 确认
  `node` 和 `out/server-main.js` 都在 → 写 `.aris-installed` 标记 → rename 到位。
  中途崩溃只会留下一个"看起来没装"的目录，不会留下半残的运行时。
- **健康检查要求无 token 请求返回 403**。若返回 200 说明服务端起来时没带鉴权，
  直接判失败并杀掉——不是"能连上就行"。
- **`busy` claim**：React StrictMode 会让 effect 跑两次，没有这个标志位
  第二次 `ensure` 会把第二份下载塞进同一个 staging 目录并起第二个服务。
- **`cancel` 标志**：`reqwest` 0.12 的 blocking builder 没有 `read_timeout`
  （只有 async 侧有），所以只能靠 60 分钟的整请求上限兜底。真正的逃生口是
  `code_server_stop` —— 下载循环每个 chunk 检查一次，否则一次卡死的下载会让
  `busy` 永久为真、之后每次重试都被拒，直到重启应用。
- **`ManagedProcessKind::Mcp`**：跟 `crates/notebook` 的内核走同一惯例，
  拿到进程树清理能力，又不会出现在用户可见的后台进程列表里被误杀。

### 7.3 验证

- Code server focused suite 50 个测试（49 passed / 1 ignored；含"URL 必须用
  `code.tauri.localhost`"、"host 不能被 wry 的 `http://tauri.*` 过滤器吞掉"、
  "用户状态目录不能在版本目录下"这三条把 §2.2 的结论钉死的回归测试）。
- 端到端测试 `installs_and_starts_the_real_runtime`（默认 `#[ignore]`）：
  用真 tarball 起本地 HTTP → 下载 → 校验 → 解包 336 MB → 起服务 → 解析端口 →
  健康检查 → 断言 URL 形态 → 关停并确认 PID 已死。**实测 27s 通过。**

  ```bash
  ARIS_CODE_RUNTIME_ARCHIVE=<tarball 路径> cargo test --lib codeserver::tests::installs_and_starts -- --ignored
  ```

- 桌面全量 Rust 套件 **460 passed / 0 failed**；`codeserver.rs` clippy 零命中。

### 7.4 M1 未做的部分

- **崩溃自动重启**未实现。目前服务端进程死掉后状态仍是 `ready`，
  UI 会指向一个死端口。留给 M2 一起做（前端能感知 iframe 失败才好决定重试策略）。
- **`somni.chat` 镜像还不存在**，`download_urls` 会先试镜像、失败后回落 GitHub。
  镜像上线前首次安装走的是 GitHub 那条慢路径。

---

## 8. M2 实现记录（已落地）

新增 `desktop/src/code/`（`CodePane.tsx` / `i18n.ts` / `Code.css` / `CodePane.test.tsx`），
`store.ts` 加 `codeEngine` 开关，`GeneralSettings` 加切换控件，
`App.tsx` 在 `lab` 标签页按开关渲染 `CodePane` 或 `LabPane`。

### 8.1 开关默认 `legacy`

`code.engine = legacy | vscode`，存 localStorage（`somniq-code-engine`），
**默认 `legacy`**。桥接（M3/M4）没落地之前切过去会丢掉 Jupyter 和 MATLAB 内核，
所以由用户在「设置 → 通用 → Code 页编辑器」显式选择。M5 再翻默认值。

### 8.2 首次进入的两道闸

1. **权限告知**：内置终端和第三方插件以用户身份运行、不受对话权限档位约束。
   这是 §4.4 决策的唯一缓解措施，所以必须在装任何东西之前显示，确认后记 localStorage。
2. **不隐式准备**：首次使用的本地解包和插件安装只在用户点「准备并启动」后开始。
   运行时已在磁盘上时才自动启动。

### 8.3 实测推翻的两个设计（重要）

用 `tauri.localhost:39220` 父页 + 真实 `server_args` 起的服务做端到端验证时，
workbench 正常加载（子 frame = 1），但发现两处原设计是错的：

**① 主题 seeding 是死代码，已删除。**
往 `--user-data-dir/User/settings.json` 写主题**完全无效**：

- 实测服务端根本不读那个目录（只留下我手写的文件，自己在
  `--server-data-dir/data/User` 下另建了目录，且那里也没有 `settings.json`）；
- 改用 `product.json` 的 `configurationDefaults` 同样无效
  （连 `workbench.startupEditor: none` 都没生效，Welcome 页照出）;
- 真实位置是**浏览器 IndexedDB**：workbench origin 下存在
  `vscode-web-db` / `vscode-web-state-db-*`，localStorage 里有
  `userDataProfiles`、`monaco-parts-splash`。

因此 `code_server_ensure` 的 `theme` 参数一并删掉——不发布一个什么都不做的参数。
主题跟随留到 M3：桥接扩展在扩展主机里可以直接调
`workspace.getConfiguration().update()`，那才是能写进去的正路。

**② `--port 0` 会每次重启清空用户设置，已改为固定端口段。**
既然设置存在浏览器里、按 **origin** 隔离，而 origin **包含端口**，
临时端口意味着用户每次重启应用，主题、字号、布局、UI 状态全部回到默认。
改成 `--port 52411-52430`（服务端取段内最低空闲端口）。
实测连续两次启动都拿到 `52411`。只有端口被占用时才会漂移并重置状态。

### 8.4 其它

- **崩溃检测**（M1 遗留项）已补：`Inner::poll_liveness` 用 `child.try_wait()`
  发现自己死掉的服务端，`code_server_status` 每次调用时检查，前端 5s 轮询一次，
  失败态给「重试」而不是一个白框。`ensure` 开头也会 poll，
  避免崩溃后被过期的 `Ready` 短路。
- **iframe 重挂键 = 完整 URL**：重启会同时换端口和 token，两者都在 URL 里；
  只盯 `folder` 会让 iframe continue 指向死服务端。
- `.app-code-pane` 与 `.code-pane` 都是 `position:absolute; inset:0`。
  workbench 按视口自算尺寸，容器必须是有界的——用百分比高度会让它撑出窗口，
  把 workbench 自己的滚动条顶到视野外。

### 8.5 验证

- Rust 28 个单测（新增端口段/无 `--user-data-dir`/崩溃检测 4 条）+ 端到端 31s 通过；
  桌面全量 **465 passed**，`codeserver.rs` clippy 零命中。
- 前端 `CodePane.test.tsx` 12 例（权限闸、不隐式下载、崩溃重试、取消、
  切项目重定向、iframe src）；前端全量 **885 passed / 77 files**，`tsc --noEmit` 干净。
- 真实 origin 端到端：`tauri.localhost` 父页 iframe 真实 `code.tauri.localhost:53729`
  workbench 加载成功，用的是 `server_args` 实际产出的参数和 `workbench_url` 实际拼出的 URL。

### 8.6 M2 未做的部分

- **主题不跟随应用**（见 8.3①），用户需在 VS Code 内自行选主题；端口稳定后该选择会保留。
- **`somni.chat` 镜像仍不存在**，首次安装走 GitHub 慢路径。

---

## 9. M3 实现记录（已落地）

| 位置 | 内容 |
|---|---|
| `crates/remote-protocol/src/code_bridge.rs` | wire 类型单一来源（Rust 端），6 个单测 |
| `desktop/src-tauri/src/codebridge.rs` | loopback WS 服务端 + 握手鉴权 + 4 个命令，11 个单测 |
| `desktop/src-tauri/resources/aris-code-bridge/` | 扩展本体（`package.json` + `extension.js`） |
| `desktop/src/code/arisCodeBridge.test.ts` | 扩展的 11 个单测（打桩 `vscode` 模块加载） |

### 9.1 三个实验结论决定了整个形态

开工前用一个探针扩展一次性验证了三件事，全部成立：

1. **文件夹直接放进 `--extensions-dir` 就会被加载并激活**
   （`--list-extensions` 报出 `aris.aris-probe`，`activate()` 真的跑了）。
   → **不用打 `.vsix`**，安装就是一次目录复制。
2. **扩展主机的 node 是 v24.15.0，`typeof WebSocket === "function"`**。
   → **不用 `ws` 依赖**，用全局 `WebSocket`。
3. **`ARIS_BRIDGE_URL` 环境变量能从服务端进程传进扩展主机**。
   → 桌面端 spawn workbench 时把地址和 token 塞进 env 即可，**不需要发现协议**。

三者合起来的结果：扩展是**零依赖、零构建步骤的纯 CommonJS**，
桌面构建不引入第二套工具链，这个文件本身保持可评审。

### 9.2 方向：桌面是服务端，扩展是客户端

反过来（扩展监听、桌面发现）没有 bootstrap——只有桌面同时知道两个地址。
loopback **不是**信任边界，本机任何进程都能连，所以第一帧必须是带 token 的
`hello`，别的一律断开；token 比较走常数时间，避免本地进程靠计时缩小搜索空间。
两个方向的 serde tag 不重叠，一侧的帧不会在另一侧解成合法消息。

### 9.3 保存事件落到 `change_ledger`，不是影子 Git

影子 Git 仍是提案（`edit-history-rollback.md`），而 `crates/runtime/change_ledger.rs`
是**已经在跑**的东西——AI 的编辑工具就写它。所以 VS Code 的保存直接调
`record_text_file_change`，`tool_name = "vscode-editor"`。目标是**一份历史**：
只记录模型改了什么的历史，是把用户从历史里删掉了。

没有 baseline 时**不记录**。拿 `after` 和空文件做 diff 会声称用户一次性写了整个文件。
`reload-from-disk` 会清掉缓存 baseline，否则 AI 写完之后用户的下一次保存
会看起来像是把 AI 的改动也一起撤了。

### 9.4 主题跟随：M2 的限制在这里解决了

M2 记录过「web workbench 的设置在浏览器 IndexedDB 里，磁盘上写什么都没用」。
扩展主机是唯一的门：`workspace.getConfiguration().update(..., Global)`。
用 `Global` 作用域是因为它等价于用户自己选主题，所以**用户之后的选择会覆盖它**
——桌面推的是默认值，不是强制值。

**实测确认**：`set-theme dark` 之后 workbench 的 class 从
`vs ...2026-light-json` 变成 `vs-dark ...dark_modern-json`，状态栏出现 "Aris"。

### 9.5 端到端验证

用一个复刻握手规则的 Node stand-in 当桥接服务端，装真扩展、起真 workbench：

```
RECV hello {"type":"hello","token":"m3token","protocol_version":1,"vscode_version":"1.126.0"}
SEND welcome
SEND set-theme dark        → workbench 实测变成 dark_modern
SEND save-all
RECV save-all-done {"type":"save-all-done","saved":[],"failed":[]}
```

全套：remote-protocol **64 passed**、桌面 Rust **476 passed**、
前端 **902 passed / 78 files**，clippy 对两个新模块零命中。

### 9.6 M3 未做的部分

- **`save-all-done` 目前没有消费方**。协议里留着是为了握手完整，
  但「AI 回合开始前自动 saveAll」还没有接进 Chat 的回合生命周期——
  现在只有 `code_bridge_save_all` 命令可被显式调用。接进去要改 Chat 的回合入口，
  属于独立改动，没有塞进 M3。
- **保存事件不带 session/turn id**（`FileMutationContext` 三个 id 都是 `None`），
  因为用户的手动保存本来就不属于任何一个 AI 回合。
- **`somni.chat` 镜像仍不存在**。

---

## 10. M4 决策：不自研 Notebook Controller，装官方插件

**2026-08-26 决定：放弃 §4.3 的自研 `NotebookController` 方案。**
Notebook、Python、MATLAB 的官方扩展都在 Open VSX 上，都是 MIT，都在维护：

| 扩展 | 版本 | 说明 |
|---|---|---|
| `ms-python.python` | 2026.4.0 | 连带装 `debugpy`、`vscode-python-envs` |
| `ms-toolsai.jupyter` | 2025.9.1 | 连带装 renderers / keymap / cell-tags / slideshow |
| `MathWorks.language-matlab` | 1.3.13 (2026-07-28) | **语言扩展**，分类是 Programming Languages / Snippets / Debuggers，**不含 Notebooks** |

自研 controller 是在重造已经存在的东西，还会让用户失去上游的变量浏览器、
绘图查看器、notebook 调试。**这个判断是对的，之前的方案文档把理由写窄了。**

### 10.1 这个选择买单的是什么

`crates/tools/src/lib.rs` 里 AI 有一整套 notebook 工具
（`NotebookExecute`、内核 start/restart/interrupt、整本运行 + papermill 参数），
它们驱动的是 `crates/notebook` 自己的内核管理器。

**同一个 `.ipynb` 因此有两个内核、两份变量状态。**
用户跑完 cell 1–5 定义了 `df`，转头让 Aris 画残差图 → `NameError`。

已接受。缓解措施是把这件事**写进工具描述**，让模型知道而不是静默撞墙：

> This kernel is separate from the one the user's editor runs: variables the
> user defined by running cells themselves are NOT visible here, and vice
> versa. If the user refers to state they created interactively, re-run the
> cells that produce it rather than assuming it exists.

AI 的 notebook 工具**没有删除**——那是砍能力，需要单独决策。

### 10.2 实现

`codeserver.rs` 新增 `Phase::Extensions`：首次启动时装
[`DEFAULT_EXTENSIONS`]，写 `.aris-defaults` 标记，之后不再推送
（用户卸载了某个扩展，下次启动不会被塞回来）。
**安装失败只警告不致命**——首次运行的网络抖动不该让 Code 页打不开。

实测：三个扩展 + 6 个传递依赖共 9 个，**30.6 秒**装完，占盘 **141 MB**。

### 10.3 端到端验证（真机）

装完扩展起 workbench，打开 `.ipynb`：

- 完整 notebook UI（Code / Markdown / Run All / Clear All Outputs / Outline）
- 执行 cell → `[1]` 执行计数、`0.0s`、输出渲染 webview 就绪
- Welcome 页出现 Python 和 Jupyter 的 walkthrough，两个扩展都激活

### 10.4 验证过程中挖出的两件事

**① `folder` 参数用原生 Windows 路径会丢盘符（真 bug，已修）。**
传 `folder=C%3A%5CUsers%5C…` 时，workbench 标题变成
`\Users\wt\…`、资源管理器解析不了任何东西——**看起来像空工作区而不是报错**，
所以 M0–M3 一路都没发现。正确格式是 URI path：`/c:/Users/wt/…`
（小写盘符、正斜杠、前导斜杠），和服务端自己的
`vscode-remote-resource?path=` 用的是同一种形状。
已加 `folder_uri_path()` + 3 个回归测试。

**② Workspace Trust 会拦住执行（已处理）。**
新工作区默认 Restricted Mode，点 Run 没反应，只有一条细横幅提示。
信任之后才恢复（实测信任后 cell 立刻跑通）。

这和 §4.4 已决策的权限模型**相关但不重复**：前者说明编辑器能力的权限边界，
后者决定当前文件夹是否允许 VS Code/扩展执行工作区内容。Workspace Trust 防的是
"别人发来的仓库"，所以继续保留。

web workbench 原本把 `security.workspace.trust.startupPrompt` 默认设成 `never`，
只显示容易漏看的横幅。`codeserver.rs` 在运行时 bundle 中把这个默认改成 `always`：
打开每个尚未信任的项目文件夹时，VS Code 原生模态框会强制让用户选择“信任”或
“不信任（受限模式）”。用户显式设置该配置时仍覆盖这个默认值；已有安装会在启动
前补应用新补丁，因此无需依赖运行时版本号变化。

**③ 内核显示名是 `Python undefined.undefined.undefined`**（仅显示层，执行正常）。
Python 扩展在这个环境里读不到解释器版本号，暂记为已知瑕疵。

---

## 11. 切换：Code 页默认改为嵌入式 VS Code

`codeEngine` 默认值从 `legacy` 翻成 `vscode`。旧编辑器**没有删除**，
仍可在「设置 → 通用 → Code 页编辑器」切回去。

### 11.1 直接翻默认值会砍掉三样东西，其中一样必须救

盘点旧 Lab 里 VS Code 没有对应物的部分：

| 能力 | 处置 |
|---|---|
| **远程算力面板** | **已接过来**。`ComputePanel` 只有 Lab.tsx 一个入口，`compute_submit` 别处没有——直接切默认值等于让远程 GPU 提交从默认路径上消失 |
| 页内 AI 助手 `LabAssistant` | **不接**。Chat 标签页 + 桥接的 `Ask Aris`（右键 / `Ctrl+Alt+A`）已经覆盖；在 CodePane 里再复制一整套聊天界面成本太高 |
| sweep 批量运行 / run 记录 | **不接**。留在旧引擎里，设置里可切回 |

### 11.2 为此扩了两条桥接消息

**`ActiveEditorChanged`（扩展 → 桌面）。**
算力面板要提交"你当前打开的那个文件"，而那个信息在 iframe 里。
扩展监听 `onDidChangeActiveTextEditor` / `onDidChangeActiveNotebookEditor`，
并在收到 `welcome` 时**主动上报一次**——socket 打开之前发生的切换桌面全都错过了。
notebook 优先于文本编辑器。

**`OpenFile`（桌面 → 扩展）。**
聊天里点文件路径原本靠 `pendingLabFilePath` 交给 Lab.tsx 打开。
旧引擎读 store，workbench 自己管标签页——**发错地方就是点了没反应**。
`openChatFile.ts` 现在按引擎分流。`.ipynb` 走 `vscode.open` 而不是
`showTextDocument`，后者会把 notebook 当成裸 JSON 打开。

实测确认 `activeNotebookEditor` / `onDidChangeActiveNotebookEditor` 是稳定 API
（若是 proposed API，扩展会在激活时抛异常、整条桥接失效）。

### 11.3 又一个只在开发模式发作的坑（已修）

`code.tauri.localhost` 是按**打包后**的 app origin（`tauri.localhost`）选的。
但 `tauri dev` 的 origin 是 `http://127.0.0.1:1420`——
`code.tauri.localhost` 从那里看是**跨站**，token cookie 被丢，
Code 页 403，而且**只在开发模式复现**。

改成跟随 app 自己的 hostname（前端传 `window.location.hostname`）：

| app origin | workbench host |
|---|---|
| `tauri.localhost`（打包） | `code.tauri.localhost` |
| `127.0.0.1` / `localhost`（`tauri dev`） | 原样复用，同站 |
| 其它 / 缺失 | 回落 `code.tauri.localhost` |

### 11.4 实测

真机 workbench 上逐条验过：

```
RECV hello                → 桥接握手
RECV active-editor-changed  path=…/demo.ipynb   is_notebook=true
RECV active-editor-changed  path=…/main.py      is_notebook=false
SEND open-file README.md  → README.md 在 workbench 里打开成新标签页
RECV active-editor-changed  path=…/README.md
```

状态栏显示 `✓ Aris`。全套：remote-protocol **65**、桌面 Rust **482**、
前端 **910 / 78 files**，clippy 对两个新模块零命中。

### 11.5 仍未做

- ~~`Lab.tsx` 等文件**没有删**，`terminal.rs` 也还在~~ → M5 已删，见 §12。
- ~~Workspace Trust 的取舍仍未决定~~ → 启动选择已由运行时补丁启用（§10.4②）。
- `somni.chat` 镜像仍不存在。

---

## 12. M5 实现记录：旧 Lab 已删除（已落地）

`codeEngine` 开关连同旧引擎一起去掉了 —— Code 页现在只有嵌入式 workbench 一种形态。
净删除约 **7,000 行**（前端 `src/lab/` 6,678 行 + `Lab.css` 3,733 行，
后端 `lab.rs` 867 行 + `terminal.rs` 157 行 + `tests/lab.rs` 52 行）。

### 12.1 四个幸存者搬了家，`src/lab/` 整个目录删掉

留一个以退役功能命名的目录只会让后来的人以为它还活着。

| 原位置 | 新位置 | 理由 |
|---|---|---|
| `lab/CodeEditor.tsx` | `editor/CodeEditor.tsx` | 只剩 Typeset 用；它本来就只 import `../editor/*` |
| `lab/labEditorCore.ts` | `editor/workspaceFiles.ts` | Chat 四处依赖的是文件路由，与"Lab"无关 |
| `lab/ComputePanel.tsx` | `code/ComputePanel.tsx` | 唯一消费者是 `CodePane` |
| `lab/tests/ComputePanel.test.tsx` | `code/ComputePanel.test.tsx` | 跟着组件走 |

`labTypes.ts`、`i18n.ts`、`labStore.ts`、`outputs.tsx`、`textDiff.ts` 随 Lab 一起删除。
`workspaceFiles.ts` 同时砍掉了 8 个只有自己的测试在调用的导出
（`normalizePath` / `selectedTextOrCurrentLine` / `editorSelectionOrLine` /
`runtimeChoiceForLanguage` / `detectExternalFileChange` 及其三个类型），
只留 `basename` / `extension` / `languageForPath` / `workspaceFileOpenTarget`。

### 12.2 ComputePanel 的样式此前根本没生效（真 bug，已修）

算力面板用的全是 `.lab-*` 类，而这些规则只存在于 `lab/Lab.css`，
**那个文件只被 `Lab.tsx` import**。默认引擎切到 VS Code 之后 `Lab.tsx` 再也不会加载，
所以 §11.1 说"已接过来"的面板其实是**裸样式**的 —— 因为它只在 iframe 右侧的
折叠抽屉里，之前没人正眼看过。

现抽出 `code/ComputePanel.css`，并做两件事：

1. 类名 `lab-*` → `compute-*`，由组件自己 import 样式表；
2. `--lab-divider` / `--lab-panel-raised` 原本声明在 `.lab` 根元素上，
   面板已经不在那个元素底下 —— 改为声明在 `.compute-panel` 自身。
   同时把旧表末尾那段"structural chrome"覆盖**合并进基础规则**，
   而不是照抄成又一层后置覆盖（styles.css 的级联坑不要再复制一份）。

### 12.3 `.lab-editor` → `.code-editor`

Typeset 的 CodeMirror 容器一直挂着 `.lab-editor`，31 条规则都在 `Typeset.css` 里、
且全部限定在 `.typeset-editor-body` 之下，所以整体改名是安全的。
顺带删掉 4 组早已没有元素产出的旧 textarea 遗留规则
（`.lab-editor-{lines,pre,input,diff-overlay}`）。

### 12.4 顺带清掉的死代码

- `api/labPreview.ts` → `api/browserPreview.ts`：删掉 notebook / kernel / runs /
  variables 全部预览桩（163 行）与 `isLabPreviewMode`。
  `isFilePreviewMode` 改由 `isPlainBrowserRuntime() || isTypesetPreviewMode()` 判定，
  `package.json` 的 `dev:lab` 脚本一并删除。
- `api/tauri.ts`：22 个 `lab_*` + 6 个 `terminal_*` 包装器、`runsLoad` 全删（174 行）。
- `store.ts`：`codeEngine` / `setCodeEngine` / `CodeEngine` 类型 /
  `somniq-code-engine` 存储键 / `pendingLabFilePath`（workbench 走桥接，不读 store）。
- `styles.css`：`.app.app-lab-workbench`（两处，无元素产出）。
- `Cargo.toml`：`portable-pty`（只有 `terminal.rs` 用）。

### 12.5 没有一起删的

- **AI 的 notebook 工具**（`crates/tools` 的 `NotebookExecute` / `NotebookSweep` 等）
  完全没动 —— 它们直接驱动 `crates/notebook`，不经过被删的 `lab.rs`。
  **sweep 因此仍然可用**，只是入口从 Lab 的按钮变成了对话。
- **`notebook` crate 依赖保留**：`compute.rs` 的远程 GPU 作业和 `lib.rs`
  退出时的 `shutdown_all()` 还在用。
- **tab id 仍是 `"lab"`**：改它要动 store / 持久化 / 导航 / 一堆测试，
  与本次"删代码"是两件事。用户看到的标签是"Code / 代码"，不受影响。
- **页内 AI 助手（`LabAssistant`）随 Lab 消失**，按 §11.1 的决策不补
  —— Chat 标签页加桥接的 `Ask Aris`（右键 / `Ctrl+Alt+A`）已覆盖。

### 12.6 验证

桌面 Rust **482 passed / 0 failed**（`cargo check` 仅剩一条与本次无关的
`remote.rs` 未使用函数告警）；前端 `tsc --noEmit` 干净，
`vitest` 全量 **887 passed / 77 files**。

---

## 13. 启动故障修复：镜像 200 HTML 与可见浏览器

`somni.chat/runtime/vscodium/...` 在镜像文件尚未部署时会由站点 SPA fallback
返回首页 HTML，HTTP 状态仍是 200。原下载循环把“HTTP 成功”等同于“候选源成功”，
在循环外才校验 SHA-256，因此 HTML 的校验失败会直接终止安装，而不会继续尝试
VSCodium 官方 GitHub Release。

现改为**每个候选源下载后立即校验**，只有匹配官方 sidecar 中固定 SHA-256 的
归档才结束 fallback 循环；错误页或被篡改内容会被删除并继续下一个来源，安全门槛
不变。

桌面启动期的 Playwright PDF worker 仍需为 Playwright MCP 提供固定 CDP 端点，
但它不应因为用户打开 SomniQ 就显示一个 Edge/Chrome 窗口。持久上下文现以
headless 模式启动；浏览器 PDF 下载和 MCP 的 CDP 连接保持原有生命周期。

---

## 14. 外观与身份：主题跟随、换掉欢迎页、offline 安装包

三件事一起做的，因为它们都撞在同一堵墙上：**web workbench 的很多东西既不读磁盘上的
`product.json`、也不吃配置**，只能从编译进 `workbench.js` 的字面量下手。

### 14.1 实测确定的三条边界（都推翻了先前的推测）

| 想改的东西 | 走配置 | 走 `product.json` | 结论 |
|---|---|---|---|
| 产品名（标题栏 / 欢迎页大标题 / 关于） | 无此项 | ❌ **无效** | 只能改 `workbench.js` 字面量 |
| `workbench.startupEditor` | ✅ 能写，但**来不及** | ❌ 无效 | 改 schema 的 `default` |
| webview 资源地址 | — | ❌ **无效**（删掉键也不变） | 仍走 `vscode-cdn.net`，见 §14.5 |

`product.json` 为什么无效已经查清楚了：服务端拼给页面的 `productConfiguration` 只有
两项 —— `{embedderIdentifier:"server-distro", extensionsGallery:…}`，`nameLong`
根本不在转发列表里；而能覆盖它的 `_VSCODE_PRODUCT_JSON` 全局在浏览器里是 `undefined`
（页内实测）。所以字面量就是唯一来源。

### 14.2 主题跟随 SomniQ

调色板**在推送时从活的样式表里读**，而不是在 workbench 侧再抄一份：
`desktop/src/code/codeTheme.ts` 用 `getComputedStyle(:root)` 取 `--bg`/`--bg-1`/
`--accent` 等 11 个 token，映射到约 70 个 VS Code 颜色 ID，跟着 `SetTheme` 一起过桥。
改 `styles.css` 里的一个 token，下一次推送 workbench 就跟着变，没有第二处要维护。

两个不显然的点：

- **无法解析成 hex 的 token 直接丢弃，不猜。** VS Code 对
  `colorCustomizations` 里的非法值**不是按键忽略**，而是整份丢掉并报错 —— 所以
  `color-mix(...)` 这类算出来不是颜色的值必须在发送前就过滤掉。
- **语法高亮一个都不碰。** SomniQ 的 `--code-*` 本来就是 Dark+/Light+ 调色板，
  基础主题（`Dark Modern`/`Light Modern`）给的就是它，再自定义等于多养一份。

实测（真 workbench + 复刻握手的 stand-in 桥接）：侧栏 / 活动栏 / 标题栏
`rgb(21,26,33)` = `--bg-1`，编辑器 `rgb(14,17,22)` = `--bg`，**刷新后仍在**
（设置落在 IndexedDB，所以端口段固定这件事在这里第二次生效）。

### 14.3 欢迎页：先堵住上游，再放自己的

先说**走不通的那条路**，因为它看起来最自然：让扩展在 `onStartupFinished` 时把
`workbench.startupEditor` 设成 `none` 再打开自己的 walkthrough。实测**输在时序上** ——
扩展跑起来时 stock 欢迎页早就开好了，设置只对下次启动生效；加 `closeAllEditors`
也没用，workbench 自己的 restore pass 会把分类列表重新盖回来。
（页内实测过：我们的 walkthrough 四个步骤标题**确实在 DOM 里**，只是没被选中显示。）

所以改成两层：

1. **`codeserver.rs` 的 `PATCHES` 把 schema 的 `default:"welcomePage"` 改成
   `"none"`** —— 页面根本不开，没有时序，没有闪烁。用户自己显式设回去仍然有效
   （显式值盖过默认值）。
2. **扩展开一个 webview 面板**当落地页，而不是 walkthrough。理由就是上面那条实测：
   `workbench.action.openWalkthrough` 不能可靠地把自己的 walkthrough 顶到前台。
   webview 完全是我们的，样式全用 `--vscode-*` 变量，所以自动跟随 §14.2 推过去的调色板。

`contributes.walkthroughs` **保留**了 —— 它是 Help → Welcome 里那份 "Get Started
with SomniQ Code"，注册和渲染都实测正常，只是不拿来当落地页。

**"已经展示过"的标记是一条设置，不是 `globalState`。** 这是个真 bug 修正：扩展状态
存在服务端，而 web workbench 的设置存在浏览器里按 origin 隔离 —— 用户清一次浏览器数据、
或者端口段撞车换了 origin，设置没了而标记还在，VSCodium 那页就**永久回来了**。
两者放同一个 store 才会一起重置。
（顺带记一条：`inspect("startupEditor").globalValue` 看起来能免掉这个标记，
但实测在全新 profile 上它**已经有值**，判断永远不成立。）

实测（全新 origin + 全新 profile）：标签页只有一个 `Welcome`，
`Editing evolved` / `VSCodium Announcements` **都不再出现**，webview 已挂载。

### 14.4 Windows 安装包内置运行时

`npm run build:vscodium` 把运行时 vendored 进 `resources/code/<version>/`，
Windows release 的 `beforeBuildCommand` 会自动执行它。`codeserver.rs` 发现资源后
跳过网络下载，走**同一条**解包 → 校验 → patch → 落标记的路径。

- **存成不压缩的 `.tar`**：VSCodium 发的是 gzip，而 NSIS 自己要用 LZMA 再压一遍 ——
  压已压过的东西白费；同样内容纯 tar 交给 NSIS 是 336 MB → ~56 MB。
- **bundled 的那份不再校验 sha256**：它是另一个产物（纯 tar），信任锚点是安装包签名本身；
  解包后对 `node` / `out/server-main.js` 的检查两条路都做。
- 版本号和 sha256 在脚本和 `codeserver.rs` 里各有一份，
  `pinned_runtime_matches_the_offline_build_script` 这条测试盯着它们别漂。

体积账（扩展目录是这次实测的）：运行时 336 MB → 55.7 MB，
9 个扩展 129.7 MB → **26.5 MB**。当前 NSIS 安装包实测 **141.2 MB**（历史基线
61.6 MB），而 NSIS 更新没有增量，Code 载荷每次发版都要随包携带；这是为了让 Windows
安装后可以离线启动 Code 页而接受的成本。

### 14.5 挖出来但没做的：webview 走 CDN

`webviewContentExternalBaseUrlTemplate` 指向 `https://{{uuid}}.vscode-cdn.net/…`，
**删掉 `product.json` 里这个键无效**（和 `nameLong` 一样是编译进去的）。
影响面不止欢迎页：notebook 渲染器、markdown 预览、所有扩展 UI 都是 webview。
M0 记的"webview 离线"只验证了 workbench HTML 不引用 CDN，没验证 webview host 帧。

**对 offline 安装包来说这是个真缺口** —— 装好了不联网，编辑器能开、能编辑，
但 notebook 输出和欢迎页会是空白。修法应该和产品名同类（再加一条 `PATCHES`
指向服务端本地的 `webview/browser/pre/`，M0 实测过那个路径本地 200），**尚未做**。
