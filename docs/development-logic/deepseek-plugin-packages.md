# DeepSeek bundle 接入：首阶段实现

SomniQ 的“插件”页新增按项目管理的插件包。用户可以先预览来源、版本、
Skills/MCP、文件摘要和兼容诊断，再安装、启停、移除。安装默认停用。
这一阶段接通了共享运行时，并提供原生 SomniQ 界面；自动工作台控制器、
DeepSeek ACP 执行器及任意 Cordis 插件的运行仍属于后续里程碑。

后续已新增 SomniQ 声明式 Chat 侧栏扩展：包可通过 `somniq.ui` 声明
Todo、笔记、文本和只读 Agent 计划，独立使用或与 DSH Skills/MCP 合包。
这是 SomniQ 原生扩展格式，不兼容 `dsh.client` 任意 JavaScript 入口。
使用方法与接口见 [Chat UI 插件](chat-ui-plugins.md)。

## 上游复用

固定 DeepSeek Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
（0.2.2-rc.1）。`crates/runtime/src/plugins/dsh.rs` 将上游
`vendor/include/src/patch.ts::applyPatches` 的组合算法移植为 Rust，沿用：

- `package.json` 的 `dsh.manifestVersion` / `dsh.bundle.patch` 契约。
- 单个或有序多个 patch 文件，顶层与组内 `insert`，按 id 定位的覆盖。
- 可选 name 限定，以及整个字段替换的语义；config 不进行递归合并。
- `@deepseek-ai/dsh-skill-filesystem` 和 `@deepseek-ai/dsh-mcp-client`
  的静态配置命名。

这是静态配置适配层，不是 Cordis 宿主。来源和 MIT 许可见
`third_party/deepseek-harness/NOTICE.md`；两份完整许可证随桌面 resources
分发。未引入上游前端、Node 宿主、npm 生命周期脚本或模型执行循环。

## 接受的 bundle

一个本地目录包含 npm 风格 name、精确 SemVer version，以及
`dsh.bundle.patch` 指向的包内 YAML 文件。示例可直接导入：
`examples/plugins/research-continuity`，提供 `research-checkpoint` Skill。

Skills 支持包内 `<root>/<name>/SKILL.md` 目录束及其 references/scripts/assets。
配置须明确 `includeDefaultRoots: false` 并使用包内相对 `customSkillDirs`；
SomniQ 自行保留用户、项目和已有兼容根目录。Skill frontmatter 的 name
必须与目录一致，DSH 调用控制标记尚未适配时阻止启用。

MCP 支持 `transport: stdio`、`serverName`、`command`、`args`、`env`
和 `toolCallTimeoutMs`。以 `./` 开头的 command/参数解析到安装快照中，
每个包拥有稳定的 MCP 名称前缀。其他裸参数沿用原义，进程 cwd 使用
SomniQ 执行上下文。显式 cwd、credential 模板、重连/连接生命周期字段和
HTTP transport 均须后续适配，不能静默丢弃配置。

不支持的宿主插件、客户端扩展、inject/isolate/intercept、动态 YAML 标签、
缺失 patch 目标、平台不匹配和组结构覆盖均产生可见诊断，阻止整包启用。
不执行 YAML 表达式；标准 tag 拼写也采取保守拒绝。包可以安装为停用状态，
便于查看诊断。不从市场下载依赖或运行 package.json scripts。

## 持久化与执行边界

`PluginStore` 位于 `crates/runtime/src/plugins/`，Desktop 与 CLI 共用：

```
<project>/.somniq/plugins/      # 工作区内容：只列出包、提出启用请求
  registry.json                 # schema 1；来源、版本、摘要、请求启用
  registry.lock                 # OS advisory lock，崩溃后自动释放
  ui-state/                     # 声明式面板的会话数据
<SomniQ 配置>/plugins/          # ARIS_CONFIG_ROOT，默认 ~/.config/SomniQ
  approvals.json                # 本机批准：项目规范路径 → 包名 → 摘要
  approvals.lock
  packages/<sha256>/            # 安装时冻结的包内文件，按摘要跨项目共享
  quarantine/modified-*/package # 重装时隔离保存损坏的旧快照
```

**信任锚不在工作区里。** 工作区里的任何文件，都可能被模型的文件工具写入，
也可能随克隆的仓库一起到来。所以 `registry.json` 的 `enabled` 只表示项目
提出了请求。包要真正运行（MCP 进程、Skill 根、Chat 面板），必须同时满足
两个条件：项目请求启用，本机 `approvals.json` 为该项目记录的摘要也等于
将要运行的快照摘要。只在 Desktop 的插件页里由用户打开开关，才会写入批准；
带 MCP 的包在写入前会先列出将要运行的命令和环境变量名。停用和移除会先撤回
批准，再改注册表，所以中途失败时包只会停着，不会在没有请求的情况下运行。
只有请求、没有批准的包显示为停用，并给出 `approval-required` 提示；快照
不在本机的包显示为 blocked。被执行的字节也不在工作区里，所以文件工具改不到
（文件工具只能写工作区）。已启用包的快照目录会加入该项目回合的只读根，
插件 Skill 的 `references/` 因此仍然可读。

