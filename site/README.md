# SomniQ Studio — 官网落地页 / Landing page

SomniQ 的统一网页目录：包含官网首页、账号控制台、远程 PWA 与 Rust 远程网关。网页与桌面应用解耦构建，中英双语，语言状态存 `localStorage`
（`somniq-site-lang`），首次访问按 `navigator.language` 猜测。

A unified Vite + React web surface for SomniQ Studio: marketing pages, account
dashboard, remote PWA, and the Rust remote gateway. The web UI remains
independently deployable from the desktop app and is bilingual (zh/en).

## 开发 / Development

```bash
npm --prefix site install
```

```bash
npm --prefix site run dev
```

Dev server: <http://127.0.0.1:5180>（端口固定，避开桌面端的 1420 / 5173）。

也可以用仓库根的 `.claude/launch.json` 里的 `somniq-site` 配置启动。

## 构建 / Build

```bash
npm --prefix site run build
```

一次命令会依次构建官网/控制台、`site/remote` PWA 与 `site/server` Rust
网关。静态产物统一位于 `site/dist/`，其中远程页在 `site/dist/remote/`；
服务端 release 二进制位于 `site/server/target/release/`。

## 用户服务协议

`user-service-agreement.html` 的中、英、西三语正文在 `src/userServiceAgreement.ts`，
由 `src/LegalApp.tsx` 渲染目录、重要条款和主体信息。
`src/agreementConfig.ts` 中的 `USER_SERVICE_AGREEMENT_VERSION` 同时用于正文展示和支付授权请求；发布修订时同步维护版本及
更新日期，并由账户服务保留注册时实际接受的版本、同意记录和对应正文快照。

运营主体默认全称为“重庆应算科技有限公司”，可通过 `VITE_SOMNIQ_MERCHANT_LEGAL_NAME`
覆盖；联系地址通过 `VITE_SOMNIQ_MERCHANT_ADDRESS` 配置。缺失的信息保留“待确认”，不能据此认定已完成
对外经营主体披露。正文没有代替完整的隐私告知，也没有实现退款、注销或支付服务；
相关实际处理流程须与发布条款一致。

