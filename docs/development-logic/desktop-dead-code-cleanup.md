# ARIS Desktop 冗余代码清理方案

> 2026-06-17 第二轮审查更新。状态:方案待批准,代码未动。
> 范围:`desktop/` 桌面端 + `crates/runtime`、`crates/tools` 中桌面触达的部分。
>
> **v0.3.x 已落地的清理**(本轮移除,不再列入):
> - `commands::team_list` / `agent_supervisor` —— 已不在 `commands.rs`
> - `onRunEvent` + `RunEvent` 类型 —— 已不在 `tauri.ts` / `types.ts`
> - `DESKTOP_ALLOWED_AGENT_TOOLS` 中 6 个 team 工具 —— 已不在表里

---

## 0. 总体判断

| 类别 | 数量 | 处理 |
|---|---|---|
| 完全无消费者(可删) | 2 | 直接删 |
| 半 dead(清重导出) | 1 | 只删 `pub use`,文件保留 |
| 半启用 / 不一致 | 1 | 决策:读/删 |
| 隐藏但活着的功能 | 1 | 已在别处暴露,产品决策 |
| 不动,保留并标记 | 6+ | 仅在文档登记 |

---

## 1. Tier 1 — 确认可以安全删除(无其他消费者)

### 1.1 整套 `connectors.rs` + `desktop/connectors/` 资源 + TS 类型

**新发现(本轮)**

**证据**
- `desktop/src-tauri/src/connectors.rs`(整文件)实现 `connector_plugins_list` / `connector_connect` 命令
- 该模块 `include_str!` 四个外部 JSON:
  - `desktop/connectors/gmail/.codex-plugin/plugin.json`
  - `desktop/connectors/gmail/.app.json`
  - `desktop/connectors/outlook-email/.codex-plugin/plugin.json`
  - `desktop/connectors/outlook-email/.app.json`
- 同时依赖 `desktop/src-tauri/src/mail.rs` 的 `mail::connected_account_labels` / `mail::mail_connect`
- `desktop/src/api/tauri.ts:91,93` 导出 `connectorPluginsList` / `connectorConnect`
- `desktop/src/types.ts` 定义 `ConnectorPluginView` / `ConnectorActionResult` 接口
- **整个 `desktop/src/**` 零调用**(只有 tauri.ts 自身的定义)
- 注册到 `invoke_handler`(`lib.rs:114-115`)但前端不触发

**结论**:Gmail / Outlook 的"connector plugin"是平行的第二套 mail 入口(用 Codex plugin JSON 描述),但前端没渲染任何相关 UI。`desktop/src/mail/` 目录才是真在用的那条路。**整套 connector 链路是冗余入口**。

**操作**
1. 删除 `desktop/src-tauri/src/connectors.rs`(整文件)
2. `desktop/src-tauri/src/lib.rs` 移除 `mod connectors;` 和 invoke 注册
3. `desktop/src/api/tauri.ts:91,93` 删除 `connectorPluginsList` / `connectorConnect` 导出
4. `desktop/src/types.ts` 删除 `ConnectorPluginView` / `ConnectorActionResult` 接口
5. 删除 `desktop/connectors/` 整个目录(Gmail + Outlook 的 plugin.json + app.json)

**风险**:低,纯删除。需确认 `desktop/connectors/` 不被任何脚本或 CI 引用。

---

### 1.2 桌面端 `process_registry` `pub use` 重导出

**证据**
- `crates/runtime/src/lib.rs:98-103`:`pub use process_registry::*` 重新导出
- `desktop/src-tauri/**` 无 `use process_registry`
- `desktop/src-tauri/Cargo.toml` 不直接依赖 `process_registry`
- `crates/runtime/src/process_registry.rs` 是新文件,git status 标 `??` 未跟踪
- crate 内部消费方:`crates/runtime/src/bash.rs` 和 `crates/runtime/src/mcp_stdio.rs`(调用 `spawn_managed_background` / `register_managed_process`)
- 桌面侧唯一一次接触:`lib.rs:195` 在 `RunEvent::ExitRequested` 调 `terminate_all_managed_processes` —— **这一处是直接路径,不走 `pub use`**

