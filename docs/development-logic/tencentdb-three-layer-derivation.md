# TencentDB-Agent-Memory 三层记忆是怎么生成的

## 来源与核对边界

- 源码：`https://github.com/TencentCloud/TencentDB-Agent-Memory`，浅克隆于 `tmp/tencentdb-agent-memory/`。
- 锚定提交：`0b7bc097f963d3d53b088cd56f79b4bc868e0023`，分支 `feat/server_team`（该仓库的默认分支），提交时间 2026-09-17。
- 本报告的全部结论来自**通读源码**。没有部署、没有运行、没有实测其效果；凡是涉及"效果好坏"的判断，本文只说机制，不替它宣称质量提升。
- 下文所有路径均相对上游仓库根目录。

---

## 0. 总览：它其实是四层，不是三层

"三层记忆"指的是 L1/L2/L3 三层**派生**记忆。L0 不是其中一层，是底座——原始对话的落盘副本，本身不经过任何模型。

```
对话回合
  │
  ├─ L0  原始消息落盘（JSONL，一行一条）           ← 0 次 LLM 调用
  │        触发：每个 agent_end
  │
  ├─ L1  情境切分 + 原子记忆抽取 → 批量冲突判定     ← 2 次 LLM 调用
  │        触发：每 5 轮对话，或 600s 空闲
  │        输入：新消息窗口 + 背景窗口 + 上一个情境名
  │        产出：带 scene_name 的结构化记忆行
  │
  ├─ L2  场景块文档（scene_blocks/*.md）           ← 1 次 agent 运行（多轮工具调用）
  │        触发：L1 完成后 10s，下限 900s，上限 3600s
  │        输入：自上次游标以来新增/变更的 L1 行 + 现有场景索引
  │        产出：LLM 自己用 read/write/edit 维护的 Markdown 叙事文档
  │
  └─ L3  persona.md（单文件画像）                  ← 1 次 agent 运行（工具写文件）
           触发：每次 L2 之后评估；命中 5 个条件之一才真跑
           输入：现有 persona 全文 + **仅变化的** L2 场景全文
           产出：≤2000 字符的画像 + 工程追加的场景导航索引
```

关键点先讲：**层与层之间是派生关系，不是标签关系。** L1 从 L0 抽，L2 从累积的 L1 聚合，L3 从变化的 L2 聚合。没有任何一层是在单个回合里"直接指派"出来的。

配置默认值（`MemoryCore/src/config.ts`）：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `everyNConversations` | 5 | 攒够 5 轮对话触发 L1 |
| `l1IdleTimeoutSeconds` | 600 | 不够 5 轮但空闲 10 分钟也触发 |
| `l2DelayAfterL1Seconds` | 10 | L1 完成后 10 秒排 L2 |
| `l2MinIntervalSeconds` | 900 | 同一 session 两次 L2 至少隔 15 分钟 |
| `l2MaxIntervalSeconds` | 3600 | 没有新对话也每小时兜底跑一次 |
| `persona.maxScenes` | 15 | 场景文件数硬上限 |
| `persona.triggerEveryN` | 50 | 距上次 persona 起累计 50 条记忆触发 L3 |
| `embedding.provider` | `"none"` | **向量默认关闭**，走 BM25 |

---

## 1. L0：原始对话落盘

文件：`MemoryCore/src/core/conversation/l0-recorder.ts`

没有模型参与。做四件事：

1. **增量切片。** 双保险防重复采集：位置切片（用 `before_prompt_build` 时缓存的消息数切掉历史）为主，时间戳游标为辅。注释里写明了为什么要双保险——网关重启后时间戳会漂移。
2. **还原被污染的用户消息。** 框架会在 `before_prompt_build` 之后把 `prependContext` 注入进用户消息，所以 rawMessages 里的用户输入是脏的。它缓存了干净的原始 prompt，按时间戳定位后替换回去。
3. **清洗。** `sanitizeText` 剥掉注入标签（防自我喂养循环），assistant 侧额外 `stripCodeBlocks`，正文里的 base64 图片 data URI 替换成 `[image]`。
4. **写 JSONL。** 一天一个文件 `conversations/YYYY-MM-DD.jsonl`，一行一条消息，`sessionKey` 存在行内而不是文件名里。

