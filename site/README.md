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

## 结构 / Layout

```
site/
  index.html          # 官网入口
  dashboard.html      # 账号与远程客户端控制台
  remote/             # 手机/浏览器远程 PWA
  server/             # 配对、账号发现、信令与加密中继网关
  dist/               # 统一静态构建产物
  public/
    somniq-icon.svg   # 从 desktop/src/assets/aris-icon.svg 复制
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
