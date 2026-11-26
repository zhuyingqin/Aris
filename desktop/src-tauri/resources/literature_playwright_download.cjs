#!/usr/bin/env node
"use strict";

// Long-lived headless browser worker for publisher PDFs, driven by
// desktop/src-tauri/src/playwright_pdf.rs: one JSON request per stdin line,
// one JSON reply per stdout line.
//
// Each guarantee below answers a failure the computer-use R0 baseline
// measured (docs/development-logic/computer-use-r0.md, section 2):
//
// - Sites. Only the landing page's site, and the site of a pdfUrl the caller
//   gave, may be navigated to. A PDF link anywhere else is reported (code
//   `cross_site`) without being visited, so the caller can ask the user.
//   Redirects a permitted site answers with are followed: publishers serve
//   PDFs from asset hosts (pdf.sciencedirectassets.com, mdpi-res.com).
// - Bytes. An inline PDF is fetched as raw bytes in the page's own browser
//   context. Navigating to it only yields the PDF viewer's HTML shell.
// - Identity. Before the file is kept it is checked against the caller's
//   expected DOI/title and the DOI/title the landing page declares (code
//   `identity_mismatch`). Same ladder as tools::literature::judge_pdf_identity;
//   keep the two in step.
// - Recovery. A crashed or closed page is replaced and a dead browser is
//   relaunched, instead of failing every later request until the app restarts.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { chromium } = require("./mcp/playwright/node_modules/playwright-core");

const MAX_PDF_BYTES = 80 * 1024 * 1024; // tools::literature MAX_PDF_BYTES
const FRONT_TEXT_CHARS = 8_000; // tools::literature PDF_IDENTITY_FRONT_TEXT_CHARS
const MAX_INFLATED_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_TOTAL_BYTES = 64 * 1024 * 1024;
const CLICK_DOWNLOAD_WAIT_MS = 3_000;

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** An expected refusal: the reply carries `code`, and no stack trace. */
class WorkerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

const MULTI_LABEL_SUFFIXES = new Set([
  "ac.uk", "co.uk", "org.uk", "gov.uk", "ac.jp", "co.jp", "or.jp", "ne.jp", "go.jp",
  "ac.cn", "com.cn", "edu.cn", "gov.cn", "net.cn", "org.cn", "com.au", "edu.au", "org.au",
  "com.hk", "edu.hk", "com.tw", "edu.tw", "ac.kr", "co.kr", "ac.in", "co.in", "com.br",
  "edu.br", "ac.nz", "co.nz", "com.sg", "edu.sg", "ac.za", "co.za",
]);

/**
 * The registrable domain ("same site" in the browser's sense) of a URL. IP
 * literals, localhost and other single-label hosts have none, so there every
 * port is its own site.
 */
