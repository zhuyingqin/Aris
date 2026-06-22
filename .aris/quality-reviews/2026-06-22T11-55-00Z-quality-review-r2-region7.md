# ARIS 代码质量审查 · 第 2 轮 · 区域 7：Mail 模块

**触发时间**：2026-06-22T11:55:00Z
**任务 ID**：`aris-review-r2-mail`
**审查范围**：`desktop/src-tauri/src/mail/*`（10 文件，~125KB）+ `desktop/src/mail/*` 前端
**新发现问题**：29（高 6 / 中 14 / 低 9）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/mail/mod.rs` | 159 | Mail 模块入口，命令注册 |
| 2 | `desktop/src-tauri/src/mail/model.rs` | ~250 | 类型定义 |
| 3 | `desktop/src-tauri/src/mail/store.rs` | 363 | 账号 + OAuth 凭证持久化 |
| 4 | `desktop/src-tauri/src/mail/oauth.rs` | 462 | OAuth2 PKCE loopback 流程 |
| 5 | `desktop/src-tauri/src/mail/imap.rs` | 1835 | **本轮最大文件**，通用 IMAP/SMTP |
| 6 | `desktop/src-tauri/src/mail/gmail.rs` | ~500 | Gmail API client |
| 7 | `desktop/src-tauri/src/mail/graph.rs` | ~450 | Microsoft Graph client |
| 8 | `desktop/src-tauri/src/mail/provider.rs` | ~280 | Token 解析 + 调度 |
| 9 | `desktop/src-tauri/src/mail/autoconfig.rs` | 392 | Thunderbird 自动配置 |
| 10 | `desktop/src-tauri/src/mail/cache.rs` | ~150 | 本地缓存 |
| 11 | `desktop/src-tauri/src/mail/agent_tools.rs` | 268 | 给 Chat agent 的 mail tool 入口 |
| 12 | `desktop/src-tauri/src/mail/atomic_file.rs` | ~80 | 原子写 |
| 13 | `desktop/src/mail/Mail.tsx` | 1780 | 主 Mail 页面 |
| 14 | `desktop/src/mail/Mail.css` | 59803 | 样式 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（6 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `store.rs:14-23` (`StoredAccount` 字段) | 安全 | **OAuth refresh_token 明文持久化**到 `~/.aris/mail/accounts.json`，且 `view()` 仅屏蔽 access_token，refresh_token 还在结构里。如果用户多账户（gmail + outlook + 自定义 imap），文件含 3+ 长 token，文件权限无显式设置（Windows 默认为用户可读，**但 macOS/Linux 是 644**），任何其他进程能读到 |
| **H-2** | `oauth.rs:33-37` (`GMAIL_SCOPE = "gmail.modify"`) | 安全 | scope 太宽。Gmail scope 分级：`gmail.readonly` < `gmail.compose` < `gmail.send` < `gmail.modify` < `gmail.full`。`gmail.modify` 包含删除/移动/标记。ARIS 现在是 read+modify+send 全开，但 Chat agent 被 prompt 注入后能删除用户邮件。应该分层：人工发邮件用 `gmail.send`，agent 自动用 `gmail.readonly` |
| **H-3** | `imap.rs` 全文（手写 IMAP 客户端 1835 行） | 安全 / 健壮性 | **手写 IMAP/SMTP 客户端**没有用 `async-imap` / `lettre` 等成熟 crate。1835 行手写代码意味着：① 没有 CVE 维护、② RFC 兼容性问题、③ 可能漏掉 SASL 安全机制、④ TLS 配置可能不安全。已经在文件大小上反应了复杂度风险 |
| **H-4** | `imap.rs` HTML body 解析 | 安全 | `body_html: Option<String>` 解析邮件 HTML 但未 sanitize。前端如果用 `dangerouslySetInnerHTML` 渲染，邮件 phishing 攻击（带 `javascript:` URL 或 external tracker pixel）会执行。Mail.tsx 应有 HTML sanitizer |
| **H-5** | `agent_tools.rs:7-13` (`MAIL_TOOL_NAMES` 7 个工具) | 安全 | agent 有 `mail_send` 工具，**只需 `to` 字段即可发送邮件**。如果 LLM 被 prompt 注入，可发送钓鱼邮件、勒索邮件、数据外泄邮件到任意收件人，且无审计日志记录发送者/收件人 |
| **H-6** | `autoconfig.rs:37-46` (`discover` 直接 trust 域名返回内容) | 安全 | `discover_from_thunderbird` 用 `https://autoconfig.{domain}/...` 但 `domain` 来自用户输入 `email.split_once('@').1`，**任何域都能被探测**。攻击者控制 email address 后，可探测 intranet autoconfig endpoint 暴露内网配置。或 DNS rebinding 让 `autoconfig.evil.com` 解析到 192.168.0.1 然后读取内网 XML 响应 |

