SomniQ Figures uses SVG-Edit 7.4.2, bundled locally from the exact npm lockfile.
SVG-Edit: https://github.com/SVG-Edit/svgedit — MIT license.
The redistributed editor includes LICENSE-MIT.txt and the upstream licenseInfo.json.
Its core dependency @svgedit/svgcanvas is also MIT licensed.

Local export libraries: resvg 0.45.1 (https://github.com/linebender/resvg)
and svg2pdf 0.13.0 (https://github.com/typst/svg2pdf), both MIT or Apache-2.0.
The included licenses directory contains their MIT texts and svg2pdf NOTICE.

The figure workflow is inspired by AutoFigure-Edit:
https://github.com/ResearAI/AutoFigure-Edit/tree/16f3749e9d512bdf7b7b55c162307bc289750b7a
SomniQ's implementation reuses its own runtime, model clients and image service.
No upstream segmentation/removal service or Python backend is included.
No upstream model weights or icon datasets are distributed.
