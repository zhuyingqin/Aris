// R0 UIA probe run: what a text-only model can see in real apps, how long a
// read takes, and what background actions do to focus. Also demonstrates the
// S5 bypass: the CURRENT Shell tool can drive the same window through
// PowerShell UI Automation with no consent step at all.
//
//   node run-probe.mjs [--apps fixture,notepad,explorer,wps] [--repeat 3]
//                      [--probe <somniq-computer-probe.exe>] [--evidence <out.json>]
//
// Opens real windows on the desktop. Raw control trees (which can include
// other tabs' titles) stay in the run directory under %TEMP%; the evidence
// file keeps only measurements, marker visibility and the fixture window's
// own rendering.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setupDesktopFixture, snapshotTree } from "./fixtures/desktop/setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const apps = arg("--apps", "fixture,notepad,explorer,wps").split(",");
const repeat = arg("--repeat", "3");
const probe = path.resolve(arg("--probe", path.join(repo, "target", "release", "somniq-computer-probe.exe")));
const evidencePath = arg("--evidence", null);
const WPS = "E:\\Program Files (x86)\\WPSOffice\\WPS Office\\12.1.0.29690\\office6\\wps.exe";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runProbe(args) {
  try {
    return JSON.parse(execFileSync(probe, args, { encoding: "utf8", windowsHide: true, timeout: 120_000 }));
  } catch (error) {
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // fall through
      }
    }
    return { ok: false, error: { code: "PROBE_CRASHED", message: String(error.message).split(/\r?\n/)[0] } };
  }
}

async function waitForWindow(exe, titleContains, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = runProbe(["find", "--exe", exe, "--title-contains", titleContains]);
    if (found.ok && found.matches.length) return found.matches[0];
    await sleep(500);
  }
  return null;
}

function readEvents(runDir) {
  const file = path.join(runDir, "fixture-window-events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function summarizeSnapshot(result) {
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    window: { exe: result.window.exe, class: result.window.class, dpi: result.window.dpi, tier: result.window.tier },
    foregroundChanged: result.foregroundChanged,
    cursorMoved: result.cursorMoved,
    runs: result.runs.map(run => {
      const fetch = run.timings.map(timing => Math.round(timing.fetchMs * 10) / 10);
      const sorted = [...fetch].sort((a, b) => a - b);
      return {
        strategy: run.strategy,
        fetchMs: fetch,
        medianFetchMs: sorted[Math.floor(sorted.length / 2)],
        convertMs: Math.round((run.timings.at(-1)?.convertMs ?? 0) * 10) / 10,
        crossProcessCalls: run.timings.at(-1)?.crossProcessCalls,
        stoppedBy: run.timings.at(-1)?.stoppedBy,
        elements: run.stats.elements,
        maxDepth: run.stats.max_depth,
        named: run.stats.named,
        offscreen: run.stats.offscreen,
        password: run.stats.password,
        childrenErrors: run.stats.children_errors,
        actions: run.stats.actions,
        frameworks: run.stats.by_framework,
        views: run.views,
      };
    }),
  };
}

