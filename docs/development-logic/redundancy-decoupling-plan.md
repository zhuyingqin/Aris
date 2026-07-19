# 系统冗余 / 合并 / 解耦 整改计划

> 调查日期：2026-07-19（分支 0.4.23，含未提交改动）。
> 审计基线：`27ae92abe45f5bad32dd06a685778b3ba2ac6e63` 的脏工作树；本文件尚未纳入版本控制。
> 方法：全仓行数统计 + 逐热点交叉验证（函数面、调用方、事件面、schema、skills）。
> 结论先行：**分层架构本身是健康的**（runtime 持久化 / tools 适配器 / chat 共享内核 /
> desktop 薄命令，literature 迁移文档所立的原则基本被遵守）。问题集中在三类：
> ① 少量真死代码与误生成物；② 平行表面各自手写同一模式（wire 类型、SSE、SQLite
> 脚手架、命令语义、事件订阅）；③ 需要安全拆分的巨石文件（当前规模见第 0 节）。

### 执行范围与审计边界

- 本轮只覆盖 runtime、tools、chat、desktop、remote、CLI 与 CSS；**skills 仅保留为观察项，
  未经后续明确授权，不合并、不 stub、也不改 registry**。
- 这是一份脏工作树快照，行号只用于定位线索。每个 PR 开始前必须记录当前 `HEAD`、目标文件的
  已审阅差异、命令注册表与调用方清单，并在隔离后的工作树重新验证；不得把既有未提交改动混入
  本计划的 PR。
- “grep 清零”只能作为辅助证据，不能单独证明删除安全或跨表面行为等价。

## 0. 体量快照（审计时统计；实施前必须复查）

| 文件 | 行数 | 性质 |
| --- | --- | --- |
| desktop/src/styles.css | 14 711 | 巨石 + 覆盖沉积 |
| desktop/src-tauri/src/engine.rs | 8 491 | 巨石（254 fn / 29 命令）|
| crates/tools/src/lib.rs | 7 124 | 巨石（~40 工具分发 + 多域内联实现）|
| desktop/src/typeset/Typeset.tsx / .css | 7 159 / 6 416 | 巨石（重写进行中，暂缓）|
| crates/aris-cli/src/main.rs | 5 370 | 巨石 |
| desktop/src-tauri/src/remote.rs | 4 892 | 巨石 + wire 类型重复 |
| services/remote-gateway/src/lib.rs | 4 737 | 巨石 + wire 类型重复 |
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
- 边界澄清：`chat_send_rich` 直接使用 `run_chat_turn`；上述**两个** agent 命令共享
  `run_literature_chat_turn`，三者只在更低层的 `run_chat_turn_with_context` 汇合。不能把它们
  当作共享同一即时 turn loop 的三个重复命令。
- 前置门槛：在改动前列出 Tauri 注册、所有静态/动态 invoke、测试 mock、权限声明与事件消费者；
  同时由产品负责人明确 Studio 的 “Revise from feedback” 是否仍需独立入口。
- 动作（二选一）：
  1. **保留 Studio 流程**：将 `studioAgentSend` 以明确的用户入口接入 `studioStore`，仅退役
     Literature 侧。验收应覆盖发起、流式事件、取消、stop→continue 与错误呈现；这是新增/恢复行为，
     风险为中等。
  2. **退役两个入口**：仅当注册表和调用方盘点证明不存在生产消费者时，删除两个命令、前端包装、
     注册与相应 mock；只有在 `run_literature_chat_turn` 和
     `LITERATURE_AGENT_EXTRA_BLOCKED_TOOLS` 确认无其他消费者后，才可一并删除。该分支在证据齐全后
     风险较低。
- 共同验收：针对保留或退役的分支分别增加负向调用验证，运行受影响 Rust/前端测试，并确认命令表、
  用户可见流程与事件序列一致；还必须覆盖 Executor → 独立 Reviewer → revise-feedback 的完整回路，
  确保不会因退役受限工具通道而破坏独立复核。调用方搜索只能作为最后的佐证。

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
  10491（“Final settings polish”）、13900（“Scheduled tasks final order overrides”）。
- 另有 “Homepage polish foundation”(3870)、“Final homepage cascade”(14088) 等
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

