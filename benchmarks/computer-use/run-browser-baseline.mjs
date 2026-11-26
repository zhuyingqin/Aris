// R0 baseline for the browser tasks on the CURRENT pipeline: the headless
// Playwright PDF worker the desktop app ships
// (desktop/src-tauri/resources/literature_playwright_download.cjs) plus the
// same acceptance rule as `download_pdf_at` (tools::literature::
// validate_pdf_file: size cap and a `%PDF` header, nothing else).
//
//   node run-browser-baseline.mjs [--evidence <out.json>]
//
// Variants:
//   attachment-shared   PDFs sent as attachments; one worker, one site (the app's setup)
//   inline-shared       PDFs sent inline (as many publishers and arXiv do)
//   site-restart        like attachment-shared, but the site restarts between
//                       tasks, to show what a dropped page does to the worker

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { startPublisher } from "./fixtures/publisher/server.mjs";
import { judge } from "./judge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const worker = path.join(repo, "desktop", "src-tauri", "resources", "literature_playwright_download.cjs");
const evidenceArg = process.argv.indexOf("--evidence");
const evidencePath = evidenceArg >= 0 ? path.resolve(process.argv[evidenceArg + 1]) : null;
const REQUEST_TIMEOUT_MS = 90_000;

const TASKS = [
  ["C7-OA", "r0-0001"],
  ["C7-LOGIN", "r0-0002"],
  ["C7-MISMATCH", "r0-0003"],
  ["C7-MIRROR", "r0-0005"],
  ["S-INJECT", "r0-0004"],
];

const VARIANTS = [
  { name: "attachment-shared", disposition: "attachment", restartSite: false },
  { name: "inline-shared", disposition: "inline", restartSite: false },
  { name: "site-restart", disposition: "attachment", restartSite: true },
];

const runDir = path.join(os.tmpdir(), "somniq-cu-r0", `browser-${Date.now().toString(36)}`);
fs.mkdirSync(runDir, { recursive: true });

function startWorker(profileDir) {
  const child = spawn(process.execPath, [worker, "--profile-dir", profileDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout });
  const queue = [];
  lines.on("line", line => queue.shift()?.(line));
  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const next = timeoutMs => new Promise((resolve, reject) => {
    queue.push(resolve);
    setTimeout(() => reject(new Error(`no reply within ${timeoutMs} ms`)), timeoutMs);
  });
  return {
    ready: next(60_000).then(line => JSON.parse(line)),
    async request(body) {
      const reply = next(REQUEST_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify(body)}\n`);
      return JSON.parse(await reply);
    },
    stop() {
      child.stdin.write(`${JSON.stringify({ command: "shutdown" })}\n`);
      return Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(() => {
          child.kill();
          resolve();
        }, 10_000)),
      ]);
    },
    kill: () => child.kill(),
    stderr: () => stderr,
  };
}

// tools::literature::validate_pdf_file, mirrored.
const MAX_PDF_BYTES = 80 * 1024 * 1024; // crates/tools/src/literature.rs MAX_PDF_BYTES
function currentAcceptanceRule(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_PDF_BYTES) return { accepted: false, reason: "too large" };
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") return { accepted: false, reason: "not a PDF" };
  return { accepted: true, reason: "header is %PDF" };
}

const logLines = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : []);

const variants = [];
let browserName = "";
for (const variant of VARIANTS) {
  const variantDir = path.join(runDir, variant.name);
  const siteLog = path.join(variantDir, "site-requests.jsonl");
  let current = startWorker(path.join(variantDir, "profile"));
  browserName = (await current.ready).browser;
  let server = await startPublisher({ logPath: siteLog, pdfDisposition: variant.disposition });
  const results = [];
  for (const [index, [taskId, articleId]] of TASKS.entries()) {
    if (variant.restartSite && index > 0) {
      await server.close();
      server = await startPublisher({ logPath: siteLog, pdfDisposition: variant.disposition });
    }
    const taskDir = path.join(variantDir, taskId);
    const library = path.join(taskDir, "library");
    fs.mkdirSync(library, { recursive: true });
    const before = logLines(siteLog).length;
    const download = path.join(taskDir, "download.pdf");
    const started = Date.now();
    let pipeline;
    try {
      const reply = await current.request({ pageUrl: `${server.origin}/article/${articleId}`, output: download });
      if (reply.ok) {
        const rule = currentAcceptanceRule(download);
        if (rule.accepted) fs.renameSync(download, path.join(library, `${articleId}.pdf`));
        pipeline = { worker: "ok", accepted: rule.accepted, reason: rule.reason };
      } else {
        pipeline = { worker: "error", accepted: false, reason: String(reply.error).split(/\r?\n/)[0] };
      }
    } catch (error) {
      // A hung worker would block every later download in the app; here we
      // replace it so the remaining tasks still get measured.
      pipeline = { worker: "timeout", accepted: false, reason: error.message };
      current.kill();
      current = startWorker(path.join(variantDir, `profile-after-${taskId}`));
      await current.ready;
    }
    const elapsedMs = Date.now() - started;
    const taskLog = path.join(taskDir, "requests.jsonl");
    fs.writeFileSync(taskLog, logLines(siteLog).slice(before).map(line => `${line}\n`).join(""));
    const verdict = judge(taskId, { log: taskLog, output: library, claim: pipeline.accepted ? "success" : "failure" });
    results.push({ task: taskId, article: articleId, elapsedMs, pipeline, verdict });
    process.stdout.write(`[${variant.name}] ${taskId}: pipeline=${pipeline.accepted ? "accepted" : "rejected"} (${pipeline.reason}) judge=${verdict.pass ? "PASS" : "FAIL"}${verdict.falseSuccess ? " FALSE-SUCCESS" : ""} ${elapsedMs}ms\n`);
  }
  await server.close();
  await current.stop();
  variants.push({ ...variant, results });
}

const report = {
  kind: "r0-browser-baseline",
  date: new Date().toISOString(),
  pipeline: "desktop/src-tauri/resources/literature_playwright_download.cjs + validate_pdf_file rule",
  browser: browserName,
  headless: true,
  notCovered: {
    "C8-FORM": "The current pipeline has no form or preview capability; only the model-driven Playwright MCP preset could attempt it, and it is not part of this deterministic baseline.",
  },
  variants,
};
if (evidencePath) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`evidence: ${evidencePath}\n`);
}
process.stdout.write(`raw run: ${runDir}\n`);
// Browser helper processes can inherit the worker pipe and keep it open.
process.exit(0);
