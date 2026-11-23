"""Regression tests for tools/deck_builder.py.

Each test pins a failure that reached a delivered deck before the builder
existed: LaTeX residue leaking into PPTX text, placeholders, silent overflow,
missing figures, empty cover/closing slides and tables wrapping numbers.
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from pptx import Presentation

SPEC = importlib.util.spec_from_file_location("deck_builder", Path(__file__).parents[1] / "tools" / "deck_builder.py")
DB = importlib.util.module_from_spec(SPEC)
sys.modules["deck_builder"] = DB  # dataclasses resolve annotations through sys.modules
SPEC.loader.exec_module(DB)


def deck(slides, **meta):
    return {"meta": {"title": "Test deck", "author": "A", "language": "en", **meta}, "slides": slides}


FULL = [
    {"id": "t", "layout": "title", "subtitle": "Sub", "date": "2026", "notes": "hi"},
    {"id": "a", "layout": "agenda", "items": ["Problem", "Method", "Results"], "notes": "n"},
    {"id": "b", "layout": "bullets", "title": "Errors grow with depth", "lead": "Lead sentence",
     "bullets": ["one **key** point", {"text": "two", "sub": ["detail"]}], "takeaway": "Remember this", "notes": "n"},
    {"id": "s", "layout": "section", "number": "02", "title": "Method", "notes": "n"},
    {"id": "f", "layout": "figure", "title": "The plot shows a line", "image": "fig.png", "caption": "cap", "notes": "n"},
    {"id": "ft", "layout": "figure_text", "title": "Figure with text", "image": "fig.png", "bullets": ["x", "y"],
     "crop": {"left": 0.25}, "notes": "n"},
    {"id": "tc", "layout": "two_column", "title": "Before vs after",
     "left": {"heading": "Before", "bullets": ["slow"]}, "right": {"heading": "After", "bullets": ["fast"]}, "notes": "n"},
    {"id": "c", "layout": "cards", "title": "Three ideas", "cards": [{"title": "A", "text": "a"}, {"title": "B", "text": "b"},
                                                                    {"title": "C", "text": "c"}], "notes": "n"},
    {"id": "m", "layout": "metrics", "title": "Numbers", "metrics": [{"value": "93%", "label": "acc"}], "notes": "n"},
    {"id": "p", "layout": "process", "title": "Pipeline", "steps": [{"title": "s1", "text": "t"}, {"title": "s2"}], "notes": "n"},
    {"id": "tb", "layout": "table", "title": "Table", "columns": ["Method", "Score"],
     "rows": [["Base", "0.1000"], ["Ours", "0.2000"]], "highlight_row": 2, "notes": "n"},
    {"id": "ch", "layout": "chart", "title": "Chart", "chart": {"type": "column", "categories": ["a", "b"],
                                                                "series": [{"name": "s", "values": [1, 2]}]}, "notes": "n"},
    {"id": "st", "layout": "statement", "statement": "One thing to remember", "notes": "n"},
    {"id": "e", "layout": "closing", "contacts": ["x@y"], "notes": ""},
]


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("SLIDE_TEST_TMPDIR"))
        self.root = Path(self.temp.name)
        Image.new("RGB", (1600, 1000), "white").save(self.root / "fig.png", dpi=(200, 200))

    def tearDown(self):
        self.temp.cleanup()

    def build(self, spec, **kw):
        out = self.root / "deck.pptx"
        with contextlib.redirect_stdout(io.StringIO()):
            report, code = DB.build(spec, self.root, out, **kw)
        return report, code, out

    def codes(self, report, severity="error"):
        return [i["code"] for i in report["issues"] if i["severity"] == severity]

    def test_every_layout_builds_with_notes_and_page_numbers(self):
        report, code, out = self.build(deck(FULL))
        self.assertEqual(code, 0, report["issues"])
        prs = Presentation(str(out))
        self.assertEqual(len(prs.slides), len(FULL))
        self.assertEqual(prs.slide_width, DB.Inches(DB.SLIDE_W))
        notes = [s.notes_slide.notes_text_frame.text if s.has_notes_slide else "" for s in prs.slides]
        self.assertEqual(notes[2], "n")
        texts = ["\n".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame) for s in prs.slides]
        self.assertIn("Test deck", texts[0])          # cover is never an empty colour block
        self.assertIn("3 / 14", texts[2])             # page number on content slides
        self.assertTrue(any(sh.has_table for sh in prs.slides[10].shapes))
        self.assertTrue(any(sh.has_chart for sh in prs.slides[11].shapes))

    def test_latex_residue_and_placeholders_are_errors(self):
        for bad in ["\\textbf{x}", "[0.2cm]", "$x^2$", "[图表]", "TODO: fill", "待补充"]:
            report, code, _ = self.build(deck([{"id": "x", "layout": "bullets", "title": "T",
                                                "bullets": [bad], "notes": "n"}]))
            self.assertEqual(code, 1, bad)
            self.assertTrue(set(self.codes(report)) & {"latex_residue", "placeholder"}, (bad, report["issues"]))

    def test_beamer_width_leak_bullet_is_an_error(self):
        report, code, _ = self.build(deck([{"id": "x", "layout": "bullets", "title": "T",
                                            "bullets": ["0.5", "real point"], "notes": "n"}]))
        self.assertIn("bare_number", self.codes(report))

    def test_overflow_is_reported_not_shrunk_away(self):
        long = "This sentence is deliberately long so that it wraps many times on the slide. " * 6
        report, code, _ = self.build(deck([{"id": "x", "layout": "bullets", "title": "T",
                                            "bullets": [long] * 8, "notes": "n"}]))
        self.assertEqual(code, 1)
        self.assertIn("text_overflow", self.codes(report))

    def test_short_text_gets_large_font(self):
        report, code, _ = self.build(deck([{"id": "x", "layout": "bullets", "title": "Short",
                                            "bullets": ["a", "b", "c"], "notes": "n"}]))
        self.assertEqual(code, 0)
        self.assertGreaterEqual(report["per_slide"][0]["body_pt"][0], 24)

    def test_missing_and_unsupported_images_are_errors(self):
        (self.root / "fig.pdf").write_bytes(b"%PDF-1.4")
        for ref, expected in (("nope.png", "missing_asset"), ("fig.pdf", "unsupported_image")):
            report, code, _ = self.build(deck([{"id": "x", "layout": "figure", "title": "T", "image": ref, "notes": "n"}]))
            self.assertEqual(code, 1)
            self.assertIn(expected, self.codes(report))

    def test_table_numbers_do_not_wrap(self):
        cols = ["γ", "1.5", "1.6", "1.7", "1.8", "2.0"]
        rows = [["margin μ", "−0.0540", "−0.0140", "+0.0204", "+0.0507", "+0.1000"]]
        spec = deck([{"id": "x", "layout": "table", "title": "T", "columns": cols, "rows": rows, "notes": "n"}])
        report, code, out = self.build(spec)
        self.assertEqual(code, 0)
        prs = Presentation(str(out))
        tbl = next(sh for sh in prs.slides[0].shapes if sh.has_table).table
        m = DB.Metrics("Calibri", "Microsoft YaHei")
        pt = report["per_slide"][0]["table_pt"]
        for j, col in enumerate(tbl.columns):
            need = m.width(rows[0][j], pt) + 2 * 0.14
            self.assertGreaterEqual(col.width / 914400, need * 0.97, (j, rows[0][j]))

    def test_slide_count_and_timing_are_checked(self):
        slides = [{"id": "x", "layout": "bullets", "title": "T", "bullets": ["a"], "seconds": 400, "notes": "n"}]
        report, code, _ = self.build(deck(slides, slide_count=2, talk_minutes=5))
        self.assertEqual(code, 1)
        self.assertIn("slide_count", self.codes(report))
        self.assertIn("timing", self.codes(report))

    def test_missing_notes_and_monotone_layouts_warn_and_strict_fails(self):
        slides = [{"id": f"s{i}", "layout": "bullets", "title": f"T{i}", "bullets": ["a"]} for i in range(7)]
        report, code, _ = self.build(deck(slides))
        self.assertEqual(code, 0)
        warns = self.codes(report, "warning")
        self.assertIn("missing_notes", warns)
        self.assertIn("monotone_layouts", warns)
        _, strict_code, _ = self.build(deck(slides), strict=True)
        self.assertEqual(strict_code, 1)

    def test_unknown_layout_and_bad_shapes_are_schema_errors(self):
        slides = [{"id": "a", "layout": "fancy", "title": "T", "bullets": ["a"], "notes": "n"},
                  {"id": "a", "layout": "table", "title": "T", "columns": ["a", "b"], "rows": [["1"]], "notes": "n"}]
        report, code, _ = self.build(deck(slides))
        self.assertEqual(code, 1)
        msgs = " ".join(i["message"] for i in report["issues"])
        self.assertIn("unknown layout", msgs)
        self.assertIn("duplicate slide id", msgs)
        self.assertIn("row 1 has 1 cells", msgs)

    def test_cli_writes_report_and_notes(self):
        spec = self.root / "slides.json"
        spec.write_text(json.dumps(deck(FULL[:3]), ensure_ascii=False), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            code = DB.main([str(spec), "--notes-md", str(self.root / "notes.md")])
        self.assertEqual(code, 0)
        self.assertTrue((self.root / "presentation.pptx").is_file())
        report = json.loads((self.root / "deck_report.json").read_text(encoding="utf-8"))
        self.assertTrue(report["ok"])
        self.assertIn("## Slide 3", (self.root / "notes.md").read_text(encoding="utf-8"))

    def test_paper_latex_is_normalized_for_mathtext(self):
        bs = "\\"
        cases = {
            "M_j " + bs + "ge m": "M_j " + bs + "geq m",
            bs + "tfrac{1}{2}" + bs + "big(x" + bs + "big)": bs + "frac {1}{2}(x)",
            bs + "lVert w " + bs + "rVert": bs + "| w " + bs + "|",
            bs + "displaystyle" + bs + "sum" + bs + "limits_i x_i " + bs + "tag{3}": bs + "sum_i x_i",
            "a &= b": "a = b",
        }
        for src, want in cases.items():
            self.assertEqual(DB.normalize_mathtext(src), want, src)
        self.assertEqual(DB.normalize_mathtext(bs + "geq"), bs + "geq")  # whole-name match only
        try:
            import matplotlib  # noqa: F401
        except ImportError:
            self.skipTest("matplotlib not installed")
        eq = ["p_{c,d} " + bs + "ge 1 " + bs + "Big( " + bs + "bm{x} " + bs + "Big) " + bs + bs + " y = " + bs + "tfrac{a}{b}"]
        report, code, _ = self.build(deck([{"id": "e", "layout": "equation", "title": "T", "equations": eq,
                                            "notes": "n"}]))
        self.assertEqual(code, 0, report["issues"])
        self.assertEqual(len(list((self.root / ".deck_cache").glob("eq-*.png"))), 2)  # split on the line break

    def test_svg_is_embedded_as_vector_with_png_fallback(self):
        try:
            import fitz  # noqa: F401
        except ImportError:
            self.skipTest("PyMuPDF not installed")
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">'
               '<rect x="10" y="10" width="380" height="180" rx="16" fill="#2F6FDE"/></svg>')
        (self.root / "arch.svg").write_text(svg, encoding="utf-8")
        report, code, out = self.build(deck([{"id": "f", "layout": "figure", "title": "T", "image": "arch.svg",
                                              "notes": "n"}]))
        self.assertEqual(code, 0, report["issues"])
        import zipfile
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            self.assertTrue(any(n.endswith(".svg") for n in names))
            self.assertIn("image/svg+xml", z.read("[Content_Types].xml").decode())
            slide_xml = z.read("ppt/slides/slide1.xml").decode()
        self.assertIn("svgBlip", slide_xml)
        pic = next(sh for sh in Presentation(str(out)).slides[0].shapes if sh.shape_type == 13)
        self.assertAlmostEqual(pic.width / pic.height, 2.0, places=2)  # aspect kept from the viewBox

    def test_illustration_layouts_label_ai_images(self):
        Image.new("RGB", (1536, 1024), "navy").save(self.root / "hero.png")
        Image.new("RGB", (1024, 1024), "teal").save(self.root / "card.png")
        slides = [
            {"id": "t", "layout": "title", "image": "hero.png", "ai_generated": True, "notes": "n"},
            {"id": "h", "layout": "hero", "image": "hero.png", "ai_generated": True,
             "statement": "Big events are where data is thinnest", "subtitle": "only **0.04%** positives", "notes": "n"},
            {"id": "s", "layout": "section", "title": "Method", "number": "02", "image": "hero.png",
             "ai_generated": True, "notes": "n"},
            {"id": "c", "layout": "cards", "title": "Three traps", "notes": "n", "cards": [
                {"title": "A", "text": "a", "image": "card.png", "ai_generated": True},
                {"title": "B", "text": "b", "image": "card.png", "ai_generated": True}]},
        ]
        report, code, out = self.build(deck(slides))
        self.assertEqual(code, 0, report["issues"])
        prs = Presentation(str(out))
        for i, slide in enumerate(prs.slides):
            texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame]
            self.assertTrue(any("AI-generated" in t for t in texts), i)
            self.assertTrue(any(sh.shape_type == 13 for sh in slide.shapes), i)  # a picture

    def test_hero_requires_image_and_unlabeled_ai_images_warn(self):
        report, code, _ = self.build(deck([{"id": "h", "layout": "hero", "statement": "x", "notes": "n"}]))
        self.assertEqual(code, 1)
        self.assertIn("empty_content", self.codes(report))
        (self.root / "somni-images").mkdir()
        Image.new("RGB", (800, 500), "navy").save(self.root / "somni-images" / "a.png")
        report, code, _ = self.build(deck([{"id": "f", "layout": "figure", "title": "T",
                                            "image": "somni-images/a.png", "notes": "n"}]))
        self.assertIn("ai_image_unlabeled", self.codes(report, "warning"))

    def test_cjk_wrapping_counts_more_lines_in_narrow_boxes(self):
        m = DB.Metrics("Microsoft YaHei", "Microsoft YaHei")
        text = "逆强化学习的根本困难在于没有答案可以对照，非线性对象没有解析解"
        self.assertGreater(DB.count_lines(m, text, 3.0, 24), DB.count_lines(m, text, 12.0, 24))
        self.assertEqual(DB.count_lines(m, "short", 12.0, 24), 1)


if __name__ == "__main__":
    unittest.main()
