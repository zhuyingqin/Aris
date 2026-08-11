const fs = require("node:fs");
const path = require("node:path");

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function wilson(successes, total, z = 1.96) {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((proportion * (1 - proportion) / total) + ((z * z) / (4 * total * total)));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function binomialCoefficient(n, k) {
  let value = 1;
  for (let index = 1; index <= k; index += 1) value = (value * (n - index + 1)) / index;
  return value;
}

function exactMcNemar(tencentOnly, builtinOnly) {
  const discordant = tencentOnly + builtinOnly;
  if (!discordant) return 1;
  const tail = Math.min(tencentOnly, builtinOnly);
  let probability = 0;
  for (let index = 0; index <= tail; index += 1) {
    probability += binomialCoefficient(discordant, index) * (0.5 ** discordant);
  }
  return Math.min(1, probability * 2);
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function parseTencentHit(content) {
  const match = String(content || "").match(/^\[LongMemEval session_id=(.*?) date=.*?\]\n([\s\S]*)$/);
  return match ? { sessionId: match[1], content: match[2] } : null;
}

function windowedTurnRank(record, l0Items, window = 5) {
  const hasLabels = record.haystack_sessions.some((session) => session.some((turn) => turn.has_answer === true));
  if (!hasLabels) return { available: false, rank: null };
  for (let rank = 0; rank < l0Items.length; rank += 1) {
    const parsed = parseTencentHit(l0Items[rank].content);
    if (!parsed) continue;
    const sessionIndex = record.haystack_session_ids.findIndex((sessionId) => String(sessionId) === parsed.sessionId);
    if (sessionIndex < 0) continue;
    const session = record.haystack_sessions[sessionIndex];
    const candidate = normalize(parsed.content);
    const anchor = session.findIndex((turn) => {
      const turnText = normalize(turn.content);
      return turnText === candidate || turnText.includes(candidate) || candidate.includes(turnText);
    });
    if (anchor < 0) continue;
    const start = Math.max(0, anchor - window);
    const end = Math.min(session.length, anchor + window + 1);
    if (session.slice(start, end).some((turn) => turn.has_answer === true)) return { available: true, rank: rank + 1 };
  }
  return { available: true, rank: null };
}

function paired(rows, selector) {
  const counts = { bothHit: 0, tencentOnly: 0, builtinOnly: 0, neither: 0 };
  for (const row of rows) {
    const [tencent, builtin] = selector(row);
    if (tencent && builtin) counts.bothHit += 1;
    else if (tencent) counts.tencentOnly += 1;
    else if (builtin) counts.builtinOnly += 1;
    else counts.neither += 1;
  }
  return { ...counts, mcnemarExactP: exactMcNemar(counts.tencentOnly, counts.builtinOnly) };
}

function systemSummary(rows, kind) {
  const builtin = kind === "builtin";
  const sessionRanks = rows.map((row) => builtin ? row.builtin?.retrieval?.evidenceSessionRankAt5 : row.retrieval.evidenceSessionRankAt5);
  const turnRows = rows.filter((row) => builtin
    ? row.builtin?.retrieval?.evidenceTurnLabelsAvailable
    : row.retrieval.evidenceTurnLabelsAvailable);
  const turnRanks = turnRows.map((row) => builtin ? row.builtin.retrieval.evidenceTurnRankAt5 : row.retrieval.evidenceTurnRankAt5);
  const latencies = rows.map((row) => Number(builtin ? row.builtin?.retrieval?.latencyMs : row.retrieval.latencyMs)).filter(Number.isFinite);
  const sessionHits = sessionRanks.filter(Boolean).length;
  const turnHits = turnRanks.filter(Boolean).length;
  return {
    count: rows.length,
    session: {
      hits: sessionHits,
      recallAt5: sessionHits / rows.length,
      mrrAt5: average(sessionRanks.map((rank) => rank ? 1 / rank : 0)),
      wilson95: wilson(sessionHits, rows.length),
    },
    turn: {
      labeled: turnRows.length,
      hits: turnHits,
      recallAt5: turnRows.length ? turnHits / turnRows.length : null,
      mrrAt5: average(turnRanks.map((rank) => rank ? 1 / rank : 0)),
      wilson95: wilson(turnHits, turnRows.length),
    },
    latencyMs: {
      mean: average(latencies),
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      max: Math.max(...latencies),
    },
  };
}

function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function milliseconds(value) {
  return value == null ? "n/a" : `${value.toFixed(1)} ms`;
}

function main() {
  const reportPath = path.resolve(process.argv[2] || path.join(
    __dirname,
    "..",
    ".benchmark-results",
    "longmemeval",
    "paired-retrieval-60",
    "report.json",
  ));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.status !== "completed" || !Array.isArray(report.results) || !report.results.length) {
    throw new Error(`Paired report is not complete: ${reportPath}`);
  }
  const dataset = JSON.parse(fs.readFileSync(report.dataset.path, "utf8"));
  const datasetById = new Map(dataset.map((record) => [record.question_id, record]));
  for (const row of report.results) {
    row.windowedTurn = windowedTurnRank(datasetById.get(row.questionId), row.retrieval.l0 || [], 5);
  }

  const types = [...new Set(report.results.map((row) => row.questionType))];
  const tencent = systemSummary(report.results, "tencent");
  const builtin = systemSummary(report.results, "builtin");
  const labeledRows = report.results.filter((row) => row.retrieval.evidenceTurnLabelsAvailable && row.builtin?.retrieval?.evidenceTurnLabelsAvailable);
  const windowedRows = report.results.filter((row) => row.windowedTurn.available);
  const windowedHits = windowedRows.filter((row) => row.windowedTurn.rank).length;
  const perType = Object.fromEntries(types.map((type) => {
    const rows = report.results.filter((row) => row.questionType === type);
    return [type, { tencent: systemSummary(rows, "tencent"), builtin: systemSummary(rows, "builtin") }];
  }));
  const sessionPaired = paired(report.results, (row) => [Boolean(row.retrieval.evidenceSessionRankAt5), Boolean(row.builtin?.retrieval?.evidenceSessionRankAt5)]);
  const turnPaired = paired(labeledRows, (row) => [Boolean(row.retrieval.evidenceTurnRankAt5), Boolean(row.builtin.retrieval.evidenceTurnRankAt5)]);
  const analysis = {
    schemaVersion: 1,
    sourceReport: reportPath,
    sample: { count: report.results.length, seed: report.options.seed, perType: report.results.length / types.length },
    tencent,
    builtin,
    deltas: {
      sessionRecallPercentagePoints: (tencent.session.recallAt5 - builtin.session.recallAt5) * 100,
      turnRecallPercentagePoints: (tencent.turn.recallAt5 - builtin.turn.recallAt5) * 100,
      meanLatencySpeedup: builtin.latencyMs.mean / tencent.latencyMs.mean,
      p95LatencySpeedup: builtin.latencyMs.p95 / tencent.latencyMs.p95,
    },
    paired: { session: sessionPaired, turn: turnPaired },
    tencentWithNeighborWindow: {
      labeled: windowedRows.length,
      hits: windowedHits,
      turnRecallAt5: windowedHits / windowedRows.length,
      mrrAt5: average(windowedRows.map((row) => row.windowedTurn.rank ? 1 / row.windowedTurn.rank : 0)),
    },
    perType,
    rolloutGate: {
      requirement: "TencentDB Top-5 recall must not be lower than builtin session_search",
      passed: tencent.session.recallAt5 >= builtin.session.recallAt5 && tencent.turn.recallAt5 >= builtin.turn.recallAt5,
    },
  };

  const outputDir = path.dirname(reportPath);
  fs.writeFileSync(path.join(outputDir, "paired-analysis.json"), JSON.stringify(analysis, null, 2));
  const csvHeader = [
    "question_id", "question_type", "tencent_session_rank", "builtin_session_rank",
    "tencent_turn_rank", "builtin_turn_rank", "tencent_windowed_turn_rank",
    "tencent_latency_ms", "builtin_latency_ms",
  ];
  const csvRows = report.results.map((row) => [
    row.questionId,
    row.questionType,
    row.retrieval.evidenceSessionRankAt5,
    row.builtin?.retrieval?.evidenceSessionRankAt5,
    row.retrieval.evidenceTurnRankAt5,
    row.builtin?.retrieval?.evidenceTurnRankAt5,
    row.windowedTurn.rank,
    row.retrieval.latencyMs,
    row.builtin?.retrieval?.latencyMs,
  ]);
  fs.writeFileSync(path.join(outputDir, "paired-raw.csv"), [csvHeader, ...csvRows].map((row) => row.map(escapeCsv).join(",")).join("\n") + "\n");

  const typeLines = types.map((type) => {
    const value = perType[type];
    return `| ${type} | ${percent(value.tencent.session.recallAt5)} | ${percent(value.builtin.session.recallAt5)} | ${percent(value.tencent.turn.recallAt5)} | ${percent(value.builtin.turn.recallAt5)} | ${milliseconds(value.tencent.latencyMs.mean)} | ${milliseconds(value.builtin.latencyMs.mean)} |`;
  });
  const markdown = [
    "# LongMemEval 60-question paired analysis",
    "",
    `Source: \`${reportPath}\``,
    "",
    "## Raw comparison",
    "",
    "| Metric | TencentDB | Builtin | Delta |",
    "|---|---:|---:|---:|",
    `| Evidence-session Recall@5 | ${percent(tencent.session.recallAt5)} | ${percent(builtin.session.recallAt5)} | ${analysis.deltas.sessionRecallPercentagePoints.toFixed(1)} pp |`,
    `| Evidence-session MRR@5 | ${tencent.session.mrrAt5.toFixed(3)} | ${builtin.session.mrrAt5.toFixed(3)} | ${(tencent.session.mrrAt5 - builtin.session.mrrAt5).toFixed(3)} |`,
    `| Evidence-turn Recall@5 | ${percent(tencent.turn.recallAt5)} | ${percent(builtin.turn.recallAt5)} | ${analysis.deltas.turnRecallPercentagePoints.toFixed(1)} pp |`,
    `| Evidence-turn MRR@5 | ${tencent.turn.mrrAt5.toFixed(3)} | ${builtin.turn.mrrAt5.toFixed(3)} | ${(tencent.turn.mrrAt5 - builtin.turn.mrrAt5).toFixed(3)} |`,
    `| Recall latency mean | ${milliseconds(tencent.latencyMs.mean)} | ${milliseconds(builtin.latencyMs.mean)} | ${analysis.deltas.meanLatencySpeedup.toFixed(1)}x faster |`,
    `| Recall latency p50 | ${milliseconds(tencent.latencyMs.p50)} | ${milliseconds(builtin.latencyMs.p50)} | — |`,
    `| Recall latency p95 | ${milliseconds(tencent.latencyMs.p95)} | ${milliseconds(builtin.latencyMs.p95)} | ${analysis.deltas.p95LatencySpeedup.toFixed(1)}x faster |`,
    `| Recall latency max | ${milliseconds(tencent.latencyMs.max)} | ${milliseconds(builtin.latencyMs.max)} | — |`,
    "",
    `Tencent session Recall@5 Wilson 95% CI: ${percent(tencent.session.wilson95.lower)}–${percent(tencent.session.wilson95.upper)}; builtin: ${percent(builtin.session.wilson95.lower)}–${percent(builtin.session.wilson95.upper)}.`,
    `Tencent turn Recall@5 Wilson 95% CI: ${percent(tencent.turn.wilson95.lower)}–${percent(tencent.turn.wilson95.upper)}; builtin: ${percent(builtin.turn.wilson95.lower)}–${percent(builtin.turn.wilson95.upper)}.`,
    "",
    "## Paired outcomes",
    "",
    `- Session: both=${sessionPaired.bothHit}, Tencent-only=${sessionPaired.tencentOnly}, builtin-only=${sessionPaired.builtinOnly}, neither=${sessionPaired.neither}, exact McNemar p=${sessionPaired.mcnemarExactP.toFixed(4)}.`,
    `- Turn: both=${turnPaired.bothHit}, Tencent-only=${turnPaired.tencentOnly}, builtin-only=${turnPaired.builtinOnly}, neither=${turnPaired.neither}, exact McNemar p=${turnPaired.mcnemarExactP.toFixed(4)}.`,
    `- If Tencent hits were expanded with the same ±5-message neighbor window as builtin, projected turn Recall@5 is ${percent(analysis.tencentWithNeighborWindow.turnRecallAt5)} (${windowedHits}/${windowedRows.length}).`,
    "",
    "## Per question type",
    "",
    "| Type | Tencent session | Builtin session | Tencent turn | Builtin turn | Tencent latency | Builtin latency |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...typeLines,
    "",
    "## Key findings",
    "",
    `1. Observation: TencentDB is ${analysis.deltas.meanLatencySpeedup.toFixed(1)}x faster on mean latency, but turn Recall@5 is ${Math.abs(analysis.deltas.turnRecallPercentagePoints).toFixed(1)} percentage points lower. Interpretation: raw L0 returns isolated messages while builtin returns a neighbor window. Implication: the rollout quality gate is ${analysis.rolloutGate.passed ? "met" : "not met"}. Next step: add source-session locators and neighbor expansion before replacing builtin session_search.`,
    `2. Observation: preference questions are the weakest TencentDB category (${percent(perType["single-session-preference"].tencent.turn.recallAt5)} turn Recall@5). Interpretation: broad preference questions contain few lexical terms matching the user's prior setup. Implication: keyword-only retrieval is insufficient for personalized guidance. Next step: evaluate L1 persona memories and hybrid embeddings specifically on preference questions.`,
    `3. Observation: TencentDB mean latency is ${milliseconds(tencent.latencyMs.mean)} with p95 ${milliseconds(tencent.latencyMs.p95)}. Interpretation: query latency remains within the 800 ms product target despite a shared 30k-message test DB. Implication: ranking/context quality, not query latency, is the immediate blocker. Next step: preserve latency while adding a bounded neighbor fetch.`,
    "",
    `Rollout gate: **${analysis.rolloutGate.passed ? "PASS" : "FAIL"}** — ${analysis.rolloutGate.requirement}.`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "paired-analysis.md"), markdown);
  process.stdout.write(`${markdown}\nAnalysis written to ${outputDir}\n`);
}

main();
