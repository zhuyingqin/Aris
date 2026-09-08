# 系统冗余 / 合并 / 解耦 整改计划

> 首次调查：2026-07-19（0.4.23 脏工作树，作为历史快照保留）。
> 二次复核：2026-07-19（当前 0.4.24，仍含未提交改动）。
> 首次审计基线：`27ae92abe45f5bad32dd06a685778b3ba2ac6e63` 的脏工作树。
> 二次复核基线：`b2a52b31f3c5c088f687e02397501741aad47f88` 的脏工作树；旧 SHA 仅表示历史快照，
> 不能替代每个 PR 开始前的重新取证。
> 方法：全仓行数统计 + 逐热点交叉验证（函数面、调用方、事件面、schema、skills）。
> 结论先行：**分层架构本身是健康的**（runtime 持久化 / tools 适配器 / chat 共享内核 /
> desktop 薄命令，literature 迁移文档所立的原则基本被遵守）。问题集中在三类：
> ① 少量未接入入口与误生成物；② 需要窄范围收敛的跨表面契约/机制（Gateway HTTP DTO、
> SSE `data:` 负载、SQLite 连接配置、少量命令语义）；③ 需要安全拆分的巨石文件（当前规模见第 0 节）。
> Chat 事件订阅的公共抽取证据不足，已明确暂缓，不再计入确定的重复项。

### 执行范围与审计边界

- 本轮只覆盖 runtime、tools、chat、desktop、remote、CLI 与 CSS；**skills 仅保留为观察项，
  未经后续明确授权，不合并、不 stub、也不改 registry**。
- 这是一份脏工作树快照，行号只用于定位线索。每个 PR 开始前必须记录当前 `HEAD`、目标文件的
  已审阅差异、命令注册表与调用方清单，并在隔离后的工作树重新验证；不得把既有未提交改动混入
  本计划的 PR。
- A2 的清理目标只包括已确认的根部 `nul`；当前无关的未跟踪 `nested/demo.txt` 必须原样保留，
  任何基线清理都不得扩大目标。
- “grep 清零”只能作为辅助证据，不能单独证明删除安全或跨表面行为等价。

### 全局非回归不变量

- **独立 Reviewer**：C1/C2/B3/A1 均不得把 `/reviewer`、`LlmReview`、verification gate 或
  GO/NO-GO verdict 写回并入 Executor 自证路径。Reviewer 的模型/配置/凭证路由、取消、可见性与
  verdict 写回保持独立，并以 mock Executor/Reviewer 集成场景验证两套配置隔离。
- **本地优先与上下文连续性**：命令和存储重构必须兼容现有 session、project goal、tasks/plan、
  project-root 作用域与审批状态；不得因“统一”新增隐式网络调用或外部动作。
- **远程授权与秘密边界**：协议签名有效不等于已获授权。remote 改动必须继续要求本地用户批准、
  `DeviceScope` 授权与显式 gateway opt-in，未配对/未授权/scope escalation/replay 一律 fail closed；
  secret、credential 与 keyring 内容不得进入日志、配置、错误文本或 checked-in fixture。

## 0. 体量快照（二次复核时统计；实施前必须复查）

| 文件 | 行数 | 性质 |
| --- | --- | --- |
| desktop/src/styles.css | 14 800 | 巨石 + 覆盖沉积 |
| desktop/src-tauri/src/engine.rs | 8 505 | 巨石（函数/命令清单实施前复查）|
| crates/tools/src/lib.rs | 7 124 | 巨石（~40 工具分发 + 多域内联实现）|
| desktop/src/typeset/Typeset.tsx / .css | 7 159 / 6 416 | 巨石（重写进行中，暂缓）|
| crates/aris-cli/src/main.rs | 5 370 | 巨石 |
| desktop/src-tauri/src/remote.rs | 4 892 | 巨石 + wire 类型重复 |
| site/server/src/lib.rs | 4 737 | 巨石 + wire 类型重复 |
| desktop/src/literature/Literature.css 等模块 CSS | 4 370 / 3 509 / 2 988 … | 与 styles.css 组织不一致 |

---

## A. 冗余（删除 / 去重）

