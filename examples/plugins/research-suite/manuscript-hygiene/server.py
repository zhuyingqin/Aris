"""Manuscript hygiene: checks any LaTeX manuscript, standard library only.

SomniQ starts this file as a stdio MCP server (see cordis.patch.yml). Every
line on stdin is one JSON-RPC message and every reply is one line on stdout;
diagnostics go to stderr only. The working directory is the project, and every
path a tool takes must stay inside it.

Tools (each follows \\input and \\include from the file it is given):
  check_citations      cite keys missing from the .bib, entries never cited,
                       entries without author, year or title
  check_terms          the same term written with and without a hyphen,
                       acronyms used before they are defined or defined twice
  check_cross_refs     \\ref to a missing \\label, duplicate and unused labels
  section_word_counts  words (and CJK characters) per section and abstract
  check_manuscript     all of the above, summarised
Every finding carries its file and line.
"""

import json
import os
import re
import sys

SERVER_NAME = "manuscript-hygiene"
SERVER_VERSION = "0.1.0"
MAX_FINDINGS = 200
MAX_FILES = 200

ROOT = os.path.realpath(os.getcwd())


# ---------------------------------------------------------------- files

def project_path(path, default_ext=None):
    if not isinstance(path, str) or not path.strip():
        raise ValueError("path is required")
    candidate = os.path.realpath(os.path.join(ROOT, path))
    if default_ext and not os.path.splitext(candidate)[1] and not os.path.exists(candidate):
        candidate += default_ext
    if os.path.commonpath([ROOT, candidate]) != ROOT:
        raise ValueError(f"{path} is outside the project")
    if not os.path.isfile(candidate):
        raise ValueError(f"{path} does not exist")
    return candidate


