"""Build the versioned research template from Pandoc's own reference DOCX.

Requires Pandoc and python-docx. No document parser or layout engine is defined here.
"""
import argparse
from pathlib import Path
import subprocess

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor


def build(pandoc: str, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([pandoc, '-o', str(output), '--print-default-data-file', 'reference.docx'], check=True)
    document = Document(output)
    for section in document.sections:
        section.page_width, section.page_height = Mm(210), Mm(297)
        section.top_margin = section.bottom_margin = Mm(25.4)
        section.left_margin = section.right_margin = Mm(25.4)
    for name in ('Normal', 'Body Text', 'First Paragraph', 'Compact', 'Title', 'Subtitle',
                 'Caption', 'Table Caption', 'Image Caption', 'Bibliography',
                 *(f'Heading {level}' for level in range(1, 10))):
        if name not in document.styles:
            continue
        style = document.styles[name]
        style.font.name = 'Times New Roman'
        style.font.size = Pt(12)
        style.font.color.rgb = RGBColor(0, 0, 0)
        # python-docx exposes latin fonts publicly; East Asian mapping is one
        # isolated, explicit template attribute, not a second OOXML formatter.
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '宋体')
        # Theme attributes take precedence when both are present on rFonts.
        for theme in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme'):
            style.element.rPr.rFonts.attrib.pop(qn('w:' + theme), None)
        fmt = style.paragraph_format
        fmt.line_spacing = 1.5
        fmt.widow_control = True
        if name.startswith('Heading'):
            level = int(name.split()[-1])
            style.font.size = Pt({1: 16, 2: 14}.get(level, 12))
            style.font.bold = True
            style.element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
            fmt.keep_with_next = True
            fmt.space_before, fmt.space_after = Pt(12), Pt(6)
        elif name == 'Title':
            style.font.size = Pt(20)
            style.font.bold = True
            fmt.keep_with_next = True
        elif name in ('Body Text', 'First Paragraph', 'Normal'):
            fmt.space_before, fmt.space_after = Pt(0), Pt(6)
        elif name == 'Table Caption':
            fmt.keep_with_next = True
    document.core_properties.title = 'SomniQ research document reference'
    document.core_properties.author = 'SomniQ Studio'
    document.save(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pandoc', default='pandoc')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.pandoc, args.output)
