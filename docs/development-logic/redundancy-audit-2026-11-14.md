# 全仓冗余与缺陷复审（2026-11-14，codex/release-0.4.89）

范围：`crates/`、`desktop/src-tauri/src`、`desktop/src`，约 49 万行（Rust 30.9 万，TS/TSX 17.6 万）。三路只读审计，每条死代码结论都附有全仓 grep 证据。前一轮审计见 `redundancy-decoupling-plan.md`、`codebase-overall-audit.md`（2026-07）。

## 一、本轮已落地（低风险，已验证）

| 项 | 改动 |
|---|---|
| `config.json` 写坏/丢设置 | `save_object` 改走 `runtime::write_file_atomically`；四个读-改-写 helper 共用进程内锁；无法解析的旧文件在覆盖前备份为 `config.json.unreadable-<秒>` |
| mail 自带原子写 | 删 `mail/atomic_file.rs` 及其测试，4 个调用点改用 runtime 版（多了路径锁和 Windows 重试） |
| 死 `run-event` 轮询线程 | 删 `watcher::spawn_event_watcher`（每 500ms 读 events.jsonl，前端监听自 v0.3.3 起为 0） |
| LiteParse 子进程 | 改走 `hidden_command`，补上项目执行上下文 |
| `#[allow(dead_code)]` | 4 个仅测试用的 helper 改 `#[cfg(test)]`；2 处过时的 allow 删除；`match_id` 的 reason 改为实情 |
| WebFetch 跨域重定向带认证头 | origin 变化时剥离 Authorization/Proxy-Authorization/Cookie/x-api-key/X-Subscription-Token（新增测试） |
| 中文标题检索去重塌缩 | `normalized_title` 只保留 ASCII，纯中文标题的键全是 `title:`，无 DOI 的中文论文被合并成一条；改为保留 Unicode 字母数字（ASCII 标题键不变，新增测试） |
| memory v2 读错环境变量 | `ARIS_CONFIG_DIR`（全仓唯一一处）改为 `somniq_config_dir_from_env()`；生产不设该变量，路径不变 |
| 非原子写 | `runtime/oauth.rs` 凭据“先删后改名”、`tools/lib.rs::write_json_object` 直接写，均改原子写 |
| 前端 ErrorBoundary | Literature/Workflows/官方插件页/Extensions/Settings 各自一层；以前任一页崩溃会连带卸载常驻的 Chat/Code |
| 聊天图片 MIME 表 | ChatComposer 与 chatRunHelpers 的逐字副本合并为 `imageFiles.chatImageMimeType` |
| 文献检索协议线类型 | `workflowTypes.ts` 的手写副本（已漂移，缺 `cancelled`）改为从 `literatureTypes.ts` 重新导出 |

验证：`cargo test -p runtime -p tools --lib` 984+343 全过；desktop `cargo test --lib --test-threads=1` 1063 过 1 败（败的是既有问题，见二.1）；vitest chat/workflows/literature/App 60 文件 828 例全过；`tsc --noEmit`、`npm run build` 通过。

## 二、待办：缺陷（按优先级）