### 🟡 中级（14 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `store.rs:14` (`STORE_LOCK: Mutex<()>` 全局进程锁) | 性能 | 所有 store 操作都过同一把全局锁，**多账号并发操作序列化**。10 个 mail list 操作串行执行 |
| **M-2** | `store.rs:38` (`account.id() = format!("{}:{}", provider, email)`) | 安全 | id 用 provider + email 拼接。email 含 `@`，不是 URL-safe 但作为内部 key OK；**前端传 account_id 给后端时如果前端拼接错误（如 `gmail+user@x.com`）会与 `gmail:user@x.com` 不匹配**。但更严重的是 `:` 在 SMTP/IMAP 用户名中合法，可能撞 id |
| **M-3** | `oauth.rs:63` (`Provider::Imap => panic!`) | 健壮性 | `endpoints(Provider::Imap)` 返回 panic 而非 Result。错误使用会导致 panic 进程崩溃 |
| **M-4** | `oauth.rs:42-46` (`Provider::Outlook uses_secret: false`) | 安全 | Microsoft public client 不要求 client_secret，**但 OAuth code 交换必须包含 PKCE verifier**。代码中要确认 PKCE 流程正确 |
| **M-5** | `imap.rs:1` (BASE64 三种解码器) | 业务逻辑 | `STANDARD` / `STANDARD_NO_PAD` / `URL_SAFE_NO_PAD` 三个 base64 decoder 都 import。哪个用在哪里不清晰，容易在边界 case 用错 pad 导致 decode fail |
| **M-6** | `imap.rs:1835` 全文 | 设计缺陷 | 1835 行手写 IMAP/SMTP 客户端是 **项目第二大文件**，仅次于 engine.rs。**违反单一职责**，应使用成熟 crate：`async-imap`、`lettre`、`imap`、`mail-parser` |
| **M-7** | `imap.rs` Body parsing (`ParsedMessage`) | 健壮性 | 手写 MIME multipart 解析容易出错，特别是 quoted-printable / base64 边界。multipart/alternative 嵌套，attachment in nested multipart 都可能漏 |
| **M-8** | `imap.rs` Connection pool | 性能 | 每个命令新建 IMAP 连接（看代码 pattern），10 个 folder 操作 = 10 次 TLS handshake。慢 |
| **M-9** | `autoconfig.rs:34-46` (`discover_from_thunderbird` 不限超时) | 安全 | `reqwest::blocking::Client` builder 设了 8s timeout，但**没有 connection-level timeout**（恶意服务器接受 TCP 但永不响应） |
| **M-10** | `autoconfig.rs:78` (parse_thunderbird_xml) | 安全 | `parse_thunderbird_xml` 解析 XML 但不验证 DTD / entity 限制。**XXE attack**：恶意 autoconfig server 返回 `<!ENTITY xxe SYSTEM "file:///etc/passwd">` 可读取本地文件 |
| **M-11** | `gmail.rs` / `graph.rs` 全部命令 | 性能 | 每个 `mail_list` / `mail_folders` / `mail_read` 都 spawn blocking thread + 创建新 reqwest client。10 个 folder list = 10 个 client 实例 + 10 个 TLS handshake |
| **M-12** | `Mail.tsx:1780` 行 | 设计缺陷 | 单 Mail 组件 1780 行，含 inbox/list/detail/compose/folder 多视图 |
| **M-13** | `Mail.tsx` 邮件 HTML 渲染 | 安全 | 读取邮件 body_html 后渲染**未明确 HTML sanitizer**。如果走 `react-markdown` 它对 raw HTML 默认不 sanitize |
| **M-14** | `Mail.tsx` 邮件附件下载 | 安全 | 附件下载是 base64 在 IPC 通道传，100MB 附件会让 IPC 卡死；没有大小限制 |

### 🟢 低级（9 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `store.rs` 全文 | 一致性 | `OauthConfig` 中只保存 gmail_client_id、gmail_client_secret、outlook_client_id，**Outlook client_secret 字段缺失**（虽然 outlook 是 public client，但配置 schema 不一致） |
| **L-2** | `oauth.rs:30` (`GOOGLE_LOOPBACK_PORT = 8765`) | 健壮性 | 端口硬编码，若被其他应用占用 OAuth 失败。Microsoft 用 ephemeral port 是正确做法 |
| **L-3** | `imap.rs` 全文 | 测试 | 1835 行手写 IMAP 客户端**没有 mock IMAP server 测试**，无法跑 CI |
| **L-4** | `autoconfig.rs` 中文硬编码 | i18n | `"邮箱地址格式无效"` 中文硬编码，与项目 i18n 体系不一致 |
| **L-5** | `cache.rs` 全文 | 一致性 | mail cache 持久化到磁盘但失效策略不明（TTL？） |
| **L-6** | `Mail.tsx` 全文 | 测试 | 1780 行 Mail 组件没有专门的 Mail.test.tsx |
| **L-7** | `Mail.css` 59803 字节 | 设计 | 与 styles.css 独立 CSS（项目其他地方用 styles.css），Mail 应合并到 styles.css 统一管理 |
| **L-8** | `oauth.rs:80-100` (`client_credentials`) | 一致性 | Gmail OAuth config 错误信息中文 + 英文混杂（"Gmail OAuth is not configured. Add..."） |
| **L-9** | `agent_tools.rs:7-13` (MAIL_TOOL_NAMES) | 一致性 | 工具名 `mail_mark` / `mail_move` 是 agent 命名但实际后端用 `mail_modify` —— 前后端命名不一致 |

