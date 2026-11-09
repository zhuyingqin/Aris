#!/usr/bin/env python3
"""Check local slide delivery evidence; never edit source files or call models.

Draft checks are useful before review, but cannot authorize status=completed.
Final checks bind every review and render to the exact delivered PDF/PPTX.
See ../references/quality-contract.md for the manifest contract.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pdf_page_count(path):
    for name in ("pypdf", "fitz"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        if name == "pypdf":
            return len(module.PdfReader(str(path)).pages)
        with module.open(str(path)) as doc:
            return len(doc)
    binary = shutil.which("pdfinfo")
    if not binary:
        raise ValueError("PDF page check requires pypdf, PyMuPDF or pdfinfo")
    result = subprocess.run([binary, str(path)], capture_output=True, timeout=30,
                            check=True, encoding="utf-8", errors="replace")
    match = re.search(r"^Pages:\s*(\d+)\s*$", result.stdout, re.MULTILINE)
    if not match:
        raise ValueError("pdfinfo did not report a page count")
    return int(match.group(1))


def pptx_inventory(path):
    """Use presentation order (not slideN filenames) and actual object bounds."""
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = root.find("p:sldSz", NS)
        width, height = int(size.get("cx")), int(size.get("cy"))
        if width <= 0 or height <= 0:
            raise ValueError("invalid PPTX canvas")
        rels = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        slides = []
        for ref in root.findall("p:sldIdLst/p:sldId", NS):
            target = targets[ref.get(f'{{{NS["r"]}}}id')]
            from posixpath import normpath
            member = normpath("ppt/" + target) if not target.startswith("/") else target.lstrip("/")
            xml = ET.fromstring(archive.read(member))
            objects = []
            for item in xml.findall("p:cSld/p:spTree/*", NS):
                transform = item.find("p:spPr/a:xfrm", NS)
                if transform is None:
                    transform = item.find("p:xfrm", NS)
                if transform is None:
                    continue
                offset, extent = transform.find("a:off", NS), transform.find("a:ext", NS)
                if offset is None or extent is None:
                    continue
                ident = next(iter(item.findall(".//p:cNvPr", NS)), None)
                box = [int(offset.get("x")), int(offset.get("y")),
                       int(extent.get("cx")), int(extent.get("cy"))]
                objects.append({"id": ident.get("id") if ident is not None else "?",
                                "name": ident.get("name") if ident is not None else "?",
                                "box": box})
            slides.append({"text": "\n".join(e.text or "" for e in xml.findall(".//a:t", NS)),
                           "objects": objects})
        return {"width": width, "height": height, "slides": slides}


def audit(manifest, base, stage="final"):
    errors, warnings = [], []
    base = Path(base)

    def fail(message):
        errors.append(message)

    def checked_file(entry, label):
        if not isinstance(entry, dict) or not entry.get("path") or not entry.get("sha256"):
            fail(f"{label}: path and SHA256 required")
            return None
        target = Path(entry["path"])
        if not target.is_absolute():
            target = base / target
        if not target.is_file():
            fail(f"{label}: file missing: {target}")
            return None
        if sha256(target) != entry["sha256"]:
            fail(f"{label}: stale SHA256")
            return None
        return target

    if manifest.get("schema_version") != 1:
        fail("schema_version must be 1")
    slides = manifest.get("slides", [])
    if not slides or [s.get("id") for s in slides] != list(range(1, len(slides) + 1)):
        fail("slides must have contiguous one-based ids in delivery order")
    count = len(slides)
    if manifest.get("requested_slide_count") != count:
        fail("requested slide count must match all main and backup slides")
    checked_file(manifest.get("content_source"), "content source")
    timing = manifest.get("timing", {})
    numbers = [timing.get("slot_seconds"), timing.get("qa_seconds")] + [s.get("seconds") for s in slides]
    if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or n < 0 for n in numbers):
        fail("timing values must be finite nonnegative numbers")
    else:
        main = sum(s["seconds"] for s in slides if not s.get("backup"))
        if main <= 0 or timing["slot_seconds"] <= 0:
            fail("main talk and time slot must be positive")
        if any(s["seconds"] != 0 for s in slides if s.get("backup")):
            fail("backup slides must have zero scheduled main-talk seconds")
        outside = timing.get("qa_policy") == "outside_slot"
        if outside and not timing.get("agreement_note"):
            fail("Q&A outside the slot needs the user's agreed timing note")
        if main + (0 if outside else timing["qa_seconds"]) > timing["slot_seconds"]:
            fail("main talk plus Q&A exceeds the agreed slot")
        if not outside and timing["qa_seconds"] <= 0:
            fail("reserve Q&A time or record the agreed outside-slot policy")

    source_map, source_text = {}, {}
    for src in manifest.get("sources", []):
        sid = src.get("id")
        if not sid or sid in source_map:
            fail(f"source id missing or duplicated: {sid}")
            continue
        source_map[sid] = src
        if src.get("kind") not in ("log", "figure", "script", "document"):
            fail(f"source {sid}: kind must be log, figure, script or document")
        target = checked_file(src, f"source {sid}")
        if target and src.get("kind") != "figure":
            source_text[sid] = target.read_text(encoding=src.get("encoding", "utf-8"), errors="replace")

    artifacts = manifest.get("artifacts", {})
    inventory = None
    artifact_hashes = {}
    for fmt in ("pdf", "pptx"):
        entry = artifacts.get(fmt)
        target = checked_file(entry, fmt)
        if target:
            artifact_hashes[fmt] = entry["sha256"]
            if entry.get("content_sha256") != manifest.get("content_source", {}).get("sha256"):
                fail(f"{fmt}: build used a different content source")
            try:
                if fmt == "pdf":
                    actual_count = pdf_page_count(target)
                else:
                    inventory = pptx_inventory(target)
                    actual_count = len(inventory["slides"])
                if actual_count != count:
                    fail(f"{fmt}: actual page count {actual_count} differs from {count}")
            except Exception as exc:
                fail(f"{fmt}: cannot inspect artifact: {exc}")

    for slide in slides:
        label = f"slide {slide.get('id')}"
        for evidence in slide.get("evidence", []):
            sid = evidence.get("source_id")
            src = source_map.get(sid)
            if not src:
                fail(f"{label}: unknown source {sid}")
                continue
            role = evidence.get("role", "primary")
            if role not in ("primary", "comparison", "method"):
                fail(f"{label}: invalid evidence role {role}")
            if role == "primary" and src.get("kind") in ("log", "figure"):
                if not slide.get("run_id") or src.get("run_id") != slide["run_id"]:
                    fail(f"{label}: primary figure/data run mismatch ({sid})")
            if role == "comparison":
                caption = evidence.get("visible_label", "")
                idx = slide.get("id", 0) - 1
                text = inventory["slides"][idx]["text"] if inventory and 0 <= idx < len(inventory["slides"]) else ""
                if not caption or caption not in text:
                    fail(f"{label}: comparison {sid} needs an actual visible label")
        for metric in slide.get("metrics", []):
            sid, quote = metric.get("source_id"), metric.get("quote")
            if sid not in {e.get("source_id") for e in slide.get("evidence", [])}:
                fail(f"{label}: metric source is not in the evidence map ({sid})")
            if not quote or quote not in source_text.get(sid, ""):
                fail(f"{label}: metric has no matching source excerpt ({sid})")
            if metric.get("kind") == "measured" and source_map.get(sid, {}).get("kind") != "log":
                fail(f"{label}: script/design cannot substantiate a measured result ({sid})")

    if inventory:
        for i, slide in enumerate(inventory["slides"], 1):
            for obj in slide["objects"]:
                x, y, w, h = obj["box"]
                if min(w, h) < 0 or x < -12700 or y < -12700 or x+w > inventory["width"]+12700 or y+h > inventory["height"]+12700:
                    fail(f"slide {i}: object outside canvas: {obj['name']}")
        warnings.append("Object bounds do not detect all text, chart-label or group-internal overflow; inspect every rendered page.")

    if stage == "final":
        for fmt in ("pdf", "pptx"):
            records = manifest.get("renders", {}).get(fmt, [])
            if [r.get("slide") for r in records] != list(range(1, count+1)):
                fail(f"{fmt}: need one render for every page in order")
            if manifest.get("rendered_artifact_sha256", {}).get(fmt) != artifact_hashes.get(fmt):
                fail(f"{fmt}: renders belong to a different artifact")
            for render in records:
                checked_file(render, f"{fmt} render {render.get('slide')}")
            review = manifest.get("visual_review", {}).get(fmt, {})
            if review.get("artifact_sha256") != artifact_hashes.get(fmt):
                fail(f"{fmt}: visual review is stale")
            pages = review.get("pages", [])
            if [p.get("slide") for p in pages] != list(range(1, count+1)) or any(p.get("verdict") != "pass" or p.get("issues") for p in pages):
                fail(f"{fmt}: visual review missing, incomplete or has unresolved issues")

        report_path = checked_file(manifest.get("independent_review"), "independent review")
        if report_path:
            try:
                report = json.loads(report_path.read_text(encoding="utf-8-sig"))
                if not report.get("reviewer") or not report.get("executor") or report["reviewer"] == report["executor"]:
                    fail("independent review must identify a separate reviewer")
                if report.get("verdict") != "ready" or report.get("blockers") != []:
                    fail("independent review requires revision")
                if report.get("artifact_sha256") != artifact_hashes:
                    fail("independent review did not review the current PDF and PPTX")
            except (ValueError, OSError) as exc:
                fail(f"independent review: invalid report: {exc}")
    elif manifest.get("status") == "completed":
        fail("draft checks cannot authorize completed status; run final checks")

    return {"schema_version": 1, "stage": stage, "passed": not errors,
            "ready_to_present": stage == "final" and not errors,
            "status": "completed" if stage == "final" and not errors else "draft_checked" if not errors else "needs_revision",
            "errors": errors, "warnings": warnings, "artifact_sha256": artifact_hashes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--stage", choices=("draft", "final"), default="final")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    try:
        result = audit(json.loads(args.manifest.read_text(encoding="utf-8-sig")), args.manifest.parent, args.stage)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        result = {"passed": False, "ready_to_present": False, "status": "needs_revision", "errors": [str(exc)]}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        # Refuse to overwrite any input, including the manifest or a source.
        inputs = {args.manifest.resolve()}
        try:
            data = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
            entries = [data.get("content_source", {})] + data.get("sources", []) + list(data.get("artifacts", {}).values()) + [data.get("independent_review", {})]
            for e in entries:
                if not isinstance(e, dict):
                    continue
                if e.get("path"):
                    p = Path(e["path"])
                    inputs.add((p if p.is_absolute() else args.manifest.parent / p).resolve())
            for records in data.get("renders", {}).values():
                for e in records:
                    p = Path(e["path"])
                    inputs.add((p if p.is_absolute() else args.manifest.parent / p).resolve())
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if args.report.resolve() in inputs:
            parser.error("report path must not overwrite an input")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