1. **既有红测**：`system_prompt::the_completion_contract_only_promises_a_reviewer_that_will_run`。`crates/runtime/assets/prompts/system.md:35`（31511e6e，0.4.88 Word 工作流）无条件写了 “configured independent Reviewer”，关闭评审时 prompt 仍提到 Reviewer。
2. **同步命令卡主线程**：全仓 168 个同步 `#[tauri::command]`。重活包括 `literature_import_pdf_as_record`（抽全文）、`literature_image_ocr`（子进程无超时）、`typeset_export_project`（打 zip）、`file_duplicate`（递归复制）、`chat_ui_sessions_save`。修法：`async` + `blocking::off_main_thread`。
3. **大块二进制走 JSON 数组**：`literature_pdf_bytes` 返回 `Vec<u8>`，OCR 入参最大 24MB；改用 `tauri::ipc::Response`（`files.rs` 已有先例）。
4. **用户可见错误绕过 `formatUserFacingError`**：约 200 处 `String(error)`，集中在 Workflows 34、Literature 23、literatureStore 22、FigureStudio 14、Extensions 12。路径/URL/密钥可能原样显示。
5. **Anthropic SSE 未知事件让整条流失败**：`api/src/types.rs` 的 `StreamEvent`/`ContentBlockDelta` 没有 `#[serde(other)]`。
6. **剩余非原子写**：`tools/runs.rs:122`、`tools/literature.rs:8110`（备份-删-改名）、`hot_memory.rs:509`、`oracle_web.rs` 三份备份交换、`engine.rs:11828`/`typeset_state.rs:1652` 先删后改名。
7. **配置根目录不认 `ARIS_CONFIG_ROOT`**：`event_sink.rs:241`、`cache.rs:132`、runtime `lib.rs:326`；`hot_memory.rs`/`knowledge_memory.rs` 仍用旧目录 `~/.config/aris`。
8. **锁中毒连锁**：`notebook/src/manager.rs` 12 处 `lock().unwrap()`。
9. **无上限增长**：`meta/events.jsonl` 不轮转；compute job 日志只追加；MCP 发现缓存不清过期键。
10. **其他**：Retry-After 已解析但未执行（固定 1s/2s）；`tools/literature.rs::http_client()` 每次新建 Client；`PendingComputePairing` 派生 Debug 含密钥；`knowledge.rs::stable_hash` 用 `DefaultHasher`；主包 2.2MB（gzip 718KB）。

## 三、待办：冗余（语义 PR，各自单开）

- **模型族分类散在 8+ 处**且语义不一（starts_with/contains、大小写、`vendor/` 前缀）：chat `model_developer`/`max_tokens_for_model`、executor `openai.rs:274/900/1328/2244`、`reasoning_effort.rs`、tools 评审路由、`usage.rs`、desktop `engine.rs:4683`。应收敛为单一 `ModelFamily` 分类器。
- **SSE 分帧两份**：`api/src/sse.rs` 与 `executor/openai.rs::StrictSseLineBuffer`。
- **文献 identity 规范化**：标题 3 份、arXiv 去版本 2 份、DOI 规范化两半各管一半。
- **research_memory v1**：5.4k 行，生产只用到几个类型和 helper；与 v2 有 8 个同名 helper。
- **小 helper**：时间 13 个命名函数 + 38 处内联（runtime 缺毫秒版）、`sha256_hex` ×5、SQLite 打开 ×6（busy_timeout 2s/5s 不一）、`validate_session_id` ×3（trim 规则已漂移）、`is_cjk` ×6（码段不一）、spawn_blocking 包装 ×3、按字符截断 ×6。
- **前端**：路径 basename/dirname ~15 处、字节格式化 10 份、复制+“已复制”计时器 13 处、Tauri 事件 listen/unlisten 样板约 30 处、localStorage JSON 读写约 20 处、工具名集合与后端不同步（`FILE_CHANGE_TOOL_NAMES` vs toolSummaries）、49 个调用方自定返回类型的 `invoke<T>`。

## 四、需要产品决定（疑似死代码，可能是未接线功能）

- 前端不可达：`knowledge/` 整套（约 1.5k 行，及 6 个 `knowledge*` 包装）、`chat/NewTaskDialog`、`literature/MathText.tsx`、`typeset/pdfSearch.ts`。
- 只被测试 mock 的命令：`git_stage/unstage`、`literature_rag_search`、`literature_read/write_annotation_export`、`memory_governance_*`、`typeset_history_*`。
- 无前端调用：`figures_export_raster`（栅格编辑器没有 PNG 导出入口）。
- crates 零调用 pub：`in_flight_plugin_runs`、`purge_legacy_derived`、`library_relations_at`、`library_update_saved_searches_at`。
- `tencentdb_memory.rs` + postgres 依赖仍在（靠 `SOMNIQ_TENCENTDB_MEMORY_URL` 开启），与“已删除”记录矛盾。

## 五、仓库卫生

- `target/` 140GB；`target-codex-release-0.4.87`/`0.4.88` 两个旧构建目录约 9GB，可删。
- `crates/runtime/src/retrieval_guard.rs:2579` 字符串里曾有字面 NUL 字节，rg/grep 会把整个文件当二进制跳过、审计漏看；已改成 `\0` 转义（字节相同，47 个相关测试通过）。
