# Agent 长期记忆：业界架构调研（2026-11-22）

方法：只采一手资料（官方文档、GitHub 源码/README、arXiv 原文），2026-11-22 抓取。没找到一手依据的标"未核实"。方括号数字对应文末来源。

## 1 总表

| 系统 | 谁写 | 何时写 | 存储形态 | 检索 | 送达 | 整理/失效 | 来源 |
|---|---|---|---|---|---|---|---|
| Claude Code | CLAUDE.md 人写；auto memory 由主 Agent 自写（CHANGELOG 另有后台 "memory extraction"） | 会话中，Claude 自判"以后有用"才写；跳过可由代码推出的内容 | `~/.claude/projects/<repo>/memory/`：MEMORY.md 索引（一行一条）+ 每条一个主题文件，frontmatter 含 type（user/feedback/project/reference）和 modified 时间戳 | 文件工具按需读；CHANGELOG 显示有副模型（默认 Sonnet）做 memory recall | CLAUDE.md 启动全量注入；MEMORY.md 只注入前 200 行或 25KB；主题文件、子目录 CLAUDE.md 按需加载 | 索引超限时报错，要求 Claude 重写；"Auto Dream" 只见于第三方博客，官方文档和 CHANGELOG 均无此名，**未核实** | [1][2] |
| Claude API memory tool | Claude 自写 | 任务中；API 自动加系统提示"先 view 记忆目录" | 客户端自管 `/memories` 文件（view/create/str_replace/insert/delete/rename） | 目录浏览 + 读文件 | 工具 | 无内置整理；文档建议删除久未访问的文件；context editing `clear_tool_uses` 默认在 10 万输入 token 时触发 | [3][4] |
| Codex CLI | 后台 LLM，两阶段 | 根会话启动时异步跑；只取空闲 ≥6h、≤10 天的会话，每次 ≤2 个；配额剩余 <25% 时跳过；默认关闭 | 阶段 1 把每个会话抽成 raw_memory + rollout_summary 存 SQLite；阶段 2 写到 git 基线目录 `~/.codex/memories(_v2)`：memory_summary.md、rollout_summaries/ | `memories.search` 做字面子串匹配（any / all-within-lines），按路径排序，没有 BM25 或向量 | memory_summary.md 截到 2,500 token 注入 developer 指令；细节按需读；用过的记忆要附 `<oai-mem-citation>` 引用 | 阶段 2 由整理子 agent（无网络、不需审批）读 git diff 改写 summary；按被引用次数和最近使用取 top 256，30 天未用即淘汰；用户说"记住/忘记"只写 ad_hoc 笔记，留待整理时应用 | [5][6][7] |
| Codex AGENTS.md | 人写 | — | 全局 1 个 + 从项目根走到 cwd，每层取 1 个 | — | 启动时拼接注入，上限 32 KiB | — | [7] |
| Kimi Code CLI | 人写 AGENTS.md | — | `.kimi/AGENTS.md` + AGENTS.md，根→叶拼接，32 KiB 预算先留给深层文件 | — | 注入 | 只有会话内压缩：上下文达 85% 或剩余不足 5 万 token 时触发；压缩后提示模型去查会话事件日志。源码树中**未发现**跨会话记忆模块 | [8][9] |
| Kimi 应用 | 后台 | 2026-10 起：新会话开启后整理过往会话 | "记忆空间"（文件）+ 过往会话 | 未公开 | 相关时引用，回答末尾显示引用标识 | 用户可删改；不保存证件号等敏感信息 | [10] |
| Mem0（2026-04 新算法） | 后台 LLM，单次调用 | 每次 `add()` | 向量库 + 实体链接 | 语义、BM25、实体三路并行打分后融合 | 应用侧检索后注入 | 只 ADD，不 UPDATE/DELETE，新旧事实并存；"哪条是当前事实"交给检索期的时间推理 | [11][12] |
| Letta（MemFS） | Agent 自写 + 后台 dreaming 子 agent | 会话中；dreaming 每 N 步（示例 25）或压缩时触发 | git 版本化的 Markdown；`system/` 下的文件每轮都在系统提示里，其余只给文件树 | 默认无向量索引，用文件搜索；可装 mod 做关键词或混合检索；对话历史单独全文检索 | 注入 + 工具 | dreaming 合并教训；旧版 MemGPT 分 core / recall / archival 三层，由 sleep-time agent 独占编辑权 | [13][14] |
| Zep / Graphiti | 后台 LLM 抽实体和边 | 每个 episode 摄入时 | 时态图：episode（原文）→ 实体 → 事实边；双时态，分别记事件时间和摄入时间 | 余弦 + BM25 + BFS，再做重排 | 应用侧检索后注入 | 新边与语义相近的旧边比对，冲突时把旧边置为失效，不删除 | [15][16] |
| A-MEM | 写入时由 LLM 生成笔记属性 | 每次 add | ChromaDB 存笔记 + 链接 | 向量 | 应用 | 新笔记会反过来改写旧笔记的属性和链接（"记忆演化"） | [17] |
| MemOS | 后台 | 任务成功后保留经验（插件模式） | MemCube，分明文、激活（KV）、参数三类，带溯源和版本 | 混合（FTS5 + 向量） | 任务前自动召回 | 去重；可在三类之间迁移 | [18] |
| LangMem | Agent 热路径工具，或后台 memory manager | 对话中，或延后在后台处理 | LangGraph BaseStore，分语义、情景、程序三类（程序类即 prompt 优化） | store 搜索 | 工具 / 注入 | manager 负责抽取和合并更新 | [19] |
| Cognee | 后台 cognify（可用本地 GLiNER 抽取） | 调用 remember 时 | 知识图谱 + 向量块 | 自动在图、向量、代码三种检索间路由 | recall API | improve：吸收反馈，把会话内容蒸馏进图 | [20] |
| MIRIX | 6 个记忆 manager + 1 个元 manager 路由 | 每批输入或截图 | Core、Episodic、Semantic、Procedural、Resource、Knowledge Vault | BM25 + 向量 | Active Retrieval：先生成当前主题，再到各库检索后注入 | 各 manager 自行更新 | [21] |
| Memobase | 后台批处理，固定 3 次 LLM 调用 | 每个用户的缓冲区满或空闲时 flush | 用户画像槽位 + 事件时间线 | 画像直接读取；事件可检索 | 注入 | 画像槽位合并更新（细节**未核实**） | [22] |
| OpenClaw | Agent 自写 + 压缩前的静默 flush 回合 + dreaming | 会话中；压缩前；cron 每天 03:00 | workspace 下 MEMORY.md、USER.md、`memory/YYYY-MM-DD.md`、DREAMS.md；索引存 SQLite | `memory_search`：向量与 BM25 加权合并 × 30 天半衰期 × 重要性，再用 MMR 去冗余；无 embedding 时只用 FTS | MEMORY/USER 在会话开始时注入；`/new` 时载入今天和昨天的日记；其余走工具 | dreaming 分三相：light（暂存）→ REM（反思）→ deep（晋升）。deep 按相关 .30、频次 .24、查询多样性 .15、新近 .15、多日复现 .10、概念密度 .06 加权，并须过三道门槛，才写入 MEMORY.md | [23] |
| Hermes Agent | Agent 自写（add/patch/remove）+ 回合后的后台自省 | 会话中 | MEMORY.md（2,200 字符）、USER.md（1,375 字符）；全部会话存 SQLite FTS5 | `session_search` 用 FTS5 返回原始消息，不调 LLM | 会话开始时注入冻结快照以保前缀缓存，会话中写入的内容下次会话才生效 | 写入超限直接报错，由 Agent 自行删改；不自动压缩 | [24] |
| TencentDB-Agent-Memory | 后台 LLM 分层抽取 | L1 每 5 轮或空闲 600 秒；L2 间隔至少 900 秒；L3 每积累 50 条新记忆 | L0 原对话 → L1 原子 → L2 场景（文件树）→ L3 persona.md | keyword / embedding / hybrid（RRF）；BM25 中文分词用 jieba；远程 embedding 默认关闭 | L2/L3 注入系统提示；L0/L1 做成只读工具，避免 KV cache 失效 | L1 用向量去重并检测冲突 | [25] |

