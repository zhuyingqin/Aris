# 字体一致性审计

审计日期：2026-07-25
范围：`desktop/src/**/*.css`、`desktop/src/**/*.tsx` 内联 `fontFamily`、`desktop/src-tauri` 中 HTML 邮件正文样式

## 一、结论

**确认严重不统一**。整个项目里至少存在 **9 种 monospace 字体栈**、**6 种 sans-serif 字体栈**、**6 种 serif/math 字体栈**，分布全项目但**没有任何 bundling**——所有声明都依赖系统字体。换句话说：**Windows / macOS / Linux 上看到的界面字形不一致**是必然结果，不是偶发问题。

## 二、唯一的"真"字体源（藏在 styles.css）

`desktop/src/styles.css:16-17` 定义了 root CSS 变量：

```css
--font-sans: "Inter", "SF Pro Text", "Segoe UI", "Microsoft YaHei UI",
             "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono",
             ui-monospace, monospace;
```

`html, body, #root`（styles.css:73）用 `var(--font-sans)`，`button { font: inherit; }` 也跟着走。这部分**规范正确**——所有应该继承的组件（按钮、表单、容器）实际拿到的就是这两个 stack。

`Literature.css:6-7` 覆盖：

```css
--lit-font-sans: "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei",
                 "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
--lit-font-mono: var(--font-mono, "Cascadia Code", "SFMono-Regular", Consolas, monospace);
```

`Literature.css` 用 `--lit-font-sans` 而不是 `--font-sans`——**这就把 CJK 渲染倾斜到了 Noto Sans SC / PingFang SC**，是好意图但路径分裂。

`Typeset.css:88` 又自己加了一层：

```css
--mono: var(--font-mono);   /* 别名 */
```

## 三、9 种 monospace 栈

按出现频率（粗略）：

| # | 字体栈 | 出现处 | 备注 |
|---|---|---|---|
| 1 | `var(--font-mono)` | styles.css ×2、Literature.css ×2 | 正确继承 |
| 2 | `var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace)` | styles.css:6387 | **冗余**：变量已有 fallback |
| 3 | `var(--mono)` | Typeset.css ×3 | 指向 `--font-mono`，语义重复 |
| 4 | `var(--lit-font-mono)` | Literature.css:5495 | 与 `--font-mono` 等价 |
| 5 | `ui-monospace, monospace` | styles.css ×8、Lab.css ×1 | 最简版本 |
| 6 | `ui-monospace, "Cascadia Code", monospace` | styles.css ×16、Literature.css ×3 | 中等版本 |
| 7 | `ui-monospace, "Cascadia Code", "Fira Code", monospace` | styles.css ×2 | 加 Fira Code |
| 8 | `ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace` | Typeset.css ×1、TypesetVisualEditor.tsx ×3 | 完整版本 |
| 9 | `ui-monospace, "Cascadia Code", Menlo, Consolas, monospace` | Lab.css ×3 | Lab 风格 |
| 10 | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | styles.css ×11 | **缺 Cascadia** |
| 11 | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` | Lab.css ×22、Terminal.tsx ×1 | **macOS 风**——在 Windows 上经常掉到 Consolas |
| 12 | `"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace` | Typeset.css ×2 | **没有 ui-monospace 兜底**——Android 上可能不识别 |

**注**：第 9、10、11 三种是 Lab 自己造的"独立栈"，跟全局 `--font-mono` 偏离。`Lab.css:829-2556` 整整 22 处都用 `ui-monospace, "SF Mono", Menlo, Consolas, monospace`，等于 **Lab 整个 module 的 mono 字体与 Chat/Literature/Typeset 都不一致**。

## 四、6 种 sans-serif 栈

| # | 字体栈 | 出现处 | 备注 |
|---|---|---|---|
| 1 | `var(--font-sans)` | styles.css ×3、Literature.css ×1 | 正确 |
| 2 | `var(--lit-font-sans)` | Literature.css ×1 | CJK 倾向 |
| 3 | `"Segoe UI", system-ui, -apple-system, sans-serif` | Typeset.css ×5、TypesetVisualEditor.tsx ×5 | **绕过 `--font-sans`**，且 **没有 Inter / SF Pro Text / YaHei**——比根变量更"窄" |
| 4 | `sans-serif` | Typeset.css ×2、Mail/oauth.rs ×1 | 极简 |
| 5 | `Arial, Helvetica, sans-serif` | Typeset.css ×6 | **PDF 预览面板**——OK 但不应该和其他面板混 |
| 6 | `"Segoe UI, system-ui, sans-serif"`（注意逗号，无 -apple-system） | MermaidDiagram.tsx ×1 | Mermaid inline，**注意少 `-apple-system`** |

