#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const [datasetPath, resultsPath, baselinePath, outputStemArg] = process.argv.slice(2);
if (!datasetPath || !resultsPath) {
  fail("Usage: analyze-longmemeval-builtin <dataset.json> <results.json> [baseline.json] [output-stem]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .replace(/^\[LongMemEval session_id=.*? date=.*?\]\n/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function evidence(record) {
  return record.haystack_sessions
    .flatMap((session) => session)
    .filter((turn) => turn.has_answer === true)
    .map((turn) => normalize(turn.content))
    .filter(Boolean);
}

function rankResult(record, result) {
  const evidenceSessions = new Set(record.answer_session_ids.map(String));
  const turns = evidence(record);
  const sessionIndex = result.hits.findIndex((hit) => evidenceSessions.has(String(hit.sourceSessionId)));
  const turnIndex = turns.length === 0 ? -1 : result.hits.findIndex((hit) =>
    (hit.messages || []).some((message) => {
      const candidate = normalize(message.content);
      return turns.some((answer) => candidate === answer || candidate.includes(answer) || answer.includes(candidate));
    }));
  return {
    sessionRank: sessionIndex >= 0 ? sessionIndex + 1 : null,
    turnAvailable: turns.length > 0,
    turnRank: turnIndex >= 0 ? turnIndex + 1 : null,
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function exactMcNemar(leftOnly, rightOnly) {
  const n = leftOnly + rightOnly;
  if (!n) return 1;
  const tail = Math.min(leftOnly, rightOnly);
  let term = Math.pow(0.5, n);
  let probability = term;
  for (let k = 1; k <= tail; k += 1) {
    term *= (n - k + 1) / k;
    probability += term;
  }
  return Math.min(1, probability * 2);
}

function summarize(rows) {
  const turnRows = rows.filter((row) => row.turnAvailable);
  const sessionHits = rows.filter((row) => row.sessionRank).length;
  const turnHits = turnRows.filter((row) => row.turnRank).length;
  const latencies = rows.map((row) => row.recallLatencyMs);
  return {
    questions: rows.length,
    labeledTurns: turnRows.length,
    sessionRecallAt5: sessionHits / rows.length,
    sessionMrrAt5: mean(rows.map((row) => row.sessionRank ? 1 / row.sessionRank : 0)),
    sessionWilson95: wilson(sessionHits, rows.length),
    turnRecallAt5: turnRows.length ? turnHits / turnRows.length : null,
    turnMrrAt5: mean(turnRows.map((row) => row.turnRank ? 1 / row.turnRank : 0)),
    turnWilson95: wilson(turnHits, turnRows.length),
    latencyMeanMs: mean(latencies),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMaxMs: Math.max(...latencies),
    indexMeanMs: mean(rows.map((row) => row.indexLatencyMs)),
  };
}

function paired(currentRows, baselineRows, field) {
  const baselineById = new Map(baselineRows.map((row) => [row.questionId, row]));
  let both = 0;
  let currentOnly = 0;
  let baselineOnly = 0;
  let neither = 0;
  for (const row of currentRows) {
    const baseline = baselineById.get(row.questionId);
    if (!baseline || (field === "turnRank" && (!row.turnAvailable || !baseline.turnAvailable))) continue;
    const currentHit = Boolean(row[field]);
    const baselineHit = Boolean(baseline[field]);
    if (currentHit && baselineHit) both += 1;
    else if (currentHit) currentOnly += 1;
    else if (baselineHit) baselineOnly += 1;
    else neither += 1;
  }
  return { both, currentOnly, baselineOnly, neither, exactMcNemarP: exactMcNemar(currentOnly, baselineOnly) };
}

const dataset = readJson(datasetPath);
const payload = readJson(resultsPath);
if (payload.schemaVersion !== 1 || !Array.isArray(payload.results)) fail(`Invalid results: ${resultsPath}`);
const recordsById = new Map(dataset.map((record) => [record.question_id, record]));
const buildRows = (source) => source.results.map((result) => {
  const record = recordsById.get(result.questionId);
  if (!record) fail(`Dataset does not contain ${result.questionId}`);
  return {
    questionId: result.questionId,
    questionType: result.questionType,
    ...rankResult(record, result),
    recallLatencyMs: Number(result.recallLatencyMs),
    indexLatencyMs: Number(result.indexLatencyMs),
  };
});

const rows = buildRows(payload);
const baselinePayload = baselinePath ? readJson(baselinePath) : null;
const baselineRows = baselinePayload ? buildRows(baselinePayload) : [];
const questionTypes = [...new Set(rows.map((row) => row.questionType))];
const report = {
  schemaVersion: 1,
  datasetPath: path.resolve(datasetPath),
  resultsPath: path.resolve(resultsPath),
  baselinePath: baselinePath ? path.resolve(baselinePath) : null,
  all: summarize(rows),
  baseline: baselineRows.length ? summarize(baselineRows) : null,
  paired: baselineRows.length ? {
    session: paired(rows, baselineRows, "sessionRank"),
    turn: paired(rows, baselineRows, "turnRank"),
  } : null,
  byType: Object.fromEntries(questionTypes.map((type) => [type, summarize(rows.filter((row) => row.questionType === type))])),
  rows,
};

const percent = (value) => value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const outputStem = outputStemArg || resultsPath.replace(/\.json$/i, "-analysis");
const markdownPath = `${outputStem}.md`;
const jsonPath = `${outputStem}.json`;
const lines = [
  "# LongMemEval builtin analysis",
  "",
  "## Raw comparison",
  "",
  "| Metric | builtin-next | baseline |",
  "|---|---:|---:|",
  `| Session Recall@5 | ${percent(report.all.sessionRecallAt5)} | ${report.baseline ? percent(report.baseline.sessionRecallAt5) : "n/a"} |`,
  `| Session MRR@5 | ${report.all.sessionMrrAt5.toFixed(3)} | ${report.baseline ? report.baseline.sessionMrrAt5.toFixed(3) : "n/a"} |`,
  `| Turn Recall@5 | ${percent(report.all.turnRecallAt5)} | ${report.baseline ? percent(report.baseline.turnRecallAt5) : "n/a"} |`,
  `| Turn MRR@5 | ${report.all.turnMrrAt5.toFixed(3)} | ${report.baseline ? report.baseline.turnMrrAt5.toFixed(3) : "n/a"} |`,
  `| Mean latency | ${report.all.latencyMeanMs.toFixed(1)} ms | ${report.baseline ? `${report.baseline.latencyMeanMs.toFixed(1)} ms` : "n/a"} |`,
  `| p95 latency | ${report.all.latencyP95Ms.toFixed(1)} ms | ${report.baseline ? `${report.baseline.latencyP95Ms.toFixed(1)} ms` : "n/a"} |`,
  "",
  "## By question type",
  "",
  "| Type | Session Recall@5 | Turn Recall@5 | Mean latency |",
  "|---|---:|---:|---:|",
  ...questionTypes.map((type) => {
    const metric = report.byType[type];
    return `| ${type} | ${percent(metric.sessionRecallAt5)} | ${percent(metric.turnRecallAt5)} | ${metric.latencyMeanMs.toFixed(1)} ms |`;
  }),
  "",
];
if (report.paired) {
  lines.push(
    "## Paired outcomes vs baseline",
    "",
    `- Session: both=${report.paired.session.both}, next-only=${report.paired.session.currentOnly}, baseline-only=${report.paired.session.baselineOnly}, neither=${report.paired.session.neither}, exact McNemar p=${report.paired.session.exactMcNemarP.toFixed(4)}.`,
    `- Turn: both=${report.paired.turn.both}, next-only=${report.paired.turn.currentOnly}, baseline-only=${report.paired.turn.baselineOnly}, neither=${report.paired.turn.neither}, exact McNemar p=${report.paired.turn.exactMcNemarP.toFixed(4)}.`,
    "",
  );
}
fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
fs.writeFileSync(markdownPath, `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\nJSON: ${path.resolve(jsonPath)}\nMarkdown: ${path.resolve(markdownPath)}\n`);
