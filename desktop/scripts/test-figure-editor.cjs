// Real browser check of the opaque-origin SVG-Edit bridge. No model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const root = path.resolve(__dirname, '../public/figure-editor');
const fixture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker><clipPath id="clip"><rect width="480" height="180"/></clipPath></defs><g clip-path="url(#clip)"><rect id="moduleA" x="20" y="40" width="140" height="80" fill="#ddeeff"/><text x="40" y="90" font-size="22">方法 A</text><path d="M160 80H310" stroke="black" stroke-width="3" marker-end="url(#arrow)"/><rect x="315" y="40" width="140" height="80" fill="#e8ddff"/><text x="335" y="90" font-size="22">审查 B</text></g></svg>';
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
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1140, height: 750 } });
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'), null, { timeout: 30000 });
    await page.evaluate(svg => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'load', requestId: 'load', svg }, '*'), fixture);
    await page.waitForFunction(() => window.messages.some(m => m.type === 'loaded'), null, { timeout: 10000 });
    const frame = page.frameLocator('#editor');
    const box = await frame.locator('#moduleA').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'dirty'), null, { timeout: 10000 });
    await frame.locator('text').filter({ hasText: '方法 A' }).dblclick({ position: { x: 12, y: 12 } });
    await frame.locator('#text').fill('方法 A 修订');
    await frame.locator('#tool_undo').click();
    await frame.locator('text').filter({ hasText: /^方法 A$/ }).waitFor();
    await frame.locator('#tool_redo').click();
    await frame.locator('text').filter({ hasText: '方法 A 修订' }).waitFor();
    await page.evaluate(() => document.getElementById('editor').contentWindow.postMessage({ channel: 'smoke-test', type: 'serialize', requestId: 'serialize' }, '*'));
    await page.waitForFunction(() => window.messages.some(m => m.type === 'serialized'), null, { timeout: 10000 });
    const result = await page.evaluate(() => window.messages.find(m => m.type === 'serialized').svg);
    assert.ok(result.includes('matrix('), 'Drag was not preserved');
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
    for (const value of ['方法 A 修订', '审查 B', 'matrix(', 'marker-end=', 'clip-path=']) assert.ok(reopened.includes(value), `Reopening lost ${value}`);
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
    console.log('SVG-Edit round trip passed: drag + edit text + undo/redo → serialize → reopen, CJK, markers, clipping, opaque-origin isolation.');
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) { const output = path.resolve(__dirname, '../../.somniq/tmp/figures-editor-smoke'); fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'failed-editor.png') }); console.log(await page.evaluate(() => window.messages)); }
    throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n')}`);
  }
  finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
