# Chat UI 插件（声明式 v1）

用户可通过本地包为 Chat 添加侧栏面板。面板使用 SomniQ 原生组件、字号、
主题和现有侧栏标签导航，支持关闭、重开、按会话恢复布局。
这一版本支持待办、笔记、说明文字和只读 Agent 执行进度；不加载用户 JS、
HTML、CSS 或任意 React 组件。输入框按钮、消息卡片和可执行组件 SDK 尚未开放。

## 创建并使用自己的插件

新建一个目录，写入以下两个文件，不需要 Node、npm 或打包工具：

`package.json`：

```json
{
  "name": "@my-lab/research-desk",
  "version": "1.0.0",
  "description": "我的研究清单",
  "somniq": { "manifestVersion": 1, "ui": "./ui.json" }
}
```

`ui.json`：

```json
{
  "schemaVersion": 1,
  "panels": [{
    "id": "desk",
    "slot": "chat.sidebar",
    "title": { "cn": "研究清单", "en": "Research checklist" },
    "order": 10,
    "widgets": [
      { "id": "intro", "type": "text", "text": "记录下一步与研究线索。" },
      { "id": "todos", "type": "todo-list", "title": "我的待办" },
      { "id": "notes", "type": "notes", "title": "随手记" },
      { "id": "plan", "type": "agent-plan", "title": "执行进度" }
    ]
  }]
}
```

1. 在 SomniQ 选择一个本地项目，打开“插件”页的“导入本地插件包”。
2. 选择这个目录并预览；检查 Chat 面板名称、来源、版本、摘要和诊断。
3. 安装后启用。在 Chat 顶部“打开插件面板”按钮打开首个面板；侧栏“+”
   可选择此项目所有启用的插件面板。重复打开会选择已有标签。
4. 添加、勾选、删除个人待办，或编辑并“保存笔记”。切换聊天后数据独立；
   回到原会话或重启应用，保存的数据保留。

新聊天首页会提示先发送第一条消息，再使用会话面板，避免将个人数据保存到
所有新聊天共用的临时首页草稿。尚未开始聊天时不创建 Todo / 笔记状态。

仓库可直接导入的完整示例：`examples/plugins/chat-workbench`。
示例含“研究清单”和“证据备忘”两个独立面板。
同一个包可同时保留 `dsh.bundle` 提供 Skills/MCP，并增加 `somniq.ui`。

## 配置契约

- `somniq.manifestVersion` 和 UI 文档 `schemaVersion` 均为 `1`。
- `ui` 为包内相对 JSON 文件路径，与已有 DSH 快照一起摘要、预览和冻结。
- `panels` 为 1–12 个面板；每个面板拥有唯一 `id`、`slot`、`title`、
  可选 `order`（默认 0），以及 1–16 个 `widgets`。
- 当前只开放 `chat.sidebar`，按 `order` 从小到大，等序号保持注册顺序。
- 面板 id 和同一面板内的 widget id 允许 `[A-Za-z0-9_-]{1,64}`。
  不同插件可以使用相同 id，宿主以包名隔离。
- 标题可写字符串或 `{ "en": "...", "cn": "..." }`，每种语言最多 80 字符。
- `todo-list`、`notes`、`agent-plan` 字段为 `id`、`type`、`title`。
- `text` 字段为 `id`、`type`、`text`，支持同样的中英格式，每种语言最多
  4000 字符，按纯文本显示，保留换行。
- 未知 slot、组件类型、额外字段、重复 id、越界路径、版本和大小限制
  产生预览诊断并阻止整个包启用，不能静默丢弃。

修改源目录不会改变已安装快照。更新包需先移除再导入、预览并启用。
同包名、同面板 id、同组件 id 的已保存个人数据可沿用；改 id 会创建新作用域。

## 状态与接口

共享 Rust `runtime::plugins` 持有 schema、校验、快照和状态操作。
Tauri 与 devserver 共用三个方法：

- `plugins_ui_list(projectPath)`：返回启用且完整性校验通过的面板声明。
- `plugins_ui_state_get(projectPath, name, panelId, sessionId)`：读取本地状态。
- `plugins_ui_state_update(projectPath, name, panelId, sessionId, expectedRevision, action)`。

宿主桥只接受 `todoAdd`、`todoSetCompleted`、`todoRemove`、`notesSet`。
所有 action 指定 `widgetId`；添加待办/保存笔记指定 `text`，勾选待办指定
`itemId` 和 `completed`，删除指定 `itemId`。客户端组件不能自行扩展动作。

