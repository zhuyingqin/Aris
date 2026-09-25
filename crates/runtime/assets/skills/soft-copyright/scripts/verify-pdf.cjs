#!/usr/bin/env node
/**
 * 校验生成的 PDF 是否满足软著登记的形式要求：
 *   - 页数
 *   - 页脚页码是否真正逐页递增（不是每页都印「第 1 页」）
 *
 * 为什么必须验页码：Chromium 下用 position:fixed 元素配合 CSS counter(page)
 * 画页码，元素每页重绘但计数器只解析一次，60 页会全部印成「第 1 页」。
 * 该缺陷在 HTML 预览中完全看不出来，只能从产出的 PDF 里验。
 *
 * 做法：解压 PDF 内容流，自动定位「出现次数 == 页数」的长十六进制串作为
 * 页脚固定前缀，取其后第二个串作为页码字形，按首页必为 1 反推 CID 基准。
 *
 * 用法：node verify-pdf.cjs <pdf路径> [期望页数]
 */

const fs = require('fs');
const zlib = require('zlib');

function inflateStreams(buf) {
  const s = buf.toString('latin1');
  const streams = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const a = m.index + m[0].length;
    const b = s.indexOf('endstream', a);
    if (b < 0) continue;
    try {
      streams.push(
        zlib.inflateSync(Buffer.from(s.slice(a, b), 'latin1')).toString('latin1')
      );
    } catch {
      /* 非 Flate 流或已损坏，跳过 */
    }
  }
  return { streams, raw: s };
}

function main() {
  const file = process.argv[2];
  const expect = process.argv[3] ? Number(process.argv[3]) : null;
  if (!file || !fs.existsSync(file)) {
    throw new Error('用法：node verify-pdf.cjs <pdf路径> [期望页数]');
  }

  const buf = fs.readFileSync(file);
  const { streams, raw } = inflateStreams(buf);
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;

  process.stdout.write(`文件：${file}\n`);
  process.stdout.write(`页数：${pages}`);
  if (expect !== null) {
    process.stdout.write(pages === expect ? `  ✓ 符合预期\n` : `  ✗ 预期 ${expect}\n`);
  } else {
    process.stdout.write('\n');
  }

  // 定位页脚签名：恰好在每一页各出现一次的长十六进制串
  const freq = new Map();
  for (const st of streams) {
    const uniq = new Set(
      [...st.matchAll(/<([0-9A-Fa-f]{20,})>/g)].map((x) => x[1])
    );
    for (const t of uniq) freq.set(t, (freq.get(t) || 0) + 1);
  }
  const sig = [...freq]
    .filter(([, c]) => c === pages)
    .sort((a, b) => b[0].length - a[0].length)[0];

  if (!sig) {
    // 页脚写死在正文流里的文档（如源程序），PDF 侧反查不可靠，
    // 改从同名 HTML 校验：那里的页码是生成时逐页写入的字面量。
    const html = file.replace(/\.pdf$/, '.html');
    if (fs.existsSync(html)) {
      const src = fs.readFileSync(html, 'utf8');
      const baked = [...src.matchAll(/第\s*(\d+)\s*页\s*(?:&nbsp;)?\s*\//g)].map((m) =>
        Number(m[1])
      );
      if (baked.length) {
        const ok =
          baked.length === pages && baked.every((v, i) => v === i + 1);
        process.stdout.write(
          `页码：文档自带（写死在各页容器内），从 HTML 校验 ${baked.length} 个\n`
        );
        process.stdout.write(
          ok
            ? `      ✓ 1..${pages} 严格递增，且与 PDF 页数一致\n`
            : `      ✗ HTML 中的页码为 ${baked.length} 个，与 PDF 的 ${pages} 页不符\n`
        );
        process.exit(!ok || (expect !== null && pages !== expect) ? 1 : 0);
      }
    }
    process.stdout.write(
      '页码：未能定位页脚签名，且无同名 HTML 可校验——请人工确认页脚\n'
    );
    process.exit(expect !== null && pages !== expect ? 1 : 0);
  }

  const nums = [];
  for (const st of streams) {
    const hex = [...st.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
    const i = hex.indexOf(sig[0]);
    if (i >= 0 && hex[i + 2]) nums.push(hex[i + 2]);
  }
  if (!nums.length) {
    process.stdout.write('页码：未取到页码字形\n');
    process.exit(1);
  }

  // 首页页码必为 1，据此反推数字 0 的 CID 基准
  const base = parseInt(nums[0], 16) - 1;
  const decoded = nums.map((h) =>
    (h.match(/.{4}/g) || []).map((c) => String(parseInt(c, 16) - base)).join('')
  );
  const ok =
    decoded.length === pages && decoded.every((v, i) => Number(v) === i + 1);

  process.stdout.write(
    `页码：检出 ${decoded.length} 个，序列 ${decoded.slice(0, 3).join(',')}` +
      ` … ${decoded.slice(-3).join(',')}\n`
  );
  process.stdout.write(
    ok
      ? `      ✓ 1..${pages} 严格递增\n`
      : `      ✗ 页码未正确递增（常见原因：用 CSS counter(page) 画页码）\n`
  );

  const bad = !ok || (expect !== null && pages !== expect);
  process.exit(bad ? 1 : 0);
}

try {
  main();
} catch (e) {
  process.stderr.write('错误：' + e.message + '\n');
  process.exit(2);
}
