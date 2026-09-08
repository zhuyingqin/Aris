# SomniQ 记忆质量审查与重构建议

日期：2026-09-06。范围：当前工作树代码、只读本机 v2 数据库、TencentDB-Agent-Memory 公共源码。

本次目标：解释低质记忆如何产生和进入上下文，确认关键实现缺陷，给出保留本地优先与独立 Reviewer 的重构顺序、迁移办法和验收条件。本次没有修改生产代码、运行记忆重建或更改用户记忆数据。

## 结论

问题首先在记忆形成机制，其次才在检索。当前系统把“聊天里出现过、能找到原句”当成主要准入条件，把单回合摘句分别贴上 R1/R2/R3 标签，缺少对采纳状态、持续价值、矛盾更新和跨回合情境的建模。模型因此可以忠实地记下一堆无用信息。

建议保留 Session、SQLite、溯源和 outbox 基础，重构 **采集 → 场景化候选 → 独立质量审阅与冲突处理 → 原子事实 → 场景文档 → 按需召回**。不应先把脏数据向量化，也不应把 Executor 的自行记录视为天然可信。

## 审查证据与边界

- 本机 v2 库使用 SQLite `mode=ro` 读取；没有通过 Store 的 `open()` 访问生产库，避免其自动迁移产生写入。
- 库中 111 条 `active` 记忆：R1 69、R2 40、R3 2；另有 83 条 R1 已被旧类型迁移归档。主要项目占其中 109 条，另一个项目有 2 条 R2。不能把全库数量误写成单个项目数量。
- outbox：89 completed、17 rejected、11 dead_letter、1 deferred。audit 中有 270 次 deferred，说明重试成本值得跟踪；这不是 270 个独立失败回合。
- 69 条活跃 R1 中，按 `occurred_at + ttl_days` 计算，33 条在审查时已超过有效期。实际存储的有效期从 9 月回填时重新开始。
- 同项目、同层中存在 4 组文本完全相同的活跃记录。语义近似和中英翻译重复尚未系统计量。
- `cargo test -p runtime research_memory_v2 --lib`：35 passed。没有修改代码，因此未运行桌面构建或全工作区测试。
- 检索探针复现的是 `recall_local` 的 SQL 与排序逻辑，不是完整桌面回答；R0 Session fallback 可能另行找回内容，不能把局部检索为空表述成所有记忆渠道失效。
- 现有项目目标文件已读取，记录的是另一项 9 月 4 日的模型/Typeset 工作；没有根据该文件推定那些工作已经完成，也没有覆盖该目标文件。

活跃库中的代表性样本：

| 内容 | 当前层 | 问题与正确去向 |
|---|---|---|
| 图1 间距拉开一些 | R1 | 一次编辑指令；留在 Session，不作为可复用记忆 |
| 第二章完整的内容蓝图 | R1 | 只有标题，无实际蓝图；保留文档定位信息即可 |
| 推荐 8 章方案 A 章节目录 | R1 decision | 建议被记成决定，缺少采纳证据 |
| 成功生成 Final/main.pdf 108 页 12.6 MB | R1 | 历史构建事件；用产物/运行记录管理，不当成当前文件状态 |
| BUILD_VERIFY PASS | R2 | 缺少对象、版本、时间，不能独立使用，也不能证明当前构建有效 |
| 读取器要求字符串数组 | R2 | 丢失具体读取器、字段和版本，几乎无法应用 |
| 论文中心科学问题正式改为知识迁移…… | R1 milestone | 有持续价值，却只能由原 Session 召回，且与旧研究定位并存 |
| read_file 读取参考文档失败，随后读取 main.tex 成功 | R1 inline | 不同文件的两个动作被误判为“失败已恢复” |

这些样本足以证明质量问题；本次没有做全库人工标注，因此不报告“垃圾占比”。R2 里仍有可用的项目定位、方法约束等信息，不建议整库直接删除。

## 可定位的缺陷

### 1. P1：来源正确不等于值得记忆，也不等于事实已验证

位置：`desktop/src-tauri/src/memory.rs:734`、`:748`、`:786`、`:2105`。

抽取阶段虽写了未来价值测试，但 promotion 主要要求原句存在、陈述得到来源支持，并明确允许任务或选定方法作为 R1。对 assistant 来源的候选，审阅输入通常只有 assistant 文本，无法可靠区分“助手建议”与“用户已确认”。最后 R2 又被展示为 `Verified research memory`。

