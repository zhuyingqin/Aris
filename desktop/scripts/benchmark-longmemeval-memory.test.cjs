const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evidenceSessionHit,
  evidenceSessionRank,
  evidenceTurnRank,
  flattenMessages,
  normalizeText,
  parseArgs,
  selectRecords,
  takeWithinBudget,
  tokenF1,
} = require("./benchmark-longmemeval-memory.cjs");

function record(id, type) {
  return {
    question_id: id,
    question_type: type,
    haystack_sessions: [[{ role: "user", content: "remember lavender gin fizz", has_answer: true }]],
    haystack_session_ids: [`session-${id}`],
    haystack_dates: ["2024/01/02 (Tue) 03:04"],
    answer_session_ids: [`session-${id}`],
  };
}

test("parseArgs keeps live execution explicit", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.live, false);
  assert.equal(defaults.profile, "l0");
  assert.equal(defaults.allowLayeredCost, false);
  assert.equal(defaults.full, false);
  const live = parseArgs(["--live", "--profile", "layered", "--sample-size", "12"]);
  assert.equal(live.live, true);
  assert.equal(live.profile, "layered");
  assert.equal(live.sampleSize, 12);
  const full = parseArgs(["--full", "--sample-size", "12"]);
  assert.equal(full.full, true);
  assert.equal(full.sampleSize, 500);
});

test("stratified selection is deterministic and covers all six types", () => {
  const types = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "knowledge-update",
    "temporal-reasoning",
  ];
  const records = types.flatMap((type, index) => [record(`${index}-a`, type), record(`${index}-b`, type)]);
  const options = { questionIds: [], sampleSize: 6, seed: "fixed" };
  const first = selectRecords(records, options);
  const second = selectRecords(records, options);
  assert.deepEqual(first.map((item) => item.question_id), second.map((item) => item.question_id));
  assert.deepEqual(new Set(first.map((item) => item.question_type)), new Set(types));
});

test("flattened messages retain evidence session markers and valid timestamps", () => {
  const source = record("abc", "single-session-user");
  const messages = flattenMessages(source);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /^\[LongMemEval session_id=session-abc date=/);
  assert.equal(messages[0].timestamp, "2024-01-02T03:04:00.000Z");
  assert.equal(evidenceSessionHit(source, [{ content: messages[0].content }]), true);
  assert.equal(evidenceSessionRank(source, [{ content: "distractor" }, { content: messages[0].content }]), 2);
  assert.deepEqual(evidenceTurnRank(source, [{ content: "distractor" }, { content: messages[0].content }]), { available: true, rank: 2 });
});

test("memory context never exceeds the configured character budget", () => {
  const context = takeWithinBudget(["a".repeat(3000), "b".repeat(3000), "c"], 6000);
  assert.equal(context.length, 6000);
  assert.equal(context.includes("\n\n"), true);
});

test("normalization and token F1 accept concise answers inside longer responses", () => {
  assert.equal(normalizeText("The Lavender Gin-Fizz!"), "lavender gin fizz");
  assert.equal(tokenF1("lavender gin fizz", "You tried a lavender gin fizz last week") > 0.5, true);
});
