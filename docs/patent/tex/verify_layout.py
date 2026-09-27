"""Measure CNIPA PDF output; a failed check must make the build fail.

Requires pdfplumber (bundled Codex Python or CNIPA_PYTHON). All coordinates
are read from the PDF. The line-gap measurement uses the font's em box,
not a claim that every Chinese character has the same visible ink height.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from statistics import median

import pdfplumber

MM = 72 / 25.4
DOCUMENTS = {
    "abstract": "说明书摘要",
    "abstract-figure": "摘要附图",
    "claims": "权利要求书",
    "description": "说明书",
    "drawings": "说明书附图",
}
HEADINGS = re.compile(r"^(技术领域|背景技术|发明内容|附图说明|具体实施方式|实施例[一二三四五六七八九十]+[：:].*|[一二三四五六七八九十]+、.*)$")
HANGING_PUNCTUATION = set("，。；、：！？（）【】〔〕“”‘’「」『』…—－-·")


def compact(text):
    return re.sub(r"\s+", "", text)


def text_lines(chars):
    """Group on baselines; font boxes differ slightly for punctuation."""
    groups = []
    for char in sorted(chars, key=lambda c: (round(c["bottom"], 1), c["x0"])):
        if not groups or abs(char["bottom"] - groups[-1][0]["bottom"]) > 1.5:
            groups.append([char])
        else:
            groups[-1].append(char)
    return [sorted(group, key=lambda c: c["x0"]) for group in groups]


def line_text(line):
    return compact("".join(c["text"] for c in line))


def black(color):
    if color is None:
        return True
    if isinstance(color, (int, float)):
        return abs(color) < 0.001
    if len(color) == 4:
        return color[3] >= 0.999  # CMYK black
    return all(abs(v) < 0.001 for v in color)


def inspect_pdf(file, job, expected_title=None):
    errors = []
    metrics = {"pages": 0, "body_font_mm": [], "line_gap_mm": [], "min_bottom_mm": None}

    def require(condition, message):
        if not condition:
            errors.append(message)

    if not file.exists():
        return {"file": str(file), "errors": ["PDF missing"], "metrics": metrics}
    with pdfplumber.open(file) as doc:
        metrics["pages"] = len(doc.pages)
        body_by_page = []
        bottom_margins, font_sizes, line_gaps = [], [], []
        for i, page in enumerate(doc.pages, 1):
            prefix = f"page {i}: "
            require(abs(page.width / MM - 210) < 0.2 and abs(page.height / MM - 297) < 0.2,
                    prefix + "page must be A4 portrait")
            require(page.rotation == 0, prefix + "unexpected page rotation")
            chars = [c for c in page.chars if c["text"].strip()]
            require(bool(chars), prefix + "empty page")
            if not chars:
                continue
            require(all(black(c.get("non_stroking_color")) for c in chars), prefix + "non-black text")
            # The official form places the bold document name and its rule in
            # the top margin. The footer rule and page number occupy the bottom
            # margin. Only application body text is subject to the 25/25/15/15mm
            # text box check.
            header = [c for c in chars if c["top"] < 23.5 * MM]
            require(line_text(sorted(header, key=lambda c: c["x0"])) == DOCUMENTS[job],
                    prefix + "missing or wrong document header")
            require(bool(header) and all("SimHei" in c["fontname"] and abs(c["size"] - 14) < 0.15 for c in header),
                    prefix + "header must match official 14pt Heiti style")
            footer = [c for c in chars if c["top"] > 275 * MM]
            require(line_text(sorted(footer, key=lambda c: c["x0"])) == str(i),
                    prefix + "page number must restart at 1 and be consecutive")
            if footer:
                center = (min(c["x0"] for c in footer) + max(c["x1"] for c in footer)) / 2
                require(abs(center - page.width / 2) < 0.3 * MM, prefix + "page number not centered on paper")
                bottom = (page.height - max(c["bottom"] for c in footer)) / MM
                bottom_margins.append(bottom)
                require(bottom >= 15 - 0.1, prefix + "less than 15mm below page number")

            body = [c for c in chars if 23.5 * MM <= c["top"] <= 274 * MM]
            for c in body:
                # xeCJK hangs a full-width opening/closing punctuation mark at
                # a line edge. That mark may extend about one glyph into the
                # margin while the line's text box remains inside the margin.
                # Allow the documented CJK punctuation overhang, but keep all
                # ordinary glyphs within the body box.
                overhang = c["text"] in HANGING_PUNCTUATION
                horizontal = (c["x0"] < (24.4 if not overhang else 21.5) * MM
                              or c["x1"] > (195.6 if not overhang else 198.5) * MM)
                if horizontal or c["top"] < 24.4 * MM or c["bottom"] > 282.0 * MM:
                    errors.append(prefix + f"body text outside 25/25/15/15mm margins: {c['text']!r}")
                    break
            body_lines = text_lines(body)
            body_by_page.append([line_text(line) for line in body_lines])
            require(bool(body), prefix + "body missing")
            if body_lines:
                require(not HEADINGS.fullmatch(line_text(body_lines[-1])), prefix + "orphan heading")
            if job in ("abstract", "claims", "description"):
                cjk = [c for c in body if re.search(r"[\u4e00-\u9fff]", c["text"])]
                require(bool(cjk), prefix + "Chinese text missing")
                require(all("SimSun" in c["fontname"] and abs(c["size"] - 12) < 0.15 for c in cjk),
                        prefix + "body must be 12pt SimSun")
                font_sizes.extend(c["size"] / MM for c in cjk)
                # Full-width continuous lines belong to flowing prose. Exclude
                # headings and paragraph starts with indentation from this sample.
                prose = []
                for line in body_lines:
                    chinese = [c for c in line if re.search(r"[\u4e00-\u9fff]", c["text"])]
                    candidate = line_text(line)
                    if len(chinese) > 18 and not HEADINGS.fullmatch(candidate):
                        prose.append((line, chinese))
                for (prev, pc), (nxt, nc) in zip(prose, prose[1:]):
                    if min(c["x0"] for c in nxt) < 26 * MM:
                        baseline_delta = median(c["bottom"] for c in nc) - median(c["bottom"] for c in pc)
                        # Adjacent lines only; a skipped heading creates a larger gap.
                        if 0 < baseline_delta < 23:
                            gap = (baseline_delta - median(c["size"] for c in pc)) / MM
                            line_gaps.append(gap)
                            require(2.5 - 0.05 <= gap <= 3.5 + 0.05,
                                    prefix + f"prose line gap outside 2.5-3.5mm: {gap:.3f}mm")
                require(not page.images, prefix + "image in text document")

            # Check vector extents as well as text; white background fills are fine.
            for edge in page.edges:
                half_width = (edge.get("linewidth") or 0) / 2
                # The two full-width horizontal rules are part of the official
                # page frame and intentionally sit in the margins. Other vector
                # artwork must stay inside the body box.
                frame_rule = edge["width"] > 150 * MM and (edge["top"] < 24 * MM or edge["bottom"] > 274 * MM)
                if not frame_rule:
                    require(edge["x0"] - half_width >= 24.7 * MM and edge["x1"] + half_width <= 195.3 * MM
                            and edge["top"] - half_width >= 24.7 * MM and edge["bottom"] + half_width <= 282.3 * MM,
                            prefix + "vector outside page margins")
                require(black(edge.get("stroking_color")), prefix + "non-black drawing line")
            # All used fonts must be embedded, including fonts in nested XObjects.
            def embedded(resources):
                if hasattr(resources, "resolve"):
                    resources = resources.resolve()
                if not isinstance(resources, dict):
                    return True
                fonts = resources.get("Font", {})
                if hasattr(fonts, "resolve"):
                    fonts = fonts.resolve()
                for ref in fonts.values():
                    font = ref.resolve() if hasattr(ref, "resolve") else ref
                    descendants = font.get("DescendantFonts", [font])
                    if hasattr(descendants, "resolve"):
                        descendants = descendants.resolve()
                    for desc in descendants:
                        desc = desc.resolve() if hasattr(desc, "resolve") else desc
                        descriptor = desc.get("FontDescriptor")
                        descriptor = descriptor.resolve() if hasattr(descriptor, "resolve") else descriptor
                        if not descriptor or not any(k in descriptor for k in ("FontFile", "FontFile2", "FontFile3")):
                            return False
                xobjects = resources.get("XObject", {})
                if hasattr(xobjects, "resolve"):
                    xobjects = xobjects.resolve()
                for ref in xobjects.values():
                    obj = ref.resolve() if hasattr(ref, "resolve") else ref
                    if "Resources" in obj and not embedded(obj["Resources"]):
                        return False
                return True
            require(embedded(page.page_obj.resources), prefix + "unembedded font")

        all_body = "".join("".join(lines) for lines in body_by_page)
        if job == "description" and body_by_page and body_by_page[0]:
            first = body_by_page[0][0]
            require(expected_title is not None and first == expected_title,
                    "description first BODY line must equal invention title")
            metrics["first_body_line"] = first
            for heading in ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"]:
                require(heading in all_body, "description section missing: " + heading)
        if job == "abstract":
            metrics["abstract_chars"] = len(all_body)
            require(0 < len(all_body) <= 300, f"abstract length {len(all_body)} exceeds 300 or is empty")
            require(len(doc.pages) == 1, "abstract must fit the template's single page")
            require(not re.search(r"说明书摘要|^发明名称", all_body), "title included in abstract body")
        if job == "drawings":
            for i, lines in enumerate(body_by_page, 1):
                require(lines and lines[-1] == f"图{i}", f"drawing page {i}: caption missing below figure")
        if job == "abstract-figure":
            require(len(doc.pages) == 1 and body_by_page[0][-1] == "图1", "abstract figure must use designated figure 1")
        metrics["body_font_mm"] = sorted({round(v, 3) for v in font_sizes})
        metrics["line_gap_mm"] = sorted({round(v, 3) for v in line_gaps})
        metrics["line_gap_samples"] = len(line_gaps)
        metrics["min_bottom_mm"] = round(min(bottom_margins), 3) if bottom_margins else None
    return {"file": str(file), "errors": list(dict.fromkeys(errors)), "metrics": metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--job", choices=DOCUMENTS)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    source = (root / "description.tex").read_text(encoding="utf-8")
    title = re.search(r"^\\inventiontitle\{([^}]+)\}", source, re.M).group(1)
    jobs = [args.job] if args.job else DOCUMENTS
    results = [inspect_pdf(args.output_dir / (DOCUMENTS[job] + ".pdf"), job, title) for job in jobs]
    report = {"ok": all(not r["errors"] for r in results), "documents": results,
              "scope": "PDF layout only; XML validation and substantive patent review are separate"}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for result in results:
        m = result["metrics"]
        print(f"{'PASS' if not result['errors'] else 'FAIL'} {Path(result['file']).name}: {m['pages']} pages; bottom {m['min_bottom_mm']}mm; font {m['body_font_mm']}mm; gaps {m['line_gap_mm']}mm")
        for error in result["errors"]:
            print("  " + error)
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