状态文件存放在 `<project>/.somniq/plugins/ui-state/<scope-sha256>.json`。
scope 包含包名、面板 id、会话 id；文件内再次校验身份。待办最多 200 项，
每项 500 字符；每个笔记最多 32000 字符。状态文件读取上限 2 MiB。
与插件注册表共用跨进程锁，验证启用状态与快照后执行动作、校验 revision，
原子保存。陈旧 revision 会拒绝保存并提示重载，笔记草稿仍留在当前面板，
用户可核对后再次明确保存。读取失败不会伪装成空数据或覆盖原文件。

切换项目或会话立即更换组件作用域，并丢弃旧请求结果。插件启停/移除
通知同一窗口的 Chat 重新注册，窗口再次获得焦点时也刷新；停用后卸载
面板与动作，保留个人数据，重新启用后可再次打开。
远端会话不挂载本地项目插件面板。

`agent-plan` 读取现有 `workflowTodos`，复用 TodoWrite 与持久任务读取逻辑，
没有写入动作。个人待办不修改 TodoWrite、WorkTask、项目目标、执行权限
或独立 Reviewer 的审核结论。笔记和待办不会自动发送给模型或外部服务。

## DeepSeek 复用范围

继续复用已有 DSH manifest / patch 组合及安装快照机制。前端
`extensions/uiSlots.ts` 从固定版本 DSH `SlotCore` 适配声明式 list 子集：
宿主声明插槽、重复注册拒绝、稳定排序和幂等卸载。
SomniQ 自己提供声明式组件和本地状态桥。来源与 MIT 声明见
`third_party/deepseek-harness/NOTICE.md`。不声称兼容 DSH 完整 UI 渲染器、
Component Factories 或 `dsh.client` JavaScript 入口。

## 本次验证

### 2026-11-05 侧栏交互优化

适配固定版本 DeepSeek `TodoPanel` / `DisclosureRow` 的紧凑折叠标题和
按状态计数逻辑，行操作沿用 `SidebarRoot` 的悬停与键盘焦点显示模式。
颜色、图标、圆角和焦点环使用 SomniQ 主题，未引入 DeepSeek 前端依赖。

- 待办、笔记与执行计划可独立折叠；隐藏内容保留挂载，折叠不丢草稿。
- 待办显示完成数与进度条，已完成组默认收起，可展开取消勾选或删除。
  长列表限制自身高度，新增入口始终在列表下方。
- 笔记缩为三行起始高度，标题始终提示未保存状态；支持
  Ctrl / Command + Enter 保存，输入法组合阶段不提交。
- Agent 执行计划保持只读，统计全部进行中步骤，折叠后仍显示状态摘要。
- 顶部固定显示会话范围，包来源移到页脚，正文使用独立滚动区域。

本轮前端回归与视觉核验证据记录在
`output/plugin-ui-polish-20261105/verification.json`。
5 个相关前端测试文件共 82 项通过，TypeScript 检查与生产构建通过。
真实组件连接本地 Rust 接口，验证折叠保留草稿、快捷保存、刷新恢复、
已完成待办展开/取消完成、会话隔离和第二面板；深浅主题、中英、
320px / 420px 窄窗口无横向溢出，console error 为 0。
外围聊天与 Agent 计划为示例数据，未替换已安装的桌面版本。

### 初始功能验证

- 共享插件核心 16 项测试通过；完整 Rust 工作区串行回归为 1567 passed、
  6 ignored、0 failed，本次没有排除既有文件锁测试。
- 桌面项目绑定检查通过；真实 devserver API 验证预览、安装、启停、
  两个面板、Todo/笔记保存、陈旧 revision、会话隔离和只读计划写入拒绝。
- 5 个前端测试文件共 79 项通过，含真实 Chat 挂载/去重/卸载、首页草稿
  保护、项目/会话过期响应、笔记冲突草稿保留和既有 Extensions 回归。
- TypeScript 与生产构建通过，保留既有 bundle 大小和静态/动态 import 提示。
- 浏览器检查真实组件与真实 Rust API，覆盖深浅主题、中英、420px 窄窗口
  无横向溢出、保存后刷新恢复、切换会话和停用/重新启用，未见 console error。
  截图的外围聊天区为隔离示意壳，不是新打包的桌面应用窗口。

证据位于 `output/plugin-ui-20261105/verification.json` 及同目录日志、
`api-smoke.json`、`chat-plugin-preview.jpg`。未运行独立模型审查，未发布
安装包或替换用户正在运行的桌面版本。

## 声明式 v2：数据面板（2026-11-09）

第一层扩展。仍然是“包只声明、宿主来画”，不加载包内 JS/HTML/CSS；新增的是
Agent 能往面板里写数据，以及用户的点击能变成一条普通的 Chat 消息。

### schema

