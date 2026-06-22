# ARIS 代码质量审查 · 第 2 轮 · 区域 1：核心基础架构

**触发时间**：2026-06-22T10:00:00Z
**任务 ID**：`aris-review-r2-core-infra`
**审查范围**：`desktop/src-tauri/src/{lib,main,state,commands,config,projects,watcher,process}.rs`（共 8 个文件）
**新发现问题**：21（高 4 / 中 10 / 低 7）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/lib.rs` | 382 | 应用启动、命令注册、关闭清理 |
| 2 | `desktop/src-tauri/src/main.rs` | 6 | 入口点 |
| 3 | `desktop/src-tauri/src/state.rs` | 187 | 全局路径 / 环境变量 / 项目状态辅助 |
| 4 | `desktop/src-tauri/src/commands.rs` | 81 | 顶层 Tauri commands（skills、URL） |
| 5 | `desktop/src-tauri/src/config.rs` | 1352 | 配置读写、verified executor 仓库、provider 连接测试 |
| 6 | `desktop/src-tauri/src/projects.rs` | 471 | 项目注册表与激活 |
| 7 | `desktop/src-tauri/src/watcher.rs` | 60 | events.jsonl 轮询 tailer |
| 8 | `desktop/src-tauri/src/process.rs` | 9 | 隐藏子进程 wrapper |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（4 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `lib.rs:103-138` (`augment_path_for_desktop_tools`) | 安全 / 一致性 | 用户安装目录（`%APPDATA%\nvm`、`%APPDATA%\npm`、scoop shims 等）被无验证地 prepend 到进程 PATH 的最前面。任何能在这些路径下写入文件的本地应用（包括被劫持的包管理器）都会先于系统命令解析到，构成进程级命令劫持 |
| **H-2** | `config.rs:299-303` (`apply_bundled_internal_config` + `_internal.overwriteExisting`) | 安全 | 当 internal-config.json 设置 `overwriteExisting: true` 时，应用会在用户已配置 executor/reviewer/scopus 之后继续覆盖其值（删除 reviewer_provider 时静默置空）。这是潜在的供应链后门：任何控制 resource_dir 的攻击者都能改写用户的关键凭据与端点，且 `eprintln!` 一行就完成了全部审计 |
| **H-3** | `config.rs:692-741` (`apply_reviewer_environment_from` + `set_memory_write_approval`) | 并发安全 | Tauri command 函数跨线程调用 `std::env::set_var/remove_var`，Rust 标准库明确标注 `set_var` 在多线程程序中是 **unsafe**（已在 1.74+ 改为 `unsafe`，本项目仍可能因 build-std 编译期未升级而被掩盖）。Tauri runtime 启动后���有多个 worker 线程在跑；环境变量并发写入会导致数据竞争 / 撕裂读，且 reviewer 切换 race 时可能把空字符串写回进程环境 |
| **H-4** | `state.rs:104` (`apply_project_environment` 末尾 `std::env::set_current_dir(workspace)`) | 并发安全 | 切换项目时调用 `set_current_dir` 改变整个进程的 cwd。`FilePathMenu`/`useChatStream`/`engine` 等子线程在切换瞬间可能正在打开相对路径文件，会读到下一项目的目录内容。同时 Tauri 自身的 plugin（如 dialog/updater）也会继承这个 cwd，行为难以预测 |

### 🟡 中级（10 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `lib.rs:158-170` (`hide_stray_console`) | UX / 健壮性 | `AllocConsole` + `ShowWindow(SW_HIDE)` 之间存在窗口可见的窗口闪烁窗口（typical 1-3 帧），且当用户运行 `tauri dev` 从终端启动时也会触发，遮盖 dev 输出。推荐使用 `AllocConsole` + `SetWindowPos(SWP_HIDEWINDOW)` 或干脆让依赖自行处理 |
| **M-2** | `lib.rs:124` (硬编码 pipx 路径 `qbz5n2kfra8p0`) | 一致性 | pipx 默认虚拟目录包含 Windows 应用包 hash，Python 升级或 reinstall 后该路径会失效；这是 silent fallback，应至少日志警告 |
| **M-3** | `state.rs:115` (`migrate_dir` 用 `rename`，且 `let _ = remove_dir(&legacy_claude)`) | 健壮性 | `migrate_dir` 用 rename 而不是 copy，跨盘/跨用户目录时会失败（`os error 17` / `os error 18`）。即便 rename 成功，后续 `remove_dir` 失败也不会重试，意味着 legacy 数据残留但 next launch 不再迁移 |
| **M-4** | `state.rs:54-62` (`runtime_dir` 与 `config_dir` 不支持环境变量覆盖) | 一致性 | `workspace_dir` 支持 `ARIS_WORKSPACE_ROOT`，但 `runtime_dir` / `config_dir` / `sessions_dir_for_project` 都硬编码 `runtime::home_dir()`。测试与多用户场景无法隔离运行时目录 |
| **M-5** | `state.rs:88` (`valid_project_id`) | 安全 | ID 验证只看格式（`project-` + 16 位十六进制），但不验证它对应当前 `project_id(path)` 哈希。攻击者如果在共享主机或被恶意项目文件诱导，可手工构造 `project-aabbccddeeff0011` 形式的 ID 访问他人的 runtime 目录 |
| **M-6** | `config.rs` 大量重复 | 代码复用 | `get_str` / `get_non_empty` / `mask` / `value_is_missing_or_empty` / `set_or_clear` / `set_secret` / `set_memory_write_approval` 中的写入逻辑都是手写 JSON Value 操作，整套逻辑没有抽到 `JsonMapExt` 之类的 trait / util，验证与修改 key 时容易漏写一边（如 `set_memory_write_approval` 没调用 `save_object`，把目录创建逻辑又写了一遍） |
| **M-7** | `config.rs:619-657` (`record_verified_executor` 明文存 API key) | 安全 | `verified_executors` 数组明文持久化 executor / reviewer 的 API key 到 `config.json`。如果 `apply_bundled_internal_config` 被触发，或项目目录被同步盘上传，密钥会随文件泄露。建议：使用 OS keyring 或单独 `secrets.json`（至少限制 fs 权限 600） |
| **M-8** | `projects.rs:78-86` (`project_id` 使用 FNV-1a 64-bit) | 设计缺陷 | 项目 ID = FNV-1a 64-bit 哈希（`{:016x}`）。生日攻击：~50 亿个项目时碰撞概率 50%。实际项目数量达不到，但理论上存在碰撞；与此同时 `valid_project_id` 不验证 hash 与路径对应，碰撞将让两个项目共享 runtime 目录 |
| **M-9** | `projects.rs:108` (`ensure_switch_allowed` 通过 `tools::execute_tool("Workflow", ...)`) | 性能 / 设计 | 切换项目前通过字符串 JSON 跨 crate 调用 Workflow 工具查询运行状态，每次 ~5-50ms 的 IPC 开销，并且依赖 Workflow 工具的 schema 没变。应该把 Workflow 运行状态缓存到内存或一个明确的 ChatState 字段 |
| **M-10** | `watcher.rs:24-55` (基于字节 offset 的 UTF-8 tail) | 健壮性 | `offset += consumed.len() as u64` 在多字节字符截断处会乱码。当文件以单字节偏移增长时不会触发；但当 events.jsonl 中出现非 ASCII（中文 session title 等），把 `buf` 通过 `read_to_string` 强制 UTF-8 解码时如果最后一次写入尚未完整，UTF-8 解码失败但 `read_to_string` 返回 `Ok(len)` 的截断 buf，会导致 offset 漂移（多字节字符只计数 1-2 个字节，下次读时再计数 2-3 个，永久漏行） |

### 🟢 低级（7 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `lib.rs:104` (`prepend_existing_path_entries` 用 `Vec` + `extend` 再 `join_paths`) | 性能 | 在热路径（每次启动）分配 Vec + 多次字符串拼接；可改用 `OnceCell<Vec<PathBuf>>` 缓存 |
| **L-2** | `lib.rs:228-230` (`eprintln!("ARIS internal config import skipped: {error}")`) | 可观测性 | 使用 `eprintln!` 而非项目自身的 `tracing`/`log`，release 包也输出到 stderr，桌面应用把日志写到用户的终端会触发反病毒软件告警 |
| **L-3** | `commands.rs:60-72` (`open_external_url` 仅按 scheme 白名单过滤) | 安全 | `view-source:`、`jar:`、`file:` 等 scheme 未列入白名单确实被拦，但 `javascript:` / `data:` 也已正确拦截。然而实现用 `split_once(':')`，形如 `https://example.com\n.evil.com` 的换行注入测试用例已在单元测试覆盖但失败模式是 OK；建议进一步用 `url::Url` 解析 |
| **L-4** | `config.rs:760-790` (`test_anthropic` 与 `test_openai_compat` 大���复制构造 `ConfigTestDetail`) | 代码复用 | 两函数内 `ConfigTestDetail { ok, label, provider, model, base_url, message }` 重复 3 次，可以抽象 `ConfigTestDetail::from_result` / `ConfigTestDetail::fail` 工具函数 |
| **L-5** | `projects.rs:54-60` (`clean_canonical_path` 处理 `\\?\` 前缀) | 健壮性 | 只 strip `\\?\UNC\` 转回 `\\`，对 `\\?\C:\...`（带盘符）落回 fallback；但 `\\?\Volume{guid}\...` 这种 Volume 形式没处理，某些网络挂载点或 junction 会保留 `\\?\`，后续 `is_dir` 调用不可预期 |
| **L-6** | `process.rs`（整个文件） | 设计缺陷 | 仅 9 行透明转发 `runtime::hidden_command`，除 `process.rs` 与 `runtime` 双重模块边界外无任何价值。建议直接删除并调用 `runtime::hidden_command` |
| **L-7** | `commands.rs` 所有 Tauri command 错误返回 `String` | 一致性 | `Result<_, String>` 不便于前端 i18n / 结构化错误处理（无法区分 network/auth/validation 等类别）。已有 `ApiError` 等枚举，建议统一封装 `Result<_, AppError>` 由前端做映射 |

---

## 3. 风格 / 一致性观察

- `config.rs` 中 `apply_bundled_internal_config` 写入分支与 `set_memory_write_approval` 都重新实现了 `state::config_path()` 的目录创建 + JSON 序列化逻��，应统一抽到 `save_object`
- `state::apply_project_environment` 与 `state::apply_bundle_cache_environment` 都用 `std::env::set_var`，但没有用任何 mutex / RwLock 保护；Tauri 启动后这两个函数会被多处调用
- `projects::ProjectState` 用 `Mutex<ProjectRegistry>`，但同一进程里 `config.rs` 没有任何锁，每次 `load_object` 都直接 `read_to_string` 然后解析；并发场景下读到的可能是半写入状态
- `engine::ChatState::cancel_all_running_turns` 在 `cleanup_before_exit` 中通过 `app_handle.state::<...>().inner()` 调用 `chat_state.inner()`，但 `cleanup_before_exit` 没有等 turn 真正结束就直接 `runtime::terminate_all_managed_processes` —— 这会先杀进程再让 chat 中途退出，前端事件流可能悬挂
- 测试代码用 `Mutex<()>` 做全局锁 (`static ENV_LOCK: Mutex<()> = Mutex::new(())`) 在并行测试下会序列化所有用例；建议按 key 拆锁（`Mutex<HashMap<&'static str, ()>>`）
- `desktop/src-tauri/src/state.rs:55` 与 `lib.rs:110` 中两处都构造 `~/.config/aris/...` 路径，应抽到 `state::config_dir().join(...)` 防止散落

---

## 4. 本轮确认无问题的方面

✅ 关闭清理函数使用 `Once::call_once` 防止重复触发
✅ `commands::open_external_url` 对 `javascript:` / `data:` 的拦截覆盖完整
✅ `config_get` 不会泄露明文 API key（mask 始终走 `••••` 或 4+4）
✅ `projects::load_registry` 在解析失败时安全 fallback 到 default
✅ `watcher.rs` 用 `rfind('\n')` 避免截断半行
✅ 单元测试覆盖 `F-1` 风格的 `overwriteExisting` 删除场景
✅ `apply_reviewer_environment` 在 provider 为空时显式写 `"none"`

---

## 5. 与上一轮的关系

- 上一轮（[Issue #23](https://github.com/zhuyingqin/Aris/issues/23)）审查的是 `crates/api/*` 与 `crates/aris-cli/build.rs`
- 本轮（区域 1）切到 desktop 端的核心基础设施，共 8 文件，发现 21 问题
- 整体累计：约 11 个文件 / ~85 个问题待跟进

---

## 6. 累计进度

```
已审 / 总文件:   11 / ~99 (.rs)
按区域进度:
  crates/api/        6 / 6   ✅ 完成
  crates/aris-cli/   1 / N
  desktop/core       8 / 30  ← 本轮（区域 1）
  desktop/chat       0 / 8
  desktop/mail       0 / 10
  desktop/literature 0 / 1
  desktop/lab        0 / 1
  desktop/knowledge  0 / 1
  desktop/studio     0 / 1
  desktop/前端       0 / 62 (.ts/.tsx)
```

---

## 7. 下次审查预期（区域 2：Scheduled Tasks）

- `desktop/src-tauri/src/scheduled.rs`（13997 bytes，本地已有未提交修改）
- `desktop/src/scheduled/ScheduledTasks.tsx`（已有未提交重大重构）
- `desktop/src/api/tauri.ts`（已加新 command wrapper）
- 重点关注：未提交修改引入了哪些回归、ChatState 切换是否与 Chat 项目绑定冲突、session_id 验证是否足以防注入

---

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-core-infra`, prompt 版本: v1, region: 1/9。*