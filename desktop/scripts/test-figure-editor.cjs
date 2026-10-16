// Real browser check of the opaque-origin SVG-Edit bridge. No model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const root = path.resolve(__dirname, '../public/figure-editor');
const fixture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker><clipPath id="clip"><rect width="480" height="180"/></clipPath></defs><g clip-path="url(#clip)"><rect id="moduleA" x="20" y="40" width="140" height="80" fill="#ddeeff"/><text x="40" y="90" font-size="22">方法 A</text><path d="M160 80H310" stroke="black" stroke-width="3" marker-end="url(#arrow)"/><rect x="315" y="40" width="140" height="80" fill="#e8ddff"/><text x="335" y="90" font-size="22">审查 B</text></g></svg>';
const typographyFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><g id="typography" font-family="Times New Roman, Times, serif" font-size="28" font-weight="bold" font-style="italic" text-anchor="middle" fill="#234567" stroke="#345678" stroke-width="0.3" transform="translate(20 12) scale(1.1 .9)"><rect id="typeBackground" x="20" y="20" width="470" height="225" fill="#eef4ff"/><text id="typeLabel" x="250" y="80">中文 AR <tspan font-size="18">t−1</tspan></text><g id="nestedTypography" style="font-size:1.2em"><text id="relativeLabel" x="250" y="145" font-size="75%">MA <tspan dy="24" x="250" font-weight="normal">多行标签</tspan></text></g><text id="inlineLabel" x="250" y="210" style="font-size:0.8em;font-family:Georgia;fill:#945123;font-weight:normal">Explicit override</text></g></svg>';
const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body style="margin:0"><iframe id="editor" title="editor" sandbox="allow-scripts" src="/index.html#smoke-test" style="width:1100px;height:700px;border:0"></iframe><script>window.messages=[];addEventListener("message",e=>{if(e.source===document.getElementById("editor").contentWindow&&e.data.channel==="smoke-test")messages.push(e.data)})</script></body></html>'); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(request.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
  response.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE || undefined });
  const errors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1140, height: 750 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'), null, { timeout: 30000 });
    await page.evaluate(svg => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'load', requestId: 'load', svg }, '*'), fixture);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'loaded'), null, { timeout: 10000 });
    const frame = page.frameLocator('#editor');
    // Appearance changes must cross the isolated bridge without touching the
    // SVG, marking the document dirty, or exposing stylesheet injection.
    const baseline = await frame.locator('#svgcontent').evaluate(element => element.outerHTML);
    for (const [mode, surface, text, accent] of [['light', '#fffaf1', '#30291f', '#7c3aed'], ['dark', '#152232', '#e1eaf5', '#67d4e8']]) {
      await page.evaluate(({ mode, surface, text, accent }) => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'theme', mode, colors: { surface, text, accent }, fontSize: 14 }, '*'), { mode, surface, text, accent });
      await frame.locator('html').evaluate((root, mode) => new Promise(resolve => {
        const check = () => root.dataset.theme === mode ? resolve() : requestAnimationFrame(check); check();
      }), mode);
      const presentation = await frame.locator('#tools_top').evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, fontSize: getComputedStyle(element).fontSize }));
      assert.notEqual(presentation.color, presentation.background, 'Toolbar text must remain readable');
      assert.equal(presentation.fontSize, '14px');
      assert.equal(await frame.locator('#svgcontent').evaluate(element => element.outerHTML), baseline, 'Theme changed the SVG');
      assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'dirty').length), 0, 'Theme caused unsaved edits');
    }
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'theme', mode: 'light', colors: { surface: 'url(https://example.invalid/leak)', text: '#1f2937', accent: '#7c3aed' }, fontFamily: 'sans-serif; background: red' }, '*'));
    await frame.locator('html').evaluate(root => new Promise(resolve => {
      const check = () => root.dataset.theme === 'light' ? resolve() : requestAnimationFrame(check); check();
    }));
    assert.equal(await frame.locator('html').evaluate(root => root.style.getPropertyValue('--somniq-surface')), '');
    assert.equal(await frame.locator('html').evaluate(root => root.style.getPropertyValue('--somniq-font-family')), '');
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'before-resize' }, '*'));
    await page.waitForFunction(() => window.messages.some(m => m.requestId === 'before-resize'));
    const beforeResize = await page.evaluate(() => window.messages.find(m => m.requestId === 'before-resize').svg);
    const initialZoom = await frame.locator('#zoom').evaluate(el => Number(el.value));
    await page.locator('#editor').evaluate(el => { el.style.width = '700px'; });
    await page.waitForTimeout(100);
    assert.ok(await frame.locator('#zoom').evaluate(el => Number(el.value)) < initialZoom, 'Initial overview did not fit the narrower canvas');
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'after-resize' }, '*'));
    await page.waitForFunction(() => window.messages.some(m => m.requestId === 'after-resize'));
    assert.equal(await page.evaluate(() => window.messages.find(m => m.requestId === 'after-resize').svg), beforeResize, 'Resizing changed the SVG');
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'dirty').length), 0, 'Resizing caused unsaved edits');
    await page.locator('#editor').evaluate(el => { el.style.width = '1100px'; });
    await page.waitForTimeout(100);
    const box = await frame.locator('#moduleA').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'dirty'), null, { timeout: 10000 });
    const editingZoom = await frame.locator('#zoom').evaluate(el => el.value);
    await page.locator('#editor').evaluate(el => { el.style.width = '700px'; });
    await page.waitForTimeout(100);
    assert.equal(await frame.locator('#zoom').evaluate(el => el.value), editingZoom, 'Resizing reset the viewport after editing');
    await page.locator('#editor').evaluate(el => { el.style.width = '1100px'; });
    await frame.locator('text').filter({ hasText: '方法 A' }).dblclick({ position: { x: 12, y: 12 } });
    await frame.locator('#text').fill('方法 A 修订');
    await frame.locator('#tool_undo').click();
    await frame.locator('text').filter({ hasText: /^方法 A$/ }).waitFor();
    await frame.locator('#tool_redo').click();
    await frame.locator('text').filter({ hasText: '方法 A 修订' }).waitFor();
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'serialize' }, '*'));
    await page.waitForFunction(() => window.messages.some(m => m.type === 'serialized' && m.requestId === 'serialize'), null, { timeout: 10000 });
    const result = await page.evaluate(() => window.messages.find(m => m.requestId === 'serialize').svg);
    assert.match(result, /transform="matrix\s*\(/, 'Drag was not preserved');
    for (const value of ['方法 A 修订', '审查 B', 'marker-end=', 'clip-path=']) assert.ok(result.includes(value), `Lost ${value}`);
    assert.ok(!result.includes('foreignObject'));
    const isolated = await frame.locator('body').evaluate(() => { try { return !parent.__TAURI_INTERNALS__; } catch { return true; } });
    assert.ok(isolated, 'Editor accessed parent IPC');
    const output = path.resolve(__dirname, '../../.somniq/tmp/figures-editor-smoke');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'roundtrip.svg'), result);
    await page.reload();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'), null, { timeout: 30000 });
    await page.evaluate(svg => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'load', requestId: 'reopen', svg }, '*'), result);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'loaded' && m.requestId === 'reopen'), null, { timeout: 10000 });
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'reopened' }, '*'));
    await page.waitForFunction(() => window.messages.some(m => m.type === 'serialized' && m.requestId === 'reopened'), null, { timeout: 10000 });
    const reopened = await page.evaluate(() => window.messages.find(m => m.requestId === 'reopened').svg);
    assert.match(reopened, /transform="matrix\s*\(/, 'Reopening lost the drag');
    for (const value of ['方法 A 修订', '审查 B', 'marker-end=', 'clip-path=']) assert.ok(reopened.includes(value), `Reopening lost ${value}`);
    const load = async (svg, requestId) => {
      await page.evaluate(({ svg, requestId }) => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'load', requestId, svg }, '*'), { svg, requestId });
      await page.waitForFunction(id => window.messages.some(m => m.type === 'loaded' && m.requestId === id), requestId);
      await page.waitForTimeout(100);
    };
    const serialize = async (requestId) => {
      await page.evaluate(requestId => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId }, '*'), requestId);
      await page.waitForFunction(id => window.messages.some(m => m.type === 'serialized' && m.requestId === id), requestId);
      return page.evaluate(id => window.messages.find(m => m.requestId === id).svg, requestId);
    };
    const textAppearance = () => frame.locator('#svgcontent').evaluate(root => [...root.querySelectorAll('text,tspan')].map(el => {
      const css = getComputedStyle(el), box = el.getBBox();
      const matrix = root.getScreenCTM().inverse().multiply(el.getScreenCTM());
      const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      return { id: el.id, text: el.textContent, style: Object.fromEntries(['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'fill', 'stroke', 'stroke-width'].map(key => [key, css.getPropertyValue(key)])), bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
    }));
    const sameTextAppearance = (actual, expected, action) => {
      assert.equal(actual.length, expected.length, `${action}: lost text/tspans`);
      actual.forEach((value, i) => {
        assert.deepEqual({ id: value.id, text: value.text, style: value.style }, { id: expected[i].id, text: expected[i].text, style: expected[i].style }, `${action}: changed ${value.id}`);
        value.bounds.forEach((number, j) => assert.ok(Math.abs(number - expected[i].bounds[j]) < .05, `${action}: moved/resized ${value.id}: ${value.bounds} vs ${expected[i].bounds}`));
      });
    };
    await load(typographyFixture, 'typography-load');
    const beforeUngroup = await serialize('typography-before');
    const beforeAppearance = await textAppearance();
    await frame.locator('#typeBackground').click({ position: { x: 10, y: 10 } });
    await frame.locator('#tool_ungroup').click();
    assert.equal(await frame.locator('#typography').count(), 0, 'Ungroup did not remove the group');
    sameTextAppearance(await textAppearance(), beforeAppearance, 'Ungroup');
    const afterUngroup = await serialize('typography-after');
    await frame.locator('#tool_undo').click();
    assert.equal(await serialize('typography-undone'), beforeUngroup, 'One Undo must restore group and original styles');
    await frame.locator('#tool_redo').click();
    sameTextAppearance(await textAppearance(), beforeAppearance, 'Redo ungroup');
    assert.equal(await serialize('typography-redone'), afterUngroup);
    await load(afterUngroup, 'typography-reopen');
    sameTextAppearance(await textAppearance(), beforeAppearance, 'Reopen ungrouped SVG');
    await frame.locator('#relativeLabel tspan').click();
    await frame.locator('#tool_ungroup').click();
    assert.equal(await frame.locator('#nestedTypography').count(), 0);
    sameTextAppearance(await textAppearance(), beforeAppearance, 'Ungroup nested relative fonts');
    await frame.locator('#typeLabel').dblclick();
    await frame.locator('#font_size').evaluate(el => { el.value = '32'; el.dispatchEvent(new Event('change')); });
    assert.equal(await frame.locator('#typeLabel').evaluate(el => getComputedStyle(el).fontSize), '32px', 'Preserved font must still be editable');
    await frame.locator('#tool_undo').click();
    sameTextAppearance(await textAppearance(), beforeAppearance, 'Undo font edit after ungroup');
    fs.writeFileSync(path.join(output, 'ungroup-roundtrip.svg'), await serialize('nested-ungroup-saved'));
    await load(typographyFixture.replace('translate(20 12) scale(1.1 .9)', 'rotate(6 260 125)'), 'rotated-typography-load');
    const beforeRotationUngroup = await serialize('rotation-before');
    const rotatedAppearance = await textAppearance();
    await frame.locator('#typeLabel').click();
    await frame.locator('#tool_ungroup').click();
    sameTextAppearance(await textAppearance(), rotatedAppearance, 'Ungroup rotated text');
    await frame.locator('#tool_undo').click();
    assert.equal(await serialize('rotation-undone'), beforeRotationUngroup, 'Undo must restore rotated group and child transforms');
    await frame.locator('#tool_redo').click();
    sameTextAppearance(await textAppearance(), rotatedAppearance, 'Redo rotated ungroup');
    await load(await serialize('rotation-saved'), 'rotation-reopen');
    sameTextAppearance(await textAppearance(), rotatedAppearance, 'Reopen rotated ungroup');
    if (process.env.SOMNIQ_FIGURE_EDITOR_UNGROUP_SVG) {
      await load(fs.readFileSync(process.env.SOMNIQ_FIGURE_EDITOR_UNGROUP_SVG, 'utf8'), 'real-ungroup-load');
      const originalAppearance = await textAppearance();
      const original = await serialize('real-ungroup-before');
      for (let depth = 0; depth < 2; depth++) {
        await frame.locator('#svgcontent text').first().click();
        await frame.locator('#tool_ungroup').click();
        sameTextAppearance(await textAppearance(), originalAppearance, `Real SVG ungroup ${depth + 1}`);
      }
      const ungrouped = await serialize('real-ungroup-after');
      assert.notEqual(ungrouped, original, 'Real SVG was not ungrouped');
      await frame.locator('#tool_undo').click();
      await frame.locator('#tool_undo').click();
      assert.equal(await serialize('real-ungroup-undone'), original, 'Real SVG undo lost original styles/groups');
      await load(ungrouped, 'real-ungroup-reopen');
      sameTextAppearance(await textAppearance(), originalAppearance, 'Real SVG ungroup saved and reopened');
      fs.writeFileSync(path.join(output, 'real-ungroup-roundtrip.svg'), ungrouped);
      console.log(`Real SVG ungroup preserved ${originalAppearance.length} text/tspan nodes, typography and document bounds.`);
    }
    if (process.env.SOMNIQ_FIGURE_EDITOR_SVG) {
      const generated = fs.readFileSync(process.env.SOMNIQ_FIGURE_EDITOR_SVG, 'utf8');
      await page.evaluate(svg => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'load', requestId: 'real-model', svg }, '*'), generated);
      await page.waitForFunction(() => window.messages.some(m => m.type === 'loaded' && m.requestId === 'real-model'), null, { timeout: 10000 });
      await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'real-serialized' }, '*'));
      await page.waitForFunction(() => window.messages.some(m => m.type === 'serialized' && m.requestId === 'real-serialized'), null, { timeout: 10000 });
      const saved = await page.evaluate(() => window.messages.find(m => m.requestId === 'real-serialized').svg);
      for (const value of ['研究问题', '独立审查', '证据产物', 'marker-end=']) assert.ok(saved.includes(value), `Generated SVG lost ${value}`);
      fs.writeFileSync(path.join(output, 'generated-roundtrip.svg'), saved);
    }
    await page.screenshot({ path: path.join(output, 'editor.png') });
    console.log('SVG-Edit round trip passed: drag, text edit, ungroup with inherited/relative fonts, undo/redo, serialize/reopen, CJK, markers, clipping, opaque-origin isolation.');
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) { const output = path.resolve(__dirname, '../../.somniq/tmp/figures-editor-smoke'); fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'failed-editor.png') }); console.log(await page.evaluate(() => window.messages.map(({ svg, ...message }) => ({ ...message, ...(svg ? { svgChars: svg.length } : {}) })))); }
    throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n')}`);
  }
  finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
