// The matrix's data model: reading untrusted widget data, the user's edits, and coverage.
// Every function is pure: it returns a new model and never mutates the one it was given.

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const SAFE_KEY = (key) => key !== "__proto__" && key !== "constructor" && key !== "prototype";

/** A list of objects that each need `field`; ids made unique, unknown fields kept. */
function entries(raw, field, prefix) {
  const seen = new Set();
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((item, index) => {
    if (!isObject(item) || !text(item[field])) return;
    let id = text(item.id) || `${prefix}${index + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({ ...item, id, [field]: text(item[field]) });
  });
  return out;
}

function optional(target, key, value) {
  if (value === "" || value === null || value === undefined) delete target[key];
  else target[key] = value;
  return target;
}

function cleanCell(raw) {
  if (typeof raw === "string" || typeof raw === "number") return text(raw) ? { value: text(raw) } : null;
  if (!isObject(raw)) return null;
  const cell = { ...raw, value: text(raw.value) };
  optional(cell, "evidence", text(raw.evidence));
  optional(cell, "path", text(raw.path));
  return cell.value || cell.evidence ? cell : null;
}

/** Whatever is stored, as a model this page can draw. Unknown fields survive a save. */
export function clean(value) {
  const source = isObject(value) ? value : {};
  const dimensions = entries(source.dimensions, "name", "d").map((d) => optional({ ...d }, "hint", text(d.hint)));
  const papers = entries(source.papers, "title", "p").map((p) => {
    const year = Number(p.year);
    const paper = optional({ ...p }, "year", p.year !== "" && p.year !== null && Number.isFinite(year) ? Math.trunc(year) : "");
    return optional(paper, "path", text(p.path));
  });
  const cells = {};
  if (isObject(source.cells)) {
    for (const [paperId, row] of Object.entries(source.cells)) {
      if (!SAFE_KEY(paperId) || !isObject(row)) continue;
      const kept = {};
      for (const [dimensionId, raw] of Object.entries(row)) {
        const cell = SAFE_KEY(dimensionId) ? cleanCell(raw) : null;
        if (cell) kept[dimensionId] = cell;
      }
      if (Object.keys(kept).length) cells[paperId] = kept;
    }
  }
  return optional({ ...source, version: 1, dimensions, papers, cells }, "updatedAt", text(source.updatedAt));
}

export const cellOf = (model, paperId, dimensionId) =>
  (Object.hasOwn(model.cells, paperId) && Object.hasOwn(model.cells[paperId], dimensionId) ? model.cells[paperId][dimensionId] : null);

/** "evidenced" (a value and where it comes from), "unsupported" (a value, no evidence) or "empty". */
export function stateOf(cell) {
  if (!cell || !cell.value) return "empty";
  return cell.evidence ? "evidenced" : "unsupported";
}

function newId(name, taken) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "dim";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function addDimension(model, name) {
  const label = text(name).slice(0, 120);
  if (!label) return model;
  const id = newId(label, new Set(model.dimensions.map((d) => d.id)));
  return { ...model, dimensions: [...model.dimensions, { id, name: label }] };
}

/** Rename or set the hint; an empty name keeps the old one, an empty hint removes it. */
export function updateDimension(model, id, patch) {
  return {
    ...model,
    dimensions: model.dimensions.map((d) => {
      if (d.id !== id) return d;
      const next = { ...d };
      if ("name" in patch && text(patch.name)) next.name = text(patch.name).slice(0, 120);
      if ("hint" in patch) optional(next, "hint", text(patch.hint).slice(0, 400));
      return next;
    }),
  };
}

export function moveDimension(model, id, delta) {
  const list = [...model.dimensions];
  const from = list.findIndex((d) => d.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return model;
  [list[from], list[to]] = [list[to], list[from]];
  return { ...model, dimensions: list };
}

/** Removes the dimension and its cells; every other cell stays. */
export function removeDimension(model, id) {
  const cells = {};
  for (const [paperId, row] of Object.entries(model.cells)) {
    const { [id]: _gone, ...rest } = row;
    if (Object.keys(rest).length) cells[paperId] = rest;
  }
  return { ...model, dimensions: model.dimensions.filter((d) => d.id !== id), cells };
}

const CHIP_MAX_LENGTH = 32;
const CHIP_MAX_DISTINCT = 8;

/**
 * Per dimension: how many papers have an evidenced value, how many a value without
 * evidence, whether it is a gap, and, when its evidenced values look like short
 * categorical labels (short and repeating), the distinct labels with their counts.
 */
export function coverage(model) {
  const total = model.papers.length;
  return model.dimensions.map((dimension) => {
    let evidenced = 0;
    let unsupported = 0;
    const counts = new Map();
    for (const paper of model.papers) {
      const cell = cellOf(model, paper.id, dimension.id);
      const state = stateOf(cell);
      if (state === "unsupported") unsupported += 1;
      if (state !== "evidenced") continue;
      evidenced += 1;
      const key = cell.value.toLowerCase();
      const entry = counts.get(key) ?? { label: cell.value, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    const labels = [...counts.values()];
    const categorical = evidenced >= 2 && labels.length <= CHIP_MAX_DISTINCT && labels.length < evidenced
      && labels.every((entry) => entry.label.length <= CHIP_MAX_LENGTH);
    return {
      dimension, evidenced, unsupported, total,
      ratio: total ? evidenced / total : 0,
      gap: total > 0 && evidenced / total < 0.5,
      chips: categorical ? labels.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) : [],
    };
  });
}

/** The value to store: plain JSON with a fresh timestamp. */
export const serialize = (model) => JSON.parse(JSON.stringify({ ...model, updatedAt: new Date().toISOString() }));
