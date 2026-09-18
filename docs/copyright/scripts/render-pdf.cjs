#!/usr/bin/env node
/**
 * 将 docs/copyright/out 下的 HTML 文档用 Chrome 打印为 PDF。
 *
 * 页眉页脚的两种处理方式：
 *   1. 文档自带分页容器（如源程序.html，每页是一个 .page 且页码已逐页写死）
 *      —— 不启用浏览器页眉页脚，直接打印。
 *   2. 流式排版文档（如软件说明书.html）
 *      —— 由 HTML 中的 <meta name="pdf-running" content="on"> 触发，
 *         使用 Chrome DevTools 协议的原生页眉页脚绘制连续页码。
 *
 * 为什么必须走 DevTools 协议：CSS 中用 position:fixed 元素配合 counter(page)
 * 绘制页码的常见写法，在 Chromium 下该元素虽然每页重绘，但 counter(page)
 * 只解析一次，导致所有页面都印成"第 1 页"。只有 Page.printToPDF 的
 * headerTemplate / footerTemplate 才能得到真正递增的页码。
 *
 * 用法：
 *   node docs/copyright/scripts/render-pdf.cjs                 # 转换全部
 *   node docs/copyright/scripts/render-pdf.cjs 软件说明书.html   # 只转换指定文件
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const COPYRIGHT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(COPYRIGHT_DIR, 'out');
const DEBUG_PORT = 9333;

/**
 * 输入 HTML 来自两处：
 *   - docs/copyright/        手写的源文档（软件说明书）
 *   - docs/copyright/out/    脚本生成的文档（源程序）
 * PDF 一律输出到 out/。
 */
function collectInputs(target) {
  if (target) {
    for (const dir of [COPYRIGHT_DIR, OUT_DIR]) {
      const candidate = path.join(dir, target);
      if (fs.existsSync(candidate)) return [candidate];
    }
    throw new Error(`未找到 ${target}`);
  }
  const inputs = [];
  for (const dir of [COPYRIGHT_DIR, OUT_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.html') && !f.startsWith('_')) inputs.push(path.join(dir, f));
    }
  }
  return inputs;
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const MM_PER_INCH = 25.4;
const mm = (v) => v / MM_PER_INCH;

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome 或 Edge');
}

function toFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForChrome(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chrome 调试端口未就绪');
}

/** 极简 CDP 客户端，基于 Node 内置 WebSocket */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    this.ws.close();
  }
}

/** 从 HTML 中读取打印配置 */
function readPrintConfig(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const meta = (name) => {
    const m = html.match(
      new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i')
    );
    return m ? m[1] : null;
  };
  return {
    running: meta('pdf-running') === 'on',
    headerLeft: meta('pdf-header-left') || '',
    headerRight: meta('pdf-header-right') || '',
    skipFirst: meta('pdf-skip-first') === 'on',
  };
}

function buildTemplates(cfg) {
  // 页眉页脚模板在独立上下文中渲染，必须自带样式，且默认无边距
  const base =
    'font-family:SimSun,serif;font-size:9pt;width:100%;' +
    'padding:0 18mm 0 20mm;box-sizing:border-box;-webkit-print-color-adjust:exact;';
  const header = `<div style="${base}">
    <div style="display:flex;justify-content:space-between;align-items:baseline;
                border-bottom:0.5pt solid #000;padding-bottom:1mm;">
      <span style="font-weight:700;">${cfg.headerLeft}</span>
      <span>${cfg.headerRight}</span>
    </div>
  </div>`;
  const footer = `<div style="${base}">
    <div style="border-top:0.5pt solid #000;padding-top:1mm;text-align:center;">
      第 <span class="pageNumber"></span> 页 &nbsp;/&nbsp; 共 <span class="totalPages"></span> 页
    </div>
  </div>`;
  return { header, footer };
}

function countPdfPages(file) {
  const s = fs.readFileSync(file).toString('latin1');
  return (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/**
 * Windows 上 PDF 阅读器（含本应用的预览窗格）会持有文件独占句柄，
 * 直接覆盖会报 EBUSY。策略：先写临时文件，再重试替换；
 * 若始终替换不掉，保留临时文件并明确告知，不让整批渲染失败。
 */
async function writePdfResilient(pdfFile, buf) {
  try {
    fs.writeFileSync(pdfFile, buf);
    return { path: pdfFile, replaced: true };
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
  }
  const tmp = pdfFile.replace(/\.pdf$/, '.new.pdf');
  fs.writeFileSync(tmp, buf);
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    try {
      fs.rmSync(pdfFile, { force: true });
      fs.renameSync(tmp, pdfFile);
      return { path: pdfFile, replaced: true };
    } catch {
      /* 仍被占用，继续重试 */
    }
  }
  return { path: tmp, replaced: false };
}

async function render(cdp, htmlFile) {
  const cfg = readPrintConfig(htmlFile);
  const pdfFile = path.join(
    OUT_DIR,
    path.basename(htmlFile).replace(/\.html$/, '.pdf')
  );

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url: toFileUrl(htmlFile) });
  await loaded;
  await sleep(800); // 等待字体与布局稳定

  const params = {
    printBackground: true,
    preferCSSPageSize: !cfg.running,
    displayHeaderFooter: cfg.running,
    transferMode: 'ReturnAsBase64',
  };
  if (cfg.running) {
    const { header, footer } = buildTemplates(cfg);
    Object.assign(params, {
      paperWidth: mm(210),
      paperHeight: mm(297),
      marginTop: mm(22),
      marginBottom: mm(20),
      marginLeft: mm(20),
      marginRight: mm(18),
      headerTemplate: header,
      footerTemplate: footer,
    });
  }

  const { data } = await cdp.send('Page.printToPDF', params);
  const out = await writePdfResilient(pdfFile, Buffer.from(data, 'base64'));

  const size = fs.statSync(out.path).size;
  process.stdout.write(
    `${path.basename(out.path)}  ${(size / 1024 / 1024).toFixed(2)} MB  ` +
      `${countPdfPages(out.path)} 页  ${cfg.running ? '[浏览器页眉页脚]' : '[文档自带分页]'}\n`
  );
  if (!out.replaced) {
    process.stdout.write(
      `  ⚠️ ${path.basename(pdfFile)} 被其他程序占用（多为 PDF 阅读器或预览窗格），\n` +
        `     新文件已写入 ${path.basename(out.path)}。关闭占用程序后重命名即可。\n`
    );
  }
}

async function main() {
  const chrome = findChrome();
  const files = collectInputs(process.argv[2]);
  if (files.length === 0) {
    process.stdout.write('没有待转换的 HTML 文件\n');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  process.stdout.write(`使用浏览器：${chrome}\n`);

  const userDir = path.join(OUT_DIR, '.chrome-profile');
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  try {
    await waitForChrome();
    const targets = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    for (const file of files) await render(cdp, file);
    cdp.close();
  } finally {
    proc.kill();
    await sleep(300);
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