预览和安装之间摘要不一致会拒绝安装。新包先完整写入临时目录，再发布快照，
最后原子更新注册表。注册表写操作同时持有进程内路径锁与 OS 文件锁；
竞争进程收到可重试的忙错误。单包文件数、体积、目录深度受限，
包文件和状态目录拒绝符号链接/Windows junction。摘要包含包内路径、字节
及 Unix 可执行位。运行时重新校验快照；损坏包显示 blocked 且不提供能力。

损坏包可停用、移除并重装；重装保存损坏内容后恢复已预览的快照。移除只
脱离注册表，保留缓存，使正在运行的会话仍有有效资源路径。尚无缓存清理
或版本升级事务；切换版本采用移除后重新导入。

插件 Skill 排在所有来源之后：显式用户 Skills、显式项目 Skills、既有兼容根、
随应用分发的 Skills、编译进程序的内置 Skills，最后才是插件包
（`crates/tools` 的解析与列举，以及系统提示词里的 "Plugin" 分组都按这个
顺序）。插件只能新增 Skill，不能替换任何已有 Skill。与内置 Skill 同名（不分
大小写）会产生 `skill-builtin` 诊断，并阻止整包启用。这项检查在每次读取时都会
重做，所以应用更新后新增的同名内置 Skill，也会让旧包停下来，不会被它遮住。解析时
插件根目录也不会被拿来查找内置名字。启用包之间的 Skill 同名冲突会被拒绝，
已激活别名的保留名也会被拒绝。

插件归属于登记的项目，不跟着回合实际运行的目录走。工作任务（以及走同一内核的
定时任务）在自己的 worktree 里运行；Desktop 的执行上下文会设置
`ARIS_PLUGIN_PROJECT_ROOT`，指向登记的项目根。`ConfigLoader`、Skill
解析和提示词列举都通过 `PluginStore::for_execution` 读取它，因此看到的批准
插件集与 Chat 完全一致。

`ConfigLoader` 仅向 MCP 集合添加已启用的包，不把包配置合并进权限、
sandbox、hooks 或 model。已有手工 MCP 声明保持优先。未修改全局 mcp.json。
MCP 仍走现有进程管理与 full-access 权限要求。启用状态表示已配置，
连接健康情况仍由现有 MCP 工具检查报告。正在运行的 turn 不被强制改写。
独立 Reviewer、Executor→Reviewer→revision 和工作任务状态机未修改。

## 界面与 API

`PluginPackages.tsx` 嵌入现有 Extensions 页，使用现有 `.ext-*` 按钮、
卡片、字体、颜色、深浅主题与全局字号缩放。局部 CSS 处理长路径、键盘
焦点和窄屏。支持中文、英文，错误就地显示；版本、来源和摘要可展开。

Tauri 命令及 devserver 路由共用 `PluginStore`：`plugins_list`、
`plugins_preview`、`plugins_install`、`plugins_set_enabled`、`plugins_remove`。
命令显式接收 projectPath，校验当前项目后固定工作目录，并在 blocking pool
处理磁盘工作。前端丢弃切换项目后的旧响应。磁盘注册表错误可在页面重载
查看，正常聊天不因插件故障而中断。

## 验证

- 插件核心 10 项测试通过，覆盖有序补丁、配置替换、动态标签拒绝、资源快照、实际 MCP
  配置加载、变化后拒装、重复/冲突、篡改阻止激活及重装恢复、注册表身份、
  Windows junction、跨句柄锁和仓库示例导入。
- tools 测试经真实 `discover_skills` / `skill_markdown` 验证启停、装载和
  显式项目覆盖优先级；Desktop 测试验证过期项目绑定拒绝。
- 插件界面及既有 Extensions 的 19 项 Vitest 通过，TypeScript 检查与
  `npm run build` 通过。构建保留现有 chunk 大小/静态动态 import 提示。
- Rust 完整工作区采用 `cargo test --workspace -- --test-threads=1`。
  初始沙箱拒绝 notebook 子进程；获准正常执行后，默认并行运行触发既有
  Windows 文件锁时序测试失败。最终串行整仓复测也触发同一项失败：
  runtime 为 914 passed / 1 failed；该项单独复测通过。因此不能将完整
  回归称为全绿。另用显式 `--skip
  batch_write_preserves_external_saves_during_a_locked_publication_and_rollback`
  跑完其余工作区测试，单列结果，不修改该项原有测试或文件操作实现。
  排除该项的最终整仓回归通过，Desktop 插件 API 复测通过。
- 使用隔离测试项目和真实 Rust API，从浏览器完成预览、安装、停用、启用、
  移除、刷新持久化核验。检查深浅主题、420px 窄屏无横向溢出，页面无
  console error。截图来自隔离挂载的真实组件，而非发布版应用窗口。

详细测试日志、API 响应与截图保存在本地
`.somniq/research/deepseek-harness-2026-11-04/`。未运行独立模型审查，
未发布安装包或更新用户正在运行的桌面进程。

## 后续衔接

自动工作台应以 SomniQ 现有 WorkTask 状态机和独立 Reviewer 为核心，
增加持久 GoalRunner 的预算、证据、等待输入和恢复控制，再将其投影到
原生工作台。需要 DSH 宿主能力的包优先通过官方 ACP 接入外部执行器，
并将 ACP 权限请求纳入现有权限链。不要把 ACP 命令当成 MCP server，
也不要用 DSH 自评循环替代独立 Reviewer。