function siteOf(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || !host.includes(".")) {
    return `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  }
  const labels = host.split(".");
  return labels.slice(MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

function crossSiteError(url, allowed) {
  return new WorkerError(
    "cross_site",
    `the PDF link on this page points to ${url}, on another site (${siteOf(url)}). This download is only authorised for ${[...allowed].join(", ")}, so the link was not opened. Ask the user before downloading from that site; if they agree, retry with that link as the explicit PDF URL.`,
  );
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

const browser = {
  launch: null,
  context: null,
  // The worker's own tab. Playwright MCP shares this browser over CDP, so the
  // worker must not borrow whichever tab happens to be first.
  page: null,
  pageCrashed: false,
};

function adoptPage(page) {
  if (!page) return null;
  browser.pageCrashed = false;
  page.setDefaultNavigationTimeout(45_000);
  page.on("crash", () => {
    if (browser.page === page) browser.pageCrashed = true;
  });
  page.on("close", () => {
    if (browser.page === page) browser.page = null;
  });
  return page;
}

async function closeContext() {
  const context = browser.context;
  browser.context = null;
  browser.page = null;
  if (context) await Promise.race([context.close().catch(() => {}), delay(10_000)]);
}

/** The worker's tab, replaced if it crashed or closed; the browser relaunched if it died. */
async function healthyPage() {
  if (browser.page && !browser.pageCrashed && !browser.page.isClosed()) return browser.page;
  if (browser.page) {
    const stale = browser.page;
    browser.page = null;
    await Promise.race([stale.close().catch(() => {}), delay(5_000)]);
  }
  if (browser.context) {
    try {
      browser.page = adoptPage(await browser.context.newPage());
      return browser.page;
    } catch {
      await closeContext();
    }
  }
  await browser.launch();
  if (!browser.page) browser.page = adoptPage(await browser.context.newPage());
  return browser.page;
}

/**
 * The tab or the browser died under a request. A renderer crash reaches
 * Playwright either as a crash ("Page crashed") or, when the crash beats the
 * crash event, as the main frame detaching mid-navigation.
 */
function browserGone(error) {
  return /Page crashed|Target crashed|Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected|frame was detached/i
    .test(String((error && error.message) || error));
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const isPdf = bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "%PDF";

async function findDownloadControl(page, baseUrl, isAllowed) {
  const groups = [
    page.getByRole("link", { name: /download\s*pdf/i }),
    page.getByRole("button", { name: /download\s*pdf/i }),
    page.locator('a[href*="/pdf"]'),
  ];
  let blocked = "";
  for (const group of groups) {
    const count = Math.min(await group.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const control = group.nth(index);
      const href = (await control.getAttribute("href").catch(() => null)) || "";
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return { control, href: "", blocked };
      let target;
      try {
        target = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
      if (!/^https?:/i.test(target)) continue;
      if (!isAllowed(target)) {
        blocked = blocked || target;
        continue;
      }
      return { control, href: target, blocked };
    }
  }
  return { control: null, href: "", blocked };
}

/**
 * Click in the page itself: MDPI's edge checks the page cookie/fetch context
 * before allowing the PDF action, and a second direct request frequently gets
 * the 403 HTML challenge instead. Main-frame navigations to other sites are
 * aborted for the duration, so a button cannot take the browser there either.
 */
async function clickForDownload(page, control, isAllowed, outputPath) {
  const blocked = [];
  const guard = route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !isAllowed(request.url())) {
      blocked.push(request.url());
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  };
  const before = page.url();
  await page.route("**/*", guard);
  try {
    // A new tab would escape the guard above.
    await control.evaluate(element => element.removeAttribute("target")).catch(() => {});
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await control.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => null);
    const download = await Promise.race([downloadPromise, delay(CLICK_DOWNLOAD_WAIT_MS).then(() => null)]);
    if (download) {
      await download.saveAs(outputPath);
      if (isPdf(fs.readFileSync(outputPath))) return { saved: true, url: download.url(), blocked };
      fs.rmSync(outputPath, { force: true });
    } else {
      // A download that starts after we moved on is not ours to keep.
      downloadPromise.then(late => late && late.delete().catch(() => {}));
    }
    const now = page.url();
    return { saved: false, navigatedTo: now !== before && /^https?:/i.test(now) ? now : "", blocked };
  } finally {
    await page.unroute("**/*", guard).catch(() => {});
  }
}

/**
 * Raw PDF bytes for `url`: first a fetch inside the page (the browser's own
 * network stack, cookies and TLS, as the click used), then the context's
 * request API (same cookies, no CORS, Node's network stack).
 */
async function fetchPdfBytes(page, url, referer) {
  const attempts = [];
  const inPageFetch = page.evaluate(async ({ url, max, timeoutMs }) => {
    try {
      const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > max) return { error: `PDF is larger than ${max} bytes` };
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
      }
      return {
        status: response.status,
        type: response.headers.get("content-type") || "",
        url: response.url,
        base64: btoa(binary),
      };
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  }, { url, max: MAX_PDF_BYTES, timeoutMs: 60_000 }).catch(error => ({ error: error.message }));
  // `evaluate` itself has no timeout; a page that never settles must not hang the worker.
  const inPage = await Promise.race([inPageFetch, delay(75_000).then(() => ({ error: "timed out" }))]);
  if (inPage.base64 !== undefined) {
    const bytes = Buffer.from(inPage.base64, "base64");
    if (isPdf(bytes)) return { bytes, url: inPage.url || url };
    attempts.push(`in-page fetch got HTTP ${inPage.status} ${inPage.type || "without a content type"}`);
  } else {
    attempts.push(`in-page fetch failed: ${inPage.error}`);
  }

  try {
    const response = await page.context().request.get(url, {
      headers: { Referer: referer, Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8" },
      timeout: 60_000,
      failOnStatusCode: false,
    });
    const bytes = await response.body();
    if (bytes.length > MAX_PDF_BYTES) throw new Error(`PDF is larger than ${MAX_PDF_BYTES} bytes`);
    if (isPdf(bytes)) return { bytes, url: response.url() };
    attempts.push(`context request got HTTP ${response.status()} ${response.headers()["content-type"] || "without a content type"}`);
  } catch (error) {
    attempts.push(`context request failed: ${error.message}`);
  }
  throw new Error(`Browser response is not a PDF (${attempts.join("; ")})`);
}

async function download(request) {
  const pageUrl = httpUrl(request.pageUrl, "pageUrl");
  const callerPdfUrl = request.pdfUrl ? httpUrl(request.pdfUrl, "pdfUrl") : "";
  const extractor = request.extractor || "";
  const expected = normalizeExpected(request.expected);
  if (!request.output) throw new Error("Missing output");
  const outputPath = path.resolve(request.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });

  const allowed = new Set([siteOf(pageUrl)]);
  if (callerPdfUrl) allowed.add(siteOf(callerPdfUrl));
  const isAllowed = url => {
    try {
      return allowed.has(siteOf(url));
    } catch {
      return false;
    }
  };

  const page = await healthyPage();
  let landing = null;
  let pdfUrl = callerPdfUrl;
  try {
    landing = await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    // The "page" is itself a PDF served as an attachment.
    if (!/Download is starting/i.test(error.message)) throw error;
    pdfUrl = pdfUrl || pageUrl;
  }
  // Where the page landed is the authorised site's own answer (a DOI
  // resolver redirecting to the publisher, for one).
  const landedUrl = landing ? page.url() : pageUrl;
  if (landing) allowed.add(siteOf(landedUrl));
  if (landing && /application\/pdf/i.test(landing.headers()["content-type"] || "")) pdfUrl = pdfUrl || landedUrl;
  const pageIdentity = landing ? await readPageIdentity(page).catch(() => ({ dois: [], titles: [] })) : { dois: [], titles: [] };

  let blocked = "";
  if (landing && extractor === "sciencedirect_viewpdf" && !pdfUrl) {
    const viewPdf = await page.evaluate(() => {
      for (const link of document.querySelectorAll("a")) {
        const text = (link.innerText || link.textContent || "").trim();
        const aria = (link.getAttribute("aria-label") || "").trim();
        if (text === "ViewPDF" || text === "View PDF" || /View PDF/i.test(aria)) {
          return link.href || "";
        }
      }
      return "";
    });
    if (viewPdf && isAllowed(viewPdf)) pdfUrl = httpUrl(viewPdf, "resolved PDF URL");
    else if (viewPdf) blocked = viewPdf;
  }
  const found = landing && !(pdfUrl && pdfUrl === landedUrl)
    ? await findDownloadControl(page, landedUrl, isAllowed)
    : { control: null, href: "", blocked: "" };
  blocked = blocked || found.blocked;
  if (!pdfUrl && found.href) pdfUrl = found.href;
  if (!pdfUrl && !found.control) {
    if (blocked) throw crossSiteError(blocked, allowed);
    throw new Error("Could not resolve a PDF URL or Download PDF button from the browser page");
  }

  let finalUrl = "";
  let saved = false;
  if (found.control) {
    const click = await clickForDownload(page, found.control, isAllowed, outputPath);
    saved = click.saved;
    finalUrl = click.url || "";
    if (!saved && !pdfUrl) pdfUrl = click.navigatedTo;
    if (!saved && !pdfUrl) {
      if (click.blocked.length) throw crossSiteError(click.blocked[0], allowed);
      throw new Error("The Download PDF control produced neither a download nor a PDF page");
    }
  }
  if (!saved) {
    const fetched = await fetchPdfBytes(page, pdfUrl, landedUrl);
    fs.writeFileSync(outputPath, fetched.bytes);
    finalUrl = fetched.url;
  }

  const pdf = fs.readFileSync(outputPath);
  if (!isPdf(pdf) || pdf.length > MAX_PDF_BYTES) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(isPdf(pdf) ? `PDF is larger than ${MAX_PDF_BYTES} bytes` : "Browser response is not a PDF");
  }
  const identity = judgeIdentity(mergeExpected(expected, pageIdentity), pdfEvidence(pdf));
  // Leave the publisher page: its scripts have no reason to keep running.
  await page.goto("about:blank").catch(() => {});
  if (identity.status === "mismatch") {
    fs.rmSync(outputPath, { force: true });
    throw new WorkerError(
      "identity_mismatch",
      `the downloaded PDF is not the requested paper: ${identity.reason}. It was discarded and not added to the library. Resolve the paper's landing page again, or ask the user for the right file; do not retry the same link.`,
    );
  }
  return { path: outputPath, bytes: pdf.length, finalUrl, pageIdentity, identity };
}

