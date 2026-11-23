// The "rounds" widget: read it tolerantly, write it back, split pasted review text into comments.
export const STATUSES = ["pending", "answered", "declined"];
export const KINDS = ["major", "minor", "typo"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const lower = (v) => str(v).trim().toLowerCase();

function unique(id, taken, fallback) {
  const base = id || fallback;
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base}-${n}`;
  taken.add(out);
  return out;
}

export function cleanChange(v) {
  if (!isObj(v)) return undefined;
  const out = { ...v, file: str(v.file).trim() };
  const line = Number(v.line);
  if (Number.isInteger(line) && line > 0) out.line = line; else delete out.line;
  if (str(v.summary).trim()) out.summary = str(v.summary); else delete out.summary;
  return out.file || out.summary ? out : undefined;
}

function cleanComment(c, index, taken) {
  const text = str(c.text ?? c.comment);
  const response = str(c.response);
  if (!text.trim() && !response.trim()) return null;
  const status = lower(c.status);
  return {
    ...c,
    id: unique(str(c.id).trim(), taken, `c${index + 1}`),
    reviewer: str(c.reviewer).trim(),
    text,
    kind: KINDS.includes(lower(c.kind)) ? lower(c.kind) : undefined,
    response,
    change: cleanChange(c.change),
    status: STATUSES.includes(status) ? status : response.trim() ? "answered" : "pending",
    justification: str(c.justification) || undefined,
  };
}

/** Whatever is stored (or nothing) -> { version, activeRound, rounds } the page can draw. */
export function clean(raw) {
  const src = isObj(raw) ? raw : { rounds: Array.isArray(raw) ? raw : [] };
  const taken = new Set();
  const rounds = (Array.isArray(src.rounds) ? src.rounds : []).filter(isObj).map((r, i) => {
    const ids = new Set();
    const comments = (Array.isArray(r.comments) ? r.comments : []).filter(isObj)
      .map((c, j) => cleanComment(c, j, ids)).filter(Boolean);
    return { ...r, id: unique(str(r.id).trim(), taken, `round${i + 1}`), name: str(r.name).trim() || `#${i + 1}`, source: str(r.source).trim(), comments };
  });
  const active = str(src.activeRound);
  return { ...src, version: 1, activeRound: rounds.some((r) => r.id === active) ? active : rounds[0]?.id, rounds };
}

const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

/** The model as it is saved: optional fields only when they hold something. */
export function serialize(model, active) {
  return {
    ...prune({ ...model, activeRound: active ?? model.activeRound }),
    version: 1,
    rounds: model.rounds.map((r) => ({
      ...prune({ ...r, source: str(r.source).trim() }),
      name: str(r.name).trim(),
      comments: r.comments.map((c) => ({
        ...prune({ ...c, change: cleanChange(c.change), justification: str(c.justification).trim() ? c.justification : undefined }),
        id: c.id, reviewer: c.reviewer, text: c.text, status: c.status,
      })),
    })),
  };
}

export function counts(round, statusOf = (c) => c.status) {
  const n = { pending: 0, answered: 0, declined: 0, total: round.comments.length };
  for (const c of round.comments) n[statusOf(c)] = (n[statusOf(c)] ?? 0) + 1;
  return n;
}