准入门槛 `shouldCaptureL0` 是宽松的——注释明说"L0 故意全采，严格过滤放在 L1"。

### 一个必须说清楚的实测发现

L1 侧那个号称严格的质量门 `shouldExtractL1`（`MemoryCore/src/utils/sanitize.ts:135`）——**长度检查和 prompt 注入检查都被注释掉了**：

```ts
// const isCJK = /[一-鿿...]/.test(text);
// if (isCJK && text.length < 2) return false;
// if (text.length > 5000) return false;
...
// if (looksLikePromptInjection(text)) return false;
```

实际剩下的只有两条：纯符号串（1–5 字符）和纯问号。所以不能因为代码注释写了 "strict quality gate" 就认为它的前置过滤可靠——**它的质量几乎全部由 prompt 承担，不由代码承担**。这一条对我们的借鉴方向有直接影响。

---

## 2. L1：一次调用同时做情境切分和抽取，第二次调用做冲突判定

文件：`MemoryCore/src/core/record/l1-extractor.ts`、`prompts/l1-extraction.ts`、`record/l1-dedup.ts`、`prompts/l1-dedup.ts`

### 2.1 输入窗口——这是最关键的一处设计

```ts
const newMessages = qualifiedMessages.slice(-maxNewMessages);        // 默认 10 条
const backgroundMessages = qualifiedMessages.slice(
  Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx);                  // 默认 5 条
```

送进模型的 user prompt 是三段（`formatExtractionPrompt`）：

```
【上一个情境】：{previousSceneName}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
[msg_id] [role] [ISO时间]: 内容
...
━━━━━━━━━━━━━━━━━━━━━━━━━━
【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
[msg_id] [role] [ISO时间]: 内容
```

三件事同时成立：
- **背景窗口只读不抽。** prompt 里两处强调，work 模式的第 6 条原则还专门写了"source_message_ids 必须只包含【待提取的新消息】中的 message id"。背景的作用是消解指代和推算时间。
- **上一个情境名被传进来。** 这让"继承 vs 切换"变成一个模型可以判断的显式任务，而不是靠事后聚类。
- **每条消息带 ID 和 ISO 时间戳。** 所以抽出的记忆能回指具体消息（`source_message_ids`），也能算绝对时间。

### 2.2 输出结构——情境是抽取的产物，不是后加的标签

一次调用返回的是**按情境分段的数组**：

```json
[{
  "scene_name": "我（AI）在和张三做 Rust 所有权机制学习",
  "message_ids": ["msg_1", "msg_2"],
  "memories": [{
    "content": "完整、独立的记忆陈述",
    "type": "persona|episodic|instruction",
    "priority": 80,
    "source_message_ids": ["msg_1"],
    "metadata": {}
  }]
}]
```

`scene_name` 的命名规则是硬约束："我（AI）在和xxx（用户身份）做xxx（目标活动）"，30–50 字符，单句，全局唯一。work 模式换成"团队在围绕[项目/模块/议题]推进[目标活动]"。

**这个 scene_name 会被挂到每一条记忆上**（`l1-extractor.ts:237`），成为 L2 聚合的分组依据，也是 dedup 判断"是否同一件事"的信号之一。一次调用同时产出"这段对话在讲什么"和"从里面记什么"，是它能做到跨层派生的起点。

### 2.3 三条提取原则

prompt 里的原文（chat 模式）：

