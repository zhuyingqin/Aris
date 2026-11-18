# 智能记忆 L2/L3 设计稿：从日志到常驻知识的晋升，以及决策模型的位置

状态：设计稿，未实现。日期：2026-10-21。
前置：`memory-l1-notes-design.md`（修订 5）。本稿只描述 L1 之上的两层；L1 的存储、补录、检索不在此重复。

---

## 0. 一句话结论

**L2/L3 不新建存储，沿用 `MEMORY.md`（项目常驻事实）与 `USER.md`（用户规矩与偏好）；新建的是一条"晋升管线"：从 L1 笔记里按信号挑候选 → 用一个只做判定、不写字的决策模型过门 → 条目文本直接取笔记原句、不生成 → 带审查凭证写入或进审批。** 决策模型第一版用已有的 reviewer 模型做封闭选择题；Jev 这类 System One 模型作为可选、显式授权的替换；每次判定与用户的批准/驳回都落成标签，攒够后再训练本地小模型。

---

## 1. 为什么这样分工

| 事实 | 来源 | 对设计的约束 |
|---|---|---|
| L2/L3 应是小而稳定、常驻注入的层；大而易变的层做成工具 | TencentDB 审查（`memory-refactor-plan.md` §1） | L2/L3 预算保持 2,200 / 1,375 字；增量只能靠"进一条、出一条" |
| OpenClaw 的 dreaming：规则门 → 评分 → 只有 Deep 阶段写 MEMORY.md；候选进短期暂存，`DREAMS.md` 做人审面 | [OpenClaw 文档](https://docs.openclaw.ai/concepts/memory-architecture) | 晋升是后台、分阶段、可解释（`promote-explain` 给每条候选的评分明细） |
| Claude Code Auto Dream：24 小时、≥5 会话后后台重写记忆目录，去重、删被推翻的、保持索引 ≤200 行；新鲜事实优先 | 社区复现 [i-doll/dream](https://github.com/i-doll/dream) | 整体重写是一个会改动用户手写条目的操作，必须有前像和可回滚 |
| Letta sleep-time：空闲时把原始上下文改写成"learned context"，测试时省 5× 算力 | [arXiv 2504.13171](https://arxiv.org/abs/2504.13171) | 晋升放在空闲时跑，不占回合 |
| Jev：只从预定义选项中选、给校准概率，不能生成句子；70–500 ms；$0.042/M 输入；分类 95.9% vs 关键词规则 77.2%，但 711 个工作流用例上与前沿模型一致率 67.8%，低于最强对照 74.1% | [Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))、[arXiv 2609.30216](https://arxiv.org/abs/2609.30216)、[TDS 评测](https://towardsdatascience.com/jev-vs-llms-when-ai-moves-from-generation-to-decision-making/) | 适合做"门"，不适合做"手"；不能替代人对复杂工作流的判断 |
| 0.6B–1.7B 的 Qwen3 经教师蒸馏后在记忆判定和分类上接近大模型，几百条样本就见效 | [arXiv 2609.23449](https://arxiv.org/abs/2609.23449)、[arXiv 2601.07469](https://arxiv.org/abs/2601.07469) | 本地小模型做判定在技术上可行，瓶颈是标签量 |
| L1 实测：952 个用户回合里自然发生的可用重学事件约 12–15 次 | `project_memory_l1_notes_plan` 记忆 | 晋升候选每项目每周只有个位数，标签积累慢；不要为训练而设计产品 |
| 产品原则：Executor 与 Reviewer 独立；外部动作显式可审 | `AGENTS.md` | 写笔记的模型不能自己批准晋升；Jev 是外部服务，须明确开关 |

---

## 2. 层定义（在 L1 设计 §2 之上）

| 层 | 内容 | 存储（不变） | 来源 | 信任标签 |
|---|---|---|---|---|
| L2 | 项目常驻事实：环境、路径、构建约定、已采纳的方法决定 | `MEMORY.md`（scope=project）；超长的程序性内容进 `~/.config/aris/memories/*.md`（已有，目录注入、正文按需读） | 晋升管线、用户、agent 手动 | `standing` 或 `reviewed` |
| L3 | 用户规矩与偏好：语言、风格、硬约束 | `USER.md`（scope=global 或 project） | **只能**经用户批准 | `standing` 或 `reviewed` |

**不进 L2/L3 的**：任务进度、当前里程碑、主线摘要（这些属于 Project Goal 状态，`project_goal.rs` 已注入，晋升门第一题就排除）；工具失败的原始记录（`[tool]` 行，只在失败触发召回里用）；读过外部内容的回合产出的笔记（`input:external`）。

**`reviewed` 的定义（兑现 L1 设计 §5.6 的承诺）**：条目的元数据里有一个 `review_id`，指向审查记录（§5），且记录里的判定模型与写出该笔记的模型不同族。没有记录的条目一律 `standing`。

---

## 3. 晋升管线

四步，前三步零生成。

```
L1 笔记（turn: 来源、无 input:external、kind ∈ decision|lesson|constraint|finding、未被 replaces）
  → ① 信号打分（确定性）
  → ② 决策门（封闭选择题；reviewer 模型 / Jev / 本地小模型）
  → ③ 组装（原句 + 元数据，不生成）
  → ④ 写入：L2 高置信直写，其余与所有 L3 进现有 pending 审批
  每一步都写审查记录
```

### 3.1 信号打分（零模型）

| 信号 | 怎么得到 | 为什么 |
|---|---|---|
| `reassert` | L1 去重返回 `duplicate` 的次数（索引表加 `reassert_count` 列，去重时 +1） | 跨会话被再次写下 = 持续成立 |
| `recall_adopted` | 失败触发召回命中该笔记、且模型下一步采用了它（L1 评估 M5 的同一判定，产品里由 runtime 记录） | 被用过且有效，是最强信号 |
| `stable_days` | 自记录日起未被 `replaces` 的天数 | 没被推翻 |
| `kind_w` | constraint 1.2、lesson 1.1、decision 1.0、finding 0.9 | 与 L1 检索权重一致 |

`score = kind_w × (1 + reassert + 2·recall_adopted) × min(1, stable_days/7)`。
候选阈值：`score ≥ 2`（即至少：被再次写下一次且稳定一周，或被召回采用一次且稳定一周）。阈值与权重放配置，设置页可看每条候选的分项（照 OpenClaw `promote-explain`）。

### 3.2 决策门：封闭选择题

对每条候选，先用 L1 的 trigram 检索在当前 `MEMORY.md`/`USER.md` 里取最相近的 3 条现有条目，然后问四道题。输入 ≈ 1 KB：候选原句、来源回合的 ≤600 字纯文本摘录（L1 补录的同一渲染器）、3 条现有条目。

| 题 | 选项 | 低置信时 |
|---|---|---|
| Q1 持久性 | `standing`（离开本会话仍成立且会改变做法）/ `task_state`（进度、里程碑、当前任务）/ `unsure` | 进审批 |
| Q2 归属 | `project_fact` → L2 / `user_rule` → L3 / `procedure` → 知识笔记文件 | 进审批 |
| Q3 与现有条目关系 | `new` / `duplicate_of:k` / `updates:k` / `contradicts:k` | `contradicts` 与低置信一律进审批 |
| Q4 采纳状态 | `user_adopted` / `assistant_proposed` / `unclear` | 非 `user_adopted` 的 decision 不晋升 [避 P30] |

**判定器接口**（`crates/runtime/src/memory_judge.rs`）：

```rust
pub trait MemoryJudge {
    fn name(&self) -> &str;                       // 写进审查记录
    fn decide(&self, q: &Question) -> Result<Decision, String>;
}
pub struct Question { pub prompt: String, pub choices: Vec<String>, pub context: String }
pub struct Decision { pub choice: String, pub probabilities: Vec<(String, f32)>, pub raw: String }
```

三种实现，按配置选，失败降级到下一个：

| 实现 | 第一版 | 置信来源 | 数据去向 | 成本/延迟 |
|---|---|---|---|---|
| `ReviewerJudge` | **默认** | 要求 JSON `{"choice":…, "confidence":0–1}`；自报置信，不校准 | 用户已配置的网关 | 每题 ≈1.2K 输入 token；四题合一次调用 |
| `JevJudge` | 可选，`memory_judge: "jev"` + 显式确认"候选文本将发送到 TypeSafe" | 模型给的校准概率 | TypeSafe 云端 | ≈$0.00005/候选；70–500 ms |
| `LocalJudge` | 后期 | 本地微调模型的 softmax | 不出进程 | 0 |

独立性：`ReviewerJudge` 用 `reviewer_model`，与写笔记的 `executor_model` 不同族（评估里已是 deepseek 写、MiniMax 审）。同族时审查记录标 `independent:false`，条目只能拿 `standing`。

### 3.3 组装：不生成

- 条目文本 = 候选笔记的 statement 原句（≤500 字，L1 已限）。超过 L2 单条 300 字时按 Q2=`procedure` 走知识笔记文件，`MEMORY.md` 只放一行标题。
- `updates:k` → 走 `replace_hot_memory(old=k)`；`duplicate_of:k` → 不写，给 k 的审查记录加一次 `reassert`。
- 元数据：`source = promote:<note_id>`、`review_id`、`turn:` 指针照抄、`created_at`。`HotMemoryEntry` 加可选字段 `review_id`、`note_id`。
- 需要改写句子的情况（合并多条、缩短）不在管线里做；它只会出现在 §6 的"整理"操作，那是另一个带前像、需审批的流程。

### 3.4 写入与审批

| 目标 | 条件 | 动作 |
|---|---|---|
| L2 直写 | Q1=standing、Q2=project_fact、Q3∈{new, updates}、Q4=user_adopted，四题置信都 ≥ τ（默认 0.85），`independent:true` | `add/replace_hot_memory`，标 `reviewed` |
| L2 审批 | 其余 | 进现有 pending，条目预填 `review_id`；用户批准后标 `reviewed`（审查已做，人只是最终确认） |
| L3 | 全部 | **一律**进 pending；用户批准后标 `reviewed`。不存在自动写 `USER.md` 的路径 |
| 驳回 | Q1=task_state 或 Q4=assistant_proposed | 不写；审查记录保留；该笔记 30 天内不再成为候选 |

`memory_write_approval` 关闭时：L2 直写条件不变，L2 审批类降为**不写**（不是直写），L3 仍不写。关闭审批不会放宽门。

---

## 4. 触发与成本

- 触发：项目空闲 ≥ 30 分钟且自上次运行后 L1 新增 ≥ 20 行，或每 24 小时一次；设置页可手动"整理候选"。不在回合内跑。
- 每次运行：候选数通常 0–5；每候选一次判定调用（`ReviewerJudge`）或四次 Jev 调用。按 L1 实测的重学频率，一个活跃项目每周几条，成本可忽略。
- 并发：与 L1 补录共用项目锁；运行中写入 `MEMORY.md` 的其他路径（用户手改、agent 工具）会让本次运行丢弃其结果重来（同 Claude Code dream 的"live session changed → drop"）。

---

## 5. 审查记录

`<config>/memory/reviews/<project_id>/YYYY-MM.jsonl`，追加写：

```json
{"review_id":"r_7k3m2p9q4w","at":"2026-10-21T09:12:03Z","note_id":"n_8k2dq5v6zx","turn":"turn-…-12",
 "score":{"reassert":2,"recall_adopted":0,"stable_days":9,"total":3.3},
 "judge":"reviewer:MiniMax-M3.1-Flash","independent":true,
 "q1":{"choice":"standing","p":0.93},"q2":{"choice":"project_fact","p":0.97},
 "q3":{"choice":"new","p":0.88,"neighbors":["mem-52840a2fd3fbd2b3"]},"q4":{"choice":"user_adopted","p":0.71},
 "outcome":"pending","human":null}
```

`human` 在用户批准/驳回时回填 `{"decision":"approve|reject","at":…}`。这个文件同时是：审查凭证（`reviewed` 的依据）、设置页"为什么晋升/为什么没晋升"的解释来源、以及 §7 的训练数据。

---

## 6. 预算、淘汰与整理

- `MEMORY.md` 满 2,200 字时，晋升前先淘汰一条：顺序 = 已过期 → 被 `updates` 取代 → `source=promote:*` 且 `reassert=0`、`recall_adopted=0`、最旧的。**用户手写或用户批准的条目不自动淘汰**；淘汰不删文件内容，条目移到 `memory/standing-archive/<project>.md`。
- "整理"（合并、缩写、重组）是会改写句子的操作：用 executor 模型对整个 `MEMORY.md` 出一份新稿，写前像到 `reviews/`，以 pending 形式整份呈给用户，批准才替换。默认不自动触发；设置页按钮。这是 Claude Code Auto Dream 做的事，但这里永远是人批。

---

## 7. 决策模型的后续路线：先攒标签，再训练

| 阶段 | 做什么 | 进入条件 |
|---|---|---|
| 7.0 | §5 的审查记录从第一天起就带四题的选择、概率、人工回填 | 随 §3 上线 |
| 7.1 | 离线对照：同一批候选分别跑 `ReviewerJudge` 与 `JevJudge`，与人工回填比一致率、校准（概率分桶 vs 实际批准率） | 人工回填 ≥ 100 条 |
| 7.2 | 本地判定器：以人工回填为标签、以 reviewer/Jev 的选择为教师信号，微调 Qwen3-0.6B 或 1.7B（LlamaFactory，LoRA，四题各一个分类头或统一指令格式）；GGUF 经 llama.cpp 或 ONNX 本地推理 | 人工回填 ≥ 500 条，且 7.1 显示判定器与人工一致率 < 90% |
| 7.3 | `LocalJudge` 作为默认，Reviewer/Jev 作为低置信时的二审 | 7.2 在留出集上一致率 ≥ 当前默认判定器 |

按 L1 实测的候选频率，单个用户一年很难攒到 500 条；7.2 现实上要等多用户（本地标签可选择性共享）或先用 7.1 的教师标签做半监督。**所以本期只做 7.0**，训练不是设计前提。

---

## 8. 注入面的变化

L1 设计 §8 的块不变，只在每条 L2/L3 条目前加标签：

```
# MEMORY (standing project facts) [n/2200 chars]
- [reviewed] Final/main.tex 整本编译约 5 分钟；中途中断会损坏 main.aux…
- [standing] 大论文核心叙事上抬到 RC 而非 ESN…
```

提示词里说明两者区别：`reviewed` 有独立判定与来源可查，`standing` 是用户或 agent 直接写的。

---

## 9. 设置页

在 L1 设计 §12 的"常驻"区块里加：候选列表（分项评分、四题结果、置信、邻居条目）、"为什么没晋升"、审查记录查看、判定器选择（reviewer / jev / local）与 Jev 的数据外发确认、"整理"按钮、淘汰归档查看。

---

## 10. 评估

| 指标 | 怎么量 | 通过线 |
|---|---|---|
| 晋升精度 | 直写与审批通过的条目，人工按"离开会话仍成立、会改变做法、不是任务状态"判 | ≥ 85% |
| 门的一致率 | 判定器四题 vs 人工回填 | ≥ 80%，`contradicts` 的召回 ≥ 90% |
| 校准 | Jev/Reviewer 置信分桶 vs 实际批准率 | 报告 |
| 不该晋升的 | 任务状态、助手建议、外部输入回合的笔记进入 L2 | 0 |
| 注入块变化 | 每周 `MEMORY.md` 变化次数与字节 | 报告，与 L1 §18 的缓存指标一起看 |
| 成本 | 每项目每周判定调用数与 token | 报告 |

标签来源：`F:\Agent\memory-l1-eval` 里的 9 条标准笔记与 14 条反例先做冷启动集；真实标签来自 §5 的人工回填。

---

## 11. 实施阶段（在 L1 阶段 C 之后）

| 阶段 | 内容 | 估时 |
|---|---|---|
| D1 | `reassert_count`、`recall_adopted` 记录；信号打分；审查记录文件；`HotMemoryEntry.review_id/note_id` | 1 天 |
| D2 | `MemoryJudge` trait + `ReviewerJudge`；四题提示词；写入与审批路径；淘汰 | 1.5 天 |
| D3 | 设置页候选/解释/审查记录；注入标签 | 1 天 |
| D4 | `JevJudge`（可选，需 API 访问）；7.1 离线对照脚本 | 0.5 天 + 等访问 |
| 7.2 以后 | 本地判定器 | 等标签 |

---

## 12. 不做什么

- 不生成条目文本（除 §6 的人批"整理"）；不做 TencentDB 式 L2 文件树；不做跨项目/团队共享。
- 不让 Jev 或任何判定器写 `USER.md`。
- 不为训练改产品流程：标签只来自本来就要发生的判定和审批。
- 不在本期做本地小模型；只留接口与标签。

## 13. 风险

1. **候选太少**：按 L1 实测，一个项目每周个位数；这意味着 L2 增长慢，但也意味着门的成本可以忽略。候选不足不是失败，`MEMORY.md` 本来就该小。
2. **自报置信不校准**：`ReviewerJudge` 的 confidence 只是一个数；τ=0.85 在 7.1 对照前只是起点，审批路径兜底。
3. **Jev 访问与条款**：限量开放、专有、云端；若不可得，设计不受影响（默认不是它）。
4. **Q4 的证据不足**：候选只带 ≤600 字摘录，"用户是否采纳"有时在别的回合；低置信走审批即可。
5. **整理操作改写用户条目**：永远人批、有前像；不自动触发。
