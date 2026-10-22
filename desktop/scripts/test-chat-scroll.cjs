// Real ChatThread + TanStack virtualization in Chromium. Message fixtures have
// deliberately inaccurate estimated heights and delayed growth; no backend runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES
  ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');

const fixture = `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatThread from './src/chat/ChatThread';
const makeTurns = (session) => Array.from({length:80}, (_, index) => ({
  id:session+'-'+index, role:index%2?'assistant':'user',
  blocks:[{kind:'text',text:'Message '+index}],
}));
function Fixture() {
  const [visible,setVisible]=useState(false);
  const [layout,setLayout]=useState(true);
  const [session,setSession]=useState('first');
  const [turns,setTurns]=useState(()=>makeTurns('first'));
  const [loading,setLoading]=useState(false);
  const [mounted,setMounted]=useState(true);
  const [composerHeight,setComposerHeight]=useState(100);
  useEffect(()=>{window.fixture={
    show:()=>setVisible(true),hide:()=>setVisible(false),
    layout:setLayout,mount:setMounted,composer:setComposerHeight,
    open:(id,delayed=false)=>{setSession(id);setLoading(delayed);setTurns(delayed?[]:makeTurns(id));},
    finish:()=>{setLoading(false);setTurns(makeTurns(session));},
    append:()=>setTurns(previous=>[...previous,{id:session+'-new',role:'assistant',blocks:[{kind:'text',text:'Newest message'}]}]),
    grow:()=>{document.querySelector('[data-index="79"] article').style.height='3200px';},
  };},[session]);
  return <div hidden={!visible} style={{height:'100%'}}>
    <div style={{display:layout?'flex':'none',height:'100%'}}>
      {mounted&&<ChatThread key={session} sessionId={session} visible={visible} loading={loading}
        language="en" turns={turns} composerHeight={composerHeight} starters={[]}
        welcomeTitle="Chat" welcomeDescription="" onStarter={()=>{}} onEdit={()=>{}}
        onRetry={()=>{}} onContinue={()=>{}} onPermissionRespond={()=>{}}
        onQuestionRespond={async()=>{}} onLoadEarlierTurns={()=>{window.historyLoads++;}}
        hasEarlierTurns />}
    </div>
  </div>;
}
window.historyLoads=0;
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`;