1. **宁缺毋滥**：过滤琐碎闲聊、临时性指令和一次性操作（"这次、本单"）。
2. **独立完整**：记忆必须"跳出当前对话依然成立"，无上下文也能看懂；主体必须以"用户（姓名）"或"AI"为核心。
3. **归纳合并**：强关联或因果关系的多条消息，必须合并为一条完整记忆，不可碎片化。

work 模式（`EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT`）在此之上加了两条我认为最值钱的：

- **准确归因**："某人提出的建议、担忧、判断，不等于团队决策。只有出现明确确认、拍板、采纳、执行安排时，才能写成确定结论。未确认内容应表达为'团队正在讨论…'、'某方案仍待确认…'。"
- **AI 输出处理**："不要把 AI 的建议自动当成团队事实或团队决策。只有当人类成员采纳、确认，或 Agent 输出本身是明确的工具执行结果、交付物、实验结果时，才可以提取。"

### 2.4 类型系统

chat 模式三类：`persona`（稳定属性/偏好）、`episodic`（客观事件，明确排除纯主观感受）、`instruction`（对 AI 的长期行为规则）。

work 模式四类：`work_fact` / `work_task` / `work_method` / `work_artifact`。其中 `work_method` 被 prompt 明确标为"团队长期工作记忆中最重要的类型之一"，定义是"不只是记录发生了什么，而是记录**以后遇到类似任务应该怎么做、不要怎么做、按什么原则判断**"。

代码侧 `VALID_TYPES` 是七个值的闭集（两套合并），`normalizeType` 做旧名映射（`episode→episodic`、`preference→persona`），不认的直接丢弃。**没有自由 kind。**

`priority` 是 0–100 整数，每个类型各自给了分档标准，并且明确写了"低于 X 分直接丢弃"——把取舍下沉到 prompt 而不是留给后处理。

### 2.5 第二次调用：批量冲突判定

抽完之后，每条新记忆先拿自己去检索已有记忆（`batchDedup`，默认 topK=5），拿到候选池，再**一次性**把所有新记忆 + 去重后的统一候选池送给模型判断。

候选召回策略（`l1-dedup.ts` 头部注释）：原生混合检索（TCVDB dense+sparse）优先；否则 FTS ∥ 客户端向量并行后 RRF 融合；两者都没有就**跳过去重，全部直接 store**。

判定输出四选一：

| action | 语义 |
|---|---|
| `store` | 新信息，新增 |
| `skip` | 已有的更好，新的无增量或更模糊，丢弃 |
| `update` | 同一事实，新的更具体/更晚/纠错，覆盖旧的，可保留旧的中仍正确的细节 |
| `merge` | 同一事实或同一演化过程，互补且不矛盾，合并成一条更完整的 |

三个细节值得单独拎出来：

- **跨 type 合并**：prompt 举了例子，一条 `episodic`"用户在 2018 年开始做播客" + 一条 `persona`"用户有播客制作经验" → 可以 merge 成一条，合并后由模型重新判定 `merged_type`。
- **多对多**：`target_ids` 是数组，一条新记忆可以同时替换多条旧记忆。
- **时间戳并集**：merge/update 时 `merged_timestamps` 必须是所有相关记忆时间戳的并集（去重排序），"保留事件发生的完整时间线"。

统一候选池的构造（`formatBatchConflictPrompt`）也是有意为之：把所有新记忆的候选合并去重成一个池子，再给每条新记忆标注"关联候选 ID 列表"。注释写了理由——"让 LLM 看到全局图景，一次处理跨记忆去重"。也就是说这一批新记忆**彼此之间**的重复也在同一次调用里解决。

### 2.6 可观测性

`L1EmptyReason` 是一个闭集：`llm_error` / `no_json` / `parse_fail` / `not_array` / `empty_scenes`。抽出 0 条时打一行可 grep 的 `l1-empty reason=<label>`。注释写得很直白："这是我们一直希望有的运维抓手——静默的 0 条运行不应该再发生。"

