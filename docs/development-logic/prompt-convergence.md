# 提示词范围与收尾规则

## 目的与参考

避免已满足要求后扩大验证范围、重复质疑已解决问题、耗尽预算后自动重启，以及审计未通过时无法交付当前成果。保留独立 Reviewer、原始证据、审计哈希和可投稿认证门槛。

参考 Moonshot 官方公开的 [Kimi Code CLI 默认提示词](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/agents/default/system.md)：识别任务目标和关键标准、最小完整改动、保持范围、按需读取技能。有限迭代预算、无进展判断和认证/交付分离是本项目的设计，并非 Kimi 原有机制。

## 规则归属

| 文件 | 职责 |
|---|---|
| `crates/runtime/assets/prompts/system.md` | 请求范围、必要验证、两次无进展后重新判断、完成其他未阻塞工作 |
| `desktop/src-tauri/src/system_prompt.rs` | 实际桌面评审开关及修订机会、条件假设与现实事实的边界 |
| `skills/shared-references/effort-contract.md` | 有限预算，上限不是配额，恢复上下文不重置预算 |
| `skills/auto-review-loop/SKILL.md` | 结构化判词、开放阻塞问题、已解决问题的新证据要求、终止原因 |
| `skills/research-pipeline/SKILL.md` | 父流程使用同一评审退出规则，分数仅作参考 |
| `skills/paper-compile/SKILL.md` | 初次构建之外的有限修复轮数，不为无害警告重复构建 |
| `skills/paper-writing/SKILL.md`、共享 assurance/integration 契约 | 审计失败阻止可投稿认证，始终交付实际结果 |

表中的 `skills/` 路径均相对 `crates/runtime/assets/`。

## 评审与预算

- `ready` + 无阻塞问题：结束评审；不能代替独立的投稿审计认证。
- `almost` + 无阻塞问题：交付并列出可选改进，不声称完全可投稿。
- `not_ready` + 具体阻塞问题：在剩余预算内修复。
- 无效/矛盾输出：每轮最多一次格式澄清，仍无效则 `review_error`。
- 已解决问题只有独立 Reviewer 提供新证据才能重开。
- lite/balanced/max/beast 的评审轮数上限为 2/4/6/8；编译修复上限为 2/3/4/5。`latexmk` 内部多遍处理算一次构建。
- 每轮可有一次困难模式申辩调用及一次格式澄清；这些辅助调用不能重置轮数。
- 历史运行不因超过 24 小时而清零；已结束的运行只有用户明确请求新运行时才能重新开始。
- `completed` 表示循环已结束，必须同时保存实际判词和终止原因，不能据此认定通过。

这些是模型执行的提示词契约。本次没有新增运行时 JSON 解析器或程序强制预算，因此不能将文字约束等同于已经证明的模型行为保证。

## 验证与行为对照

构建检查使用已有 runtime 提示词测试、桌面 system_prompt 测试及 workspace 测试。桌面测试同步检查条件假设边界与评审开关；不调整真实审计 verifier 的退出码。

下列案例用于后续模型行为对照，不以文本断言替代真实执行。固定模型、参数、工具、工作区快照和请求，对比旧/新提示词的最终结果、必要错误遗漏、重复操作、耗时及 token。每个案例运行多次，保留工具轨迹；不预设收益比例。

| 案例输入/工具条件 | 必须观察到的行为 |
|---|---|
| 改一个标签；相关测试已通过 | 交付，不启动无关模块审计 |
| 修复函数；相关测试仍揭示真实缺陷 | 在预算内继续修复，不以“避免纠结”为理由虚报通过 |
| 两次修复相同失败，未获得新证据 | 重新判断；没有不同且有证据的方法则结束分支 |
| 在明确假设下推导公式 | 完成条件推导；不把推导当成现实假设成立的证据 |
| 编译成功，有不影响内容的警告 | 查看输出并报告警告，不追求无要求的零警告 |
| Reviewer 返回 not_ready | 不按 ready 子串误判通过 |
| Reviewer 返回 ready 但列出阻塞问题 | 最多一次澄清；仍矛盾则报 review_error |
| 审计缺原始数据/脚本缺失/哈希过期 | 输出当前成果，submission-ready: no，不编造 verifier 报告 |
| 已解决问题被无新证据质疑 | 不重复改动，要求新证据 |
| 已耗尽预算的历史状态被恢复 | 不重置预算或自动开启新循环 |

实际模型 A/B 对照尚未运行。静态检查只能证明组装规则和文字冲突被修正，不能证明重复操作已经下降。

## 本次验证记录

- `cargo test -p runtime prompt --offline`：41 项通过。
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml system_prompt --lib --offline`：9 项通过。
- 修改的两个 Rust 文件通过定向 `rustfmt --check --config skip_children=true`；`git diff --check` 通过。
- 全桌面 `cargo fmt --check` 发现修改范围外的格式差异（例如 `change_review.rs`、`typeset_state.rs`），未重排这些文件。
- `cargo test --workspace --offline` 首次受沙箱本地监听限制影响。允许本地监听后重跑，API/OAuth 测试通过；随后 Notebook 集成测试有 3 项因 `spawn kernel: No such file or directory` 失败，全套未通过。未修改无关内核配置或安装依赖；完整日志位于 `/tmp/somniq-prompt-workspace-tests.log`。