**结论**:`pub use` 这一行是桌面侧的死链;文件本身 crate 内部要用,**不能删**。

**操作**
1. `git grep -n process_registry desktop/` 二次确认
2. `crates/runtime/src/lib.rs:98-103` 移除 `pub use process_registry::*`
3. `process_registry.rs` 文件保留(crate 内部在用)

---

## 2. Tier 2 — 不一致,先统一状态再谈删

### 2.1 团队功能残余防护层(已收敛)

**当前状态**(2026-06-17)

| 位置 | 状态 | 文件:行 |
|---|---|---|
| team prompt 开关 | 关 | `desktop/src-tauri/src/engine.rs:765` `include_team_orchestration: false` |
| `DESKTOP_ALLOWED_AGENT_TOOLS` | **已不含 team 工具** | `desktop/src-tauri/src/state.rs:3-24` (20 项,全部为 file/search/literature/skill) |
| 工具层硬阻止 | 存在 | `desktop/src-tauri/src/engine.rs:93-103` `TEAM_WORKFLOW_BLOCKED_TOOLS`:`SpawnTeammate/SendMessage/ListTeam/WaitForTeammates/TeamControl/Workflow` |
| slash 命令隐藏 | 双层,内容不一致 | `engine.rs:114` `DISABLED_DESKTOP_SLASH_COMMANDS = ["team", "workflows"]` <br> `desktop/src/chat/Chat.tsx:166` 4 项 set:`team/teams/workflow/workflows` |
| 事件监听入口 | **已移除** | tauri.ts 中无 `onRunEvent` |
| Tauri 命令 `team_list` 等 | **已移除** | commands.rs 仅剩 `skills_list/skill_view/state_dir` |

**结论**:v0.3.x 已经把主要 dead 路径清掉,只剩两层防御性过滤。两层内容不一致是历史遗留:
- `engine.rs:114` 是 Rust 侧 2 项
- `Chat.tsx:166` 是 TS 侧 4 项(包含 `teams`/`workflow` 单数形式)
- 仅 `team`/`workflows` 会被 Rust 实际反序列化,TS 侧多出的两个是防御性兜底

**操作建议**:统一到 Rust 侧 2 项。删 `Chat.tsx:166` 中多余的 `teams` / `workflow` 两项,只留 `team` / `workflows`。

---

### 2.2 `mail/model.rs:146` `reply_to_message_id` 字段未读

**证据**
- 编译警告:`field reply_to_message_id is never read`
- 字段在结构体定义,有赋值点,无读取者

**操作(2 选 1)**

| 选项 | 范围 |
|---|---|
| A. 补读 | 在 Mail UI 展示 reply-to 元信息(更对 —— 桌面 mail 已能回复) |
| B. 删字段 | 删结构体字段 + 所有赋值点,顺带消掉 warning |

---

## 3. Tier 3 — 入口隐藏但仍可达

### 3.1 `ScheduledTasks` 视图(主导航缺失,侧栏可达)

**修正(本轮)**

之前判"NAV_GROUPS 无 scheduled 项 = 不可达",实际是:
- `desktop/src/chat/ChatSidebar.tsx:362-368` 有一个"定时任务"按钮,`onClick={() => setTab("scheduled")}`
- 路径:开 App → Chat tab 展开 ChatSidebar → 点 "定时任务" → 跳到 ScheduledTasks 视图
- `store.ts:28` 的 `"scheduled"` 联合成员仍被消费
- `scheduled.rs` 后端 + `scheduledTasksList` TS wrapper 仍有调用

**结论**:**不是死代码**,只是入口位置隐藏(在 chat 侧栏,不在主导航)。是否提升到主导航或保留现状是产品决策,不在本次清理范围。