另外 `parseExtractionResult` 里有一段针对 thinking 模型的处理：把 `<think>…</think>` 先剥掉再做数组匹配，因为思考过程里的散装 `[` 会把贪婪匹配锚错位置。用非贪婪 + 强制要求 `</think>` 闭合，防止被 max_tokens 截断的 think 标签吃掉整个响应。

---

## 3. L2：一个被沙箱限制的 Agent，自己用文件工具维护场景文档

文件：`MemoryCore/src/core/scene/scene-extractor.ts`、`prompts/scene-extraction.ts`

L2 不是"把 L1 汇总成一行摘要"。它是**启动一个带文件工具的 LLM agent，让它自己读写一个 Markdown 文档目录**。

### 3.1 输入

由 `createL2Runner`（`MemoryCore/src/utils/pipeline-factory.ts:703`）按游标增量拉取：`queryMemoryRecords(store, { sessionKey, updatedAfter: cursor })`。没有新记录就直接 `{ skipped: true }` 返回，不浪费一次 agent 运行。

拉到的 L1 记录按租户隔离维度分组，每组独立跑一次 SceneExtractor。

送进 prompt 的有三样：
1. 新记忆列表（JSON：content / created_at / id）
2. **现有场景索引摘要**——每个场景的文件名、热度、更新时间、summary，顶部还带一行容量计数 `**当前场景总数：5 / 15**`
3. 当前时间戳

### 3.2 沙箱

`workspaceDir` 被设成 `scene_blocks/`。checkpoint、scene_index、persona.md 对这个 agent **物理不可见**。它没有 exec 工具，只有 `read` / `write` / `edit`。

删除文件的唯一方式是"软删除"——往文件里写 `[DELETED]` 标记，工程侧事后 `unlink`。为什么不写空字符串？因为核心 write 工具的参数校验会拒绝空内容。prompt 里还专门堵了一个漏洞：写 `[ARCHIVE]`、`[CONSOLIDATED]` 之类的标记**不算删除**，文件会继续占配额。

### 3.3 配额压力驱动合并——这是 L2 不膨胀的真正机制

场景文件数硬上限 15。工程侧按剩余量生成三档警告塞进 prompt（`scene-extractor.ts:189`）：

| 场景数 | 注入的约束 |
|---|---|
| ≥ 15 | **必须先 MERGE**，把最相似的 2–4 个合并为 1 个并删除旧文件，降到 15 以下才能处理新记忆 |
| = 14 | **只能 UPDATE，不能 CREATE** |
| ≥ 12 | 建议优先 UPDATE 或主动 MERGE |

prompt 里还定了策略优先级和合并优先级：

- **默认策略是 UPDATE，不是 CREATE。犹豫时选 UPDATE。**
- CREATE 是最后手段，且**前置强制验证**：必须先 `read` 至少 2 个最相似的现有场景，确认融不进去才能建；每批最多新增 1 个。
- 合并优先级：主题高度重叠 → 叙事弧线相同 → 热度最低。

热度管理：新建 `heat=1`，更新 `heat=旧+1`，合并 `heat=sum(所有)+1`。热度既是排序依据也是合并时的牺牲顺序。

### 3.4 场景文件长什么样

固定模板，每个文件 ≤1500 字符：

```markdown
-----META-START-----
created: ...
updated: ...
summary: [30-40 words 摘要，供索引用]
heat: [整数]
-----META-END-----

## 用户基础信息      （列表，可省略）
## 用户核心特征      （**连贯段落，不是列表**，≤100 字）
## 用户偏好          （列表，显性偏好）
## 隐性信号          （模型推断的"没明说但重要"的事，可为空）
## 核心叙事          （**连贯段落**，≤400 字，必须含 Trigger → Action → Result）
## 演变轨迹          （只记偏好/性格/重大观念转变，冲突时不覆盖而是记轨迹）
## 待确认/矛盾点      （当前无法整合的矛盾，等未来记忆澄清）
```

