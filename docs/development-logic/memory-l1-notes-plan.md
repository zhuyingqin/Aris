# 智能记忆第一层（L1）重做方案：回合笔记 + 原始历史检索

日期：2026-10-20。范围：替换 `research_memory_v2` 的 R1 层（抽取 → 独立审查 → 晋升 → 按配额注入）。
这是一份方案，不是已落地的实现；本文件未改动任何生产代码。
**完整设计稿（接口、schema、提示词、迁移、测试）见 `memory-l1-notes-design.md`，以修订 4 的协议与预算规则为准；本文件保留论证与外部证据，§3–§7 已与修订 4 对齐。**

## 0. 一句话结论

**L1 不再是"从对话里抽出来的原子"，而是 agent 自己写的、按日追加的笔记文件；读取不再是每轮注入，而是对"笔记 + 原始 Session"做一次强检索的工具。** 回合内写入不增加模型调用；补录在后台按已结束回合数限次（每 10 个回合最多 1 次请求），失败也计数，且不命中前缀缓存、按无缓存计费（详见设计稿 §5.3），读取由模型按需发起。TencentDB 的 L0–L3 分层保留为概念，但第一层的实现从"数据库行 + 状态机"改成"文件 + 索引"。

## 1. 已经踩过的坑（编号供后文引用）

来源：`memory-quality-review-2026-09-06.md`、`memory-refactor-plan.md` 与各次实测记录。

| # | 坑 | 根因一句话 |
|---|---|---|
| P1 | 每轮注入 6,000 字符随查询变化的块 | 放在系统提示末尾只保住前面的指令，后面整段对话历史的 prefix cache 全失效 |
| P2 | 每条存活 atom ≈5,285 输入 token | 抽取 + 每候选一次审查；且每次调用预置 10.6 KB 的 research-review 技能 |
| P3 | 前置过滤 60% 误杀 | user+assistant 拼成一个 blob 判；ASCII 裸子串（table 命中 immutable） |
| P4 | 抽取器 90% 回合返回零候选 | 提示词自相矛盾（R1 是任务记忆，又禁止任务指令） |
| P5 | 审查者按抽取器的私有 `reason` 否决 | 审查输入泄漏了不该审的字段 |
| P6 | 一条坏候选连累整批，重试烧光 10 次 | `validate_extraction(...)?` 整批中断 |
| P7 | 正常凝练被 grounding 拒绝 | 要求 statement 是 quote 的子串 |
| P8 | 工具失败从未进过管道 | 捕获只留 Text 块，`clean_capture_text` 又剥代码块 |
| P9 | bash 失败只截到一行 null | 16 键 JSON 信封，stderr 被埋 |
| P10 | kind 爆炸：63 种、59 种只用一次；R2 至今 41 种 | 自由 snake_case，无汇聚 |
| P11 | R1 一半是任务复述 | 存在"当前任务"这种类型；对话里免费的东西又买一遍 |
| P12 | 锚点启发式砍掉最有价值的纯中文条目 | 要求含路径/数字/latin token |
| P13 | supersede 误杀：待确认 R3 把已确认规则废掉；所有 read_file finding 共用一个 subject 互相覆盖 | 主题键粒度错 + 未生效即 supersede |
| P14 | 候选过滤后 `zip` 错配，审核结论贴到别的候选上 | 按位置而非 ID 关联 |
| P15 | 回填让 7 月的一次性任务"有效到 10 月" | `expires_at` 用当前时钟 |
| P16 | milestone 困在原 Session，新会话查"知识迁移"为空 | R1 强制 `session_id` 相同 |
| P17 | 召回=最近 100 行 + 子串计数；中文停用词表全废（单字 vs 二字组）；alias 抬门槛 | 无 IDF、无分词、先裁后过滤 |
| P18 | 主题键：474 条 474 键，硬编码词表 0 命中；CJK n-gram 主题全是功能词 | 想从语料里"抽主题"，而不是"做匹配" |
| P19 | 评估路径断：JS 镜像与 Rust 失同步、无 precision/recall、无标注集 | 两份逻辑 |
| P20 | 设置页冻 42 秒 | 同步命令占主线程 + 状态查询顺手重建索引 |
| P21 | 先关旧路径再建替代品，92% 覆盖丢失 | 顺序反了 |
| P22 | "读另一个文件成功"被判成"失败已恢复" | episode 只看同名工具，不看目标资源 |
| P23 | 重筛漏掉最该重跑的批次；重抽被 `INSERT OR IGNORE` 吞掉 | 状态机与确定性 ID 的组合 |
| P24 | v1/v3/v4 三代混装，kind 语义跨版本不可比 | 抽取器版本漂移 |
| P25 | 吞吐 1 条/分钟，UI 只有一个不动的"队列 N" | 无进度面 |
| P26 | 调抽取行为要重编译 | 提示词是 Rust const |
| P27 | 注入行带长 hash、Session ID、事件列表，挤占 300/500/700 预算；截断是唯一杠杆 | 把 SQLite 行塞进字符配额 |
| P28 | 单测写穿清空真实项目注册表 | 测试没有注入 seam |
| P29 | 层级实际上只是 TTL 标签 | 一个回合直接定层，没有 L1→L2 聚合 |
| P30 | 助手"建议"被记成"决定" | assistant 来源的候选无法区分建议与采纳 |

