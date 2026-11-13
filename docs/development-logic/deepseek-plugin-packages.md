# DeepSeek bundle 接入：首阶段实现

SomniQ 的“插件”页新增按项目管理的插件包。用户可以先预览来源、版本、
Skills/MCP、文件摘要和兼容诊断，再安装、启停、移除。安装默认停用。
这一阶段接通了共享运行时，并提供原生 SomniQ 界面；自动工作台控制器、
DeepSeek ACP 执行器及任意 Cordis 插件的运行仍属于后续里程碑。

第二阶段（本文“生命周期、升级与冻结”三节）借鉴 DeepSeek Harness
`packages/boot/plugin-manager` 的思路（只借思路，不引入代码），把“已安装”
“已批准并启用”“正在运行”“失败”“需要重新开始”分开；同名新版本改为带差异、
需重新批准、失败回滚的升级事务；每次运行开始时冻结插件集并写入审计记录。

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
竞争进程收到可重试的忙错误。进程内路径锁按路径哈希分成 97 条，注册表与
`approvals.json` 两把锁在 `mutate` 开头一次性按序取得（`with_paths_locked`）。
原实现在持有注册表锁时再取批准文件锁，两条路径落在同一条锁上时会自锁；
`plugin_mutations_do_not_deadlock_when_their_lock_stripes_collide` 专门找出
这样的项目路径做回归。单包文件数、体积、目录深度受限，
包文件和状态目录拒绝符号链接/Windows junction。摘要包含包内路径、字节
及 Unix 可执行位。运行时重新校验快照；损坏包显示 blocked 且不提供能力。

损坏包可停用、移除并重装；重装保存损坏内容后恢复已预览的快照。移除只
脱离注册表，保留缓存，使正在运行的会话仍有有效资源路径。尚无缓存清理；
切换版本走下文的升级事务，不必先移除。

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
MCP 仍走现有进程管理与 full-access 权限要求。`enabled` 只表示“下一次运行
会拿到它”，真实状态见下一节。独立 Reviewer、Executor→Reviewer→revision
和工作任务状态机未修改，只是整个运行共用开始时冻结的插件集。

## 生命周期状态

`InstalledPlugin.status`（enabled/disabled/blocked）保持原义，只描述配置和
完整性。新增 `lifecycle`（`crates/runtime/src/plugins/lifecycle.rs`）描述
实际情况，`state` 取以下之一：

| state | 含义 |
| --- | --- |
| `installed` | 在列表里，本机没有批准，哪里都不运行 |
| `approval-required` | 项目文件要求运行，但本机没批准这个摘要，仍不运行 |
| `blocked` | 诊断或快照损坏阻止运行，与配置无关 |
| `enabled` | 已批准并启用，下一次运行会拿到；此刻没有运行在用 |
| `running` | 有正在进行的运行冻结了与当前启用版本完全相同的摘要 |
| `failed` | 已启用，但它某个 MCP 服务最近一次真实发现失败 |
| `needs-restart` | 有正在进行的运行使用的集合与下一次不同：旧版本、已停用的包，或在它开始之后才启用的包 |

判定顺序：不能启用 → `blocked`；未启用时，仍被在途运行使用 → `needs-restart`，
否则看 `approval-required` 诊断；已启用时依次为 MCP 失败 → `failed`、
有过期运行 → `needs-restart`、有在用运行 → `running`、否则 `enabled`。
另给出 `activeRuns`（冻结了这个包任一版本的在途运行数）、`staleRuns`
（与下一次运行不一致的在途运行数）和逐个 MCP 服务的健康。只统计同一项目
的运行。

**MCP 健康来自真实发现，不是推断。** 所有发现都经过
`runtime::McpServerManager::discover_tools_resilient*`：Chat 每回合挂载工具
（`aris_chat::attach_mcp_tools_with_cancel`，带 5 分钟缓存）、Extensions 页的
MCP 测试（Desktop `mcp.rs`）、插件卡片上的“检查连接”
（`plugins_check_mcp`，复用同一管理器后清掉 Chat 的发现缓存，免得旧失败
继续生效）。管理器把每个服务的结果记进 `runtime::mcp_health`，键为运行时
服务名加 `scoped_mcp_config_hash`。命令行里带快照路径，所以升级后的新版本
从“尚未连接”开始，不会继承旧版本的健康。健康只在本进程内保存，最多 512 条；
重启后都回到“尚未连接”，直到下一次对话或检查。缓存命中的回合不重新发现，
沿用上次记录。工具调用中途崩溃目前不更新健康，下一次发现才会反映。