export const snippet = (text, max = 480) => {
  const flat = str(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function uid(prefix, taken) {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// --- Splitting pasted review text -------------------------------------------------------------
// A section starts at a reviewer header ("Reviewer 2", "Referee #1:", "R3.", "审稿人一：", "Revisor 2").
const WHO = "reviewer|referee|revisora?|evaluadora?|árbitro|审稿专家|审稿人|评审专家|评审人|评审|r(?=\\s*\\d)";
const HEADER = new RegExp(
  `^\\s*(?:#{1,6}\\s*)?[*_]*\\s*(${WHO})\\s*(?:#|no\\.?|nº|n\\.º|№)?\\s*([0-9]{1,2}|[a-z](?![a-z])|[一二三四五六七八九十]{1,2})?` +
  `\\s*(?:'s)?\\s*(?:comments?|report|意见|comentarios)?\\s*[*_]*\\s*(?:[:：.\\-–—]\\s*[*_]*\\s*(.*?))?\\s*$`, "i");
// A numbered point: "1.", "2)", "(3)", "1.2.", "Comment 4:", "Q5.", "第6条". Needs a space (or CJK) after it.
const ITEM = /^\s*[*_]{0,2}(?:(?:comment|point|remark|issue|question|comentario|punto|observaci[oó]n|意见|问题)\s*#?\s*\d{1,3}(?:\.\d{1,2})*\s*[.):：、\-–—]|[qc]\d{1,3}(?:\.\d{1,2})*\s*[.):：、]|\(?\d{1,3}(?:\.\d{1,2})*[.)\]:：、]|[(（]\d{1,3}[)）]|第\s*\d{1,3}\s*[条点个][:：、]?)[*_]{0,2}(?:\s+|(?=[^\x00-\x7F]))/i;
// Short heading lines that set the kind of the points below them.
const KIND_WORDS = [
  ["major", /major|main|主要|重大|mayor|principal/i],
  ["minor", /minor|次要|menor/i],
  ["typo", /typo|typographical|grammar|spelling|笔误|错别字|拼写|语法|errata|tipogr|ortogr/i],
];
const HEADING_NOUN = /comment|issue|concern|point|remark|problem|意见|问题|评论|comentario|observaci|cuesti|aspecto|error|errata|typo|笔误|错别字/i;

function header(line) {
  if (line.length > 160) return null;
  const m = HEADER.exec(line);
  if (!m) return null;
  const word = m[1], num = m[2] ?? "";
  if (word.length === 1 && !num) return null;
  return { label: word.length === 1 ? `${word.toUpperCase()}${num}` : `${word}${num ? ` ${num}` : ""}`, rest: (m[3] ?? "").trim() };
}

function kindOf(line) {
  const s = line.replace(/^[\s#*_>]+|[\s*_:：.]+$/g, "");
  if (!s || s.length > 48 || /[.。!?！？:：,，;；]/.test(s)) return null;
  const ascii = /^[\x00-\x7F]/.test(s);
  if (ascii && s.split(/\s+/).length > 4) return null;
  const head = ascii ? s.split(/\s+/).slice(0, 2).join(" ") : s.slice(0, 4);
  for (const [kind, re] of KIND_WORDS) if (re.test(head) && (HEADING_NOUN.test(s) || s.split(/\s+/).length <= 2)) return kind;
  return null;
}

function splitSection(lines, reviewer, out) {
  const numbered = lines.some((l) => ITEM.test(l));
  let kind, buf = [];
  const flush = () => {
    const text = buf.join("\n").replace(/^\n+|\s+$/g, "");
    if (text.trim()) out.push({ reviewer, text, kind: kind ?? "" });
    buf = [];
  };
  for (const line of lines) {
    const k = kindOf(line);
    if (k) { flush(); kind = k; continue; }
    if (numbered ? ITEM.test(line) : !line.trim()) flush();
    if (line.trim() || numbered) buf.push(numbered ? line.replace(ITEM, "") : line);
  }
  flush();
}

/** Raw review text -> [{ reviewer, text, kind }] for the user to confirm. Nothing leaves the page. */
export function splitReview(text, fallbackReviewer) {
  const lines = str(text).replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let cur = { reviewer: fallbackReviewer, lines: [] };
  for (const line of lines) {
    const h = header(line);
    if (!h) { cur.lines.push(line); continue; }
    if (cur.lines.some((l) => l.trim())) sections.push(cur);
    cur = { reviewer: h.label, lines: h.rest ? [h.rest] : [] };
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  const out = [];
  for (const s of sections) splitSection(s.lines, s.reviewer, out);
  return out.slice(0, 300);
}