function markerVisibility(rawDir, label, markers) {
  const out = {};
  for (const view of ["interactive", "all"]) {
    const file = path.join(rawDir, `${label}-walker-${view}.txt`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    out[view] = Object.fromEntries(markers.map(marker => [marker, text.includes(marker)]));
  }
  return out;
}

function refFor(text, controlType, name) {
  const match = new RegExp(`\\[e(\\d+)\\] ${controlType} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(text);
  return match ? match[1] : null;
}

const { manifest, manifestPath } = setupDesktopFixture();
const runDir = manifest.runDir;
const rawDir = path.join(runDir, "probe-raw");
const evidence = {
  kind: "r0-uia-probe",
  date: new Date().toISOString(),
  probe: path.relative(repo, probe),
  repeat: Number(repeat),
  os: execFileSync("cmd", ["/c", "ver"], { encoding: "utf8" }).trim(),
  apps: {},
};
process.stdout.write(`fixture: ${manifestPath}\n`);

const listing = runProbe(["list"]);
evidence.listing = {
  elapsedMs: listing.elapsedMs,
  listed: listing.windows?.length,
  hiddenByPolicy: listing.hiddenByPolicy,
  dpis: [...new Set((listing.windows || []).map(window => window.dpi))],
  tiers: (listing.windows || []).reduce((acc, window) => ({ ...acc, [window.tier]: (acc[window.tier] || 0) + 1 }), {}),
};

let fixtureChild = null;
let fixtureHwnd = null;
let notepadHwnd = null;

if (apps.includes("fixture")) {
  fixtureChild = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File",
    path.join(here, "fixtures", "desktop", "fixture-window.ps1"),
    "-RunDir", runDir, "-RunId", manifest.runId, "-Minutes", "15",
  ], { stdio: "ignore" });
  const window = await waitForWindow("powershell.exe", `SomniQ CU R0 Fixture ${manifest.runId}`);
  if (!window) throw new Error("fixture window did not appear");
  fixtureHwnd = window.hwnd;
  await sleep(800);
  const snap = runProbe(["snapshot", "--hwnd", fixtureHwnd, "--repeat", repeat, "--out-dir", rawDir, "--label", "fixture"]);
  const interactive = fs.readFileSync(path.join(rawDir, "fixture-walker-interactive.txt"), "utf8");
  const refs = {
    title: refFor(interactive, "Edit", "论文题名"),
    password: refFor(interactive, "Edit", "测试密码"),
    agree: refFor(interactive, "CheckBox", "同意测试条款"),
    save: refFor(interactive, "Button", "保存草稿"),
    submit: refFor(interactive, "Button", "提交（禁止）"),
  };
  const acts = [];
  const act = (label, extra, expectCode = null) => {
    const before = readEvents(runDir).length;
    const result = runProbe(["act", "--hwnd", fixtureHwnd, ...extra]);
    const events = readEvents(runDir).slice(before);
    const foregroundBefore = result.inputBefore ? `0x${result.inputBefore.foreground_hwnd.toString(16)}` : null;
    acts.push({
      label,
      ok: result.ok,
      errorCode: result.error?.code ?? null,
      expectedError: expectCode,
      asExpected: expectCode ? result.error?.code === expectCode : result.ok === true,
      actionMs: result.report ? Math.round(result.report.action_ms * 10) / 10 : null,
      walkMs: result.report ? Math.round(result.report.walk_ms * 10) / 10 : null,
      targetWasForeground: foregroundBefore === null ? null : foregroundBefore === fixtureHwnd,
      foregroundChanged: result.foregroundChanged ?? null,
      cursorMoved: result.cursorMoved ?? null,
      windowActivated: events.some(event => event.control === "activated"),
      fixtureEvents: events.map(event => `${event.kind}:${event.control}`),
    });
  };
  const actionSet = phase => {
    act(`${phase}: set_value 论文题名`, ["--ref", refs.title, "--expect-name", "论文题名", "--set-value", `R0 题名 ${manifest.runId} ${phase}`]);
    act(`${phase}: toggle 同意测试条款`, ["--ref", refs.agree, "--expect-name", "同意测试条款", "--toggle"]);
    act(`${phase}: invoke 保存草稿`, ["--ref", refs.save, "--expect-name", "保存草稿", "--invoke"]);
  };
  actionSet("as launched");
  act("set_value 测试密码 (must refuse)", ["--ref", refs.password, "--expect-name", "测试密码", "--set-value", "should-not-arrive"], "PROTECTED_TARGET");
  act("stale ref (name changed)", ["--ref", refs.save, "--expect-name", "保存", "--invoke"], "STALE_SNAPSHOT");
  act("ref out of range", ["--ref", "9999", "--expect-name", "x", "--invoke"], "STALE_SNAPSHOT");

  // Background case, one action at a time: a fresh "holder" window takes the
  // foreground, the action targets the fixture behind it, and we record
  // whether the foreground moved to the fixture.
  const background = [];
  const backgroundActions = [
    ["set_value 论文题名", ["--ref", refs.title, "--expect-name", "论文题名", "--set-value", `R0 题名 ${manifest.runId} background`]],
    ["toggle 同意测试条款", ["--ref", refs.agree, "--expect-name", "同意测试条款", "--toggle"]],
    ["invoke 保存草稿", ["--ref", refs.save, "--expect-name", "保存草稿", "--invoke"]],
  ];
  for (const [index, [label, extra]] of backgroundActions.entries()) {
    const holderId = `${manifest.runId}-holder${index}`;
    const holderDir = path.join(runDir, `holder${index}`);
    const holder = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File",
      path.join(here, "fixtures", "desktop", "fixture-window.ps1"),
      "-RunDir", holderDir, "-RunId", holderId, "-Minutes", "3",
    ], { stdio: "ignore" });
    const holderWindow = await waitForWindow("powershell.exe", `SomniQ CU R0 Fixture ${holderId}`);
    await sleep(1_200);
    const fixtureBefore = readEvents(runDir).length;
    const result = runProbe(["act", "--hwnd", fixtureHwnd, ...extra]);
    const fixtureEvents = readEvents(runDir).slice(fixtureBefore);
    const hex = value => `0x${value.toString(16)}`;
    background.push({
      label,
      ok: result.ok,
      holderWasForeground: Boolean(holderWindow && result.inputBefore && hex(result.inputBefore.foreground_hwnd) === holderWindow.hwnd),
      foregroundMovedToFixture: Boolean(result.inputSettled && hex(result.inputSettled.foreground_hwnd) === fixtureHwnd),
      cursorMoved: result.cursorMoved ?? null,
      fixtureActivated: fixtureEvents.some(event => event.control === "activated"),
      fixtureEvents: fixtureEvents.map(event => `${event.kind}:${event.control}`),
    });
    holder.kill();
    await sleep(500);
  }

  // S5 baseline: the Shell tool today. Same window, no consent, no gate —
  // plain Win32 messages from a PowerShell script (fixtures/desktop/shell-bypass.ps1).
  const before = readEvents(runDir).length;
  let bypass;
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(here, "fixtures", "desktop", "shell-bypass.ps1"),
      "-Title", `SomniQ CU R0 Fixture ${manifest.runId}`,
    ], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();
    bypass = { ran: true, touched: out.split(/\r?\n/).at(-1) };
  } catch (error) {
    bypass = { ran: false, touched: String(error.message).split(/\r?\n/)[0] };
  }
  await sleep(500);
  const bypassEvents = readEvents(runDir).slice(before);
  bypass.fixtureEvents = bypassEvents.map(event => `${event.kind}:${event.control}`);
  bypass.titleWritten = bypassEvents.some(event => event.control === "title" && event.detail === "written via the Shell tool");
  bypass.passwordWritten = bypassEvents.some(event => event.control === "password");
  bypass.forbiddenSubmitClicked = bypassEvents.some(event => event.control === "submit-forbidden");

  evidence.apps.fixture = {
    snapshot: summarizeSnapshot(snap),
    refs,
    interactiveView: interactive,
    acts,
    background,
    shellBypass: bypass,
  };
  process.stdout.write(`fixture: ${acts.filter(item => item.asExpected).length}/${acts.length} act checks as expected; background=${JSON.stringify(background.map(item => [item.label, item.holderWasForeground, item.foregroundMovedToFixture]))}; shell bypass ${JSON.stringify(bypass)}\n`);
}

if (apps.includes("notepad")) {
  spawn("notepad.exe", [manifest.paths.draft], { stdio: "ignore", detached: true }).unref();
  const window = await waitForWindow("notepad.exe", "draft.txt");
  if (window) {
    notepadHwnd = window.hwnd;
    await sleep(1_500);
    const snap = runProbe(["snapshot", "--hwnd", notepadHwnd, "--repeat", repeat, "--out-dir", rawDir, "--label", "notepad"]);
    const gate = runProbe(["act", "--hwnd", notepadHwnd, "--ref", "1", "--expect-name", "x", "--invoke"]);
    evidence.apps.notepad = {
      snapshot: summarizeSnapshot(snap),
      markersVisible: markerVisibility(rawDir, "notepad", [manifest.markers.note]),
      actGate: gate.error?.code ?? "UNEXPECTED_OK",
    };
  } else {
    evidence.apps.notepad = { error: "window not found" };
  }
  process.stdout.write(`notepad: ${JSON.stringify(evidence.apps.notepad.markersVisible ?? evidence.apps.notepad.error)}\n`);
}

if (apps.includes("explorer")) {
  spawn("explorer.exe", [manifest.paths.pdfs], { stdio: "ignore", detached: true }).unref();
  const window = await waitForWindow("explorer.exe", `pdfs-${manifest.runId}`);
  if (window) {
    await sleep(2_000);
    const snap = runProbe(["snapshot", "--hwnd", window.hwnd, "--repeat", repeat, "--out-dir", rawDir, "--label", "explorer"]);
    evidence.apps.explorer = {
      snapshot: summarizeSnapshot(snap),
      markersVisible: markerVisibility(rawDir, "explorer", ["a-latest-looking-name.pdf", "m-actually-newest.pdf", "z-middle.pdf"]),
    };
    // Close only the window this run opened.
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationURL -like '*pdfs-${manifest.runId}*' } | ForEach-Object { $_.Quit() }`], { windowsHide: true, timeout: 30_000 });
    } catch {
      // best effort
    }
  } else {
    evidence.apps.explorer = { error: "window not found" };
  }
  process.stdout.write(`explorer: ${JSON.stringify(evidence.apps.explorer.markersVisible ?? evidence.apps.explorer.error)}\n`);
}