### A5. 两份 SSE 解析器
- `crates/api/src/sse.rs`（Anthropic 客户端）与 `crates/executor/src/openai.rs`
  （当前约 1189 行处自带 `data:` 行解析）。前者按 LF/CRLF 帧边界缓存，处理多行 `data:` 与事件名；
  后者只规范单个 `data:` 负载，流循环忽略其他字段。两者都接受 `data:` 后无空格的负载；真正差异是
  frame、多行 data 与事件语义，而不是零/一空格兼容性。
- 动作：只抽 provider 无关的 `data:` 前缀/负载规范化 helper；`executor` 已依赖 `api`，可先放在
  `api` 的窄公共面中。不要合并完整 SSE 事件组装、终止、重试或错误语义，保留各客户端的 frame、
  多行 data、typed event 与终止处理。
- 验收：以共享 fixture 覆盖分块边界、CRLF/LF、注释、空格容忍、多行 data、`[DONE]`、非法 JSON
  与终止/重试路径；`openai.rs` 有并发编辑历史，此项保持为独立小 PR。

---

## B. 可合并（同类逻辑收敛到一处）

### B1. Gateway HTTP DTO 部分重复（先做端点级契约盘点）
- desktop/src-tauri/src/remote.rs:712-758 定义 `GatewayStartPairingRequest/
  Response、GatewayPendingClaim、GatewayApprovePairing*、GatewayDeviceSummary`；
  services/remote-gateway/src/lib.rs:242-346 有相近的 `StartPairingRequest/Response、
  ApprovePairing*、DeviceSummary`。重复真实存在，但并非可直接替换：desktop 的请求字段带
  借用，`GatewayDeviceSummary` 只读 `id`，gateway 的 `DeviceSummary` 还含
  `name/role/scopes/active`。
- mobile 的配对 REST 类型主要位于 `services/remote-mobile/src/types.ts` 与 `gateway.ts`，
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
     检查进仓库的 TS 声明配合共享 JSON fixture。仅“集中一个 TS 文件”或标注版本不能防漂移。
  3. 以 golden serialization fixture 做 desktop↔gateway↔mobile 的字段/错误兼容测试，并覆盖
     旧客户端、新字段、未知字段、`deny_unknown_fields`、approval/signature 校验与拒绝非法配对请求的
     行为；为 wire 契约定义版本演进规则。

### B2. SQLite 连接脚手架重复 + knowledge 所有权迁移（拆成两条工作流）
- 三处独立 SQLite bootstrap 都设置了 WAL/busy timeout，但并非三份同构迁移/重试逻辑：
  `runtime/literature.rs` 有 schema version、`ensure_column`、IMMEDIATE+revision/retry；
  `runtime/session_index.rs` 是 best-effort 的幂等 index+FTS 初始化；`tools/knowledge.rs`
  是 7 表/trigram-FTS store 的普通事务。三者的持久性、并发和 provenance 语义不能被抹平。
- literature 迁移文档的“runtime 持久化 / tools 适配器”是有价值的参考，但不能仅凭类比断言
  knowledge 必须迁入 runtime：tools 也拥有 ARIS 工具实现和共享工具状态。需要先给 knowledge
  定义数据契约、调用 API 与依赖方向，再决定其持久化的归属。
- 动作 A（先做、纯基础设施）：盘点每个 store 的数据库路径、PRAGMA、锁竞争、迁移版本与重试
  语义，只抽已证明相同的 `open + WAL/busy_timeout` 连接 helper；事务重试、schema、版本演进、
  FTS 与领域迁移仍各自留在所属 store，避免把 Literature 的 revision 模型强加给其他生命周期。
- 动作 B（另开数据归属决策/迁移 PR）：待当前 in-flight 的 runtime literature 迁移合入并稳定后，
  决定 knowledge 是否迁至 runtime。若迁移，先定义兼容读取、失败回滚/备份和工具适配层的过渡边界，
  最后才移除 tools 中的持久化实现；若不迁移，则固化一个窄的 storage API。两种结果都不得形成
  tools↔runtime 循环依赖。
- 验收：动作 A 用连接配置与 busy-timeout 行为测试锁定共用 helper 的语义；动作 B 用旧库升级 fixture、
  7 张表与 FTS 检索完整性、并发写入和无数据丢失测试验证。两项都要检查 crate 依赖方向，禁止形成
  runtime↔tools 循环。

