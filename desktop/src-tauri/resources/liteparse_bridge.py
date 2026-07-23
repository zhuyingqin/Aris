"""Small JSON bridge between SomniQ Studio and LiteParse.

The desktop invokes this script only when a Python environment containing
``liteparse`` is available. It intentionally performs no embedding, network
request, vector indexing, or answer generation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def safe_component(value: object) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-.")
    return normalized or "asset"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--no-ocr", action="store_true")
    args = parser.parse_args()

    try:
        from liteparse import LiteParse
    except Exception as exc:  # pragma: no cover - depends on local environment
        print(json.dumps({"error": f"liteparse import failed: {exc}"}), file=sys.stderr)
        return 2

    pdf_path = Path(args.pdf).resolve(strict=True)
    asset_dir = Path(args.asset_dir).resolve()
    asset_dir.mkdir(parents=True, exist_ok=True)
    liteparse = LiteParse(
        ocr_enabled=not args.no_ocr,
        dpi=args.dpi,
        image_mode="embed",
        output_format="json",
        quiet=True,
    )
    result = liteparse.parse(pdf_path)

    pages = [
        {
            "page": int(page.page_num),
            "width": float(page.width),
            "height": float(page.height),
            "text": page.text or "",
            "textItems": len(page.text_items),
        }
        for page in result.pages
    ]
    assets = []
    for image in result.images:
        extension = safe_component(image.format).lower()
        asset_key = f"p{int(image.page)}-{safe_component(image.id)}"
        target = asset_dir / f"{asset_key}.{extension}"
        image_bytes = bytes(image.bytes)
        target.write_bytes(image_bytes)
        assets.append(
            {
                "sourceId": str(image.id),
                "page": int(image.page),
                "format": extension,
                "mimeType": f"image/{extension}",
                "path": str(target),
                "contentHash": hashlib.sha256(image_bytes).hexdigest(),
            }
        )

    print(
        json.dumps(
            {
                "engine": "liteparse-python-sdk",
                "ocrEnabled": not args.no_ocr,
                "pages": pages,
                "assets": assets,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - returned to Rust as fallback reason
        print(json.dumps({"error": f"liteparse parse failed: {exc}"}), file=sys.stderr)
        raise SystemExit(1)