## 2. 外部证据（2026 年）

1. **抽取式记忆整体上不优于对原始历史做检索。** [arXiv 2610.24671](https://arxiv.org/abs/2610.24671)：6 个显式记忆系统 vs raw-history RAG，LongMemEval-S 与 BEAM-100K，无一致优势；部分系统在构建时丢掉答案；检索是瓶颈。[arXiv 2607.29104](https://arxiv.org/abs/2607.29104)：相同检索深度下对原始回合的朴素 RAG 通常更准；只换检索器准确率 58.1% → 75.5%。
2. **Mem0 在 2026-04 废掉了 UPDATE/DELETE。** [README](https://github.com/mem0ai/mem0)："Single-pass ADD-only extraction — one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten." 检索改为语义 + BM25 + 实体并行融合。LoCoMo 71.4 → 92.5。
3. **文件夹就是记忆。** Anthropic memory tool 是模型用 view/create/str_replace/insert/delete 编辑的目录；按 [Jake Cuth 汇总](https://www.jakecuth.com/work/agent-memory-lab/)（二手），纯文件系统 agent LoCoMo 74.0%，高于 Mem0 图变体 68.5%。
4. **三个主流 agent 收敛到同一形态：** [OpenClaw](https://docs.openclaw.ai/concepts/memory)（`memory/YYYY-MM-DD.md` + 精选 `MEMORY.md`；今昨两天自动加载，更早的只进 FTS5+sqlite-vec 索引；压缩前静默回合追加写、拒绝整段重放；后台 dreaming 蒸馏）、[Hermes](https://hermes-agent.ai/how-to/set-up-hermes-memory)（MEMORY.md 2,200 字 + USER.md 1,375 字，agent 自写，会话内冻结保 prefix cache）、[Claude Code](https://code.claude.com/docs/en/memory)（一事一文件 + 索引常驻、正文按需读）。
5. **agent 场景笔记仍有价值。** [LongMemEval-V2](https://arxiv.org/abs/2605.12493)：最强 RAG 48.5%，轨迹当文件交给 coding agent 72.5%。所以是"原始历史 + 轻量笔记，都用强检索"。

共同点：**写得便宜且只追加，读得强。** v2 建成了相反的东西，后面所有修补都是在错的架构里优化。

## 3. 设计（逐项带 why 与避开的坑）

版本边界：本节到 §7 已按设计稿修订 4（2026-10-21）更新；接口、schema、参数与测试以设计稿为准，这里只保留决定和理由。早期稿里的 `memory/projects/<id>/notes/` 路径、`← session:x#n` 来源、"压缩前补录、上下文已在缓存里"等说法均已作废。

### 3.1 笔记文件

```
<SomniQ config>/memory/notes/<project_id>/YYYY-MM-DD.md
```

行格式（设计稿 §4.2）：

```
- 14:32 [lesson] Final/main.tex 整本编译约 5 分钟；中途中断会损坏 main.aux，删 .aux/.toc/.bbl 后重编 ← turn:turn-7f3a…-12 tool:toolu_01Ab ^n_ak2df6m7qp
- 14:40 [decision] 第五章标题从 "ESN" 上抬为 "RC"，用户确认 ← turn:turn-7f3a…-13 ^n_bq3x5v2k7r replaces:n_dm7c2q5v6z
- 15:02 [tool] bash: ls Final\\Ch2\\ 失败(exit 2) → ls Final/Ch2/ 成功 ← turn:turn-7f3a…-15 tool:toolu_01Cd ^n_cp5z6mtv4w
```

| 决定 | 为什么 | 避开 |
|---|---|---|
| 按项目一个目录，文件名即记录日期；事件日期另放 `observed:` | 隔离靠目录，时间靠文件名；两个日期分开，回填不会改写任何一个 | 跨项目串入（default 注入私人事实）；P15 |
| 一行一条，纯文本 | 人能直接改，git 能 diff，索引可重建 | P27（行塞配额）、P23（状态机） |
| `[kind]` 建议 `decision/lesson/constraint/finding/tool`，**不校验、不拒绝** | kind 只用于显示和检索加权，错标的代价是权重差一点，不是丢数据 | P10、P12（机械校验砍掉好条目） |
| **没有"任务/进度"类 kind**，提示词明写反例；写了也只降权 | 在做什么本来就在对话里 | P11 |
| 来源 `← turn:<audit_turn_id>[ tool:<tool_use_id>]` 必填，注入时剥掉、搜索结果保留 | 消息下标压缩后会漂移，回合 ID 不会；`turn:` 能从恢复后的 Session（含压缩归档）取回原文 | P27 |
| 稳定 `^note_id`（项目内唯一）+ 可选 `replaces:` | 纠正关系可识别，检索时读时投影，不改旧行 | P13 |
| **只追加，机器永不改旧行** | 矛盾用新行 `replaces` 旧行来表达，检索时被替代的旧行带出修正。Mem0 2026 与 OpenClaw 都只追加 | P13、P14、P23 |
| 没有 subject 键、supersede 状态、TTL、scope=session | 项目级，任何会话都能搜到；"过期"由检索半衰期处理，不硬删 | P16、P18、P29、P15 |
| 今昨两天内同文本、同 `replaces` 不重复写 | 精确去重足够，语义去重交给 MMR | 审查发现的 4 组全同文本 |

### 3.2 写入：三条路径，都不经过"审查者"

**为什么没有审查者**：L1 定位为低信任日志——错误以 `note` 暴露、可追加修正、每行带证据指针、不能自动升级为常驻规则。独立审查原则保留在晋升到 MEMORY/USER 的那一步（设计稿 §5.6）。P5、P7、P14、P30 全是审查链路自己制造的。

**(a) agent 当场写** — `memory(action:"add", target:"note", content, kind?, replaces?, evidence?)`，追加一行。

- 系统提示（放 `assets/prompts/`，不放 Rust const，避开 P26）只讲三种该写的时刻：工具失败后找到的正确路径；用户做出或纠正的决定；发现的环境事实。唯一准入判据写在提示词里："在看不到本次对话的新会话里，这句话还成立、还改变行为吗？"反例列出：任务进度、正在做什么、复述用户要求。
- 不设审批门：note 不是规矩，只是可搜索的记录；误写一行的代价被检索权重和半衰期稀释。USER.md/MEMORY.md 继续走现有 pending 审批。
- 回合身份已经有了：`ToolRunContext` 已带 `session_id`/`turn_id`，Desktop 已填入；来源由代码填写，不由模型编。还需要给 `ConversationMessage` 加 `turn_id`，让 `turn:` 能回查到消息（设计稿 §5.2）。

**(b) 后台补录** — 每会话请求数 ≤ ⌈已结束回合数 / 10⌉，失败也计数（设计稿 §5.3）。

- 触发：回合结束后待补录 ≥10 个回合；或会话最后一个回合结束 ≥10 分钟且待补录 ≥3（不论会话是否在前台）；或应用启动时补扫最近 7 天的会话。会话切换和退出不发请求——退出时请求多半被杀，仍要计次。
- 不挂在压缩上：压缩归档保留被移出的原文，补录不必抢在压缩前；runtime 内部还有三条压缩路径不经过 Desktop 回合前的压缩检查。
- 输入：源回合渲染成有界纯文本（单回合 ≤1,600、单批 ≤16,000 估算 token；失败调用和恢复调用带输出摘要，成功调用只占一行），不发结构化工具块。用对话模型、不带工具、取最低推理档，`max_tokens` 4,096。
- 成本：补录请求的工具列表和指令都与对话不同，**命不中前缀缓存**，按无缓存计，单次输入 ≤ 约 19,000 估算 token。早期稿"用对话模型、上下文已在缓存里、增量成本只有指令加输出"的说法不成立，已撤回。
- 代码侧的拒绝规则（不是模型侧）：每行必须引用本批的回合 `@tN`；与现有行精确重复丢弃；超过 8 行截断；**逐行处理，一行坏不影响其他行**（P6）。
- 游标只在完整处理后推进；同一批反复截断或反复出坏行时部分推进，游标不会永久停滞。
- 模型看的是含工具信息的回合摘要，不再经过 `final_assistant_memory_source`/`clean_capture_text`（P8）。

**(c) 确定性工具 episode** — 零 token。

- 保留 `tool_episodes_for_turn` 的三条约束（只认已恢复、恢复须同一工具、同参数重试算 flake）。
- 新增第四条：恢复调用的目标资源必须与失败调用相同（path 或命令的首个路径参数），避开 P22。
- 保留 `tool_output_digest` 的字段优先级抽取（P9）。
- 写成 `[tool]` 行，带失败调用的 `tool:` 来源，权重最低；它是观察，不是结论，不进 MEMORY.md。

### 3.3 读取：一个工具，不注入旧 recall 块

**索引**：复用每项目的 `session-index.sqlite3`（schema 升到 v3），新增 `notes_lines/notes_fts` 与 `session_chunks/session_chunks_fts`，FTS 用 `tokenize='trigram'`（设计稿 §6.1）。索引只做搜索，不做证据；删了可以重建。

| 决定 | 为什么 | 避开 |
|---|---|---|
| `trigram` 分词器 | rusqlite 0.32 bundled 的 SQLite 3.46 自带；不需要分词器、停用词表、alias。它只做匹配，不抽主题 | P17、P18 |
| 查询预处理：每个词项加引号；CJK 段拆成三元组 OR；少于 3 字的词走 LIKE | 裸短语是整句匹配（零命中）、`main.aux` 不加引号报语法错、两字词 trigram 命不中，内存 SQLite 都复现过 | P17 |
| 两字词是中文常态，LIKE 会常走：`session_chunks` 上限定时间窗与扫描上限，验收 p95 ≤300 ms，不达标先加 CJK 二元组影子列 | 少于 3 字的 LIKE 用不上 trigram 索引，只能逐行扫 | P20 |
| 覆盖率按查询词计；工具描述让模型写 2–5 个关键词，不写整句 | 按三元组计会让一个长词压过其他词 | — |
| 全库候选，再过滤再排序 | 先裁后过滤是 P17 的一半 | P17 |
| Session 消息按 ≈400 token 切块，工具结果不入块 | 论文项目 207 个 Session 共 3 GB，整条消息做命中单元太粗 | 新 |
| 笔记与历史各自按 bm25 排名后 RRF 融合 → 时间衰减 `max(0.1, 0.5^(天数/30))` × kind 权重 × 修正权重 → 归一 → MMR λ=0.7 → top 6，每条 ≤700 字符 | 两张表的 bm25 不可比；新的排前、近重复合并、噪音行自然沉底 | P13 的替代（矛盾靠排序不靠删除） |
| 被 `replaces` 的旧行仍可命中，但带 `superseded_by` 附上新行 | 读时投影，不改文件 | P13 |
| MEMORY.md 不衰减 | 常驻层不是日记 | — |
| 空结果合法 | 不用最新几条填满 | 审查第 7 条 |
| 向量留缝不做 | `message_embeddings` + RRF 已在；网关今天没有 embedding 模型 | — |
| 命令全部 async + `spawn_blocking`；重建只由 `spawn_session_index_repair` 承担；状态查询纯只读 | — | P20 |

**工具**：`memory_search(query, days?, kind?, scope?)` 返回 `notes/2026-10-20.md:14` 或 `session:x turn:…` 形式的来源；`memory_get(path, lines?)` 读上下文；`session_search` 保留做 R0，并新增 `turn_id` 参数取证据原文。描述文案照 `session_search` 的体例写，结果包在"不可信数据"框架里。

**注入**：系统提示里的记忆块 = `MEMORY.md` + `USER.md`（已有预算）+ 本项目**今天和昨天**的笔记（剥掉来源，上限 1,500 字符，超出丢最旧的行）。快照按"会话 × 本地日"取一次并随会话持久化，同一会话同一天内逐字不变，重启后也一样（P1）。由 engine 把快照传给提示词构建函数，缓存键加快照哈希。MEMORY/USER 本期不冻结，写入生效后提示词随之变化。切到新注入后，删除 `builtin_research_recall_prompt` 调用和 6,000 字符渲染器；R0 的 session hits 也不注入（`session_search` 已能取，不付两次钱）。

**顺序**（P21）：注入块由 `memory_recall_block: legacy_v2 | notes | off` 三选一，阶段 A/B 默认仍是 `legacy_v2`；三方案对比通过后才切默认（§5）。flag 保留一个版本可回退。

### 3.4 晋升（L2/L3，不在本方案内）

后台 dreaming：每周或空闲时读最近 14 天笔记，提出对 `MEMORY.md` 的 add/replace/remove，进现有 pending 审批。等 L1 跑稳、笔记量够了再做。R3 的用户确认门保留在那一层。

## 4. 迁移

1. 阶段 A/B 不动 v2。三方案对比通过后，`memory_v2_mode` 默认改为 `legacy_r0_only`，不再 spawn outbox drain；v2 store 只读保留（设置页溯源仍可用）。
2. 导出 v2 `active` 的 R1/R2/R3（本机 123 条）到 `notes/<导出日>-legacy-v2.md`，每行带 `observed:<原 occurred_at 日期>`，来源为 `legacy:<session_id>#<index>/<atom_id>`。文件日期是记录日期，事件日期放 `observed`（P15）。`superseded`/`archived_legacy_kind` 不导出。验证阶段先导出到评估副本，阶段 C 才写真实目录。
3. 不迁 v1（P24）。hot-memory 不动。
4. 设置页：三张层卡片改为"笔记（按日）/ 常驻（MEMORY/USER）/ 索引与补录"；显示补录配额、游标、部分推进批次与暂停原因（P25）；"补录历史记忆""重新筛查"按钮下线。
5. 笔记读写、索引、flush 提示词放 `crates/runtime`；工具规格放 `crates/tools`；Desktop 只做调度与视图。

## 5. 验收（可度量，不靠"抓到多少条"）

- RECENT NOTES 块在同一会话、同一本地日内逐字不变（含重启）；用 `usage-log.jsonl` 对比缓存命中率前后，只报告。
- 每回合 0 次额外模型调用；每会话补录请求 ≤ ⌈已结束回合数 / 10⌉，失败也计入。
- 标注集 50 题分两组：A 组取自灰度期，测笔记增益；B 组取自 v2 捕获与之前 30 天，测迁移与历史检索。评估前在副本里先跑 v2 导出。检索层（无模型）报 recall@5/precision@5、证据正确与 p95 延迟；端到端层（新会话真实提问）报正确率、旧结论误用与每题 token。对比现有实现 X0、纯历史 X1、历史加笔记 X2；评估跑**同一份 Rust 逻辑**，不写 JS 镜像（P19）。
- 切默认的条件：A 组 X2 不低于 X1，B 组 X2 不低于 X0，旧结论误用 = 0，token 不高于 X0（设计稿 §18）。
- 回归集：中文查询不再零命中；过期任务不被注入；跨项目不串；legacy 导出行的 `observed` 等于原事件日期。
- 测试用注入 seam 写临时目录（P28）。

## 6. 工作量

- 阶段 A（2 天）：Session 回合归属与规范事件、`NoteId` 与统一追加入口、trigram 索引与查询规则、`memory` 工具 `note` 目标、`memory_search` / `memory_get` / `session_search(turn_id)`。
- 阶段 B（1.5 天）：后台补录（有界渲染、按回合配额、三种触发）、提示词、今昨笔记注入与快照持久化（flag 控制）。
- 验证（1 周，主要是等数据）：灰度、评估副本导出、两层三方案对比。
- 阶段 C（1 天）：切默认、v2 导出、设置页。

## 7. 不做什么

- 不做 subject 键、supersede 状态、TTL、候选状态机；不做"审查者"写入门禁。
- 不先做向量：BM25(trigram) 加查询规则先跑，网关今天也没有 embedding 模型；缝留着。
- 不照搬 TencentDB 的 L2 文件树和 persona.md：那是 L2/L3 的事，先把 L1 跑通。
