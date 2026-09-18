#!/usr/bin/env node
/**
 * 生成计算机软件著作权登记用「源程序」文档。
 *
 * 规格（依中国版权保护中心要求）：
 *   - 每页 50 行源代码，共 60 页
 *   - 取源程序前 30 页 + 后 30 页，中间省略
 *   - 每页页眉标注软件全称与版本号，页脚标注连续页码
 *   - 不含空行填充、不含第三方代码、不含第三方版权声明
 *
 * 输出：docs/copyright/out/源程序.html（用浏览器打印为 PDF，或由 render-pdf.cjs 自动转换）
 *
 * 用法：node docs/copyright/scripts/gen-source-listing.cjs
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────── 可修改配置 ─────────────────────────

/** 软件全称：必须与申请表中登记的中文全称完全一致 */
const SOFTWARE_NAME = '应算科研工作台软件（SomniQ Studio）';
/** 版本号：必须与申请表一致 */
const VERSION = 'V1.0';

const LINES_PER_PAGE = 50;
const FRONT_PAGES = 30;
const BACK_PAGES = 30;

// ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(__dirname, '..', 'out');

/**
 * 收录顺序决定前 30 页与后 30 页的内容：
 * 前部为共享 Rust 内核（核心算法与会话循环），后部为桌面端前端实现。
 */
const INCLUDE_ROOTS = [
  'crates/runtime/src',
  'crates/api/src',
  'crates/executor/src',
  'crates/chat/src',
  'crates/tools/src',
  'crates/notebook/src',
  'crates/remote-protocol/src',
  'crates/compute/src',
  'desktop/src-tauri/src',
  'desktop/src/chat',
  'desktop/src/literature',
  'desktop/src/knowledge',
  'desktop/src/settings',
  'desktop/src/tasks',
  'desktop/src/scheduled',
  'desktop/src/mail',
  'desktop/src/screenshot',
  'desktop/src/remote',
  'desktop/src/api',
];

const INCLUDE_EXT = new Set(['.rs', '.ts', '.tsx']);

/**
 * 排除规则。第三类是软著登记的关键：任何引用、改编或补丁化第三方项目
 * （嵌入式代码编辑器 VSCodium、Overleaf 界面样式、Tectonic 排版引擎）的文件
 * 都不得出现在声明为「原创」的源程序中。
 */
const EXCLUDE_PATH_PARTS = [
  // 测试代码：非功能实现，不作为展示页
  '/tests/', '.test.', '.spec.',
  // 第三方集成：VSCodium 嵌入式编辑器
  '/code/', 'codeserver', 'codebridge', 'code_bridge',
  // 第三方集成：Overleaf 界面复刻与 Tectonic 引擎
  '/typeset/', '/editor/', '/git/', 'latexFigure', 'outlineModel',
];

/** 含第三方项目名称的文件一律排除（双重保险） */
const THIRD_PARTY_TOKENS = [/vscodium/i, /overleaf/i, /tectonic/i];

/** 单行过长（≥400 字符）通常是内嵌数据或提示词长串，不具代码展示性 */
const MAX_ACCEPTABLE_LINE = 400;

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (INCLUDE_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

function isExcluded(relPath, content) {
  const normalized = '/' + relPath.replace(/\\/g, '/');
  if (EXCLUDE_PATH_PARTS.some((part) => normalized.includes(part))) return true;
  if (THIRD_PARTY_TOKENS.some((re) => re.test(content))) return true;
  const lines = content.split('\n');
  if (lines.some((line) => line.length >= MAX_ACCEPTABLE_LINE)) return true;
  return false;
}

function collectLines() {
  const out = [];
  const manifest = [];
  let excludedCount = 0;

  for (const root of INCLUDE_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    if (!fs.existsSync(absRoot)) continue;
    for (const file of walk(absRoot, [])) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');
      if (isExcluded(rel, content)) {
        excludedCount += 1;
        continue;
      }
      // 去掉空行：软著要求源程序不得用空行填充页面
      const codeLines = content
        .split(/\r?\n/)
        .map((l) => l.replace(/\t/g, '    ').trimEnd())
        .filter((l) => l.length > 0);
      if (codeLines.length === 0) continue;

      out.push(`// ===== ${rel} =====`);
      out.push(...codeLines);
      manifest.push({ rel, lines: codeLines.length });
    }
  }
  return { lines: out, manifest, excludedCount };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPages(allLines) {
  const frontLineCount = FRONT_PAGES * LINES_PER_PAGE;
  const backLineCount = BACK_PAGES * LINES_PER_PAGE;
  const totalNeeded = frontLineCount + backLineCount;

  if (allLines.length <= totalNeeded) {
    // 源程序总量不足 60 页时全文提交
    const pages = [];
    for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
      pages.push({ lines: allLines.slice(i, i + LINES_PER_PAGE), omitBefore: false });
    }
    return pages;
  }

  const front = allLines.slice(0, frontLineCount);
  const back = allLines.slice(allLines.length - backLineCount);
  const pages = [];
  for (let i = 0; i < front.length; i += LINES_PER_PAGE) {
    pages.push({ lines: front.slice(i, i + LINES_PER_PAGE), omitBefore: false });
  }
  for (let i = 0; i < back.length; i += LINES_PER_PAGE) {
    pages.push({
      lines: back.slice(i, i + LINES_PER_PAGE),
      omitBefore: i === 0,
    });
  }
  return pages;
}