(async () => {
  const bundle = await esbuild.build({
    stdin: {contents:fixture,resolveDir:desktop,loader:'tsx'},
    bundle:true,write:false,outfile:'preview.js',format:'esm',jsx:'automatic',
    loader:{'.png':'dataurl'},
    plugins:[{name:'message-fixture',setup(build){
      build.onResolve({filter:/^\.\/ChatMessage$/},()=>({path:'message',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'tsx',resolveDir:desktop,contents:`
        export default function Message({turn}) {
          const index=Number(turn.id.split('-').at(-1));
          return <article style={{height:index===79?2200:100+(index%5)*70,boxSizing:'border-box',padding:12,borderBottom:'1px solid'}}>
            {turn.blocks[0].text}
          </article>;
        }
      `}));
    }}],
  });
  const javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents;
  const styles=`
    html,body,#root {height:100%;margin:0}
    [hidden] {display:none!important}
    .chat-thread {display:flex;position:relative;flex:1;min-height:0}
    .chat-scroll {flex:1;overflow-y:auto;overflow-anchor:none;padding:0 24px}
    .chat-virtual-list {position:relative;width:100%}
    .chat-virtual-row {position:absolute;top:0;left:0;width:100%}
    .chat-scroll-bottom,.chat-question-timeline {position:absolute;bottom:12px;right:24px}
    .chat-question-timeline {display:none}
  `;
  const server=http.createServer((request,response)=>{
    if(request.url==='/preview.js') {response.setHeader('Content-Type','text/javascript');response.end(javascript);return;}
    response.setHeader('Content-Type','text/html');
    response.end('<!doctype html><html><head><style>'+styles+'</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE||undefined});
    const page=await browser.newPage({viewport:{width:1100,height:720}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.waitForFunction(()=>window.fixture);
    const bottom=async()=>{
      await page.waitForFunction(()=>{
        const el=document.querySelector('.chat-scroll');
        return el?.clientHeight>0&&el.scrollHeight>el.clientHeight&&el.scrollHeight-el.clientHeight-el.scrollTop<=2;
      },{},{timeout:5000}).catch(async error=>{
        console.error(await page.locator('.chat-scroll').evaluate(el=>({
          top:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight,
          listHeight:el.querySelector('.chat-virtual-list')?.style.height,
          lastRow:el.querySelector('[data-index="79"]')?.getBoundingClientRect().toJSON(),
          following:!document.querySelector('.chat-scroll-bottom'),
        })));
        throw error;
      });
      await page.waitForTimeout(250);
      const position=await page.locator('.chat-scroll').evaluate(el=>({top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop}));
      assert(position.gap<=2,'bottom alignment remains stable after measurements settle');
      return position;
    };
    const checks=[];
    await page.evaluate(()=>window.fixture.show());
    checks.push({scenario:'initially hidden Chat opens at the end',...await bottom()});

    await page.locator('.chat-scroll').evaluate(el=>{el.scrollTop=3000;});
    await page.waitForTimeout(300);
    await page.evaluate(()=>window.fixture.hide());
    await page.waitForTimeout(150);
    await page.evaluate(()=>window.fixture.show());
    checks.push({scenario:'kept-alive page returns to the end',...await bottom()});

    await page.evaluate(()=>window.fixture.grow());
    checks.push({scenario:'last message grows after landing',...await bottom()});

    // Wheel input must win even inside the programmatic-scroll grace period.
    await page.mouse.move(500,350);
    await page.evaluate(()=>window.fixture.composer(120));
    await page.mouse.wheel(0,-600);
    await page.waitForTimeout(300);
    assert(await page.locator('.chat-scroll').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>300),
      'upward wheel input leaves bottom following immediately');
    const before=await page.locator('.chat-scroll').evaluate(el=>el.scrollTop);
    await page.evaluate(()=>window.fixture.append());
    await page.waitForTimeout(300);
    const after=await page.locator('.chat-scroll').evaluate(el=>el.scrollTop);
    assert(Math.abs(after-before)<=2,'new messages preserve the reader position');
    checks.push({scenario:'reader stays in history during new messages',before,after});

    await page.evaluate(()=>window.fixture.open('second',true));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.chat-thread-loading').count(),1);
    await page.evaluate(()=>window.fixture.finish());
    checks.push({scenario:'asynchronous session restore lands at the end',...await bottom()});

    await page.evaluate(()=>{window.fixture.hide();window.fixture.open('third',true);});
    await page.waitForTimeout(150);
    await page.evaluate(()=>window.fixture.finish());
    await page.waitForTimeout(150);
    await page.evaluate(()=>window.fixture.show());
    checks.push({scenario:'history restored behind a hidden page',...await bottom()});

    await page.evaluate(()=>{window.fixture.layout(false);window.fixture.open('fourth');});
    await page.waitForTimeout(150);
    await page.evaluate(()=>window.fixture.layout(true));
    checks.push({scenario:'zero-size viewport waits for layout',...await bottom()});

    await page.evaluate(()=>window.fixture.mount(false));
    await page.waitForTimeout(100);
    await page.evaluate(()=>window.fixture.mount(true));
    checks.push({scenario:'remounted conversation lands at the end',...await bottom()});

    assert.equal(await page.evaluate(()=>window.historyLoads),0,'landings do not fetch earlier history');
    assert.deepEqual(errors,[]);
    const result={outcome:'passed',checks,historyLoads:0,pageErrors:errors};
    const output=path.resolve(desktop,'../.somniq/runtime/chat-scroll-browser-verification.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
