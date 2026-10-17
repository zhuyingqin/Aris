// Real Chat, summary, child conversation and navigation in Chromium.
// The Tauri boundary is a deterministic fixture; no model requests run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES
  ? path.join(process.env.SOMNIQ_BROWSER_TEST_NODE_MODULES, 'playwright') : 'playwright');
const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SOMNIQ_AGENT_UI_TEST_OUTPUT || path.join(desktop, '../.somniq/changes/agent-summary-2026-10-15'));

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Chat from './src/chat/Chat';
import {makeSession, CURRENT_KEY} from './src/chat/model';
import {useStore} from './src/store';
import './src/styles.css';
const project={id:'research',name:'持续学习',path:'F:/Research',createdAt:'2026-10-15T12:00:00Z'};
const session={...makeSession(project.id),id:'chat-research',title:'时间序列持续学习研究',turns:[
 {id:'user',role:'user',blocks:[{kind:'text',text:'请调查「时间序列数据持续学习研究方向」，用于判断未来半年的研究选题。委派两个只读子智能体并行工作，给出可核查的论文来源，并由独立 Reviewer 核查证据。'}]},
 {id:'assistant',role:'assistant',blocks:[{kind:'text',text:'已将调查分为两个独立方向。文献智能体梳理方法、数据集和评价指标；问题智能体核查方法局限和复现难点。完成后将整合双方证据并交给独立 Reviewer。'},
  {kind:'tool',id:'spawn-survey',name:'spawn_agent',input:'{}',output:JSON.stringify({sessionId:'agent-survey'})},
  {kind:'tool',id:'spawn-limits',name:'Agent',input:'{}',output:JSON.stringify({sessionId:'agent-limits'})},
 ]},
]};
const contract={reason:'分别核查方法谱系和实际复现限制，使用独立上下文交叉检查证据。',inputs:'2023—2026 年论文元数据与本地证据库',deliverable:'代表论文、可核查的 DOI、证据位置与研究空白',stopCondition:'覆盖主要方法族和关键评估协议后停止',model:'deepseek-v4.1-flash',connection:'Configured executor',permission:'read-only',workspace:project.path,maxIterations:16,maxSeconds:600};
let agents=[
 {revision:1,sessionId:'agent-survey',rootSessionId:session.id,path:'/root/survey_agent',projectId:project.id,status:{state:'running'},pendingMail:0,task:{...contract,task:'梳理近三年的代表论文、主要方法、数据集和评价指标。对照 continual learning、online adaptation、experience replay 与 test-time adaptation，逐项核查论文的实验设置与数据使用边界。'},lastActivity:'ScopusSearch · continual learning for time series',interruptionReason:null,sessionPath:'agents/survey.json',evidencePath:'agents/survey.events.jsonl'},
 {revision:1,sessionId:'agent-limits',rootSessionId:session.id,path:'/root/limits_agent',projectId:project.id,status:{state:'waiting'},pendingMail:0,task:{...contract,task:'调查现有方法的局限、实验与复现难点，提出值得进一步核查的研究问题。'},lastActivity:'read_file · benchmark-evaluation.md',interruptionReason:null,sessionPath:'agents/limits.json',evidencePath:'agents/limits.events.jsonl'},
];
agents=agents.map((agent,index)=>({...agent,startedAt:Date.now()-(index?44000:47000),finishedAt:null}));
const callbacks=new Map(); const listeners=new Map(); let seq=0; const calls=[];
const emit=(event,payload)=>{for(const id of listeners.get(event)??[])callbacks.get(id)?.({event,id,payload});};
const turns=(child)=>[
 {id:child+'-task',role:'user',blocks:[{kind:'text',text:agents.find(a=>a.sessionId===child).task.deliverable}]},
 {id:child+'-tools',role:'assistant',blocks:[
  {kind:'text',text:'先核查已有证据，再对照论文中的评价协议。'},
  {kind:'tool',id:'read',name:'read_file',input:'{"path":"benchmark-evaluation.md"}',output:'The benchmark uses a chronological split. Cross-device evaluation has not been measured.',isError:false},
  {kind:'text',text:child==='agent-survey'?'已核查 **时间划分与评估协议**。文献中的设备内结果不能直接支持跨设备泛化；需要单独验证。':'已定位复现缺口：**跨设备测量尚未开展**。后续实验必须补充独立设备的数据划分。'},
 ]},
];
const brief={mission:'通过可追溯的文献与实验，确定值得推进的时间序列持续学习研究问题。',goal:null};
window.__TAURI_INTERNALS__={
 metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback:(fn)=>{const id=++seq;callbacks.set(id,fn);return id;},
 unregisterCallback:(id)=>callbacks.delete(id),convertFileSrc:(file)=>file,
 invoke:async(command,args={})=>{
  calls.push({command,args});
  if(command==='plugin:event|listen'){const items=listeners.get(args.event)??[];items.push(args.handler);listeners.set(args.event,items);return args.handler;}
  if(command==='chat_agent_list')return args.sessionId===session.id?agents:[];
  if(command==='chat_agent_detail')return {info:agents.find(a=>a.sessionId===args.childSessionId),transcript:'',turns:turns(args.childSessionId),timeline:[{seq:1,ts:1792083600000,kind:'agent.turn.started'},{seq:2,ts:1792083601000,kind:'agent.tool.started',toolName:'read_file'},{seq:3,ts:1792083602000,kind:'agent.tool.finished',toolName:'read_file',isError:false}]};
  if(command==='chat_agent_interrupt'){agents=agents.map(a=>a.path===args.target?{...a,revision:a.revision+1,status:{state:'interrupted'},finishedAt:Date.now(),interruptionReason:'已停止；对话与已完成证据保留。'}:a);emit('chat-agents',{sessionId:session.id,agents});return;}
  if(command==='chat_ui_sessions_list')return [session];
  if(command==='chat_ui_session_load')return args.sessionId===session.id?session:null;
  if(command==='chat_status')return {ready:true,model:contract.model,provider:'openai-compatible',contextWindow:120000,compactionBudget:100000};
  if(command==='chat_model_options')return {provider:'openai-compatible',current:contract.model,options:[{value:contract.model,label:contract.model}]};
  if(command==='chat_permission_get')return {mode:'workspace-write',label:'Accept edits',description:'Read and edit workspace files'};
  if(command==='chat_reasoning_effort_get')return {effort:'high',supported:false,options:[],transport:'unsupported'};
  if(command==='config_get')return {reviewEnabled:true};
  if(command==='project_brief_get')return brief;
  if(command==='git_status')return {isRepository:false};
  if(command==='chat_events_replay')return {sessionId:session.id,eventCount:0,lastSeq:0,turns:[]};
  if(command==='chat_context_tokens')return 5000;
  if(command==='file_search')return [];
  if(command.endsWith('_list')||command==='chat_tasks_get'||command==='chat_command_specs'||command==='chat_events_read')return [];
  return null;
 }
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event,id)=>listeners.set(event,(listeners.get(event)??[]).filter(item=>item!==id))};
localStorage.setItem(CURRENT_KEY,session.id);
useStore.setState({tab:'chat',language:'cn',projects:[project],currentProject:project,chatSidebarOpen:false});
window.fixture={calls,complete:()=>{agents=agents.map(a=>a.sessionId==='agent-survey'?{...a,revision:a.revision+1,status:{state:'completed',message:'已完成文献核查'},finishedAt:Date.now(),lastActivity:'read_file · evidence complete'}:a);emit('chat-agents',{sessionId:session.id,agents});},language:(language)=>useStore.setState({language}),theme:(theme)=>useStore.getState().setTheme(theme)};
createRoot(document.getElementById('root')).render(<div className="preview-app"><header className="preview-header"><strong>SomniQ Chat</strong><span>持续学习</span><div id="app-chat-actions-portal"/></header><Chat/></div>);
`;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const bundle = await esbuild.build({
    stdin: { contents: fixture, resolveDir: desktop, loader: 'tsx' },
    bundle: true, write: false, outfile: 'preview.js', format: 'esm', jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.tex': 'text' },
    plugins: [{ name: 'unused-worker-url', setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'worker-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'worker-fixture' }, () => ({ contents: 'export default "/unused-worker.mjs";' }));
    } }],
  });
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  const server = http.createServer((request, response) => {
    if (request.url === '/preview.js') { response.setHeader('content-type', 'text/javascript'); response.end(javascript); return; }
    if (request.url === '/preview.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/preview.css"><style>html,body,#root{height:100%;margin:0}.preview-app{height:100%;display:flex;flex-direction:column}.preview-header{height:46px;flex-shrink:0;display:flex;align-items:center;gap:28px;padding:0 22px;border-bottom:1px solid var(--border);background:var(--bg);font-size:13px}.preview-header>span{color:var(--text-dim)}#app-chat-actions-portal{margin-left:auto}.preview-app>.chat-root{position:relative;inset:auto;flex:1;min-height:0}.chat-root{width:100%}</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let page;
  const issues = [];
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => issues.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('.chat-session-title[title="时间序列持续学习研究"]').click();
    const summary = page.locator('#project-brief-popover');
    const summaryLauncher = summary.getByRole('button', { name: '查看子智能体' });
    await summaryLauncher.waitFor();
    assert.equal(await page.locator('main.chat .agent-task-cards').count(), 0);
    assert.equal(await summary.locator('.agent-task-row').count(), 0);
    assert.equal(await summary.locator('.agent-identity').count(), 2);
    assert.ok(await summary.locator('.agent-task-cards').evaluate(node => node.getBoundingClientRect().height < 100));
    const identity = await summary.locator('[data-agent-id="agent-survey"]').getAttribute('data-identity');
    const notice = page.getByRole('group', { name: '已委派子任务' });
    await notice.waitFor();
    assert.equal(await notice.locator('[data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    await page.screenshot({ path: path.join(output, 'summary.png') });
    await summaryLauncher.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: '子智能体', exact: true }).waitFor();
    const directory = page.locator('.agent-task-directory:visible');
    await directory.getByRole('button', { name: '打开子任务 文献检索' }).waitFor();
    assert.equal(await directory.locator('.agent-task-row').count(), 2);
    assert.ok(await directory.locator('.agent-task-row').first().evaluate(node => node.getBoundingClientRect().height < 90));
    assert.equal(await directory.locator('[data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    assert.equal(await directory.locator('time').count(), 2);
    await page.screenshot({ path: path.join(output, 'directory.png') });
    await notice.getByRole('button', { name: '文献检索', exact: true }).click();
    await page.getByRole('tab', { name: '文献检索', exact: true }).waitFor();
    await page.locator('.agent-task-panel .chat-assistant').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-task-panel .chat-turn')].every(node => getComputedStyle(node).opacity === '1'));
    assert.ok(await page.locator('main.chat .chat-thread').isVisible());
    assert.equal(await page.locator('.agent-task-panel-head [data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    assert.equal(await page.getByRole('tab', { name: '文献检索', exact: true }).locator('[data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    await page.screenshot({ path: path.join(output, 'conversation.png') });
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await page.getByText('工具调用完成 · read_file', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'activity.png') });
    await page.evaluate(() => window.fixture.complete());
    await page.locator('.agent-task-panel-head').getByText('已完成', { exact: true }).waitFor();
    assert.equal(await page.locator('.agent-task-panel-head [data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    await page.getByRole('button', { name: '所有子智能体', exact: true }).click();
    await directory.getByText('已完成文献核查', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '子智能体', exact: true }).count(), 1);
    await page.getByRole('button', { name: '显示项目摘要' }).click();
    await summary.getByRole('button', { name: '查看子智能体' }).click();
    await directory.getByRole('button', { name: '打开子任务 局限核查' }).click();
    await page.getByRole('tab', { name: '局限核查', exact: true }).waitFor();
    await page.locator('.agent-task-panel:visible .chat-assistant').waitFor();
    await page.locator('.agent-task-panel:visible').getByRole('button', { name: '停止', exact: true }).click();
    await page.locator('.agent-task-panel:visible .agent-task-panel-head').getByText('已停止', { exact: true }).waitFor();
    await page.getByRole('button', { name: '显示项目摘要' }).click();
    await summary.getByRole('button', { name: '查看子智能体' }).click();
    await directory.getByRole('button', { name: '打开子任务 文献检索' }).click();
    assert.equal(await page.getByRole('tab', { name: '文献检索', exact: true }).count(), 1);
    await page.reload();
    await page.locator('.chat-session-title[title="时间序列持续学习研究"]').click();
    await page.getByRole('tab', { name: '文献检索', exact: true }).waitFor();
    await page.locator('.agent-task-panel:visible .chat-assistant').waitFor();
    assert.equal(await page.locator('.agent-task-panel-head [data-agent-id="agent-survey"]').getAttribute('data-identity'), identity);
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-task-panel .chat-turn')].every(node => getComputedStyle(node).opacity === '1'));
    const layouts = [];
    for (const width of [1440, 960, 720, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForFunction(() => [...document.querySelectorAll('.agent-task-panel .chat-turn')].every(node => getComputedStyle(node).opacity === '1'));
      await page.screenshot({ path: path.join(output, 'conversation-' + width + '.png') });
      const geometry = await page.locator('.agent-task-panel:visible').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const content = node.querySelector('.agent-task-panel-scroll');
        return { left: rect.left, right: rect.right, width: rect.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
          contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth };
      });
      assert.ok(geometry.left >= -1 && geometry.right <= width + 1, JSON.stringify({ width, geometry }));
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, JSON.stringify({ width, geometry }));
      assert.ok(geometry.contentScrollWidth <= geometry.contentWidth + 1, JSON.stringify({ width, geometry }));
      await page.getByRole('button', { name: '所有子智能体', exact: true }).click();
      await page.screenshot({ path: path.join(output, 'directory-' + width + '.png') });
      const directoryGeometry = await directory.evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
      assert.ok(directoryGeometry.scrollWidth <= directoryGeometry.clientWidth + 1, JSON.stringify({ width, directoryGeometry }));
      await directory.getByRole('button', { name: '打开子任务 文献检索' }).click();
      layouts.push({ viewportWidth: width, ...geometry });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => { window.fixture.language('en'); window.fixture.theme('light'); });
    await page.getByRole('tab', { name: 'Conversation', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'conversation-light-en.png') });
    await page.getByRole('button', { name: 'All agents', exact: true }).click();
    await page.getByRole('tab', { name: 'Agents', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'directory-light-en.png') });
    const calls = await page.evaluate(() => window.fixture.calls);
    assert.equal(calls.filter(call => call.command === 'chat_send').length, 0);
    assert.equal(calls.filter(call => call.command === 'chat_agent_detail' && call.args.childSessionId === 'agent-survey').length > 0, true);
    assert.deepEqual(issues, []);
    const result = { kind: 'chromium-ui-fixture', modelCalls: 0, layouts, assertions: ['compact summary launcher', 'keyboard navigation', 'bounded directory rows', 'stable identity across notice summary directory conversation and tab', 'recorded elapsed time', 'inline spawn links', 'original child identity', 'main chat remains visible', 'durable activity view', 'event-driven completion', 'stop original child', 'directory and child tab deduplication', 'tab and identity restoration', 'responsive conversation and directory', 'light theme and English'], issues };
    fs.writeFileSync(path.join(output, 'browser-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error({ issues, body: (await page.locator('body').innerText()).slice(0, 3000) }); }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