- `ui.json` 的 `schemaVersion` 现为 `2`，`1` 继续可读。`1` 的文档只能用
  原有四种组件和会话范围；用到新增内容时预览给出“needs schemaVersion 2”
  诊断并阻止启用，不会静默降级。
- 面板新增可选 `scope`：`session`（默认，每个会话一份）或 `project`
  （整个项目一份，所有会话读写同一份，新聊天首页也可用）。
- 新组件。数据组件的内容不写在包里，由 Agent 写入：

  | type | 额外字段 | Agent 写入的值 |
  | --- | --- | --- |
  | `table` | `columns: [{key, title}]`（1–12 列） | 行数组，键必须是已声明的列，单元格为字符串/数字/布尔/null，最多 500 行 |
  | `metrics` | – | `[{label, value, hint?, tone?}]`，`tone` 为 good/warn/bad，最多 24 |
  | `list` | – | `[{title, detail?, tag?, path?, url?}]`，`path` 为项目内相对路径，`url` 仅 http/https，最多 200 |
  | `markdown` | – | Markdown 字符串，最多 32000 字符 |
  | `progress` | – | `{value: 0..1, label?}` |
  | `chart` | `chart: bar \| line` | `{labels, series: [{name, values}]}`，最多 200 个标签 × 8 个序列，`null` 表示缺测 |
  | `form` | `fields: [{key, label, input, options?}]`、`submit: {label, action}` | 不存数据 |
  | `button` | `label`、`action` | 不存数据 |

  表单输入类型：`text`、`textarea`、`number`、`select`（必须带 `options`）、
  `checkbox`。
- 点击动作只有两种，都由宿主在用户点击时执行：
  - `{"type": "prompt", "text": "...", "send": false}`：把文字放进输入框，
    表单里的 `{{字段 key}}` 替换为用户填的值（勾选框为 是/否）；占位符必须是
    已声明字段。`send: true` 时，仅当输入框原本为空、没有附件且对话空闲才
    直接发送，否则只填入，由用户自己发送。
  - `{"type": "open-file", "path": "相对路径"}`：在侧栏打开项目内文件。

  没有“点击直接调用工具”的动作：按钮要“做事”，就是发一条让 Agent 去做的
  消息，于是权限模式、每回合冻结的插件集合、独立 Reviewer 全部照常生效。

### Agent 工具 `PluginPanel`

`list`（面板、范围、组件及每个可写组件的值形状）、`read`（当前值与
revision）、`write`（整体替换一个组件的值）。实现在
`desktop/src-tauri/src/plugins.rs`，校验与存储在 `runtime::plugins::ui`
（`check_data`、`PluginStore::ui_widget_set`）。

- 写入是数据，不是插件变更：不装、不启用、不运行任何东西，所以没有批准卡片，
  无人值守运行（待办任务、定时任务、综述工作流）也可以写，定时任务刷新项目
  看板正是用途之一。只读（Plan）模式拒绝 `write`。
- 每个值在写入前按组件形状校验，读出时再校验一次；包升级后收窄了组件
  （如删了一列），不再合法的旧值被丢弃而不是带病显示。
- Agent 写入是后写者胜并递增 revision。面板收到后端的
  `plugin-panel-changed` 事件后静默重载，所以用户随后的保存不会因 revision
  过期被拒；用户正在保存时到达的事件，等保存结束后再重载。
- `todo-list` 与 `notes` 也可由 Agent 整体写入。
- 路由：提到“插件面板 / 侧栏面板 / 看板 / 更新面板”等时固定带上该工具；
  单独的“面板”不触发（避免“面板数据”这类计量经济学用语误触发）。

### 存储

项目范围的面板存在空会话 id 下，scope 键为
`sha256(JSON(包名, 面板 id, "", "project"))`，与会话范围的文件互不相干。
上限沿用单文件 2 MiB。

### 不变量核对

1. 工作区内容不能让任何东西运行：面板数据只被渲染。Markdown 走 Chat 同一个
   渲染器；链接只接受 http/https 并交给系统浏览器；路径只接受项目内相对路径。
2. 批准只来自用户在本机主窗口的点击：`PluginPanel` 没有任何改变插件状态的
   动作，未知动作与多余字段一律拒绝。
3. 一个回合一份冻结的插件集合：写数据不改变集合；面板声明的变更仍走
   `PluginManager` 的预览、安装、批准。
4. 无人值守运行不能改插件：仍然如此，它们只能写数据。

### 图表

内联 SVG，无新依赖。单一 y 轴，柱状图从 0 起；序列颜色按固定顺序取 8 色，
深浅主题各一组，均用 dataviz 校验器对实际底色（浅 `#ffffff`、深 `#151a21`）
验过。浅色下有三色对比度低于 3:1，以图例、悬停读数和“查看数据”表格补足，
不靠颜色单独传达。