## 升级事务

预览同名已安装包时，`plugins_preview` 返回 `PluginImportPreview`，其
`upgrade` 字段给出 `PluginUpgradePlan`：已安装版本与摘要、它此刻是否已批准
并启用、版本方向（upgrade/downgrade/same-version/identical）和
`CapabilityDiff`。差异对比的是已安装（若已启用则是本机已批准）的版本，包括
Skills、Chat 面板、每个 MCP 服务的增删改、全部命令行的增删、环境变量键的
增删以及值发生变化的键。命令行里的快照目录写回 `./`，换快照位置本身不算
变化；环境变量只显示键，不显示值。直接 `install` 同名包会被拒绝，并提示
重新预览以升级。

`PluginStore::upgrade(source, expected_digest, expected_current_digest, approve)`
在注册表锁内完成：

1. 摘要须与预览一致，已安装摘要须仍是差异所对比的那个，否则拒绝并要求重新预览。
2. `approve` 时新版本必须能启用，且与其他已启用包没有 Skill 冲突。
3. 先读出当前批准；批准文件损坏会在任何改动前停止。
4. 新快照发布到旧快照旁边。快照按摘要寻址，从不原地修改，旧版本和冻结了
   旧版本的运行都不受影响。
5. 切换：先改批准（`approve` 时换成新摘要，否则撤回），再原子写注册表。
   注册表写失败时把批准恢复成原值；恢复也失败时报告两者，包停着而不是
   以未批准的字节运行。

所以在新版本就位之前，旧版本和它的批准一直有效；任何一步失败都回到旧版本。
新运行在注册表锁下冻结插件集，看不到改了一半的状态。界面上，旧版本已启用
时主按钮是“升级并重新批准”（差异里列出新版本将运行的命令）；旧版本停用时
是“升级并保持停用”；旧版本启用但新版本不能启用时是“升级并停用”；完全相同
的快照不提供操作。测试通过线程局部故障注入点（`published`、`approved`），
在每一步失败后核对注册表字节、批准摘要和实际可用的 Skill 根都还是旧版本。

## 运行时冻结插件集

`PluginRun::begin(store, label)` 在运行开始时调用 `PluginStore::freeze`，
得到 `PluginSet`：项目规范路径、按名排序的 (name, version, digest)、
`fingerprint`（排序后 `name@digest` 的 SHA-256）、冻结时间；注册表读不出来
时为空集并附 `error`（运行不用任何插件，与之前注册表损坏时一致）。
`PluginRun` 在进程内登记一个随机令牌，`bind` 把令牌写进执行上下文的
`ARIS_PLUGIN_RUN`。在这样的上下文里，`PluginStore::for_execution` 只从冻结集
解析：`ConfigLoader` 的 MCP、提示词里的 Skill 列表、`crates/tools` 的 Skill
解析、只读根，全部一致。冻结集仍重新校验快照完整性，被篡改的包照样不提供
能力。`PluginRun` 析构时注销；令牌未登记（运行已结束，或不是本进程发出的）
或属于其他项目时解析为空集，绝不回落到实时配置。在冻结运行内再
`begin` 会沿用外层集合。

- **Chat 回合**：`engine.rs` 在派发 worker 前冻结（工作任务回合沿用任务的
  集合），用 `state::project_run_execution_context` 建上下文，只读根取冻结
  集的快照目录。worker 持有 `Arc<PluginRun>` 直到回合完全结束。集合非空或带
  错误时写入会话事件日志一条 `plugin_set`，由 `TurnTag` 盖上回合 id；不用
  插件的回合不写，避免每回合涨一条。
- **WorkTask**：`work_task::engine::run` 每次运行冻结一次，执行回合、每轮
  revision 都通过 `WorkTaskTurnBinding.plugin_run` 共用；独立 Reviewer 目前
  是不带工具的模型调用，仍在 `PluginRun::enter` 内执行，以后若读取插件也只
  看到冻结集。集合写入任务记录 `pluginSet`（带 `runSeq`），即该次运行的
  审计记录。合并修复的多轮也共用一次冻结。
