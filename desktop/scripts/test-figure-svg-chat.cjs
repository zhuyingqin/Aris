// Real React + SVG-Edit controls, using local fixtures only. No model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');
const assets = path.join(desktop, 'dist/assets');
const css = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(name => name.startsWith('main-') && name.endsWith('.css'))));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320"><rect width="600" height="320" fill="white"/><g id="input"><rect x="50" y="110" width="170" height="100" rx="12" fill="#e5e0f9"/><text x="135" y="166" text-anchor="middle" font-size="22">输入 / Input</text></g><path d="M220 160H380" stroke="#706096" stroke-width="3"/><path d="M368 152L380 160L368 168" fill="none" stroke="#706096" stroke-width="3"/><g id="output"><rect x="380" y="110" width="170" height="100" rx="12" fill="#e0eff6"/><text x="465" y="166" text-anchor="middle" font-size="22">输出 / Output</text></g></svg>';
const identity = { model: 'fixture', provider: 'fixture', endpoint: 'https://fixture.invalid', transport: 'chat_completions', signature: 'fixture' };
const initial = { schemaVersion: 1, id: 'a'.repeat(32), title: 'SVG 对话测试', method: 'Input to output', style: 'paper', sourceMode: 'import', sourceMime: 'image/png', sourceHash: 'original', status: 'accepted', outputLimit: 0, executor: identity, reviewer: identity, executorVision: true, reviewerVision: true, revisionUsed: false, requests: [], review: null, svgEdits: [], error: null, createdAt: '', updatedAt: '',
  versions: [{ index: 1, hash: 'v1', svgPath: '', pngPath: '', pdfPath: '', author: 'user', classification: 'editable_vector', textCount: 2, vectorCount: 4, reviewStatus: 'accepted', renderer: 'fixture', fontFingerprint: 'fixture', createdAt: '' }] };
