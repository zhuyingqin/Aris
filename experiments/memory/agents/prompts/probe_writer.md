# 任务：为记忆评测写"前情回顾"考题

输入文件（JSONL，每行一个候选回合）：`F:\Agent\memory-exp-data\probe_candidates_{N}.jsonl`
字段：turn_id、project、session、ts、user（用户原话）、assistant（助手回复，截断）。

这些是本机真实科研对话（私人数据）。你要判断每个回合是否确立了一条**之后另一个新会话可能需要回想起来**的具体信息，如果是，就出一道考题。

## 判定 keep
保留（keep=true）：决定/选择（用哪个方法、数据集、期刊、模板、参数）、偏好/规矩（写作风格、语言、格式要求）、项目事实（文件/目录位置、命名、章节结构、截止日期）、结果/发现（实验数字、结论、某方案行不通）。
丢弃（keep=false）：一次性的编辑请求且没有可复用信息、寒暄、只有提问没有答案、大段粘贴、泛泛的命令、信息只在本会话内有意义。
宁缺毋滥，预计保留率 30–60%。

## 保留时要写的字段
- `type`：decision | preference | fact | result
- `question`：以用户口吻、在几周后的**新会话**里会怎么问（看不到这次对话）。必须能用这个回合的信息回答。**改写措辞**：除不可替代的专名/文件名/模型名外，不要照抄原文里连续 4 个及以上的字；不要把答案写进问题里。
- `answer`：标准答案，≤ 60 字。
- `answer_from`：user（信息出自用户原话）| assistant（出自助手回复）
- `durable`：high | medium | low（几周后还重要的可能性）
- `changes_earlier`：原话明确在改掉更早的选择（如"改为/不再/换成"）时为 true，否则 false

## 输出
写到 `F:\Agent\memory-exp-data\probes_raw_{N}.jsonl`，每个候选一行（包括 keep=false 的），格式：
{"turn_id": "...", "keep": true, "type": "...", "question": "...", "answer": "...", "answer_from": "user", "durable": "high", "changes_earlier": false}
keep=false 时只需 {"turn_id": "...", "keep": false, "why": "≤10字"}。

只读这个输入文件、只写这个输出文件，不要联网，不要读其他文件。最终回复只给数量统计（共几条、保留几条、各 type 几条），不要在回复里引用任何对话内容。
