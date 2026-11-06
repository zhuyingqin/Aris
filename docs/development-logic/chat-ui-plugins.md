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