const mockApi = `
let run=${JSON.stringify(initial)}, active=false, notify=()=>{};
const documents=[${JSON.stringify(svg)}];window.__svgCalls=[];
const view=()=>({projectId:'fixture',run:structuredClone(run),active});
export const figuresAvailable=()=>true;
export const figureList=async()=>[view()];
export const figureConnections=async()=>({executor:run.executor,reviewer:run.reviewer,image:{enabled:false,available:false,models:[]}});
export const onFigureUpdated=async callback=>{notify=callback;return()=>{notify=()=>{}}};
export const figureDocument=async(_project,_id,index)=>({svg:documents[(index??documents.length)-1],sourceDataUrl:null,previewDataUrl:null});
export const figureEditSvg=async input=>{
 if(active)throw Error('duplicate');window.__svgCalls.push(input);active=true;run.status='editing_svg';
 const edit={id:input.editId,baseVersion:input.baseIndex,baseHash:input.expectedHash,prompt:input.prompt,resultVersion:null,status:'running',error:null,createdAt:'',finishedAt:null};run.svgEdits.push(edit);
 setTimeout(()=>{const index=documents.length+1;documents.push(documents.at(-1).replace(/font-size="[0-9]+"/g,'font-size="'+(20+index*3)+'"'));run.versions.push({...run.versions[0],index,hash:'v'+index,parentIndex:index-1,author:'executor_edit',svgEditId:input.editId});Object.assign(edit,{resultVersion:index,status:'completed'});active=false;run.status='accepted';notify(view())},160);
 return view();
};
const reject=()=>{throw Error('No external action allowed in SVG chat fixture')};
export const figurePrepare=reject,figureStart=reject,figureSave=reject,figureReview=reject,figureCancel=reject,figureExport=reject,figureDelete=reject,figureEditImage=reject,figureSelectRaster=reject,figureRasterDocument=reject,figureExportRaster=reject,figureEditResultDocument=reject,figureResolveEditResult=reject;
`;
const mockStore = `const state={currentProject:{id:'fixture',name:'SomniFig'},language:new URLSearchParams(location.search).get('language')==='en'?'en':'cn',setTab:()=>{},setFigureDirty:()=>{}};export const useStore=Object.assign(selector=>selector(state),{getState:()=>state});`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import FigureStudio from './src/figures/FigureStudio.tsx';createRoot(document.getElementById('workspace')).render(React.createElement(FigureStudio));`, resolveDir: desktop, loader: 'tsx' }, bundle: true, write: false, outfile: 'preview.js', format: 'esm', jsx: 'automatic', target: 'esnext', define: { 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'svg-fixtures', setup(build) {
    build.onResolve({ filter: /^(?:\.\.\/|\.\/)(?:.*\/)?store$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    build.onResolve({ filter: /^\.\/figureApi$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    build.onResolve({ filter: /api\/tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api' ? mockApi : args.path === 'store' ? mockStore : 'export const isTauri=()=>false;export const fileOpen=()=>{};export const fileReveal=()=>{};', loader: 'js' }));
  } }] });
  const files = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.contents]));
  const publicRoot = path.join(desktop, 'public');
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const url = request.url.split('?')[0];
    if (url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/global.css"><link rel="stylesheet" href="/preview.css"></head><body><div id="workspace" style="height:100vh"></div><script type="module" src="/preview.js"></script></body></html>'); return; }
    let data = url === '/global.css' ? css : files.get(url);
    if (!data && url.startsWith('/figure-editor/')) {
      const resolved = path.resolve(publicRoot, '.' + decodeURIComponent(url));
      if (resolved.startsWith(publicRoot + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) data = fs.readFileSync(resolved);
    }
    if (!data) { response.writeHead(404); response.end(); return; }
    const ext = path.extname(url); response.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' })[ext] || 'application/octet-stream'); response.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => /^(http:\/\/127\.0\.0\.1:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
    const output = path.resolve(desktop, '../.somniq/diagnostics/svg-conversation'); fs.mkdirSync(output, { recursive: true });
    for (const language of ['cn', 'en']) {
      await page.goto('http://127.0.0.1:' + server.address().port + '/?language=' + language);
      await page.getByRole('button').filter({ hasText: 'SVG 对话测试' }).click();
      await page.frameLocator('iframe[title="SVG-Edit"]').locator('#svgcontent text').first().waitFor();
      await page.getByRole('button', { name: language === 'cn' ? 'SVG 源码' : 'SVG source', exact: true }).click();
      const source = page.getByRole('textbox', { name: 'SVG', exact: true });
      await page.waitForFunction(() => document.querySelectorAll('.figure-source .cm-line span').length > 8);
      const colors = await source.locator('span').evaluateAll(spans => [...new Set(spans.map(span => getComputedStyle(span).color))]);
      assert(colors.length >= 3, 'SVG tags, attributes and strings have distinct syntax colors');
      assert.equal(await page.getByRole('button', { name: /^(保存新版本|Save version)/ }).isDisabled(), true);
      await source.click(); await source.press('Control+End'); await source.press('Space');
      await page.getByRole('button', { name: language === 'cn' ? '放弃编辑' : 'Discard edits', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: /^(保存新版本|Save version)/ }).isDisabled(), true);
      await page.screenshot({ path: path.join(output, language + '-source-light.png') });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: path.join(output, language + '-source-dark.png') });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.getByRole('button', { name: language === 'cn' ? '画布' : 'Canvas', exact: true }).click();
      await page.getByRole('button', { name: language === 'cn' ? '对话修改' : 'Edit with chat', exact: true }).click();
      const input = page.getByLabel(language === 'cn' ? 'SVG 修改要求' : 'SVG edit instructions');
      const send = page.getByRole('button', { name: language === 'cn' ? '修改 SVG' : 'Edit SVG', exact: true });
      await input.fill('把文字放大，保留箭头和模块布局'); await send.dblclick();
      await page.getByText(language === 'cn' ? '修改已保存，审查通过。' : 'Edit saved and review passed.', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), ''); assert.equal(await page.evaluate(() => window.__svgCalls.length), 1);
      await input.fill('再放大一点'); await send.click();
      await page.waitForFunction(() => document.querySelectorAll('.figure-svg-turn').length === 2 && document.querySelectorAll('.figure-svg-reply button').length === 2);
      assert.deepEqual(await page.evaluate(() => window.__svgCalls.map(call => [call.baseIndex, call.expectedHash])), [[1, 'v1'], [2, 'v2']]);
      await page.getByRole('button', { name: /^(查看|View) v2$/ }).click();
      assert.equal(await send.isDisabled(), true);
      await page.locator('.figure-svg-compose').getByRole('button', { name: language === 'cn' ? '返回当前版本' : 'Back to current', exact: true }).click();
      for (const width of [1280, 960, 720]) {
        await page.setViewportSize({ width, height: 900 });
        // Let React apply its responsive panel-collapse handler before opening it.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const toggle = page.getByRole('button', { name: language === 'cn' ? '对话修改' : 'Edit with chat', exact: true });
        if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
        await input.waitFor();
        await page.locator('.figure-svg-chat').waitFor({ state: 'visible' });
        const bounds = await page.locator('.figure-svg-chat').boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: path.join(output, language + '-' + width + '.png') });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    assert.deepEqual(errors, []); console.log('SVG source and conversation: syntax colors, edit/discard, light/dark themes, sequential edits, history, bilingual layout and original editor passed.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