### 本期未做

- 点击直接调用 MCP 工具的 `tool` 动作（需要回合外的权限与审计设计）。
- 新位置：输入框上方停靠条、导航页、工具结果卡片。目前仍只有
  `chat.sidebar`。
- 面板局部更新（现在一次写入替换一个组件的全部值）。
- 第二层（HTTP MCP 等）与第三层（可执行 UI）未开始。

## 导航页位置 `nav.page`（2026-11-09）

Agent 自建的插件可以在左侧导航栏里有自己的图标，点开是一整页。仍是声明式：
页面由宿主用同一套组件来画，包不带代码，也不带图片。

### 声明

- 面板的 `slot` 新增取值 `nav.page`（`chat.sidebar` 不变）。
- 面板新增可选字段 `icon`，只能取契约 `ui.icons` 列出的宿主图标名
  （`runtime::plugins::ui::UI_ICONS`，24 个）。包不能带自己的图标文件：
  工作区里的字节不进应用外壳。未声明时按第一个组件的类型取图标。
- `nav.page` 的约束，预览阶段即报错并阻止启用：
  - 需要 `schemaVersion` 2；
  - 必须 `"scope": "project"`（页面不从某个会话打开，没有会话可归属）；
  - 不能包含 `agent-plan` 组件（它跟随单个会话）。

### 宿主行为

- 导航栏在模块按钮之后、“更多”之前，用一条分隔线接上插件页按钮。一个项目
  最多 3 个直接显示（`RAIL_PLUGIN_PAGES`），其余列在“更多”菜单的分隔线之后。
  顺序即面板的 `order`。
- 插件页不是新的模块（`Tab` 类型未变）：它显示在“插件”模块的位置，由
  `App` 里的 `pluginPageKey` 记住当前页。切到任何模块、切换项目、停用或
  卸载插件，页面随之消失，回到原模块的内容。
- 页面在主区域居中，最宽 1180px，组件按 360px 的列宽自动分栏
  （`PluginPage.tsx` / `PluginPage.css`），数据读写与侧栏面板完全相同
  （空会话 id 的项目范围数据，`plugin-panel-changed` 事件静默重载）。
- 页面上的按钮和表单不在页面里执行：`App` 先切到 Chat，再派发窗口事件
  `somniq:plugin-page-action`，由 Chat 复用侧栏面板的同一条路径
  （填入输入框 / 在侧栏打开项目内文件）。`send: true` 仍只在输入框为空、
  无附件、对话空闲时直接发送，并且只对属于该项目的本机会话生效。
- 只有显示导航栏的模块（对话、绘图、插件、设置）里能看到入口；远程/手机端
  没有本机后端，列表为空。

### 不变量

批准路径没有变化：页面只在用户于本机主窗口批准启用之后出现；模型没有任何
动作能让一个页面出现或保持出现。页面不运行包里的任何东西，所以“工作区内容
不能让任何东西运行”仍然成立。

### 未做

- 插件页没有自己的模块名（标题栏的模块切换器仍显示“插件”）。
- 输入框上方停靠条、工具结果卡片、对话内嵌卡片。
- 页面内的即时交互（筛选、排序、拖拽）属于第三层，未开始。

## 可执行页面（第三层 M1，2026-11-10）

`nav.page` 面板可以不再由宿主画组件，而是由包里的一个 HTML 文件自己画整页：
布局、配色、动画、拖拽、筛选都由页面自己决定。这是"界面任意"与"权限受限"
分开的一层：页面长什么样随意，页面能做的事只有读写本面板数据、请宿主把一段
提示词放进输入框、请宿主打开一个项目内文件。

### 声明（schema 3）

- `ui.json` 的 `schemaVersion` 现为 `3`，`1`、`2` 继续可读，各自只能用自己那一版
  的内容。
- 面板新增可选字段 `page`：包内相对路径，必须是 `.html`、UTF-8、不超过 1 MiB，
  只有 `nav.page` 面板可以声明。它必须是**单个自包含文件**：内联 `<style>` 与
  `<script>`，图片和字体用 `data:` URL。
- 新组件 `json`（字段 `id`、`type`、`title`）：任意 JSON 值，序列化后不超过
  256 KiB，只能出现在带 `page` 的面板里（宿主不会画它）。带 `page` 的面板可以
  一个组件都不声明。
- 带 `page` 的面板里，组件就是页面的数据仓：`json` 之外也可以声明 `todo-list`、
  `notes` 和各数据组件，读写规则与形状校验不变。Agent 仍用 `PluginPanel`
  读写，`list` 输出里带 `page` 字段。

### 运行结构

```
应用主文档  >  外壳框架（宿主生成，无脚本）  >  页面框架（包的 HTML）
```