function render(pages, stats) {
  const totalPages = pages.length;
  const pageHtml = pages
    .map((page, idx) => {
      const pageNo = idx + 1;
      const omitNote = page.omitBefore
        ? '<div class="omit-note">（中间部分源程序依登记规定省略，以下为源程序末 30 页）</div>'
        : '';
      const body = page.lines
        .map((line) => `<div class="ln">${escapeHtml(line) || '&nbsp;'}</div>`)
        .join('\n');
      return `<section class="page">
  <header class="pg-head"><span class="pg-name">${escapeHtml(SOFTWARE_NAME)}</span><span class="pg-ver">${escapeHtml(VERSION)}</span></header>
  ${omitNote}
  <div class="code">
${body}
  </div>
  <footer class="pg-foot">第 ${pageNo} 页 &nbsp;/&nbsp; 共 ${totalPages} 页</footer>
</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(SOFTWARE_NAME)} ${escapeHtml(VERSION)} 源程序</title>
<style>
  @page { size: A4 portrait; margin: 16mm 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Consolas", "Courier New", monospace;
    background: #fff; color: #000;
  }
  .page {
    page-break-after: always;
    break-after: page;
    height: 265mm;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .pg-head {
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: "SimSun", "Songti SC", serif;
    font-size: 9.5pt; border-bottom: 0.5pt solid #000;
    padding-bottom: 1.5mm; margin-bottom: 2mm; flex: 0 0 auto;
  }
  .pg-name { font-weight: 700; }
  .pg-ver { letter-spacing: 0.4pt; }
  .omit-note {
    font-family: "SimSun", "Songti SC", serif;
    font-size: 9pt; text-align: center; padding: 1mm 0 2mm;
    border-bottom: 0.5pt dashed #666; margin-bottom: 2mm; flex: 0 0 auto;
  }
  .code { flex: 1 1 auto; overflow: hidden; }
  .ln {
    font-size: 8pt;
    line-height: 4.7mm;
    height: 4.7mm;
    white-space: pre;
    overflow: hidden;
    text-overflow: clip;
  }
  .pg-foot {
    flex: 0 0 auto;
    font-family: "SimSun", "Songti SC", serif;
    font-size: 9pt; text-align: center;
    border-top: 0.5pt solid #000; padding-top: 1.5mm; margin-top: 2mm;
  }
  @media screen {
    body { background: #eee; padding: 8mm 0; }
    .page { width: 210mm; margin: 0 auto 8mm; background: #fff; padding: 16mm 14mm 14mm 16mm; height: 297mm; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
  }
</style>
</head>
<body>
<!--
  生成统计（不参与打印）：
  纳入文件数 ${stats.manifest.length}，排除文件数 ${stats.excludedCount}
  纳入代码总行数（去空行）${stats.lines.length}
-->
${pageHtml}
</body>
</html>
`;
}

function main() {
  const stats = collectLines();
  const pages = buildPages(stats.lines);
  const html = render(pages, stats);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, '源程序.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const manifestFile = path.join(OUT_DIR, '源程序-收录清单.txt');
  const manifestText = [
    `${SOFTWARE_NAME} ${VERSION} 源程序收录清单`,
    `生成时间：${new Date().toISOString().slice(0, 10)}`,
    `纳入文件：${stats.manifest.length} 个｜排除文件：${stats.excludedCount} 个｜去空行后代码行数：${stats.lines.length}`,
    `输出页数：${pages.length} 页（每页 ${LINES_PER_PAGE} 行）`,
    '',
    '序号\t行数\t文件路径',
    ...stats.manifest.map((m, i) => `${i + 1}\t${m.lines}\t${m.rel}`),
  ].join('\n');
  fs.writeFileSync(manifestFile, manifestText, 'utf8');

  process.stdout.write(
    [
      `纳入文件 ${stats.manifest.length} 个，排除 ${stats.excludedCount} 个`,
      `去空行后代码行数 ${stats.lines.length}`,
      `输出 ${pages.length} 页 -> ${outFile}`,
      `收录清单 -> ${manifestFile}`,
    ].join('\n') + '\n'
  );
}

main();
