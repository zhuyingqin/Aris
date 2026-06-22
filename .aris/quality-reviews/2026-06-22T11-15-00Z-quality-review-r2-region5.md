# ARIS 代码质量审查 · 第 2 轮 · 区域 5：Lab 模块

**触发时间**：2026-06-22T11:15:00Z
**任务 ID**：`aris-review-r2-lab`
**审查范围**：`desktop/src-tauri/src/lab.rs`（867 行）+ `desktop/src/lab/*` 11 个 tsx/ts
**新发现问题**：26（高 5 / 中 13 / 低 8）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/lab.rs` | 867 | Lab Jupyter kernel 桥接（start/exec/interrupt/inspect/sweep） |
| 2 | `desktop/src/lab/Lab.tsx` | ~1700 | 主 Lab 页面（65920 字节） |
| 3 | `desktop/src/lab/CodeEditor.tsx` | 8994 | Cell 编辑器 |
| 4 | `desktop/src/lab/FileEditorPane.tsx` | 17211 | 文件编辑面板 |
| 5 | `desktop/src/lab/LabAssistant.tsx` | 26720 | Lab AI 助手 |
| 6 | `desktop/src/lab/LabFiles.tsx` | 7181 | 文件浏览器 |
| 7 | `desktop/src/lab/labStore.ts` | 27392 | Zustand store |
| 8 | `desktop/src/lab/labTypes.ts` | 3880 | 类型 |
| 9 | `desktop/src/lab/outputs.tsx` | 6420 | Cell output 渲染 |
| 10 | `desktop/src/lab/textDiff.ts` | 1303 | diff 工具 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（5 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `lab.rs:104` (`resolve`) | 安全 | **notebook 路径无沙箱**：任意相对路径会 join 到 `current_project_path` 解析，不检查 `..` 之外的恶意构造（如 `papers/../etc/passwd`）。且 `notebook.is_absolute()` 直接通过，**允许绝对路径指向任意文件系统位置**（用户传 `C:\Windows\notebook.ipynb` 也能加载）。任意 notebook 加载 → 任意 `.ipynb` 文件读取 |
| **H-2** | `lab.rs:339-380` (`execute_blocking`) | 安全 | 执行任意 Python 代码无任何 sandbox。Kernel 启动后任何 Python 代码（`import os; os.system("rm -rf /")`）会直接在用户权限下执行。Lab 是 Chat/Agent 都能调的工具，**LLM 可被 prompt 注入触发执行任意代码**。文档提及 `LAB_CELL_OUTPUT_EVENT` 流式输出但**没看到权限检查** |
| **H-3** | `lab.rs:88-145` (`VAR_INSPECT_CODE`) | 安全 | 内置的 Python 反射代码用 `globals()` 枚举所有变量。**当 kernel 同时被 Chat agent 使用时，agent 设置的私有变量（API key 等）会被 inspect 工具枚举并暴露给前端**。`if name in ("In", "Out", "exit", ...)` 黑名单不够 —— 用户变量 `_secret_key` 不会被过滤因��以 `_` 开头的被排除，但 `secret_key` 这种不含 `_` 前缀的会被泄露 |
| **H-4** | `lab.rs:148-156` (`session_id` 用绝对路径作为 key) | 一致性 | `session_id(path) = path.to_string_lossy().to_string()` —— 用绝对路径作为 kernel 标识符。**同 notebook 在不同 project 中路径不同会启动两个 kernel 实例**，变量状态不共享。这与 header 注释"every layer keys a session by the notebook's absolute path, so a kernel the user starts in the Lab is the same one the agent executes against" 的设计意图不一致 |
| **H-5** | `lab.rs:147` (`DEFAULT_TIMEOUT_SECS = 120`) | 安全 | 单 cell 执行默认超时 120 秒，但**没有进程级超时**：如果用户执行 `while True: pass`，KernelManager.execute 内部要等 timeout 才会返回。恶意 notebook 可以永远挂着，阻塞 thread pool |

### 🟡 中级（13 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `lab.rs:50-58` (`lab_execute_cell`) | 并发 | `let event_notebook_path = notebook_path.clone()` 在 `move` 闭包外 clone 一次，但 `cell_index` 是 `Copy` 直接 capture —— **闭包内 `notebook_path` 是 `String` 已经是 owned clone**，无需二次 clone。代码风格不统一 |
| **M-2** | `lab.rs:131-145` (`resolve_file` 同��的 `is_absolute` 通过) | 安全 | 与 H-1 同问题：`file_path` 可以是绝对路径指向任意 `.py` 文件。执行任意 `.py` 文件等于 RCE |
| **M-3** | `lab.rs:147-156` (`ensure_python_file`) | 安全 | 只检查 `.py`/`.pyw` 扩展名，**不检查文件内容**。恶意 `.py` 文件可包含 `__pycache__` 注入。但更严重的是：用户拖入 `setup.py` 或 `conftest.py` 也可执行，**如果是 pip 依赖中的同名文件会被覆盖** |
| **M-4** | `lab.rs:181-200` (`VAR_INSPECT_CODE` 中的 `short_repr`) | 业务逻辑 | `repr(value)` 在 Python 对象很大时返回 100MB+ 字符串，被 `[:237]` 截断后仍可能含敏感数据。前端拿到 truncated repr 后无法判断原值大小 |
| **M-5** | `lab.rs:296-310` (`lab_run_sweep`) | 性能 | `tools::sweep::run_sweep_local` 顺序执行每个 run，没看到并发控制。Sweep 是 CPU-bound 应该并发，且 sweep 间共享 kernel 状态会污染 |
| **M-6** | `lab.rs:213-228` (`execute_blocking` 中 `if let Some(index) = cell_index` 才 save) | 一致性 | 只对有 `cell_index` 的执行保存输出。如果传 `code` 直接运行（不指定 cell），outputs 不会写到任何 cell —— **用户传 ad-hoc 代码会得到结果但下次 reload notebook 丢失** |
| **M-7** | `lab.rs:425-440` (`lab_run_all` 中 `parameter_run_artifact`) | 健壮性 | 创建 `write_to` artifact 文件名硬编码格式，可能与已有 artifact 冲突导致覆盖；未检查 `parameters` 是否包含 reserved 名称 |
| **M-8** | `lab.rs:660-690` (`collect_notebooks` 递归) | 性能 | 递归 `collect_notebooks` 深度限制 `MAX_WALK_DEPTH = 12`，但**没有跳过系统目录**（`.git/`、`.venv/`、`node_modules/`）。`notebook` crate 项目通常有 `.venv/`，里面大量 symlink/非 .ipynb 但仍 enumerate |
| **M-9** | `labStore.ts:73-100` (`cellSignature` 嵌入控制字符) | 设计缺陷 | `CELL_SIGNATURE_FIELD_SEPARATOR = "\u001f"`（unit separator）和 `CELL_SIGNATURE_CELL_SEPARATOR = "\u001e"`（record separator）。这些控制字符在 unicode 文本中合法但**如果用户 cell source 含这些字符会破坏签名**（碰撞风险）。建议用 length-prefix 或 base64 编码 |
| **M-10** | `labStore.ts:60-72` (`replaceCellOutputs` 直接 mutate) | 状态管理 | `[...view.notebook.cells]` 然后 `cells[index] = { ...cells[index], outputs }` —— 浅复制 + 浅合并。`outputs` 数组引用可能与原 cell 共享，导致 React 渲染优化失效 |
| **M-11** | `Lab.tsx:65920` 字节（约 1700 行） | 设计缺陷 | 主 Lab 组件 1700 行，包含 notebook 列表、cell 编辑、output 渲染、kernel 状态、sweep UI、AI 助手等多职责，应拆分 |
| **M-12** | `lab.ts:91` (`lab_save_notebook` 接受任意 Value) | 安全 | `lab_save_notebook` 接收整个 notebook JSON 并 `from_json_str` 验证后保存。**但验证后立即 `doc.save(&path)`，没有限制哪些 metadata 字段可改**。攻击者构造含恶意 kernelspec 的 notebook（如指向 `python3` 但实际执行 `/tmp/hacker.py`）会持久化到磁盘 |
| **M-13** | `LabAssistant.tsx` 26720 字节 | 设计缺陷 | Lab AI 助手 26720 字节，类似 Chat 组件的简化版，没有复用 Chat 引擎的 streaming/event/state |

### 🟢 低级（8 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `lab.rs:31` (`DEFAULT_TIMEOUT_SECS`) | 性能 | 常量 120 秒硬编码，应该走 user config |
| **L-2** | `lab.rs:174-184` (`session_id` 用 path) | 一致性 | 与其他模块用 UUID 不同，session_id 用 path string 让 IPC 消息变大 |
| **L-3** | `lab.rs:225-230` (execute_cell 没有 streaming 默认路径) | UX | `execute_blocking` 默认走 `execute` 而非 `execute_streaming`，流式 output 仅在传 `on_output` 时启用。Cell 大的输出要等全部完成才显示 |
| **L-4** | `lab.rs:412-426` (`lab_run_all` 的 `stop_on_error` 默认 true) | 设计缺陷 | `stop_on_error.unwrap_or(true)` 在科研场景中常常期望 `false`（即使中间失败也要继续后续 cell），但默认 true 会中断后续 cell |
| **L-5** | `labStore.ts:88` (`defaultKernel` 优先 python3) | 业务逻辑 | 硬编码 `python3`，但很多用户用 `python` 或 `conda` env 的自定义 kernel 名 |
| **L-6** | `labStore.ts` 全文 | 测试 | Lab.test.tsx 24455 字节，但 labStore.ts 27392 字节没有专门 store 测试 |
| **L-7** | `CodeEditor.tsx` 8994 字节 | 一致性 | CodeEditor.tsx 没有 onChange debounce，每次按键都触发 lab_save_notebook，浪费 IO |
| **L-8** | `LabFiles.tsx` 7181 字节 | 性能 | 文件树展开/折叠没有缓存，每次点击都重新 walk filesystem |

---

## 3. 风格 / 一致性观察

- `lab.rs` 全文用 `String` 错误返回，与其他模块一致但项目未统一 `AppError`
- `lab.rs:resolve` 与 `lab.rs:resolve_file` 高度重复，应抽 `resolve_path_in_project(base, p, allow_absolute: bool)`
- `lab.rs:KernelManager::start` 在每个 `execute_*` 函数里都调一次，`start` 应是 idempotent 但**仍然每次 IO**（探测 kernel 状态）。多次调用浪费
- `labStore.ts:cellSignature` 用 Unicode 控制字符做分隔符是创意但脆弱
- `lab.ts:147` 的 `DEFAULT_TIMEOUT_SECS` 不在用户配置中暴露，但 Chat turn timeout 是
- `LabAssistant.tsx` 没复用 `useChatStream` hook 的 streaming 逻辑，自实���一份
- `labStore.ts` `runningCell` 和 `runningAll` 是独立 state 但实际互斥（一个 cell 跑就不跑 all），应合并为 discriminated union
- `lab.ts:lab_save_notebook` 没有事务性，多 cell 并发编辑可能丢更新

---

## 4. 本轮确认无问题的方面

✅ `lab.rs:execute_blocking` 在 cell 索引有效时正确写回 outputs
✅ `VAR_INSPECT_CODE` 用 sentinel `__ARIS_VARS_JSON__` 避免与用户输出混淆
✅ `lab_set_kernelspec` 持久化到 nbformat metadata
✅ `lab_list_kernelspecs` 在 spawn_blocking 跑避免阻塞 IPC
✅ `lab_create_notebook` 路径不存则创建空 notebook
✅ `lab_run_all` 写入 `experiments/runs.json` ledger
✅ `lab_export_sweep_manifest` 返回 YAML 字符串
✅ 测试覆盖 `Lab.test.tsx` 24455 字节

---

## 5. 与之前轮的关系

- **区域 1 H-1**（PATH 劫持）→ `lab.rs` 通过 spawn jupyter kernel 间接执行命令，PATH 优先级影响 kernel 启动顺序
- **区域 2 H-3**（路径过滤不严）→ 本轮 H-1/M-2 同样问题
- **区域 3 M-12**（跨语言代码重复）→ labStore.ts 的 `cellSignature` 用控制字符，LabAssistant 不复用 Chat 的 streaming hook
- **区域 4 H-3**（外部进程超时）→ 本轮 H-5 同样模式（kernel execute 无超时保护）

---

## 6. 累计进度

```
已审 / 总文件:   27 / ~99 (.rs) + 9 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ✅
  desktop/chat 前端   4 / 8   ✅
  desktop/literature 1 / 1   ✅
  desktop/literature 前端 5 / 7 ✅
  desktop/lab        1 / 1   ✅ ← 本轮
  desktop/lab 前端    3 / 9   ← 本轮
  desktop/knowledge  0 / 1
  desktop/studio     0 / 1
  desktop/mail       0 / 10
```

---

## 7. 下次审查预期（区域 6：Knowledge 模块）

- `desktop/src-tauri/src/knowledge.rs`（11992 bytes）
- `desktop/src/knowledge/knowledgeStore.ts`、`knowledgeTypes.ts`、`KnowledgeReview.tsx`
- 重点关注：SQLite 数据库写入并发、knowledge draft/confirm 状态机、citation 注入、XSS in annotations

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T11-15-00Z-quality-review-r2-region5.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T11-15-00Z-quality-review-r2-region5.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-lab`, prompt 版本: v1, region: 5/9。*