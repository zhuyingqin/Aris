#!/usr/bin/env python3
"""Deterministic slides.json -> editable PPTX builder for /paper-slides.

Why this exists
---------------
Earlier decks were produced by having the model hand-write a fresh
``generate_pptx.py`` with absolute coordinates on every run. Layout quality then
depended entirely on how well that model wrote python-pptx coordinate code:
12pt text crammed into the top-left corner, figures shrunk into a corner, text
drawn over plots, and -- worst -- decks "converted" from Beamer by regex that
leaked ``[0.2cm]`` / ``0.5`` / ``[图表]`` into the slides.

Here the model authors only *content* (``slides.json``: one layout name and its
fields per slide). Geometry, typography, text fitting, figure fitting, native
tables/charts, speaker notes and a lint report are deterministic. Every text box
is measured with the real font metrics before it is placed, so overflow is
detected instead of discovered on the projector.

Usage
-----
    python3 deck_builder.py slides.json -o presentation.pptx \
        [--report deck_report.json] [--notes-md speaker_notes.md] [--check] [--strict]

Exit status: 0 = built with no errors; 1 = errors (overflow, missing asset,
markup residue, schema problems) -- fix ``slides.json`` and rebuild; 2 = bad
invocation / missing dependency.

Schema: see ``../references/deck-schema.md``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.dml.color import RGBColor
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
    from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
    from pptx.oxml.ns import qn
    from pptx.util import Emu, Inches, Pt
except ImportError:  # pragma: no cover - exercised only without the dependency
    sys.stderr.write("python-pptx is required: python3 -m pip install python-pptx pillow\n")
    sys.exit(2)

try:
    from PIL import Image, ImageFont
except ImportError:  # pragma: no cover
    sys.stderr.write("Pillow is required: python3 -m pip install pillow\n")
    sys.exit(2)

from lxml import etree

SCHEMA_VERSION = 1

# --------------------------------------------------------------------------- themes

THEMES: dict[str, dict[str, str]] = {
    # primary: dark structural colour; accent: highlights; accent2: contrast highlight
    "academic": {"primary": "1F3A5F", "accent": "2F6FDE", "accent2": "E07A2E", "text": "1F2937",
                 "muted": "6B7280", "light": "EEF3FB", "line": "D5DDEA", "bg": "FFFFFF"},
    "teal": {"primary": "0F4C5C", "accent": "0E9F8E", "accent2": "E36414", "text": "1F2937",
             "muted": "6B7280", "light": "E8F5F3", "line": "CFE3E0", "bg": "FFFFFF"},
    "crimson": {"primary": "5C1A26", "accent": "C0392B", "accent2": "2F6FDE", "text": "1F2937",
                "muted": "6B7280", "light": "FBEDEC", "line": "EBD3D1", "bg": "FFFFFF"},
    "graphite": {"primary": "222831", "accent": "3A86FF", "accent2": "F59E0B", "text": "1F2937",
                 "muted": "6B7280", "light": "EEF2F7", "line": "D8DEE8", "bg": "FFFFFF"},
    "violet": {"primary": "3B1F6B", "accent": "7C3AED", "accent2": "2563EB", "text": "1F2937",
               "muted": "6B7280", "light": "F3EEFD", "line": "DFD5F5", "bg": "FFFFFF"},
    "forest": {"primary": "1E4D2B", "accent": "059669", "accent2": "0284C7", "text": "1F2937",
               "muted": "6B7280", "light": "EAF6F0", "line": "CFE6D9", "bg": "FFFFFF"},
}
VENUE_THEMES = {"neurips": "violet", "icml": "crimson", "iclr": "forest", "cvpr": "academic",
                "eccv": "academic", "aaai": "academic", "acl": "crimson", "emnlp": "crimson",
                "generic": "academic"}

LAYOUTS = ("title", "section", "hero", "agenda", "bullets", "figure", "figure_text", "two_column",
           "cards", "metrics", "process", "table", "chart", "equation", "statement", "closing")

# --------------------------------------------------------------------------- geometry (inches)

SLIDE_W, SLIDE_H = 13.333, 7.5
ML = 0.7
CW = SLIDE_W - 2 * ML
TITLE_Y, TITLE_H = 0.42, 0.95
CONTENT_TOP = 1.75
CONTENT_BOTTOM = 6.62
SOURCE_Y = 6.68
FOOTER_Y = 7.05
GAP = 0.35

CJK_RE = re.compile(r"[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\uAC00-\uD7AF]")
TOKEN_RE = re.compile(
    r"[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\uAC00-\uD7AF]|\s+|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\uAC00-\uD7AF]+"
)
# PowerPoint will not start a line with these, so the preceding glyph moves down with them.
NO_LINE_START = set("，。、；：！？）》」』】〉,.;:!?)]}%")

# --------------------------------------------------------------------------- font metrics

FONT_FILES = {
    "Microsoft YaHei": (["msyh.ttc", "msyh.ttf"], ["msyhbd.ttc", "msyhbd.ttf"]),
    "PingFang SC": (["PingFang.ttc"], ["PingFang.ttc"]),
    "Noto Sans CJK SC": (["NotoSansCJK-Regular.ttc", "NotoSansCJKsc-Regular.otf"],
                         ["NotoSansCJK-Bold.ttc", "NotoSansCJKsc-Bold.otf"]),
    "Calibri": (["calibri.ttf"], ["calibrib.ttf"]),
    "Segoe UI": (["segoeui.ttf"], ["segoeuib.ttf"]),
    "Arial": (["arial.ttf", "Arial.ttf"], ["arialbd.ttf", "Arial Bold.ttf"]),
}
FONT_DIRS = [
    Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
    Path.home() / "AppData/Local/Microsoft/Windows/Fonts",
    Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"), Path("/Library/Fonts"),
    Path.home() / "Library/Fonts",
    Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
]


def _find_font_file(names: list[str]) -> Path | None:
    for d in FONT_DIRS:
        if not d.is_dir():
            continue
        for n in names:
            p = d / n
            if p.is_file():
                return p
        if str(d).startswith("/usr") or str(d).endswith(".fonts"):
            for n in names:
                hits = list(d.rglob(n))
                if hits:
                    return hits[0]
    return None


class Metrics:
    """Text width / line-height oracle. Falls back to conservative em estimates."""

    REF = 100  # measure at 100 px, scale linearly

    def __init__(self, latin: str, ea: str):
        self._fonts: dict[tuple[str, bool], Any] = {}
        self.latin, self.ea = latin, ea
        self.exact = True
        for name in {latin, ea}:
            for bold in (False, True):
                files = FONT_FILES.get(name)
                path = _find_font_file(files[1 if bold else 0]) if files else None
                if path is None and bold and files:
                    path = _find_font_file(files[0])
                if path is None:
                    self.exact = False
                    self._fonts[(name, bold)] = None
                    continue
                try:
                    self._fonts[(name, bold)] = ImageFont.truetype(str(path), self.REF)
                except OSError:
                    self.exact = False
                    self._fonts[(name, bold)] = None
        f = self._fonts.get((ea, False)) or self._fonts.get((latin, False))
        if f is not None:
            asc, desc = f.getmetrics()
            self.line_em = (asc + desc) / self.REF
        else:
            self.line_em = 1.32
        self.line_em = max(self.line_em, 1.2)

    def width(self, text: str, pt: float, bold: bool = False) -> float:
        """Width of ``text`` in inches at ``pt`` points."""
        total = 0.0
        for chunk_is_cjk, chunk in _script_runs(text):
            font = self._fonts.get((self.ea if chunk_is_cjk else self.latin, bold))
            if font is not None:
                total += font.getlength(chunk) / self.REF * pt
            else:
                em = 1.0 if chunk_is_cjk else (0.6 if bold else 0.56)
                total += len(chunk) * em * pt
        return total / 72.0

    def line_height(self, pt: float, spacing: float) -> float:
        return self.line_em * spacing * pt / 72.0


def _script_runs(text: str):
    if not text:
        return
    cur, buf = None, []
    for ch in text:
        c = bool(CJK_RE.match(ch))
        if cur is None or c == cur:
            buf.append(ch)
        else:
            yield cur, "".join(buf)
            buf = [ch]
        cur = c
    yield cur, "".join(buf)


# --------------------------------------------------------------------------- rich text

def parse_rich(text: str) -> list[tuple[str, bool]]:
    """``**bold**`` segments -> [(text, bold)]. Unpaired markers are kept literally."""
    parts = text.split("**")
    if len(parts) % 2 == 0:  # unpaired
        return [(text, False)]
    return [(p, i % 2 == 1) for i, p in enumerate(parts) if p]


def plain(text: str) -> str:
    return "".join(t for t, _ in parse_rich(text))


def count_lines(m: Metrics, text: str, width: float, pt: float, bold: bool = False,
                safety: float = 0.97) -> int:
    """Greedy wrap that mirrors PowerPoint closely enough (with a safety margin)."""
    width *= safety
    lines = 0
    for hard in plain(text).split("\n"):
        lines += 1
        cur = 0.0
        tokens = TOKEN_RE.findall(hard)
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            w = m.width(tok, pt, bold)
            # keep closing punctuation with the previous glyph
            nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
            if nxt and nxt[0] in NO_LINE_START and len(nxt) == 1:
                w += m.width(nxt, pt, bold)
                i += 1
            if cur + w <= width or cur == 0.0:
                if cur == 0.0 and tok.isspace():
                    i += 1
                    continue
                if w > width and not CJK_RE.match(tok[0]):
                    # very long latin token: hard split
                    for ch in tok:
                        cw = m.width(ch, pt, bold)
                        if cur + cw > width and cur > 0:
                            lines += 1
                            cur = 0.0
                        cur += cw
                else:
                    cur += w
            else:
                lines += 1
                cur = 0.0 if tok.isspace() else w
            i += 1
    return max(lines, 1)


# --------------------------------------------------------------------------- data classes

@dataclass
class Para:
    text: str
    level: int = 0
    bold: bool = False
    bullet: bool = True
    color: str | None = None


@dataclass
class Issue:
    slide: int | None
    severity: str  # error | warning
    code: str
    message: str


@dataclass
class Ctx:
    prs: Any
    theme: dict[str, str]
    m: Metrics
    base_dir: Path
    cache_dir: Path
    lang: str
    issues: list[Issue] = field(default_factory=list)
    slide_no: int = 0
    total: int = 0
    footer: str = ""
    sizes: dict[str, Any] = field(default_factory=dict)
    min_body: int = 16

    def err(self, code: str, msg: str):
        self.issues.append(Issue(self.slide_no, "error", code, msg))

    def warn(self, code: str, msg: str):
        self.issues.append(Issue(self.slide_no, "warning", code, msg))


# --------------------------------------------------------------------------- low-level drawing

def rgb(hexstr: str) -> RGBColor:
    return RGBColor.from_string(hexstr.lstrip("#").upper())


def _set_run_font(ctx: Ctx, run, pt: float, bold: bool, color: str, italic: bool = False):
    f = run.font
    f.size = Pt(pt)
    f.bold = bold
    f.italic = italic
    f.name = ctx.m.latin
    f.color.rgb = rgb(color)
    rPr = run._r.get_or_add_rPr()
    latin = rPr.find(qn("a:latin"))
    for tag in ("a:ea", "a:cs"):
        old = rPr.find(qn(tag))
        if old is not None:
            rPr.remove(old)
    ea = etree.SubElement(rPr, qn("a:ea"))
    ea.set("typeface", ctx.m.ea)
    cs = etree.SubElement(rPr, qn("a:cs"))
    cs.set("typeface", ctx.m.ea)
    # schema order: ... latin, ea, cs ...
    if latin is not None:
        latin.addnext(ea)
        ea.addnext(cs)
    rPr.set("lang", "zh-CN" if ctx.lang == "zh" else "en-US")


def _bullet(p, char: str, color: str, mar_l: float, indent: float):
    pPr = p._p.get_or_add_pPr()
    pPr.set("marL", str(int(Inches(mar_l))))
    pPr.set("indent", str(-int(Inches(indent))))
    for tag in ("a:buClr", "a:buSzPct", "a:buFont", "a:buChar", "a:buNone"):
        old = pPr.find(qn(tag))
        if old is not None:
            pPr.remove(old)
    buClr = etree.SubElement(pPr, qn("a:buClr"))
    etree.SubElement(buClr, qn("a:srgbClr")).set("val", color)
    etree.SubElement(pPr, qn("a:buSzPct")).set("val", "100000")
    etree.SubElement(pPr, qn("a:buFont")).set("typeface", "Arial")
    etree.SubElement(pPr, qn("a:buChar")).set("char", char)


def _no_bullet(p):
    pPr = p._p.get_or_add_pPr()
    if pPr.find(qn("a:buNone")) is None:
        etree.SubElement(pPr, qn("a:buNone"))


def textbox(ctx: Ctx, slide, x, y, w, h, paras: list[Para], pt: float, *, color=None,
            align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.08, space_before=0.45,
            sub_delta=4, bold_color=None, name=None):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        tb.name = name
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    color = color or ctx.theme["text"]
    bold_color = bold_color or ctx.theme["accent"]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        size = pt if para.level == 0 else max(pt - sub_delta, 10)
        p.line_spacing = spacing
        if i > 0:
            p.space_before = Pt(size * space_before)
        if para.bullet:
            if para.level == 0:
                _bullet(p, "•", ctx.theme["accent"], size * 1.05 / 72, size * 1.05 / 72)
            else:
                _bullet(p, "–", ctx.theme["muted"], size * 1.05 / 72 + pt * 1.2 / 72, size * 0.95 / 72)
        else:
            _no_bullet(p)
        for seg, b in parse_rich(para.text):
            r = p.add_run()
            r.text = seg
            is_bold = b or para.bold
            c = para.color or (bold_color if b else (ctx.theme["muted"] if para.level else color))
            _set_run_font(ctx, r, size, is_bold, c)
    return tb


def paras_height(ctx: Ctx, paras: list[Para], width: float, pt: float, spacing=1.08,
                 space_before=0.45, sub_delta=4) -> float:
    total = 0.0
    for i, para in enumerate(paras):
        size = pt if para.level == 0 else max(pt - sub_delta, 10)
        indent = 0.0
        if para.bullet:
            indent = size * 1.05 / 72 + (pt * 1.2 / 72 if para.level else 0)
        n = count_lines(ctx.m, para.text, width - indent, size, para.bold)
        total += n * ctx.m.line_height(size, spacing)
        if i > 0:
            total += size * space_before / 72
    return total


def fit(ctx: Ctx, paras: list[Para], width: float, height: float, max_pt: int, min_pt: int,
        what: str, **kw) -> tuple[int, float, bool]:
    for pt in range(max_pt, min_pt - 1, -1):
        h = paras_height(ctx, paras, width, pt, **kw)
        if h <= height:
            return pt, h, True
    h = paras_height(ctx, paras, width, min_pt, **kw)
    ctx.err("text_overflow",
            f"{what}: needs {h:.2f}in at the minimum {min_pt}pt but only {height:.2f}in is available. "
            "Shorten the text, move detail to notes, or split the slide.")
    return min_pt, h, False


def rect(slide, x, y, w, h, fill: str | None, line: str | None = None, shape=MSO_SHAPE.RECTANGLE,
         radius: float | None = None, line_w: float = 1.0):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if fill:
        s.fill.solid()
        s.fill.fore_color.rgb = rgb(fill)
    else:
        s.fill.background()
    if line:
        s.line.color.rgb = rgb(line)
        s.line.width = Pt(line_w)
    else:
        s.line.fill.background()
    s.shadow.inherit = False
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = radius
    if s.has_text_frame:
        s.text_frame.text = ""
    return s


def shape_label(ctx: Ctx, shp, text: str, pt: float, color: str, bold=True):
    tf = shp.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.word_wrap = False
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = text
    _set_run_font(ctx, r, pt, bold, color)


def line(slide, x1, y1, x2, y2, color: str, width_pt: float = 1.5):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = rgb(color)
    c.line.width = Pt(width_pt)
    return c


# --------------------------------------------------------------------------- shared chrome

def as_paras(items: Any, ctx: Ctx, where: str) -> list[Para]:
    out: list[Para] = []
    if items is None:
        return out
    if isinstance(items, str):
        items = [items]
    if not isinstance(items, list):
        ctx.err("schema", f"{where}: expected a list of bullets")
        return out
    for it in items:
        if isinstance(it, str):
            out.append(Para(it))
        elif isinstance(it, dict):
            t = it.get("text") or it.get("title") or ""
            out.append(Para(str(t), bold=bool(it.get("bold"))))
            for s in it.get("sub") or it.get("children") or []:
                out.append(Para(str(s if isinstance(s, str) else s.get("text", "")), level=1))
        else:
            ctx.err("schema", f"{where}: bullet must be a string or object")
    return out


def draw_title(ctx: Ctx, slide, title: str) -> float:
    """Draw title + accent rule. Returns the y where content may start."""
    if not title:
        ctx.err("missing_title", "content slide has no title")
        return CONTENT_TOP
    paras = [Para(title, bullet=False, bold=True)]
    pt, h, _ = fit(ctx, paras, CW, TITLE_H, 32, 22, "title")
    textbox(ctx, slide, ML, TITLE_Y, CW, TITLE_H, paras, pt, color=ctx.theme["primary"],
            anchor=MSO_ANCHOR.BOTTOM, spacing=1.0, bold_color=ctx.theme["accent"], name="Title")
    rect(slide, ML, TITLE_Y + TITLE_H + 0.1, 0.9, 0.06, ctx.theme["accent"])
    ctx.sizes["title_pt"] = pt
    return CONTENT_TOP


def draw_footer(ctx: Ctx, slide, s: dict):
    if s.get("source"):
        src = str(s["source"])
        paras = [Para(src, bullet=False)]
        pt, _, ok = fit(ctx, paras, CW, 0.3, 12, 10, "source line")
        textbox(ctx, slide, ML, SOURCE_Y, CW, 0.3, paras, pt, color=ctx.theme["muted"], name="Source")
    if ctx.footer:
        textbox(ctx, slide, ML, FOOTER_Y, CW * 0.7, 0.28, [Para(ctx.footer, bullet=False)], 11,
                color=ctx.theme["muted"], name="Footer")
    textbox(ctx, slide, SLIDE_W - ML - 1.5, FOOTER_Y, 1.5, 0.28,
            [Para(f"{ctx.slide_no} / {ctx.total}", bullet=False)], 11, color=ctx.theme["muted"],
            align=PP_ALIGN.RIGHT, name="PageNumber")


def draw_lead_and_takeaway(ctx: Ctx, slide, s: dict, top: float) -> tuple[float, float]:
    """Optional lead sentence under the title and takeaway band above the footer.
    Returns the remaining (top, bottom) content band."""
    bottom = CONTENT_BOTTOM - (0.12 if s.get("source") else 0.0)
    if s.get("lead"):
        paras = [Para(str(s["lead"]), bullet=False)]
        pt, h, _ = fit(ctx, paras, CW, 0.95, 22, 16, "lead")
        textbox(ctx, slide, ML, top, CW, h + 0.05, paras, pt, color=ctx.theme["primary"], name="Lead")
        top += h + 0.3
    if s.get("takeaway"):
        paras = [Para(str(s["takeaway"]), bullet=False, bold=True)]
        inner = CW - 0.9
        pt, h, _ = fit(ctx, paras, inner, 0.95, 22, 16, "takeaway")
        band_h = h + 0.36
        y = bottom - band_h
        rect(slide, ML, y, CW, band_h, ctx.theme["light"])
        rect(slide, ML, y, 0.09, band_h, ctx.theme["accent"])
        textbox(ctx, slide, ML + 0.45, y + 0.18, inner, h + 0.02, paras, pt,
                color=ctx.theme["primary"], anchor=MSO_ANCHOR.MIDDLE, name="Takeaway")
        bottom = y - 0.28
    return top, bottom


def body_block(ctx: Ctx, slide, paras: list[Para], x, y, w, h, *, max_pt=28, min_pt=None,
               what="bullets", anchor=MSO_ANCHOR.MIDDLE):
    min_pt = min_pt or ctx.min_body
    if not paras:
        return None
    pt, used, _ = fit(ctx, paras, w, h, max_pt, min_pt, what)
    ctx.sizes.setdefault("body_pt", []).append(pt)
    if pt < 18:
        ctx.warn("small_text", f"{what} fitted at {pt}pt; projection reads best at >= 18pt -- trim text or split")
    if anchor == MSO_ANCHOR.MIDDLE:
        # visually centre the block, slightly above the optical middle
        y = y + max(0.0, (h - used) * 0.42)
        h = min(h, used + 0.1)
    return textbox(ctx, slide, x, y, w, h, paras, pt, anchor=MSO_ANCHOR.TOP, name=what)


# --------------------------------------------------------------------------- images

RASTER_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}
SVG_BLIP_EXT_URI = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
SVG_NS = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"
RT_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def resolve_image(ctx: Ctx, ref: str, what: str) -> Path | None:
    p = Path(ref)
    if not p.is_absolute():
        p = ctx.base_dir / p
    if not p.is_file():
        ctx.err("missing_asset", f"{what}: image not found: {ref}")
        return None
    if p.suffix.lower() not in RASTER_EXTS | {".svg"}:
        ctx.err("unsupported_image",
                f"{what}: {p.suffix} cannot be embedded in PPTX; use PNG/JPG or SVG "
                "(PDF figure: `pdftoppm -png -r 220 in.pdf out` or PyMuPDF page.get_pixmap(dpi=220))")
        return None
    return p


def svg_fallback(ctx: Ctx, svg: Path, what: str) -> tuple[Path, float, float] | None:
    """Rasterize an SVG for renderers without SVG support. Returns (png, width_pt, height_pt).
    PowerPoint 2016+ draws the vector original; the PNG is only the compatibility layer."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        ctx.err("svg_renderer", f"{what}: embedding SVG needs PyMuPDF for the PNG fallback "
                                "(python3 -m pip install pymupdf)")
        return None
    data = svg.read_bytes()
    key = hashlib.sha1(data).hexdigest()[:16]
    out = ctx.cache_dir / f"svg-{key}.png"
    try:
        doc = fitz.open(str(svg))
        page = doc[0]
        wpt, hpt = page.rect.width, page.rect.height
        if not out.is_file():
            ctx.cache_dir.mkdir(parents=True, exist_ok=True)
            zoom = min(8.0, max(1.0, 2400 / max(wpt, hpt)))
            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=True).save(str(out))
        doc.close()
    except Exception as e:  # malformed SVG
        ctx.err("svg_parse", f"{what}: {svg.name} could not be parsed as SVG ({e})")
        return None
    if wpt <= 0 or hpt <= 0:
        ctx.err("svg_parse", f"{what}: {svg.name} has no usable width/height/viewBox")
        return None
    return out, wpt, hpt


