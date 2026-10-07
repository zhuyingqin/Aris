// Exercises the real React PNG editor and Canvas mask in Chromium. All model
// calls are replaced by local fixtures; no account or project data is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');
const assets = path.join(desktop, 'dist/assets');
const globalCss = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(name => name.startsWith('main-') && name.endsWith('.css'))));
const identity = { model: 'vision-fixture', provider: 'fixture', endpoint: 'https://fixture.invalid/v1', transport: 'chat_completions', signature: 'fixture' };
const fixture = { schemaVersion: 1, id: 'a'.repeat(32), title: 'PNG 圈选测试', method: 'Input → reservoir → output', style: 'paper', sourceMode: 'generate', sourceMime: 'image/png', sourceHash: 'original',
  status: 'image_ready', outputLimit: 0, executor: identity, reviewer: { ...identity, model: 'independent-fixture' }, imageIdentity: { ...identity, model: 'gpt-image-2' },
  imageConfirmed: false, sourceRaster: 1, executorVision: false, reviewerVision: false, revisionUsed: false, versions: [], requests: [], review: null, error: null, createdAt: '', updatedAt: '',
  rasterVersions: [{ index: 1, hash: 'original', path: 'fixture', mimeType: 'image/png', width: 1536, height: 1024, parentHash: null, prompt: null, maskPath: null, requestId: null, createdAt: '' }] };
