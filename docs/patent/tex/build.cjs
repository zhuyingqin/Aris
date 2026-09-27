#!/usr/bin/env node
/**
 * 编译 A1 专利申请文件（xelatex → PDF），并做递交前的形式核验。
 *
 *   node patent/tex/build.cjs              编译全部并核验
 *   node patent/tex/build.cjs claims       只编译某一份
 *   node patent/tex/build.cjs --check      不编译，只核验已有 PDF
 *
 * 中间文件全部落在 patent/tex/.build/，成品以中文名复制到
 * patent/output/CNIPA/。用中文名做 jobname 在 Windows 上不保险，所以
 * .tex 一律 ASCII 名，编完再改名。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const os = require('os');

const TEX_DIR = __dirname;
const BUILD_DIR = path.join(TEX_DIR, '.build');
const OUT_DIR = path.resolve(TEX_DIR, '..', 'output', 'CNIPA');
const BUNDLED_PYTHON = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const PYTHON = process.env.CNIPA_PYTHON || (fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : 'python');

// 顺序即《专利审查指南》第一部分第一章规定的申请文件排列顺序：
// 请求书（官方表格，不在此生成）→ 说明书摘要 → 摘要附图 → 权利要求书
// → 说明书 → 说明书附图。合订本最后编译，因为它要并入前面各份的 PDF。
const DOCS = [
  { job: 'abstract',         out: '说明书摘要',         kind: '递交件', filing: true },
  { job: 'abstract-figure',  out: '摘要附图',           kind: '递交件', filing: true },
  { job: 'claims',           out: '权利要求书',         kind: '递交件', filing: true },
  { job: 'description',      out: '说明书',             kind: '递交件', filing: true },
  { job: 'drawings',         out: '说明书附图',         kind: '附图',   filing: true },
  { job: 'notes-prior-art',  out: '现有技术检索记录',   kind: '工作文档' },
  { job: 'notes-disclosure', out: '发明构建书',         kind: '工作文档' },
  { job: 'notes-draft',      out: '递交前注意事项',     kind: '工作文档' },
  { job: 'combined',         out: '合订本',             kind: '合订本', last: true },
];

/**
 * 缺字检查。xelatex 遇到字体里没有的字符时，PDF 里那个字直接消失，只在
 * .log 留一行 Missing character，页面看上去毫无异常。专利文件里丢一个
 * ≥ 或 ∧ 会改变技术方案的含义，所以这里当作构建失败处理，修法见
 * symbols.sty。
 */
function missingChars(job) {
  const log = path.join(BUILD_DIR, `${job}.log`);
  if (!fs.existsSync(log)) return [];
  const hits = fs.readFileSync(log, 'utf8').match(/Missing character: There is no (\S+)/g) || [];
  return [...new Set(hits.map((h) => h.replace('Missing character: There is no ', '')))];
}

function layoutCheck(job) {
  const args = ['-X', 'utf8', path.join(TEX_DIR, 'verify_layout.py'),
    '--output-dir', OUT_DIR, '--report', path.join(OUT_DIR, job ? `${job}-layout-check.json` : 'layout-check.json')];
  if (job) args.push('--job', job);
  const result = spawnSync(PYTHON, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout || '');
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || 'PDF 版面检查未通过\n'));
  return result.status === 0;
}

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceHashes() {
  const result = {};
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'templates') continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.(tex|sty|cjs|py)$/.test(item.name)) result[path.relative(TEX_DIR, file)] = sha(file);
    }
  }
  visit(TEX_DIR);
  return result;
}
function currentManifest() {
  return { sources: sourceHashes(), outputs: Object.fromEntries(DOCS.map(d => {
    const file = path.join(OUT_DIR, d.out + '.pdf');
    return [d.out + '.pdf', fs.existsSync(file) ? sha(file) : null];
  })) };
}
function writePageCounts() {
  const tex = DOCS.filter(d => !d.last).map(d =>
    `\\expandafter\\def\\csname pages-${d.job}\\endcsname{${pdfInfo(path.join(OUT_DIR, d.out + '.pdf')).pages}}`).join('\n');
  fs.writeFileSync(path.join(BUILD_DIR, 'page-counts.tex'), tex + '\n');
}