def embed_svg(slide, pic, svg: Path):
    """Attach the SVG as the picture's primary image (Office 2016 svgBlip extension)."""
    from pptx.opc.package import Part
    from pptx.opc.packuri import PackURI

    package = slide.part.package
    existing = {str(p.partname) for p in package.iter_parts()}
    n = 1
    while f"/ppt/media/image-svg{n}.svg" in existing:
        n += 1
    part = Part(PackURI(f"/ppt/media/image-svg{n}.svg"), "image/svg+xml", package, svg.read_bytes())
    rid = slide.part.relate_to(part, RT_IMAGE)
    blip = pic._element.find(".//" + qn("a:blip"))
    ext_lst = blip.find(qn("a:extLst"))
    if ext_lst is None:
        ext_lst = etree.SubElement(blip, qn("a:extLst"))
    ext = etree.SubElement(ext_lst, qn("a:ext"))
    ext.set("uri", SVG_BLIP_EXT_URI)
    svg_blip = etree.SubElement(ext, "{%s}svgBlip" % SVG_NS, nsmap={"asvg": SVG_NS})
    svg_blip.set(qn("r:embed"), rid)


def ai_badge(ctx: Ctx, slide, x, y, w, h, dark: bool):
    label = "AI 生成示意图" if ctx.lang == "zh" else "AI-generated illustration"
    tw = ctx.m.width(label, 10) + 0.24
    bx, by = x + w - tw - 0.1, y + h - 0.32
    b = rect(slide, bx, by, tw, 0.24, "000000" if dark else "FFFFFF", shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.3)
    set_alpha(b, 0.45 if dark else 0.75)
    shape_label(ctx, b, label, 10, "FFFFFF" if dark else ctx.theme["muted"], bold=False)