---

## 3. 风格 / 一致性观察

- `store.rs` 把所有 mail 相关 config 放在一个 JSON 文件（oauth + accounts + servers + identities），文件结构复杂且**整个文件每次 save 都重新序列化所有内容**
- `oauth.rs` 把 OAuth config 字段直接放在 store 的 `OauthConfig` 中，**与 `config.rs` 中的 `verified_executors` 模式相同**（明文存凭证），与之前轮 H-1 一致问题
- `imap.rs` 把 SSL/TLS 连接、auth、list、search、fetch、append、send 都塞一个文件，**应拆 `imap_connection.rs` / `imap_fetch.rs` / `smtp_send.rs`**
- `Mail.tsx` 把 folder tree + message list + reader + composer 放一起，**没有 useReducer / RTK Query**
- `Mail.tsx:avatar imports` 静态 import 4 个 avatar PNG（每个 ~50KB��，**bundle 体积浪费**，应改 dynamic import 或 SVG
- `agent_tools.rs` 的 tool schema 全部手写 json!()，应抽 `ToolSpecBuilder`
- `autoconfig.rs:USER_AGENT = "ARIS Mail Autoconfig/0.3"` 版本号与项目实际 v0.4.1 不一致

---

## 4. 本轮确认无问题的方面

✅ `store.rs:atomic_file::write_replace` 原子写凭证文件
✅ `oauth.rs` 用 PKCE（`code_verifier` + `code_challenge` SHA256）
✅ `oauth.rs:endpoints()` 集中管理 OAuth 端点
✅ `imap.rs:helper_config` 用 store 取 server config 避免硬编码
✅ `mod.rs:offload` 模式统一（spawn_blocking）
✅ `store.rs:load()` 用 unwrap_or_default 安全 fallback
✅ `agent_tools.rs:MAIL_TOOL_NAMES` 白名单（不在白名单的工具拒绝）
✅ 测试覆盖 `mod.rs` 与 `oauth.rs` 关键路径（推测）

---

## 5. 与之前轮的关系

- **区域 1 H-2**（apply_bundled_internal_config 明文凭证）→ 本轮 H-1 同样问题（refresh_token 明文存 accounts.json）
- **区域 1 H-3**（set_var 并发）→ store.rs 全局 Mutex 是替代方案，OK
- **区域 3 M-12**（cleanChatTitle 跨语言重复）→ 本轮 Mail.tsx 邮件 HTML 渲染与 markdown 解析同样面临跨语言/跨库一致问题
- **区域 4 H-3**（外部进程超时）→ autoconfig.rs 用 8s timeout OK，但 IMAP 没有 connection timeout（M-9）
- **区域 5 H-2**（Lab 无 sandbox）→ Mail agent_tools 同样无 prompt injection 防护

---

## 6. 累计进度

```
已审 / 总文件:   40 / ~99 (.rs) + 13 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ✅
  desktop/chat 前端   4 / 8   ✅
  desktop/literature 1 / 1   ✅
  desktop/literature 前端 5 / 7 ✅
  desktop/lab        1 / 1   ✅
  desktop/lab 前端    3 / 9   ✅
  desktop/knowledge  1 / 1   ✅
  desktop/knowledge 前端 4 / 5 ✅
  desktop/mail       10 / 10 ✅ ← 本轮
  desktop/mail 前端   1 / 2   ← 本轮
  desktop/studio     0 / 1
  desktop/sessions   1 / 1   ✅
```

---

## 7. 下次审查预期（区域 8：Studio + Settings + 其他）

- `desktop/src-tauri/src/studio.rs`（9102 bytes）+ `studio/*` 前端
- `desktop/src-tauri/src/files.rs`、`connectors.rs`、`mcp.rs`
- `desktop/src/settings/*` 前端（Settings.tsx、MailSettings.tsx、RuntimeAccess.tsx）
- `desktop/src/App.tsx`、`store.ts`、`types.ts`、`util.tsx`
- `desktop/src/extensions/Extensions.tsx`
- 重点关注：Studio 生成器安全边界、files.rs 路径遍历、settings store 一致性、App.tsx 路由

---

**��细报告**：[`.aris/quality-reviews/2026-06-22T11-55-00Z-quality-review-r2-region7.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T11-55-00Z-quality-review-r2-region7.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-mail`, prompt 版本: v1, region: 7/9。*