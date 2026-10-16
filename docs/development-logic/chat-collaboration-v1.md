# Chat 双子 Agent 协作第一版

2026-10-15 UI 更新：子任务列表已迁入 Project Summary，点击后在侧栏页签查看原有子会话与执行时间线；主聊天顶部不再显示长任务卡片。现行交互及本轮验证见 [子智能体摘要与侧栏对话](agent-summary-navigation.md)。下文的卡片和父子树说明保留第一版交付记录。

本轮里程碑：完成 Chat 中可解释、可控制、可恢复的双子 Agent 协作闭环。Desktop 是产品入口，状态与投递协议位于共享 runtime，普通子任务不能代替独立 Reviewer。

## 已实现的行为

普通本地 Chat 将当前回合的 Executor 连接、模型、项目执行上下文、权限模式与可用工具冻结到协作宿主。每个子任务拥有独立 Session，使用同一 `aris_chat::build_conversation_runtime`，不建立专用 Anthropic 客户端。旧 `Agent` 是同一创建动作的兼容名；没有 Session 宿主的入口明确失败，不会落回旧后台任务或输出文件协议。

| 动作 | 协议 |
| --- | --- |
| `spawn_agent` / `Agent` | 必须提供 name、task、reason、inputs、deliverable、stop_condition、read_only 角色和已满足的前置条件；成功返回控制器真实状态。 |
| `send_message` | 投递信息；空闲收件人不会因此启动。子任务只能向 `/root` 发送协调消息。 |
| `followup_task` | 在原有子会话继续；运行中在下一次模型请求接收，空闲时开始新回合。 |
| `wait_agent` | 等待自己的 mailbox，收到结果、失败或协调消息即返回；不占两个子任务名额。等待最长 60 秒，可再次等待。 |
| `list_agents` | 返回真实状态、模型连接、权限、项目归属、最近活动、结果及证据位置，不消费邮件。 |
| `interrupt_agent` | 停止当前回合，保留会话和部分证据，之后由用户或父会话显式续派。 |

第一版每个父会话最多保留两个普通子会话、一层委派。后续工作复用这两个会话；没有递归组队。每次执行最多 16 次模型迭代和 600 秒。只允许父工具权限与读取、搜索白名单的交集；不开放 Shell、文件修改、任意 MCP、外部消息、生成媒体、委派或正式审查工具。Prompt 权限不会被子任务偷偷提升。

模型提示要求直接处理简单问答和单点修改，仅在任务可独立完成、存在并行收益或需要独立上下文核查时委派。前置输入缺失时拒绝创建。主 Agent 要说明哪些发现被采纳、拒绝或仍需核查，以及停止或失败带来的缺口。

## 停止、失败与退出

- 每次执行分配独立取消标记与回合 ID。开始新回合会退休旧回合；重复完成事件和旧回合的 start、finish、error、checkpoint、消息与创建请求均不能覆盖新状态。
- 最终成功保存和失败保存均在持有主会话执行槽的锁内核对回合；停止的原回合只有在执行槽尚未被替换时才能保留部分会话，不能在新回合开始后覆盖 canonical 文件或内存缓存。子任务启动、连接重绑定、中断和会话关闭也在同一状态锁内核对归属，消除入口检查后的停止竞态。
- 停止父会话递归停止子任务和保留角色；旧取消标记永久保持取消。已保存结果不被删除，待启动邮件不再自动触发执行。
- 子线程异常、模型错误与 panic 隔离为该子任务失败，结果通过 mailbox 告诉父会话；失败初始化不会无限重启。创建失败显示失败卡片并释放名额。
- 项目停止与应用退出记录不同原因。应用退出保留检查点、合约和未消费邮件，重新打开只恢复可追溯状态，不启动模型请求。
- 删除 Chat 关闭其树并清理关联子会话；正常停止保留历史。

卡片由控制器快照和事件驱动，无文件轮询。卡片展示委派理由、职责、排队/运行/等待/完成/失败/停止、最近真实工具调用、摘要、输入、模型连接、权限、项目、预算和会话证据，可停止、查看详情、显式继续。每项状态带递增 revision，迟到查询和事件不能把较新状态倒退。不可恢复的创建失败不提供无效的继续按钮。持久化错误向界面暴露。