`Typeset.css` 整个 module 的"Segoe UI, system-ui, -apple-system"栈和根变量不一致——10 处都在用这个窄栈。

## 五、6 种 serif / math 栈

| 字体栈 | 出现处 | 用途 |
|---|---|---|
| `"Times New Roman", Times, serif` | Typeset.css ×3 | 默认衬线 |
| `"Noto Serif", "Times New Roman", Times, serif` | Typeset.css ×1 | CJK 衬线 |
| `"Noto Serif", "Palatino Linotype", "Book Antiqua", Palatino, "Times New Roman", serif` | Typeset.css ×1 | 较长 |
| `"Times New Roman", Times, "Noto Serif", serif` | Typeset.css ×1 | 顺序不同 |
| `"Cambria Math", "STIX Two Math", serif` | Literature.css:4865 | 数学（KaTeX 类字体） |
| `"KaTeX_Main", "Latin Modern Roman", "CMU Serif", "Times New Roman", Times, serif` | Typeset.css ×1、TypesetVisualEditor.tsx ×1 | KaTeX 渲染体 |

serif 是 LaTeX 渲染域，**字体差异属于合理设计**——不要硬统一。但"Latin Modern Roman"和"CMU Serif"在 Windows 上都没有，**会掉到 Times New Roman**，实际效果就是 Times 系列。考虑省略这俩只在 macOS / Linux 上存在的字体，简化栈。

## 六、Canvas / SVG / 内联 HTML 中的字体（绕过 CSS）

**这是最容易漏掉的盲区**——CSS 改了也不影响它们。

