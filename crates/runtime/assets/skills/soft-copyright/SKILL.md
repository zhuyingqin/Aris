---
name: soft-copyright
description: "Generate a complete Chinese software copyright registration (计算机软件著作权登记) package for a codebase: the application-form field content ready to paste into 中国版权保护中心's system, the 60-page source-code listing PDF, and the 60-page user manual PDF. Use when user says \"写软著\", \"软件著作权\", \"软著登记\", \"申请软著\", \"software copyright registration\", \"软著材料\", or needs to register copyright for software they wrote."
argument-hint: "[软件中文全称 — 著作权人（可留空，会逐项询问）]"
allowed-tools: read_file, write_file, edit_file, glob_search, grep_search, bash, AskUserQuestion
---

# 中国软件著作权登记材料生成

为当前工程生成一整套软著登记材料：**$ARGUMENTS**

## 产出

| 材料 | 文件 | 说明 |
|---|---|---|
| 申请表填写内容 | `copyright/软著登记-申请表填写模板.md` | 逐字段可直接复制进登记系统，每项已按限额调好字数 |
| 源程序 | `copyright/out/源程序.pdf` | 60 页，每页 50 行，前 30 + 后 30 |
| 软件说明书 | `copyright/out/软件说明书.pdf` | 用户手册，60 页或全文 |
| 收录清单 | `copyright/out/源程序-收录清单.txt` | 纳入/排除了哪些文件，备查 |

## 脚本路径

下文用 `$SK` 指代本 skill 的资源目录（脚本、模板、参考文档都在里面）。每次会话开始时先解析一次，并**把打印出来的绝对路径记下来**——后面用 read_file 读 `references/` 和 `assets/` 里的文件时要拼这个前缀：

```bash
SK=""
for marker in \
  "$HOME/.config/SomniQ/skills/soft-copyright/scripts/gen-source-listing.cjs" \
  "${ARIS_CACHE_DIR:-.}/skills/soft-copyright/scripts/gen-source-listing.cjs" \
  "skills/soft-copyright/scripts/gen-source-listing.cjs"; do
  [ -f "$marker" ] && { SK="${marker%/scripts/gen-source-listing.cjs}"; break; }
done
[ -z "$SK" ] && {
  echo "ERROR: soft-copyright 的脚本未解析到。已查 ~/.config/SomniQ/、\$ARIS_CACHE_DIR/、./skills/。" >&2
  echo "       修复：重装 SomniQ 让内置资源正常解包，或手动放一份到 ~/.config/SomniQ/skills/soft-copyright/。" >&2
  exit 1
}
echo "SK=$SK"
command -v node >/dev/null || {
  echo "ERROR: 未找到 Node.js，四个脚本都跑不了。先装 Node（LTS 即可）再继续。" >&2
  exit 1
}
```

脚本只用 Node 标准库，无第三方依赖；生成 PDF 还需要本机装有 Chrome / Edge / Chromium（脚本会自动在常见安装路径里找，也可用 `CHROME_PATH` 指定）。

## 开始前必读

先读 `$SK/references/申请表字段规则.md`。里面有三条不读就会做错的事：

1. **字数限制方向不一致**——「主要功能」的 500 字是**下限**，「技术特点」的 100 字是上限，环境类字段的 50 字是上限。不要假设「限 N 字」都是上限。
2. **主要功能和技术特点在系统上是两个独立输入框**，不要合并写。
3. **勾「原创」是法律声明**，引用或改编第三方项目的文件必须整个排除出提交的源程序。

---

## 流程

### 第 1 步：摸清工程

并行执行，不要一条条问用户能自己查到的东西：

```bash
# 版本号
cat package.json 2>/dev/null | head -5; cat Cargo.toml 2>/dev/null | head -10
# 时间线
git log --reverse --format="%ad %s" --date=short | head -3
git log -1 --format="%ad" --date=short
git log --tags --simplify-by-decoration --format="%ad %d" --date=short | tail -5
# 代码量（按实际语言调整）
find <源码目录> -name "*.<后缀>" | xargs wc -l | tail -1
```

同时读 README 了解产品定位、扫一遍目录结构确定模块划分。

**排查第三方代码**（这一步决定 `thirdPartyTokens` 怎么配）：

```bash
grep -rli -e "<第三方项目名>" --include="*.<后缀>" <源码目录> | head -30
grep -rn "Copyright (c)" --include="*.<后缀>" <源码目录> | head -20
```

