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

server.listen(4174, async () => {
  console.log('Static server running on http://localhost:4174');
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Helper function to setup and screenshot
    const captureUsage = async (width, height, isMobile, theme, filename) => {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile, hasTouch: isMobile });
      await page.goto('http://localhost:4174/dashboard.html', { waitUntil: 'domcontentloaded' });
      await page.evaluate((th) => {
        localStorage.setItem('somniq_user_session_v1', JSON.stringify({
          id: 108,
          username: 'Dr.Researcher',
          display_name: 'Dr.Researcher',
          role: 1,
          status: 1,
          quota: 8500000,
          used_quota: 2300000,
          request_count: 14660,
          token: 'sk-somniq-demo-access-token-123456'
        }));
        localStorage.setItem('somniq_access_token_v1', 'sk-somniq-demo-access-token-123456');
        localStorage.setItem('somniq-site-lang', 'zh');
        localStorage.setItem('somniq-site-theme', th);
      }, theme);
      await page.goto('http://localhost:4174/dashboard.html', { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 400));

      // Click on Usage tab
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.console-nav-item'));
        const usageBtn = btns.find(b => b.textContent.includes('算力用量') || b.textContent.includes('用量'));
        if (usageBtn) usageBtn.click();
      });
      await new Promise(r => setTimeout(r, 600));

      await page.screenshot({ path: path.join(__dirname, filename), fullPage: true });
      console.log(`Saved: ${filename}`);
      await page.close();
    };

    // 1. 375px iPhone Dark
    await captureUsage(375, 812, true, 'dark', 'usage_mobile_full_after_dark.png');

    // 2. 375px iPhone Light
    await captureUsage(375, 812, true, 'light', 'usage_mobile_full_after_light.png');

    // 3. 360px Android Dark
    await captureUsage(360, 740, true, 'dark', 'usage_mobile_360_dark.png');

    // 4. Desktop 1280px Dark
    await captureUsage(1280, 800, false, 'dark', 'usage_desktop_full_after.png');

    console.log('All screenshots completed successfully!');
    await browser.close();
  } catch (err) {
    console.error('Error running puppeteer:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