const mockApi = `
let run=${JSON.stringify(fixture)}, notify=()=>{};
const view=()=>({projectId:'fixture',run:structuredClone(run),active:false});
window.__pngCalls=[];window.__localChoices=[];window.__savedParents=[];
window.__fixtureUnresolved=()=>{run.status='unknown';notify(view())};
export const figuresAvailable=()=>true;
export const figureList=async()=>[view()];
export const figureConnections=async()=>({executor:run.executor,reviewer:run.reviewer,image:{enabled:true,available:true,model:'gpt-image-2',models:['gpt-image-2']}});
export const onFigureUpdated=async callback=>{notify=callback;return()=>{notify=()=>{}}};
export const figureDocument=async()=>({svg:null,sourceDataUrl:window.__fixtureImage,previewDataUrl:null});
export const figureRasterDocument=async(_project,_id,index)=>{const v=run.rasterVersions.find(v=>v.index===(index??run.sourceRaster));return {dataUrl:v.hash==='candidate'?window.__returnedImage:window.__fixtureImage,hash:v.hash,index:v.index,width:v.width,height:v.height,editPrompts:v.prompt?[v.prompt]:[],resolvedPrompt:'Keep scientific relationships; apply '+(v.prompt||'the original requirements'),promptModel:'vision-fixture'}};
export const figureEditResultDocument=async(_project,_id,_request,_hash,choice)=>{await new Promise(resolve=>setTimeout(resolve,80));return {dataUrl:choice==='returned'?window.__returnedImage:window.__fixtureImage,hash:choice,index:0,width:choice==='returned'?512:1536,height:choice==='returned'?768:1024}};
export const figureResolveEditResult=async(_project,_id,requestId,hash,choice)=>{window.__localChoices.push({requestId,hash,choice});await new Promise(resolve=>setTimeout(resolve,30));if(choice!=='keep'){const v={...run.pendingRasterEdit,index:run.rasterVersions.length+1,hash:choice==='returned'?'candidate':'local-selection',width:choice==='returned'?512:1536,height:choice==='returned'?768:1024};run.rasterVersions.push(v);run.sourceRaster=v.index;run.sourceHash=v.hash}run.pendingRasterEdit=null;notify(view());return view()};
export const figureEditImage=async input=>{
 window.__pngCalls.push({kind:'edit',...input});await new Promise(resolve=>setTimeout(resolve,30));
 if(window.__rejectNext){window.__rejectNext=false;throw Error('HTTP 400: fixture rejected edit; no retry')}
 if(window.__differentSize){const c=document.createElement('canvas');c.width=512;c.height=768;const img=new Image();img.src=window.__fixtureImage;await img.decode();c.getContext('2d').drawImage(img,0,0,512,768);window.__returnedImage=c.toDataURL('image/png');run.pendingRasterEdit={...run.rasterVersions[0],index:0,hash:'candidate',width:512,height:768,parentHash:input.expectedHash,parentIndex:input.baseIndex,prompt:input.prompt,requestId:'request-02'};notify(view());return view()}
 const index=run.rasterVersions.length+1;run.rasterVersions.push({...run.rasterVersions[0],index,hash:'edited-'+index,parentHash:input.expectedHash,prompt:input.prompt});run.sourceRaster=index;run.sourceHash='edited-'+index;notify(view());return view();
};
export const figureSelectRaster=async(_project,_id,index,expectedHash)=>{if(expectedHash!==run.sourceHash)throw Error('stale');const v=run.rasterVersions.find(v=>v.index===index);run.sourceRaster=index;run.sourceHash=v.hash;window.__pngCalls.push({kind:'select',index,expectedHash});notify(view());return view()};
export const figureStart=async(projectId,id,expectedSourceHash)=>{window.__pngCalls.push({kind:'svg',projectId,id,expectedSourceHash});run.imageConfirmed=true;run.status='probing';notify(view());return view()};
export const figureExportRaster=async()=>({filename:'fixture.png',mimeType:'image/png',dataBase64:window.__fixtureImage.split(',')[1]});
const reject=()=>{throw Error('Unexpected request in PNG preview')};
export const figurePrepare=async input=>{
 if(!input.confirmedRaster)throw Error('unused fixture');
 const source=run.rasterVersions.find(version=>version.index===input.confirmedRaster.index);if(source.hash!==input.confirmedRaster.hash)throw Error('stale image');
 window.__savedParents.push(structuredClone(run));window.__pngCalls.push({kind:'continuation',...input});
 run={...run,id:input.id,title:input.title,method:input.method,sourceMode:'import',status:'image_ready',sourceRaster:1,sourceHash:source.hash,imageConfirmed:false,pendingRasterEdit:null,versions:[],requests:[],review:null,error:null,rasterVersions:[{...source,index:1}]};
 return view();
};
export const figureSave=reject,figureReview=reject,figureCancel=reject,figureExport=reject,figureDelete=reject,figureEditSvg=reject;
`;
const mockStore = `const state={currentProject:{id:'fixture',name:'SomniQ PNG preview'},language:new URLSearchParams(location.search).get('language')==='en'?'en':'cn',setTab:()=>{},setFigureDirty:()=>{}};export const useStore=Object.assign(selector=>selector(state),{getState:()=>state});`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import FigureStudio from './src/figures/FigureStudio.tsx';createRoot(document.getElementById('workspace')).render(React.createElement(FigureStudio));`, resolveDir: desktop, loader: 'tsx' },
    bundle: true, write: false, outfile: 'preview.js', format: 'esm', jsx: 'automatic', target: 'esnext', plugins: [{ name: 'png-fixtures', setup(build) {
      build.onResolve({ filter: /^(?:\.\.\/|\.\/)(?:.*\/)?store$/ }, () => ({ path: 'store', namespace: 'fixture' }));
      build.onResolve({ filter: /^\.\/figureApi$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      build.onResolve({ filter: /api\/tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api' ? mockApi : args.path === 'store' ? mockStore : 'export const isTauri=()=>false;export const fileOpen=()=>{};export const fileReveal=()=>{};', loader: 'js' }));
    } }] });
  const files = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.contents]));
  const server = http.createServer((request, response) => {
    if (request.url.split('?')[0] === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html data-theme="light" data-ui-color="purple"><head><link rel="stylesheet" href="/global.css"><link rel="stylesheet" href="/preview.css"></head><body><div id="workspace" style="height:100vh"></div><script>const c=document.createElement("canvas");c.width=1536;c.height=1024;const ctx=c.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,1536,1024);for(const [x,color,label] of [[120,"#e2eefc","Input"],[580,"#ece4fa","Reservoir"],[1040,"#e0f3e5","Output"]]){ctx.fillStyle=color;ctx.fillRect(x,330,340,250);ctx.fillStyle="#27303f";ctx.font="36px sans-serif";ctx.fillText(label,x+32,450)}window.__fixtureImage=c.toDataURL("image/png");</script><script type="module" src="/preview.js"></script></body></html>'); return;
    }
    const data = request.url === '/global.css' ? globalCss : files.get(request.url);
    if (!data) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button').filter({ hasText: 'PNG 圈选测试' }).click();
    const selection = page.getByRole('img', { name: '圈选图片区域' }); await selection.waitFor();
    await page.locator('.figure-raster-prompt summary').click();
    assert.match(await page.locator('.figure-raster-prompt').innerText(), /original requirements/);
    assert.doesNotMatch(await page.locator('.figure-raster-submit').innerText(), /1 次 Executor \+ 1 次生图调用/);
    assert.deepEqual(await page.evaluate(() => window.__pngCalls), []);
    const edit = page.getByRole('button', { name: '修改选区' });
    await page.getByLabel('修改要求', { exact: true }).fill('  Change the selected label to 输入层  ');
    assert.equal(await edit.isDisabled(), true);
    assert.match(await page.getByRole('status').innerText(), /请先在左侧图片拖动圈选区域/);
    async function draw(points) {
      const rect = await selection.boundingBox(); const scale = Math.min(rect.width / 1536, rect.height / 1024);
      const map = ([x, y]) => [rect.x + (rect.width - 1536 * scale) / 2 + x * scale, rect.y + (rect.height - 1024 * scale) / 2 + y * scale];
      await page.mouse.move(...map(points[0])); await page.mouse.down();
      for (const point of points.slice(1)) await page.mouse.move(...map(point), { steps: 4 });
      await page.mouse.up();
    }
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    await draw([[150, 350], [450, 550]]); assert.equal(await selection.locator('polygon').count(), 1);
    await page.getByRole('button', { name: '自由圈选', exact: true }).click();
    await draw([[600, 360], [650, 320], [730, 340], [750, 420], [690, 480], [610, 440], [600, 360]]);
    assert.equal(await selection.locator('polygon').count(), 2);
    await page.getByRole('button', { name: '撤销圈选' }).click(); assert.equal(await selection.locator('polygon').count(), 1);
    if (process.env.SOMNIQ_PNG_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SOMNIQ_PNG_TEST_SCREENSHOT });
    await edit.dblclick();
    await page.waitForFunction(() => document.querySelector('.figure-raster-controls select')?.value === '2');
    assert.equal(await page.getByLabel('修改要求', { exact: true }).inputValue(), '');
    const history = page.locator('details').filter({ has: page.getByText('修改记录', { exact: true }) });
    assert.equal(await history.evaluate(element => element.open), false);
    assert.equal(await history.locator('p').isVisible(), false);
    await history.locator('summary').click();
    assert.match(await history.innerText(), /Change the selected label to 输入层/);
    await history.locator('summary').click();
    if (process.env.SOMNIQ_PNG_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SOMNIQ_PNG_TEST_SCREENSHOT.replace(/\.png$/i, '-submitted.png') });
    const calls = await page.evaluate(() => window.__pngCalls);
    assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'edit'); assert.equal(calls[0].baseIndex, 1);
    assert.equal(calls[0].expectedHash, 'original'); assert.equal(calls[0].prompt, 'Change the selected label to 输入层');
    const mask = await page.evaluate(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,' + window.__pngCalls[0].maskBase64; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let count = 0; let partial = 0; for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) count++; else if (data[i] !== 255) partial++; }
      return { width: img.width, height: img.height, inside: data[(450 * img.width + 300) * 4 + 3], outside: data[3], count, partial };
    });
    assert.deepEqual(mask, { width: 1536, height: 1024, inside: 0, outside: 255, count: 60000, partial: 0 });
    assert.equal(await selection.locator('polygon').count(), 0);
    for (const width of [960, 720]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PNG editor overflows at ' + width);
      const rect = await selection.boundingBox(); assert.ok(rect.width > 250 && rect.height > 200);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '矩形', exact: true }).click(); await draw([[150, 350], [450, 550]]);
    await page.getByLabel('修改要求', { exact: true }).fill('Second edit: change the selected label');
    await page.evaluate(() => { window.__rejectNext = true; }); await edit.click();
    await page.getByRole('alert').filter({ hasText: 'fixture rejected edit' }).waitFor();
    assert.equal(await page.getByLabel('修改要求', { exact: true }).inputValue(), '');
    assert.equal(await selection.locator('polygon').count(), 1); assert.equal((await page.evaluate(() => window.__pngCalls)).length, 2);
    await page.getByLabel('图片版本', { exact: true }).selectOption('1');
    const confirm = page.getByRole('button', { name: '下一步' }); await page.waitForFunction(() => !document.querySelector('.figure-raster-next button')?.disabled);
    await confirm.dblclick();
    await page.waitForFunction(() => window.__pngCalls.some(call => call.kind === 'svg'));
    assert.deepEqual((await page.evaluate(() => window.__pngCalls)).slice(2), [
      { kind: 'select', index: 1, expectedHash: 'edited-2' }, { kind: 'svg', projectId: 'fixture', id: 'a'.repeat(32), expectedSourceHash: 'original' },
    ]);
    // Reproduce the user's prompt-only case. Editing the whole image is a
    // deliberate choice and still goes through the same masked edit transport.
    const wholePage = await browser.newPage({ viewport: { width: 1280, height: 900 } }); wholePage.setDefaultTimeout(10000);
    wholePage.on('pageerror', error => errors.push(error.message));
    await wholePage.goto(`http://127.0.0.1:${server.address().port}/`);
    await wholePage.getByRole('button').filter({ hasText: 'PNG 圈选测试' }).click();
    await wholePage.getByRole('img', { name: '圈选图片区域' }).waitFor();
    await wholePage.getByLabel('修改要求', { exact: true }).fill('MA');
    assert.equal(await wholePage.getByRole('button', { name: '修改选区' }).isDisabled(), true);
    if (process.env.SOMNIQ_PNG_TEST_SCREENSHOT) await wholePage.screenshot({ path: process.env.SOMNIQ_PNG_TEST_SCREENSHOT.replace(/\.png$/i, '-missing-selection.png') });
    await wholePage.getByRole('button', { name: '整图修改', exact: true }).click();
    const wholeEdit = wholePage.getByRole('button', { name: '修改整图' });
    assert.equal(await wholeEdit.isDisabled(), false);
    assert.deepEqual(await wholePage.evaluate(() => window.__pngCalls), []);
    const wholeSelection = wholePage.getByRole('img', { name: '圈选图片区域' });
    assert.equal(await wholeSelection.locator('rect.whole').count(), 1);
    if (process.env.SOMNIQ_PNG_TEST_SCREENSHOT) await wholePage.screenshot({ path: process.env.SOMNIQ_PNG_TEST_SCREENSHOT.replace(/\.png$/i, '-whole.png') });
    await wholeEdit.dblclick();
    await wholePage.waitForFunction(() => document.querySelector('.figure-raster-controls select')?.value === '2');
    assert.equal(await wholePage.getByLabel('修改要求', { exact: true }).inputValue(), '');
    const wholeMask = await wholePage.evaluate(async () => {
      const calls = window.__pngCalls; const img = new Image(); img.src = 'data:image/png;base64,' + calls[0].maskBase64; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let protectedPixels = 0; for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) protectedPixels++;
      return { count: calls.length, kind: calls[0].kind, prompt: calls[0].prompt, baseIndex: calls[0].baseIndex, width: img.width, height: img.height, protectedPixels };
    });
    assert.deepEqual(wholeMask, { count: 1, kind: 'edit', prompt: 'MA', baseIndex: 1, width: 1536, height: 1024, protectedPixels: 0 });
    await wholePage.getByRole('button', { name: '自由圈选', exact: true }).click();
    assert.equal(await wholeSelection.locator('rect.whole').count(), 0);
    assert.equal(await wholePage.getByRole('button', { name: '修改选区' }).isDisabled(), true);
    await wholePage.getByLabel('修改要求', { exact: true }).fill('Next edit');
    for (const width of [960, 720]) {
      await wholePage.setViewportSize({ width, height: 900 });
      assert.ok(await wholePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Scope controls overflow at ' + width);
      await wholePage.getByRole('button', { name: '整图修改', exact: true }).click();
      assert.equal(await wholePage.getByRole('button', { name: '修改整图' }).isDisabled(), false);
    }
    const englishPage = await browser.newPage({ viewport: { width: 1280, height: 900 } }); englishPage.setDefaultTimeout(10000);
    englishPage.on('pageerror', error => errors.push(error.message));
    await englishPage.goto(`http://127.0.0.1:${server.address().port}/?language=en`);
    await englishPage.getByRole('button').filter({ hasText: 'PNG 圈选测试' }).click();
    await englishPage.getByRole('img', { name: 'Select an image region' }).waitFor();
    await englishPage.getByLabel('Edit instruction', { exact: true }).fill('MA');
    assert.match(await englishPage.getByRole('status').innerText(), /choose "Whole image"/);
    await englishPage.getByRole('button', { name: 'Whole image', exact: true }).click();
    for (const width of [1280, 960, 720]) {
      await englishPage.setViewportSize({ width, height: 900 });
      assert.equal(await englishPage.getByRole('button', { name: 'Edit whole image' }).isDisabled(), false);
      assert.ok(await englishPage.evaluate(() => {
        const controls = document.querySelector('.figure-raster-controls');
        return document.documentElement.scrollWidth <= innerWidth && controls.scrollWidth <= controls.clientWidth;
      }), 'English scope controls overflow at ' + width);
    }
    assert.deepEqual(await englishPage.evaluate(() => window.__pngCalls), []);
    const instruction = 'Move the ARMA module inside the reservoir and retain its scientific relationships. '.repeat(12).trim();
    await englishPage.getByLabel('Edit instruction', { exact: true }).fill(instruction);
    await englishPage.getByRole('button', { name: 'Edit whole image', exact: true }).click();
    assert.equal(await englishPage.getByLabel('Edit instruction', { exact: true }).inputValue(), '');
    await englishPage.waitForFunction(() => document.querySelector('.figure-raster-controls select')?.value === '2');
    assert.equal((await englishPage.evaluate(() => window.__pngCalls))[0].prompt, instruction);
    const englishHistory = englishPage.locator('details').filter({ has: englishPage.getByText('Edit history', { exact: true }) });
    assert.equal(await englishHistory.evaluate(element => element.open), false);
    assert.ok((await englishHistory.boundingBox()).height < 65, 'Collapsed history occupies too much space');
    await englishHistory.locator('summary').click();
    assert.equal(await englishHistory.locator('p').innerText(), instruction);
    await englishHistory.locator('summary').click();
    await englishPage.evaluate(() => window.__fixtureUnresolved());
    await englishPage.getByLabel('Edit instruction', { exact: true }).fill('Next edit');
    const unresolvedEdit = englishPage.getByRole('button', { name: 'Edit whole image', exact: true });
    assert.equal(await unresolvedEdit.isDisabled(), true);
    assert.equal(await unresolvedEdit.getAttribute('title'), null);
    assert.doesNotMatch(await englishPage.locator('.figure-raster-controls').innerText(), /1 Executor \+ 1 image call|A request is unresolved/);
    assert.equal(await englishPage.getByRole('button',{name:/New SVG task|Download this PNG|Download original/}).count(),0);
    const next=englishPage.getByRole('button',{name:'Next',exact:true});
    assert.equal(await next.isEnabled(),true);await next.dblclick();
    await englishPage.waitForFunction(()=>window.__pngCalls.some(call=>call.kind==='svg'));
    const continued=await englishPage.evaluate(()=>({calls:window.__pngCalls,parents:window.__savedParents}));
    assert.equal(continued.parents.length,1);assert.equal(continued.parents[0].status,'unknown');
    assert.equal(continued.calls.filter(call=>call.kind==='edit').length,1);
    const continuation=continued.calls.find(call=>call.kind==='continuation');
    assert.equal(continuation.confirmedRaster.id,fixture.id);assert.equal(continuation.confirmedRaster.index,2);assert.equal(continuation.confirmedRaster.hash,'edited-2');
    assert.match(continuation.method,/Move the ARMA module/);
    assert.equal(continued.calls.filter(call=>call.kind==='svg').length,1);
    assert.equal(await englishPage.locator('.figure-composer').count(),0);
    for (const choice of ['returned','selection','keep']) {
      const resultPage=await browser.newPage({viewport:{width:1280,height:900}});resultPage.setDefaultTimeout(10000);
      resultPage.on('pageerror',error=>errors.push(error.message));
      await resultPage.goto('http://127.0.0.1:'+server.address().port+'/');
      await resultPage.getByRole('button').filter({hasText:'PNG 圈选测试'}).click();
      await resultPage.getByRole('img',{name:'圈选图片区域'}).waitFor();
      await resultPage.getByLabel('修改要求',{exact:true}).fill('MA');
      await resultPage.getByRole('button',{name:'整图修改',exact:true}).click();
      await resultPage.evaluate(()=>{window.__differentSize=true});
      await resultPage.getByRole('button',{name:'修改整图',exact:true}).click();
      await resultPage.getByRole('img',{name:'图片结果预览'}).waitFor();
      assert.equal((await resultPage.evaluate(()=>window.__pngCalls)).length,1);
      assert.deepEqual(await resultPage.evaluate(()=>window.__localChoices),[]);
      assert.equal(await resultPage.getByRole('button',{name:'下一步'}).isDisabled(),true);
      const select=resultPage.getByLabel('采用方式',{exact:true});
      assert.equal(await select.inputValue(),'selection');
      assert.equal(await resultPage.getByRole('img',{name:'图片结果预览'}).getAttribute('viewBox'),'0 0 1536 1024');
      await select.selectOption(choice);
      const adopt=resultPage.getByRole('button',{name:choice==='returned'?'使用整张修改图':choice==='selection'?'应用修改':'保留原图',exact:true});
      await resultPage.waitForFunction(()=>!document.querySelector('.figure-raster-result button')?.disabled);
      assert.equal(await resultPage.getByRole('img',{name:'图片结果预览'}).getAttribute('viewBox'),choice==='returned'?'0 0 512 768':'0 0 1536 1024');
      for(const width of [1280,960,720]){await resultPage.setViewportSize({width,height:900});assert.ok(await resultPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Result controls overflow at '+width)}
      if(process.env.SOMNIQ_PNG_TEST_SCREENSHOT)await resultPage.screenshot({path:process.env.SOMNIQ_PNG_TEST_SCREENSHOT.replace(/\.png$/i,'-result-'+choice+'.png')});
      await adopt.dblclick();await resultPage.waitForFunction(()=>!document.querySelector('.figure-raster-result'));
      assert.deepEqual(await resultPage.evaluate(()=>window.__localChoices),[{requestId:'request-02',hash:'candidate',choice}]);
      assert.equal((await resultPage.evaluate(()=>window.__pngCalls)).length,1);
      await resultPage.getByRole('img',{name:'圈选图片区域'}).waitFor();
      assert.equal(await resultPage.getByRole('img',{name:'圈选图片区域'}).getAttribute('viewBox'),choice==='returned'?'0 0 512 768':'0 0 1536 1024');
      if(choice!=='keep'){await resultPage.getByLabel('图片版本',{exact:true}).selectOption('1');await resultPage.waitForFunction(()=>document.querySelector('.figure-raster-surface svg')?.getAttribute('viewBox')==='0 0 1536 1024')}
      await resultPage.close();
    }
    assert.deepEqual(errors, []);
    console.log('PNG browser check passed: visible selection requirement, explicit whole-image scope, lasso/rectangle/undo, exact masks, one explicit edit, no retry, history confirmation and 1280/960/720px layout. No model requests.');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