修复方向：同时检查证据支持、采纳状态、独立可读性、未来用途、时效、信息增量。`assistant_asserted` 与 `tool_observed`、`user_confirmed`、`reviewer_verified` 必须分开。科研结论的验证要引用论文证据、实验运行和 Reviewer 结果，不能引用助手自己一句“已验证”。

### 2. P1：过滤候选后，审核结果按错误位置关联

位置：`crates/runtime/src/research_memory_v2.rs:520`、`desktop/src-tauri/src/memory.rs:704`。

`record_extractions` 逐项丢弃无效候选，只返回幸存 ID；调用方却 `ids.iter().zip(extractions.iter())`。原数组 `[A无效, B有效, C有效]` 会配成 `(idB,A)`、`(idC,B)`。同层时可能错误接受或拒绝，异层时也会误拒绝；C 未按自己的内容得到审阅。

修复方向：返回带内容的已验证候选，或按持久化 ID 重新读取；每份审核结论必须绑定 `candidate_id + content_hash + source_revision`。增加无效候选出现在首位、中间、末尾的流水线测试。

### 3. P1：工具事件直接激活，且“同工具后续成功”不证明恢复

位置：`crates/runtime/src/research_memory_v2.rs:898`、`:1452`、`:1489`；`desktop/src-tauri/src/memory.rs:324`。

`record_inline` 没有独立审阅，R1/R2 直接 active。当前生产调用是工具 episode → R1。episode 只寻找后续同名工具成功，参数不同即可；读取另一份文件并不能解决原文件不可读的问题，真实库已有此例。

修复方向：确定性代码只登记 observation；候选必须经过同一个 Reviewer。区分相同任务/目标的恢复与无关成功，保留原始工具调用 ID、目标资源、错误类别、结果证据。一次失败通常只是诊断事件；只有有适用条件和验证的经验才提升为 lesson。

### 4. P1：历史回填让过期任务重新获得生命

位置：`crates/runtime/src/research_memory_v2.rs:707`、`:2302`。

`expires_at` 由 `iso_after_days` 使用当前时钟计算，忽略原事件时间。7 月的一次性任务在 9 月回填后，仍可“有效到 10 月”。这是 33 条过期源事件仍活跃的直接原因。

修复方向：分开 `observed_at`、`recorded_at`、`valid_from`、`valid_until`。回放不得修改事件有效期；确有新证据续期时，创建显式 reaffirmation 事件。

### 5. P1：未生效的新记录会废止旧记录，主题冲突范围也过宽

位置：`crates/runtime/src/research_memory_v2.rs:736`、`:1005`、`:1873`。

新 R3 尚待用户确认、新 R2 尚待远端同步时，都立即调用 `supersede_same_subject`，使旧 active 条目失效。匹配键只有 project/layer/kind/subject，忽略 Session、scope 和具体属性；所有 `read_file` finding 也共用一个 subject。

已用源码中的原 SQL 在内存 SQLite 复现：待确认 R3 使已确认规则变为 superseded；Session B 的 read_file finding 使 Session A 的 finding 变为 superseded。没有对生产库执行该 SQL。

修复方向：独立冲突审阅输出 merge/supersede 的目标 ID；仅在新记录正式激活的事务里切换状态。身份键包含 scope/entity/predicate，互补事实可并存，不能“一工具只剩一个事实”。

### 6. P1：层级实际上是 TTL 标签，跨会话连续性被切断

位置：`crates/runtime/src/research_memory_v2.rs:1168`；`desktop/src-tauri/src/memory.rs:734`。

R1 无论 `scope=session` 还是 `milestone` 都强制 `session_id` 相同；v2 没有从累计 R1 形成 R2 场景的主路径。核心研究问题这种 milestone 记忆进了 R1，就被困在原 Session。新的会话探针查询“知识迁移”返回空；旧的研究定位仍可能从 R2 命中。

修复方向：将作用域、有效期、信息类型、聚合层级分离；`milestone` 要绑定实际 milestone ID。R1 是已审阅原子事实，R2 是由这些事实聚合的场景文档。Project Goal 和 Workflow Ledger 继续拥有任务状态，不另造相互矛盾的状态副本。

### 7. P2：候选召回截断过早，中文没有有效分词

位置：`crates/runtime/src/research_memory_v2.rs:1143`、`:2437`。

先取最近 100 条，再对子串计数，旧而相关的记忆根本没有参选机会；CJK 连续句子被作为一整项，普通中文问句很容易零命中。`missing data` 探针还召回了带 Data 的论文元数据，缺少 IDF 和相关性重排。