两层框架都是 `sandbox="allow-scripts allow-forms"`，不带 `allow-same-origin`：
没有源、没有存储、读不到应用文档。实现在 `desktop/src/extensions/`：
`pluginPageDocument.ts`（生成文档）、`pluginPageBootstrap.js`（页面框架里最先
运行的引导脚本）、`PluginPageFrame.tsx`（宿主桥）。

- **页面的 CSP**：`default-src 'none'`，只放开内联脚本、内联样式和 `data:`/
  `blob:` 的图片、字体、媒体；`connect-src 'none'`、`form-action 'none'`、
  `base-uri 'none'`、`webrtc 'block'`。
- **为什么要套一层外壳**：CSP 不管框架把自己导航走（`location.href = "https://…?数据"`
  会把数据带在网址里发出去）。外壳只为携带 `frame-src 'none'` 而存在：页面的
  任何导航都成为被拦截的框架加载；沙箱也不允许它导航父框架或应用窗口。
  `allow-forms` 只为让表单能触发 `submit` 事件，提交本身被上面两条拦住。
- **Windows 上的 Tauri IPC**：wry 会把 `ipc`、`isTauri`、`__TAURI_INTERNALS__`
  注入每个子框架。做法与 Figures 编辑器相同：`ipc` 自定义协议被
  `connect-src 'none'` 拦截；postMessage 回退的唯一出口 `chrome.webview` 由引导
  脚本在页面代码之前移除，移除不掉就 `window.stop()` 并通知宿主卸载框架，页面
  代码不会运行。页面自己再创建的子框架不在这条保护之内，见下文"子框架环境
  里的传输"。
- **页面文件怎么到框架里**：`plugins_ui_page(projectPath, name, panelId)`
  （Tauri 与 devserver 共用，`PluginStore::ui_page`）在校验过摘要的已批准快照里
  读出这一个文件，作为文本交给前端放进 `srcdoc`。它从不在应用自己的文档里求值；
  包里的其他文件框架读不到。停用、未批准、快照被改动时读取失败。

### 宿主桥

引导脚本在页面里放一个冻结的 `window.somniq`：

| 调用 | 作用 |
| --- | --- |
| `await somniq.ready()` | `{ language, theme, data }`，`data` 为各组件 id 到当前值 |
| `await somniq.data()` | 重新读取 |
| `await somniq.set(widgetId, value)` | 整体替换一个已声明组件的值；后端按形状校验，不合规时以原因拒绝 |
| `somniq.onData(fn)` / `somniq.onTheme(fn)` | Agent 的 `PluginPanel` 写入、主题变化时回调 |
| `somniq.prompt(text)` | 把文字放进 Chat 输入框 |
| `somniq.openFile(path)` | 在侧栏打开项目内文件 |

主题以 `<html>` 上的 CSS 变量给出（`--somniq-bg`、`-surface`、`-raised`、
`-border`、`-text`、`-muted`、`-accent`、`--somniq-font`）并带 `data-theme`。
初始语言、主题和数据直接编进引导脚本，页面首帧就是正确的颜色和内容。

宿主侧的校验：

- 只接受来源窗口是"外壳里的那一个框架"、且带本次挂载随机通道的消息。
- 写入走既有的 `plugins_ui_state_update` + `widgetSet`，带页面上次看到的
  revision；Agent 抢先写入导致 revision 过期时，宿主重读后重试一次。写入串行。
- `prompt` **永不自动发送**，无论页面怎么传参：页面脚本可以在没有用户点击时
  调用它，自动发送等于让包代码替用户驱动 Agent。文字上限 4000 字符，路径上限
  1024 字符，其余丢弃。
- 宿主页头（面板标题 + "插件页面 · 包名"）始终在框架上方，由宿主绘制。

### 批准与升级

- 批准卡片在面板名后注明"自绘页面：运行插件自带的页面代码，在沙箱内，不能
  联网"（`capabilities.uiPanels[].page`）。
- 页面代码变了而声明没变时，能力差异是空的；因此只要新版本含自绘页面，升级
  卡片的 `executionUnchanged` 恒为 false。面板获得或失去 `page` 在差异里显示为
  `<id> (page)`。

### 不变量核对

1. 工作区内容不能让任何东西运行：页面只来自用户在本机批准过的快照，改草稿
   不改变已安装的页面；面板数据仍只是数据，页面应以 `textContent` 渲染。
2. 批准只来自用户在本机主窗口的点击：桥上没有任何改变插件状态的调用。
3. 点击不得绕过回合直接执行：页面不能调用工具、命令或 IPC，`prompt` 只填入
   输入框。
4. 项目数据默认留在本地：页面没有网络出口。