两条硬性写作约束：

- **"用户核心特征"和"核心叙事"禁止列表**，必须是连贯段落。prompt 原话："严禁简单的文本追加。你必须结合上下文重写叙事，将新信息自然地融入其中。"
- **冲突不覆盖**：新旧矛盾时写进"演变轨迹"（带日期和记忆 ID）或"待确认/矛盾点"，不直接抹掉旧的。

work 模式的模板换成 SOP / 判断逻辑 / 禁忌 / 原则 / 经验，并明确禁止把场景块写成"项目日报、聊天摘要或任务清单"。

### 3.5 Agent 跑完之后工程做的六件事

这部分是纯确定性代码，agent 碰不到：

1. **软删除清理**：扫 `scene_blocks/`，内容为空或等于 `[DELETED]` 的删掉；只有 META 头没有正文的（合并后没删干净的残留）也删掉。
2. **文件名归一化**：agent 偶尔会生成带空格/括号的文件名，破坏下游按 `\S+\.md` 解析路径的消费者。工程在 `syncSceneIndex` **之前**重命名，保证索引和所有下游只看到规范名。
3. **重建索引**：`syncSceneIndex` 从磁盘上剩下的非空文件重建 `scene_index.json`。
4. **更新 persona.md 尾部的场景导航**（见下）。
5. **解析带外信号**：扫 agent 的文本输出找 `[PERSONA_UPDATE_REQUEST]reason: …[/PERSONA_UPDATE_REQUEST]`，命中就往 checkpoint 里记一个"请求更新画像"的标记。这是 L2 向 L3 传信号的唯一通道——agent 不能直接写 persona.md。
6. **失败回滚**：Phase 1 先备份整个 `scene_blocks/`，agent 抛异常就从备份恢复，防止半截写入泄漏到下一轮召回。

---

## 4. L3：只看变化的场景，写一份 ≤2000 字符的 persona.md

文件：`MemoryCore/src/core/persona/persona-generator.ts`、`persona-trigger.ts`、`prompts/persona-generation.ts`

### 4.1 触发条件（五选一，按优先级）

`PersonaTrigger.shouldGenerate()`：

| 优先级 | 条件 |
|---|---|
| P1 | L2 agent 通过带外信号显式请求了更新 |
| P2 | 冷启动：首次抽取完成、有场景文件、还没有 persona |
| P2.5 | 恢复：曾生成过但 persona.md 正文现在空了（损坏/丢失） |
| P3 | 首次 Scene Block 提取完成 |
| P4 | 距上次 persona 起累计记忆数 ≥ `triggerEveryN`（默认 50） |

都不命中就不跑。每次 L2 之后评估一次。

### 4.2 增量输入——L3 的成本控制在这里

```ts
const changedScenes = index.filter((e) => {
  if (!cp.last_persona_time) return true;              // 首次：全量
  return new Date(e.updated) > new Date(cp.last_persona_time);
});
```

只读**自上次 persona 生成后 updated 时间更新过**的场景，读全文（含 META）预加载进 prompt。日期解析失败时保守地当作"已变化"。

如果没有变化场景且 persona 已存在 → 直接返回 `false`，不跑模型。

prompt 里把这段包装成：

> ⚠️ **重点分析变化场景**：上述场景是自上次更新后的新增/修改内容，请重点分析这些场景中的新信息。

现有 persona 全文也一并送进去（剥掉尾部导航），并明说"无需 read 工具：当前 persona.md 的完整内容已在用户消息中提供"。

### 4.3 生成逻辑：四层深度扫描

chat 模式的 `PERSONA_SYSTEM_PROMPT` 要求按四层扫：

