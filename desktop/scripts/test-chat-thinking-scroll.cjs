// Real transcript, message renderer and styles; stream fixtures make no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES
  ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SOMNIQ_THINKING_SCROLL_OUTPUT || path.join(desktop, '../.somniq/runtime/chat-thinking-scroll'));

const fixture = `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatThread from './src/chat/ChatThread';
import {useStore} from './src/store';
import './src/styles.css';
const history = Array.from({length:30}, (_,i)=>({
  id:'turn-'+i,role:i%2?'assistant':'user',blocks:[{kind:'text',text:'Message '+i+' — 已核查本地证据。'.repeat(8)}],
}));
const reasoning = Array.from({length:18},(_,i)=>'推理步骤 '+i+'：核查时间划分与评估协议，保留可追溯的证据。').join('\\n\\n');
const narrative = Array.from({length:40},(_,i)=>'段落 '+i+'：文献中的设备内结果需要独立数据进行检验。').join('\\n\\n');
const initial = {id:'active-turn',role:'assistant',streaming:true,blocks:[
  {kind:'thinking',thinking:reasoning},
  {kind:'text',text:narrative},
]};
let nextThinkingId=0;
function Fixture(){
  const [active,setActive]=useState(initial);
  useEffect(()=>{window.fixture={
    resetThinking:(short=false)=>setActive({...initial,id:'thinking-'+(++nextThinkingId),blocks:[{kind:'thinking',thinking:short?'开始推理。':reasoning}]}),
    think:()=>setActive(turn=>({...turn,blocks:[...turn.blocks,{kind:'thinking',thinking:reasoning}]})),
    grow:()=>setActive(turn=>({...turn,blocks:turn.blocks.map((b,i)=>i===turn.blocks.length-1
      ?b.kind==='thinking'?{...b,thinking:b.thinking+'\\n\\n'+reasoning}:{...b,text:b.text+'\\n\\n'+narrative}:b)})),
    finish:()=>setActive(turn=>({...turn,streaming:false})),
    answer:()=>setActive(turn=>({...turn,blocks:[...turn.blocks,{kind:'text',text:'已核查时间划分和评估协议。'}]})),
  };},[]);
  return <div className="chat-root"><ChatThread sessionId="thinking-scroll" language="cn"
    turns={[...history,active]} composerHeight={100} starters={[]} welcomeTitle="Chat" welcomeDescription=""
    onStarter={()=>{}} onEdit={()=>{}} onRetry={()=>{}} onContinue={()=>{}}
    onPermissionRespond={()=>{}} onQuestionRespond={async()=>{}} />
    <div className="fixture-composer">继续研究…</div></div>;
}
useStore.setState({language:'cn'});
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const bundle=await esbuild.build({
    stdin:{contents:fixture,resolveDir:desktop,loader:'tsx'},
    bundle:true,write:false,outfile:'preview.js',format:'esm',jsx:'automatic',
    define:{'import.meta.env':'{}'},
    loader:{'.png':'dataurl','.svg':'dataurl','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl','.tex':'text'},
    plugins:[{name:'unused-preview-url',setup(build){
      build.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'preview-url'}));
      build.onLoad({filter:/.*/,namespace:'preview-url'},()=>({contents:'export default "/unused-preview";'}));
    }}],
  });
  const javascript=bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents;
  const css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
  const server=http.createServer((request,response)=>{
    if(request.url==='/preview.js'){response.setHeader('content-type','text/javascript');response.end(javascript);return;}
    if(request.url==='/preview.css'){response.setHeader('content-type','text/css');response.end(css);return;}
    response.setHeader('content-type','text/html; charset=utf-8');
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/preview.css"><style>html,body,#root{height:100%;margin:0}.chat-root{height:100%;position:relative}.fixture-composer{position:absolute;bottom:12px;left:15%;right:15%;height:76px;border:1px solid var(--border);border-radius:16px;background:var(--bg-1);padding:16px}</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE||undefined});
    const page=await browser.newPage({viewport:{width:1100,height:720}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.fixture&&document.querySelector('.md-think-body'));
    const position=()=>page.locator('.chat-scroll').evaluate(el=>({top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop,height:el.scrollHeight,
      activeHeight:el.querySelector('[data-index="30"]')?.getBoundingClientRect().height}));
    await page.waitForFunction(()=>{const el=document.querySelector('.chat-scroll');return el.scrollHeight-el.clientHeight-el.scrollTop<2;});
    await page.waitForTimeout(250);
    const checks=[];
    const record=(check)=>{checks.push(check);fs.writeFileSync(path.join(output,'positions.json'),JSON.stringify(checks,null,2)+'\n');console.log(JSON.stringify(check,null,2));};
    const atBottom=()=>page.waitForFunction(()=>{const el=document.querySelector('.chat-scroll');return el.scrollHeight-el.clientHeight-el.scrollTop<=2;},null,{timeout:5000});
    const returnToBottom=async()=>{
      await page.waitForTimeout(250);
      // Shrinking the turn may already clamp to the bottom and remove the button.
      await page.evaluate(()=>document.querySelector('.chat-scroll-bottom')?.click());
      await atBottom();
      await page.waitForTimeout(250);
    };
    await page.mouse.move(550,320);
    await page.mouse.wheel(0,-500);
    await page.waitForTimeout(300);
    const before=await position();
    assert(before.gap>300,'reader has moved into the active message');
    await page.evaluate(()=>window.fixture.grow());
    await page.waitForTimeout(350);
    const after=await position();
    record({scenario:'active answer grows while reader browses the same turn',before,after});
    await page.screenshot({path:path.join(output,'reading-active-turn.png')});
    assert(after.height>before.height+500,'the real Markdown answer has grown');
    assert(Math.abs(after.top-before.top)<=2,'streaming below the reader must preserve the reading position');
    await page.evaluate(()=>window.fixture.think());
    await page.waitForTimeout(350);
    const thinking=await position();
    record({scenario:'new thinking phase starts below the reader',before:after,after:thinking});
    assert(Math.abs(thinking.top-after.top)<=2,'a new thinking phase below the reader must not pull the viewport');

    await page.evaluate(()=>window.fixture.resetThinking());
    await returnToBottom();
    const body=page.locator('.md-think-body');
    const thinkingPosition=()=>body.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight}));
    const initialThinking=await thinkingPosition();
    record({scenario:'new streaming reasoning follows its latest step',...initialThinking});
    assert(initialThinking.top>100,'reasoning is long enough to scroll');
    const pageBefore=await position();
    const box=await body.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,-200);
    await page.waitForTimeout(200);
    const readerThinking=await thinkingPosition();
    assert(readerThinking.top<initialThinking.top-100,'reader scrolled up inside reasoning');
    assert.equal(await page.locator('.chat-scroll-bottom').count(),0,'inner scrolling preserves transcript following');
    await page.evaluate(()=>window.fixture.grow());
    await page.waitForTimeout(200);
    const thinkingAfter=await thinkingPosition();
    assert(thinkingAfter.height>readerThinking.height,'new reasoning actually arrived');
    assert(Math.abs(thinkingAfter.top-readerThinking.top)<=2,'new reasoning preserves the inner reading position');
    assert(Math.abs((await position()).top-pageBefore.top)<=2,'bounded reasoning does not move the transcript');
    record({scenario:'reader browses earlier reasoning while tokens arrive',before:readerThinking,after:thinkingAfter});

    await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await page.waitForTimeout(100);
    await page.evaluate(()=>window.fixture.grow());
    await page.waitForTimeout(200);
    const resumed=await thinkingPosition();
    assert(resumed.height-resumed.viewport-resumed.top<=2,'returning to the reasoning bottom resumes inner following');
    record({scenario:'inner following resumes at the reasoning bottom',...resumed});

    const stablePage=await position();
    await page.evaluate(()=>{
      window.scrollFrames=[];
      window.captureScroll=true;
      const sample=()=>{
        const el=document.querySelector('.chat-scroll');
        const body=document.querySelector('.md-think-body');
        window.scrollFrames.push({top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop,bodyGap:body.scrollHeight-body.clientHeight-body.scrollTop});
        if(window.captureScroll)requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for(let i=0;i<8;i++){
      await page.evaluate(()=>window.fixture.grow());
      await page.waitForTimeout(70);
    }
    const frames=await page.evaluate(()=>{window.captureScroll=false;return window.scrollFrames;});
    assert(frames.length>=8,'captured painted frames during streaming');
    assert(frames.every(frame=>Math.abs(frame.top-stablePage.top)<=2&&frame.gap<=2),'bounded thinking keeps the page still on every frame');
    assert(frames.every(frame=>frame.bodyGap<=2),'thinking follows before each paint');
    record({scenario:'bounded thinking streams without frame jumps',frames:frames.length,maxPageDrift:Math.max(...frames.map(frame=>Math.abs(frame.top-stablePage.top))),maxBodyGap:Math.max(...frames.map(frame=>frame.bodyGap))});
    await page.screenshot({path:path.join(output,'thinking-stream.png')});

    await page.evaluate(()=>window.fixture.answer());
    await page.waitForTimeout(250);
    await atBottom();
    assert.equal(await body.count(),1,'thinking stays revealed as the answer begins');
    await page.evaluate(()=>window.fixture.finish());
    await page.waitForTimeout(250);
    await atBottom();
    assert.equal(await body.count(),0,'completed reasoning collapses and the transcript stays aligned');
    record({scenario:'thinking to answer to complete keeps bottom alignment',...await position()});

    await page.setViewportSize({width:390,height:720});
    await page.evaluate(()=>window.fixture.resetThinking(true));
    await page.waitForTimeout(250);
    await returnToBottom();
    await page.evaluate(()=>window.fixture.grow());
    await page.waitForTimeout(250);
    await atBottom();
    const narrow=await body.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.clientHeight,scrollHeight:el.scrollHeight}));
    assert(narrow.height<=182,'reasoning stays bounded on a narrow window');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no page overflow on a narrow window');
    await page.screenshot({path:path.join(output,'thinking-narrow.png')});
    record({scenario:'narrow window reasoning grows and remains aligned',...await position(),body:narrow});
    assert.deepEqual(errors,[]);
    const result={outcome:'passed',checks,pageErrors:errors};
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
