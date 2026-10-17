import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("slide_quality", Path(__file__).parents[1] / "tools" / "slide_quality.py")
QUALITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUALITY)


class DeliveryGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("SLIDE_TEST_TMPDIR"))
        self.root = Path(self.temp.name)
        self.content = self.record("slides.json", b'{"title":"experiment"}')
        self.log = {"id": "current", "kind": "log", "run_id": "arm-k2", **self.record("current.log", b'seed 0: error 0.006%')}
        self.figure = {"id": "figure", "kind": "figure", "run_id": "arm-k2", **self.record("figure.png", b'local figure bytes')}
        self.make_pptx()
        self.artifacts = {"pptx": self.record("deck.pptx"), "pdf": self.record("deck.pdf", b'PDF inspection is patched only in these unit fixtures')}
        for artifact in self.artifacts.values():
            artifact["content_sha256"] = self.content["sha256"]
        self.hashes = {key: value["sha256"] for key, value in self.artifacts.items()}
        reviewer = {"reviewer": "independent-reviewer", "executor": "executor", "verdict": "ready", "blockers": [], "artifact_sha256": self.hashes}
        self.review = self.record("review.json", json.dumps(reviewer).encode())
        self.manifest = {"schema_version": 1, "status": "in_review", "requested_slide_count": 2,
                         "content_source": self.content,
                         "timing": {"slot_seconds": 1500, "qa_seconds": 240},
                         "slides": [{"id": 1, "seconds": 1260, "run_id": "arm-k2",
                                     "evidence": [{"source_id": "current"}, {"source_id": "figure"}],
                                     "metrics": [{"source_id": "current", "kind": "measured", "quote": "error 0.006%"}]},
                                    {"id": 2, "seconds": 0, "backup": True}],
                         "sources": [self.log, self.figure], "artifacts": self.artifacts,
                         "rendered_artifact_sha256": self.hashes,
                         "renders": {fmt: [{"slide": i, **self.record(f"{fmt}-{i}.png", b'preview bytes')} for i in (1, 2)] for fmt in ("pdf", "pptx")},
                         "visual_review": {fmt: {"artifact_sha256": self.hashes[fmt], "pages": [{"slide": i, "verdict": "pass", "issues": []} for i in (1, 2)]} for fmt in ("pdf", "pptx")},
                         "independent_review": self.review}
        # These fixtures exercise delivery policy, not a third-party PDF parser.
        self.pdf_patch = patch.object(QUALITY, "pdf_page_count", return_value=2)
        self.pdf_patch.start()

    def tearDown(self):
        self.pdf_patch.stop()
        self.temp.cleanup()

    def record(self, name, data=None):
        target = self.root / name
        if data is not None:
            target.write_bytes(data)
        return {"path": name, "sha256": QUALITY.sha256(target)}

    def make_pptx(self, x=10):
        p, a, r = QUALITY.NS["p"], QUALITY.NS["a"], QUALITY.NS["r"]
        with zipfile.ZipFile(self.root / "deck.pptx", "w") as archive:
            archive.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{p}" xmlns:r="{r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="100000" cy="100000"/></p:presentation>')
            archive.writestr("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="rId1" Target="slides/slide7.xml"/><Relationship Id="rId2" Target="slides/slide3.xml"/></Relationships>')
            for n, text in ((7, "current experiment"), (3, "backup")):
                archive.writestr(f"ppt/slides/slide{n}.xml", f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="body"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{x}" y="10"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')

    def audit(self, stage="final"):
        return QUALITY.audit(self.manifest, self.root, stage)

    def assert_blocked(self, substring):
        result = self.audit()
        self.assertFalse(result["ready_to_present"])
        self.assertTrue(any(substring in error for error in result["errors"]), result)

    def test_complete_review_binds_both_formats_and_main_plus_backup(self):
        self.assertTrue(self.audit()["ready_to_present"])
        inventory = QUALITY.pptx_inventory(self.root / "deck.pptx")
        self.assertEqual(inventory["slides"][0]["text"], "current experiment")

    def test_qa_is_part_of_the_slot(self):
        self.manifest["slides"][0]["seconds"] = 1500
        self.assert_blocked("plus Q&A")

    def test_backup_time_cannot_hide_in_main_budget(self):
        self.manifest["slides"][1]["seconds"] = 60
        self.assert_blocked("backup slides")

    def test_outside_slot_requires_user_agreement(self):
        self.manifest["timing"]["qa_policy"] = "outside_slot"
        self.assert_blocked("agreed timing note")

    def test_different_system_figure_does_not_support_current_run(self):
        self.manifest["sources"][1]["run_id"] = "linear-old"
        self.assert_blocked("run mismatch")

    def test_comparison_needs_visible_label_not_just_notes(self):
        self.manifest["slides"][0]["evidence"][1].update(role="comparison", visible_label="old linear system")
        self.assert_blocked("actual visible label")

    def test_wrong_metric_excerpt_is_rejected(self):
        self.manifest["slides"][0]["metrics"][0]["quote"] = "error 0.005%"
        self.assert_blocked("matching source excerpt")

    def test_script_self_report_is_not_measured_evidence(self):
        self.manifest["sources"][0]["kind"] = "script"
        self.assert_blocked("cannot substantiate")

    def test_modified_source_requires_new_evidence_review(self):
        (self.root / "current.log").write_bytes(b'changed output')
        self.assert_blocked("stale SHA256")

    def test_pdf_page_count_must_match_exactly(self):
        QUALITY.pdf_page_count.return_value = 3
        self.assert_blocked("actual page count 3")

    def test_every_format_needs_every_render(self):
        self.manifest["renders"]["pptx"].pop()
        self.assert_blocked("one render for every page")

    def test_render_and_visual_review_are_invalid_after_artifact_change(self):
        self.manifest["rendered_artifact_sha256"]["pdf"] = "old"
        self.manifest["visual_review"]["pdf"]["artifact_sha256"] = "old"
        self.assert_blocked("renders belong to a different artifact")
        self.assert_blocked("visual review is stale")

    def test_needs_revision_cannot_be_marked_ready(self):
        report = json.loads((self.root / "review.json").read_text())
        report["verdict"] = "needs_revision"
        self.manifest["independent_review"] = self.record("review.json", json.dumps(report).encode())
        self.assert_blocked("requires revision")

    def test_missing_or_self_review_is_not_independent(self):
        self.manifest["independent_review"] = None
        self.assert_blocked("independent review")
        report = {"reviewer": "same", "executor": "same", "verdict": "ready", "blockers": [], "artifact_sha256": self.hashes}
        self.manifest["independent_review"] = self.record("review.json", json.dumps(report).encode())
        self.assert_blocked("separate reviewer")

    def test_out_of_canvas_shape_is_a_blocker(self):
        self.make_pptx(x=200000)
        self.manifest["artifacts"]["pptx"].update(self.record("deck.pptx"))
        self.assert_blocked("object outside canvas")

    def test_draft_check_does_not_masquerade_as_final(self):
        self.manifest.pop("independent_review")
        self.assertTrue(self.audit("draft")["passed"])
        self.assertFalse(self.audit("draft")["ready_to_present"])
        self.manifest["status"] = "completed"
        self.assertFalse(self.audit("draft")["passed"])

    def test_report_cannot_overwrite_a_source(self):
        target = self.root / "manifest.json"
        target.write_text(json.dumps(self.manifest), encoding="utf-8")
        original = (self.root / "current.log").read_bytes()
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            QUALITY.main([str(target), "--stage", "draft", "--report", str(self.root / "current.log")])
        self.assertEqual(original, (self.root / "current.log").read_bytes())

    def test_pending_review_can_write_draft_and_blocked_final_reports(self):
        self.manifest["independent_review"] = None
        self.manifest["status"] = "draft_pending_review"
        target = self.root / "manifest.json"
        target.write_text(json.dumps(self.manifest), encoding="utf-8")
        for stage, expected_exit in (("draft", 0), ("final", 1)):
            report_path = self.root / f"{stage}-report.json"
            with contextlib.redirect_stdout(io.StringIO()):
                result = QUALITY.main([str(target), "--stage", stage, "--report", str(report_path)])
            self.assertEqual(result, expected_exit)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertFalse(report["ready_to_present"])
            if stage == "final":
                self.assertEqual(report["errors"], ["independent review: path and SHA256 required"])


if __name__ == "__main__":
    unittest.main()