## 2 设计维度与各家取值

- **写入方**：人写（CLAUDE.md、AGENTS.md）；Agent 自写（Claude Code、Letta、Hermes、OpenClaw、Claude API）；后台 LLM 抽取（Codex、Mem0、Zep、TencentDB、Memobase、MIRIX、A-MEM、Cognee）；不抽取、直接检索原文（Hermes session_search、Letta 对话检索、Kimi Code 事件日志）。
- **写入时机**：回合内即写；回合后后台写；空闲门槛（Codex 6h、TencentDB 600s）；压缩前 flush（OpenClaw）；定时（OpenClaw cron、Letta 按步数）。
- **存储粒度**：索引 + 主题文件；原子事实；时态图；画像槽位 + 事件；原文行。
- **检索**：不检索、全量注入；子串匹配（Codex）；BM25；向量；加权或 RRF 混合（OpenClaw、Mem0、TencentDB、Zep）；图遍历；LLM 选择（Claude Code 副模型召回、MIRIX 先定主题）。
- **送达**：会话开始时注入冻结快照（Hermes、Codex、Claude Code 的 MEMORY.md）；每轮注入（Letta `system/`、TencentDB L2/L3）；按需工具；事件触发（`/new` 载入日记、引用块）。
- **整理/失效**：不整理（Mem0 只增）；容量上限逼 Agent 自己删改（Hermes、Claude Code 200 行）；时态失效（Zep）；按使用淘汰或衰减（Codex 30 天、OpenClaw 半衰期）；晋升（OpenClaw deep、TencentDB L1→L3、Codex 阶段 2）。
- **共识**：小而稳定的层注入，大而易变的层走工具。Hermes、TencentDB、Codex、Claude Code 都明确这样分。