### 验证

- 隔离实测（Edge 无头，与 WebView2 同内核，`sandbox` 与 CSP 同上）：自导航、
  `location.assign`、meta refresh、点击链接、GET/POST 表单、`fetch`、图片、
  外链样式与脚本、prefetch/preload、`sendBeacon`、WebSocket、`window.open`、
  导航父框架、导航顶层窗口、嵌套框架共 19 种手法，页面脚本均已运行，服务器
  收到的请求数为 0；不加外壳的单层框架对照组的自导航请求确实发出。
- 同一环境用 CDP 发送真实输入：输入框打字加回车（表单提交事件）、按钮点击、
  拖拽均生效。

- 应用内实测（debug 版，Windows 11 / WebView2，独立配置目录）：
  - 导航栏图标进入页面，宿主页头在上、页面在下，颜色跟随应用主题。
  - CDP 真实输入添加三张卡片，经桥写入后端（revision 1→3）；主窗口带外写入后
    派发面板变更事件，页面即时显示；带外写入但不通知时，页面下一次保存命中
    过期 revision，宿主重读重试后成功；点击"规划下一步"切到 Chat、文字进入
    输入框、没有消息被发送。
  - 探针页（包内脚本自查）：`chrome.webview` 为 `undefined`；读应用文档与外壳
    文档、`localStorage` 均抛 `SecurityError`；`location.origin` 为 `null`；
    对 `http://ipc.localhost`、`ipc://`、开发源、`tauri.localhost`、
    `asset.localhost`（fetch 与图片）和本机测试服务器的请求全部被拦截；写未
    声明的组件被拒绝；自导航后测试服务器收到 0 个请求。`__TAURI_INTERNALS__`、
    `ipc`、`isTauri` 仍可见（wry 注入为不可配置属性），但 `ipc.postMessage` 与
    `invoke` 都发不出去。
  - 攻击探针：页面读不到自己创建的子框架的窗口（各为独立的无源环境）；
    `window.open` 返回 null；Worker 被拦截。

### 子框架环境里的传输（已知，依赖 Tauri）

页面可以创建子框架（空白或 `srcdoc`；CSP 的 `frame-src` 不管这两种），子框架是
全新的环境：引导脚本没有在那里运行，`chrome.webview` 仍在，继承来的 CSP 仍允许
内联脚本。实测子框架脚本能调用 `chrome.webview.postMessage`，它调用
`plugins_set_enabled` 没有产生任何效果，也没有网络外泄。

这一路不是本层切断的。拦住它的是 Tauri（2.11.2）`Webview::on_message`：
请求来源不是应用来源（这里是 `about:srcdoc`）时，自定义命令一律按 ACL 拒绝，除非
某个 capability 配置了 `remote` 来源；本应用的 capability 都没有。
`plugins::tests::no_capability_opens_commands_to_remote_origins` 钉住这一点。
应用自己拿不到一次调用的来源 URL（`InvokeMessage` 不暴露），所以无法在命令层再
加一道检查；升级 Tauri 时需要复核这段来源检查仍在。

### 未做 / 已知限制

- 只开放 `nav.page` 整页；侧栏、对话内嵌卡片未开放。
- 页面只能是单个文件，不能引用包内其他文件，也不能联网（按能力清单开放白名单
  属于后续）。
- 批准卡片不显示页面预览或代码差异（M2）。
- macOS / Linux 未实测：那里 wry 不向子框架注入初始化脚本，引导脚本另外隐藏了
  `window.webkit`，但 WKWebView 下的隔离与 `frame-src` 对自导航的拦截没有在
  真机上验证过。
- DNS 预取等不经 CSP 的低带宽侧信道未评估。

## 可执行页面：放开设计（第三层 M1.1，2026-11-10）

M1 之后的反馈是"还是三列"：三列只是示例模板的设计，但单文件、只能放导航页这两条
限制确实让页面难以做出差异。本轮放开：