### B3. 斜杠命令只收敛已证实的纯语义，不能整体下沉
- engine.rs 含 provider/model 解析及 `handle_model/reviewer/permissions/plan/tasks/
  skills/resume/export/debug-zip` 等命令实现；
- aris-cli/main.rs 另有 `handle_repl_command/session/team/workflows/goal`；
- `crates/commands` 已拥有共享的 `SlashCommand` 解析、规格与帮助文本，并非只承载 manifest；
  desktop 明确含 Tauri/config/filesystem 等表面专属行为，CLI 的 REPL/session/team/workflows/goal
  也不是同一组适配器。
- 动作：先逐命令建立盘点表（输入语法、权限、状态副作用、输出/错误、所属 surface），并采用明确的
  所有权矩阵：`crates/commands` 拥有解析、规格、帮助与无终端依赖的命令结果；`crates/chat` 拥有
  provider/config 解析、权限策略构造、提示词组装与 turn 语义；Desktop/CLI 保留 Tauri、文件系统、
  REPL 与展示 IO。仅把两端语义和状态依赖完全一致的部分下沉。
- 验收：每个下沉命令先有 Desktop/CLI 的兼容矩阵和 fixture，再以两端集成测试验证成功、拒绝、
  权限和错误文本/代码；不把“共享 turn 内核”当作命令语义已相同的证明。

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
  （14158 起）已建立“共享构件/动效”段，方向正确。
- 动作：规则统一为“tokens + shell + 共享构件留 styles.css（或拆 tokens.css /
  shell.css），每模块样式独占一个文件”；Settings.css、ChatShell.css 从
  styles.css 摘出并顺手去沉积（A3）。
- 验收：先固定模块 import 顺序与层级边界；每次拆分都比较关键页面在亮/暗主题、常用响应式宽度、
  键盘焦点和 reduced-motion 下的视觉快照/计算样式，避免只凭人工“过屏”判断。

---

## C. 可解耦（纯移动式拆分，不改行为）

| # | 目标 | 拆法 | 优先级 |
| --- | --- | --- | --- |
| C1 | engine.rs（8 491）| 仅将 Tauri 适配、事件桥接与 desktop 隔离代码拆到 `desktop/src-tauri/src/chat/` 子模块；`ConversationRuntime`、共享 turn/权限/provider 语义优先留在或移至 runtime/chat/commands 的所有权边界。desktop 内部 slash 命令分组与 B3 跨表面收敛另立阶段 | 高 |
| C2 | tools/lib.rs（7 124）| 按域外移：web.rs(WebFetch/WebSearch)、memory.rs、repl.rs(REPL/PowerShell)、agents.rs(Agent/SpawnTeammate 执行体)、latex.rs、misc(Todo/Brief/Config)；lib.rs 只留 dispatch 表与公共类型。literature/knowledge/studio/notebook/team_state/workflow_state 已是模块，照此收尾 | 高 |
| C3 | remote.rs（4 892）与 remote-gateway lib.rs（4 737）| desktop 侧：store+迁移 / pairing / gateway client（经 B1 契约测试后才使用共享 DTO）/ wire session / chat idempotency / commands；gateway 侧：routes / store / pairing / relay | 中 |
| C4 | aris-cli main.rs（5 370）| 子命令一文件一模块（repl / session / team / workflows / goal / dump-manifests）| 中 |
| C5 | styles.css（14 711）| tokens / shell / 共享构件 + 模块文件（见 B5、A3），保持既有 cascade/import 顺序 | 中 |
| C6 | Settings.tsx（2 770）| 按 zone/section 组件化 | 低 |
| C7 | api/tauri.ts（1 286）| 按域拆 barrel（chat/literature/lab/mail/remote/…）| 低 |

Typeset.tsx/Typeset.css 虽同为巨石，但 Visual editor 正在重写（Phase 4/5 未完），
**明确暂缓**，避免与进行中的重写冲突。

---

## D. 查过、确认不需要动的（防误伤清单）

1. **literature 三层**（runtime store / tools adapters / desktop 命令）是文档化的
   有意架构，三个 literature.rs 不是重复实现，勿合并。
2. **mail/auto_literature.rs** 已复用 `tools::literature` 适配器（349/392/395 行处
   验证），迁移文档承诺兑现。