本次条款核对参考：[民法典](https://www.court.gov.cn/zixun/xiangqing/233181.html)、
[消费者权益保护法实施条例](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2024/art_0aea188276a44f0baf940ab95ee00e0a.html)、
[个人信息保护法](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)。

## 自动续费接入

公开定价页仅展示套餐信息。用户注册须在注册弹窗中单独勾选《用户服务协议》；
登录后的 `dashboard.html?tab=plan` 展示自动续费金额、周期、取消路径与默认不勾选的代扣授权框。
统一使用 `user-service-agreement.html`：第九至十一章包含购买、扣款授权、取消和退款规则。
购买确认及会员管理链接直达 `#legal-auto-renewal`，不再要求接受第二份协议。
旧地址 `auto-renew-agreement.html` 仅用于兼容跳转，保留语言参数，不包含独立协议正文。
`auto-renew-result.html` 仅在服务端查到有效签约记录后显示成功。控制台
`dashboard.html?tab=plan` 从服务端读取签约状态，并提供关闭前确认。账户分组或算力
余额不能作为自动扣款授权的依据。

当前控制台另外展示的「千研科研 Pro」¥199/月是独立方案，入口改为咨询，
不会跳到 ¥79/月的 SomniQ Studio 专业版自动续费签约。注册协议勾选目前由前端校验；
账户服务还需保存协议版本、勾选时间与账号关联记录，才能形成可核验的注册同意记录。

目前本仓库只有网站和远程网关，没有支付渠道签约、订单、代扣通知或解约服务。
`VITE_SOMNIQ_AUTO_RENEW_SIGN_ENABLED` 默认为关闭，必须在支付链路完整接入后才设
为 `true`，并确认默认主体“重庆应算科技有限公司”与支付渠道登记的商户全称一致；
如需覆盖主体名称，使用 `VITE_SOMNIQ_MERCHANT_LEGAL_NAME` 配置。
签约页显示的计划金额和周期由 `src/billingConfig.ts` 定义；启用前须与服务端及支付
渠道的实际配置逐项核对。商户全称被显式配置为空时，协议页显示待确认，签约保持关闭。

需要由账户／支付服务实现并记录以下同源接口（现有 `/v1/user/*` 路由转发到该服务）：

| 接口 | 约定 |
| --- | --- |
| `GET /v1/user/auto-renew` | 返回 `{success:true,data:{status:"none"}}`，或含 `status:"active"/"cancelled"`、`plan_name`、`current_period_end`、`currency:"CNY"`；有效签约另含 `next_charge_at`、`next_charge_fen`。状态必须来自支付签约记录。 |
| `POST /v1/user/auto-renew/sign` | 验证登录身份、计划与协议版本，记录用户主动授权及协议快照；返回 `sign_url`、`amount_fen`、`currency`、`period`、`merchant_name`，与页面展示一致后才跳往 HTTPS 支付渠道签约。 |
| `POST /v1/user/auto-renew/cancel` | 撤销支付渠道代扣授权，服务端确认后返回 `status:"cancelled"` 和当前权益截止日期；失败不能在页面上显示“已关闭”。 |

支付回调需校验签名并更新签约／订单状态；支付渠道回跳地址可指向
`auto-renew-result.html`，该页会重新查询服务端记录。
每次自动扣款前还需通知用户扣款时间、金额和取消路径。不要通过浏览器本地状态
模拟签约成功或关闭成功。

## 结构 / Layout

```
site/
  index.html          # 官网入口
  dashboard.html      # 账号与远程客户端控制台
  remote/             # 手机/浏览器远程 PWA
  server/             # 配对、账号发现、信令与加密中继网关
  dist/               # 统一静态构建产物
  public/
    app-logo.png      # 品牌 mark，与 desktop/src/assets/app-logo.png 同一份
  src/
    i18n.ts           # 全部文案（中英），版本号与外链常量
    App.tsx           # 语言状态 + 章节编排
    useReveal.ts      # 滚动淡入
    styles.css        # 设计 token 与全部样式
    usePointerGlow.ts   # 首屏跟随指针的光斑
    components/
      Nav · Hero · AppMock · Starfield · Does · Review
      Memory · Vision · Local · Skills · Start · Footer · Section · icons
```

页面顺序：首屏（含产品界面演示）→ 一站式（四件事）→ 一键综述 →
三层记忆 → 我们要做的（完全自主）→ 数据在本地 → 上手命令 → 三步开始。

叙事主线是：**梦中求索，醒时有获** —— 你只提一个问题，剩下的交给它。
「一键综述」和「三层记忆」是两个支撑点：前者证明它能自己跑完长流程，
后者解释它为什么记得住。「我们要做的」那节明说理想（完全自主）和现状
（16 步里 12 步自动，剩下 4 步交还用户）的差距，不要删掉这个诚实的部分。

## 特效 / Effects

全部在 `prefers-reduced-motion: reduce` 下自动关闭：

| 效果 | 位置 | 说明 |
| --- | --- | --- |
| 星空漂移 | `Starfield.tsx` | canvas，密度按面积算、上限 220 颗；标签页隐藏时暂停 |
| 跟随指针光斑 | `usePointerGlow.ts` | 只写 `--px/--py` 两个 CSS 变量，每帧合并一次；粗指针（触屏）直接跳过 |
| 标题流光 | `.hero-title span` | 背景渐变位移，不触发文字重排 |
| 极光呼吸 | `.aurora-blob` | 26s / 32s 的 transform，慢到只当氛围 |
| 演示窗口落位 | `.hero-visual .mock` | 进入视口时从微仰角转正 |
| 阶段逐条入场 | `.stage` | 按索引错开 0.07s |

`Starfield` 用 `ResizeObserver` 而不是 `window.resize` —— 首次布局尺寸为 0 时
（面板收起、祖先 `display:none`、字体晚加载）窗口事件不会触发，星空会永久空白。

## 写文案的规矩 / Writing rules

**读者是科研人员，不是工程师。** 这一条决定了下面所有规矩：

- **讲结果，不讲实现。** 不要出现「内核」「状态机」「纯函数」「工作表面」
  「provider 抽象」这类词。用户关心的是"它能替我做什么"。
- **一句话一个意思**，句子短。
- **每条主张都要能对到真实功能。** 拿不准就去查：文献检索看 `crates/tools`，
  Jupyter 看 `crates/notebook`，分阶段流程看 `crates/runtime/src/review_workflow_driver.rs`，
  应用有哪些页签看 `desktop/src/App.tsx` 的 `PRIMARY_NAV_ITEMS`。

所有文案集中在 `src/i18n.ts`。`zh` 是 source of truth，`en` 声明为 `Copy`
（即 `typeof zh`），所以漏写或拼错 key 会在 `npm run typecheck` 时报错，
而不是在页面上留一块空白。

两个容易踩的坑：

- **首屏标题**（`hero.title`）用 `\n` 手动断行，字号上限 56px，容器 760px 居中。
  中文那行 10 个全角字、英文那行约 24 个字符是安全上限。改标题后回浏览器量一下。
- **中文标题不要超过 15 字**。`.section-title` 最大 38px、容器约 592px，超了就折行，
  而中文可以在任意两字之间断开 —— `text-wrap: balance` 会把「状态机」劈成
  「状态 / 机」，所以它只对英文生效。

## 设计 / Design

配色直接取自 `desktop/src/styles.css` 的 token（`--bg`、`--accent`、`--accent-2` 等），
让官网与应用视觉同源。新增的只有 cyan（`#7df3ff`，取自应用图标）、表面层次与背景光晕。

`AppMock.tsx` 是首屏那个「产品界面」—— 它是手写的仿真界面，不是截图。里面出现的
页签名必须和应用真实导航一致（Chat / Code / LaTeX / Literature / Workflows），
演示的流程也必须是产品真能做的事。

## 设计 / Design

配色直接取自 `desktop/src/styles.css` 的 token（`--bg`、`--accent`、`--accent-2` 等），
让官网与应用视觉同源。新增的只有 cyan（`#7df3ff`，取自应用图标）、表面层次与背景光晕。
