/**
 * A tolerant BibTeX reader, used to offer real citation keys in `\cite{`.
 *
 * Most LaTeX projects don't keep their references in the app's literature
 * library — they have a hand-maintained `.bib` next to the source (the sample
 * theses here carry 20–106 entries each), and without reading it the citation
 * completion has nothing to show. This is deliberately a scanner rather than a
 * grammar: a `.bib` that is malformed halfway through should still contribute
 * the entries before and after the damage.
 */

export interface BibEntry {
  key: string;
  /** `article`, `inproceedings`, … lower-cased. */
  entryType: string;
  title?: string;
  author?: string;
  year?: string;
}

/** Reads the brace-balanced body starting at `{`, ignoring braces in strings. */
function balancedBody(text: string, open: number): { body: string; end: number } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), end: index };
    }
  }
  return null;
}

/** Strips the braces/quotes and TeX accents a field value carries so the
 * completion detail reads as plain text. */
function cleanFieldValue(raw: string): string {
  return raw
    .trim()
    .replace(/^[{"]|[}"]$/g, "")
    // An accent keeps its argument (`Lukoševi\v{c}ius`), so unwrap those before
    // the braces go — stripping braces first would glue the command to the text
    // and swallow the rest of the word.
    .replace(/\\[a-zA-Z]+\s*(?=\{)/g, "")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldsOf(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /(^|,)\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const name = match[2].toLowerCase();
    let cursor = re.lastIndex;
    let value = "";
    if (body[cursor] === "{") {
      const braced = balancedBody(body, cursor);
      if (!braced) break;
      value = braced.body;
      cursor = braced.end + 1;
    } else if (body[cursor] === "\"") {
      let index = cursor + 1;
      while (index < body.length && (body[index] !== "\"" || body[index - 1] === "\\")) index += 1;
      value = body.slice(cursor + 1, index);
      cursor = index + 1;
    } else {
      const end = body.indexOf(",", cursor);
      value = body.slice(cursor, end === -1 ? body.length : end);
      cursor = end === -1 ? body.length : end;
    }
    if (!(name in fields)) fields[name] = cleanFieldValue(value);
    re.lastIndex = cursor;
  }
  return fields;
}

export function parseBibEntries(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([A-Za-z]+)\s*\{\s*([^,\s{}]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const entryType = match[1].toLowerCase();
    // @string/@preamble/@comment carry no citation key.
    if (entryType === "string" || entryType === "preamble" || entryType === "comment") continue;
    const body = balancedBody(text, text.indexOf("{", match.index)) ?? { body: "", end: match.index };
    const fields = fieldsOf(body.body);
    entries.push({
      key: match[2],
      entryType,
      title: fields.title,
      author: fields.author,
      year: fields.year || fields.date?.slice(0, 4),
    });
    if (body.end > re.lastIndex) re.lastIndex = body.end;
  }
  return entries;
}

/** `\bibliography{a,b}`, `\addbibresource{refs.bib}`, `\bibliographystyle` is
 * not a source. Returns raw targets; the caller resolves them against the
 * project the way it resolves `\input`. */
export function bibliographyTargets(source: string): string[] {
  const targets: string[] = [];
  const re = /\\(?:bibliography|addbibresource|addglobalbib)\s*\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    for (const piece of match[1].split(",")) {
      const target = piece.trim();
      if (!target || targets.includes(target)) continue;
      targets.push(target);
    }
  }
  return targets;
}

/** The one-line hint shown next to a key in the completion popup. */
export function bibEntryDetail(entry: BibEntry): string {
  const author = entry.author?.split(/\s+and\s+/)[0]?.split(",")[0]?.trim();
  return [author, entry.year, entry.title].filter(Boolean).join(" · ");
}
