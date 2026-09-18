#!/usr/bin/env node
/**
 * 生成计算机软件著作权登记用「源程序」文档（HTML，供 render-pdf.cjs 转 PDF）。
 *
 * 规格（中国版权保护中心）：
 *   - 每页 50 行源代码，共 60 页
 *   - 取源程序前 30 页 + 后 30 页，中间省略
 *   - 每页页眉标注软件全称与版本号，页脚标注连续页码
 *   - 不含空行填充、不含第三方代码、不含第三方版权声明
 *
 * 页码逐页写死在各页容器内，不依赖浏览器分页计数器。
 *
 * 用法：
 *   node gen-source-listing.cjs [配置文件路径]
 *
 * 配置文件默认取 ./copyright.config.json；不存在时自动探测工程源码目录。
 * 配置示例见同目录 config.example.json。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  softwareName: '',
  version: 'V1.0',
  linesPerPage: 50,
  frontPages: 30,
  backPages: 30,
  outDir: 'copyright/out',
  extensions: [
    '.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt', '.go',
    '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.php', '.rb', '.vue', '.dart',
  ],
  includeRoots: [],
  /** 路径片段命中即排除：测试代码与第三方集成 */
  excludePathParts: [
    '/tests/', '/test/', '/__tests__/', '.test.', '.spec.',
    '/node_modules/', '/vendor/', '/third_party/', '/dist/', '/build/', '/target/',
    '/migrations/', '.min.', '.generated.', '_pb.', '.pb.',
  ],
  /**
   * 文件内容命中任一正则即整file排除。
   * 用途：登记勾选「原创」是法律声明，凡引用或改编第三方项目的文件都不得混入。
   * 请按本工程实际引入的第三方项目补充。
   */
  thirdPartyTokens: [],
  /** 单行超过该长度多为内嵌数据或压缩产物，不具代码展示性 */
  maxAcceptableLine: 400,
};

/** 自动探测：常见工程的源码根目录 */
const AUTO_ROOTS = [
  'src', 'lib', 'app', 'crates', 'packages', 'internal', 'pkg', 'cmd',
  'server', 'client', 'backend', 'frontend', 'core',
];

function loadConfig(argPath) {
  const cfgPath = path.resolve(argPath || 'copyright.config.json');
  let userCfg = {};
  if (fs.existsSync(cfgPath)) {
    userCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...userCfg };
  cfg.excludePathParts = [
    ...DEFAULTS.excludePathParts,
    ...(userCfg.excludePathParts || []),
  ];
  if (!cfg.includeRoots.length) {
    cfg.includeRoots = AUTO_ROOTS.filter((d) => fs.existsSync(d));
    if (!cfg.includeRoots.length) cfg.includeRoots = ['.'];
    process.stdout.write(
      `未配置 includeRoots，自动探测到：${cfg.includeRoots.join('、')}\n`
    );
  }
  if (!cfg.softwareName) {
    throw new Error(
      '配置缺少 softwareName。软著登记的软件全称必须与申请表完全一致，不能留空。'
    );
  }
  return cfg;
}

function walk(dir, exts, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.includes(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

function isExcluded(relPath, content, cfg, tokenRes) {
  const normalized = '/' + relPath.replace(/\\/g, '/');
  if (cfg.excludePathParts.some((p) => normalized.includes(p))) return true;
  if (tokenRes.some((re) => re.test(content))) return true;
  if (content.split('\n').some((l) => l.length >= cfg.maxAcceptableLine)) return true;
  return false;
}

function collectLines(cfg) {
  const tokenRes = cfg.thirdPartyTokens.map((t) => new RegExp(t, 'i'));
  const out = [];
  const manifest = [];
  let excludedCount = 0;

  for (const root of cfg.includeRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root, cfg.extensions, [])) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (isExcluded(rel, content, cfg, tokenRes)) {
        excludedCount += 1;
        continue;
      }
      // 去空行：软著要求源程序不得用空行填充页面
      const codeLines = content
        .split(/\r?\n/)
        .map((l) => l.replace(/\t/g, '    ').trimEnd())
        .filter((l) => l.length > 0);
      if (!codeLines.length) continue;

      out.push(`// ===== ${rel} =====`);
      out.push(...codeLines);
      manifest.push({ rel, lines: codeLines.length });
    }
  }
  return { lines: out, manifest, excludedCount };
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildPages(allLines, cfg) {
  const { linesPerPage: L, frontPages: F, backPages: B } = cfg;
  const need = (F + B) * L;
  const chunk = (arr, omitFirst) => {
    const pages = [];
    for (let i = 0; i < arr.length; i += L) {
      pages.push({ lines: arr.slice(i, i + L), omitBefore: omitFirst && i === 0 });
    }
    return pages;
  };
  if (allLines.length <= need) return chunk(allLines, false);
  return [
    ...chunk(allLines.slice(0, F * L), false),
    ...chunk(allLines.slice(allLines.length - B * L), true),
  ];
}

