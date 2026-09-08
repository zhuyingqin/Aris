#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("./mcp/playwright/node_modules/playwright-core");

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    if (required) throw new Error(`Missing ${name}`);
    return "";
  }
  return process.argv[index + 1];
}

function httpUrl(value, name) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must be http(s)`);
  }
  return parsed.toString();
}

async function download(context, request) {
  const pageUrl = httpUrl(request.pageUrl, "pageUrl");
  let pdfUrl = request.pdfUrl || "";
  const extractor = request.extractor || "";
  if (!request.output) throw new Error("Missing output");
  const outputPath = path.resolve(request.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultNavigationTimeout(45_000);
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  // Keep the navigation and the click in the same browser context. MDPI's
  // edge checks the page cookie/fetch context before allowing the PDF action;
  // a second direct request frequently gets the 403 HTML challenge instead.
  const clickDownload = async () => {
    const candidates = [
      page.getByRole("link", { name: /download\s*pdf/i }).first(),
      page.getByRole("button", { name: /download\s*pdf/i }).first(),
      page.locator('a[href*="/pdf"]').first(),
    ];
    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0) === 0) continue;
      const href = await candidate.getAttribute("href").catch(() => null);
      if (href && !pdfUrl) pdfUrl = new URL(href, pageUrl).toString();
      return candidate;
    }
    return null;
  };

  if (extractor === "sciencedirect_viewpdf") {
    pdfUrl = await page.evaluate(() => {
      for (const link of document.querySelectorAll("a")) {
        const text = (link.innerText || link.textContent || "").trim();
        const aria = (link.getAttribute("aria-label") || "").trim();
        if (text === "ViewPDF" || text === "View PDF" || /View PDF/i.test(aria)) {
          return link.href || "";
        }
      }
      return "";
    });
  }
  const downloadButton = await clickDownload();
  if (!pdfUrl && !downloadButton) throw new Error("Could not resolve a PDF URL or Download PDF button from the browser page");
  if (pdfUrl) pdfUrl = httpUrl(pdfUrl, "resolved PDF URL");

  let response = null;
  let browserDownload = null;
  if (downloadButton) {
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await downloadButton.click({ noWaitAfter: true }).catch(() => null);
    browserDownload = await Promise.race([
      downloadPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 2_000)),
    ]);
  }
  if (!browserDownload && pdfUrl) {
    response = await page.goto(pdfUrl, {
      referer: pageUrl,
      waitUntil: "commit",
    }).catch(() => null);
  }

  if (browserDownload) {
    await browserDownload.saveAs(outputPath);
  } else if (response) {
    fs.writeFileSync(outputPath, await response.body());
  } else {
    const delayedDownload = await downloadPromise;
    if (!delayedDownload) throw new Error("PDF navigation produced neither a response nor a download");
    await delayedDownload.saveAs(outputPath);
  }

  const handle = fs.openSync(outputPath, "r");
  const header = Buffer.alloc(4);
  fs.readSync(handle, header, 0, header.length, 0);
  fs.closeSync(handle);
  if (header.toString("ascii") !== "%PDF") throw new Error("Browser response is not a PDF");
  return { path: outputPath, bytes: fs.statSync(outputPath).size };
}

async function server() {
  const profileDir = path.resolve(option("--profile-dir"));
  const cdpPort = option("--cdp-port", false);
  fs.mkdirSync(profileDir, { recursive: true });
  const channel = process.platform === "win32" ? "msedge" : "chrome";
  const context = await chromium.launchPersistentContext(profileDir, {
    channel,
    acceptDownloads: true,
    // This long-lived worker is initialized with the desktop app so the
    // Playwright MCP preset can attach over CDP. It must not create a visible
    // browser window merely because SomniQ was opened.
    headless: true,
    args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [],
  });
  process.stdout.write(`${JSON.stringify({
    ready: true,
    cdpEndpoint: cdpPort ? `http://127.0.0.1:${cdpPort}` : null,
    browser: channel,
    profileDir,
  })}\n`);

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      if (request.command === "shutdown") break;
      process.stdout.write(`${JSON.stringify({ ok: true, result: await download(context, request) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.stack || error.message || String(error) })}\n`);
    }
  }
  await context.close();
}

server().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