async function readPageIdentity(page) {
  const raw = await page.evaluate(() => {
    const meta = names => names
      .flatMap(name => [...document.querySelectorAll(`meta[name="${name}" i], meta[property="${name}" i]`)])
      .map(node => (node.getAttribute("content") || "").trim())
      .filter(Boolean);
    const heading = document.querySelector("h1");
    return {
      dois: meta(["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi", "bepress_citation_doi"]),
      titles: meta(["citation_title", "dc.title"]),
      heading: heading ? (heading.innerText || heading.textContent || "") : "",
      documentTitle: document.title || "",
      text: ((document.body && document.body.innerText) || "").slice(0, 5_000),
    };
  });
  const collapse = text => String(text).split(/\s+/).filter(Boolean).join(" ");
  let dois = unique(raw.dois.map(normalizeDoi).filter(Boolean));
  if (dois.length === 0) {
    // No citation meta tags: a single DOI the page labels as such near the top.
    // Several distinct ones (a reference list) say nothing about this paper.
    const labeled = unique(
      [...raw.text.matchAll(/(?:\bdoi\b\s*[:：]?\s*|doi\.org\/)(10\.\d{4,9}\/[^\s"'<>]+)/gi)]
        .map(match => normalizeDoi(match[1]))
        .filter(Boolean),
    );
    if (labeled.length === 1) dois = labeled;
  }
  let titles = unique(raw.titles.map(collapse).filter(Boolean));
  const heading = collapse(raw.heading);
  if (titles.length === 0 && heading.length >= 10 && collapse(raw.documentTitle).includes(heading)) titles = [heading];
  return { dois, titles };
}

function unique(values) {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Identity: a port of tools::literature::judge_pdf_identity and its helpers.
// ---------------------------------------------------------------------------

function normalizeExpected(value) {
  const expected = { dois: [], titles: [], pageTitles: [] };
  if (!value || typeof value !== "object") return expected;
  for (const doi of value.dois || []) {
    const normalized = normalizeDoi(doi);
    if (normalized && !expected.dois.includes(normalized)) expected.dois.push(normalized);
  }
  for (const key of ["titles", "pageTitles"]) {
    for (const title of value[key] || []) pushTitle(expected[key], title);
  }
  return expected;
}

function pushTitle(list, raw) {
  const title = String(raw || "").split(/\s+/).filter(Boolean).join(" ");
  if (title && !list.some(known => known.toLowerCase() === title.toLowerCase())) list.push(title);
}

function mergeExpected(expected, page) {
  const merged = normalizeExpected(expected);
  for (const doi of page.dois) {
    const normalized = normalizeDoi(doi);
    if (normalized && !merged.dois.includes(normalized)) merged.dois.push(normalized);
  }
  for (const title of page.titles) pushTitle(merged.pageTitles, title);
  return merged;
}

function normalizeDoi(raw) {
  let value = String(raw || "").trim().toLowerCase();
  for (const prefix of ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "dx.doi.org/", "doi:", "doi "]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trimStart();
      break;
    }
  }
  value = value.split("%2f").join("/");
  const doi = extractDois(value)[0];
  return doi && value.startsWith(doi) ? doi : null;
}

function extractDois(text) {
  const lower = String(text).toLowerCase();
  const found = [];
  const pattern = /10\.([\d.]+)\/([a-z0-9\-._;()/:+]*)/g;
  let match;
  while ((match = pattern.exec(lower))) {
    const start = match.index;
    if (start > 0 && /\d/.test(lower[start - 1])) {
      pattern.lastIndex = start + 3;
      continue;
    }
    const registrant = match[1].split(".")[0].length;
    if (registrant < 4 || registrant > 9) {
      pattern.lastIndex = start + 3;
      continue;
    }
    const doi = trimDoiTail(match[0]);
    const prefixLength = 3 + match[1].length + 1;
    if (doi.length > prefixLength && !found.includes(doi)) found.push(doi);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return found;
}

function trimDoiTail(doi) {
  for (;;) {
    let trimmed = doi.replace(/[.,;:/]+$/, "");
    if (trimmed.endsWith(")") && (trimmed.match(/\(/g) || []).length < (trimmed.match(/\)/g) || []).length) {
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed.length === doi.length) return doi;
    doi = trimmed;
  }
}

function doiAppearsIn(doi, squeezed) {
  let from = 0;
  for (;;) {
    const at = squeezed.indexOf(doi, from);
    if (at < 0) return false;
    if (!/[0-9]/.test(squeezed[at + doi.length] || "")) return true;
    from = at + 1;
  }
}

const IDENTITY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "via", "using", "based", "toward", "towards",
  "its", "are", "our", "their", "this", "that", "than", "not", "but", "all", "can", "how",
  "what", "why", "when", "does", "between", "under", "over", "through", "about", "among",
  "within", "without",
]);

const IDENTITY_FUNCTION_WORDS = new Set([
  "the", "and", "of", "in", "to", "for", "with", "is", "are", "we", "this", "that", "on", "by",
  "an", "as",
]);

const LATIN_FOLDS = new Map();
for (const [accented, base] of [
  ["àáâãäåāăą", "a"], ["çćĉċč", "c"], ["ďđ", "d"], ["èéêëēĕėęě", "e"], ["ĝğġģ", "g"],
  ["ĥħ", "h"], ["ìíîïĩīĭįı", "i"], ["ĵ", "j"], ["ķ", "k"], ["ĺļľŀł", "l"], ["ñńņň", "n"],
  ["òóôõöøōŏő", "o"], ["ŕŗř", "r"], ["śŝşš", "s"], ["ţťŧ", "t"], ["ùúûüũūŭůűų", "u"],
  ["ŵ", "w"], ["ýÿŷ", "y"], ["źżž", "z"],
]) {
  for (const char of accented) LATIN_FOLDS.set(char, base);
}
const LIGATURES = new Map([["ﬀ", "ff"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"], ["ﬄ", "ffl"], ["ﬅ", "st"], ["ﬆ", "st"]]);
const DROPPED_ACCENTS = /[\u0300-\u036f\u00a8\u00af\u00b4\u00b8\u02c6\u02c7\u02d8-\u02dd]/;
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;
const ALPHABETIC_WORD = /^\p{Alphabetic}+$/u;

function foldForIdentity(text) {
  let out = "";
  for (const char of String(text)) {
    for (const lower of char.toLowerCase()) {
      if (DROPPED_ACCENTS.test(lower)) continue;
      out += LIGATURES.get(lower) || LATIN_FOLDS.get(lower) || lower;
    }
  }
  return out;
}

function isCjk(char) {
  const code = char.codePointAt(0);
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xac00 && code <= 0xd7af);
}

function identityTokens(folded) {
  const tokens = [];
  let word = "";
  let cjk = [];
  const flushCjk = () => {
    if (cjk.length === 1) tokens.push(cjk[0]);
    for (let index = 0; index + 1 < cjk.length; index += 1) tokens.push(cjk[index] + cjk[index + 1]);
    cjk = [];
  };
  for (const char of folded) {
    if (isCjk(char)) {
      if (word) tokens.push(word);
      word = "";
      cjk.push(char);
    } else if (ALPHANUMERIC.test(char)) {
      flushCjk();
      word += char;
    } else {
      if (word) tokens.push(word);
      word = "";
      flushCjk();
    }
  }
  if (word) tokens.push(word);
  flushCjk();
  return tokens;
}

const charCount = text => [...text].length;
const squashText = folded => [...folded].filter(char => ALPHANUMERIC.test(char)).join("");

function significantToken(token) {
  return [...token].some(isCjk) || (charCount(token) >= 3 && !IDENTITY_STOPWORDS.has(token));
}

function identityHaystack(text) {
  const folded = foldForIdentity(text);
  return { tokens: new Set(identityTokens(folded)), squashed: squashText(folded) };
}

function titleOverlap(title, haystack) {
  const folded = foldForIdentity(title);
  const squashed = squashText(folded);
  const cjkChars = [...squashed].filter(isCjk).length;
  const significant = unique(identityTokens(folded).filter(significantToken));
  const present = significant.filter(token => haystack.tokens.has(token)).length;
  return {
    contained: charCount(squashed) >= (cjkChars > 0 ? 6 : 12) && haystack.squashed.includes(squashed),
    significant: significant.length,
    fraction: significant.length ? present / significant.length : 0,
    cjk: cjkChars * 2 > charCount(squashed),
  };
}

const titleConfirms = overlap => overlap.contained || (overlap.significant >= 3 && overlap.fraction >= 0.8);

function textReadable(frontText) {
  const folded = foldForIdentity(frontText);
  const tokens = identityTokens(folded);
  const functionWords = tokens.filter(token => IDENTITY_FUNCTION_WORDS.has(token)).length;
  const words = tokens.filter(token => charCount(token) >= 3 && ALPHABETIC_WORD.test(token)).length;
  const cjk = [...folded].filter(isCjk).length;
  return { latin: functionWords >= 8 && words >= 40, cjk: cjk >= 80 };
}

function judgeIdentity(expected, evidence) {
  const front = [...evidence.frontText].slice(0, FRONT_TEXT_CHARS).join("");
  const foundDois = unique([...evidence.metadataDois.flatMap(extractDois), ...extractDois(front)]);
  const verdict = (status, matchedBy, reason) => ({ status, ...(matchedBy ? { matchedBy } : {}), foundDois, reason });
  if (!expected.dois.length && !expected.titles.length && !expected.pageTitles.length) {
    return verdict("unchecked", null, "no expected DOI or title was given");
  }

  const squeezed = `${front}\n${evidence.metadataDois.join("\n")}\n${evidence.metadataTitles.join("\n")}`
    .toLowerCase()
    .replace(/\s+/g, "");
  const doi = expected.dois.find(candidate => doiAppearsIn(candidate, squeezed));
  if (doi) return verdict("verified", "doi", `the PDF carries DOI ${doi}`);

  const haystack = identityHaystack(`${front}\n${evidence.metadataTitles.join("\n")}`);
  const title = [...expected.titles, ...expected.pageTitles].find(candidate => titleConfirms(titleOverlap(candidate, haystack)));
  if (title) return verdict("verified", "title", `the PDF's first page carries the title “${title}”`);

  if (expected.dois.length && foundDois.length) {
    return verdict(
      "mismatch",
      null,
      `the PDF declares DOI ${foundDois.slice(0, 3).join(", ")} but ${expected.dois.join(" or ")} was expected, and its first page does not carry the expected title`,
    );
  }

  const readable = textReadable(front);
  for (const candidate of expected.titles) {
    const overlap = titleOverlap(candidate, haystack);
    if ((overlap.cjk ? readable.cjk : readable.latin) && overlap.significant >= 3 && overlap.fraction < 0.5) {
      return verdict(
        "mismatch",
        null,
        `the PDF's first page does not carry the expected title “${candidate}” (only ${Math.round(overlap.fraction * 100)}% of its words appear) and has no expected DOI`,
      );
    }
  }
  return verdict(
    "unverified",
    null,
    readable.latin || readable.cjk
      ? "the PDF text neither confirms nor contradicts the expected DOI or title"
      : "the PDF has no readable text or metadata naming the paper",
  );
}

// ---------------------------------------------------------------------------
// PDF evidence: a byte-level scan, no PDF library (none is bundled). It reads
// the information dictionary (also inside object streams), XMP packets and the
// text of the first content streams, inflating FlateDecode streams.
// ---------------------------------------------------------------------------

function readLiteral(source, start) {
  let depth = 0;
  let out = "";
  let index = start;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      const next = source[index];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "b") out += "\b";
      else if (next === "f") out += "\f";
      else if (next >= "0" && next <= "7") {
        let octal = next;
        while (octal.length < 3 && source[index + 1] >= "0" && source[index + 1] <= "7") octal += source[++index];
        out += String.fromCharCode(parseInt(octal, 8) & 0xff);
      } else if (next === "\r") {
        if (source[index + 1] === "\n") index += 1;
      } else if (next !== "\n" && next !== undefined) {
        out += next;
      }
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return [out, index + 1];
    }
    out += char;
  }
  return [out, index];
}

function readHex(source, start) {
  const end = source.indexOf(">", start);
  if (end < 0) return ["", source.length];
  let hex = source.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, "");
  if (hex.length % 2) hex += "0";
  return [Buffer.from(hex, "hex").toString("latin1"), end + 1];
}

