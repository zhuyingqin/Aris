# 0.4.83 发布范围与验收

基线为已发布的 `v0.4.82`，发布分支为 `codex/release-0.4.83`，在独立工作区 `F:\Agent\Aris-0.4.83` 中只改 Scopus 适配器及其版本来源；主开发目录的未提交内容不进入本次发布。

## 主要变化

- Scopus 新增学校通道：`POST https://somni.ensuanx.com/research/scopus/search`，请求体按学校 `SearchRequest`（`query`、`view: STANDARD`、`count ≤ 200`、`cursor`、`include_abstracts: false`，按日期排序时加 `sort`），并解析学校原生响应（`entries[]`、`total_hits`、`pagination.next_cursor` / `has_more`、`quota`）。
- 账号凭证：`Authorization: Bearer <登录访问令牌>` 与 `New-Api-User: <用户 id>`，与网关管理员接口用来向 New API `/api/user/self` 校验身份的头相同。令牌只发给与签发账号服务同源（scheme + host + port）的网关；运行记录与请求预览中只写 `SomniQ account session (redacted)`。
- 路由：没有 `SCOPUS_API_KEY` 时直接走学校通道；有 key 时先直连 Elsevier（COMPLETE），遇到 401/403 时，本次搜索剩余部分改走学校通道，不再做注定失败的 STANDARD 重试。未登录时保留原来的 COMPLETE→STANDARD 一次降级。
- 可用性：有 key 或已登录即视为可用；两者都没有时，仍记录为明确的 unauthorised 来源尝试。"已登录"只读本地配置，不读钥匙串，也不联网。Settings 中 Scopus 密钥改为"可选"。
- 学校通道不请求摘要补全：补全最多会额外调用 25 次上游，消耗所有用户共享的学校额度。同一记录在 OpenAlex / Crossref 中的摘要会在去重合并时补上。

## 与网关的依赖

- 当前生产网关的 Scopus 路由还不校验账号，Nginx 会删除该路由的 `Authorization` 头。因此本版本发出的凭证暂时会被忽略，学校通道照常可用。
- 第 1 步（Site 仓库）给 Scopus 路由加账号验证时，必须接受上述两个头，并把它们原样转发给 New API `/api/user/self` 做校验；Nginx 需要单独为 `/research/scopus` 放行 `Authorization`。
- 在第 1 步上线前已发布的旧桌面版（≤ 0.4.82）只会直连 Elsevier，校外仍不可用。

## 发布验证

- tools crate：312 通过、1 忽略（含 12 个新增 Scopus 路由测试）。新测试用本地 HTTP 夹具覆盖：学校请求格式与请求头；Elsevier 401/403 后切换；已登录时 Elsevier 成功则不碰学校通道；未登录时的 STANDARD 回退；无路由、会话失效、网关拒绝三种情况的 unauthorised 分类；无 `entries` 的响应报错；真实学校响应样本的字段映射；凭证同源检查。
- Rust 工作区 1,478 通过、5 忽略；Desktop 原生库 943 通过、14 忽略；资源脚本测试与 TypeScript 通过；前端生产构建通过。
- 完整 Vitest：1,947 个测试中 1,939 个通过。另外 8 个失败都出现在与 cargo 并行运行时，其中 5 个是 5 秒超时；这 5 个文件单独重跑后 127/127 全部通过。`scripts/tests/macos-resources.test.cjs` 属于 node:test 脚本，由 `npm run test:scripts` 运行并通过。
- 线上验证：用适配器生成的请求体（`view: STANDARD`、`include_abstracts: false`、`cursor: "*"`、`sort: "-coverDate"`、`count: 2`）向 `https://somni.ensuanx.com/research/scopus/search` 发送 1 次请求，返回 HTTP 200、294 条命中，`entries` / `pagination` / `quota` 字段与解析器一致；学校本周剩余额度 19,969 / 20,000。这次请求没有携带账号凭证，因为当前网关尚未校验身份。真实桌面端的登录态检索留到安装后验证。
