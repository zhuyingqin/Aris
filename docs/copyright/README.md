# 软件著作权登记材料

本目录存放计算机软件著作权登记（中国版权保护中心）所需的全部材料与其生成工具。

## 目录结构

```
docs/copyright/
├── 软著登记-申请表填写模板.md    # 申请表逐字段填写内容，可直接复制进登记系统
├── 软件说明书.html               # 说明书正文（手写源文档，纳入版本库）
├── scripts/
│   ├── gen-source-listing.cjs   # 生成「源程序」60 页文档
│   └── render-pdf.cjs           # 将 HTML 打印为 PDF
└── out/                          # 生成产物（已 gitignore）
    ├── 源程序.html / .pdf        # 60 页，每页 50 行，前 30 + 后 30
    ├── 源程序-收录清单.txt        # 纳入与排除的文件明细，备查
    └── 软件说明书.pdf             # 53 页用户手册（纯文字，无截图）
```

`render-pdf.cjs` 从 `docs/copyright/` 与 `docs/copyright/out/` 两处收集 HTML，PDF 一律输出到 `out/`。

## 需要提交的三份材料

| 材料 | 文件 | 状态 |
|---|---|---|
| 申请表 | `软著登记-申请表填写模板.md` | 逐字段内容已备好，待填入登记系统 |
| 源程序 | `out/源程序.pdf` | 60 页，已生成 |
| 软件说明书 | `out/软件说明书.pdf` | 53 页，已生成（不足 60 页按全部提交处理） |

## 重新生成

改动配置后按顺序执行：

```bash
node docs/copyright/scripts/gen-source-listing.cjs && node docs/copyright/scripts/render-pdf.cjs
```

`render-pdf.cjs` 不带参数时转换 `out/` 下全部 HTML；也可指定单个文件，例如 `node docs/copyright/scripts/render-pdf.cjs 软件说明书.html`。

## 改软件名称与版本号

名称和版本号出现在三处，改名时必须**同时**改完，否则页眉与登记信息不一致会被要求补正：

1. `scripts/gen-source-listing.cjs` 顶部的 `SOFTWARE_NAME` 与 `VERSION` 常量
2. `软件说明书.html` 的 `<meta name="pdf-header-left">` 与 `<meta name="pdf-header-right">`
3. `软件说明书.html` 封面区块的标题与版本

改完后重新执行上面的生成命令。

## 两个已验证的实现约束

**一、源程序的页眉页脚是逐页写死的，说明书的不是。**

源程序文档由脚本切分为 60 个固定高度的页面容器，每个容器自带页眉与写死的页码，因此不依赖浏览器分页。

说明书是流式排版，页数由内容决定。这里有一个坑：用 CSS `position: fixed` 元素配合 `counter(page)` 绘制页码的常见写法，在 Chromium 下**不成立**——该元素虽然每页重绘，但 `counter(page)` 只解析一次，60 页会全部印成「第 1 页」。因此 `render-pdf.cjs` 改走 DevTools 协议的 `Page.printToPDF`，用 `headerTemplate` / `footerTemplate` 中的 `.pageNumber` / `.totalPages` 绘制，这是唯一能得到真正递增页码的机制。

说明书 HTML 中的 `<meta name="pdf-running" content="on">` 就是触发该模式的开关。

**二、源程序排除了全部第三方相关文件。**

登记时勾选「原创」是法律声明。`gen-source-listing.cjs` 中的 `EXCLUDE_PATH_PARTS` 与 `THIRD_PARTY_TOKENS` 排除了引用或改编第三方项目的文件（嵌入式代码编辑器、在线排版平台界面复刻、排版引擎），以及测试代码与含超长内嵌数据的文件。本次生成纳入 243 个文件、排除 175 个，明细见 `out/源程序-收录清单.txt`。

CSS 整体未纳入源程序提交范围——排版模块的样式复用了第三方界面的类名，排除全部 CSS 可一次性规避该风险，且 Rust 与 TypeScript 代码量已远超 60 页所需。
