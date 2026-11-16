#!/usr/bin/env python3
"""Render an exported PPTX to per-page PNGs, a contact sheet and (optionally) a PDF.

    python3 render_deck.py presentation.pptx --out renders/ [--pdf presentation.pdf] [--width 1600]
    python3 render_deck.py presentation.pdf  --out renders-pdf/      # PDF pages (PyMuPDF / pdftoppm)

Renderer order: Microsoft PowerPoint via COM (Windows) -> LibreOffice ``soffice``
(any OS, PDF then PyMuPDF/pdftoppm to PNG). The renderer actually used is
printed and written to ``renders/render.json`` so reports never claim
PowerPoint was tested when it was not.

Exit status: 0 = rendered; 1 = no renderer available or rendering failed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PS_SCRIPT = r"""
param([string]$Pptx, [string]$OutDir, [int]$Width, [string]$Pdf)
$ErrorActionPreference = "Stop"
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open($Pptx, $true, $false, $false)
  $h = [int]($Width * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
  $i = 1
  foreach ($s in $pres.Slides) {
    $s.Export((Join-Path $OutDir ("slide-{0:D2}.png" -f $i)), "PNG", $Width, $h)
    $i++
  }
  if ($Pdf -ne "") { $pres.SaveAs($Pdf, 32) }
  $pres.Close()
  Write-Output "rendered $($i-1)"
} finally { $app.Quit() }
"""


def _env():
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def _hidden():
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}


def render_powerpoint(pptx: Path, out: Path, width: int, pdf: Path | None) -> bool:
    if sys.platform != "win32" or not shutil.which("powershell"):
        return False
    with tempfile.TemporaryDirectory() as td:
        ps = Path(td) / "render.ps1"
        ps.write_text(PS_SCRIPT, encoding="utf-8-sig")
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
               "-Pptx", str(pptx), "-OutDir", str(out), "-Width", str(width), "-Pdf", str(pdf or "")]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=_env(), **_hidden())
        except (OSError, subprocess.TimeoutExpired):
            return False
    return r.returncode == 0 and any(out.glob("slide-*.png"))


def _soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        p = shutil.which(name)
        if p:
            return p
    for p in (r"C:\Program Files\LibreOffice\program\soffice.exe",
              "/Applications/LibreOffice.app/Contents/MacOS/soffice"):
        if Path(p).is_file():
            return p
    return None


def pdf_to_pngs(pdf: Path, out: Path, width: int) -> bool:
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(str(pdf))
        for i, page in enumerate(doc, 1):
            zoom = width / page.rect.width
            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).save(str(out / f"slide-{i:02d}.png"))
        return True
    except ImportError:
        pass
    if shutil.which("pdftoppm"):
        r = subprocess.run(["pdftoppm", "-png", "-scale-to-x", str(width), "-scale-to-y", "-1", str(pdf),
                            str(out / "page")], capture_output=True)
        if r.returncode == 0:
            for i, p in enumerate(sorted(out.glob("page-*.png")), 1):
                p.rename(out / f"slide-{i:02d}.png")
            return True
    return False


def render_libreoffice(pptx: Path, out: Path, width: int, pdf: Path | None) -> bool:
    exe = _soffice()
    if not exe:
        return False
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([exe, "--headless", "--convert-to", "pdf", "--outdir", td, str(pptx)],
                           capture_output=True, timeout=600, **_hidden())
        produced = Path(td) / (pptx.stem + ".pdf")
        if r.returncode != 0 or not produced.is_file():
            return False
        if pdf:
            shutil.copyfile(produced, pdf)
        return pdf_to_pngs(produced, out, width)


def contact_sheet(out: Path, cols: int = 4) -> Path | None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    files = sorted(out.glob("slide-*.png"))
    if not files:
        return None
    first = Image.open(files[0])
    w = 480
    h = int(w * first.height / first.width)
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 10) + 10, rows * (h + 28) + 10), "#8A8F98")
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(files):
        x, y = 10 + (i % cols) * (w + 10), 10 + (i // cols) * (h + 28)
        with Image.open(f) as im:
            sheet.paste(im.convert("RGB").resize((w, h)), (x, y + 18))
        d.text((x, y + 2), str(i + 1), fill="white")
    p = out / "contact-sheet.png"
    sheet.save(p)
    return p


def review_sheets(out: Path, per_sheet: int = 4, width: int = 2000) -> list[Path]:
    """2x2 grids at ~1000 px per slide: every page readable in a quarter of the image
    budget. Use these to inspect all pages; open slide-NN.png for anything doubtful."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return []
    for old in out.glob("review-*.png"):
        old.unlink()
    files = sorted(out.glob("slide-*.png"))
    if not files:
        return []
    cell_w = width // 2
    with Image.open(files[0]) as f0:
        cell_h = int(cell_w * f0.height / f0.width)
    sheets = []
    for n, start in enumerate(range(0, len(files), per_sheet), 1):
        chunk = files[start:start + per_sheet]
        rows = (len(chunk) + 1) // 2
        sheet = Image.new("RGB", (width + 12, rows * (cell_h + 34) + 6), "#5B616B")
        d = ImageDraw.Draw(sheet)
        for i, f in enumerate(chunk):
            x, y = 4 + (i % 2) * (cell_w + 4), 4 + (i // 2) * (cell_h + 34)
            with Image.open(f) as im:
                sheet.paste(im.convert("RGB").resize((cell_w, cell_h)), (x, y + 30))
            d.text((x + 4, y + 8), f"slide {start + i + 1}", fill="white")
        p = out / f"review-{n:02d}.png"
        sheet.save(p)
        sheets.append(p)
    return sheets


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("--out", default=None, help="directory for slide-NN.png (default: renders/ next to pptx)")
    ap.add_argument("--pdf", default=None, help="also export a PDF of the PPTX here")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--renderer", choices=["auto", "powerpoint", "libreoffice"], default="auto")
    a = ap.parse_args(argv)
    pptx = Path(a.pptx).resolve()
    if not pptx.is_file():
        print(f"ERROR: {pptx} not found", file=sys.stderr)
        return 1
    out = Path(a.out).resolve() if a.out else pptx.parent / "renders"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("slide-*.png"):
        old.unlink()
    pdf = Path(a.pdf).resolve() if a.pdf else None
    used = None
    if pptx.suffix.lower() == ".pdf":
        if pdf_to_pngs(pptx, out, a.width):
            used = "PDF rasterizer (PyMuPDF/pdftoppm)"
        pdf = None
    elif a.renderer in ("auto", "powerpoint") and render_powerpoint(pptx, out, a.width, pdf):
        used = "Microsoft PowerPoint (COM)"
    elif a.renderer in ("auto", "libreoffice") and render_libreoffice(pptx, out, a.width, pdf):
        used = "LibreOffice (soffice headless)"
    if not used and pptx.suffix.lower() == ".pdf":
        print("ERROR: rendering a PDF needs PyMuPDF (pip install pymupdf) or pdftoppm", file=sys.stderr)
        return 1
    if not used:
        print("ERROR: no presentation renderer available (need PowerPoint on Windows or LibreOffice). "
              "PPTX visual validation is pending -- keep the deck in draft status.", file=sys.stderr)
        return 1
    pages = sorted(out.glob("slide-*.png"))
    sheet = contact_sheet(out)
    reviews = review_sheets(out)
    info = {"renderer": used, "pptx": str(pptx), "pages": [p.name for p in pages],
            "review_sheets": [p.name for p in reviews],
            "contact_sheet": sheet.name if sheet else None, "pdf": str(pdf) if pdf else None}
    (out / "render.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"rendered {len(pages)} pages with {used} -> {out}" + (f"; PDF {pdf}" if pdf else ""))
    if reviews:
        print("Inspect every page via " + ", ".join(p.name for p in reviews)
              + " (4 slides each); open slide-NN.png at full size for figures, tables, equations"
              " and anything doubtful. contact-sheet.png is for flow only.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