/** A PDF text string: UTF-16BE or UTF-8 with a BOM, else PDFDocEncoding (read as Latin-1). */
function decodeTextString(value) {
  if (value.startsWith("\xFE\xFF")) {
    let out = "";
    for (let index = 2; index + 1 < value.length; index += 2) {
      out += String.fromCharCode((value.charCodeAt(index) << 8) | value.charCodeAt(index + 1));
    }
    return out;
  }
  if (value.startsWith("\xEF\xBB\xBF")) return Buffer.from(value.slice(3), "latin1").toString("utf8");
  return value;
}

/**
 * Text of a content stream, with a line break at text moves and a space at
 * wide TJ kerning, mirroring append_page_text in playwright_pdf.rs.
 */
function contentText(source) {
  let out = "";
  let pending = "";
  let inArray = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "(") {
      const [text, next] = readLiteral(source, index);
      pending += text;
      index = next;
    } else if (char === "<") {
      if (source[index + 1] === "<") {
        index += 2;
        continue;
      }
      const [text, next] = readHex(source, index);
      pending += text;
      index = next;
    } else if (char === "[") {
      inArray = true;
      index += 1;
    } else if (char === "]") {
      inArray = false;
      index += 1;
    } else if (char === "%") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
    } else if (char === "/") {
      index += 1;
      while (index < source.length && !/[\s()<>[\]{}/%]/.test(source[index])) index += 1;
    } else if (/[-+.\d]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[.\d]/.test(source[end])) end += 1;
      if (inArray && Number(source.slice(index, end)) < -150) pending += " ";
      index = end;
    } else if (/[A-Za-z*'"]/.test(char)) {
      let end = index + 1;
      if (char !== "'" && char !== '"') {
        while (end < source.length && /[A-Za-z*\d]/.test(source[end])) end += 1;
      }
      const operator = source.slice(index, end);
      index = end;
      if (operator === "Tj" || operator === "TJ") out += pending;
      else if (operator === "'" || operator === '"') out += `\n${pending}`;
      else if (["Td", "TD", "T*", "Tm", "ET"].includes(operator)) out += "\n";
      else if (operator === "ID") {
        const end = source.indexOf("EI", index);
        index = end < 0 ? source.length : end + 2;
      }
      pending = "";
      if (out.length >= FRONT_TEXT_CHARS) break;
    } else {
      index += 1;
    }
  }
  return out;
}