基础父子树随卡片显示真实根会话与子任务。查看子会话时，按需读取其持久事件日志形成最近 80 项执行时间线，涵盖创建、模型绑定、执行起止、工具调用、邮件、停止与恢复，保留回合归属。时间线仅投影允许展示的字段；不暴露完整模型输入或连接凭据。这是列表视图，不包含复杂 Trace 画布或跨会话关系图。

## 恢复协议

`<project sessions>/agents/state.json` 原子保存任务合约、树、mailbox、inflight 租约、回合退休信息、状态和最后活动；同目录保存独立会话 JSON 和事件 JSONL，`edges.jsonl` 保留谱系。独占 owner lock 防止第二进程重写正在运行的树。

投递顺序是：保存邮件租约 → 将带稳定 mail ID 的消息加入 canonical Session → 保存 Session → 确认消费。重启逐条核对当前会话及压实归档中的稳定 ID：已经保存的不重投，未保存的重新入队。已完成但尚未交给父会话的结果保留为未消费邮件。

同一进程内停止后续派也执行相同对账：旧回合取走但没有落盘的邮件重新排队，已写入 canonical 事件的邮件不再投递，即使便利 manifest 尚未来得及保存。初始化失败只消耗已处理的唤醒标记，保留邮件内容；不会无限自动重试，也不会清掉旧 worker 退出期间收到的新续派。

尚未执行的任务保持排队，需要显式继续；运行或等待中的任务改为中断并展示原因。工具意图在执行前保存；没有匹配结果的意图是“不明操作”。恢复时保留这个事实，续派前补入明确的 unknown 工具结果，不从旧意图执行工具，也不把未知当成功。新模型仍需先核对现有证据，不能静默重放外部操作。

普通子任务的结果和实际会话证据进入正式 Reviewer 的审查包。Reviewer 使用保留的 `/root/~reviewer`、独立模型及自己的只读工具，模型协作工具不能发现、发送消息或访问该角色；其 verdict 不会作为普通邮件直接交给 Executor。

## 验证记录（2026-10-15）

模拟与真实模型的记录分别存放。确定性测试中的“模拟通过”仅证明状态、驱动、投递和恢复协议。

| 验证 | 结果与证据 |
| --- | --- |
| Windows 压实 PermissionDenied | 已复现为执行沙箱的 OS code 5：原子文件替换被拒绝；同一个原始压实测试在正常权限下通过。没有为绕过沙箱而削弱压实或持久化。 |
| Rust 工作区 | 最终 `cargo test --workspace`：1456 passed、5 ignored，退出码 0；`.somniq/chat-collaboration-verified-workspace.log` 与 `chat-collaboration-verified-workspace-exit.txt`。包含协作意图和恢复续派时六动作均可见的路由回归。 |
| 控制器与恢复 | 64 项通过；`.somniq/chat-collaboration-final-controller.log`。覆盖旧回合隔离、停止竞态、完成与待执行任务恢复、未消费结果、租约与 canonical Session 对账、不明工具意图、独立 Reviewer 隔离。新增真实独立进程退出再打开的恢复测试，模型响应仍为模拟。 |
| 原生模拟协作与 Chat | 141 项通过、5 项默认 ignored；`.somniq/chat-collaboration-final-native.log`。其中 10 项协作模拟覆盖共享 Executor → runtime → Kernel → 子 Session → mailbox、双任务、补充、同会话追问、停止一方、失败隔离、前置条件、权限、独立 Reviewer、初始化恢复及持久时间线；3 项真实模型测试默认 ignored，另行显式运行。 |
| 父会话与正式审查 | 父会话管理 7 项、独立 Reviewer 聚焦 21 项通过；`.somniq/chat-collaboration-final-agent-threads.log` 与 `chat-collaboration-final-reviewer.log`；Chat 审查集成也包含在原生 141 项中。 |
| 前端 | Chat、卡片、独立审查面板 59 项通过；TypeScript 与生产构建通过。记录见 `.somniq/chat-collaboration-final-ui.log`、`chat-collaboration-final-typecheck.log`、`chat-collaboration-final-build.log`。 |
| 真实模型 | 最终审计修复后重新显式执行 3 项，全部通过、退出码 0，耗时 230.84 秒；`.somniq/chat-collaboration-final-live.log` 与 `chat-collaboration-final-live-exit.txt`。独立于模拟测试计数。早先的 216.51 秒记录保留为历史，不代替最终版本记录。 |

