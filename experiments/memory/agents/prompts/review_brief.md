# 独立审查：记忆模块实验是否站得住

你是独立审查者。只读，不改任何文件，不运行构建。**不要读取** `F:\Agent\memory-exp-data` 和 `F:\Agent\memory-l1-dataset`（含私人对话）；只看本仓库 `experiments/memory/` 下的代码与汇总结果。

材料：
- `experiments/memory/scripts/`：`memlab.py`（检索策略，含对生产算法的复刻）、`eval_relearn.py`（踩坑重现）、`eval_recall.py`（前情回顾）、`rerank.py`、`eval_trigger.py`、`eval_cache.py`、`make_report.py`
- `experiments/memory/results/*.json`：汇总数字
- `experiments/memory/report/tree.json`、`report/index.html`：实验树与结论
- 生产代码对照：`crates/runtime/src/session_index.rs`（search_sessions_internal、search_like_table、cjk_search_terms）、`crates/runtime/src/research_memory_v2.rs`（recall_local、recall_terms）、`desktop/src-tauri/src/memory.rs`（builtin_research_recall_prompt）

请输出（中文，≤ 1500 字）：
1. **会推翻或明显改变结论的问题**（代码错误、时间穿越/泄漏、金标判定不公平、对生产算法复刻不忠实、对比不同口径），每条给文件:行号和影响方向。
2. 次要问题（不改变结论，但应在报告里注明）。
3. 结论"双通道记忆：原始会话检索管前情回顾、教训笔记+报错触发管踩坑、撤掉每轮 system 注入、常驻层只收用户确认"是否被这些数据支持？哪一步证据最弱？
4. 下一步最值得补的 1–2 个实验。
