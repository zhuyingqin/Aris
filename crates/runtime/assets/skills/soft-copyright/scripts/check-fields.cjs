#!/usr/bin/env node
/**
 * 校验「软著登记-申请表填写模板.md」中各字段的字数是否满足登记系统的限制。
 *
 * 为什么需要这个脚本：登记系统对不同字段的字数限制方向不一致——
 * 环境类短字段是**上限**，主要功能是**下限**，技术特点又是上限。
 * 靠肉眼数中文字数极易出错，且一旦超限/不足会被退回补正。
 *
 * 用法：
 *   node check-fields.cjs [模板路径]     默认 copyright/软著登记-申请表填写模板.md
 *
 * 模板中每个字段形如：
 *   ### 2.9 软件的开发目的
 *   ▶ 填写内容（...）：
 *   ```
 *   待校验的内容
 *   ```
 *
 * 规则在下方 RULES 中按字段号配置。不在表中的字段按默认上限 50 校验。
 * 中文字数按「去除空白字符后的字符数」计（登记系统的通行口径）。
 */

const fs = require('fs');
const path = require('path');

/** [最小值, 最大值]，null 表示该侧不限 */
const RULES = {
  '2.8': null, // 源程序量：纯数字，不校验
  '2.9': [50, 50], // 开发目的：限 50。上/下限口径不明时压到正好 50，两种解读都过
  '2.10': [50, 50], // 面向领域：同上
  '2.11': [500, null], // 主要功能：不少于 500 字
  '2.12': [null, 100], // 技术特点：100 字以内
};
const DEFAULT_RULE = [null, 50];

function describe([mn, mx]) {
  if (mn !== null && mn === mx) return `正好 ${mn}`;
  if (mn !== null && mx !== null) return `${mn}–${mx}`;
  if (mn !== null) return `≥${mn}`;
  return `≤${mx}`;
}

function main() {
  const file = path.resolve(
    process.argv[2] || 'copyright/软著登记-申请表填写模板.md'
  );
  if (!fs.existsSync(file)) {
    throw new Error(`未找到模板：${file}`);
  }
  const doc = fs.readFileSync(file, 'utf8');
  const hits = [...doc.matchAll(/^### ((?:1\.\d+|2\.\d+) [^\n]+)$/gm)];
  if (!hits.length) {
    throw new Error('模板中未找到形如「### 2.9 软件的开发目的」的字段标题。');
  }

  const stopAt = doc.indexOf('\n---\n\n## 3.');
  let bad = 0;
  let checked = 0;
  const rows = [];

  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end =
      i + 1 < hits.length ? hits[i + 1].index : stopAt > 0 ? stopAt : doc.length;
    const title = hits[i][1];
    const num = title.split(' ')[0];
    const block = doc.slice(start, end).match(/```\n([\s\S]*?)\n```/);

    if (!block) {
      rows.push(['–', title, '选择项', '']);
      continue;
    }
    const value = block[1].trim();
    if (value.startsWith('【')) {
      rows.push(['□', title, '占位待填', '']);
      continue;
    }
    if (RULES[num] === null) {
      rows.push(['–', title, `${[...value].length} 字`, '不校验']);
      continue;
    }

    const rule = RULES[num] || DEFAULT_RULE;
    const [mn, mx] = rule;
    const n = [...value.replace(/\s/g, '')].length;
    const ok = (mn === null || n >= mn) && (mx === null || n <= mx);
    if (!ok) bad += 1;
    checked += 1;

    let note = '';
    if (!ok && mn !== null && n < mn) note = `差 ${mn - n} 字`;
    if (!ok && mx !== null && n > mx) note = `超 ${n - mx} 字`;
    rows.push([ok ? '✓' : '✗', title, `${n} 字`, `要求 ${describe(rule)} ${note}`]);
  }

  const w1 = Math.max(...rows.map((r) => [...r[1]].length));
  for (const [mark, title, val, note] of rows) {
    const pad = ' '.repeat(w1 - [...title].length);
    process.stdout.write(`${mark}  ${title}${pad}  ${val.padStart(7)}  ${note}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(
    bad === 0
      ? `✓ 已校验 ${checked} 个字段，全部满足字数要求\n`
      : `✗ ${bad} 项不合格，需修改后再提交\n`
  );
  process.exit(bad === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  process.stderr.write('错误：' + e.message + '\n');
  process.exit(2);
}