function render(pages, cfg, stats) {
  const total = pages.length;
  const body = pages
    .map((page, idx) => {
      const omit = page.omitBefore
        ? '<div class="omit-note">（中间部分源程序依登记规定省略，以下为源程序末 ' +
          cfg.backPages +
          ' 页）</div>'
        : '';
      const code = page.lines
        .map((l) => `<div class="ln">${escapeHtml(l) || '&nbsp;'}</div>`)
        .join('\n');
      return `<section class="page">
  <header class="pg-head"><span class="pg-name">${escapeHtml(cfg.softwareName)}</span><span class="pg-ver">${escapeHtml(cfg.version)}</span></header>
  ${omit}
  <div class="code">
${code}
  </div>
  <footer class="pg-foot">第 ${idx + 1} 页 &nbsp;/&nbsp; 共 ${total} 页</footer>
</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(cfg.softwareName)} ${escapeHtml(cfg.version)} 源程序</title>
<style>
  @page { size: A4 portrait; margin: 16mm 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Consolas", "Courier New", monospace; background: #fff; color: #000; }
  .page {
    page-break-after: always; break-after: page;
    height: 265mm; display: flex; flex-direction: column; position: relative;
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .pg-head {
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: "SimSun", "Songti SC", serif; font-size: 9.5pt;
    border-bottom: 0.5pt solid #000; padding-bottom: 1.5mm; margin-bottom: 2mm; flex: 0 0 auto;
  }
  .pg-name { font-weight: 700; }
  .pg-ver { letter-spacing: 0.4pt; }
  .omit-note {
    font-family: "SimSun", "Songti SC", serif; font-size: 9pt; text-align: center;
    padding: 1mm 0 2mm; border-bottom: 0.5pt dashed #666; margin-bottom: 2mm; flex: 0 0 auto;
  }
  .code { flex: 1 1 auto; overflow: hidden; }
  .ln { font-size: 8pt; line-height: 4.7mm; height: 4.7mm; white-space: pre; overflow: hidden; }
  .pg-foot {
    flex: 0 0 auto; font-family: "SimSun", "Songti SC", serif; font-size: 9pt;
    text-align: center; border-top: 0.5pt solid #000; padding-top: 1.5mm; margin-top: 2mm;
  }
  @media screen {
    body { background: #eee; padding: 8mm 0; }
    .page { width: 210mm; margin: 0 auto 8mm; background: #fff;
            padding: 16mm 14mm 14mm 16mm; height: 297mm; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
  }
</style>
</head>
<body>
<!-- 纳入 ${stats.manifest.length} 文件，排除 ${stats.excludedCount} 文件，去空行后 ${stats.lines.length} 行 -->
${body}
</body>
</html>
`;
}

function main() {
  const cfg = loadConfig(process.argv[2]);
  const stats = collectLines(cfg);

  if (!stats.lines.length) {
    throw new Error(
      '未收集到任何源代码。请检查配置中的 includeRoots 与 extensions 是否匹配本工程。'
    );
  }

  const pages = buildPages(stats.lines, cfg);
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const outFile = path.join(cfg.outDir, '源程序.html');
  fs.writeFileSync(outFile, render(pages, cfg, stats), 'utf8');

  const manifestFile = path.join(cfg.outDir, '源程序-收录清单.txt');
  fs.writeFileSync(
    manifestFile,
    [
      `${cfg.softwareName} ${cfg.version} 源程序收录清单`,
      `生成时间：${new Date().toISOString().slice(0, 10)}`,
      `纳入文件：${stats.manifest.length} 个｜排除文件：${stats.excludedCount} 个｜去空行后代码行数：${stats.lines.length}`,
      `输出页数：${pages.length} 页（每页 ${cfg.linesPerPage} 行）`,
      '',
      '序号\t行数\t文件路径',
      ...stats.manifest.map((m, i) => `${i + 1}\t${m.lines}\t${m.rel}`),
    ].join('\n'),
    'utf8'
  );

  process.stdout.write(
    [
      `纳入文件 ${stats.manifest.length} 个，排除 ${stats.excludedCount} 个`,
      `去空行后代码行数 ${stats.lines.length}`,
      `输出 ${pages.length} 页 -> ${outFile}`,
      `收录清单 -> ${manifestFile}`,
      pages.length < cfg.frontPages + cfg.backPages
        ? `提示：源码总量不足 ${cfg.frontPages + cfg.backPages} 页，已全文提交（符合「不足 60 页全部提交」）`
        : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  );
}

try {
  main();
} catch (e) {
  process.stderr.write('错误：' + e.message + '\n');
  process.exit(1);
}