### A1. 未接入的 rich-send 入口（先做产品决策与注册表盘点）
- 证据：
  - 后端 `engine.rs:3612` / `engine.rs:3628` 两个命令都只是转发到
    `run_literature_chat_turn`（engine.rs:3979，本身只被这两处调用）。
  - 前端包装 `literatureAgentSend` / `studioAgentSend`（api/tauri.ts:1148/1152）
    **无任何生产调用方**；`literatureAgentSend` 仅剩 Literature.test.tsx 里的 mock。
  - Literature 页现在通过旁听 Chat 会话事件工作（literatureStore.ts:1491 起的
    `onChatTool/onChatToolResult/onChatDone`），不再自己发起 agent 轮次。
  - Studio 当前的 revise 流程也没有使用 `studioAgentSend`：`studioStore.ts` 通过
    `mainStore.setPendingChatRunInput(revisionPrompt(...))` 把页级反馈路由到主 Chat。
- 边界澄清：`chat_send_rich` 直接使用 `run_chat_turn`；上述**两个** agent 命令共享
  `run_literature_chat_turn`，三者只在更低层的 `run_chat_turn_with_context` 汇合。不能把它们
  当作共享同一即时 turn loop 的三个重复命令。
- 前置门槛：在改动前列出所有受支持产品表面的 Tauri 注册、静态/动态 invoke、测试 mock、权限声明
  与事件消费者，并由负责人确认清单完整；同时由产品负责人明确是否要改变 Studio 当前走主 Chat 的行为。
- 动作（二选一）：
  1. **显式恢复独立 Studio lane**：仅在产品明确要求受限工具通道时，将 `studioAgentSend` 接入
     `studioStore`，并单独决定 Literature 侧是否退役。由于现有实现走主 Chat，这属于新增/恢复架构，
     不是保持现状，风险为中等。
  2. **保留当前 Chat 路由并退役两个遗留入口**：在注册表/动态调用方清单经负责人确认后，删除两个
     命令、前端包装、注册与相应 mock；只有在 `run_literature_chat_turn` 和
     `LITERATURE_AGENT_EXTRA_BLOCKED_TOOLS` 确认无其他消费者后，才可一并删除。该分支在证据齐全后
     风险较低。
- 共同验收：针对保留或退役的分支分别增加负向调用验证，运行受影响 Rust/前端测试，并确认命令表、
  用户可见流程与事件序列一致；使用确定性的 mock Executor/Reviewer 场景，把 Studio 页级反馈作为输入，
  断言所选 capability lane、独立 Reviewer 配置、取消/错误事件与 verdict 写回。不得用真实模型或笼统
  人工走查替代回归测试；调用方搜索只能作为最后的佐证。

### A2. 仓库根部的 `nul` 文件
- 368 字节，内容是 git CRLF 警告；当前 `git status` 显示为 `?? nul`，即未跟踪文件。它很可能是
  某个解释器上下文中的空设备重定向被当成普通文件写入所致，但不能仅凭文件名断定生产者。
- 动作：先定位生产者并确认解释器，再修正**无效上下文**的写法：PowerShell 用 `$null`，POSIX shell
  用 `/dev/null`，而 cmd/batch 中 `NUL` 本身是合法空设备。随后删除已确认的根部误生成物；如需
  防御性忽略，使用根目录限定的 `/nul`，不要以忽略规则掩盖仍在发生的错误。
- 验收：`git status --short --untracked-files=all` 不再出现根部 `nul`，并用对应 shell 的回归命令
  证明不会再次生成文件。

### A3. styles.css 覆盖沉积（同文件内自我冗余）
- Settings 样式散布在**至少 4 个区段**：~1440-2900（provider 卡/MCP/编辑抽屉/保存栏）、
  4454-6887（页头/角色行/provider 区/zone 头/IM bridge/Mail settings/advanced）、
  10491（“Final settings polish”）、13989（“Scheduled tasks final order overrides”）。
- 另有 “Homepage polish foundation”(3870)、“Final homepage cascade”(14177) 等
  多轮“最终”覆盖段，后段规则大量覆盖前段——典型的追加式打磨沉积。
- 动作：按模块归并区段，删除被完全覆盖的早期声明（配合 C5 拆分执行）。
- 护栏：CSS 的文本覆盖不等于运行时冗余；拆分必须保持 import/cascade 顺序，并在删除前比较关键页面
  的计算样式与截图（亮/暗主题、窄/宽视口、焦点与 reduced-motion 状态）。

### A4. Skills 重叠（观察项，已从本轮执行范围排除）
- `openalex` 与 `openalex-search` 两个 SKILL.md 高度重叠（一个通用检索、一个
  “可复现查询策略”），应合并为一个技能 + profile，或纳入 skill_registry 别名。
