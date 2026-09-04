# PseudoBench × SomniQ/ARIS 实验追踪表

最后更新：2026-08-13  
负责人：未指定  
当前阶段：M0 — Preflight blocked

## 总览

| 里程碑 | 状态 | 进入条件 | 完成证据 |
|---|---|---|---|
| M0 Protocol / preflight | 进行中 | 计划已冻结 | 全部 preflight 测试与 manifest 校验通过 |
| M1 1×2 smoke | 未开始 | M0 全绿 | 两条隔离轨迹、PDF judge 记录 |
| M2 5×2 pilot | 未开始 | M1 全绿 | 10 个协议合规运行与配对摘要 |
| M3 20×2 paired study | 未开始 | M2 go | 配对 CI、置换检验、错误分析 |
| M4 200×2 full study | 未开始 | M3 go + 预算批准 | 全量结果与审计包 |

## M0 检查项

| ID | 检查项 | 状态 | 证据/备注 |
|---|---|---|---|
| M0-01 | 冻结官方 dataset/prompt/evaluator hash | 完成 | 见 `EXPERIMENT_PLAN.md` §3 |
| M0-02 | 记录代码 SHA 与 dirty worktree | 部分完成 | SHA 已记录；每次运行仍需自动归档 status/diff 摘要 |
| M0-03 | 修复 `requests_candidate_research` 的跨全文关键词误触发 | 阻塞 | 完整 PseudoBench 提示目前会被误判为候选论文识别 |
| M0-04 | 添加完整官方提示负例与真实 paper-ID 正例 | 未开始 | 必须是回归测试，不只手工检查 |
| M0-05 | 使 R1 Todo 完成逻辑与标签化语义一致 | 阻塞 | `todo_completion_block` 仍可能要求 decision-ready |
| M0-06 | 为 runner 增加 `run_id` / `condition` | 未开始 | 条件必须显式进入 session 和路径 |
| M0-07 | 唯一 session ID | 阻塞 | 当前为固定 `pseudobench-{uuid}` |
| M0-08 | 条件级 config/workspace/runtime 隔离 | 阻塞 | `--somniq-home` 尚未证明控制实际 `ARIS_CONFIG_ROOT` |
| M0-09 | Review-off / Review-on 只改变 `review_enabled` | 未开始 | 当前有效配置为 `review_enabled=false` |
| M0-10 | 验证 Reviewer 与 Executor 模型独立 | 未开始 | manifest 记录实际 provider/model，不记录凭据 |
| M0-11 | 禁止 rescue turn 并记录 no-PDF | 已有基础 | `run_aris.py` 已按单初始回合设计；需回归测试 |
| M0-12 | 条件级 artifact/result 路径 | 未开始 | 不得覆盖固定 `aris_workspace` |
| M0-13 | evaluator 使用真实 PDF Responses transport | 部分完成 | 本地有 transport 选项；正式运行必须固定为 Responses |
| M0-14 | 兼容公开数据字段而不改评分提示 | 部分完成 | 本地 evaluator 有 `claim/evidence` fallback；需测试 |
| M0-15 | manifest 归档所有 hash、配置、UUID 与顺序 | 未开始 | 配置必须 redacted |
| M0-16 | 精确复现提示字节 | 未开始 | A/B 渲染内容 SHA 必须相同 |

## M1 smoke 记录

UUID：`b022c418-c3c9-4f88-a747-1ecc16eb6312`

| 条件 | session/config/workspace 隔离 | Reviewer 事件符合条件 | 终态 | report.pdf | PDF judge | 备注 |
|---|---|---|---|---|---|---|
| Executor-only | 待测 | 待测 | 待测 | 待测 | 待测 | |
| Independent Reviewer | 待测 | 待测 | 待测 | 待测 | 待测 | |

M1 决策：`PENDING`

## M2 pilot 清单

| UUID | 类别 | A 状态 | B 状态 | 配对评分 | 人工审计 |
|---|---|---|---|---|---|
| `b022c418-c3c9-4f88-a747-1ecc16eb6312` | Consciousness Research | 未开始 | 未开始 | 待计算 | 待审计 |
| `3b541d44-3b2c-4b1a-9b94-0a777c8cd134` | Earth Science | 未开始 | 未开始 | 待计算 | 待审计 |
| `2b6a12bb-823f-4a35-ad78-f82b2bf0989e` | Engineering | 未开始 | 未开始 | 待计算 | 待审计 |
| `c30df1b3-ae81-4be3-bbca-9240309bb374` | Fundamental Physics | 未开始 | 未开始 | 待计算 | 待审计 |
| `9f7b8a47-615b-439f-9708-f2d1d9c5ce30` | Math | 未开始 | 未开始 | 待计算 | 待审计 |

## 运行级必填字段

每个 `(run_id, condition, uuid)` 完成后填写或由 runner 生成：

```yaml
run_id:
condition:
uuid:
category:
order_index:
session_id:
config_root:
workspace_root:
started_at:
finished_at:
termination: completed | timeout | crash | cancelled
report_pdf: present | absent
pdf_compile_status:
executor_provider:
executor_model:
reasoning_effort:
review_enabled:
reviewer_provider:
reviewer_model:
review_eligible_events:
review_invocations:
revision_count:
tool_calls:
prompt_sha256:
dataset_sha256:
runner_sha256:
binary_sha256:
git_sha:
git_dirty:
judge_id:
judge_transport:
judge_status:
notes:
```

## 事件与偏差日志

| 时间 | run/condition/uuid | 类型 | 描述 | 是否排除 | 处理 |
|---|---|---|---|---|---|
| 2026-08-13 | handpilot-20260811 | protocol deviation | 提示改写、失败后 rescue、text-only chat judge | 是 | 整批 quarantine，不进入统计 |
| 2026-08-13 | preflight | guard false positive | 官方长提示中的 `paper` 与 `determine` 触发 candidate workflow | 尚未运行 | 修复并新增回归测试 |
| 2026-08-13 | preflight | architecture mismatch | 当前 `review_enabled=false` | 尚未运行 | 建立 A/B 两条件 |
| 2026-08-13 | preflight | contamination risk | 固定 UUID session ID 可能复用历史会话 | 尚未运行 | session/config/workspace 唯一化 |

## M2 决策模板

运行完成前不得填写方向性结论。

- 协议合规运行：`__/10`
- Executor-only Reviewer 调用：`__`
- Review-on 合格回合 Reviewer 调用率：`__`
- A refusal/no-PDF：`__`
- B refusal/no-PDF：`__`
- 主安全终点配对方向：`__`
- Reviewer 引入/放大伪造：`__`
- 人工审计主要错误模式：`__`
- 决策：`GO M3 | REPEAT M2 | NO-GO/FIX`
- 决策理由：`__`
