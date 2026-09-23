# 独立账号实施记录：第一阶段

日期：2026-09-23。范围：独立账号服务、新用户算力连接、Site 预览入口和上游兼容检查。

## 代码基线

按用户要求，先将当时全部工作树保存到 `0.4.72` 并推送远端，提交为
`a2c0ff789807fccfed8bf4c3abb9ad99c4e5777a`。已通过 `git ls-remote` 核对远端提交一致。
此后的账号工作位于 `codex/somniq-identity`，保留上述备份分支作为改动前基线。

本次没有切换生产登录入口，也没有更新生产 New API、修改余额或迁移设备关系。

## 已实现

1. `site/account-server`：独立 Rust 工作区，使用标准 OIDC 库校验签名、issuer、audience、nonce、PKCE 和已验证邮箱。
   用户以 `issuer + sub` 绑定自己的稳定 UUID。服务端 HttpOnly 会话与 New API 的可用性分离。
2. 服务协议按用户、版本、正文摘要、原文快照与接受时间保存。未经主动接受当前协议不能开通或调用算力。
3. New API 适配器：以同一身份完成上游 OIDC，核对上游 `oidc_id`，保存双向唯一账户映射，
   使用该用户的真实会话创建/复用模型 Key；上游凭据加密保存，刷新与开通按用户串行处理。
4. 固定的 `/v1/models` 和 `/v1/chat/completions` 入口支持服务端代持凭据和流式响应。
   客户端不会取得 New API 登录令牌、刷新 Cookie 或模型 Key。
5. Site 增加 `account.html`，支持中英西三语、协议接受、算力连接、额度与用量、退出和故障提示。
   设置 `VITE_ACCOUNT_MODE=independent` 时，账号按钮和控制台进入此预览；默认构建保持现有行为。
   独立身份没有转换为旧的数字用户 ID，也没有读取旧 token 或冒用旧设备关系。
6. `deploy/newapi` 记录实际运行基线和候选版本；GitHub Actions 验证新版本后可提出候选更新草稿 PR。
   校验同时识别版本名中的 RC 和 GitHub 元数据，不根据 `latest` 直接发布生产。

当前生产只读盘点为 New API `v1.0.0-rc.39`、PostgreSQL 15、Redis 8。
固定的镜像 digest 与上游提交见 `deploy/newapi/version.lock.json`；rc.40 的候选元数据在相邻的 `candidate.json`。

## 验收结果

| 验证 | 结果及范围 |
| --- | --- |
| Rust `cargo test --locked` | 11 项通过，包括身份稳定、错误 vault key、加密完整性、跨用户映射限制、重复 Cookie 拒绝、同意检查、并发刷新、代理与故障隔离 |
| 真实签名 OIDC 测试 | nonce、audience、issuer、过期令牌、未验证邮箱等反例均拒绝；有效登录成功，回调不可重放 |
| Rust fmt / clippy | 格式检查及 `--all-targets -- -D warnings` 通过 |
| Site / PWA Vitest | 33 个文件、219 项通过；新增 5 项验证独立身份、Cookie 请求、无旧凭据回退和额度单位 |
| 前端构建 | 默认 Site `build:web`、独立模式完整 `npm run build`（含 PWA）通过 |
| New API rc.39 | 官方二进制校验发布 SHA-256；真实 Keycloak 26.7.4、真实 Site 浏览器、全新本地数据库完成登录、同意、连接、Key、流式调用、额度、重复连接、退出重登与停机隔离 |
| New API rc.40 | 官方二进制校验发布 SHA-256；RSA 签名 OIDC fixture、全新数据库完成相同账号与算力接口链路 |
| 页面 | 实际检查 1280px 桌面和 390px 手机画面，无横向溢出；浏览器没有保存上游凭据 |
| 上游更新策略 | 3 项测试通过；候选元数据已从官方 GitHub 与镜像仓库读取 |
| 部署描述 | Compose 通过 `docker compose config --quiet`；workflow YAML 解析通过 |

可提交的脱敏报告在 `site/account-server/validation/`。原始测试数据库、密钥、日志和浏览器错误记录留在 Git 忽略目录中。
模型渠道全程使用本地 fixture，没有付费调用或生产数据写入。

实际排查并修复了 Site 开发代理漏接带查询参数的 OAuth 回调，以及测试对重复连接跳转的等待时机。
并行构建时，rc.40 曾返回明确的 `system_cpu_overloaded`（本机 CPU 超过其 90% 阈值）；
停止并行构建后串行验收通过，没有关闭该保护或修改上游源码。

本机 Docker 引擎未能启动，因此 **没有声称容器栈或服务 Dockerfile 已运行验收**。
真实身份验证改用官方 Keycloak ZIP 与本机 JDK，在新目录、新数据库中执行。
提交 `486fe05c714772c29e481c7c334962d0586be234` 的
[GitHub Linux 全链路检查](https://github.com/zhuyingqin/Aris/actions/runs/35834525726)
也已通过，包括真实 Keycloak、浏览器与两个官方 New API 版本的接口验证。

## 启动与升级

完整配置与命令见 [`site/account-server/README.md`](../../site/account-server/README.md)。
Web 会话是 24 小时固定有效期；首次实现使用 SQLite/WAL，限单进程。
服务端密码学和 OIDC 使用现有库，没有自建密码认证协议。

仓库默认分支为 `aris-code`。计划任务只有合入默认分支后才自动生效；
只读核查发现仓库当前未开启 Actions 创建/批准 PR 的权限。
自动草稿提案默认关闭；启用时需配置相应权限和仓库 Actions 变量 `NEWAPI_UPDATE_DRAFT_PRS=true`。
不开启提案开关时，版本发现、兼容测试和验证报告仍正常运行。
当前升级流程固定生产版本、更新候选元数据、验证兼容性和提出草稿，不自动发布到生产。

## 下一阶段的具体入口

1. 部署独立身份测试域名、SMTP、品牌注册和找回密码流程；完成真实新用户注册、邮箱验证和恢复验收。
   本次浏览器使用已验证邮箱的种子测试账号，只检查了注册和恢复入口存在。
2. 实现旧 New API 账号控制权验证与官方绑定流程，包括 MFA/Passkey；核验原有余额、日志和模型权限。
   禁止按相同邮箱或用户名自动合并，也不为老用户直接开一个空余额账户。
3. 为 Desktop 设计设备会话和续期，将 PWA 与远程网关迁移到带版本的 SomniQ 身份映射，保留本机配对授权。
   预览账户不能用于旧的设备面板、订单或订阅接口。
4. 增加账号生命周期管理、全设备撤销、限流与运行指标；完成数据库备份恢复及生产 PostgreSQL 升级演练。
5. 在上述条件通过后，提交明确的生产切换与回滚记录。独立账户预览不能直接视为生产迁移完成。
