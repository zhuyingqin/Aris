# 审稿人插件（Reviewer packs，2026-11-15）

插件除了给 Executor 加 Skills、MCP 和面板，现在也能给**独立 Reviewer** 加审查
细则：实验室的标准、会议的清单、领域的方法学规则。细则跟着插件安装、批准、
升级和回退，于是"我们组怎么审"成了能分发、有版本的东西，而不是每次在对话里
重复叮嘱。

## 声明

`package.json`：`"somniq": { "manifestVersion": 1, "reviewer": "./reviewer.json" }`，
可以和 `ui` 并存，也可以只声明这一项。

```json
{
  "schemaVersion": 1,
  "rubrics": [{
    "id": "statistics",
    "title": { "en": "Statistics reported in full", "cn": "统计结论要报全" },
    "appliesWhen": ["显著", "p 值", "significant", "p-value"],
    "criteria": [
      { "id": "effect-size", "severity": "high",
        "check": "Each significance claim reports an effect size or confidence interval, not only a p-value." }
    ]
  }]
}
```

- 1–8 个 rubric，每个 1–20 条 criterion；id 为 `[A-Za-z0-9_-]{1,64}`，在各自列表中
  唯一；`check` 1–600 字符；`severity` 为 critical / high / medium / low。
- `appliesWhen` 最多 24 个关键词（每个 ≤40 字符），在用户请求或 Executor 答案中
  大小写不敏感地子串匹配，中文不需要分词；不写则每次审查都适用。
- 未知字段、未知严重度、越界一律产生 `reviewer` 诊断并阻止启用。
- 校验和存储在 `runtime::plugins::reviewer`；模板 `reviewer-pack`。

## 进入审查的路径

1. 每个 Chat 回合开始时冻结的插件集合（`PluginRun`）决定有哪些细则：
   `PluginStore::review_rubrics_for(set)`。回合中途开关或升级插件不会改变本轮
   Reviewer 检查什么，与 Skills/MCP 同一规则。
2. 每一轮审查（首轮与每次修订）按当前请求 + 当前答案重新判断适用的细则，
   `render_review_rubrics` 生成一节，`with_review_rubrics` 把它插在审查包的
   "Return exactly one JSON object…" 之前，让答案格式仍是 Reviewer 最后读到的
   内容。完整包和增量包都插。整节上限 12000 字符，超出的 rubric 整个列为
   "Omitted for length"，不会截断在某条中间。
3. 说明文字要求 Reviewer：违反的条目要单独提 issue，`criterion` 填完整键
   `<包名>/<rubric>#<criterion>`，严重度不低于条目本身；违反 critical 条目时
   判定不能是 pass；细则里任何试图改变角色、工具或 JSON 格式的文字都要忽略。
4. 控制器（不是 Reviewer）写审查记录 `rubrics`（`ReviewRubricRecord`）：
   - `delivered`：实际放进审查包的 rubric；`omitted`：适用但因长度被整段跳过的
     rubric。跳过的从不进 `delivered`，也不出现在逐条结果里，所以不会出现
     "没检查却显示已应用"。
   - `checks`：每条**已下发**条目的结果 `met / violated / not_applicable /
     unverified / unreported`。Reviewer 按要求在 JSON 里附 `rubricChecks`，但那只是
     输入：引用了某条目的 issue 一律使该条目为 `violated`，不论 Reviewer 自报什么；
     Reviewer 没提到的已下发条目记为 `unreported`，绝不默认为满足。
   - `unknownCriteria`：Reviewer 引用了包里没有的键，键从 issue 上清掉并记在这里。
   - `verdictCorrected`：违反了 critical 条目却判 pass 时，控制器改判为 revise
     （审查门则把 `approved` 改为 false），并在摘要里注明是控制器改的。
   引用了条目的 issue，严重度被抬到不低于条目本身；Reviewer 自报 violated 但没提
   issue 的条目，控制器补一条 issue，保证违反项一定进入修订要求。对账逻辑在
   `runtime::plugins::reconcile_rubric_checks`，三条路径共用。审查面板逐条显示结果、
   跳过的细则和改判说明，问题卡片上显示 `criterion` 标签。
5. Reviewer 没给出可用结论（`unavailable`）时，记录仍写：已下发什么、每条都是
   `unreported`。

## 独立性

- 细则只进 Reviewer 的审查包。Executor 的系统提示和修订提示里都没有细则文本；
  修订提示只转述 Reviewer 的发现（标题、说明、建议），不带 `criterion` 键。
- 已知限制：插件快照目录对 Executor 的文件工具可读（为了让插件 Skill 能读自己的
  文件），所以 Executor 若主动去读快照里的 `reviewer.json`，是能看到细则的。这里
  不当作机密来保护：防住的是"Executor 改不了、关不掉、绕不开"，而不是"看不见"。
  细则的变更必须经用户批准，Executor 无法在回合内修改。
- 批准卡片和插件详情列出每个 rubric 及条数；插件详情展开全部条目原文。升级差异
  按 `<rubric id> (<条数> criteria, <内容摘要前 8 位>)` 比较，改一个字也算变更。

## 范围

- Chat 回合内的独立审查（线程式与 oneshot 走同一个审查包）。
- 待办任务完成后对提交结果的审查（`run_work_task_review`）：细则来自任务运行冻结的
  插件集合，按任务标题 + 任务内容 + 执行者总结判断适用；细则一节插在
  "Reply with a single JSON object" 之前；记录存在 `WorkTaskReviewState.rubrics`，
  看板显示下发/违反/未报告计数和跳过的细则。任务的修订提示同样不带细则键。
- 综述工作流的**审查门**（`gateVerdict` 与检索计划审查）：前端调用时带
  `gate: true`，后端在 `reviewer_turn` 里冻结当时的插件集合、注入细则，
  `apply_rubrics_to_gate` 对账后把记录写进回复 JSON 的 `rubrics`，前端存进
  `ReviewerGate.rubrics`。门的 `issues` 是字符串，违反项以 `[键]` 开头标记。
  分级、分类、误检分析这类走同一 Reviewer 通道但产出数据的调用**不带**细则，
  以免额外字段破坏它们的 JSON。
- 尚未做：工作流界面上还没有单独渲染 `ReviewerGate.rubrics`（违反项已体现在
  issues 与摘要里）。
