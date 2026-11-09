// Exercise the real composer and application CSS at split-pane widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES
  ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SOMNIQ_COMPOSER_LAYOUT_OUTPUT
  || path.join(desktop, '../.somniq/runtime/chat-composer-layout'));

const fixture = `
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatComposer from './src/chat/ChatComposer';
import {useStore} from './src/store';
import './src/styles.css';
const emptyRepo={gitAvailable:true,isRepository:false,files:[],branches:[]};
function Fixture(){
  const [width,setWidth]=useState(544);
  const [input,setInput]=useState('');
  const [busy,setBusy]=useState(true);
  const [model,setModel]=useState('deepseek-v4.1-flash');
  const [reasoning,setReasoning]=useState('high');
  const [used,setUsed]=useState(8000);
  const [permission,setPermission]=useState('danger-full-access');
  const [repo,setRepo]=useState(emptyRepo);
  const [height,setHeight]=useState(0);
  useEffect(()=>{window.fixture={width:setWidth,input:setInput,busy:setBusy,model:setModel,
    used:setUsed,permission:setPermission,repo:setRepo,
    language:language=>useStore.setState({language}),
    theme:theme=>useStore.getState().setTheme(theme),
    font:size=>document.documentElement.style.fontSize=size+'px',
  };},[]);
  return <div className="fixture-shell">
    <aside className="fixture-sidebar">SomniQ Chat</aside>
    <main className="chat" style={{width,maxWidth:'100%'}}>
      <div className="fixture-heading">Research conversation</div>
      <ChatComposer input={input} onInputChange={setInput} commands={[]} skills={[]}
        attachments={[]} onAttachmentsChange={()=>{}} busy={busy} ready editing={false}
        permission={{mode:permission,label:permission}} onPermissionChange={setPermission}
        modelName={model} modelOptions={[{value:model,label:model}]} canSwitchModel onModelChange={setModel}
        reasoningSupported reasoningEffort={reasoning} reasoningOptions={['low','medium','high','xhigh']}
        onReasoningEffortChange={setReasoning} contextUsed={used} contextMax={100000}
        gitWorkspace={repo} onRefreshGit={()=>{}} onOpenGit={()=>{}}
        onSubmit={()=>{window.submits++}} onStop={()=>{window.stops++}} onCancelEdit={()=>{}}
        onHeightChange={setHeight}/>
      <output className="fixture-height" data-height={height}/>
    </main>
    <aside className="fixture-agent">Number Audit · Running</aside>
  </div>;
}
window.stops=0;window.submits=0;
useStore.setState({language:'en'});
useStore.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const bundle=await esbuild.build({
    stdin:{contents:fixture,resolveDir:desktop,loader:'tsx'},bundle:true,write:false,
    outfile:'preview.js',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},
    loader:{'.png':'dataurl','.svg':'dataurl','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl','.tex':'text'},
    plugins:[{name:'unused-preview-url',setup(build){
      build.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'preview-url'}));
      build.onLoad({filter:/.*/,namespace:'preview-url'},()=>({contents:'export default "/unused-preview";'}));
    }}],
  });
  const javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents;
  const css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
  const server=http.createServer((request,response)=>{
    if(request.url==='/preview.js'){response.setHeader('content-type','text/javascript');response.end(javascript);return;}
    if(request.url==='/preview.css'){response.setHeader('content-type','text/css');response.end(css);return;}
    response.setHeader('content-type','text/html; charset=utf-8');
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/preview.css"><style>html,body,#root{height:100%;margin:0}.fixture-shell{height:100%;display:flex;overflow:hidden}.fixture-shell>.chat{flex:0 0 auto;min-width:0;height:100%;position:relative}.fixture-sidebar{width:260px;flex-shrink:0;padding:24px;border-right:1px solid var(--border)}.fixture-agent{flex:1;min-width:0;padding:24px;border-left:1px solid var(--border)}.fixture-heading{padding:24px;color:var(--text-dim)}.fixture-height{display:none}@media(max-width:800px){.fixture-sidebar,.fixture-agent{display:none}}</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE||undefined});
    const page=await browser.newPage({viewport:{width:1802,height:1152}});
    page.setDefaultTimeout(5000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.fixture&&document.querySelector('.chat-model-pill'));
    const geometry=()=>page.locator('.chat-input').evaluate(input=>{
      const rect=selector=>{
        const node=input.querySelector(selector);if(!node)return null;
        const box=node.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom,scrollWidth:node.scrollWidth};
      };
      const card=input.getBoundingClientRect();
      return {width:card.width,height:card.height,left:rect('.chat-footer-left'),right:rect('.chat-footer-right'),
        permission:rect('.chat-perm-pill'),upload:rect('.chat-upload-btn'),git:rect('.chat-workspace-git'),
        model:rect('.chat-model-pill'),context:rect('.ctx-ring'),send:rect('.chat-send-btn'),
        textarea:rect('textarea'),footer:rect('.chat-input-footer'),reportedHeight:Number(document.querySelector('.fixture-height').dataset.height)};
    });
    const checks=[];
    const record=(scenario,layout)=>{checks.push({scenario,layout});fs.writeFileSync(path.join(output,'positions.json'),JSON.stringify(checks,null,2)+'\n');console.log(JSON.stringify({scenario,width:layout.width,height:layout.height,rows:Math.abs(layout.left.y-layout.right.y)<=2?1:2}));};
    await page.waitForTimeout(200);
    const initial=await geometry();
    record('split pane, screenshot model and context',initial);
    await page.screenshot({path:path.join(output,'split-pane.png')});
    await page.locator('.chat-input-wrap').screenshot({path:path.join(output,'composer-fixed.png')});
    assert(Math.abs(initial.left.y-initial.right.y)<=2,'a 504px composer keeps its toolbar on one row');
    const assertFits=async(scenario,oneRow=false,save=true)=>{
      await page.waitForTimeout(100);
      const layout=await geometry();
      for(const control of ['permission','upload','git','model','context','send']){
        const box=layout[control];
        assert(box.width>0&&box.height>0,scenario+': '+control+' remains visible');
        assert(box.x>=layout.footer.x-1&&box.right<=layout.footer.right+1,scenario+': '+control+' stays inside the toolbar');
      }
      assert(layout.send.width>=28&&Math.abs(layout.send.width-layout.send.height)<=1,scenario+': send/stop remains square');
      assert(layout.model.right<=layout.send.x+1,scenario+': model and action do not overlap');
      assert(layout.footer.bottom<=layout.textarea.bottom+layout.footer.height+20,scenario+': toolbar follows the editor');
      if(oneRow)assert(Math.abs(layout.left.y-layout.right.y)<=2,scenario+': toolbar stays on one row');
      if(save)record(scenario,layout);
      return layout;
    };
    await assertFits('split pane controls',true);
    for(const used of [0,99000,100000]){
      await page.evaluate(value=>window.fixture.used(value),used);
      const state=await assertFits('context '+used,true);
      assert(Math.abs(state.height-initial.height)<=1,'context text does not resize the composer');
    }
    await page.evaluate(()=>window.fixture.model('anthropic/claude-sonnet-4.6-20260514-long-model-name'));
    const longModel=await assertFits('long model name',true);
    assert(Math.abs(longModel.height-initial.height)<=1,'switching models does not wrap the toolbar');
    await page.evaluate(()=>window.fixture.busy(false));
    const send=page.locator('.chat-send-btn');
    await page.locator('.chat-model-pill').click();
    await page.getByRole('dialog',{name:'Model and reasoning effort'}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:/Git menu/}).click();
    await page.getByRole('menu',{name:'Git actions'}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Auto-approve',exact:true}).click();
    await page.getByRole('menuitem',{name:'Plan',exact:true}).click();
    await page.locator('textarea').fill('Continue the research.');
    await send.click();
    assert.equal(await page.evaluate(()=>window.submits),1,'sending still works');
    await page.evaluate(()=>window.fixture.busy(true));
    await send.click();
    assert.equal(await page.evaluate(()=>window.stops),1,'stopping still works');
    await page.evaluate(()=>{
      window.fixture.permission('danger-full-access');
      window.fixture.repo({gitAvailable:true,isRepository:true,branch:'codex/research-long-branch-name',files:[],branches:[]});
    });
    await assertFits('long Git branch',true);
    await page.evaluate(()=>window.fixture.language('cn'));
    await assertFits('Chinese split pane',true);
    await page.screenshot({path:path.join(output,'split-pane-cn.png')});
    await page.evaluate(()=>{window.fixture.width(900);window.fixture.theme('dark');});
    await assertFits('wide dark composer',true);
    await page.screenshot({path:path.join(output,'wide-dark.png')});
    await page.setViewportSize({width:390,height:720});
    await page.evaluate(()=>window.fixture.width(390));
    await assertFits('narrow composer');
    await page.screenshot({path:path.join(output,'narrow.png')});
    await page.evaluate(()=>window.fixture.font(20));
    await assertFits('narrow composer, 125% text');
    await page.screenshot({path:path.join(output,'narrow-large-text.png')});
    await page.setViewportSize({width:1802,height:1152});
    await page.evaluate(()=>window.fixture.language('en'));
    const sweep=[];
    for(const font of [12,14,16,20]){
      await page.evaluate(value=>window.fixture.font(value),font);
      for(const width of [320,390,443,500,544,600,704,900]){
        await page.evaluate(value=>window.fixture.width(value),width);
        const layout=await assertFits('width '+width+', font '+font,false,false);
        const rows=Math.abs(layout.left.y-layout.right.y)<=2?1:2;
        const previousHeight=layout.height;
        await page.evaluate(()=>{window.fixture.model('deepseek-v4.1-flash');window.fixture.used(0);});
        const shorter=await assertFits('shorter labels, width '+width+', font '+font,false,false);
        assert(Math.abs(shorter.height-previousHeight)<=1,'labels do not change rows at width '+width+', font '+font);
        await page.evaluate(()=>{window.fixture.model('anthropic/claude-sonnet-4.6-20260514-long-model-name');window.fixture.used(100000);});
        sweep.push({width,font,rows,height:layout.height});
      }
    }
    assert.deepEqual(errors,[]);
    const result={outcome:'passed',checks,widthAndFontSweep:sweep,pageErrors:errors};
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({outcome:result.outcome,checks:checks.length,pageErrors:errors}));
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