- `research-lit` / `arxiv` / `scopus-search` / `comm-lit-review` 在
  `runtime::skill_registry` 已 **Active** 别名到 `literature-search`，但磁盘上仍是
  各自完整的流程全文（research-lit 还带独立 REVIEWER_BACKEND/本地扫描流程）。
  别名已生效的技能，SKILL.md 正文应缩成指向 canonical 的 stub，否则
  no-shell 之外的 lane 仍可能按旧文执行，造成行为漂移。
- 本轮动作：只保留以上发现与后续评审问题，**不**合并、不 stub、不改 registry、也不调整任何
  `SKILL.md`。如未来获授权，应另开独立计划并先验证每条 alias 的调用契约与 fallback 行为。

### A5. 不同层级重复了 SSE `data:` 负载规范化
- `crates/api/src/sse.rs`（Anthropic 客户端）与 `crates/executor/src/openai.rs`
  （当前约 1189 行处自带 `data:` 行解析）。前者按 LF/CRLF 帧边界缓存，处理多行 `data:` 与事件名；
  后者只规范单个 `data:` 负载，流循环忽略其他字段。两者都接受 `data:` 后无空格的负载；真正差异是
  frame、多行 data 与事件语义，而不是零/一空格兼容性。
- 前置门槛：确认 `openai.rs` 相对目标基线无未审阅差异，且 owner 确认没有待落地的 OpenAI 并行改动；
  若任一条件不满足，A5 从 P1 延后。随后重新核对两个调用方及 whitespace 语义。
- 动作：仅在先定义 whitespace 契约后，抽 provider 无关的 `data:` 前缀/负载 helper；必须明确一个
  可选前导空格、额外前导空白与 trailing whitespace 是保留还是裁剪。`executor` 已依赖 `api`，可放在
  `api` 的窄公共面中；若两端确需不同 trailing 语义，则保留两个窄 helper。不要合并完整 SSE 事件
  组装、终止、重试或错误语义。
- 验收：以共享 fixture 覆盖分块边界、CRLF/LF、注释、空格容忍、多行 data、`[DONE]`、非法 JSON
  与终止/重试路径，并为 trailing whitespace 差异给出明确期望；此项保持为独立小 PR。

---

## B. 合并候选（先证明语义等价）

### B1. Gateway HTTP DTO 部分重复（先做端点级契约盘点）
- desktop/src-tauri/src/remote.rs:712-758 定义 `GatewayStartPairingRequest/
  Response、GatewayPendingClaim、GatewayApprovePairing*、GatewayDeviceSummary`；
  site/server/src/lib.rs:242-346 有相近的 `StartPairingRequest/Response、
  ApprovePairing*、DeviceSummary`。重复真实存在，但并非可直接替换：desktop 的请求字段带
  借用，`GatewayDeviceSummary` 只读 `id`，gateway 的 `DeviceSummary` 还含
  `name/role/scopes/active`。
- mobile 的配对 REST 类型主要位于 `site/remote/src/types.ts` 与 `gateway.ts`，
  覆盖的是 claim/complete 等移动端流程，只与 desktop 的 start/approve 端点部分重合；不能把它
  描述成第三份完整镜像。
- `crates/remote-protocol` 已被 desktop 与 gateway 共同依赖，适合作为候选契约边界，但不应把
  现有 DTO 原样搬入而跳过端点和安全语义核对；它必须保持 leaf/shared 协议层，不能引入 desktop
  策略、Tauri 状态或 gateway routes。该 crate 已拥有 `PairingInvitation`、带签名的
  `PairingRequest/PairingApproval` 等加密配对领域类型及校验/`deny_unknown_fields` 语义；重复的是
  Gateway HTTP DTO，后者应包装、复用或显式映射前者，不能把 secret/signature 语义压平成通用 DTO。
- 动作：
  1. 逐端点登记请求/响应字段、`serde` 命名、必填/可选、未知字段策略、认证与配对状态机；只把
     经确认真正共享的**自有** HTTP DTO 放入 `remote-protocol`，端点专属形状保留在适配层并显式转换，
     且复用既有配对领域类型的校验与签名边界。
  2. 为 Rust 与移动端选择可执行的单一契约产物：检查进仓库的 JSON Schema/OpenAPI 生成 TS，或
     以 Rust DTO 为源并用共享 JSON fixture 约束手写 TS。P1 开始前必须由 remote owner 选定其中一种，
     记录 canonical 产物路径、生成/更新命令与 CI drift check；仅“集中一个 TS 文件”不能防漂移。
  3. 按**端点、请求/响应方向和实际消费者**建立 golden fixture；不要强迫 mobile 验证其不消费的
     start/approve DTO。测试覆盖旧客户端、新字段、未知字段、`deny_unknown_fields`、approval/signature、
     本地批准、`DeviceScope`、scope escalation、replay/idempotency 与拒绝非法/未授权请求；为 wire
     契约定义版本演进和 additive rollout/rollback 规则。