def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def read_text(path):
    with open(path, "rb") as handle:
        data = handle.read()
    for encoding in ("utf-8-sig", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


COMMENT = re.compile(r"(?<!\\)%.*$")
INPUT = re.compile(r"\\(?:input|include|subfile)\s*\{([^}]+)\}")


def strip_comment(line):
    return COMMENT.sub("", line)


def load_tex(main):
    """Lines of the manuscript, with \\input/\\include expanded: (file, line, text)."""
    base = os.path.dirname(main)
    lines, seen = [], set()

    def visit(path):
        if path in seen or len(seen) >= MAX_FILES:
            return
        seen.add(path)
        for number, raw in enumerate(read_text(path).splitlines(), 1):
            text = strip_comment(raw)
            lines.append((rel(path), number, text))
            for target in INPUT.findall(text):
                target = target.strip()
                try:
                    child = project_path(os.path.relpath(os.path.join(base, target), ROOT), ".tex")
                except ValueError:
                    continue
                visit(child)

    visit(main)
    return lines


def body_lines(lines):
    """Only what is between \\begin{document} and \\end{document}, when present."""
    start = next((i for i, (_, _, t) in enumerate(lines) if "\\begin{document}" in t), None)
    if start is None:
        return lines
    end = next((i for i, (_, _, t) in enumerate(lines) if "\\end{document}" in t), len(lines))
    return lines[start + 1 : end]


def capped(items):
    return {"count": len(items), "items": items[:MAX_FINDINGS], "truncated": len(items) > MAX_FINDINGS}


# ---------------------------------------------------------------- citations

CITE = re.compile(r"\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}")
BIBLIO = re.compile(r"\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]+)\}")
ENTRY = re.compile(r"@\s*([A-Za-z]+)\s*([{(])\s*([^,\s]+)\s*,")


def bib_files(main, lines, bib):
    if bib:
        names = bib if isinstance(bib, list) else [bib]
        return [project_path(name, ".bib") for name in names]
    base = os.path.dirname(main)
    found = []
    for _, _, text in lines:
        for group in BIBLIO.findall(text):
            for name in group.split(","):
                name = name.strip()
                if not name:
                    continue
                try:
                    found.append(project_path(os.path.relpath(os.path.join(base, name), ROOT), ".bib"))
                except ValueError:
                    pass
    return found


def entry_body(text, start):
    """The text of one entry from its opening brace, by brace depth."""
    depth, i = 0, start
    while i < len(text):
        ch = text[i]
        if ch in "{(":
            depth += 1
        elif ch in "})":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    return text[start:]


def parse_bib(path):
    text = read_text(path)
    entries = {}
    for match in ENTRY.finditer(text):
        kind, key = match.group(1).lower(), match.group(3)
        if kind in ("comment", "string", "preamble"):
            continue
        body = entry_body(text, match.start(2))
        line = text.count("\n", 0, match.start()) + 1
        fields = set(f.lower() for f in re.findall(r"([A-Za-z]+)\s*=", body))
        entries.setdefault(key, {"file": rel(path), "line": line, "type": kind, "fields": fields, "count": 0})
        entries[key]["count"] += 1
    return entries


def check_citations(arguments):
    main = project_path(arguments.get("tex"), ".tex")
    lines = load_tex(main)
    bibs = bib_files(main, lines, arguments.get("bib"))
    entries = {}
    for path in bibs:
        for key, entry in parse_bib(path).items():
            if key in entries:
                entries[key]["count"] += entry["count"]
            else:
                entries[key] = entry
    cited, cite_all = {}, False
    for file, line, text in lines:
        for group in CITE.findall(text):
            for key in (k.strip() for k in group.split(",")):
                if key == "*":
                    cite_all = True
                elif key:
                    cited.setdefault(key, []).append({"file": file, "line": line})
    missing = [{"key": k, "file": v[0]["file"], "line": v[0]["line"], "uses": len(v)} for k, v in cited.items() if k not in entries]
    unused = [] if cite_all else [{"key": k, "file": e["file"], "line": e["line"]} for k, e in entries.items() if k not in cited]
    incomplete = []
    for key, entry in entries.items():
        lacks = []
        if not entry["fields"] & {"author", "editor"}:
            lacks.append("author")
        if not entry["fields"] & {"year", "date"}:
            lacks.append("year")
        if "title" not in entry["fields"]:
            lacks.append("title")
        if lacks:
            incomplete.append({"key": key, "file": entry["file"], "line": entry["line"], "lacks": lacks})
    duplicates = [{"key": k, "file": e["file"], "line": e["line"], "times": e["count"]} for k, e in entries.items() if e["count"] > 1]
    return {
        "manuscript": rel(main),
        "bibFiles": [rel(p) for p in bibs],
        "citedKeys": len(cited),
        "bibEntries": len(entries),
        "missingFromBib": capped(missing),
        "neverCited": capped(unused),
        "incompleteEntries": capped(incomplete),
        "duplicateKeys": capped(duplicates),
        "note": None if bibs else "No .bib file found: pass bib, or add \\bibliography{...} / \\addbibresource{...}.",
    }


# ---------------------------------------------------------------- terms

MATH = re.compile(r"\$[^$]*\$|\\\(.*?\\\)|\\\[.*?\\\]")
COMMAND = re.compile(r"\\[A-Za-z@]+\*?")
ARG_COMMANDS = re.compile(r"\\(?:[A-Za-z]*cite[A-Za-z]*|nocite|ref|eqref|autoref|[cC]ref|pageref|label|url|href|input|include|includegraphics|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|begin|end)\*?\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}")
HYPHENATED = re.compile(r"(?<![\w-])([^\W\d_]{2,})-([^\W\d_]{2,})(?![\w-])")
ACRONYM_DEF = re.compile(r"\(\s*([A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)s?\s*\)")
ACRONYM_USE = re.compile(r"(?<![\w-])([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?(?![\w-])")


def prose(text):
    text = ARG_COMMANDS.sub(" ", text)
    text = MATH.sub(" ", text)
    text = COMMAND.sub(" ", text)
    return text.replace("{", " ").replace("}", " ").replace("~", " ")


def check_terms(arguments):
    main = project_path(arguments.get("tex"), ".tex")
    lines = [(f, n, prose(t)) for f, n, t in body_lines(load_tex(main))]
    flat = "\n".join(t for _, _, t in lines).lower()

    variants = []
    seen = set()
    for file, line, text in lines:
        for left, right in HYPHENATED.findall(text):
            key = (left.lower(), right.lower())
            if key in seen:
                continue
            seen.add(key)
            spaced = len(re.findall(rf"(?<![\w-]){re.escape(key[0])}\s+{re.escape(key[1])}(?![\w-])", flat))
            joined = len(re.findall(rf"(?<![\w-]){re.escape(key[0] + key[1])}(?![\w-])", flat))
            if spaced or joined:
                forms = {f"{left}-{right}": len(re.findall(rf"(?<![\w-]){re.escape(key[0])}-{re.escape(key[1])}(?![\w-])", flat))}
                if spaced:
                    forms[f"{left} {right}"] = spaced
                if joined:
                    forms[f"{left}{right}"] = joined
                variants.append({"forms": forms, "file": file, "line": line})

    defined, first_use = {}, {}
    for file, line, text in lines:
        for acronym in ACRONYM_DEF.findall(text):
            defined.setdefault(acronym, []).append({"file": file, "line": line})
        stripped = ACRONYM_DEF.sub(" ", text)
        for acronym in ACRONYM_USE.findall(stripped):
            first_use.setdefault(acronym, {"file": file, "line": line})
    order = {(f, n): i for i, (f, n, _) in enumerate(lines)}

    def position(place):
        return order.get((place["file"], place["line"]), 0)

    before = [
        {"acronym": a, "firstUse": first_use[a], "definedAt": d[0]}
        for a, d in defined.items()
        if a in first_use and position(first_use[a]) < position(d[0])
    ]
    twice = [{"acronym": a, "definitions": d} for a, d in defined.items() if len(d) > 1]
    undefined = [{"acronym": a, "firstUse": p} for a, p in first_use.items() if a not in defined]
    return {
        "manuscript": rel(main),
        "hyphenVariants": capped(variants),
        "acronymUsedBeforeDefinition": capped(before),
        "acronymDefinedTwice": capped(twice),
        "acronymNeverDefined": capped(undefined),
        "note": "acronymNeverDefined includes widely known acronyms; decide which ones the venue expects to be spelled out.",
    }


# ---------------------------------------------------------------- cross references

LABEL = re.compile(r"\\label\s*\{([^}]+)\}")
REF = re.compile(r"\\(?:ref|eqref|autoref|[cC]ref|[cC]refrange|pageref|nameref|vref)\*?\s*\{([^}]+)\}")


def check_cross_refs(arguments):
    main = project_path(arguments.get("tex"), ".tex")
    lines = load_tex(main)
    labels, refs = {}, {}
    for file, line, text in lines:
        for label in LABEL.findall(text):
            labels.setdefault(label.strip(), []).append({"file": file, "line": line})
        for group in REF.findall(text):
            for key in (k.strip() for k in group.split(",")):
                if key:
                    refs.setdefault(key, []).append({"file": file, "line": line})
    missing = [{"label": k, **v[0], "uses": len(v)} for k, v in refs.items() if k not in labels]
    duplicate = [{"label": k, "places": v} for k, v in labels.items() if len(v) > 1]
    unused = [{"label": k, **v[0]} for k, v in labels.items() if k not in refs]
    return {
        "manuscript": rel(main),
        "labels": len(labels),
        "references": sum(len(v) for v in refs.values()),
        "refWithoutLabel": capped(missing),
        "duplicateLabels": capped(duplicate),
        "unusedLabels": capped(unused),
    }


# ---------------------------------------------------------------- words per section

SECTION = re.compile(r"\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}")
WORD = re.compile(r"[^\W\d_]+(?:['\u2019-][^\W\d_]+)*")
CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")


def count(text):
    text = prose(text)
    cjk = len(CJK.findall(text))
    words = len(WORD.findall(CJK.sub(" ", text)))
    return words, cjk


def section_word_counts(arguments):
    main = project_path(arguments.get("tex"), ".tex")
    lines = body_lines(load_tex(main))
    depth_names = {"part": 0, "chapter": 1, "section": 2, "subsection": 3, "subsubsection": 4}
    sections = [{"title": "(before the first section)", "level": "front", "file": None, "line": None, "words": 0, "cjkChars": 0}]
    in_abstract = False
    abstract = {"title": "Abstract", "level": "abstract", "file": None, "line": None, "words": 0, "cjkChars": 0}
    for file, line, text in lines:
        if "\\begin{abstract}" in text:
            in_abstract = True
            abstract.update(file=file, line=line)
            text = text.split("\\begin{abstract}", 1)[1]
        if in_abstract:
            part = text.split("\\end{abstract}", 1)[0]
            w, c = count(part)
            abstract["words"] += w
            abstract["cjkChars"] += c
            if "\\end{abstract}" in text:
                in_abstract = False
            continue
        match = SECTION.search(text)
        if match:
            sections.append({"title": prose(match.group(2)).strip() or match.group(2), "level": match.group(1), "depth": depth_names[match.group(1)], "file": file, "line": line, "words": 0, "cjkChars": 0})
            text = text[match.end():]
        w, c = count(text)
        sections[-1]["words"] += w
        sections[-1]["cjkChars"] += c
    if sections[0]["words"] == 0 and sections[0]["cjkChars"] == 0:
        sections.pop(0)
    result = ([abstract] if abstract["file"] else []) + sections
    return {
        "manuscript": rel(main),
        "sections": result,
        "totalWords": sum(s["words"] for s in result),
        "totalCjkChars": sum(s["cjkChars"] for s in result),
        "note": "Counts are of prose: commands, citations, labels and inline math are left out; subsections are counted separately from their section.",
    }


# ---------------------------------------------------------------- all together

def check_manuscript(arguments):
    citations = check_citations(arguments)
    terms = check_terms(arguments)
    refs = check_cross_refs(arguments)
    words = section_word_counts(arguments)
    summary = {
        "missingFromBib": citations["missingFromBib"]["count"],
        "neverCited": citations["neverCited"]["count"],
        "incompleteEntries": citations["incompleteEntries"]["count"],
        "hyphenVariants": terms["hyphenVariants"]["count"],
        "acronymUsedBeforeDefinition": terms["acronymUsedBeforeDefinition"]["count"],
        "acronymNeverDefined": terms["acronymNeverDefined"]["count"],
        "refWithoutLabel": refs["refWithoutLabel"]["count"],
        "duplicateLabels": refs["duplicateLabels"]["count"],
        "totalWords": words["totalWords"],
        "totalCjkChars": words["totalCjkChars"],
    }
    return {"manuscript": citations["manuscript"], "summary": summary, "citations": citations, "terms": terms, "crossRefs": refs, "words": words}


TEX_ARG = {"tex": {"type": "string", "description": "Project-relative path of the main .tex file (the extension may be omitted)."}}
SCHEMA = {"type": "object", "properties": TEX_ARG, "required": ["tex"], "additionalProperties": False}
CITE_SCHEMA = {
    "type": "object",
    "properties": {
        **TEX_ARG,
        "bib": {
            "description": "Optional project-relative .bib file or list of files; by default the ones named in \\bibliography or \\addbibresource.",
            "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
        },
    },
    "required": ["tex"],
    "additionalProperties": False,
}

TOOLS = {
    "check_citations": {
        "description": "Check a LaTeX manuscript's citations against its .bib: cite keys missing from the .bib, entries never cited, entries without author, year or title, duplicate keys. Follows \\input and \\include. Every finding has file and line.",
        "inputSchema": CITE_SCHEMA,
        "handler": check_citations,
    },
    "check_terms": {
        "description": "Check a LaTeX manuscript's terminology: a term written both with and without a hyphen, acronyms used before their definition '(ABC)', defined twice, or never defined. Every finding has file and line.",
        "inputSchema": SCHEMA,
        "handler": check_terms,
    },
    "check_cross_refs": {
        "description": "Check a LaTeX manuscript's cross references: \\ref/\\eqref/\\cref to a missing \\label, duplicate labels, labels never referenced.",
        "inputSchema": SCHEMA,
        "handler": check_cross_refs,
    },
    "section_word_counts": {
        "description": "Count the prose words (and CJK characters) of the abstract and of every section of a LaTeX manuscript, leaving out commands, citations and math.",
        "inputSchema": SCHEMA,
        "handler": section_word_counts,
    },
    "check_manuscript": {
        "description": "Run every manuscript check (citations, terms, cross references, words per section) on a LaTeX manuscript and return a summary plus all findings.",
        "inputSchema": CITE_SCHEMA,
        "handler": check_manuscript,
    },
}


# ---------------------------------------------------------------- protocol

def result(request_id, value):
    return {"jsonrpc": "2.0", "id": request_id, "result": value}


def error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle(message):
    request_id = message.get("id")
    if request_id is None:
        return None
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return result(request_id, {
            "protocolVersion": params.get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method == "ping":
        return result(request_id, {})
    if method == "tools/list":
        return result(request_id, {"tools": [
            {"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"]}
            for name, tool in TOOLS.items()
        ]})
    if method == "tools/call":
        name = params.get("name")
        tool = TOOLS.get(name)
        if tool is None:
            return error(request_id, -32602, f"Unknown tool: {name}")
        try:
            value = tool["handler"](params.get("arguments") or {})
        except Exception as exc:
            return result(request_id, {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True})
        text = json.dumps(value, ensure_ascii=False, indent=1, default=sorted)
        return result(request_id, {"content": [{"type": "text", "text": text}], "isError": False})
    return error(request_id, -32601, f"Method not found: {method}")


def main():
    for raw in iter(sys.stdin.buffer.readline, b""):
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"invalid JSON-RPC line: {exc}", file=sys.stderr, flush=True)
            continue
        reply = handle(message)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