- 运行内部为某项工作重建的上下文继承该运行。`DesktopToolExecutor` 每次
  工具调用都会用 `with_bound_project_environment` 重新绑定项目；
  `state::project_execution_context` 通过 `runtime::plugins::current_plugin_run()`
  取得当前令牌和冻结快照目录，所以 Skill 工具解析和只读根仍是冻结集。
  新增重建上下文的路径时必须经由这两者之一，否则运行中的调用会回落到实时
  配置。令牌还在、运行已结束时也照样继承，解析为空集。
- `apply_project_environment`（应用到进程的活动项目环境）显式清掉
  `ARIS_PLUGIN_RUN`，进程环境里永远没有运行令牌。

信任模型不变：冻结只能收窄到冻结时已批准、已启用、完整的包；令牌只在本
进程内有效；批准和快照仍只在 `ARIS_CONFIG_ROOT/plugins`；插件仍不能遮盖
内置 Skill（冻结集解析也重做 `skill-builtin` 检查）；工作任务仍经
`PluginStore::for_execution` 解析插件。Chat 面板属于界面，不随运行冻结，
启用后立即出现。

## 界面与 API

`PluginPackages.tsx` 嵌入现有 Extensions 页，使用现有 `.ext-*` 按钮、
卡片、字体、颜色、深浅主题与全局字号缩放。局部 CSS 处理长路径、键盘
焦点和窄屏。支持中文、英文，错误就地显示；版本、来源和摘要可展开。

Tauri 命令及 devserver 路由共用 `PluginStore`：`plugins_list`、
`plugins_preview`（含升级计划）、`plugins_install`、`plugins_upgrade`、
`plugins_set_enabled`、`plugins_check_mcp`、`plugins_remove`。卡片显示生命周期
状态及说明（例如“2 个正在运行的回合或任务在使用这个版本”“已停用，但 1 个
正在运行的回合或任务会继续使用它”），已启用包列出每个 MCP 服务的最近一次
连接结果并可“检查连接”；检查只占用本卡片，不锁整个页面。
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

第二阶段（生命周期、升级、冻结，2026-11-06）：

- runtime 新增 7 项插件测试和 1 项 `mcp_health` 测试，`plugins::` 共 27 项通过：
  逐一走过 installed → approval-required → enabled → running → failed → 恢复 →
  needs-restart（运行中停用）→ 运行结束回到 installed、needs-restart（运行开始后
  才启用）、他项目运行不计入、blocked；真实 `McpServerManager` 发现一个起不来的
  命令后卡片变 failed；升级差异（Skill、命令行、环境变量键、版本方向、identical）、
  须重新批准、不批准则停用；`published` / `approved` 两个故障点在批准与不批准两种
  路径下各失败一次，外加 Skill 冲突、批准文件损坏、预览后改包，每次都核对注册表
  字节、批准摘要和实际 Skill 根仍是旧版本；冻结集在中途停用、启用另一包、升级、
  移除后仍解析出原来的 Skill、MCP 和只读根，运行内重建的上下文继承运行，运行
  结束或伪造的令牌解析为空；冻结集仍拒绝被篡改的快照；锁条带碰撞不再自锁。
- Desktop 新增 2 项：插件页中途停用后，运行上下文（含工具调用重建的上下文）仍
  解析出冻结的 Skill 且快照可读，下一次运行和进程环境拿到新配置、不带令牌；
  任务记录 `pluginSet` 序列化带 `runSeq`，旧记录照常读取。
- `cargo test --workspace --no-fail-fast` 全部通过（runtime 932、tools 334 等
  11 个测试二进制，0 失败；先前偶发的
  `batch_write_preserves_external_saves_during_a_locked_publication_and_rollback`
  本次也通过）。Desktop `cargo test --lib` 1000 通过、0 失败、15 忽略。
- `src/extensions` 的 Vitest 41 项通过（插件页 11 项，新增 4 项：状态与 MCP 健康、
  检查连接只占本卡片、升级差异与重新批准、停用包升级与失败保留预览、identical
  与“升级并停用”）。`tsc --noEmit` 与 `npm run build` 通过，构建只有既有的
  chunk 大小提示。
- 未做：应用内或浏览器里的界面实测与截图、独立模型审查。

## 后续衔接

自动工作台应以 SomniQ 现有 WorkTask 状态机和独立 Reviewer 为核心，
增加持久 GoalRunner 的预算、证据、等待输入和恢复控制，再将其投影到
原生工作台。需要 DSH 宿主能力的包优先通过官方 ACP 接入外部执行器，
并将 ACP 权限请求纳入现有权限链。不要把 ACP 命令当成 MCP server，
也不要用 DSH 自评循环替代独立 Reviewer。
