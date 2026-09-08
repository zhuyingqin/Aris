const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const distDir = path.join(__dirname, '..', 'dist');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  if (reqPath.endsWith('/')) reqPath += 'index.html';
  
  let filePath = path.join(distDir, reqPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end(`Server Error: ${err.code}`);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(4173, async () => {
  console.log('Static server running on http://localhost:4173');
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // 1. 375px Chinese Dark (Activity)
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('somniq_user_session_v1', JSON.stringify({
        id: 108,
        username: 'Dr.Researcher',
        display_name: 'Dr.Researcher',
        role: 1,
        status: 1,
        quota: 8500000,
        used_quota: 2300000,
        token: 'sk-somniq-demo-access-token-123456'
      }));
      localStorage.setItem('somniq_access_token_v1', 'sk-somniq-demo-access-token-123456');
      localStorage.setItem('somniq-site-lang', 'zh');
      localStorage.setItem('somniq-site-theme', 'dark');
    });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(__dirname, 'tab_compact_375_zh.png') });

    // 2. 375px English Dark
    await page.evaluate(() => {
      localStorage.setItem('somniq-site-lang', 'en');
      localStorage.setItem('somniq-site-theme', 'dark');
    });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(__dirname, 'tab_compact_375_en.png') });

    // 3. 360px Chinese Dark (ultra narrow Android)
    await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.evaluate(() => {
      localStorage.setItem('somniq-site-lang', 'zh');
      localStorage.setItem('somniq-site-theme', 'dark');
    });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(__dirname, 'tab_compact_360_zh.png') });

    // 4. Desktop 1280px Dark view
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5, isMobile: false });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(__dirname, 'dashboard_desktop_full.png') });

    // 5. Desktop 1280px Light view
    await page.evaluate(() => {
      localStorage.setItem('somniq-site-theme', 'light');
    });
    await page.goto('http://localhost:4173/dashboard.html', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(__dirname, 'dashboard_desktop_light.png') });

    console.log('All tab and desktop screenshots saved successfully!');
    await browser.close();
  } catch (err) {
    console.error('Error running puppeteer:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