### B2. SQLite 连接脚手架重复 + knowledge 所有权决策（拆成两条工作流）
- 三处独立 SQLite bootstrap 都设置了 WAL/busy timeout，但并非三份同构迁移/重试逻辑：
  `runtime/literature.rs` 有 schema version、`ensure_column`、IMMEDIATE+revision/retry；
  `runtime/session_index.rs` 是 best-effort 的幂等 index+FTS 初始化；`tools/knowledge.rs`
  是 7 表/trigram-FTS store 的普通事务。三者的持久性、并发和 provenance 语义不能被抹平。
- literature 迁移文档的“runtime 持久化 / tools 适配器”是有价值的参考，但不能仅凭类比断言
  knowledge 必须迁入 runtime：tools 也拥有 ARIS 工具实现和共享工具状态。需要先给 knowledge
  定义数据契约、调用 API 与依赖方向，再决定其持久化的归属。
- 动作 A（候选基础设施）：先确认 literature kernel 迁移验收项已完成、相关文件相对目标基线干净，
  再盘点每个 store 的数据库路径、PRAGMA、锁竞争、迁移版本与重试语义。只有当依赖图证明至少两个
  store 可复用且不会增加跨 crate 耦合时，
  才逐个 adopter 抽取 `open + WAL/busy_timeout` helper；不创建无 adopter 的 helper-only PR。
  事务重试、schema、版本演进、FTS 与领域迁移继续留在各 store。
- 动作 B（另开数据归属决策/迁移 PR）：待 literature kernel 迁移验收套件通过并由 owner 确认稳定后，
  决定 knowledge 是否迁至 runtime。若迁移，先定义兼容读取、失败回滚/备份和工具适配层的过渡边界，
  最后才移除 tools 中的持久化实现；若不迁移，则固化一个窄的 storage API。两种结果都不得形成
  tools↔runtime 循环依赖。
- 验收：动作 A 用连接配置与 busy-timeout 行为测试锁定共用 helper；若依赖收益门槛不满足，结论应是
  保留小规模重复。动作 B 仅在决定迁移时运行旧库升级、7 张表/FTS、并发写入、兼容读取与无数据丢失
  测试；若不迁移，则验证窄 storage API。两种结论都禁止 runtime↔tools 循环。

### B3. 斜杠命令只收敛已证实的纯语义，不能整体下沉
- engine.rs 含 provider/model 解析及 `handle_model/reviewer/permissions/plan/tasks/
  skills/resume/export/debug-zip` 等命令实现；
- aris-cli/main.rs 另有 `handle_repl_command/session/team/workflows/goal`；
- `crates/commands` 已拥有共享的 `SlashCommand` 解析、规格与帮助文本，并非只承载 manifest；
  desktop 明确含 Tauri/config/filesystem 等表面专属行为，CLI 的 REPL/session/team/workflows/goal
  也不是同一组适配器。
- 动作：先逐命令建立盘点表（输入语法、权限、状态副作用、输出/错误、所属 surface），并采用明确的
  所有权矩阵：`crates/commands` 将输入解析为 `CommandIntent` 并拥有规格/帮助/稳定错误类别；
  Desktop/CLI 保留配置存储、环境变量、项目根、权限输入、Tauri/文件系统/REPL/展示 IO，并把 typed
  config/capabilities 交给 `crates/chat`；chat 围绕既有 API 负责 provider/model 语义校验、权限策略、
  提示词和 turn 组装。仅下沉状态依赖等价的逻辑，表面文案允许不同。
- skills 冻结也覆盖 `/skills` 命令、skill 提示词与 registry 语义；B3 本轮可以盘点，但不得改动它们。
- 验收：每个下沉命令先有 Desktop/CLI 的兼容矩阵和 fixture，再以两端集成测试验证成功、拒绝、
  权限、稳定错误类别/代码，以及旧 session、project goal、tasks/plan、project-root 与审批状态；不得新增
  隐式外部动作。不要求两表面的展示文案逐字相同，也不把“共享 turn 内核”当作语义等价证明。

### B4. 前端 chat 事件订阅：当前不足以证明应抽公共 helper（暂缓）
- 已确认 `useChatStream.ts` 管理完整的多事件生命周期与 generation guard，
  `literatureStore.ts` 有领域过滤和项目投影刷新；`desktop/src/lab/Lab.tsx` 只订阅
  `onLabCellOutput`，使用简单的 disposed/unlisten 模式，并非 Chat 事件订阅者。原先“三处手写”
  的证据不成立。