真实模型使用当前配置的 Executor `deepseek-v4.1-flash`，连接为 `openai-compatible / somni.ensuanx.com`；父会话权限为 `danger-full-access`，子会话实际权限为其与只读白名单的交集。测试项目为 `collaboration-live-acceptance`。独立 Reviewer 使用单独 Session 和配置的 `MiniMax-M3`（provider `custom`），最终执行 3 次只读工具调用：2 次 `read_file` 成功独立读取两份指定证据，1 次补充 `glob_search` 未得到可用结果。Reviewer 将补充检索的限制写入 missingChecks，没有据此推断其他文件不存在；针对限定范围的回答给出 `pass`。早先一轮的 6 次核查属于历史记录。

| 真实场景 | 实际结果 | 证据目录（位于 `.somniq/runtime/`） |
| --- | --- | --- |
| 解释函数 | 主会话直接解释，无子任务。 | `chat-collaboration-live-simple-086b4992ff115f07/` |
| 后端恢复与前端状态核查 | 两个只读子会话完成，各自读取证据；主会话收到结果并在原后端会话追问，随后由独立 Reviewer 核对。 | `chat-collaboration-live-parallel-54d6b6c3b7fa097d/` |
| 补充条件、停止一方、追问另一方 | `C99` 条件到达前端子会话；后端最终为 Interrupted，前端为 Completed；追问复用原前端 Session。主回答只采纳前端已有交付并明确后端缺口。 | `chat-collaboration-live-stop-4f107757483d9620/` |

并行场景中，子任务发现验收资料明确缺少跨设备测量，因此主回答将结论保持为“未测量／不可判定”。Reviewer 独立读取原文，确认不能从单设备陈述推导跨设备结论。这个 `pass` 只针对证据使用和限定后的回答，不代表跨设备能力通过验证。

重启恢复除确定性控制器和 Session 测试外，另有实际独立进程退出测试：子进程直接退出、不运行析构或优雅关闭；新进程重新获取 owner lock，保留已完成但未消费结果、尚未执行任务和不明工具意图。显式续派只交付一次已有结果，不执行旧工具意图；再次重开不重复交付。该项使用模拟模型，不能冒充桌面 UI 关闭重开或真实模型恢复验收。

完成度边界：第一版核心源码及自动化验证已交付；尚未做 Windows WebView2 中的真实点击、整应用关闭重开及真实模型恢复操作验收，也未重打包或更新已安装程序。项目里程碑保留为待桌面验收状态。多 Agent 同时改文件、递归组队、自动选择不同供应商、全产品 Reviewer 迁移、复杂 Trace 画布和跨会话关系图按用户要求暂缓。

真实模型入口：

```powershell
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib engine::collaboration::tests::live_ -- --ignored --nocapture --test-threads=1
```

三个测试分别验证简单函数解释不委派、双任务整合及正式独立审查、补充条件后停止一方并继续另一方。真实模型读取本地验收 fixture；这验证实际模型工具协议与执行路径，不构成实际科研资料质量或跨设备泛化的验证。记录写入 `.somniq/runtime/chat-collaboration-live-*/result.json`、`review.json` 及 canonical 会话，包含模型、已脱敏连接、项目、权限、用量与结果。完整索引为 `.somniq/runtime/chat-collaboration-verification.json`；父会话用量见各 `result.json`，子会话用量见 `agent.usage` 事件，Reviewer 用量见 `review.json`，父用量不包含子任务与审查。

本轮不包含多 Agent 同时修改文件、递归委派、自动选择不同供应商、其他产品面 Reviewer 迁移或复杂 Trace 画布。安装包与 Windows WebView2 人工操作验收应单独记录。