| 层 | 扫描目标 | 实用价值（prompt 原话） |
|---|---|---|
| 🟢 Layer 1 基础锚点 | 确凿事实、人口统计、当前状态 | 破冰话题和上下文感知 |
| 🔵 Layer 2 兴趣图谱 | 投入时间/金钱/注意力的事物，区分活跃/被动/休眠 | 高质量闲聊和生活推荐 |
| 🟡 Layer 3 交互协议 | 沟通习惯、雷区、工作流偏好 | 指导 Agent 如何说话、如何交付，避免踩雷 |
| 🔴 Layer 4 认知内核 | 决策逻辑、矛盾点、终极驱动力 | 让 Agent 成为能替用户做决策的副驾驶 |

输出模板对应四个 Chapter，外加顶部的 Archetype（一句话原型）、基本信息、长期偏好。Chapter 4 里有"矛盾统一性"和"演变轨迹"两个字段，专门承载不一致的信息。

四条硬禁止：

- **禁止过长**：≤2000 字符（work 模式 ≤1200 字），超了就总结删减。
- **禁止过度推测**：没提到的不要臆想，冷启动阶段尤其要克制，"如果没有相关信息完全可以不填"。
- **禁止使用非场景来源的信息**：不许从 workspace 目录结构、文件路径、系统元数据里提取用户信息。
- **禁止操作 persona.md 以外的任何文件**。

work 模式的 L3 叫 Team Operating Doctrine，额外禁止"项目化碎片"（"项目 v2 要优化"这种）、"流水账"、"低层事实堆积"（项目名/版本号/PR/Issue 一般不进 L3），并要求"每条原则必须脱离原项目也能理解，必须包含动作对象、适用条件或判断逻辑"。

### 4.4 生成后的工程处理

1. 读回 agent 写的 persona.md；没写成功当失败。
2. `stripSceneNavigation` 剥掉 agent 可能自己加的导航段，`escapeXmlTags` 做注入转义。
3. 空内容直接放弃。
4. **工程追加新鲜的场景导航**，写回文件。

第 4 步就是"渐进式披露"的接缝。

---

## 5. Scene Navigation：L3 里那张指向 L2 的地图

文件：`MemoryCore/src/core/scene/scene-navigation.ts`

persona.md 的结尾永远跟着一段由工程生成、按 heat 降序的索引：

```markdown
---
## 🗺️ Scene Navigation (Scene Index)
*以下是当前场景记忆的索引，可根据需要 read 读取详细内容。*

### Path: scene_blocks/技术研究-Rust学习.md
**热度**: 230 🔥🔥🔥 | **更新**: 2026-09-15
Summary: ……

📌 使用说明：
- Path 是 scene block 的路径，可直接使用 **read** 工具读取完整内容
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要
```

重点不在格式，在两个契约：

1. **导航段是工程生成的，不是模型写的。** 生成 persona 前先剥、写回前再追加，所以它永远和 `scene_index.json` 一致，不会被模型写歪。
2. **`renderSceneNavigation` 要求调用方传入 `pathFor` 解析器**，而不是传一个模式开关。注释说明了理由——"后端渲染它自己实际服务的路径，所以导航和读取不可能像 useCos 分支那样漂移"。而那个 `useCos=true` 的分支源码里明确标了 **KNOWN BROKEN**：它发出的路径读不出来（目录名是已删除设计的遗留，且漏了 scope 段），因为导航是在一个带 scope 的存储视图上生成的，而读工具持有的是未加 scope 的根。他们选择不修，因为没有活路径走到那里。

这是个值得记的教训：**索引和读取必须共享同一个路径解析器，否则一定会漂。**

---

## 6. 注入侧：为什么它敢每轮注入 L2/L3

文件：`MemoryProxy/src/injection/index.ts`、`injectors/tdai-profile-memory-injector.ts`

注入规则（`MemoryProxy/src/injection/index.ts:347` 的注释原文）：