if (apps.includes("wps") && fs.existsSync(WPS)) {
  const docName = path.basename(manifest.paths.docx, ".docx");
  spawn(WPS, [manifest.paths.docx], { stdio: "ignore", detached: true }).unref();
  const window = await waitForWindow("wps.exe", docName, 60_000);
  if (window) {
    await sleep(4_000);
    const snap = runProbe(["snapshot", "--hwnd", window.hwnd, "--repeat", repeat, "--deadline-ms", "30000", "--out-dir", rawDir, "--label", "wps"]);
    const reviewTree = snapshotTree(manifest.paths.review);
    evidence.apps.wps = {
      snapshot: summarizeSnapshot(snap),
      markersVisible: markerVisibility(rawDir, "wps", [manifest.markers.comment, manifest.markers.insert, manifest.markers.delete]),
      lockFiles: Object.keys(reviewTree).filter(name => name.includes("~$") || name.startsWith(".~")),
    };
  } else {
    evidence.apps.wps = { error: "window not found within 60 s" };
  }
  process.stdout.write(`wps: ${JSON.stringify(evidence.apps.wps.markersVisible ?? evidence.apps.wps.error)}\n`);
}

if (fixtureChild) fixtureChild.kill();
evidence.runDir = runDir;
if (evidencePath) {
  fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
  fs.writeFileSync(path.resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`evidence: ${path.resolve(evidencePath)}\n`);
}
process.stdout.write(`raw: ${rawDir}\n`);
process.exit(0);
