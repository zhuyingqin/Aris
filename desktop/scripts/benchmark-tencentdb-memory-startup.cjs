const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const smokeScript = path.join(__dirname, "smoke-tencentdb-memory-resource.cjs");
const runs = Number.parseInt(process.env.SOMNIQ_MEMORY_STARTUP_RUNS || "5", 10);
const thresholdMs = Number.parseInt(
  process.env.SOMNIQ_MEMORY_STARTUP_P95_MS || "5000",
  10,
);

if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
  throw new Error("SOMNIQ_MEMORY_STARTUP_RUNS must be between 1 and 50");
}

const samples = [];
for (let index = 0; index < runs; index += 1) {
  const result = spawnSync(process.execPath, [smokeScript], {
    cwd: desktopDir,
    encoding: "utf8",
    windowsHide: true,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  const match = /passed .* in (\d+) ms/.exec(result.stdout || "");
  if (!match) {
    throw new Error("Could not parse Memory Core startup latency from smoke output");
  }
  samples.push(Number.parseInt(match[1], 10));
}

const sorted = [...samples].sort((left, right) => left - right);
const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
const p95Ms = sorted[percentileIndex];
process.stdout.write(
  `TencentDB Memory startup samples=${samples.join(",")} p95=${p95Ms} ms threshold=${thresholdMs} ms\n`,
);
if (p95Ms > thresholdMs) {
  process.stderr.write(
    `TencentDB Memory cold-start p95 ${p95Ms} ms exceeds ${thresholdMs} ms\n`,
  );
  process.exitCode = 1;
}