### 第 2 步：确认必须由用户决定的事

用 AskUserQuestion 一次问完，不要挤牙膏。至少确认：

- **软件中文全称**——给 3–4 个候选，说明命名硬规则，推荐「中文名（English Name）」中英并列形式
- **著作权人是个人还是公司**——这会连带改变证件类型、证明文件和权利取得情形

能从代码里查到的（版本、日期、语言、代码量）不要问。

### 第 3 步：写配置并生成源程序

把 `$SK/scripts/config.example.json` 复制为工程根的 `copyright.config.json`，按第 1 步的调查结果填 `includeRoots`（把最能体现技术含量的模块排最前，它们会进前 30 页）和 `thirdPartyTokens`。

```bash
node "$SK/scripts/gen-source-listing.cjs"
node "$SK/scripts/render-pdf.cjs" 源程序.html
node "$SK/scripts/verify-pdf.cjs" copyright/out/源程序.pdf 60
```

生成后核对 `源程序-收录清单.txt` 的排除数量是否合理——排除过多说明 `thirdPartyTokens` 写宽了。

**带省略声明的第 31 页要单独验**，做法见 `$SK/references/PDF生成技术要点.md` 第三节。

### 第 4 步：写申请表

按 `$SK/references/申请表字段规则.md` 逐字段写入 `copyright/软著登记-申请表填写模板.md`。格式必须是：

```markdown
### 2.9 软件的开发目的

▶ 填写内容（**正好 50 字**）：

​```
为科研人员提供本地优先的一体化研究工作台，解决各环节工具割裂……
​```

> 补充说明放在引用块里，不影响字数校验。
```

`### N.N 字段名` + 代码块 这个结构是 `check-fields.cjs` 的解析依据，不要改。

写完立即校验：

```bash
node "$SK/scripts/check-fields.cjs"
```

不通过就改到通过。**不要凭肉眼判断中文字数。**

### 第 5 步：写说明书

复制 `$SK/assets/软件说明书模板.html` 到工程的 `copyright/软件说明书.html`，替换 `{{软件全称}}` 等占位符，然后按工程实际撰写各章。

推荐章节结构（按实际模块增减）：

1. 软件概述（简介、设计目标、体系结构、功能一览、技术特点）
2. 运行环境与安装（硬件、软件、安装步骤、首次配置、升级卸载）
3. 界面总览与基本操作
4. ~N. 各功能模块的操作步骤，**一个模块一章**
5. 常见问题与故障处理
6. 附录：快捷键总表、术语表、功能清单、数据目录结构、典型业务流程

生成与验证：

```bash
node "$SK/scripts/render-pdf.cjs" 软件说明书.html
node "$SK/scripts/verify-pdf.cjs" copyright/out/软件说明书.pdf
```

**页数不够 60 时不要灌水**——加附录和流程示例，都是真手册该有的内容。具体见 `$SK/references/PDF生成技术要点.md` 第六节。

### 第 6 步：交付前复核

```bash
node "$SK/scripts/check-fields.cjs"
node "$SK/scripts/verify-pdf.cjs" copyright/out/源程序.pdf 60
node "$SK/scripts/verify-pdf.cjs" copyright/out/软件说明书.pdf
```

然后逐条核对：

- [ ] 软件全称在申请表、源程序页眉、说明书页眉/封面**四处完全一致**
- [ ] 版本号四处一致
- [ ] 开发完成日期 ≤ 首次发表日期
- [ ] 著作权人名称与证件逐字一致（公司要含行政区划和组织形式后缀）
- [ ] 源程序未混入第三方代码，未含他人版权声明
- [ ] 说明书截图（若有）中的软件名称与登记全称对得上
- [ ] 若著作权人是公司而仓库 LICENSE 署个人名，已提示用户处理权属矛盾

---

## 输出要求

- 所有面向用户的说明用中文。
- 每个字段标注实际字数，让用户一眼看出是否贴着限额。
- **明确区分「已核实」和「待用户确认」**：从代码/git 查到的是前者，营业执照全称、发表日期这类是后者，用 `【】` 占位并在状态表里列出。
- 发现与登记冲突的事实（如开源协议、个人署名与公司登记不符）要明说，给建议但不代替用户做法律判断。

## 复用提示

同一工程后续版本再次登记时，改 `copyright.config.json` 的 `version`、更新说明书的修订记录，重跑生成命令即可。软件名称一旦登记不便更改，续登要沿用。