function decodeStream(dict, data, budget) {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  const filters = filter ? filter[1].match(/\/[A-Za-z0-9]+/g) || [] : [];
  if (filters.length === 0) return data;
  if (filters.length !== 1 || (filters[0] !== "/FlateDecode" && filters[0] !== "/Fl")) return null;
  if (budget.remaining <= 0) return null;
  try {
    const out = zlib.inflateSync(data, {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
      maxOutputLength: Math.min(MAX_INFLATED_STREAM_BYTES, budget.remaining),
    });
    budget.remaining -= out.length;
    return out;
  } catch {
    return null;
  }
}

function readObjectStream(dict, text, objects) {
  const count = Number(/\/N\s+(\d+)/.exec(dict)?.[1] || 0);
  const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] || 0);
  const header = text.slice(0, first).trim().split(/\s+/).map(Number);
  for (let index = 0; index < count && 2 * index + 1 < header.length; index += 1) {
    const start = first + header[2 * index + 1];
    const end = 2 * index + 3 < header.length ? first + header[2 * index + 3] : text.length;
    objects.set(`${header[2 * index]} 0`, text.slice(start, end));
  }
}

function xmpTitle(xmp) {
  const match = /<dc:title[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
  if (!match) return "";
  return match[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function pdfEvidence(bytes) {
  const raw = bytes.toString("latin1");
  const objects = new Map();
  const xmp = [];
  const budget = { remaining: MAX_INFLATED_TOTAL_BYTES };
  const outside = [];
  let front = "";
  let cursor = 0;
  let from = 0;
  for (;;) {
    const at = raw.indexOf("stream", from);
    if (at < 0) break;
    from = at + 6;
    if (raw.startsWith("end", at - 3)) continue;
    let start = at + 6;
    if (raw.startsWith("\r\n", start)) start += 2;
    else if (raw[start] === "\n" || raw[start] === "\r") start += 1;
    else continue;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const objAt = raw.lastIndexOf("obj", at);
    const dict = objAt >= 0 && at - objAt < 65_536 && !raw.startsWith("end", objAt - 3) ? raw.slice(objAt + 3, at) : "";
    outside.push(raw.slice(cursor, start));
    cursor = end;
    from = end + 9;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XRef|\/Length[123]\b|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)|\/Type\s*\/EmbeddedFile/.test(dict)) continue;
    const isObjectStream = /\/Type\s*\/ObjStm/.test(dict);
    const isMetadata = /\/Type\s*\/Metadata|\/Subtype\s*\/XML/.test(dict);
    if (!isObjectStream && !isMetadata && front.length >= FRONT_TEXT_CHARS) continue;
    const decoded = decodeStream(dict, bytes.subarray(start, end), budget);
    if (!decoded) continue;
    const text = decoded.toString("latin1");
    if (isObjectStream) {
      readObjectStream(dict, text, objects);
    } else if (isMetadata || /<x:xmpmeta|<rdf:RDF/.test(text.slice(0, 2_048))) {
      xmp.push(decoded.toString("utf8"));
    } else if (/\bBT\b/.test(text)) {
      front += `${contentText(text)}\n`;
    }
  }
  outside.push(raw.slice(cursor));
  const body = outside.join("");
  for (const match of body.matchAll(/(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g)) {
    objects.set(`${match[1]} ${match[2]}`, match[3]);
  }

  const infoRef = [...body.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)].at(-1);
  const infoDict = infoRef && (objects.get(`${infoRef[1]} ${infoRef[2]}`) ?? objects.get(`${infoRef[1]} 0`));
  const infoDicts = infoDict
    ? [infoDict]
    : [...objects.values()].filter(text => /\/(?:Producer|Creator|CreationDate)\b/.test(text) && !/\/Type\s*\//.test(text));
  const metadataDois = [];
  const metadataTitles = [];
  for (const dict of infoDicts) {
    for (const match of dict.matchAll(/\/([A-Za-z0-9_.-]+)\s*(?=\(|<(?!<))/g)) {
      const at = match.index + match[0].length;
      const value = decodeTextString(dict[at] === "(" ? readLiteral(dict, at)[0] : readHex(dict, at)[0]);
      if (match[1] === "Title") metadataTitles.push(value);
      if (value.includes("10.")) metadataDois.push(value);
    }
  }
  for (const packet of xmp) {
    metadataDois.push(...extractDois(packet));
    const title = xmpTitle(packet);
    if (title) metadataTitles.push(title);
  }
  return { metadataDois, metadataTitles, frontText: front };
}

// ---------------------------------------------------------------------------
// Server loop
// ---------------------------------------------------------------------------

async function handle(request) {
  try {
    return await download(request);
  } catch (error) {
    if (!browserGone(error)) throw error;
    // The tab or the browser died under this request: replace it, try once more.
    browser.pageCrashed = true;
    return download(request);
  }
}

async function server() {
  const profileDir = path.resolve(option("--profile-dir"));
  const cdpPort = option("--cdp-port", false);
  fs.mkdirSync(profileDir, { recursive: true });
  const channel = process.platform === "win32" ? "msedge" : "chrome";
  browser.launch = async () => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel,
      acceptDownloads: true,
      // This long-lived worker is initialized with the desktop app so the
      // Playwright MCP preset can attach over CDP. It must not create a visible
      // browser window merely because SomniQ was opened.
      headless: true,
      args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [],
    });
    context.on("close", () => {
      if (browser.context === context) {
        browser.context = null;
        browser.page = null;
      }
    });
    browser.context = context;
    browser.page = adoptPage(context.pages()[0] || null);
  };
  await browser.launch();
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
      process.stdout.write(`${JSON.stringify({ ok: true, result: await handle(request) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: error.code ? error.message : error.stack || error.message || String(error),
        ...(error.code ? { code: error.code } : {}),
      })}\n`);
    }
  }
  await closeContext();
}

if (require.main === module) {
  server().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
} else {
  // Loaded by tests: the pure parts, no browser.
  module.exports = { siteOf, normalizeDoi, extractDois, judgeIdentity, pdfEvidence, mergeExpected, normalizeExpected };
}