| 文件 | 行 | 字体栈 | 用途 |
|---|---|---|---|
| `desktop/src/api/labPreview.ts` | 113-124 | `Arial, sans-serif` + `Consolas, monospace` | Lab 内联 SVG 预览 |
| `desktop/src/lab/Terminal.tsx` | 48 | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` | xterm.js |
| `desktop/src/chat/MermaidDiagram.tsx` | 39 | `"Segoe UI, system-ui, sans-serif"` | Mermaid 渲染 |
| `desktop/src/typeset/TypesetVisualEditor.tsx` | 310-672 | 12 处 | CodeMirror decoration 渲染 |
| `desktop/src-tauri/src/mail/oauth.rs` | 194 | `font-family:sans-serif` | OAuth 邮件 HTML |

**Mermaid 渲染**的 inline 字体决定了用户看到的图表字体，而 CSS 改不了。`"Segoe UI, system-ui, sans-serif"` 在 macOS 上会掉到 system-ui（San Francisco），看起来跟 Chat 主体不一样。

## 七、最关键的"用户感知"问题

### 1. Inter 在大多数用户机器上不存在

`--font-sans` 把 **Inter 放在第一位**。Inter 是 web 字体，不在 Windows / macOS / Linux 系统字体里。99% 的用户**永远掉到下一级**——在 Windows 上看到的就是 Segoe UI。

如果不打算 bundling Inter，应该把它从栈里删掉或放到后面，让 Segoe UI / system-ui 当首选。

### 2. Cascadia Code 同理

`--font-mono` 把 Cascadia Code 放第一位，但它只是 Windows 11 自带、macOS 没有、Linux 大多数发行版不预装。在 Windows 10 上、Cascadia Code 没手动装的 macOS 上，Cascadia Code 直接掉到 SFMono-Regular（也基本没），最后掉到 Consolas / 系统 mono。**结果：开发者在不同机器上看到的 Chat 代码块字形差距很大**。

### 3. Lab 用 SF Mono（macOS 风）

`Lab.css` 22 处都用 `ui-monospace, "SF Mono", Menlo, Consolas, monospace`——把 SF Mono 放 Menlo 前面。在 macOS 上 SF Mono 是系统 mono，效果好；在 Windows 上 SF Mono 不存在，直接掉到 Menlo（也不存在）→ Consolas（存在）→ monospace（最终）。**Lab 在 Windows 上比 Chat 多跳一层 fallback**，肉眼可见字形不一样。

### 4. PDF / 导出 HTML 邮件字体另行一套

`mail/i18n.ts:342` 的中文登录提醒邮件用 `font-family:Arial,sans-serif`——这是邮件客户端的渲染，不是桌面 UI 本身，但**用户看到的"我们的产品发的邮件"是这个字体**，跟桌面 UI 完全不同。

## 八、修复建议

### P0：合并 mono 栈

把所有 mono 栈都改成 `var(--font-mono)`（styles.css:17 已定义完整 fallback）。替换面：
- styles.css 的 8 处 `ui-monospace, monospace`
- styles.css 的 16 处 `ui-monospace, "Cascadia Code", monospace`
- styles.css 的 11 处 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
- styles.css 的 2 处 `ui-monospace, "Cascadia Code", "Fira Code", monospace`
- styles.css:6387 的 `var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace)`（去掉冗余 fallback）
- Lab.css 的 22 处 + 3 处 + 1 处 = 26 处
- Terminal.tsx 的 1 处
- Literature.css 的 6 处
- Typeset.css 的 6 处 + 3 处 `var(--mono)`（保留 `--mono` 别名就够）
- TypesetVisualEditor.tsx 的 6 处

→ 约 **80+ 处** 替换。可以用 `sed` 或编辑器正则批量改。

### P0：合并 sans 栈

把所有硬编码的 sans 栈改成 `var(--font-sans)`。替换面：
- Typeset.css 的 5 处 `"Segoe UI", system-ui, -apple-system, sans-serif`
- TypesetVisualEditor.tsx 的 5 处
- 保留 `Arial, Helvetica, sans-serif`（PDF 预览合理）

→ 约 **10 处** 替换。

### P1：处理 MermaidDiagram.tsx 的 inline 字体

`MermaidDiagram.tsx:39` 的 `"Segoe UI, system-ui, sans-serif"` 改成跟 `--font-sans` 一致的栈，或读 CSS 变量。

### P1：Inter / Cascadia Code 是否 bundling

需要决策：

**选项 A**：bundling Inter 和 Cascadia Code（用 `@font-face` 引入 woff2）。视觉最一致，但增加 ~400KB 安装包。

**选项 B**：从 `--font-sans` / `--font-mono` 删掉 Inter / Cascadia Code，让 Segoe UI / Consolas / system-ui 当首选。安装包不变，但**放弃现代 web 字体美学**。

**建议**：选 B，等出现"字形难看"的真实反馈再升级。

### P2：mail 邮件 HTML 字体

`mail/i18n.ts:342` 和 `:601` 的两处邮件模板。邮件客户端不能用 CSS 变量，**保持 Arial,sans-serif 是合理**——但可以加上系统字体 fallback：`Arial, "Microsoft YaHei", "PingFang SC", sans-serif`，让 CJK 在中文 / 日文 / 韩文系统上有合理渲染。

### P3：Mermaid + canvas 同步

`labPreview.ts:113-124` 的 SVG 字体也是硬编码。这块属于"工具生成的预览图"，可以接受现状，但建议加一条注释说明"硬编码是有意的，跟 UI 字体解耦"。

## 九、可立刻执行的最小修复（30 分钟）

```bash
# 1. styles.css: 把 47 处 mono 合并成 var(--font-mono)
# 2. Lab.css: 把 26 处 mono 合并成 var(--font-mono)
# 3. Typeset.css: 把硬编码 sans/mono 替换成 var(--font-sans) / var(--font-mono)
# 4. TypesetVisualEditor.tsx: 12 处内联 fontFamily 替换
# 5. MermaidDiagram.tsx:39: 替换成 var(--font-sans) 或同步栈
# 6. Terminal.tsx:48: 替换成 var(--font-mono)
```

**为什么这是 P0 而不是 P1**：因为 `styles.css:17` 已经定义了完整的 fallback 栈，**只是没人用它**。改完立刻生效、零风险。

## 十、附加观察

- 项目**完全没 bundling 任何字体文件**——所有声明都靠系统
- index.html **没有任何 `<link>` 字体引用**、没有任何 `@font-face`
- `font-synthesis: none` 在 styles.css:29 设置了，避免浏览器在缺失字体时合成粗体/斜体——这个设置**很专业**，保留
- 没有任何 dark-mode 字体切换——但有 dark-mode 颜色切换（color-scheme: dark）