3. **A1 所列两个 agent send_rich 后端命令共享 `run_literature_chat_turn`**，非复制粘贴；
   普通 `chat_send_rich` 走不同的即时路径，三者只在更低层汇合。冗余风险在于这两个入口是否无人
   调用及其受限工具语义，而非三个命令的实现完全相同。
4. **lab.rs** 是薄封装的正面样板（头注释明确三层共用同一 kernel session）。
5. **事件传输面**是收敛的：后端仅 ~10 个事件名，前端注册入口集中在 api/tauri.ts；这不等于
   各领域 consumer 的过滤与投影语义已经相同，因此不构成当前抽取 B4 helper 的证据。
6. legacy `papers/library.json` 投影是迁移文档明文保留的兼容层，退役条件
   （“所有 Desktop 消费者直读 canonical kernel”）尚未满足，不在本计划强拆。

---

## E. 分阶段执行计划

| 阶段 | 内容 | 前置 | 验证 |
| --- | --- | --- | --- |
| P0 基线冻结与决策（半天）| 在隔离工作树记录 HEAD、目标差异、命令注册/调用清单并重跑本报告的关键证据；A1 由产品负责人选择保留或退役；A2 定位 `nul` 生产者并清理。**A4 skills 明确不执行。** | 无 | 可复现的基线记录、A1 决策记录、`nul` 生产者回归；不吸收任何已有未提交改动 |
| P1 契约与低层防漂移（拆成独立 PR）| B1 端点级 DTO/版本/fixture 契约；A5 仅抽 `data:` 负载规范化；B2 动作 A（连接 helper）。 | P0 的基线与所有权清单 | B1：remote-protocol、gateway 独立 workspace、desktop Tauri remote、mobile TS/typecheck 与 wire fixture；A5：api/executor fixture；B2：runtime/tools 连接测试 |
| P1b 数据归属决策（可选迁移）| B2 动作 B：待 literature runtime 迁移稳定后，确定 knowledge 的 storage API；若获决策再做数据迁移。 | P1；literature 迁移已合入并验证 | 旧库升级、FTS、并发写入、兼容读取/回滚测试；crate 依赖图无循环 |
| P2a 机械拆分（多个小 PR）| C1 的 desktop 边界、C2 tools/lib.rs、C3 remote 两端、C4 CLI；仅移动/模块化，不做 B3 语义抽取。 | P1 完成 | 受影响 crate 的 focused test + 编译；人工审查 import/可见性改动；跨根 workspace 边界分别测试 |
| P2b 命令语义收敛（多个语义 PR）| B3 依所有权矩阵逐命令下沉，先有 Desktop/CLI 兼容矩阵，再合并实现。 | P2a；每个命令的行为 fixture | 两表面成功/拒绝/权限/错误集成测试；不以“diff 仅移动”作为验收 |
| P3 前端 API 与组件边界 | C6/C7；B4 仅补事件回归证据，不抽 helper，除非未来满足其重复证据门槛。 | 对应 Rust/Tauri 接口稳定 | focused Vitest + `npm run build`；覆盖 stop→continue 和陈旧事件的现有路径 |
| P4 CSS 整理 | C5+A3+B5 的模块化、去沉积与 import 顺序固化。 | 视觉基线已建立 | Vitest + `npm run build`；亮/暗、窄/宽、焦点、reduced-motion 的视觉/计算样式对比 |

### 执行纪律
- 机械拆分 PR 与语义 PR 严格分离：前者只能改模块边界、import 与可见性，不能改变行为；发现需要
  行为调整时，停止并另开语义 PR。
- 删除类改动必须同时通过注册表/动态调用方盘点、负向调用测试与用户流程回归；“调用方 grep 清零”
  只是辅助证据。
- Rust 改动先跑受影响 crate 的 focused tests；涉及 root workspace 的跨 crate 边界时跑
  `cargo test --workspace`。`services/remote-gateway` 与 `desktop/src-tauri` 是独立 workspace，
  必须在各自目录另行测试；remote-mobile 还要跑 TS 的测试/typecheck。
- Desktop/Tauri API 改动先跑 focused Vitest，随后在 `desktop/` 跑 `npm run build`；CSS 还必须保留
  可比较的视觉基线。
- openai.rs、Typeset 相关文件在其各自进行中的工作合入前不碰；knowledge 的数据归属也不得抢跑
  当前 literature 迁移。