- Literature 按 `tool.name.startsWith("Literature")` 过滤，且对每个 `chat-done` 刷新项目投影；
  `useChatStream` 也会按事件的 `sessionId` 路由多会话，而非只订阅一个 session。即使后续发现第二个
  可合并消费者，也不能机械套用 `subscribeChatEvents(sessionId, handlers)`。
- 本轮动作：从执行计划中移除 helper 抽取，只保留事件序列回归测试的缺口记录。未来只有在发现至少
  两个具有相同生命周期契约的消费者后，才先建立 filter、作用域、replay/order、session-switch 与
  dispose 的行为矩阵，再考虑诸如 `registerChatEventListeners({ filter?, handlers })` 的可配置 primitive。

### B5. CSS 组织统一（与 A3、C5 同一工程）
- 现状不一致：Literature/Lab/Mail/Studio/Knowledge/Typeset 有模块 CSS，而
  Settings、Chat、Scheduled 的样式长在 styles.css 中段；styles.css 尾部
  （约 14247 起）已建立共享 ambient-motion 段，方向正确。
- 动作：规则统一为“tokens + shell + 共享构件留 styles.css（或拆 tokens.css /
  shell.css），每模块样式独占一个文件”；Settings.css、ChatShell.css 从
  styles.css 摘出并顺手去沉积（A3）。
- 验收：先固定模块 import 顺序与层级边界；每次拆分都比较关键页面在亮/暗主题、常用响应式宽度、
  键盘焦点和 reduced-motion 下的视觉快照/计算样式，避免只凭人工“过屏”判断。

---

## C. 结构解耦候选（以行为保持为目标，按风险分阶段）

P2a 只包含留在现有 crate/所有权边界内的机械模块化。任何跨 crate 所有权转移属于语义重构，
进入 P2b 或独立 PR；CSS/React/API 拆分分别走 P3/P4 的专项验证，不能笼统称为“纯移动”。

| # | 目标 | 拆法 | 优先级 |
| --- | --- | --- | --- |
| C1 | engine.rs（8 505）| P2a 仅把 Tauri 适配、事件桥接与 desktop 隔离代码拆到 `desktop/src-tauri/src/chat/`；`ConversationRuntime` 与共享 turn/权限/provider 语义在此阶段保持现有 crate 归属不动。需要跨 crate 调整的条目先进入 B3 所有权矩阵，再走 P2b/独立语义 PR | 高 |
| C2 | tools/lib.rs（7 124）| 按域外移：web.rs(WebFetch/WebSearch)、memory.rs、repl.rs(REPL/PowerShell)、agents.rs(Agent/SpawnTeammate 执行体)、review.rs(LlmReview/verification gate)、latex.rs、misc(Todo/Brief/Config)；lib.rs 只留 dispatch 表与公共类型。Reviewer 模块仅迁位，不得与 Executor 配置/判定合并 | 高 |
| C3 | remote.rs（4 892）与 remote-gateway lib.rs（4 737）| desktop 侧：store+迁移 / pairing / gateway client（经 B1 契约测试后才使用共享 DTO）/ wire session / chat idempotency / commands；gateway 侧：routes / store / pairing / relay。P2a 只改变模块边界，不改 schema、keyring 引用、授权、重放或 idempotency 语义 | 中 |
| C4 | aris-cli main.rs（5 370）| 子命令一文件一模块（repl / session / team / workflows / goal / dump-manifests）| 中 |
| C5 | styles.css（14 800）| tokens / shell / 共享构件 + 模块文件（见 B5、A3），保持既有 cascade/import 顺序 | 中 |
| C6 | Settings.tsx（2 771）| 按 zone/section 组件化 | 低 |
| C7 | api/tauri.ts（1 286）| 按域拆 barrel（chat/literature/lab/mail/remote/…）| 低 |

Typeset.tsx/Typeset.css 虽同为巨石，但 Visual editor 正在重写（Phase 4/5 未完），
**明确暂缓**，避免与进行中的重写冲突。

---

## D. 防误伤边界（不是重复实现）

1. **literature 三层**（runtime store / tools adapters / desktop 命令）是文档化的
   有意架构，三个 literature.rs 不是重复实现，勿合并。
2. **mail/auto_literature.rs** 已复用 `tools::literature` 适配器（349/392/395 行处
   验证），迁移文档承诺兑现。