修复方向：全库索引检索、中文分词、BM25，再按 scope/status/validity 过滤和重排；可选向量使用排名融合。空结果是合法结果，不能总用最新几条填满。去掉“最近100条”正确性上限，保留最终响应预算。

### 8. P2：抽取上下文被裁断，摘要约束偏向复制原话

位置：`desktop/src-tauri/src/memory.rs:285`、`:759`、`:2646`；`crates/runtime/src/research_memory_v2.rs:2327`。

user/assistant 两边都剥离代码块，并要求清洗后至少 20 字符；短而明确的用户偏好可能根本不入队。抽取只看到各自前 3000 字符的单回合文本，没有背景场景。statement 的字符/词包含检查不能证明逻辑蕴含，也妨碍消解指代和表达完整关系。

修复方向：结构化来源引用代替全词来自原句的规则；明确区分新消息与背景消息，允许受证据约束的归纳。来源跨度仍应精确，但 statement 的语义支持由独立审阅负责。

## 从 TencentDB 学什么

源码锚点：[`2ee22397f6091b8cd3ea847bc1edb04d3bec0c94`](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94)，审查时默认分支 `feat/server_team`。没有部署或实测腾讯服务，不能宣称其在本项目上的质量提升幅度。

| 机制 | 腾讯源码证据 | SomniQ 应采用的部分 |
|---|---|---|
| 场景与背景 | [L1 extractor](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/record/l1-extractor.ts#L177) | 新消息 + 背景窗口 + 上一场景；先消解指代再抽取 |
| 准确归因 | [L1 work prompt](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/prompts/l1-extraction.ts#L162) | 建议不能自动成为决策；只保存有后续用途的完整信息 |
| 冲突处理 | [dedup decisions](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/prompts/l1-dedup.ts#L30) | store/skip/update/merge；按 ID 关联，多证据归并，保留演变时间线 |
| 聚合层级 | [scene extractor](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/scene/scene-extractor.ts)、[persona generator](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/persona/persona-generator.ts#L91) | R1 → R2 场景文档；上层只处理有变化的下层，文档带版本和来源 |
| 渐进加载 | [Proxy injection](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryProxy/src/injection/index.ts#L347) | 稳定画像 + 场景索引，L0/L1 按需工具检索 |
| 中文和融合 | [SQLite 分词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/store/sqlite.ts#L167)、[RRF](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2ee22397f6091b8cd3ea847bc1edb04d3bec0c94/MemoryCore/src/core/store/search-utils.ts#L36) | 写入与查询一致分词；BM25 可本地运行，向量可选 |

不要照搬的部分：

- 腾讯也存在 dedup 失败后直接新增全部候选的 fallback；SomniQ 的已审阅知识应该留在 pending/deferred，不以可用性代替质量门槛。
- 腾讯 `shouldExtractL1` 中部分长度与安全检查实际被注释；不能只凭“strict quality gate”注释认为其过滤可靠。
- 当前腾讯工作模式已有 `work_fact/work_task/work_method/work_artifact`，不只有三种类型。旧重构文档的比较已不完整。
- “L0/L1 不自动注入”是本次核对的 Proxy 路径；其 OpenClaw 插件仍有动态 L1 召回。不能把一种接入路径当成整个项目的统一行为。
- 团队 ACL、独立 Hub/Proxy 部署不是 SomniQ 当前需要解决的问题。现有 `tencentdb_memory.rs` 只是可选 PostgreSQL 语义投影，并未集成腾讯上述记忆形成机制。

## 建议的目标架构

```text
Session / 用户确认 / 实验与工具结果 / 文献证据
  → 结构化 observation（本地，append-only，保留原始事件引用）
  → 场景窗口 + 已有相关事实 → Executor 产生候选
  → 独立 Reviewer：证据、采纳、用途、时效、重复、冲突
  → R1 原子事实（有版本、有作用域、有证据、有状态）
  → 按场景聚合并独立审阅 → R2 场景文档与目录
  → 明确用户确认的偏好/约束 → R3 稳定上下文

回答时：R3 + R2 目录 → memory_search / memory_read
  → 必要时 session_search / 原始证据 → 当前任务
```

R3 保留明确用户确认要求；不从科研内容或工具故障推断用户画像。科研论断进入已确认知识库仍使用现有证据/人工确认流程，记忆不能自行提升其权威级别。

建议 R1 类型保持小而清晰：`decision / constraint / finding / lesson / artifact_ref / preference`。临时动作和任务状态继续由 Session、Project Goal、Workflow Ledger 管理。类型不再决定层级或 TTL。

最小记录需要：`id`、`content_revision`、`entity_id`、`predicate`、`statement`、`kind`、`scope + scope_id`、`observed_at`、`valid_until`、`epistemic_status`、`evidence_refs[]`、`supersedes_ids[]`、`review_run_id`。证据引用包括 Session/event/block/span 或 artifact/run/page/anchor，保留多个来源；不能只用一个聊天句子的字符串冒充全部证据。

Reviewer 的结果按候选 ID 返回：`accept/reject/defer`，并分别记录 grounding、adoption、future_use、validity、novelty 和冲突目标。全新会话能否用这条信息减少一次检索、避免一个已验证的错误或保持一个已采纳决定，是价值判断的可审查依据。不能靠模型自报一个高分代替证据。

`memory_search` 返回摘要、状态、时间和短引用 ID；`memory_read` 展开场景及依据；`session_search` 查原始讨论。当前每条注入行附带长 hash、Session ID、事件列表，挤占 300/500/700 字符层预算，应将这些详细溯源放到按需展开中。

抽取、审阅、状态机、索引和聚合协议放在 `crates/runtime`，工具接口放在共享工具层；Desktop 负责调度适配、审查视图和可视化。不要再将核心流水线长期留在 Tauri 文件中使 CLI 无法复用。

## 重构顺序

1. **先修正确性，并建立基线。** 修候选错配、未生效即 supersede、事件 TTL；inline 降为待审 observation。固定真实问题样本，记录当前 recall 和用户可用性，保留所有原始来源。
2. **交付最小闭环。** 做一个场景窗口 → typed candidate → 独立价值/冲突审阅 → 原子事实的垂直链路。优先覆盖“研究问题改名”“建议未采纳”“约束跨会话继续有效”“旧构建结果不能充当当前状态”。先验证有用，再扩大提取范围。
3. **接上场景聚合和检索。** R2 文档带来源和版本；中文 BM25 全库索引；工具读取能恢复真实项目上下文。向量仍作为可替换的可选投影；远端故障时本地已审阅事实可用，远端同步状态与知识状态分离。
4. **缩减自动注入并迁移。** 小规模 canary 验证 memory_search 调用和新会话连续性后，将动态 R0/R1 转为按需读取，只常驻用户确认的稳定信息和有界目录。保留回退开关，实际测缓存命中，不预先承诺节省百分比。
5. **补管理视图。** 以有效事实、场景和待审冲突展示；可以查看证据、拒绝、纠正、撤销、过期和恢复。按 prompt version、模型、来源、审阅结果统计，而不是以“抓到多少条”衡量成功。

这调整了旧 `memory-refactor-plan.md` 的优先级：当前主要诉求是质量，不能把 BM25 和 token 优化放在修复准入与状态错误之前。原计划保留作历史记录，本报告作为新的审查建议。

## 旧数据怎么处理

- 备份并冻结 v2 为可追溯输入；以 generation/policy version 建新投影，在 shadow/observe 中重放。生产切换前展示差异，不直接清空历史。
- 保留现有用户确认规则；新建议未确认前不能取代它们。
- 根据原 Session 时间重算有效性；过期临时任务留在历史，不能靠回填续期。
- 重新读取原始讨论、用户采纳证据和产物引用。旧 atom 只是定位线索，不能作为新记忆的唯一证据。
- 对重复和矛盾生成明确的 merge/supersede/reject 建议；保留 rejected/archive 与原因。回滚只切换投影版本，不反向改写 Session。

## 验收标准（拟定目标，尚未达成）

- 用至少 50 个脱敏真实场景构建标注集，覆盖中英混合、建议/采纳、跨回合指代、事件时间、冲突、失败恢复、文献证据、空结果。保存来源引用和人工判断，不把用户私有对话提交到仓库。
- 候选抽取的可用率目标 ≥90%；同时单独测关键决定/约束召回率，避免靠“全部不记”得到高精度。
- 新会话恢复任务：关键已采纳决定和约束 top-5 recall 目标 ≥90%；过期事实、未确认 R3、跨项目串入和错误 supersede 在回归集上均为 0。
- 受控用例中，语义相同的重放不重复生成有效事实；互补事实不被粗糙 subject 覆盖；同一候选只消费绑定其版本的审核结果。
- 与无记忆和当前 v2 比较真实任务成功率、用户纠正次数、错误旧事实引用次数，并记录每个有效事实的生成成本、召回延迟、注入 token 和缓存命中。

35 个现有单测通过只能证明当前约定运行一致；其中部分测试还明确接受一次任务指令成为 R1、接受 inline 无审核激活。新验收应先重新定义这些约定，再实施重构。
