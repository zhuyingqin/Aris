"""Content/complex-object regressions for the bounded python-docx adapter."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('formatter', ROOT / 'crates/runtime/assets/docx/format_docx.py')
formatter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(formatter)


def parts(path):
    with ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


class FormatDocxTests(unittest.TestCase):
    def test_formats_body_and_hyperlink_runs_without_changing_math_or_other_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
            doc = Document()
            paragraph = doc.add_paragraph('保留 7 人和原生公式 ')
            fonts = paragraph.runs[0]._r.get_or_add_rPr().get_or_add_rFonts()
            for theme in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme'):
                fonts.set(qn('w:' + theme), 'majorEastAsia' if theme == 'eastAsiaTheme' else 'majorHAnsi')
            link = OxmlElement('w:hyperlink')
            link.set(qn('w:anchor'), 'local')
            run, text = OxmlElement('w:r'), OxmlElement('w:t')
            text.text = '链接文字'
            run.append(text)
            link.append(run)
            paragraph._p.append(link)
            math = OxmlElement('m:oMath')
            run, text = OxmlElement('m:r'), OxmlElement('m:t')
            text.text = 'x+1'
            run.append(text)
            math.append(run)
            paragraph._p.append(math)
            doc.add_table(rows=1, cols=1).cell(0, 0).text = '表格内容不变'
            doc.sections[0].header.paragraphs[0].text = '页眉不变'
            doc.save(source)
            before = parts(source)
            formatter.format_document(source, output, {'operations': [{
                'paragraph_id': 'word/document.xml:p1', 'font_size_pt': 14,
                'font_name': 'Times New Roman', 'east_asia_font': '宋体', 'line_spacing': 1.5}]})
            after = parts(output)
            self.assertEqual(set(before), set(after))
            for name, data in before.items():
                if name != 'word/document.xml':
                    self.assertEqual(data, after[name], name)
            a, b = [etree.fromstring(package['word/document.xml']) for package in (before, after)]
            self.assertEqual(formatter.signature(a), formatter.signature(b))
            result = Document(output)
            self.assertEqual(result.paragraphs[0].runs[0].font.size.pt, 14)
            self.assertEqual(result.paragraphs[0].hyperlinks[0].runs[0].font.size.pt, 14)
            attributes = result.paragraphs[0].runs[0]._r.rPr.rFonts.attrib
            self.assertFalse(any(qn('w:' + theme) in attributes for theme in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme')))

    def test_protected_content_and_invalid_second_operation_never_publish_partial_output(self):
        for tag in ('sdt', 'ins', 'fldSimple', None):
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
                doc = Document()
                paragraph = doc.add_paragraph('完整保留这段话')
                if tag:
                    paragraph._p.append(OxmlElement('w:' + tag))
                doc.save(source)
                original = source.read_bytes()
                operations = [{'paragraph_id': 'word/document.xml:p1', 'font_size_pt': 14}]
                if not tag:
                    operations.append({'paragraph_id': 'word/document.xml:p999', 'font_size_pt': 14})
                with self.assertRaises(ValueError):
                    formatter.format_document(source, output, {'operations': operations})
                self.assertFalse(output.exists())
                self.assertEqual(source.read_bytes(), original)

    def test_deletion_uses_original_ids_and_preserves_every_other_child_and_part(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
            doc = Document()
            doc.add_paragraph('first duplicate')
            doc.add_paragraph('retained text').add_run(' in a separate run')
            doc.add_paragraph('second duplicate')
            table = doc.add_table(rows=1, cols=1)
            table.cell(0, 0).text = 'table survives'
            paragraph = doc.add_paragraph('native math survives ')
            math, run, text = (OxmlElement(tag) for tag in ('m:oMath', 'm:r', 'm:t'))
            text.text = 'x+1'
            run.append(text)
            math.append(run)
            paragraph._p.append(math)
            doc.sections[0].header.paragraphs[0].text = 'header survives'
            doc.save(source)
            before = parts(source)
            original_root = etree.fromstring(before['word/document.xml'])
            body = original_root.find(qn('w:body'))
            expected = [etree.tostring(child, method='c14n') for i, child in enumerate(body) if i not in (0, 2)]
            count = formatter.delete_paragraphs(source, output, {'deletions': [
                {'paragraph_id': 'word/document.xml:p3', 'expected_text': 'second duplicate'},
                {'paragraph_id': 'word/document.xml:p1', 'expected_text': 'first duplicate'}]})
            self.assertEqual(count, 2)
            after = parts(output)
            self.assertEqual(set(before), set(after))
            for name, data in before.items():
                if name != 'word/document.xml':
                    self.assertEqual(data, after[name], name)
            actual = etree.fromstring(after['word/document.xml']).find(qn('w:body'))
            self.assertEqual(expected, [etree.tostring(child, method='c14n') for child in actual])

    def test_invalid_deletion_batch_preserves_existing_output_and_source(self):
        batches = [
            [(1, 'remove me'), (2, 'incorrect text')],
            [(1, 'remove me'), (1, 'remove me')],
            [(1, 'remove me'), (999, 'missing')],
            [(1, 'remove me'), (3, 'table cell')],
        ]
        for batch in batches:
            with self.subTest(batch=batch), tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
                doc = Document()
                doc.add_paragraph('remove me')
                doc.add_paragraph('keep me')
                doc.add_table(rows=1, cols=1).cell(0, 0).text = 'table cell'
                doc.save(source)
                original = source.read_bytes()
                output.write_bytes(b'previous approved output')
                with self.assertRaises(ValueError):
                    formatter.delete_paragraphs(source, output, {'deletions': [
                        {'paragraph_id': f'word/document.xml:p{i}', 'expected_text': text} for i, text in batch]})
                self.assertEqual(output.read_bytes(), b'previous approved output')
                self.assertEqual(source.read_bytes(), original)

    def test_structural_content_cannot_be_deleted_or_compacted(self):
        for kind in ('math', 'drawing', 'bookmarkStart', 'commentReference', 'hyperlink',
                     'br', 'sectPr', 'numPr', 'pageBreakBefore', 'inherited_break', 'inherited_numbering'):
            for mode in ('delete', 'compact'):
                with self.subTest(kind=kind, mode=mode), tempfile.TemporaryDirectory() as directory:
                    source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
                    doc = Document()
                    paragraph = doc.add_paragraph(' ')
                    doc.add_paragraph('keep')
                    if kind.startswith('inherited_'):
                        base = doc.styles.add_style('ProtectedBase', WD_STYLE_TYPE.PARAGRAPH)
                        child = doc.styles.add_style('ProtectedChild', WD_STYLE_TYPE.PARAGRAPH)
                        child.base_style = base
                        paragraph.style = child
                        if kind == 'inherited_break':
                            base.paragraph_format.page_break_before = True
                        else:
                            base.element.get_or_add_pPr().append(OxmlElement('w:numPr'))
                    elif kind in ('sectPr', 'numPr', 'pageBreakBefore'):
                        paragraph._p.get_or_add_pPr().append(OxmlElement('w:' + kind))
                    elif kind in ('br', 'drawing', 'commentReference'):
                        paragraph.runs[0]._r.append(OxmlElement('w:' + kind))
                    else:
                        paragraph._p.append(OxmlElement('m:oMath' if kind == 'math' else 'w:' + kind))
                    doc.save(source)
                    original = source.read_bytes()
                    with self.assertRaises(ValueError):
                        if mode == 'delete':
                            formatter.delete_paragraphs(source, output, {'deletions': [
                                {'paragraph_id': 'word/document.xml:p1', 'expected_text': ' '}]})
                        else:
                            formatter.format_document(source, output, {'operations': [
                                {'paragraph_id': 'word/document.xml:p1', 'compact_empty_paragraph': True}]})
                    self.assertFalse(output.exists())
                    self.assertEqual(source.read_bytes(), original)

    def test_cannot_delete_the_last_paragraph(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
            doc = Document()
            doc.add_paragraph('only paragraph')
            doc.save(source)
            with self.assertRaisesRegex(ValueError, 'empty_document'):
                formatter.delete_paragraphs(source, output, {'deletions': [
                    {'paragraph_id': 'word/document.xml:p1', 'expected_text': 'only paragraph'}]})
            self.assertFalse(output.exists())

    def test_compaction_preserves_text_structure_and_other_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.docx', Path(directory) / 'output.docx'
            doc = Document()
            doc.add_paragraph('keep text')
            doc.add_table(rows=1, cols=1).cell(0, 0).text = 'keep table'
            paragraph = doc.add_paragraph('   ')
            paragraph.paragraph_format.space_after = Pt(72)
            paragraph.paragraph_format.keep_with_next = True
            doc.save(source)
            before = parts(source)
            formatter.format_document(source, output, {'operations': [
                {'paragraph_id': 'word/document.xml:p3', 'compact_empty_paragraph': True}]})
            after = parts(output)
            self.assertEqual(formatter.signature(etree.fromstring(before['word/document.xml'])),
                             formatter.signature(etree.fromstring(after['word/document.xml'])))
            self.assertEqual(len(Document(source).paragraphs), len(Document(output).paragraphs))
            for name, data in before.items():
                if name != 'word/document.xml':
                    self.assertEqual(data, after[name], name)
            result = Document(output).paragraphs[-1]
            self.assertEqual(result.paragraph_format.line_spacing.pt, 1)
            self.assertEqual(result.paragraph_format.space_after.pt, 0)
            self.assertFalse(result.paragraph_format.keep_with_next)
            self.assertEqual(result.runs[0].font.size.pt, 1)
            for operation in (
                {'paragraph_id': 'word/document.xml:p1', 'compact_empty_paragraph': True},
                {'paragraph_id': 'word/document.xml:p3', 'compact_empty_paragraph': True, 'font_size_pt': 12},
            ):
                previous = output.read_bytes()
                with self.assertRaises(ValueError):
                    formatter.format_document(source, output, {'operations': [operation]})
                self.assertEqual(output.read_bytes(), previous)


if __name__ == '__main__':
    unittest.main()