def place_image(ctx: Ctx, slide, ref: str, x, y, w, h, crop: dict | None = None, what="figure",
                align="center", fit="contain", ai_generated=False, dark_badge=True):
    """Place an image in a box. ``contain`` keeps the whole image (letterboxed);
    ``cover`` fills the box exactly and crops the overflow evenly (heroes, cards)."""
    p = resolve_image(ctx, ref, what)
    if p is None:
        rect(slide, x, y, w, h, ctx.theme["light"], ctx.theme["line"])
        return None
    is_svg = p.suffix.lower() == ".svg"
    if is_svg:
        fb = svg_fallback(ctx, p, what)
        if fb is None:
            rect(slide, x, y, w, h, ctx.theme["light"], ctx.theme["line"])
            return None
        raster, pw, ph = fb
    else:
        raster = p
        with Image.open(p) as im:
            pw, ph = im.size
    crop = crop or {}
    cl, ct = float(crop.get("left", 0)), float(crop.get("top", 0))
    cr, cb = float(crop.get("right", 0)), float(crop.get("bottom", 0))
    if min(cl, ct, cr, cb) < 0 or cl + cr >= 1 or ct + cb >= 1:
        ctx.err("schema", f"{what}: crop fractions must be in [0,1) and leave a visible area")
        cl = ct = cr = cb = 0.0
    vw, vh = pw * (1 - cl - cr), ph * (1 - ct - cb)
    aspect = vw / vh
    if fit == "cover":
        box = w / h
        if aspect > box:  # too wide: trim left/right
            extra = 1 - box / aspect
            cl, cr = cl + extra * (1 - cl - cr) / 2, cr + extra * (1 - cl - cr) / 2
        else:  # too tall: trim top/bottom, keep a little more of the top
            extra = 1 - aspect / box
            span = 1 - ct - cb
            ct, cb = ct + extra * span * 0.4, cb + extra * span * 0.6
        dx, dy, dw, dh = x, y, w, h
        vw, vh = pw * (1 - cl - cr), ph * (1 - ct - cb)
    else:
        if w / h > aspect:
            dh, dw = h, h * aspect
        else:
            dw, dh = w, w / aspect
        dx = x + (w - dw) / 2 if align == "center" else (x if align == "left" else x + w - dw)
        dy = y + (h - dh) / 2
    pic = slide.shapes.add_picture(str(raster), Inches(dx), Inches(dy), Inches(dw), Inches(dh))
    if cl or ct or cr or cb:
        pic.crop_left, pic.crop_top, pic.crop_right, pic.crop_bottom = cl, ct, cr, cb
    if is_svg:
        embed_svg(slide, pic, p)
    else:
        eff_dpi = vw / dw
        if eff_dpi < 110:
            ctx.warn("low_resolution", f"{what}: {Path(ref).name} is shown at ~{eff_dpi:.0f} dpi; "
                                       "re-export at >= 150 dpi (or use SVG) to stay sharp on a projector")
    if fit == "contain" and dw * dh < (CW * (CONTENT_BOTTOM - CONTENT_TOP)) * 0.18 and what == "figure":
        ctx.warn("small_figure", f"{what}: figure occupies a small part of the slide; "
                                 "crop to the relevant panel or use the `figure` layout")
    if ai_generated:
        ai_badge(ctx, slide, dx, dy, dw, dh, dark_badge)
    return pic, (dx, dy, dw, dh)


# LaTeX that papers use but matplotlib mathtext rejects -> nearest supported form.
# Applied before rendering so a model copying equations from a .tex source does not
# have to discover the mathtext subset by trial and error.
BS = "\\"  # one backslash; spelled out so no tool can collapse the escapes
# macro name -> replacement (None removes it). Matched only as a whole macro name.
MATHTEXT_MACROS = {
    "displaystyle": None, "textstyle": None, "limits": None, "nolimits": None,
    "nonumber": None, "notag": None,
    "big": None, "Big": None, "bigg": None, "Bigg": None,
    "bigl": None, "bigr": None, "Bigl": None, "Bigr": None, "biggl": None, "biggr": None,
    "Biggl": None, "Biggr": None, "bigm": None, "Bigm": None,
    "ge": BS + "geq", "le": BS + "leq", "tfrac": BS + "frac", "bm": BS + "boldsymbol",
    "textbf": BS + "mathbf", "textit": BS + "mathit",
    "lVert": BS + "|", "rVert": BS + "|", "lvert": "|", "rvert": "|",
    "coloneqq": ":=", "land": BS + "wedge", "lor": BS + "vee",
}
_MACRO_RE = re.compile(re.escape(BS) + r"([A-Za-z]+)")
_TAG_RE = re.compile(re.escape(BS) + r"(?:tag|label)\{[^{}]*\}")
_BBM_RE = re.compile(re.escape(BS) + r"mathbbm\{([^{}]*)\}")
_OPSTAR_RE = re.compile(re.escape(BS) + r"operatorname\*")
_AMP_RE = re.compile(r"(?<!" + re.escape(BS) + r")&")


def normalize_mathtext(tex: str) -> str:
    """Rewrite LaTeX that papers use but matplotlib mathtext rejects."""
    tex = _TAG_RE.sub("", tex)
    tex = _BBM_RE.sub(lambda m: BS + "mathbf{" + m.group(1) + "}", tex)
    tex = _OPSTAR_RE.sub(lambda m: BS + "operatorname", tex)
    tex = _AMP_RE.sub("", tex)

    def macro(m):
        name = m.group(1)
        if name in MATHTEXT_MACROS:
            rep = MATHTEXT_MACROS[name]
            return "" if rep is None else rep + " "
        return m.group(0)

    tex = _MACRO_RE.sub(macro, tex)
    return re.sub(r"\s+", " ", tex).strip()


def render_equation(ctx: Ctx, tex: str, color: str) -> Path | None:
    tex = tex.strip()
    tex = normalize_mathtext(tex.strip("$ "))
    if tex.startswith("$") and tex.endswith("$"):
        tex = tex.strip("$")
    key = hashlib.sha1(f"{tex}|{color}".encode()).hexdigest()[:16]
    out = ctx.cache_dir / f"eq-{key}.png"
    if out.is_file():
        return out
    try:
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib.figure import Figure
    except ImportError:
        ctx.err("equation_renderer", "matplotlib is required to render equations "
                                     "(python3 -m pip install matplotlib), or supply `image` instead")
        return None
    ctx.cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        fig = Figure()
        fig.text(0, 0, f"${tex}$", fontsize=40, color="#" + color)
        fig.savefig(str(out), dpi=220, transparent=True, bbox_inches="tight", pad_inches=0.06)
    except Exception as e:  # mathtext parse errors
        if out.exists():
            out.unlink()
        ctx.err("equation_parse", f"equation could not be rendered by matplotlib mathtext: {tex!r} ({e}). "
                                  "Use the supported subset (\\frac, \\sum, \\mathbb, Greek, sub/superscripts) "
                                  "or supply a pre-rendered `image`.")
        return None
    return out