- **多文件**：页面可以用相对路径引用包里的其他文件，宿主在页面加载前把它们放进
  去，框架里仍然没有任何请求：
  - `<link rel="stylesheet">` 内联为 `<style>`，其中的 `@import`（最多 8 层）展开、
    `url()` 换成 `data:` URL；`<style>` 元素和 `style` 属性里的 `url()` 同样处理；
  - `<script src>` 内联（`</script` 转义）；
  - `img`/`source`/`video`/`audio`/`track`/`input`/`embed` 的 `src`、`srcset`、
    `poster`，SVG `image`/`feImage` 与图标 `link` 的 `href` 换成 `data:` URL；
  - ES 模块用 `.mjs` 文件，彼此以 `pkg:<包内路径>` 导入：宿主生成一个导入映射，把
    每个 `.mjs` 映射为 `data:text/javascript` URL；`<script type="module" src>` 改写
    为 `import "pkg:<路径>"`。相对导入（`./x.mjs`）在 `data:` 模块里无法解析，不支持；
  - 脚本里用 `somniq.asset(path)`（`data:` URL）和 `somniq.text(path)`（文本）读图片、
    字体、JSON/CSV 等非代码文件，路径相对页面。
  - 指向包外（`../` 越界、绝对路径、任何带协议的网址）的引用原样保留，由 CSP 拦截。
  - 可用的扩展名见 `UI_PAGE_ASSET_TYPES`；这些文件合计不超过 12 MiB（预览诊断），
    单个页面 HTML 仍不超过 1 MiB。`plugins_ui_page` 现在返回 `path`、`assets`
    （包内路径 → `{mime, data(base64)}`），读取时整个快照重新校验摘要。
  - 页面 CSP 的 `script-src` 增加 `data:`，只为导入映射里的模块；仍然没有任何网络
    来源。
- **侧栏**：`page` 不再限于 `nav.page`，`chat.sidebar` 面板也可以自绘，`scope` 可以是
  `session`（按会话存数据，新聊天首页不挂载，同既有规则）或 `project`。侧栏里页面的
  `prompt` 同样只填入输入框。
- **示例**：`examples/plugins/page-gallery` 一个包三个页面，设计语言互不相同：
  纸质感的研究路线图（衬线字体、自有配色）、可平移拖拽连线的想法画布（三个文件）、
  实验驾驶舱（两个 `.mjs` 模块互相导入、`seed.json` 示例数据、`mark.svg` 图标）。
- **Skill**：`somniq-plugin-development` 改为"页面拥有整个区域，按用户要的去设计，
  不要默认卡片网格"，并说明多文件、库、模块和主题的两种做法（融入应用或自有配色，
  但须同时支持深浅色）。

## 摘要小组件与共用数据（第三层 M1.2）

- **新插槽 `chat.brief`**（schemaVersion 3）：位于 Chat 项目摘要卡片顶部，宽约 280–340 px。必须设置 `scope: "project"`。宿主组件只接受小尺寸的几种：text、metrics、progress、list、markdown、button、todo-list、json；也可以挂自绘 `page`。
  - 自绘页面用 `somniq.resize(px)` 申请高度，宿主把它限制在 40–320 px。
  - 用户可以折叠小组件，折叠状态按项目存在 localStorage `somniq-brief-glances-v1:<projectPath>`。
  - 有小组件时，摘要卡片本身也算可显示（`projectBriefAvailable`），不再依赖项目有 Git 仓库或目标。
- **`dataPanel`**：一个带 `page` 的面板可以指向同包、同 scope 的另一个面板。指向后它自己不声明 widgets，页面读写的就是对方的 widgets。
  - 校验规则：目标必须存在；不能指向自己；目标本身不能再带 `dataPanel`；scope 必须一致。
  - 前端由 `PluginPageFrame` 的 `store` 属性实现：页面文件从本面板读取，数据走目标面板。后端状态接口不需要额外解析。
- **多视图同步**：页面保存成功后，派发带 `origin`（即该框架的 channel）的 `somniq:plugin-panel-changed` 事件。其它视图（摘要小组件或完整页面）收到后重新读取，发出事件的框架自己忽略，避免覆盖还在排队的乐观更新。
- **新桥方法**：
  - `somniq.openPanel(id)`：只接受合法 id；只有它确实是导航栏里同包的页面时，App 才会打开（`PLUGIN_OPEN_PAGE_EVENT`）。
  - `somniq.resize(px)`：调整摘要小组件高度。
- **模板 `todo-workspace`**（`@local/project-tasks`）：
  - 完整页面提供列表、看板、日历、时间线四种视图，带详情抽屉（状态、优先级、日期、标签、步骤、备注、"让 AI 拆解"）。
  - 快速添加语法：`#标签 !高 @明天/@周五/@11-20`。
  - 摘要小组件内容：进度环、逾期和今天到期数量、接下来 4 条任务、勾选、快速添加。
  - 两个页面共用 `todo/model.mjs`，通过 `pkg:` 导入。
- **应用内实测**（隔离实例，2026-11-10）：
  - 模板安装零诊断。
  - 摘要小组件显示正常；"打开"按钮能跳到完整页面。
  - 真实输入的快速添加解析正确，写入 `due` = 明天、`priority` = high、`tags` = [paper]。
  - 四种视图和详情抽屉均正常。
  - 在小组件里勾掉任务后，完整页面同步显示为已完成。
  - 深色/浅色、中文/英文都检查过。
  - 截图在 `desktop/.audit/plugin-pages/20–26`。