> 注意：L0/L1 不再每轮自动召回注入到 user prompt（会破坏 KV/prompt cache）。改为只在 system prompt 暴露只读工具，借助 system prompt cache 复用。L1 recall injector 已下线，`recallL1` 配置保留但不再注册。

于是每轮注入的实际负载是：

```xml
<tdai_profile_memory>
  <agent name="…" role="self" agent_id="…">
    <l3_core_memory>  persona 全文（截断 6000 字符）  </l3_core_memory>
    <l2_scene_index>
      - `scene_blocks/技术研究-Rust学习.md` — summary（截断 200 字符）
      - `scene_blocks/日常生活-健康管理.md` — summary
    </l2_scene_index>
  </agent>
</tdai_profile_memory>

<memory-tools-guide> … </memory-tools-guide>
```

- **L3 注全文**——它稳定、短（≤2000 字符）、是长期画像。
- **L2 只注路径 + summary**——正文让模型自己调 `tdai_read_scene` 按 path 拉。注释写明了两个理由："大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）"、"让 LLM 按需取文，而不是被无关的场景污染上下文"。
- **L0/L1 完全不注**——只在 system prompt 里列工具。

`cacheStrategy = "session_init"`：这块快照在 session 注册后注入一次，不是每轮重算。这才是 KV cache 能复用的原因——**注入块不随 query 变化**。

`MEMORY_TOOLS_GUIDE` 里还写了四条"必须先查再答"的触发场景（用户提及历史 / 涉及自己身份偏好 / 要求你回忆 / 答案强依赖历史事实），以及调用上限："每轮 `tdai_memory_search` + `tdai_conversation_search` 合计 ≤ 3 次"、"检索无果时明确说明'我在记忆里没找到 X'，不要幻想"。

也就是说：**把召回从"自动注入"改成"工具调用"之后，它用 prompt 补了一套触发规则，防止模型干脆不查。** 这是配套动作，不是可选项。

---

## 7. 检索底座

文件：`MemoryCore/src/core/store/tokenize.ts`、`search-utils.ts`

这一层不直接产出记忆，但 L1 的 dedup 候选召回和三个只读工具全靠它。

- **中文分词用 jieba `cutForSearch`**，分完把空格连接的 token 存进独立的 `tokens` 字段；FTS5 / Lucene / TCVDB sparse 三个后端都用朴素空白分词，**不再二次分词**。设计说明写得很清楚：这样写入侧和查询侧的 token 是对齐的。jieba 装不上时回落到 Unicode 正则切分。
- **停用词表刻意做小**，只放高频虚词（的了在是我有和就不人都一…）。
- **token 之间 OR 连接**成带引号的 FTS5 phrase term，命中任一即返回，靠 BM25 让命中更多 token 的文档自然排前——"precision 得以保持的同时 recall 提升"。
- **RRF 融合**：`rrfMerge(lists, getId, k=60)`，多路排序列表按 `1/(k+rank+1)` 求和。
- **向量默认关闭**（`provider = "none"`）。缺 embedding 不是阻塞项。

---

## 8. 五个真正起作用的机制（以及它们各自解决什么）

按我的判断排序，不按它的代码量：

1. **抽取输入是"新消息窗口 + 背景窗口 + 上一个情境名"，不是孤立回合。** 解决的是"只能记住结果"——孤立回合里唯一存在的东西就是结果，前因、决定、约束都在窗口外。
2. **情境切分和记忆抽取在同一次调用里完成，scene_name 挂到每条记忆上。** 这让上层有东西可以聚合。没有这一步，L2/L3 就只能是标签而不是派生层。
3. **写入前先检索已有记忆，让模型出 store/skip/update/merge 决策。** 解决的是重复和矛盾。注意它是**批量**判定，所以同一批新记忆彼此的重复也一起解决了。
4. **L2 是文档 + 配额压力，不是行。** 15 个文件的硬上限 + 三档警告 + "默认 UPDATE 不 CREATE" + CREATE 前强制读 2 个最相似的，共同保证场景数不膨胀、内容被重写而不是被追加。
5. **注入的是画像 + 地图，不是内容。** L3 全文 + L2 索引，正文按需读。这同时解决 token 成本和 KV cache 失效。

