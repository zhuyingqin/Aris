# 独立设计任务：SomniQ Studio 记忆模块该怎么设计

你是被邀请的独立架构师。请**只读**本仓库，不要修改任何文件，不要运行构建。

## 背景
SomniQ Studio 是本地优先的科研桌面工作台（Tauri + Rust），Executor → 独立 Reviewer → 修订循环。用户是单人研究者，中文为主、中英混杂，会话里大量工具调用（bash、LaTeX 编译、文献检索、写文件）。

现有记忆相关代码与设计文档：
- `docs/development-logic/memory-architecture.md`、`builtin-research-memory.md`、`memory-quality-review-2026-09-06.md`、`memory-refactor-plan.md`
- `docs/development-logic/memory-l1-notes-plan.md`、`memory-l1-notes-design.md`（L1 笔记方案，尚未实现）
- `docs/development-logic/memory-l2-l3-design.md`（晋升管线方案，尚未实现）
- `crates/runtime/src/hot_memory.rs`（MEMORY.md / USER.md 常驻文件）、`research_memory_v2.rs`（后台 LLM 抽取 + 审查的原子库，生产在用）、`session_index.rs`（会话全文索引）
- `crates/tools/src/lib.rs` 里的 `memory` 工具

已知事实（来自本机实测，可直接采信）：
- v2 原子库写入很贵（约 5,000 输入 token / 条存活原子），读取却只是子串计数，没有 IDF。
- 30% 注入用的"决定/约束"是错的：把一次性回答（如「B吧」）、助手建议记成用户长期决定；长期性只有用户知道。
- 跨会话"重学"事件少（约每 100 个用户回合 5 次），其中 85% 间隔超过 2 天。
- 网关没有 embedding 模型；本机有 RTX 3060 6GB，可跑本地小模型。
- 每轮把记忆拼进 system prompt 会破坏 KV cache。

## 请输出（中文，Markdown，≤ 2500 字）
1. 对现状的诊断：最该砍掉什么、最该保留什么（各 ≤ 5 条，指向具体文件/机制）。
2. 你推荐的目标架构：写入（谁写、何时写、写什么）、存储、检索（算法）、送达（注入 vs 工具 vs 触发）、整理（去重/失效/晋升）。每一项给出一句理由。
3. 5–8 条**可证伪的假设**，必须能用本机历史会话日志离线验证（零或少量模型调用）。每条写：假设、对比的两个方案、指标、判定线。
4. 你明确**不建议**做的 3 件事。
5. 如果只能做一件事，做什么。