- **实测中修掉的问题**：
  - 透明 iframe 被浏览器铺上不透明底色：小组件页面改为自己铺 `--somniq-surface`。
  - 图标未设尺寸被撑大。
  - 带 `hidden` 的提示条被 `display:flex` 覆盖，空着显示出来。
  - 时间线今日徽标与星期字母挤在一行；打开时没有滚到今天。
  - 时间线粘性标签列左侧的内边距缝隙露出滚过的内容。
- **仍未做**：
  - 第二期："改这个界面"按钮、本地副本、预览差异批准、版本回退。
  - 首页小组件、对话内卡片。
  - 小组件的排序只按 `order`，用户还不能拖动调整。

## 用对话修改插件（第三层 M2）

- **"改这个界面"按钮**（`PluginEditButton`）出现在三处：导航页面的页头、Chat 侧栏面板的页脚、摘要小组件的标题栏。
  - 点击后只在输入框里起草一段请求，不会发送。请求里写明插件、面板 id、所在位置，以及 checkout → 修改 → 提版本 → 预览 → upgrade 的步骤，结尾留"我想要："给用户补充。
  - 导航页面内部的宿主绘制面板，其页脚按钮用 CSS 隐藏，避免和页头的按钮重复。
- **`PluginManager checkout`**（写操作；Plan 模式和无人值守运行中不可用）：
  - 把当前安装的快照逐字节写进 `.somniq/plugin-drafts/<去掉 scope 的包名>`，写入前先校验快照的 digest。
  - 返回状态有三种：
    - `checked-out`：已写入。
    - `unchanged`：草稿已经和安装版完全一致。
    - `exists`：草稿里有别的修改，这次什么都没写。
  - 传 `replace: true` 时，先把旧草稿改名为 `<名>-previous-N` 再写入，从不删除。
- **版本历史**：
  - 记录：`Record.history` 记录每次被替换的版本（版本号、digest、来源、替换时间），新的在前，最多 20 条，超出上限时保留原版。`Record.original` 在安装时记下原版的 digest。在此之前装的包，若从未升级过，第一次升级时把被替换的版本当作原版。
  - 存储：快照按内容寻址，本来就不会被清理，所以历史只是一份索引。旧版本读取时会忽略这些新字段，`Registry` 的 `deny_unknown_fields` 只作用在顶层。
  - 回退：`rollback` 与 `upgrade` 共用同一个事务 `replace_with`。只能回到历史里的 digest，并且要校验快照完整、当前 digest 与用户看到的一致。回退来源按历史记录保留，被替换的版本进入历史。
  - 入口：回退只在插件页上提供，Agent 工具不能回退。用户点击"确认回退"即视为批准；插件原本在运行时，回退后继续运行。
- **升级审批卡片**：
  - 卡片 JSON 新增 `files`（改动的路径、类型、大小）和 `pagePanels`（新版本中自绘页面的面板）。
  - 用户在卡片上可以：
    - 试用每个新页面：`plugins_draft_page` 从草稿读取并校验卡片上的 digest；数据从项目真实数据起步，读不到时为空；写入只保存在内存，提示词、打开文件、打开页面等动作一律不执行，也不广播变更。
    - 逐行查看改动：`plugins_draft_changes` 返回两侧文本；二进制文件或超过 256 KiB 的文件只显示大小。前端用 `externalTextDiff`，先统一换行符。
  - 草稿在卡片显示之后被改动，两个命令都会拒绝。
- **应用内实测**（隔离实例，2026-11-10）：
  - 摘要小组件和任务页的按钮都把请求正确填进了输入框，且没有发送。
  - 用临时测试页挂载真实的 `PluginUpgradeReview`，调用真实后端：草稿页面以紫色卡片样式显示真实任务；在预览里勾掉任务后，磁盘上的 revision 仍为 1；文件差异逐行显示正确。
  - 批准升级后任务页变成新样式，数据不变；在插件页回退到 v0.1.0 后插件仍然运行，v0.2.0 进入历史。
  - 截图在 `desktop/.audit/plugin-pages/30–35`。
- **实测中修掉的问题**：
  - 两个面板同名时，试用按钮无法区分：按钮上加了位置。
  - CRLF 换行导致 `\r` 混进差异文本。
  - "原版"标签原先按列表位置推断，回退到原版之后会标错：改为记录原版的 digest。
  - 回退确认框原先用了删除样式的红色。
- **限制**：
  - 审批卡片只在 Agent 真正调用 upgrade 时出现。隔离实例无法运行模型，所以卡片上的部分是用测试页验证的，没有经过完整的对话回合。
  - 版本历史不显示两个历史版本之间的文件差异。
