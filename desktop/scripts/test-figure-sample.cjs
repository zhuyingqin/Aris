// Local checks for a frozen image-reconstruction sample. No model calls.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const workspace = path.resolve(process.env.SOMNIQ_FIGURE_P0_WORKSPACE || path.join(__dirname, '../..'));
const sampleDirectory = path.resolve(process.argv[2] || path.join(workspace, '.somniq/tmp/figures-dev-02'));
const sample = JSON.parse(fs.readFileSync(path.join(sampleDirectory, 'sample.json'), 'utf8'));
const pointer = JSON.parse(fs.readFileSync(path.join(sampleDirectory, 'live-run.json'), 'utf8'));
assert.match(pointer.runId, /^[0-9a-f]{32}$/);
const runDirectory = path.join(workspace, '.somniq/artifacts/figures', pointer.runId);
const run = JSON.parse(fs.readFileSync(path.join(runDirectory, 'manifest.json'), 'utf8'));
const version = run.versions.at(-1);
assert.ok(version, 'No reconstruction version exists');
const generated = fs.readFileSync(path.join(runDirectory, version.svgPath), 'utf8');
const vendorRoot = path.resolve(__dirname, '../public/figure-editor');
const wrapperRoot = path.resolve(__dirname, '../figure-editor');
const wrapper = Object.fromEntries(['index.html', 'bridge.js'].map(name => [name, fs.readFileSync(path.join(wrapperRoot, name))]));
const channel = crypto.randomBytes(16).toString('hex');
const report = { sampleId: sample.sampleId, runId: run.id, authorship: sample.authorship || 'model_reconstruction', modelRequests: 0, nativeWebView2: false };
const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><body style="margin:0"><iframe id="editor" sandbox="allow-scripts" src="/editor/index.html#${channel}" style="width:1850px;height:1230px;border:0"></iframe><script>window.messages=[];addEventListener('message',event=>{if(event.source===document.getElementById('editor').contentWindow&&event.data.channel==='${channel}')messages.push(event.data)})</script></body></html>`); return;
  }
  if (!request.url.startsWith('/editor/')) { response.writeHead(404); response.end(); return; }
  const relative = decodeURIComponent(request.url.split('?')[0].slice('/editor/'.length));
  const file = path.resolve(vendorRoot, relative);
  if (!file.startsWith(vendorRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  const bytes = wrapper[relative] || (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null);
  if (!bytes) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
  response.end(bytes);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1880, height: 1250 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    report.svg = await page.evaluate(({ svg, labels, occurrences }) => {
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = document.documentElement;
      const texts = [...document.querySelectorAll('text')].map(node => node.textContent.replace(/\s/g, ''));
      const normalize = value => value.replace(/\s/g, '').normalize('NFKC');
      const exact = labels.filter(label => texts.includes(label.replace(/\s/g, '')));
      const semantic = labels.filter(label => texts.some(text => normalize(text) === normalize(label)));
      const actualOccurrences = Object.fromEntries(Object.keys(occurrences).map(label => [label, texts.filter(text => normalize(text) === normalize(label)).length]));
      return { width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')), textCount: texts.length, imageCount: document.querySelectorAll('image').length, clipPathCount: document.querySelectorAll('clipPath').length, exactLabels: exact, semanticLabels: semantic, missingExactLabels: labels.filter(label => !exact.includes(label)), missingSemanticLabels: labels.filter(label => !semantic.includes(label)), actualOccurrences, insufficientOccurrences: Object.keys(occurrences).filter(label => actualOccurrences[label] < occurrences[label]), groupsWithRectangleAndLabel: [...document.querySelectorAll('g')].filter(group => group.querySelector('rect') && [...group.querySelectorAll('text')].some(node => labels.some(label => normalize(node.textContent) === normalize(label))) && [...group.querySelectorAll('text')].filter(node => labels.some(label => normalize(node.textContent) === normalize(label))).length <= 2).length };
    }, { svg: generated, labels: sample.requiredLabels, occurrences: sample.requiredOccurrences || {} });
    report.aspectRatioDifferencePercent = ((report.svg.width / report.svg.height) / (sample.sourceWidth / sample.sourceHeight) - 1) * 100;
    report.allRequiredLabelsPresent = report.svg.semanticLabels.length === sample.requiredLabels.length;
    // Record the untouched model SVG even if an editor operation later fails.
    await page.setViewportSize({ width: report.svg.width, height: report.svg.height });
    await page.setContent(`<html><body style="margin:0">${generated}</body></html>`);
    await page.locator('svg').screenshot({ path: path.join(sampleDirectory, 'browser-render.png') });
    await page.setViewportSize({ width: 1880, height: 1250 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const waitMessage = id => page.waitForFunction(id => window.messages.some(message => message.requestId === id && ['loaded', 'serialized', 'error'].includes(message.type)), id, { timeout: 15000 });
    const load = async (svg, id) => { await page.evaluate(({ channel, svg, id }) => document.getElementById('editor').contentWindow.postMessage({ channel, type: 'load', requestId: id, svg }, '*'), { channel, svg, id }); await waitMessage(id); assert.equal(await page.evaluate(id => window.messages.find(message => message.requestId === id).type, id), 'loaded'); };
    const serialize = async id => { await page.evaluate(({ channel, id }) => document.getElementById('editor').contentWindow.postMessage({ channel, type: 'serialize', requestId: id }, '*'), { channel, id }); await waitMessage(id); return page.evaluate(id => window.messages.find(message => message.requestId === id).svg, id); };
    await page.waitForFunction(() => window.messages.some(message => message.type === 'ready'), null, { timeout: 30000 });
    await load(generated, 'generated');
    const frame = page.frameLocator('#editor');
    if (sample.moveGroupId) {
      const module = frame.locator(`#svgcontent [id="${sample.moveGroupId}"]`);
      const shape = module.locator('use').first();
      const text = module.locator('text').first();
      const beforeShape = await shape.boundingBox();
      const beforeText = await text.boundingBox();
      assert.ok(beforeShape && beforeText);
      const start = { x: beforeShape.x + beforeShape.width / 2, y: beforeShape.y + beforeShape.height / 3 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 28, start.y + 18, { steps: 8 });
      await page.mouse.up();
      const afterShape = await shape.boundingBox();
      const afterText = await text.boundingBox();
      const dx = afterText.x - beforeText.x;
      const dy = afterText.y - beforeText.y;
      assert.ok(Math.abs(dx) > 5 && Math.abs(dy) > 5, 'Module label did not move');
      assert.ok(Math.abs((afterShape.x - beforeShape.x) - dx) < 1 && Math.abs((afterShape.y - beforeShape.y) - dy) < 1, 'Icon and label moved separately');
      await frame.locator('#tool_undo').click();
      const restored = await text.boundingBox();
      assert.ok(Math.abs(restored.x - beforeText.x) < 1 && Math.abs(restored.y - beforeText.y) < 1, 'Module undo did not restore its position');
      report.groupMoveAndUndo = { id: sample.moveGroupId, labelDelta: { dx, dy }, iconAndLabelTogether: true };
    }
    const editLabel = sample.editLabel || sample.requiredLabels[0];
    const labelPattern = new RegExp(`^${editLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const editedLabel = `${editLabel}（改字验证）`;
    const label = frame.locator('#svgcontent text').filter({ hasText: labelPattern }).first();
    await label.dblclick();
    await frame.locator('#text').fill(editedLabel);
    await frame.locator('#svgcontent text').filter({ hasText: editedLabel }).waitFor();
    await frame.locator('#tool_undo').click();
    await frame.locator('#svgcontent text').filter({ hasText: labelPattern }).first().waitFor();
    await frame.locator('#tool_redo').click();
    await frame.locator('#svgcontent text').filter({ hasText: editedLabel }).waitFor();
    report.textEditUndoRedo = true;
    // Restore the original text; the immutable model version is never modified.
    await frame.locator('#tool_undo').click();
    const serialized = await serialize('serialized');
    assert.ok(serialized.includes('marker-end='), 'Arrows lost during serialization');
    fs.writeFileSync(path.join(sampleDirectory, 'editor-roundtrip.svg'), serialized);
    await page.reload();
    await page.waitForFunction(() => window.messages.some(message => message.type === 'ready'), null, { timeout: 30000 });
    await load(serialized, 'reopened');
    const reopened = await serialize('reopened-svg');
    report.reopenedLabels = await page.evaluate(({ svg, labels }) => {
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const texts = [...document.querySelectorAll('text')].map(node => node.textContent.replace(/\s/g, '').normalize('NFKC'));
      return labels.filter(label => texts.includes(label.replace(/\s/g, '').normalize('NFKC')));
    }, { svg: reopened, labels: sample.requiredLabels });
    assert.deepEqual(report.reopenedLabels, report.svg.semanticLabels, 'A generated label was lost during the editor roundtrip');
    report.saveAndReopen = true;
    await page.screenshot({ path: path.join(sampleDirectory, 'editor.png') });
    const image = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
    const originalPng = image(fs.readFileSync(path.join(sampleDirectory, 'reference.png')));
    const generatedPng = image(fs.readFileSync(path.join(runDirectory, version.pngPath)));
    const html = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const subtitle = sample.comparisonSubtitle || `${sample.requiredLabels.length} 个必要标签 · ${sample.requiredRelations.length} 条关系 · 输入为 PNG 与文字要求`;
    const drawingCaption = sample.authorship === 'manual_vector_redraw' ? '手工重绘 · SVG 的原生导出 PNG' : '还原图 · 模型 SVG 的原生导出 PNG';
    const comparison = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${html(sample.sampleId)} 原图与还原图</title><style>body{margin:0;padding:28px;background:#e9eef5;color:#182b49;font-family:'Microsoft YaHei',sans-serif}h1{font-size:30px;margin:0 0 8px}p{margin:0 0 20px;font-size:19px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.figure{background:white;border-radius:12px;overflow:hidden}.label{padding:16px 20px;font-size:23px;font-weight:bold;border-bottom:1px solid #e3e8ef}.figure img{width:100%;display:block}footer{margin-top:20px;font-size:19px}</style><h1>${html(sample.sampleId)} · ${html(sample.title)}</h1><p>${html(subtitle)}</p><div class="pair"><div class="figure"><div class="label">原图 · 参考 PNG</div><img src="${originalPng}"></div><div class="figure"><div class="label">${html(drawingCaption)}</div><img src="${generatedPng}"></div></div><footer>画布 ${report.svg.width}×${report.svg.height} · 标签 ${report.svg.semanticLabels.length}/${sample.requiredLabels.length} · 独立审查状态 ${html(run.status)}${run.error ? ` · ${html(run.error)}` : ''}</footer></html>`;
    fs.writeFileSync(path.join(sampleDirectory, 'comparison.html'), comparison);
    await page.setViewportSize({ width: 2400, height: 1100 });
    await page.setContent(comparison);
    await page.screenshot({ path: path.join(sampleDirectory, 'comparison.png'), fullPage: true });
    assert.deepEqual(errors, []);
    report.errors = errors;
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; report.errors = errors; throw error; }
  finally { fs.writeFileSync(path.join(sampleDirectory, 'local-checks.json'), JSON.stringify(report, null, 2)); await browser.close(); server.close(); console.log(JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