function compile(job) {
  // 跑两遍：工作文档页脚的「共 N 页」靠 lastpage 的交叉引用，一遍出不来。
  // 注意：xelatex 带 -output-directory 时会把该目录也加进输入搜索路径，
  // .build/ 里若留有同名 .tex 会被优先读到。中间文件用完即清。
  for (let pass = 0; pass < 2; pass += 1) {
    const res = spawnSync(
      'xelatex',
      ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${BUILD_DIR}`, `${job}.tex`],
      { cwd: TEX_DIR, encoding: 'utf8' }
    );
    if (res.status !== 0) {
      const log = path.join(BUILD_DIR, `${job}.log`);
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : res.stdout || '';
      const errors = text.split('\n').filter((l) => /^! |^l\.\d/.test(l)).slice(0, 12);
      process.stderr.write(`\n${job}.tex 编译失败：\n${errors.join('\n') || res.stderr}\n`);
      process.exit(1);
    }
  }
}

/**
 * 页数与页面尺寸走 pdfinfo。
 * 不要用正则去 PDF 字节里找 /Type /Page 或 /MediaBox——xelatex 的输出把
 * 这些对象放在压缩对象流里，正则一个也匹配不到，会静默报 0 页。
 * pdfinfo 随 TeX Live 一起装，本脚本本来就依赖 TeX Live。
 */
function pdfInfo(file) {
  const res = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
  if (res.status !== 0) return { pages: 0, a4: false };
  const pages = Number((res.stdout.match(/^Pages:\s+(\d+)/m) || [])[1] || 0);
  const size = (res.stdout.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m) || []).slice(1).map(Number);
  const a4 = size.length === 2 &&
    Math.abs(size[0] - 595.28) < 1.5 && Math.abs(size[1] - 841.89) < 1.5;
  return { pages, a4 };
}

/** 从实际 PDF 计数，去除文件页眉与页码；正文不依赖“本发明”起句。 */
function abstractChars() {
  const res = spawnSync('pdftotext', ['-enc', 'UTF-8', '-layout', path.join(OUT_DIR, '说明书摘要.pdf'), '-'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return Array.from(res.stdout.split('\n').map(l => l.replace(/\s/g, ''))
    .filter(l => l && l !== '说明书摘要' && !/^\d+$/.test(l)).join('')).length;
}

/**
 * 孤标题：小节标题排在某页最后一行、正文被甩到下一页。
 * \nopagebreak 只是惩罚值挡不住，cnipa.sty 用 \needspace 做硬约束；
 * 这里复查一遍，免得以后改宏又漏回去。
 * pdftotext 必须带 -enc UTF-8，否则中文被整段丢掉只剩 ASCII。
 */
const HEADING_RE =
  /^(技术领域|背景技术|发明内容|附图说明|具体实施方式|实施例[一二三四五六七八九十]+[：:].*|[一二三四五六七八九十]+、.*)$/;

function orphanHeadings(pdf) {
  const res = spawnSync('pdftotext', ['-enc', 'UTF-8', '-layout', pdf, '-'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return ['无法提取 PDF，不能确认孤标题检查'];
  const bad = [];
  res.stdout.split('\f').forEach((page, index) => {
    const lines = page.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    // 末行通常是页码，取它前面那一行
    const tail = /^\d+$/.test(lines[lines.length - 1])
      ? lines[lines.length - 2]
      : lines[lines.length - 1];
    if (tail && HEADING_RE.test(tail)) bad.push(`第 ${index + 1} 页末尾是「${tail}」`);
  });
  return bad;
}

/**
 * 官方“说明书”属于页眉；跳过它后，第一行正文应当是发明名称。
 */
function descriptionFirstLine() {
  const pdf = path.join(OUT_DIR, '说明书.pdf');
  if (!fs.existsSync(pdf)) return null;
  const res = spawnSync('pdftotext', ['-enc', 'UTF-8', '-layout', '-f', '1', '-l', '1', pdf, '-'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  const lines = res.stdout.split('\n').map((l) => l.replace(/\s/g, '')).filter(l => l && l !== '说明书');
  return lines[0] || '';
}

/**
 * 摘要必备的五项内容。审查指南 4.5.1：摘要文字部分应当写明发明的名称和
 * 所属的技术领域，清楚反映所要解决的技术问题、解决该问题的技术方案的
 * 要点以及主要用途。缺名称或不能反映要点的会被通知补正。
 */
function abstractElements() {
  const src = fs.readFileSync(path.join(TEX_DIR, 'abstract.tex'), 'utf8');
  const body = src.split('\n').filter((l) => !l.trimStart().startsWith('%')).join('\n');
  return [
    ['发明名称', /大语言模型智能体的工具调用控制方法及系统/],
    ['技术领域', /技术领域/],
    ['技术问题', /技术问题/],
    ['方案要点', /技术方案要点/],
    ['主要用途', /可?用于/],
  ]
    .filter(([, re]) => !re.test(body))
    .map(([name]) => name);
}

/** 权利要求项数：数 \claim{ 的出现次数 */
function claimCount() {
  const src = fs.readFileSync(path.join(TEX_DIR, 'claims.tex'), 'utf8');
  return (src.match(/^\\claim\{/gm) || []).length;
}

/** 附图标记：说明书与五幅图必须完全一致，双向不得有孤儿 */
function numeralCrossCheck() {
  const pick = (text) => new Set(text.match(/(?<![0-9])(1[0-1][0-9])(?![0-9])/g) || []);
  const spec = pick(fs.readFileSync(path.join(TEX_DIR, 'description.tex'), 'utf8'));
  let figs = new Set();
  for (const f of fs.readdirSync(path.join(TEX_DIR, 'figures'))) {
    // 只取节点文字里的标记，注释里的说明不算
    const text = fs
      .readFileSync(path.join(TEX_DIR, 'figures', f), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('%'))
      .join('\n');
    for (const n of pick(text)) figs.add(n);
  }
  const onlySpec = [...spec].filter((n) => !figs.has(n)).sort();
  const onlyFigs = [...figs].filter((n) => !spec.has(n)).sort();
  return { spec: spec.size, figs: figs.size, onlySpec, onlyFigs };
}

function check({ freshBuild = false } = {}) {
  let ok = true;
  const line = (label, value, good) => {
    if (!good) ok = false;
    process.stdout.write(`  ${good ? '✓' : '✗'} ${label}：${value}\n`);
  };

  process.stdout.write('\n形式核验\n');

  if (!freshBuild) {
    const manifestFile = path.join(OUT_DIR, 'build-manifest.json');
    let matched = false;
    try { matched = JSON.stringify(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).hashes) === JSON.stringify(currentManifest()); } catch {}
    line('来源与 PDF 一致性', matched ? '源文件与 PDF 的 SHA-256 均匹配' : '缺少记录或文件已改动，请完整重新编译', matched);
  }

  const dropped = [];
  for (const doc of DOCS) {
    const miss = missingChars(doc.job);
    if (miss.length) dropped.push(`${doc.out}: ${miss.join(' ')}`);
  }
  line(
    '缺字（字体无字形，会在 PDF 里静默消失）',
    dropped.length ? dropped.join('；') : '无',
    dropped.length === 0
  );

  const chars = abstractChars();
  line('摘要字数（限 300）', `${chars} 字`, chars !== null && chars <= 300);

  process.stdout.write('  提示：摘要五要素、权项引用逻辑及附图缩小后的可辨性须人工复核；不以关键词命中宣称合规。\n');

  const first = descriptionFirstLine();
  line(
    '说明书首行正文是发明名称（不含页眉）',
    first === null ? '未生成' : `「${first}」`,
    first !== null && first === (fs.readFileSync(path.join(TEX_DIR, 'description.tex'), 'utf8').match(/^\\inventiontitle\{([^}]+)\}/m) || [])[1]
  );

  const claims = claimCount();
  line('权利要求项数', `${claims} 项（超出 10 项的部分每项加收附加费）`, claims >= 1);

  const orphans = [];
  for (const doc of DOCS.filter((d) => d.filing)) {
    const pdf = path.join(OUT_DIR, `${doc.out}.pdf`);
    if (fs.existsSync(pdf)) {
      for (const hit of orphanHeadings(pdf)) orphans.push(`${doc.out} ${hit}`);
    }
  }
  line('孤标题（标题落在页末、正文翻页）', orphans.length ? orphans.join('；') : '无', orphans.length === 0);

  const nm = numeralCrossCheck();
  line(
    '附图标记双向一致',
    nm.onlySpec.length || nm.onlyFigs.length
      ? `说明书独有 ${nm.onlySpec.join('/') || '无'}；附图独有 ${nm.onlyFigs.join('/') || '无'}`
      : `${nm.spec} 个标记，说明书与附图完全对应`,
    !nm.onlySpec.length && !nm.onlyFigs.length
  );

  for (const doc of DOCS) {
    const pdf = path.join(OUT_DIR, `${doc.out}.pdf`);
    if (!fs.existsSync(pdf)) {
      line(doc.out, '未生成', false);
      continue;
    }
    const info = pdfInfo(pdf);
    line(
      `${doc.out}.pdf`,
      `${info.pages} 页，${info.a4 ? 'A4' : '页面尺寸异常'}`,
      info.a4 && info.pages > 0
    );
  }

  if (!layoutCheck()) ok = false;

  process.stdout.write(ok ? '\n自动形式检查通过；XML 提交校验与实体审查另行进行。\n' : '\n有未通过项，见上\n');
  return ok;
}

function main() {
  const arg = process.argv[2];
  if (arg === '--check') {
    process.exit(check() ? 0 : 1);
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = arg ? DOCS.filter((d) => d.job === arg || d.out === arg) : DOCS;
  if (targets.length === 0) {
    process.stderr.write(`未知目标 ${arg}；可选：${DOCS.map((d) => d.job).join(' / ')}\n`);
    process.exit(1);
  }

  for (const doc of targets) {
    if (doc.last) writePageCounts();
    compile(doc.job);
    const src = path.join(BUILD_DIR, `${doc.job}.pdf`);
    const dst = path.join(OUT_DIR, `${doc.out}.pdf`);
    fs.copyFileSync(src, dst);
    process.stdout.write(
      `${doc.out.padEnd(6)} ${String(pdfInfo(dst).pages).padStart(3)} 页  ` +
        `${(fs.statSync(dst).size / 1024).toFixed(0).padStart(4)} KB  [${doc.kind}]\n`
    );
  }

  if (!arg) {
    const ok = check({ freshBuild: true });
    if (ok) fs.writeFileSync(path.join(OUT_DIR, 'build-manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), hashes: currentManifest(),
      documents: DOCS.map(d => ({ job: d.job, file: d.out + '.pdf', pages: pdfInfo(path.join(OUT_DIR, d.out + '.pdf')).pages })),
    }, null, 2) + '\n');
    process.exitCode = ok ? 0 : 1;
  } else {
    const doc = targets[0];
    const good = missingChars(doc.job).length === 0 && (!doc.filing || layoutCheck(doc.job));
    process.exitCode = good ? 0 : 1;
  }
}

main();