## 3 可离线验证的假设（本机会话日志，零或少量模型调用）

探针统一用"跨会话重学事件"：用户在后一个会话里重述了前一个会话已经出现过的信息。前一会话中对应的 turn 是金标。检索单元分 msg 和 turn，复用 `scripts/memlab.py` 已有的策略。

1. **写入方 H1**：在 Recall@5 上，原文 turn 检索不低于 v2 原子库，且写入成本为 0。另加 oracle 覆盖率，即金标信息是否进了原子库，用来区分"没存进去"和"存了没检到"（2610.24671 的做法）。判定：原文不低于原子库减 2pp，就停止扩建抽取管线。
2. **写入方 H1b**：沿用 LongMemEval 的"事实作键、原文作值"。拿已有 v2 原子当作 turn 的附加索引键，原子本身不送达，零新增调用。判定：Recall@5 提升至少 3pp，才保留原子库，而且只当索引用。
3. **时机 H2**：用规则（"不对/改成/算了/还是用"）统计一个会话内、写入后又被推翻的候选条数。比较两种写法：回合内立即写，与会话空闲后写（Codex 的空闲门槛）。量：会话内推翻率，以及能避免的错写条数。
4. **检索 H3a**：查询按 CJK 长度分桶（不超过 2 字、3–4 字、5 字以上、中英混杂），比较 trigram、bigram、RRF、prod_like。FTS5 文档写明，少于 3 个字符的子串在全文查询中匹配不到任何行 [40]，所以预测 trigram 在 2 字桶召回为 0，bigram 和 RRF 胜出。量：分桶 Recall@5 和 MRR。
5. **检索 H3b**：本地向量与 BM25 做 RRF，在"改写/同义"类探针上看能否提升至少 5pp。依据：2610.24671 中只换检索器就差 14.8pp，2603.02473 中检索器带来的差异是写入策略的 3–6 倍。候选模型见第 4 节 D。
6. **送达 H4**：离线重放请求序列，算两个量：前缀可复用字节比例（最长公共前缀），以及注入条目与本会话后续文本的重叠命中率。比较会话开始时冻结注入与每轮动态注入：看命中率的提升是否抵得上缓存损失。
7. **整理 H5**：从日志里抽同一键的新旧值（路径、版本号、模型名、偏好），比较两种处理：只增 + 检索期按时间戳取最新，与写入期覆盖。量：当前值排第一的比例、旧值误召回率。再测 30 天半衰期衰减对重学探针 MRR 的影响：已知 85% 的重学间隔超过 2 天，预期衰减无益。
8. **晋升 H6**：用前 N 周日志按 OpenClaw 的频次、查询多样性、多日复现打分，检验分数最高的 k 条在后 M 周是否真被重学（precision@k）。

## 4 证据强弱

**受控实验支持**
- 2610.24671：6 个显式记忆系统对比原文 RAG（LongMemEval-S、BEAM-100K），检索器和预算都控制住后，仍无一致优势。知识更新、多会话推理两类上原文 RAG 领先。显式记忆只在小模型或预算很紧时占优。把 MiniLM 换成 Qwen3-Embedding-0.6B，原文 RAG 提升 14.8pp [30]。
- 2603.02473（ICLR'26 Workshop，LoCoMo 3×3 网格）：换检索方法，准确率在 57.1%–77.2% 之间变动；换写入策略只差 3–8pp；直接存原文块并不吃亏 [31]。
- 2611.17068：只从答题上下文中去掉检索到的原文轮次，LoCoMo 降 12.17pp，LongMemEval 降 6.50pp [32]。
- LongMemEval：事实作键扩展，召回 +9.4%，准确率 +5.4%；时间感知查询扩展，召回 +11.3%，但需要强 LLM 抽时间范围；英文场景下 BM25 明显弱于稠密检索 [26]。
- MemoryAgentBench：多跳选择性遗忘，所有方法最高只有 28% [28]。
- 2607.21962：系统排名随历史长度反转；写得差的事实失败率 24%，写得好的只有 2% [34]。
- 2606.15903：确定性原语能处理词法类和时间类遗忘，但跨语言规范化为 0% [35]。
- ConvoMem：少于 150 次对话时，全上下文准确率 70–82%，Mem0 只有 30–45% [36]。
- 2605.29630：256 维哈希 trigram 只在封闭词表的词法类查询上有帮助；BGE-large 的参数量是 MiniLM 的 2.7 倍，却并不全面胜出 [37]。
- 基准规模：LoCoMo 每段约 300 轮、9K token，整段放得进上下文 [27]；BEAM 最长 10M token [29]。时间推理和知识更新是各基准公认的难点。