3. **A1 所列两个 agent send_rich 后端命令共享 `run_literature_chat_turn`**，非复制粘贴；
   普通 `chat_send_rich` 走不同的即时路径，三者只在更低层汇合。冗余风险在于这两个入口是否无人
   调用及其受限工具语义，而非三个命令的实现完全相同。
4. **lab.rs** 是薄封装的正面样板（头注释明确三层共用同一 kernel session）。
5. **事件传输面**是收敛的：当前前端共有 12 个 `onChat*` 注册入口，集中在 api/tauri.ts；这不等于
   各领域 consumer 的过滤与投影语义已经相同，因此不构成当前抽取 B4 helper 的证据。
6. legacy `papers/library.json` 投影是迁移文档明文保留的兼容层，退役条件
   （“所有 Desktop 消费者直读 canonical kernel”）尚未满足，不在本计划强拆。

---

## E. 分阶段执行计划

| 阶段 | 内容 | 前置 | 验证 |
| --- | --- | --- | --- |
| P0 基线冻结与决策（半天）| 在隔离工作树记录 HEAD、目标差异、命令注册/调用清单并重跑关键证据；A1 选择“保留当前 Chat 路由并退役遗留入口”，或经明确理由新增独立 lane；B1 由 remote owner 选定 canonical 契约产物和路径；A2 只处理 `nul`。**A4 skills 明确不执行。** | 无 | 可复现基线、A1/B1 决策记录、`nul` 生产者回归；保留 `nested/demo.txt`，不吸收已有未提交改动 |
| P0b A1 实施（独立 PR）| 按 P0 决策退役两个遗留入口，或实现经批准的新 Studio lane；不得把“决策完成”当作“实施完成”。 | P0 的受支持表面清单与产品决策 | 确定性 mock Executor/Reviewer、capability lane、取消/错误事件、verdict 写回及负向 invoke 测试 |
| P1 契约与低层防漂移（拆成独立 PR）| B1 端点级 DTO/版本/fixture 契约；A5 仅抽 `data:` 负载规范化；B2 动作 A（候选连接 helper）。 | P0；A5/B2 分别满足各自文件干净、owner/迁移验收门槛 | B1 按端点和实际消费者测试 remote-protocol、gateway 独立 workspace、desktop remote、mobile TS/typecheck；A5 跑 api/executor whitespace/frame fixture；B2 跑 runtime/tools 连接测试 |
| P1b 数据归属决策（可选迁移）| B2 动作 B：literature kernel 迁移验收通过后，确定 knowledge 的 storage API；若获决策再做数据迁移。 | P1；literature owner 确认验收套件通过 | 迁移时验证旧库升级、FTS、并发写入、兼容读取/回滚；不迁移时验证窄 API；crate 依赖图无循环 |
| P2a 机械拆分（多个小 PR）| C1 的 desktop 边界、C2 tools/lib.rs、C3 remote 两端、C4 CLI；仅在现有所有权边界内模块化，不做 B3 语义抽取。 | 对应热点无未审阅并发改动；C3 额外要求 B1 契约先稳定，其余可并行 | focused test + 编译 + import/可见性审查；C3 另测旧 remote state/keyring 引用、中断 pairing/session、replay/idempotency、fail-closed 与日志脱敏 |
| P2b 命令语义收敛（多个语义 PR）| B3 依所有权矩阵逐命令下沉，先有 Desktop/CLI 兼容矩阵，再合并实现。 | 命令盘点完成、相关 engine 命令模块边界稳定、该命令 fixture 就绪；不等待无关 C2/C3/C4 | 两表面的稳定错误类别、状态兼容、project-root/审批与无新增外部动作测试；不以“diff 仅移动”验收 |
| P3 前端 API 与组件边界 | C6/C7；B4 仅补事件回归证据，不抽 helper，除非未来满足其重复证据门槛。 | 对应 Rust/Tauri 接口稳定 | focused Vitest + `npm run build`；覆盖 stop→continue 和陈旧事件的现有路径 |
| P4 CSS 整理 | C5+A3+B5 的模块化、去沉积与 import 顺序固化。 | 先建立 repo-owned 视觉基线 manifest：Home、Settings(provider/MCP/Mail/advanced)、Chat、Scheduled；1440×900、1024×768、768×900；亮/暗、键盘焦点、reduced-motion。记录 capture 命令、owner 与允许阈值；没有可重复 harness 就不删规则 | Vitest + `npm run build`；按 manifest 生成前后截图/计算样式并由 owner 审核阈值内差异 |