配套的两个工程护栏也值得抄：

- **agent 只能碰它该碰的文件**（L2 沙箱到 `scene_blocks/`，L3 只能写 `persona.md`），索引、checkpoint、跨层信号全部由确定性代码维护。
- **层间信号走带外通道**（`[PERSONA_UPDATE_REQUEST]` 文本标记 → checkpoint 字段），而不是让 L2 agent 直接写 L3。

---

## 9. 不要照抄的部分

都是这次读源码时看到的，不是推测：

1. **`shouldExtractL1` 的长度和注入检查被注释掉了**（`utils/sanitize.ts:139-153`）。它的"严格质量门"几乎全在 prompt 里。我们如果照抄结构但不补代码侧门槛，等于把全部质量责任押在一次模型调用上。
2. **dedup 失败时的兜底是"全部直接 store"**（`l1-dedup.ts:194`、`l1-extractor.ts:362`）。可用性优先于质量。我们这边已审阅的知识应该留在 pending/deferred，不该用这个兜底。
3. **`generateSceneNavigation(useCos=true)` 分支是坏的**，上游自己标了 KNOWN BROKEN 并选择不修（无活调用方）。不要把它当参考实现。
4. **团队 ACL、Hub/Proxy 独立部署、三维租户隔离**（teamId/userId/agentId）是多租户 SaaS 的需求，我们是单用户本地优先，不需要。
5. **它的写入路径也是异步 LLM 管线**（L1 两次调用 + L2 一次 agent + L3 一次 agent），不是"写得便宜"。所谓省钱省在**读**——注入的是索引，检索默认 BM25 不用 embedding。

---

## 10. 对照我们当前实现

| 机制 | TencentDB | Aris 现状 | 差距性质 |
|---|---|---|---|
| 抽取输入 | 新消息窗口 + 背景窗口 + 上一情境名 | 单回合 user 3000 + assistant 3000 + tool trace 4000（`desktop/src-tauri/src/memory.rs:712`） | **结构性** |
| 情境 | 抽取时产出 scene_name，挂到每条记忆 | 无 | **结构性** |
| 层级来源 | L1 抽取 → L2 聚合 → L3 聚合 | `target_layer` 由单回合直接指派；v2 无任何聚合代码 | **结构性** |
| 去重 | 检索候选 → 模型出 store/skip/update/merge | `supersede_same_subject` 按 (project,layer,kind,subject) 精确串匹配 | **结构性** |
| L2 载体 | Markdown 文档 + 15 个配额 + 强制合并 | SQLite 行 + 字符配额截断 | **结构性** |
| L3 载体 | persona.md ≤2000 字符 + 场景导航 | SQLite 行，300 字符注入配额 | **结构性** |
| 注入 | L3 全文 + L2 索引，session_init 缓存 | 6000 字符每 query 重算，追加在 system 末尾 | 成本 + 缓存 |
| 中文检索 | jieba 预分词落库 + FTS5 + BM25 + RRF | 整段中文当一个 term 做 `contains`（`crates/runtime/src/research_memory_v2.rs:2428`） | 可局部修 |
| 候选池 | 全库索引检索 | 最近 100 行 + 数 term 出现次数 | 可局部修 |
| 跨会话 | 按租户维度隔离，不按 session | R1 检索被 `session_id=?3` 锁死在原会话 | **一行改动，影响最大** |

最后一行是目前投入产出比最高的：`crates/runtime/src/research_memory_v2.rs:1119` 那个 `AND (layer='r2' OR (layer='r1' AND session_id=?3))` 让 R1 永远出不了原会话。改成按 `scope` 过滤（`scope='session'` 才锁），其余不锁。