# --------------------------------------------------------------------------- layouts

def set_alpha(shp, opacity: float):
    clr = shp._element.spPr.find(qn("a:solidFill"))
    if clr is not None and len(clr):
        a = etree.SubElement(clr[0], qn("a:alpha"))
        a.set("val", str(int(opacity * 100000)))


def scrim(slide, x, y, w, h, color: str, a_from: float, a_to: float, angle: float = 0.0):
    """Editable gradient overlay: ``color`` at opacity ``a_from`` fading to ``a_to``
    along ``angle`` degrees (0 = left->right, 90 = top->bottom). Keeps text on
    photos legible without baking the overlay into the image."""
    s = rect(slide, x, y, w, h, color)
    s.fill.gradient()
    s.fill.gradient_angle = angle
    stops = s.fill.gradient_stops
    for stop, pos, a in ((stops[0], 0.0, a_from), (stops[1], 1.0, a_to)):
        stop.position = pos
        stop.color.rgb = rgb(color)
        srgb = stop._element.find(qn("a:srgbClr"))
        alpha = etree.SubElement(srgb, qn("a:alpha"))
        alpha.set("val", str(int(a * 100000)))
    return s


def L_title(ctx: Ctx, slide, s: dict, meta: dict):
    t = ctx.theme
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, t["primary"])
    img = s.get("image")
    if img:
        # cover image fills the right part; a gradient blends it into the title panel
        ix = SLIDE_W * 0.52
        place_image(ctx, slide, img, ix, 0, SLIDE_W - ix, SLIDE_H, s.get("crop"), what="title image",
                    fit="cover", ai_generated=bool(s.get("ai_generated")))
        scrim(slide, ix - 0.01, 0, 2.6, SLIDE_H, t["primary"], 1.0, 0.0, 0)
    else:
        # quiet editable geometry on the right: two translucent discs and a ring
        c1 = rect(slide, SLIDE_W - 3.9, -1.9, 6.0, 6.0, t["accent"], shape=MSO_SHAPE.OVAL)
        set_alpha(c1, 0.55)
        c2 = rect(slide, SLIDE_W - 2.4, 3.6, 4.2, 4.2, t["accent2"], shape=MSO_SHAPE.OVAL)
        set_alpha(c2, 0.35)
        rect(slide, SLIDE_W - 3.75, 4.75, 1.1, 1.1, None, line="FFFFFF", shape=MSO_SHAPE.OVAL, line_w=2.0)
    rect(slide, 0, SLIDE_H - 0.12, SLIDE_W, 0.12, t["accent"])
    title = s.get("title") or meta.get("title") or ""
    if not title:
        ctx.err("missing_title", "title slide has no title")
    tw = SLIDE_W * 0.52 - ML - 0.4 if img else SLIDE_W - 2 * ML - 3.4
    paras = [Para(title, bullet=False, bold=True)]
    pt, h, _ = fit(ctx, paras, tw, 2.4, 44, 28, "deck title")
    y = 2.55 - h / 2 if h < 2.0 else 1.4
    textbox(ctx, slide, ML + 0.1, y, tw, h + 0.1, paras, pt, color="FFFFFF", spacing=1.05,
            bold_color="FFFFFF", name="Title")
    y += h + 0.3
    rect(slide, ML + 0.1, y, 1.1, 0.07, t["accent2"])
    y += 0.35
    sub = s.get("subtitle") or meta.get("subtitle")
    if sub:
        paras = [Para(str(sub), bullet=False)]
        spt, sh, _ = fit(ctx, paras, tw, 1.2, 24, 16, "subtitle")
        textbox(ctx, slide, ML + 0.1, y, tw, sh + 0.05, paras, spt, color="DCE6F5", name="Subtitle")
        y += sh + 0.25
    lines = [x for x in [s.get("author") or meta.get("author"),
                         s.get("affiliation") or meta.get("affiliation"),
                         s.get("date") or meta.get("date")] if x]
    if lines:
        paras = [Para(str(x), bullet=False) for x in lines]
        apt, ah, _ = fit(ctx, paras, tw, 1.4, 18, 12, "author block", space_before=0.25)
        textbox(ctx, slide, ML + 0.1, SLIDE_H - 0.6 - ah, tw, ah + 0.05, paras, apt, color="C9D5E8",
                space_before=0.25, name="Authors")


def L_section(ctx: Ctx, slide, s: dict, meta: dict):
    t = ctx.theme
    panel_w = SLIDE_W * 0.38
    rect(slide, 0, 0, panel_w, SLIDE_H, t["primary"])
    if s.get("image"):
        place_image(ctx, slide, s["image"], 0, 0, panel_w, SLIDE_H, s.get("crop"), what="section image",
                    fit="cover", ai_generated=bool(s.get("ai_generated")))
        scrim(slide, 0, 0, panel_w, SLIDE_H, t["primary"], 0.15, 0.85, 90)
    num = str(s.get("number") or "")
    if num:
        nb = slide.shapes.add_textbox(Inches(ML), Inches(4.3 if s.get("image") else 2.3),
                                      Inches(panel_w - 2 * ML), Inches(2.2))
        shape_label(ctx, nb, num, 110, "FFFFFF")
        nb.text_frame.paragraphs[0].alignment = PP_ALIGN.LEFT
    x = panel_w + 0.8
    w = SLIDE_W - x - ML
    title = s.get("title") or ""
    if not title:
        ctx.err("missing_title", "section slide has no title")
    paras = [Para(title, bullet=False, bold=True)]
    pt, h, _ = fit(ctx, paras, w, 2.2, 40, 26, "section title")
    y = 3.0 - h / 2
    textbox(ctx, slide, x, y, w, h + 0.05, paras, pt, color=t["primary"], name="Title")
    rect(slide, x, y + h + 0.25, 1.0, 0.07, t["accent"])
    if s.get("subtitle"):
        paras = [Para(str(s["subtitle"]), bullet=False)]
        spt, sh, _ = fit(ctx, paras, w, 1.6, 24, 16, "section subtitle")
        textbox(ctx, slide, x, y + h + 0.6, w, sh + 0.05, paras, spt, color=t["muted"], name="Subtitle")


def L_hero(ctx: Ctx, slide, s: dict, meta: dict):
    """Full-bleed image with a statement over a gradient: opening hooks, motivation
    scenes, application context, section transitions."""
    t = ctx.theme
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, t["primary"])
    if not s.get("image"):
        ctx.err("empty_content", "hero layout needs `image` (SomniImage illustration, photo or SVG)")
    else:
        place_image(ctx, slide, s["image"], 0, 0, SLIDE_W, SLIDE_H, s.get("crop"), what="hero image",
                    fit="cover", ai_generated=bool(s.get("ai_generated")))
    side = s.get("text_side", "left")
    tw = SLIDE_W * 0.5
    if side == "right":
        scrim(slide, SLIDE_W * 0.35, 0, SLIDE_W * 0.65, SLIDE_H, t["primary"], 0.0, 0.92, 0)
        tx = SLIDE_W - ML - tw
    else:
        scrim(slide, 0, 0, SLIDE_W * 0.68, SLIDE_H, t["primary"], 0.92, 0.0, 0)
        tx = ML + 0.1
    text = s.get("statement") or s.get("title") or ""
    if not text:
        ctx.err("empty_content", "hero layout needs `statement` (or `title`)")
        return
    paras = [Para(str(text), bullet=False, bold=True)]
    pt, h, _ = fit(ctx, paras, tw, 3.0, 40, 24, "hero statement")
    sub = s.get("subtitle")
    sp, spt, sh = [], 20, 0.0
    if sub:
        sp = [Para(str(sub), bullet=False)]
        spt, sh, _ = fit(ctx, sp, tw, 1.4, 22, 14, "hero subtitle")
    total = h + (0.45 + sh if sub else 0)
    y = 3.6 - total / 2
    rect(slide, tx, y - 0.35, 1.0, 0.07, t["accent2"])
    textbox(ctx, slide, tx, y, tw, h + 0.05, paras, pt, color="FFFFFF", spacing=1.08, bold_color="FFE7A3",
            name="Statement")
    if sub:
        textbox(ctx, slide, tx, y + h + 0.45, tw, sh + 0.05, sp, spt, color="DCE6F5", name="Subtitle")
    if s.get("source"):
        textbox(ctx, slide, tx, SLIDE_H - 0.55, tw, 0.3, [Para(str(s["source"]), bullet=False)], 11,
                color="C9D5E8", name="Source")


