// The claim data model: reading the stored widget value tolerantly, grouping
// it for the galley, and joining each claim with the task board's record.
import { marker } from "pkg:claims/copy.mjs";

export const VERDICTS = ["supported", "partial", "unsupported", "no-source"];
/** Task states in which the claim is still being worked on: no second proposal. */
export const BUSY = new Set(["todo", "active", "waiting"]);
const STATES = new Set([...BUSY, "ready", "done", "failed", "canceled"]);

const text = (value) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const iso = (value) => {
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

function cleanClaim(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const sentence = text(entry.text);
  if (!sentence) return null;
  const rawCites = Array.isArray(entry.cites) ? entry.cites : typeof entry.cites === "string" ? entry.cites.split(/[,;\s]+/) : [];
  const line = Number(entry.line);
  return {
    id: text(entry.id) || `#${index + 1}`,
    hasId: Boolean(text(entry.id)),
    text: sentence,
    file: text(entry.file),
    line: Number.isInteger(line) && line > 0 ? line : null,
    section: text(entry.section),
    cites: [...new Set(rawCites.map(text).filter(Boolean))],
    source: text(entry.source),
    taskId: text(entry.taskId),
    verdict: VERDICTS.includes(entry.verdict) ? entry.verdict : null,
    quote: text(entry.quote),
    page: text(entry.page),
    note: text(entry.note),
    checkedAt: iso(entry.checkedAt),
  };
}

/** The stored value, whatever version of the page or the agent wrote it. */
export function readClaims(raw) {
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(doc.claims) ? doc.claims : [];
  const claims = list.map(cleanClaim).filter(Boolean);
  // Two entries with one id would share a task; the later one gets its own id.
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim.id)) { claim.id = `${claim.id}~${seen.size}`; claim.hasId = false; }
    seen.add(claim.id);
  }
  return { manuscript: text(doc.manuscript), extractedAt: iso(doc.extractedAt), claims };
}

export const verdictOf = (claim) => claim.verdict || "unchecked";

export function tally(claims) {
  const counts = { supported: 0, partial: 0, unsupported: 0, "no-source": 0, unchecked: 0 };
  for (const claim of claims) counts[verdictOf(claim)] += 1;
  return counts;
}

/** Claims by file, then by section, in manuscript order. */
export function groupClaims(claims, filter) {
  const files = new Map();
  for (const claim of claims) {
    if (filter !== "all" && verdictOf(claim) !== filter) continue;
    if (!files.has(claim.file)) files.set(claim.file, new Map());
    const sections = files.get(claim.file);
    if (!sections.has(claim.section)) sections.set(claim.section, []);
    sections.get(claim.section).push(claim);
  }
  return [...files].map(([file, sections]) => ({
    file,
    sections: [...sections].map(([section, items]) => ({
      section,
      claims: items.slice().sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity)),
    })),
  }));
}

/**
 * Where a claim's task stands. The board's record wins over anything stored,
 * so a row never reads "investigating" after its task ended.
 *   local: what this page knows in memory ({ taskId?, status? }) for the claim.
 */
export function taskView(claim, board, known, local) {
  const taskId = local?.taskId || claim.taskId;
  if (local?.status === "asking") return { state: "asking" };
  let task = taskId ? board.get(taskId) : undefined;
  // The agent may have rewritten the entry without its taskId: find the task by its title tag.
  if (!task && !taskId) task = [...board.values()].find((record) => typeof record.title === "string" && record.title.includes(marker(claim.id)));
  if (task) return { state: STATES.has(task.state) ? task.state : "unknown", task };
  if (local?.status === "declined") return { state: "declined" };
  if (!taskId) return { state: null };
  return { state: known ? "gone" : "unknown" };
}

/**
 * The stored value with one claim's taskId set, every other byte kept.
 * Null when the claim has no stored id to match on.
 */
export function withTaskId(raw, claimId, taskId) {
  const doc = raw && typeof raw === "object" && !Array.isArray(raw)
    ? JSON.parse(JSON.stringify(raw))
    : { version: 1, claims: Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : [] };
  if (!Array.isArray(doc.claims)) return null;
  const entry = doc.claims.find((item) => item && typeof item === "object" && text(item.id) === claimId);
  if (!entry) return null;
  entry.taskId = taskId;
  if (doc.version == null) doc.version = 1;
  return doc;
}
