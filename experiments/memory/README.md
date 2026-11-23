# 记忆模块设计实验（exp/memory-design）

目的：用本机真实会话，比较“存什么 / 怎么找 / 怎么送达 / 怎么整理”四个维度的做法，决定记忆模块的方向。
结论与实验树见 `report/index.html`（自包含，浏览器直接打开）。

## 目录

| 路径 | 内容 |
|---|---|
| `scripts/build_corpus.py` | 从 `~/.config/SomniQ/desktop-runtime` 只读构建语料（会话、消息、回合），输出到仓库外 |
| `scripts/memlab.py` | 检索策略：生产 `session_search` / `recall_local` 的复刻、二元组与三元组 BM25、RRF、近因衰减 |
| `scripts/eval_relearn.py` | 任务 A 踩坑重现（107 个已标注重学事件，金标锚定真实 tool_use_id） |
| `scripts/eval_recall.py` | 任务 B 前情回顾（132 道由 Claude 子 agent 从真实回合改写的考题） |
| `scripts/rerank.py` | 混合 RRF + 本地 Qwen3-0.6B 重排（HF 缓存，GPU） |
| `scripts/eval_trigger.py` | 送达门槛：词法覆盖率 / 小模型概率 能否区分“该送”和“不该送” |
| `scripts/eval_cache.py` | 每轮 system 注入的缓存代价（`memory_recall` 事件 × `usage-log.jsonl`） |
| `scripts/make_report.py` | 读 `results/*.json` 生成 `report/tree.json` 与 `report/index.html` |
| `results/` | 只含汇总数字 |
| `agents/prompts/` | 给 Claude / Codex / 出题子 agent 的任务说明 |
| `agents/outputs/` | Claude、Codex 的独立设计方案与 Codex 的独立审查 |
| `research/architectures.md` | 业界架构调研（Claude Code、Codex、Kimi、Mem0、Letta、Zep 等，附一手来源） |

## 复现

```powershell
$env:PYTHONIOENCODING="utf-8"
python experiments/memory/scripts/build_corpus.py          # 约 30 秒
python experiments/memory/scripts/eval_relearn.py          # 约 2 分钟
python experiments/memory/scripts/eval_recall.py           # 约 2 分钟
$env:HF_HUB_OFFLINE="1"; python experiments/memory/scripts/rerank.py   # 需要 GPU 与本地 Qwen3-0.6B
python experiments/memory/scripts/eval_trigger.py
python experiments/memory/scripts/eval_cache.py
python experiments/memory/scripts/make_report.py
```

任务 A 依赖 `F:\Agent\memory-l1-dataset`（2026-10-21 的 L1 评测集），任务 B 的考题在 `F:\Agent\memory-exp-data\probes.json`。

## 隐私

语料、考题、v2 原子库快照都含私人对话，**只放在仓库外的 `F:\Agent\memory-exp-data`**，不要提交、不要上传。本目录只提交代码、提示词与汇总数字。