**单篇或自家评测**：Zep 论文报告 LongMemEval 71.2%，全上下文为 60.2% [16]；2603.04814 中长上下文比 Mem0 高 30pp 以上 [33]。

**厂商声明**：Mem0 92.5/94.4（README 注明平台版含开源版没有的专有优化）；MemOS 88.83/89.20；TencentDB 声称 token 降 61%；Letta 文件系统 LoCoMo 74.0% [38]；Redis 混合方案 86.1% [39]；Memobase、MIRIX 自称 SOTA。产品机制本身（Claude Code、Codex、Hermes、OpenClaw）出自文档或源码，可信；但这些产品的效果都没有公开评测。

**D 中文检索**：没找到 trigram、二元组、jieba、向量在中英混杂短查询上的公开受控对比，**未核实**，需本机实测；上面所有基准都是英文。体积与 C-MTEB 分数取自 [41]，各卡评测版本不同，不能严格横比：
- bge-small-zh-v1.5：24M 参数，96MB，平均 57.82，检索 61.77。
- Qwen3-Embedding-0.6B：0.6B 参数，1.19GB，平均 66.33，检索 71.03。
- multilingual-e5-small：118M 参数，471MB，平均 55.38。
- bge-m3：568M 参数，fp32 2.27GB；支持稠密、稀疏、多向量三种检索；卡片未列 C-MTEB 分数。

6GB 显存按参数量估算，以上 fp16 都能跑；Qwen3-Embedding-4B 的 fp16 约 8GB，需量化。显存一项未实测。

## 来源
[1] https://code.claude.com/docs/en/memory · [2] https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md · [3] https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · [4] https://platform.claude.com/docs/en/build-with-claude/context-editing · [5] https://github.com/openai/codex/blob/main/codex-rs/memories/README.md · [6] https://github.com/openai/codex/tree/main/codex-rs/ext/memories · [7] https://github.com/openai/codex/blob/main/codex-rs/config/src/types.rs ，https://learn.chatgpt.com/docs/customization/memories ，https://learn.chatgpt.com/docs/agent-configuration/agents-md · [8] https://github.com/MoonshotAI/kimi-cli （已归档） · [9] https://github.com/MoonshotAI/kimi-code · [10] https://www.kimi.com/help/features/memory-space · [11] https://github.com/mem0ai/mem0 · [12] https://docs.mem0.ai/migration/platform-v2-to-v3 · [13] https://docs.letta.com/concepts/memfs/ · [14] https://docs.letta.com/agent-sdk/memory/ · [15] https://github.com/getzep/graphiti · [16] https://arxiv.org/abs/2501.13956 · [17] https://arxiv.org/abs/2502.12110 · [18] https://arxiv.org/abs/2507.03724 ，https://github.com/MemTensor/MemOS · [19] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ · [20] https://github.com/topoteretes/cognee · [21] https://arxiv.org/abs/2507.07957 · [22] https://github.com/memodb-io/memobase · [23] https://docs.openclaw.ai/concepts/memory ，/concepts/memory-search ，/concepts/dreaming · [24] https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md · [25] https://github.com/TencentCloud/TencentDB-Agent-Memory · [26] https://arxiv.org/abs/2410.10813 · [27] https://arxiv.org/abs/2402.17753 · [28] https://arxiv.org/abs/2507.05257 · [29] https://arxiv.org/abs/2510.27246 · [30] https://arxiv.org/abs/2610.24671 · [31] https://arxiv.org/abs/2603.02473 · [32] https://arxiv.org/abs/2611.17068 · [33] https://arxiv.org/abs/2603.04814 · [34] https://arxiv.org/abs/2607.21962 · [35] https://arxiv.org/abs/2606.15903 · [36] https://arxiv.org/abs/2511.10523 · [37] https://arxiv.org/abs/2605.29630 · [38] https://www.letta.com/blog/benchmarking-ai-agent-memory/ · [39] https://redis.github.io/redis-ai-research-public/longmemeval-agent-memory/ · [40] https://www.sqlite.org/fts5.html · [41] https://huggingface.co/BAAI/bge-small-zh-v1.5 ，/BAAI/bge-m3 ，/Qwen/Qwen3-Embedding-0.6B ，/intfloat/multilingual-e5-small