def L_agenda(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title") or ("目录" if ctx.lang == "zh" else "Outline"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    items = s.get("items") or []
    if not items:
        ctx.err("empty_content", "agenda needs `items`")
        return
    current = s.get("current")
    n = len(items)
    cols = 1 if n <= 5 else 2
    rows = math.ceil(n / cols)
    col_w = (CW - GAP * (cols - 1)) / cols
    row_h = min(1.0, (bottom - top) / rows)
    num_w = 0.95
    texts = [Para(str(it if isinstance(it, str) else it.get("title", "")), bullet=False) for it in items]
    pt = min(fit(ctx, [p], col_w - num_w - 0.2, row_h * 0.9, 26, 16, f"agenda item {i + 1}")[0]
             for i, p in enumerate(texts))
    y0 = top + max(0.0, ((bottom - top) - rows * row_h) / 2)
    for i, para in enumerate(texts):
        c, r = divmod(i, rows)
        x, y = ML + c * (col_w + GAP), y0 + r * row_h
        active = current is not None and (current == i + 1 or current == para.text)
        circle = rect(slide, x, y + (row_h - 0.68) / 2, 0.68, 0.68,
                      ctx.theme["accent"] if active or current is None else ctx.theme["light"],
                      shape=MSO_SHAPE.OVAL)
        shape_label(ctx, circle, f"{i + 1:02d}", 18,
                    "FFFFFF" if active or current is None else ctx.theme["muted"])
        textbox(ctx, slide, x + num_w, y, col_w - num_w, row_h, [para], pt,
                color=ctx.theme["text"] if active or current is None else ctx.theme["muted"],
                anchor=MSO_ANCHOR.MIDDLE, name=f"Agenda{i + 1}")
        if r < rows - 1 and i < n - 1:
            line(slide, x + num_w, y + row_h, x + col_w, y + row_h, ctx.theme["line"], 0.75)


def L_bullets(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    paras = as_paras(s.get("bullets"), ctx, "bullets")
    if not paras:
        ctx.err("empty_content", "bullets layout needs `bullets`")
        return
    top_level = sum(1 for p in paras if p.level == 0)
    if top_level > 6:
        ctx.warn("dense_slide", f"{top_level} bullets; keep <= 6 (split the slide or move detail to notes)")
    body_block(ctx, slide, paras, ML + 0.1, top, CW - 0.2, bottom - top, max_pt=28)


def L_figure(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    cap_h = 0.0
    if s.get("caption"):
        paras = [Para(str(s["caption"]), bullet=False)]
        cpt, ch, _ = fit(ctx, paras, CW, 0.7, 16, 12, "caption")
        cap_h = ch + 0.12
        textbox(ctx, slide, ML, bottom - ch, CW, ch + 0.02, paras, cpt, color=ctx.theme["muted"],
                align=PP_ALIGN.CENTER, name="Caption")
    if not s.get("image"):
        ctx.err("empty_content", "figure layout needs `image`")
        return
    place_image(ctx, slide, s["image"], ML, top, CW, bottom - top - cap_h, s.get("crop"))


def L_figure_text(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    ratio = float(s.get("image_ratio", 0.58))
    ratio = min(max(ratio, 0.4), 0.7)
    img_w = CW * ratio - GAP / 2
    txt_w = CW - img_w - GAP
    side = s.get("image_side", "left")
    ix = ML if side == "left" else ML + txt_w + GAP
    tx = ML + img_w + GAP if side == "left" else ML
    cap_h = 0.0
    if s.get("caption"):
        paras = [Para(str(s["caption"]), bullet=False)]
        cpt, ch, _ = fit(ctx, paras, img_w, 0.7, 14, 11, "caption")
        cap_h = ch + 0.1
        textbox(ctx, slide, ix, bottom - ch, img_w, ch + 0.02, paras, cpt, color=ctx.theme["muted"],
                align=PP_ALIGN.CENTER, name="Caption")
    if s.get("image"):
        place_image(ctx, slide, s["image"], ix, top, img_w, bottom - top - cap_h, s.get("crop"),
                    what="figure_text image")
    else:
        ctx.err("empty_content", "figure_text layout needs `image`")
    paras = as_paras(s.get("bullets"), ctx, "bullets")
    if not paras:
        ctx.err("empty_content", "figure_text layout needs `bullets`")
        return
    body_block(ctx, slide, paras, tx, top, txt_w, bottom - top, max_pt=24)


def _panel(ctx: Ctx, slide, x, y, w, h, heading: str, paras: list[Para], color: str, what: str,
           pt: int | None = None):
    head_h = 0.62
    rect(slide, x, y, w, head_h, color)
    hb = slide.shapes.add_textbox(Inches(x + 0.25), Inches(y), Inches(w - 0.5), Inches(head_h))
    hp = [Para(heading, bullet=False, bold=True)]
    hpt, _, _ = fit(ctx, hp, w - 0.5, head_h - 0.08, 22, 14, f"{what} heading")
    tf = hb.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.word_wrap = True
    r = tf.paragraphs[0].add_run()
    r.text = plain(heading)
    _set_run_font(ctx, r, hpt, True, "FFFFFF")
    rect(slide, x, y + head_h, w, h - head_h, ctx.theme["light"])
    if paras:
        textbox(ctx, slide, x + 0.3, y + head_h + 0.28, w - 0.6, h - head_h - 0.5, paras, pt,
                name=what)


def L_two_column(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    left, right = s.get("left") or {}, s.get("right") or {}
    if not left or not right:
        ctx.err("empty_content", "two_column layout needs `left` and `right`")
        return
    col_w = (CW - GAP) / 2
    lp = as_paras(left.get("bullets"), ctx, "left.bullets")
    rp = as_paras(right.get("bullets"), ctx, "right.bullets")
    avail = bottom - top - 0.62 - 0.55
    pt = min(fit(ctx, lp, col_w - 0.6, avail, 24, ctx.min_body, "left column")[0] if lp else 24,
             fit(ctx, rp, col_w - 0.6, avail, 24, ctx.min_body, "right column")[0] if rp else 24)
    ctx.sizes.setdefault("body_pt", []).append(pt)
    if pt < 18:
        ctx.warn("small_text", f"two_column text fitted at {pt}pt; keep each side to 3-4 short points "
                               "(detail goes to notes) so it reads at >= 18pt")
    used = max(paras_height(ctx, lp, col_w - 0.6, pt), paras_height(ctx, rp, col_w - 0.6, pt))
    h = min(bottom - top, used + 0.62 + 0.6)
    y = top + max(0.0, (bottom - top - h) * 0.4)
    _panel(ctx, slide, ML, y, col_w, h, str(left.get("heading", "")), lp,
           ctx.theme["primary"] if not left.get("highlight") else ctx.theme["accent"], "left", pt)
    _panel(ctx, slide, ML + col_w + GAP, y, col_w, h, str(right.get("heading", "")), rp,
           ctx.theme["accent"] if right.get("highlight", True) else ctx.theme["primary"], "right", pt)


def L_cards(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    cards = s.get("cards") or []
    n = len(cards)
    if not 2 <= n <= 6:
        ctx.err("schema", f"cards layout takes 2-6 cards, got {n}")
        if n == 0:
            return
        cards = cards[:6]
        n = len(cards)
    cols = {2: 2, 3: 3, 4: 4 if s.get("single_row", True) else 2, 5: 3, 6: 3}[n]
    rows = math.ceil(n / cols)
    cw = (CW - GAP * (cols - 1)) / cols
    gap_y = 0.3
    ch_max = (bottom - top - gap_y * (rows - 1)) / rows
    pad = 0.28
    badge = 0.55
    inner_w = cw - 2 * pad
    titles = [Para(str(c.get("title", "")), bullet=False, bold=True) for c in cards]
    bodies = [as_paras(c.get("text") or c.get("bullets"), ctx, f"card {i + 1}") for i, c in enumerate(cards)]
    for b in bodies:
        for p in b:
            p.bullet = len(b) > 1
    tpt = min(fit(ctx, [t], inner_w, 0.9, 24, 16, f"card {i + 1} title")[0] for i, t in enumerate(titles))
    title_h = max(paras_height(ctx, [t], inner_w, tpt) for t in titles)
    body_avail = ch_max - pad * 2 - badge - 0.2 - title_h - 0.15
    bpt = min((fit(ctx, b, inner_w, body_avail, 20, 13, f"card {i + 1} text")[0] if b else 20)
              for i, b in enumerate(bodies))
    body_h = max((paras_height(ctx, b, inner_w, bpt) if b else 0) for b in bodies)
    ch = min(ch_max, pad * 2 + badge + 0.2 + title_h + 0.15 + body_h + 0.05)
    total_h = rows * ch + (rows - 1) * gap_y
    y0 = top + max(0.0, (bottom - top - total_h) * 0.42)
    for i, c in enumerate(cards):
        r, col = divmod(i, cols)
        row_n = min(cols, n - r * cols)
        x_off = (CW - (row_n * cw + (row_n - 1) * GAP)) / 2
        x = ML + x_off + col * (cw + GAP)
        y = y0 + r * (ch + gap_y)
        rect(slide, x, y, cw, ch, ctx.theme["light"], shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
        rect(slide, x, y, cw, 0.07, ctx.theme["accent"])
        b = rect(slide, x + pad, y + pad, badge, badge, ctx.theme["accent"] if not c.get("muted") else ctx.theme["muted"],
                 shape=MSO_SHAPE.OVAL)
        shape_label(ctx, b, str(c.get("badge") or (i + 1)), 16, "FFFFFF")
        ty = y + pad + badge + 0.2
        textbox(ctx, slide, x + pad, ty, inner_w, title_h + 0.05, [titles[i]], tpt,
                color=ctx.theme["primary"], name=f"Card{i + 1}Title")
        if bodies[i]:
            textbox(ctx, slide, x + pad, ty + title_h + 0.15, inner_w, ch - (ty - y) - title_h - 0.15 - pad + 0.1,
                    bodies[i], bpt, name=f"Card{i + 1}Text", space_before=0.3)


def L_metrics(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    items = s.get("metrics") or []
    n = len(items)
    if not 1 <= n <= 4:
        ctx.err("schema", f"metrics layout takes 1-4 metrics, got {n}")
        if n == 0:
            return
        items = items[:4]
        n = len(items)
    w = (CW - GAP * (n - 1)) / n
    values = [Para(str(it.get("value", "")), bullet=False, bold=True) for it in items]
    vpt = min(fit(ctx, [v], w - 0.4, 1.3, 60, 28, f"metric {i + 1} value")[0] for i, v in enumerate(values))
    labels = [Para(str(it.get("label", "")), bullet=False, bold=True) for it in items]
    lpt = min(fit(ctx, [lb], w - 0.4, 0.9, 22, 14, f"metric {i + 1} label")[0] for i, lb in enumerate(labels))
    notes = [Para(str(it.get("note", "")), bullet=False) for it in items]
    npt = min((fit(ctx, [nt], w - 0.4, 1.3, 18, 12, f"metric {i + 1} note")[0] if nt.text else 18)
              for i, nt in enumerate(notes))
    vh = ctx.m.line_height(vpt, 1.0)
    lh = max(paras_height(ctx, [lb], w - 0.4, lpt) for lb in labels)
    nh = max((paras_height(ctx, [nt], w - 0.4, npt) if nt.text else 0) for nt in notes)
    card_h = min(bottom - top, 0.45 + vh + 0.2 + lh + (0.18 + nh if nh else 0) + 0.45)
    y = top + max(0.0, (bottom - top - card_h) * 0.42)
    for i in range(n):
        x = ML + i * (w + GAP)
        rect(slide, x, y, w, card_h, ctx.theme["light"])
        rect(slide, x, y + card_h - 0.07, w, 0.07, ctx.theme["accent"] if i % 2 == 0 else ctx.theme["accent2"])
        yy = y + 0.45
        textbox(ctx, slide, x + 0.2, yy, w - 0.4, vh + 0.05, [values[i]], vpt,
                color=ctx.theme["accent"] if i % 2 == 0 else ctx.theme["accent2"], align=PP_ALIGN.CENTER,
                spacing=1.0, name=f"Metric{i + 1}Value")
        yy += vh + 0.2
        textbox(ctx, slide, x + 0.2, yy, w - 0.4, lh + 0.05, [labels[i]], lpt, color=ctx.theme["primary"],
                align=PP_ALIGN.CENTER, name=f"Metric{i + 1}Label")
        if notes[i].text:
            yy += lh + 0.18
            textbox(ctx, slide, x + 0.2, yy, w - 0.4, nh + 0.05, [notes[i]], npt, color=ctx.theme["muted"],
                    align=PP_ALIGN.CENTER, name=f"Metric{i + 1}Note")


def L_process(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    steps = s.get("steps") or []
    n = len(steps)
    if not 2 <= n <= 6:
        ctx.err("schema", f"process layout takes 2-6 steps, got {n}")
        if n == 0:
            return
        steps = steps[:6]
        n = len(steps)
    w = (CW - 0.25 * (n - 1)) / n
    circle = 0.8
    titles = [Para(str(st.get("title", "")), bullet=False, bold=True) for st in steps]
    texts = [Para(str(st.get("text", "")), bullet=False) for st in steps]
    tpt = min(fit(ctx, [t], w - 0.1, 0.9, 22, 15, f"step {i + 1} title")[0] for i, t in enumerate(titles))
    th = max(paras_height(ctx, [t], w - 0.1, tpt) for t in titles)
    avail = bottom - top - circle - 0.3 - th - 0.15
    bpt = min((fit(ctx, [t], w - 0.1, avail, 20, 13, f"step {i + 1} text")[0] if t.text else 20)
              for i, t in enumerate(texts))
    bh = max((paras_height(ctx, [t], w - 0.1, bpt) if t.text else 0) for t in texts)
    longest = max((count_lines(ctx.m, t.text, w - 0.1, bpt) for t in texts if t.text), default=0)
    if longest > 4 or bpt < 15:
        ctx.warn("dense_slide", f"process step text wraps to {longest} lines at {bpt}pt; keep each step to "
                                "a short phrase (<= 2 lines), use fewer steps, or switch to `cards`/`table`")
    total = circle + 0.3 + th + 0.15 + bh
    y = top + max(0.0, (bottom - top - total) * 0.4)
    cy = y + circle / 2
    line(slide, ML + w / 2, cy, ML + (n - 1) * (w + 0.25) + w / 2, cy, ctx.theme["line"], 3)
    for i in range(n):
        x = ML + i * (w + 0.25)
        c = rect(slide, x + (w - circle) / 2, y, circle, circle,
                 ctx.theme["accent"] if not steps[i].get("muted") else ctx.theme["muted"], shape=MSO_SHAPE.OVAL)
        shape_label(ctx, c, str(steps[i].get("badge") or (i + 1)), 22, "FFFFFF")
        textbox(ctx, slide, x + 0.05, y + circle + 0.3, w - 0.1, th + 0.05, [titles[i]], tpt,
                color=ctx.theme["primary"], align=PP_ALIGN.CENTER, name=f"Step{i + 1}Title")
        if texts[i].text:
            textbox(ctx, slide, x + 0.05, y + circle + 0.3 + th + 0.15, w - 0.1, bh + 0.05, [texts[i]], bpt,
                    align=PP_ALIGN.CENTER, name=f"Step{i + 1}Text")


def _cell_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def L_table(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    cols = [str(c) for c in (s.get("columns") or [])]
    rows = [[_cell_text(v) for v in r] for r in (s.get("rows") or [])]
    if not cols or not rows:
        ctx.err("empty_content", "table layout needs `columns` and `rows`")
        return
    for i, r in enumerate(rows):
        if len(r) != len(cols):
            ctx.err("schema", f"table row {i + 1} has {len(r)} cells but there are {len(cols)} columns")
            r.extend([""] * (len(cols) - len(r)))
            del r[len(cols):]
    nc, nr = len(cols), len(rows) + 1
    if nr > 13:
        ctx.warn("dense_slide", f"table has {nr - 1} rows; keep <= 10 for projection, move the rest to backup")
    cap_h = 0.0
    if s.get("caption"):
        paras = [Para(str(s["caption"]), bullet=False)]
        cpt, ch, _ = fit(ctx, paras, CW, 0.6, 14, 11, "table caption")
        cap_h = ch + 0.15
        caption = (paras, cpt, ch)
    else:
        caption = None
    avail_h = bottom - top - cap_h
    pad_x, pad_y = 0.14, 0.07
    all_rows = [cols] + rows
    hi = s.get("highlight_rows") or ([s["highlight_row"]] if s.get("highlight_row") else [])
    hi = {int(h) for h in hi}

    def is_bold(k, c):
        return k == 0 or k in hi or "**" in c

    def layout_at(pt, allow_wrap=True):
        """Column widths at ``pt``. Data cells keep their single-line width when the
        table can afford it (headers may wrap); otherwise text-heavy columns give up
        width before short/numeric ones. Never break inside a number or word."""
        cell_pad = 2 * pad_x + 0.06
        nat_all, nat_body, floor = [], [], []
        for j in range(nc):
            cells = [r[j] for r in all_rows]
            ws = [ctx.m.width(plain(c), pt, is_bold(k, c)) + cell_pad for k, c in enumerate(cells)]
            nat_all.append(max(ws))
            nat_body.append(max(ws[1:]) if len(ws) > 1 else ws[0])
            longest = max((ctx.m.width(tok, pt, is_bold(k, c)) for k, c in enumerate(cells)
                           for tok in TOKEN_RE.findall(plain(c)) if not tok.isspace()), default=0.3)
            floor.append(max(longest + cell_pad, 0.7))
        base = [max(b, f) for b, f in zip(nat_body, floor)]
        if sum(base) <= CW:
            target = min(CW, max(sum(nat_all) * 1.15, CW * 0.55, sum(base)))
            extra = target - sum(base)
            deficit = [max(0.0, a - b) for a, b in zip(nat_all, base)]  # header wider than data
            if sum(deficit) > 0:
                give = min(extra, sum(deficit))
                widths = [b + give * d / sum(deficit) for b, d in zip(base, deficit)]
                extra -= give
            else:
                widths = list(base)
            if extra > 0:
                tw = sum(widths)
                widths = [w_ + extra * w_ / tw for w_ in widths]
        else:
            if not allow_wrap or sum(floor) > CW:
                return None
            spare = CW - sum(floor)
            want = [n - f for n, f in zip(nat_body, floor)]
            tw = sum(want) or 1.0
            widths = [f + spare * w_ / tw for f, w_ in zip(floor, want)]
        hs = []
        for k, cells in enumerate(all_rows):
            # cell widths already include explicit slack, so no extra safety factor here
            n_lines = max(count_lines(ctx.m, c, widths[j] - 2 * pad_x, pt, is_bold(k, c), safety=0.995)
                          for j, c in enumerate(cells))
            hs.append(n_lines * ctx.m.line_height(pt, 1.0) + 2 * pad_y + 0.08)
        return widths, hs

    chosen = None
    # pass 1: largest size at which no data cell wraps; pass 2: allow wrapping text columns
    for allow_wrap, lo in ((False, 14), (True, 11)):
        for pt in range(24, lo - 1, -1):
            lay = layout_at(pt, allow_wrap)
            if lay and sum(lay[1]) <= avail_h:
                chosen = (pt,) + lay
                break
        if chosen:
            break
    if chosen is None:
        pt = 11
        lay = layout_at(pt) or ([CW / nc] * nc, [0.4] * nr)
        ctx.err("text_overflow", f"table does not fit at 11pt in {CW:.1f}x{avail_h:.2f}in; "
                                 "split rows into a backup slide or drop columns")
        chosen = (pt,) + lay
    pt, widths, hs = chosen
    th = sum(hs)
    width = sum(widths)
    if pt < 14:
        ctx.warn("small_text", f"table fitted at {pt}pt; consider fewer rows/columns")
    ctx.sizes["table_pt"] = pt
    x = ML + (CW - width) / 2
    y = top + max(0.0, (avail_h - th) * 0.4)
    gt = slide.shapes.add_table(nr, nc, Inches(x), Inches(y), Inches(width), Inches(th))
    if caption:
        cparas, cpt, ch = caption
        textbox(ctx, slide, ML, y + th + 0.15, CW, ch + 0.02, cparas, cpt, color=ctx.theme["muted"],
                align=PP_ALIGN.LEFT if width >= CW - 0.05 else PP_ALIGN.CENTER, name="Caption")
    tbl = gt.table
    tblPr = tbl._tbl.tblPr
    style = tblPr.find(qn("a:tableStyleId"))
    if style is None:
        style = etree.SubElement(tblPr, qn("a:tableStyleId"))
    style.text = "{5940675A-B579-460E-94D1-54222C63F5DA}"  # "No Style, Table Grid" -> we paint cells
    for j, w in enumerate(widths):
        tbl.columns[j].width = Inches(w)
    align_num = re.compile(r"^[\s+\-−±~≈<>≤≥]*[\d.,]+\s*(%|x|×|ms|s|M|K|B|pp)?\s*(±\s*[\d.]+)?\s*$")
    for k, cells in enumerate([cols] + rows):
        tbl.rows[k].height = Inches(hs[k])
        for j, val in enumerate(cells):
            cell = tbl.cell(k, j)
            cell.margin_left = cell.margin_right = Inches(pad_x)
            cell.margin_top = cell.margin_bottom = Inches(pad_y)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            if k == 0:
                fill, color, bold = ctx.theme["primary"], "FFFFFF", True
            elif k in hi:
                fill, color, bold = "FFF4E5", ctx.theme["text"], True
            else:
                fill, color, bold = (ctx.theme["light"] if k % 2 == 0 else "FFFFFF"), ctx.theme["text"], False
            cell.fill.solid()
            cell.fill.fore_color.rgb = rgb(fill)
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER if (k == 0 or (j > 0 and align_num.match(plain(val)))) else PP_ALIGN.LEFT
            for seg, b in parse_rich(val) or [("", False)]:
                r = p.add_run()
                r.text = seg
                _set_run_font(ctx, r, pt, bold or b, ctx.theme["accent2"] if (b and k > 0 and k not in hi) else color)


CHART_TYPES = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "stacked_column": XL_CHART_TYPE.COLUMN_STACKED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}


def L_chart(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    spec = s.get("chart") or {}
    ctype = spec.get("type", "column")
    cats = spec.get("categories") or []
    series = spec.get("series") or []
    if ctype not in CHART_TYPES:
        ctx.err("schema", f"chart.type must be one of {sorted(CHART_TYPES)}")
        return
    if not cats or not series:
        ctx.err("empty_content", "chart needs `categories` and `series`")
        return
    data = CategoryChartData()
    data.categories = [str(c) for c in cats]
    for se in series:
        vals = se.get("values") or []
        if len(vals) != len(cats):
            ctx.err("schema", f"series {se.get('name')!r} has {len(vals)} values for {len(cats)} categories")
            vals = (list(vals) + [None] * len(cats))[: len(cats)]
        data.add_series(str(se.get("name", "")), vals, number_format=spec.get("number_format", "General"))
    paras = as_paras(s.get("bullets"), ctx, "bullets")
    if paras:
        cw = CW * 0.62
        tx = ML + cw + GAP
        body_block(ctx, slide, paras, tx, top, CW - cw - GAP, bottom - top, max_pt=24)
    else:
        cw = CW
    gf = slide.shapes.add_chart(CHART_TYPES[ctype], Inches(ML), Inches(top), Inches(cw), Inches(bottom - top), data)
    ch = gf.chart
    ch.has_title = bool(spec.get("title"))
    if spec.get("title"):
        ch.chart_title.text_frame.text = str(spec["title"])
    ch.font.size = Pt(16)
    ch.font.name = ctx.m.latin
    palette = [ctx.theme["accent"], ctx.theme["accent2"], ctx.theme["primary"], "8B5CF6", "10B981", "94A3B8"]
    multi = len(series) > 1 or ctype in ("pie", "doughnut")
    ch.has_legend = multi
    if multi:
        ch.legend.position = XL_LEGEND_POSITION.BOTTOM
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(15)
    if ctype in ("pie", "doughnut"):
        pts = ch.plots[0].series[0].points
        for i in range(len(cats)):
            pts[i].format.fill.solid()
            pts[i].format.fill.fore_color.rgb = rgb(palette[i % len(palette)])
    else:
        for i, se in enumerate(ch.plots[0].series):
            col = rgb(palette[i % len(palette)])
            if ctype == "line":
                se.format.line.color.rgb = col
                se.format.line.width = Pt(3)
                se.smooth = False
            else:
                se.format.fill.solid()
                se.format.fill.fore_color.rgb = col
        try:
            va = ch.value_axis
            va.has_major_gridlines = True
            va.major_gridlines.format.line.color.rgb = rgb(ctx.theme["line"])
            va.tick_labels.font.size = Pt(14)
            ch.category_axis.tick_labels.font.size = Pt(15)
            if spec.get("y_label"):
                va.has_title = True
                va.axis_title.text_frame.text = str(spec["y_label"])
                va.axis_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
            if spec.get("x_label"):
                ca = ch.category_axis
                ca.has_title = True
                ca.axis_title.text_frame.text = str(spec["x_label"])
                ca.axis_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
            if spec.get("y_min") is not None:
                va.minimum_scale = float(spec["y_min"])
            if spec.get("y_max") is not None:
                va.maximum_scale = float(spec["y_max"])
        except (AttributeError, ValueError):
            pass
    if spec.get("labels", len(cats) * len(series) <= 12):
        pl = ch.plots[0]
        pl.has_data_labels = True
        dl = pl.data_labels
        dl.font.size = Pt(13)
        if spec.get("label_format"):
            dl.number_format = spec["label_format"]
            dl.number_format_is_linked = False
        if ctype in ("column", "bar"):
            dl.position = XL_LABEL_POSITION.OUTSIDE_END


def L_equation(ctx: Ctx, slide, s: dict, meta: dict):
    top = draw_title(ctx, slide, s.get("title"))
    top, bottom = draw_lead_and_takeaway(ctx, slide, s, top)
    eqs = s.get("equations") or ([s["equation"]] if s.get("equation") else [])
    # a LaTeX line break inside one entry becomes separate centred lines
    eqs = [part for e in eqs for part in re.split(r"\\\\", str(e)) if part.strip()]
    if len(eqs) > 3:
        ctx.warn("dense_slide", f"{len(eqs)} equation lines; keep 1-3 key relations, move the rest to notes/backup")
    if not eqs and not s.get("image"):
        ctx.err("empty_content", "equation layout needs `equations` (LaTeX math) or `image`")
        return
    paras = as_paras(s.get("explanation") or s.get("bullets"), ctx, "explanation")
    imgs: list[tuple[str, int, int]] = []
    for tex in eqs:
        p = render_equation(ctx, str(tex), ctx.theme["text"])
        if p:
            with Image.open(p) as im:
                imgs.append((str(p), *im.size))
    if s.get("image"):
        p = resolve_image(ctx, s["image"], "equation image")
        if p:
            with Image.open(p) as im:
                imgs.append((str(p), *im.size))
    avail = bottom - top
    max_w = CW - 0.8
    gap, pad = 0.3, 0.25

    def sizes(scale):
        # rendered at 220 dpi with 40pt glyphs; `scale` 0.8 => ~32pt glyphs on the slide
        out = []
        for _, pw, ph in imgs:
            w, h = pw / 220 * scale, ph / 220 * scale
            if w > max_w:
                h, w = h * max_w / w, max_w
            out.append((w, h, 40 * scale * (w / (pw / 220 * scale))))
        return out

    chosen, expl_space = None, 0.0
    for scale in (0.8, 0.72, 0.64, 0.56, 0.48):
        sz = sizes(scale)
        block = sum(h for _, h, _ in sz) + gap * (len(sz) - 1) + 2 * pad if sz else 0.0
        rest = avail - block - (0.3 if sz else 0.0)
        if not paras and block <= avail:
            chosen, expl_space = sz, 0.0
            break
        if paras and rest > 0 and paras_height(ctx, paras, CW - 1.0, ctx.min_body) <= rest:
            chosen, expl_space = sz, rest
            break
    if chosen is None:
        chosen = sizes(0.48)
        block = sum(h for _, h, _ in chosen) + gap * (len(chosen) - 1) + 2 * pad if chosen else 0.0
        expl_space = max(0.5, avail - block - 0.3)
        ctx.err("text_overflow", "equations and explanation do not fit together; "
                                 "keep 1-2 key equations here and move the rest to notes or a backup slide")
    block = sum(h for _, h, _ in chosen) + gap * (len(chosen) - 1) + 2 * pad if chosen else 0.0
    pt = 20
    used = 0.0
    if paras:
        pt, used, _ = fit(ctx, paras, CW - 1.0, expl_space, 24, ctx.min_body, "explanation")
    total = block + (0.35 + used if paras else 0.0)
    y0 = top + max(0.0, (avail - total) * 0.35)
    if chosen:
        rect(slide, ML, y0, CW, block, ctx.theme["light"])
        y = y0 + pad
        for (ref, _, _), (w, h, glyph) in zip(imgs, chosen):
            place_image(ctx, slide, ref, ML + (CW - w) / 2, y, w, h, what="equation")
            if glyph < 18:
                ctx.warn("small_text", f"an equation renders at ~{glyph:.0f}pt glyphs; it is too long for one line "
                                       "-- split it, drop terms into notes, or show only the key relation")
            y += h + gap
    if paras:
        textbox(ctx, slide, ML + 0.5, y0 + block + 0.35, CW - 1.0, used + 0.1, paras, pt, name="Explanation")


def L_statement(ctx: Ctx, slide, s: dict, meta: dict):
    t = ctx.theme
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, t["light"])
    rect(slide, ML, 1.6, 0.12, 4.3, t["accent"])
    text = s.get("statement") or s.get("title") or ""
    if not text:
        ctx.err("empty_content", "statement layout needs `statement`")
        return
    paras = [Para(str(text), bullet=False, bold=True)]
    w = CW - 0.8
    pt, h, _ = fit(ctx, paras, w, 3.2, 40, 24, "statement")
    sub = s.get("subtitle") or s.get("attribution")
    sh = 0.0
    if sub:
        sp = [Para(str(sub), bullet=False)]
        spt, sh, _ = fit(ctx, sp, w, 1.0, 22, 14, "statement subtitle")
    total = h + (0.4 + sh if sub else 0)
    y = 3.75 - total / 2
    textbox(ctx, slide, ML + 0.6, y, w, h + 0.05, paras, pt, color=t["primary"], spacing=1.1, name="Statement")
    if sub:
        textbox(ctx, slide, ML + 0.6, y + h + 0.4, w, sh + 0.05, sp, spt, color=t["muted"], name="Subtitle")


def L_closing(ctx: Ctx, slide, s: dict, meta: dict):
    t = ctx.theme
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, t["primary"])
    title = s.get("title") or ("谢谢！欢迎提问" if ctx.lang == "zh" else "Thank you — questions?")
    paras = [Para(title, bullet=False, bold=True)]
    pt, h, _ = fit(ctx, paras, CW, 1.8, 48, 28, "closing title")
    lines = [str(x) for x in (s.get("bullets") or s.get("contacts") or [])]
    sub = s.get("subtitle")
    sp = [Para(str(sub), bullet=False)] if sub else []
    sp += [Para(x, bullet=False) for x in lines]
    sh, spt = 0.0, 20
    if sp:
        spt, sh, _ = fit(ctx, sp, CW, 2.4, 22, 14, "closing details", space_before=0.3)
    total = h + (0.5 + sh if sp else 0)
    y = 3.6 - total / 2
    textbox(ctx, slide, ML, y, CW, h + 0.05, paras, pt, color="FFFFFF", align=PP_ALIGN.CENTER, bold_color="FFFFFF",
            name="Title")
    rect(slide, SLIDE_W / 2 - 0.55, y + h + 0.22, 1.1, 0.07, t["accent2"])
    if sp:
        textbox(ctx, slide, ML, y + h + 0.5, CW, sh + 0.05, sp, spt, color="DCE6F5", align=PP_ALIGN.CENTER,
                space_before=0.3, bold_color="FFFFFF", name="Details")


RENDERERS = {
    "title": L_title, "section": L_section, "hero": L_hero, "agenda": L_agenda, "bullets": L_bullets, "figure": L_figure,
    "figure_text": L_figure_text, "two_column": L_two_column, "cards": L_cards, "metrics": L_metrics,
    "process": L_process, "table": L_table, "chart": L_chart, "equation": L_equation,
    "statement": L_statement, "closing": L_closing,
}
CHROMELESS = {"title", "section", "hero", "statement", "closing"}

# --------------------------------------------------------------------------- lint

RESIDUE = [
    (re.compile(r"\\[a-zA-Z]{2,}"), "latex_residue", "LaTeX command in visible text"),
    (re.compile(r"\[\s*-?\d+(\.\d+)?\s*(cm|mm|pt|em|ex|in)\s*\]"), "latex_residue", "LaTeX length residue"),
    (re.compile(r"(?<![\w$])\$[^$\n]+\$"), "latex_residue",
     "raw $...$ math in visible text (use Unicode or the equation layout)"),
    (re.compile(r"\[(图表|表格|图片|图|figure|table|image|chart|placeholder|TODO)\]", re.I), "placeholder",
     "placeholder left in visible text"),
    (re.compile(r"\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b", re.I), "placeholder", "placeholder left in visible text"),
    (re.compile(r"(待补充|待填写|此处填写|占位符|内容待定)"), "placeholder", "placeholder left in visible text"),
    (re.compile(r"\\n|<br\s*/?>|&nbsp;"), "markup_residue", "escaped newline / HTML markup in visible text"),
    (re.compile(r"^\s*[-+]?\d+(\.\d+)?\s*$"), "bare_number",
     "a bullet that is only a number (often a Beamer column-width leak)"),
]
TEXT_KEYS = {"title", "subtitle", "lead", "takeaway", "caption", "statement", "attribution", "heading", "text",
             "label", "value", "note", "author", "affiliation", "date", "source", "badge"}
LIST_KEYS = {"bullets", "items", "explanation", "contacts", "sub", "children", "columns"}


def visible_strings(obj: Any, path: str = ""):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from visible_strings(v, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("notes", "image", "crop", "equations", "equation", "layout", "id", "seconds", "backup",
                     "source_ids", "chart", "number_format", "label_format", "image_side", "image_ratio"):
                if k == "chart" and isinstance(v, dict):
                    for kk in ("categories", "x_label", "y_label"):
                        if kk in v:
                            yield from visible_strings(v[kk], f"{path}.chart.{kk}")
                    for i, se in enumerate(v.get("series") or []):
                        if isinstance(se, dict) and "name" in se:
                            yield f"{path}.chart.series[{i}].name", str(se["name"])
                continue
            if k == "rows" and isinstance(v, list):
                for i, r in enumerate(v):
                    for j, c in enumerate(r if isinstance(r, list) else []):
                        if isinstance(c, str):
                            yield f"{path}.rows[{i}][{j}]", c
                continue
            if k in TEXT_KEYS or k in LIST_KEYS or isinstance(v, (dict, list)):
                yield from visible_strings(v, f"{path}.{k}")


def lint_slide(ctx: Ctx, s: dict):
    for path, txt in visible_strings(s):
        for rx, code, msg in RESIDUE:
            if code == "bare_number" and ("bullets" not in path and "items" not in path):
                continue
            if rx.search(txt):
                ctx.err(code, f"{msg}: {path} = {txt[:80]!r}")
                break
    layout = s.get("layout")
    if layout not in ("title", "closing", "section") and not str(s.get("notes") or "").strip():
        ctx.warn("missing_notes", "no speaker notes; every content slide needs `notes` (what to say + transition)")


# --------------------------------------------------------------------------- build

def build(spec: dict, base_dir: Path, out: Path | None, strict: bool = False) -> tuple[dict, int]:
    meta = spec.get("meta") or {}
    slides = spec.get("slides")
    issues_global: list[Issue] = []
    if not isinstance(slides, list) or not slides:
        report = {"ok": False, "errors": 1, "issues": [{"slide": None, "severity": "error", "code": "schema",
                                                         "message": "`slides` must be a non-empty list"}]}
        return report, 1
    lang = meta.get("language") or ("zh" if any(CJK_RE.search(json.dumps(sl, ensure_ascii=False)) for sl in slides[:5])
                                    else "en")
    theme_name = (meta.get("theme") or VENUE_THEMES.get(str(meta.get("venue", "generic")).lower(), "academic"))
    theme = dict(THEMES.get(theme_name, THEMES["academic"]))
    if theme_name not in THEMES:
        issues_global.append(Issue(None, "warning", "unknown_theme",
                                   f"theme {theme_name!r} unknown; using academic. Known: {sorted(THEMES)}"))
    for k, v in (meta.get("colors") or {}).items():
        if k in theme and re.fullmatch(r"#?[0-9a-fA-F]{6}", str(v)):
            theme[k] = str(v).lstrip("#").upper()
    default_ea = "Microsoft YaHei"
    if sys.platform == "darwin":
        default_ea = "PingFang SC"
    fonts = meta.get("fonts") or {}
    latin = fonts.get("latin") or (default_ea if lang == "zh" else "Calibri")
    ea = fonts.get("ea") or default_ea
    m = Metrics(latin, ea)
    if not m.exact:
        issues_global.append(Issue(None, "warning", "font_metrics",
                                   f"font files for {latin!r}/{ea!r} not found; text fitting uses estimates. "
                                   "Inspect the rendered pages closely."))
    prs = Presentation()
    if str(meta.get("aspect", "16:9")) != "16:9":
        issues_global.append(Issue(None, "warning", "aspect", "only 16:9 is supported; building 16:9"))
    prs.slide_width, prs.slide_height = Inches(SLIDE_W), Inches(SLIDE_H)
    blank = prs.slide_layouts[6]
    ctx = Ctx(prs=prs, theme=theme, m=m, base_dir=base_dir, cache_dir=base_dir / ".deck_cache", lang=lang,
              total=len(slides), footer=str(meta.get("footer") or ""),
              min_body=int(meta.get("min_body_pt", 16)))
    ctx.issues.extend(issues_global)
    seen_ids, seen_titles = set(), {}
    per_slide = []
    for idx, s in enumerate(slides, 1):
        ctx.slide_no = idx
        ctx.sizes = {}
        if not isinstance(s, dict):
            ctx.err("schema", "slide must be an object")
            continue
        sid = s.get("id", idx)
        if sid in seen_ids:
            ctx.err("schema", f"duplicate slide id {sid!r}")
        seen_ids.add(sid)
        layout = s.get("layout")
        if layout not in RENDERERS:
            ctx.err("schema", f"unknown layout {layout!r}; use one of {', '.join(LAYOUTS)}")
            layout = "bullets"
        t = plain(str(s.get("title") or "")).strip()
        if t and layout not in CHROMELESS:
            if t in seen_titles:
                ctx.warn("duplicate_title", f"same title as slide {seen_titles[t]}; make each title state its point")
            seen_titles[t] = idx
        lint_slide(ctx, s)
        slide = prs.slides.add_slide(blank)
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = rgb(theme["bg"])
        RENDERERS[layout](ctx, slide, s, meta)
        if layout not in CHROMELESS:
            draw_footer(ctx, slide, s)
        notes = str(s.get("notes") or "").strip()
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
        per_slide.append({"index": idx, "id": sid, "layout": layout, "title": t,
                          "seconds": s.get("seconds"), "backup": bool(s.get("backup")),
                          "has_notes": bool(notes), **ctx.sizes})
    ctx.slide_no = None
    if slides and isinstance(slides[0], dict) and slides[0].get("layout") != "title":
        ctx.warn("structure", "first slide is not a `title` slide")
    want = meta.get("slide_count")
    if want is not None and int(want) != len(slides):
        ctx.err("slide_count", f"meta.slide_count is {want} but slides.json has {len(slides)} slides")
    layouts_used = [p["layout"] for p in per_slide]
    content = [x for x in layouts_used if x not in CHROMELESS]
    if len(content) >= 6 and sum(1 for x in content if x == "bullets") / len(content) > 0.6:
        ctx.warn("monotone_layouts", "over 60% of content slides are plain bullets; use figure/table/chart/"
                                     "cards/process/metrics where the content has that shape")
    main_secs = sum(int(p["seconds"] or 0) for p in per_slide if not p["backup"])
    if meta.get("talk_minutes") and main_secs:
        budget = float(meta["talk_minutes"]) * 60
        if main_secs > budget:
            ctx.err("timing", f"main slides total {main_secs}s which exceeds talk_minutes ({budget:.0f}s)")
    errors = sum(1 for i in ctx.issues if i.severity == "error")
    warnings = sum(1 for i in ctx.issues if i.severity == "warning")
    failed = errors > 0 or (strict and warnings > 0)
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        prs.save(str(out))
    report = {
        "schema_version": SCHEMA_VERSION,
        "builder": "paper-slides/deck_builder.py",
        "ok": not failed,
        "output": str(out) if out else None,
        "slides": len(slides),
        "theme": theme_name,
        "fonts": {"latin": latin, "ea": ea, "exact_metrics": m.exact},
        "main_seconds": main_secs,
        "errors": errors,
        "warnings": warnings,
        "issues": [i.__dict__ for i in ctx.issues],
        "per_slide": per_slide,
    }
    return report, (1 if failed else 0)


def notes_markdown(spec: dict) -> str:
    out = ["# Speaker Notes", ""]
    t = 0
    for i, s in enumerate(spec.get("slides") or [], 1):
        title = plain(str(s.get("title") or s.get("statement") or s.get("layout", "")))
        secs = int(s.get("seconds") or 0)
        tag = " (backup)" if s.get("backup") else ""
        if not s.get("backup"):
            t += secs
        out.append(f"## Slide {i}: {title}{tag}")
        out.append("")
        out.append(str(s.get("notes") or "").strip() or "_(no notes)_")
        if secs:
            out.append("")
            out.append(f"[Time: {secs // 60}:{secs % 60:02d} · cumulative {t // 60}:{t % 60:02d}]")
        out.append("")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("spec", help="slides.json")
    ap.add_argument("-o", "--output", default=None, help="output .pptx (default: presentation.pptx next to spec)")
    ap.add_argument("--report", default=None, help="write JSON report here (default: deck_report.json next to spec)")
    ap.add_argument("--notes-md", default=None, help="also export speaker notes markdown")
    ap.add_argument("--check", action="store_true", help="lint and measure only; do not write the PPTX")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    a = ap.parse_args(argv)
    spec_path = Path(a.spec).resolve()
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read {spec_path}: {e}", file=sys.stderr)
        return 2
    base = spec_path.parent
    out = None if a.check else Path(a.output).resolve() if a.output else base / "presentation.pptx"
    report, code = build(spec, base, out, a.strict)
    rp = Path(a.report) if a.report else base / "deck_report.json"
    rp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if a.notes_md:
        Path(a.notes_md).write_text(notes_markdown(spec), encoding="utf-8")
    for i in report["issues"]:
        where = f"slide {i['slide']}" if i["slide"] else "deck"
        print(f"{i['severity'].upper():7} {where:9} [{i['code']}] {i['message']}")
    status = "OK" if report["ok"] else "FAILED"
    print(f"{status}: {report['slides']} slides, {report['errors']} errors, {report['warnings']} warnings"
          + (f" -> {out}" if out else " (check only)") + f"; report: {rp}")
    return code


if __name__ == "__main__":
    sys.exit(main())