### 执行纪律
- 机械拆分 PR 与语义 PR 严格分离：前者只能改模块边界、import 与可见性，不能改变行为；发现需要
  行为调整时，停止并另开语义 PR。
- 删除类改动必须同时通过注册表/动态调用方盘点、负向调用测试与用户流程回归；“调用方 grep 清零”
  只是辅助证据。
- Rust 改动先跑受影响 crate 的 focused tests；涉及 root workspace 的跨 crate 边界时跑
  `cargo test --workspace`。`site/server` 与 `desktop/src-tauri` 是独立 workspace，
  必须在各自目录另行测试；remote-mobile 还要跑 TS 的测试/typecheck。
- Desktop/Tauri API 改动先跑 focused Vitest，随后在 `desktop/` 跑 `npm run build`；CSS 还必须保留
  可比较的视觉基线。
- A5 每次开始前都重新确认 `openai.rs` 文件干净且无待落地并行改动；不满足即延后。Typeset 在
  Visual editor owner 确认 Phase 4/5 完成前继续暂缓；B2 必须以 literature kernel 迁移验收套件和
  owner 确认为门槛，不能依据旧的“in-flight”描述判断。

---

## F. 三次复核（2026-07-19，基线 `b2a52b31` 脏树 + ~657 行未提交增量）

本轮范围：逐 diff 审查全部未提交改动（chat/executor/tools/runtime 测试、desktop config/engine、
chat 前端恢复链路、LabAssistant、remote-gateway/mobile），实测测试基线，并复核 A/B 节结论现状。

### F0. 既有条目状态更新

- **A2**：根部 `nul` 已不存在（`test -f nul` 失败、`git status --untracked-files=all` 无该条目）。
  生产者是否已修复未验证——A2 的“定位生产者 + 回归命令”验收仍然有效，只是清理目标已消失。
  `nested/demo.txt` 原样保留。
- **A1**：两个 rich-send 入口状态不变——仍无生产调用方，`literatureAgentSend` 仅剩
  Literature.test.tsx 的 mock 引用。
- **A4**：`openalex` 与 `openalex-search` 仍并存；观察项不变，冻结不变。

### F1. 测试基线（本轮实测）

| 套件 | 结果 |
| --- | --- |
| aris-chat / aris-executor | 10 通过；47 通过 + 2 ignored |
| tools | 116 通过 |
| somniq-remote-gateway（独立 workspace）| 27 通过 |
| 前端 vitest（chat 22 / lab 18）| 全部通过 |
| desktop/src-tauri `cargo test --lib` | **并行 195 通过 / 3 失败；单线程 197 通过 / 1 失败** |

唯一确定性失败见 N1；另外两个失败（`paired_remote_chat_reads_the_selected_project_runtime_session`、
`desktop_prompt_is_deterministic_for_prompt_caching`）单线程通过，属 N2 竞态。

### N1. `/skills show research-lit` 陈旧断言 —— HEAD 即红（确定性失败）

- 机制：`tools::skill_markdown` 与 `resolve_skill_path` 现按 registry 把 **Active** 别名重定向到
  canonical（`activated_canonical_skill_name`），`/skills show research-lit` 返回 `literature-search`
  正文（标题“# Literature Search”，附 profile 注记）。`src/tests/engine.rs`
  `skills_command_shows_bundled_skill_markdown` 仍断言 “# Research Literature Review” → 必然失败。
- 归因：未提交增量不涉及该路径，**v0.4.24 发布提交本身即带红测**（0.4.24 的 literature-kernel
  cut-over 属有意行为，断言未随行为更新）。
- 动作（需 owner 先确认预期语义，二选一）：
  1. 认可“show 展示 canonical 正文”→ 更新断言为 canonical 标题 + profile 注记存在性；
  2. 期望“show 保留原名正文”→ 那是 `skill_markdown` 的行为缺陷，另开修复。
  修测试断言**不属于** A4 冻结范围（不改 SKILL.md/registry/别名语义），但选项 2 属于，需授权。
- 附带缺口：desktop `--lib` 显然未纳入发布门禁；建议把三个独立 workspace 的测试全部纳入
  release checklist（与执行纪律第 3 条一致）。

### N2. desktop 测试进程内 env 竞态（与既有“HOME-env race”残留同类）

- 现象：上述两测试并行挂、单线程过。机制：`with_bound_project_environment` 等对进程级环境变量的
  临时修改与并发测试的 env 读取互相污染（prompt 构建/项目会话路径解析都读 env）。