---

## 4. Tier 4 — 不动但标记

| 模块 | 路径 | 行数 | 评价 |
|---|---|---|---|
| `tools::team_state` | `crates/tools/src/team_state.rs` | ~1500 | CLI 测试 + 内部使用,保留 |
| `tools::workflow_state` | `crates/tools/src/workflow_state.rs` | 775 | 内部使用,保留 |
| `runtime::bash` | `crates/runtime/src/bash.rs` | — | 修改中,功能在用 |
| 79 个 skills | `desktop/src-tauri/resources/skills/**` | — | 实际被 `/<skill>` 调用,全部保留 |
| 49 个 MCP resource | `desktop/src-tauri/resources/mcp/**` | — | 后台启动,保留 |
| Mail / IM Bridge | `desktop/src-tauri/src/{mail,im_bridge}.rs` | — | 全部接通,保留 |
| 知识库 / 知识图谱 | `crates/knowledge/*` | — | UI 已接通,保留 |

---

## 5. 执行清单

```
□ 阶段 0 — 准备
  □ git checkout -b chore/dead-code-cleanup
  □ cargo build --manifest-path desktop/src-tauri/Cargo.toml   # 基线构建

□ 阶段 1 — Tier 1 删除(2 项)
  □ 1.1  connectors 全栈: 删 connectors.rs + lib.rs 注册 + tauri.ts 导出
                            + types.ts 类型 + desktop/connectors/ 目录
  □ 1.2  process_registry: lib.rs 移除 pub use(文件保留)

□ 阶段 2 — Tier 2 不一致 / 字段
  □ 2.1  Chat.tsx:166 收敛 4 项 set → 2 项(只留 team/workflows)
  □ 2.2  mail/model.rs:146 reply_to_message_id 决策(读/删)

□ 阶段 3 — 验证
  □ cargo build -p aris-desktop
  □ cargo clippy -- -D warnings                              # 0 warning
  □ npm run build
  □ npm run tauri -- build                                    # release 二进制
  □ 启动 .exe 走 7 个 tab + 侧栏定时任务入口:
    Chat / Literature / Studio / Mail
    Extensions / Sessions / Settings / 定时任务(侧栏)

□ 阶段 4 — 提交
  □ git commit -m "chore(desktop): remove dead code paths
                   — connectors/process_registry pub use/slash command drift"
  □ 合并到 release/v0.3.x → 打 v0.3.3 或 v0.4.0
```

---

## 6. 风险评估

| 阶段 | 风险 | 缓解 |
|---|---|---|
| 1.1 connectors 全栈 | 低 | 纯删除;`desktop/connectors/` 无外部脚本/CI 引用;mail 路径独立 |
| 1.2 process_registry pub use | 低 | 删重导出,crate 内部路径不受影响;lib.rs:195 直接调,不依赖 `pub use` |
| 2.1 slash 收敛 | 低 | 改的是防御性 set;Rust 侧反序列化仍是 2 项,行为不变 |
| 2.2 reply 字段 | 低 | 删字段同时改所有 `.reply_to_message_id =` 赋值点 |

---

## 7. 预计收益

- **代码量**:删 1 个 Rust 文件(`connectors.rs`)+ 1 个目录(`desktop/connectors/`) + 2 个 TS 接口 + 2 个 TS 导出 + 1 行 `pub use`,约 150-200 行 Rust + 4 个 JSON 资源
- **编译时间**:`aris-desktop` 少一个模块,小幅缩短
- **认知负担**:`connector_*` 命令不再出现在 invoke 注册表里;`process_registry` 暴露面收窄到 crate 内部
- **维护成本**:消除"Gmail/Outlook 两套入口"的歧义;slash 防御层收敛为单一真源

整个清理半天到 1 个工作日可完成,合并到 v0.3.3 或 v0.4.0 即可。
