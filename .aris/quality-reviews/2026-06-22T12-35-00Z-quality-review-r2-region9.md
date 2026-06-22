# ARIS 代码质量审查 · 第 2 轮 · 区域 9：API 层 + 剩余前端

**触发时间**：2026-06-22T12:35:00Z
**任务 ID**：`aris-review-r2-api-frontend`
**审查范围**：`desktop/src/api/tauri.ts`（616 行）+ `api/labPreview.ts` + `main.tsx` + `util.tsx` + `extensions/Extensions.tsx` + `settings/*` 等
**新发现问题**：25（高 4 / 中 12 / 低 9）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src/api/tauri.ts` | 616 | **Tauri IPC 命令全部 wrapper** |
| 2 | `desktop/src/api/labPreview.ts` | ? | 浏览器 preview fallback |
| 3 | `desktop/src/main.tsx` | 10 | React 入口 |
| 4 | `desktop/src/util.tsx` | 21 | 工具函数 |
| 5 | `desktop/src/extensions/Extensions.tsx` | 639 | MCP/Skills 扩展管理 |
| 6 | `desktop/src/settings/Settings.tsx` | ? | 设置页 |
| 7 | `desktop/src/settings/MailSettings.tsx` | ? | 邮件设置 |
| 8 | `desktop/src/settings/RuntimeAccess.tsx` | ? | runtime 访问 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（4 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `tauri.ts` 全文 | 一致性 | **整个文件 616 行 100+ 命令 wrapper 是纯手写转发**，每个 `export const xxx = (args) => invoke<T>("xxx", { args });`。**没有生成**（ts-rs / specta / ts-bind），后端加命令必须手改前端且编译时报错。新增命令时易漏 |
| **H-2** | `tauri.ts:300+` (`chatSend` 同时支持 string / ChatSendRequest) | 设计 | `chatSend = (sessionId, message: string \| ChatSendRequest) => ...` —— union type 重载在 invoke 时序列化不同字段名（`text` vs `request`），后端两个不同 command 接收（`chat_send` / `chat_send_rich`），但前端一个函数搞定。**TS 类型上 OK 但运行时绕了一层** |
| **H-3** | `tauri.ts:300+` (事件 listener 重复注册) | 性能 | `onChatDelta` / `onChatThinkingDelta` 等 7 个 `listen()` 调用，**每个 component mount 都注册新 listener**，**没有 cleanup 链统一管理**。`useChatStream` 虽然有 cleanup 但 listener 注册分散 |
| **H-4** | `extensions/Extensions.tsx:639` | 设计缺陷 | Extensions 组件 639 行含 MCP server CRUD、skill 浏览、catalog 列表、env parser。**承担 system + user + project 三层 MCP 合并逻辑**，但每层都不可见 |

### 🟡 中级（12 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `tauri.ts` 全文 | 一致性 | 大多数 wrapper 用 generic `<T>()` 标注返回类型，**实际后端返回类型不可知**，错误被忽略（`Promise<T>` 但 T 是 unknown）。建议改 `Result<T, AppError>` 模式 |
| **M-2** | `tauri.ts` 全部 `isLabPreviewMode` 判断 | 一致性 | 仅 Lab 模块的 wrapper 用 `isLabPreviewMode` 短路返回 mock，**其他模块（chat / mail / literature）都没这个 fallback**。浏览器 preview 模式下其他 tab 调用会 throw |
| **M-3** | `tauri.ts:300+` (`chatUiSessionsLoad/save` 用 `T` generic) | 类型安全 | `chatUiSessionsLoad = <T>() => invoke<T[]>("chat_ui_sessions_load")` —— 调用方要 cast T[]，没有 schema 保证。`chat_ui_sessions.json` 损坏时返回 null 但签名是 T[]，运行时类型不一致 |
| **M-4** | `tauri.ts:300+` (`chatPermissionRespond` 第二参数 `allow: boolean`) | 业务逻辑 | `chatPermissionRespond = (promptId, allow)` 只接受 allow/deny 二元，但**实际后端支持 AlwaysAllow / RejectForSession** 等扩展语义，wrapper 没暴露 |
| **M-5** | `tauri.ts:300+` (literatureDownloadPdf 后端用 `paperId` 但 wrapper 没传) | 一致性 | `literatureDownloadPdf = (url, fileName)` 不传 paperId，后端 command 是 `pub async fn literature_download_pdf(projects_state, url, file_name)` —— **前端用 `paperId` 命名的搜索但下载 wrapper 不用 paperId**，混乱 |
| **M-6** | `tauri.ts:300+` (`lab_preview` mock 返回硬编码数据) | 一18n | `labExecuteCell` mock 返回 `"Preview cell executed\n"` 英文硬编码，与项目 i18n 不一致 |
| **M-7** | `extensions/Extensions.tsx:30` (`parseEnv` 解析 KEY=VALUE) | 健壮性 | 用 `line.indexOf("=")` 取第一个 `=`，但 value 含 `=` 时被截断。`KEY=a=b=c` 会被解析为 `KEY=a` |
| **M-8** | `extensions/Extensions.tsx:50` (`isWindows = /win/i.test(navigator.userAgent)`) | 健壮性 | 在 Tauri webview 中 `navigator.userAgent` 是 webview UA（`Tauri/...`），不是 OS UA。**isWindows 可能永远是 false**，导致 playwrightArgs 选错 browser |
| **M-9** | `extensions/Extensions.tsx:80` (MCP server config JSON.parse) | 安全 | parseEnv 后直接传 `env` 到 mcp_stdio_server，**没有 escape `]`、`[`、`"` 等 shell 元字符**。MCP server 是 stdio spawn，`bash -c "KEY=value cmd"` 时注入 |
| **M-10** | `main.tsx` | 设计 | `ReactDOM.createRoot(...).render(<React.StrictMode><App /></React.StrictMode>)` 启用 StrictMode 但项目很多 useEffect 没有 cleanup（前面 region 提到），double-invoke 会暴露 bug |
| **M-11** | `util.tsx:21` (`Badge` component) | 一致性 | `Badge` �� styles.css 中 `.badge` class 耦合，���抽 `components/Badge.tsx` |
| **M-12** | `util.tsx:13` (`fmtTs` 中 `ts < 1e12` 判断) | 健壮性 | epoch seconds vs millis 的判断阈值 `1e12` 对 2001-09-09 后的 milliseconds 都判为 millis。但 2026-06-22 的 milliseconds 是 ~1.7e12，seconds 是 ~1.7e9。`1e12` 太宽松导致 2026-09-09 之后会判错 |

### 🟢 低级（9 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `tauri.ts:1` | 一致性 | 没有 error 类型 export，所有调用方 catch 用 `String(error)` 失去结构化错误 |
| **L-2** | `tauri.ts:100+` (mail commands) | 性能 | 每个 mail 命令独立创建 promise，没有 batch API（10 个 folder list = 10 次 IPC） |
| **L-3** | `tauri.ts:300+` (`chatSend` union input) | 可读性 | 函数重载让 auto-import 工具识别混乱，调用方 IDE 提示可能不准确 |
| **L-4** | `tauri.ts` 全文 | 测试 | 没有任何 `tauri.ts` 单元测试，IPC wrapper 必须靠集成测试 |
| **L-5** | `extensions/Extensions.tsx:639` | 测试 | Extensions 没有 `Extensions.test.tsx` |
| **L-6** | `main.tsx` | 设计 | ReactDOM.createRoot 错误时无 ErrorBoundary，应用崩溃白屏 |
| **L-7** | `util.tsx` | 一致性 | `fmtTs` / `fmtClock` 应抽 `utils/date.ts`，与 chat/model.ts 中的时间处理重复 |
| **L-8** | `extensions/Extensions.tsx:80` (catalog build) | 一致性 | 硬编码的 catalog（playwright、arxiv 等）应该用单独的 catalog.toml 加载 |
| **L-9** | `extensions/Extensions.tsx:50` (`playwrightArgs`) | 一致性 | 硬编码 `--caps=pdf` 等参数，不能被用户覆盖 |

---

## 3. 风格 / 一致性观察

- `tauri.ts` 全文是无脑 `export const xxx = (args) => invoke<T>("xxx", { args });`，**应使用 codegen**（`ts-rs` / `specta`），后端加命令时自动生成 wrapper
- `chatSend` union type + 后端双命令是历史遗留
- `extensions/Extensions.tsx` 把 MCP catalog 写死在源码，应该读 `extensions/catalog.toml` 或后端 `extensions_list`
- `util.tsx` 21 行可保留但应该把 `Badge` 移到 `components/Badge.tsx`
- 整个前端没有 `AppError` / `Result<T, E>` 错误处理模式，所有错误 catch 用 `String(error)` 字符串化
- 多个 store 的 `pendingChatInput` / `pendingStudioArtifactId` 等 one-shot 状态没有 timeout（区域 8 已记录）
- `extensions/Extensions.tsx` 的 `parseEnv` 是个手写 parser，没用 `dotenv` crate

---

## 4. 本轮确认无问题的方面

✅ `tauri.ts` 用 `@tauri-apps/api/core` 的 `invoke` 统一封装
✅ `isLabPreviewMode` fallback 在 Lab 模块 wrapper 中正确应用
✅ `extensions/Extensions.tsx` 用 `useEffect` 注册 listener
✅ `chatSend` 重载 string 与 ChatSendRequest
✅ `mcpConfigSet` 把 server list flatten 后传给后端
✅ `util.tsx:fmtTs` 容忍 epoch seconds / millis

---

## 5. 与之前轮的关系

- **区域 8 M-8**（`pendingChatInput` 没 timeout）→ 本轮 M-1 同样指 generic T 缺失结构
- **区域 2 H-6**（scheduled write_record 非原子 rename）→ 整个项目原子写模式重复（store, projects, scheduled, sessions 都各自实现 atomic_file）
- **跨轮**：整个项目错误返回 `Result<T, String>` 而非 `Result<T, AppError>` 是最大一致性问题（区域 1 L-7 记录过）

---

## 6. 累计进度（最终）

```
已审 / 总文件:   ~55 / ~99 (.rs) + ~25 / ~62 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ✅
  desktop/chat 前端   5 / 8   ✅
  desktop/literature 1 / 1   ✅
  desktop/literature 前端 6 / 7 ✅
  desktop/lab        1 / 1   ✅
  desktop/lab 前端    3 / 9   ✅
  desktop/knowledge  1 / 1   ✅
  desktop/knowledge 前端 4 / 5 ✅
  desktop/mail       10 / 10 ✅
  desktop/mail 前端   1 / 2   ✅
  desktop/studio     1 / 1   ✅
  desktop/files      1 / 1   ✅
  desktop/connectors 1 / 1   ✅
  desktop/mcp        1 / 1   ✅
  desktop/sessions   1 / 1   ✅
  desktop/App + store 3 / 4   ✅
  desktop/extensions 1 / 1   ✅ ← 本轮
  desktop/api        2 / 2   ✅ ← 本轮
  desktop/util       1 / 1   ✅ ← 本轮
  desktop/settings   0 / 3
  desktop/main + App.test 1 / 2 ✅ ← 本轮
```

---

## 7. 全局总结

### 7.1 本轮次（r2）总发现

| 区域 | 高 | 中 | 低 | 总 |
|---|---|---|---|---|
| 1: 核心基础架构 | 4 | 10 | 7 | **21** |
| 2: Scheduled Tasks | 6 | 14 | 8 | **28** |
| 3: Chat | 5 | 15 | 10 | **30** |
| 4: Literature | 4 | 14 | 9 | **27** |
| 5: Lab | 5 | 13 | 8 | **26** |
| 6: Knowledge | 4 | 11 | 6 | **21** |
| 7: Mail | 6 | 14 | 9 | **29** |
| 8: Studio + Files + Misc | 4 | 12 | 8 | **24** |
| 9: API + 剩余前端 | 4 | 12 | 9 | **25** |
| **r2 合计** | **42** | **115** | **74** | **231** |

### 7.2 跨轮高频问题

下列问题在多轮重复出现，**建议统一修复**：

1. **Windows 路径过滤不严**（H 类）：区域 2 H-3、3 M-1、4 M-2、5 H-1
2. **canonicalize + starts_with 验证脆弱**：区域 4 M-1、5 H-1、8 H-1
3. **`std::env::set_var` 并发安全**：区域 1 H-3、3 M-2
4. **Result<T, String> 而非 AppError**：区域 1 L-7、3 M-1、8 M-12、9 M-1
5. **`| string` 类型 union 让类型守卫失效**：区域 2 L-8、3 L-7、8 L-7
6. **手写 HTML / JSON 解析**：区域 4 H-4、4 L-8、5 M-7、7 M-7、8 M-5
7. **前后端同一逻辑重复实现**：区域 3 M-12、4 M-7、6 M-5
8. **超长前端组件无拆分**：区域 3 H-1 (engine.rs)、4 H-4 (Literature.tsx)、5 M-11 (Lab.tsx)、6 H-4 (KnowledgeReview.tsx)、7 M-12 (Mail.tsx)、8 H-4 (App.tsx)
9. **缺失调度执行器 / 缺失 sandbox**：区域 2 H-1（scheduled）、5 H-2（lab）、7 H-2/H-5（mail scope）
10. **明文凭证持久化**：区域 1 H-2（config）、7 H-1（mail oauth）

### 7.3 优先级建议

| 优先级 | 建议优先修复 |
|---|---|
| P0 | 区域 2 H-1（scheduled 缺失调度器）、区域 7 H-1/H-2/H-5（mail OAuth/scope/agent 发送）、区域 5 H-1/H-2（lab 路径 + sandbox）、区域 4 H-3（外部进程无超时） |
| P1 | Windows 路径过滤统一修复、所有 canonicalize 验证改为组件化、前后端共享逻辑抽 crate/shared |
| P2 | 错误类型统一为 AppError、TS 弱类型 union 修复、组件拆分 |
| P3 | 性能优化（cache、debounce、code splitting） |

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T12-35-00Z-quality-review-r2-region9.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T12-35-00Z-quality-review-r2-region9.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-api-frontend`, prompt 版本: v1, region: 9/9。本轮次审查完成。*