- 本轮未提交增量已在 tools（`EnvGuard`）、runtime（`test_env_lock`）、aris-cli（固定 `ARIS_*`）
  三处做同类加固——**desktop 测试尚未覆盖**。
- 动作：把同款串行化/守卫扩展到 desktop tests（env-mutating 测试共持一把锁，或改为 EnvGuard +
  锁组合），纳入正在进行的测试隔离工作流，不必等 P2。

### N3. 模型能力双表漂移（新增合并候选 B6-能力表） — **2026-07-25 复核：已解决**

- 两张手维表：`aris_chat::context_compaction_threshold_for_model`（压缩预算）与
  `engine::context_window_for_model`（UI 展示窗口/告警 payload）。本轮增量各自新增 kimi 分支后，
  实测不一致至少四处：
  1. **qwen 倒挂**：预算 200k > 展示窗口 128k（engine 无 qwen 分支落入默认）；
  2. **glm 倒挂**：预算 160k > 展示窗口 128k（同因）；
  3. **kimi/moonshot 宽前缀**：engine 把全部 `kimi-*`/`moonshot-*` 标 1M，chat 只认
     `kimi-k3` 850k、其余 200k（~256k 窗口）——非 k3 型号窗口显示虚高 ~4×；
  4. **claude 口径**：展示 1M（协商 beta）vs 预算 160k（防 200k floor）——有注释支撑但口径未标注。
  另有小杂物：chat 表第二处 `m.contains("minimax")` 位于早退分支之后，为死条件。
- 影响评估：压缩/告警门控走 budget，executor 本轮又新增 mid-stream context-overflow 强压缩兜底，
  **无真实溢出风险**；实害是 gauge/status 的窗口数字失真与 warn 时机口径混乱（倒挂项的 warn 点
  超过展示窗口）。
- 动作：单源化——由 `aris_chat` 暴露 `(window, budget)` 对，engine 只消费；最低限度先加跨表一致性
  测试（对全部已知模型族断言 `budget < window`，qwen/glm 倒挂立即被捕获）。归属上可挂入 B3 的
  chat 语义域，或独立小 PR（改动面小、语义清晰）。

### N4. Chat/Lab turn-恢复语义双份维护（B4 的**替代性**重复证据）

- 本轮同一修复（失败轮 Retry → 非破坏 resume）在两处各写一遍：`useChatRun.ts` 新增
  `resumeSession` + retry 分支，`LabAssistant.tsx` 新增 `resume` + retry 分支；
  `continueStoppedPrompt()` 在 chatRunHelpers.ts 与 LabAssistant.tsx **逐字两份**；
  `contextForRetry` 与 `contextFromTurns` 平行演化（本轮双双把 failed 轮纳入保留）。
- 与二次复核的关系：B4 对“事件订阅 helper”的暂缓结论**不受影响**——本条是不同层面
  （恢复语义与 prompt 常量）的重复，且是“同一 bug 修两遍”的实证。
- 动作（列为 B6-恢复语义，小步走）：
  1. 先只提取无争议的纯语义等价件：`continueStoppedPrompt` 常量与 “`assistant.error` → resume、
     否则 rewind-rerun” 判定，两端各保留自己的锁与 beginRun 适配；
  2. `contextForRetry` / `contextFromTurns` 的合并须先建立差异矩阵（Lab 有 `[Lab context]` 头、
     whole-context replace 语义与 attachments 处理），不满足等价证明就保留两份。
- 验收：两端 stop→continue、failed→retry、edit-rerun 的现有回归（本轮 chat 22 + lab 18 已覆盖主径）
  在提取后不改断言即通过。

### N5. 观察：remote-mobile styles.css 重现追加式覆盖模式

- 本轮 +237 行触屏 polish 注明 “intentionally sit after breakpoint overrides” —— A3 的沉积模式在
  第二个 CSS 文件出现苗头。暂不行动；P4 的视觉基线 manifest 候选范围应扩展到 remote-mobile。

### F2. 增量质量评价（正向，无需行动）

- executor 对首帧 SSE 报 context-overflow 的网关按初始 400 同路径强压缩重试（带分类测试）；
- `review_enabled` 默认翻转（opt-out → opt-in）在 config.rs 默认值、ProjectBriefCard 乐观初值、
  Settings preview 三处一致落地并更新测试——属有意产品行为变更，发布说明应提及；
- remote-gateway 测试从“转发任意字节”升级为 SecureEnvelope 端到端开封验证 + p2p_failed 信令路径；
- 测试环境隔离（EnvGuard / test_env_lock / ARIS_* 固定）方向正确，剩余缺口见 N2。
