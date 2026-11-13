"""Office regressions for lossless native edits and atomic protective failures."""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'crates/runtime/assets/docx'))
from structure_docx import structure_document
from tools.docx.office_fixtures import sdt
from tools.docx.test_format_docx import parts

PID = 'word/document.xml:p1'


class OfficeStructureTests(unittest.TestCase):
    def test_tab_delimited_table_preserves_commas_emphasis_and_untouched_parts(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            p = document.add_paragraph('打印纸,A4\t')
            p.add_run('10').bold = True
            p.add_run('\t28.50\t285.00')
            document.add_paragraph('备注保持不变')
            document.save(source)
            original = parts(source)
            structure_document(source, output, {'operations': [{'action': 'text_to_table',
                'paragraphs': [{'paragraph_id': PID, 'expected_text': p.text}], 'delimiter': '\t'}]})
            result = Document(output)
            self.assertEqual([c.text for c in result.tables[0].rows[0].cells], ['打印纸,A4', '10', '28.50', '285.00'])
            self.assertTrue(next(r for r in result.tables[0].cell(0, 1).paragraphs[0].runs if r.text).bold)
            self.assertEqual(result.paragraphs[0].text, '备注保持不变')
            self.assertEqual(parts(source), original)
            self.assertTrue(all(parts(output)[n] == data for n, data in original.items() if n != 'word/document.xml'))

    def test_cover_numbering_keeps_existing_header_and_rejects_nonempty_cover_footer(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            document.add_paragraph('封面及正文')
            section = document.sections[0]
            section.header.paragraphs[0].text = '必须保留的单位页眉'
            document.save(source)
            plan = {'operations': [{'action': 'page_numbers', 'alignment': 'right', 'skip_first_page': True, 'start_at': 1}]}
            structure_document(source, output, plan)
            result = Document(output)
            self.assertEqual(result.sections[0].first_page_header.paragraphs[0].text, '必须保留的单位页眉')
            self.assertEqual(result.sections[0].header.paragraphs[0].text, '必须保留的单位页眉')
            self.assertFalse(result.sections[0].first_page_footer._element.xpath('.//w:instrText'))
            self.assertTrue(result.sections[0].footer._element.xpath('.//w:instrText'))
            self.assertEqual(parts(source)['word/header1.xml'], parts(output)['word/header1.xml'])
            previous = output.read_bytes()
            section.different_first_page_header_footer = True
            section.first_page_footer.paragraphs[0].text = '保留的封面签注'
            document.save(source)
            with self.assertRaisesRegex(ValueError, 'nonempty_footer'):
                structure_document(source, output, plan)
            self.assertEqual(output.read_bytes(), previous)

    def test_repeat_header_requires_first_row_and_orientation_changes_only_selected_section(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            table = document.add_table(rows=2, cols=2)
            for cell, value in zip(table._cells, ('编码', '名称', '001', '纸')):
                cell.text = value
            document.add_section(WD_SECTION_START.NEW_PAGE)
            document.add_paragraph('附件')
            document.save(source)
            structure_document(source, output, {'operations': [
                {'action': 'repeat_table_header', 'paragraph_id': PID, 'expected_text': '编码', 'header_rows': 1},
                {'action': 'section_orientation', 'section_index': 1, 'orientation': 'landscape'}]})
            result = Document(output)
            self.assertTrue(result.tables[0].rows[0]._tr.xpath('./w:trPr/w:tblHeader'))
            self.assertEqual([c.text for c in result.tables[0]._cells], ['编码', '名称', '001', '纸'])
            self.assertEqual(etree.tostring(document.sections[0]._sectPr), etree.tostring(result.sections[0]._sectPr))
            self.assertGreater(result.sections[1].page_width, result.sections[1].page_height)
            previous = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'invalid_header_rows'):
                structure_document(source, output, {'operations': [
                    {'action': 'repeat_table_header', 'paragraph_id': 'word/document.xml:p3', 'expected_text': '001'}]})
            self.assertEqual(output.read_bytes(), previous)

    def test_accept_revisions_in_body_and_header_and_refuse_unsupported_moves_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            p = document.add_paragraph('金额 ')
            for tag, text in (('del', '10,000.00'), ('ins', '11,000.00')):
                change = OxmlElement('w:' + tag)
                change.set(qn('w:id'), '1' if tag == 'del' else '2')
                change.set(qn('w:author'), '示例')
                run = OxmlElement('w:r')
                node = OxmlElement('w:delText' if tag == 'del' else 'w:t')
                node.text = text
                run.append(node)
                change.append(run)
                p._p.append(change)
            document.sections[0].header.paragraphs[0]._p.append(deepcopy(change))
            document.add_paragraph('保留条款')
            document.save(source)
            original = source.read_bytes()
            structure_document(source, output, {'operations': [{'action': 'accept_revisions'}]})
            result = Document(output)
            self.assertEqual(result.paragraphs[0].text, '金额 11,000.00')
            self.assertEqual(result.sections[0].header.paragraphs[0].text, '11,000.00')
            self.assertFalse(result.element.xpath('.//w:ins|.//w:del'))
            self.assertFalse(result.sections[0].header._element.xpath('.//w:ins|.//w:del'))
            self.assertEqual(result.paragraphs[1].text, '保留条款')
            self.assertEqual(source.read_bytes(), original)
            previous = output.read_bytes()
            p._p.append(OxmlElement('w:moveFrom'))
            document.save(source)
            with self.assertRaises(ValueError):
                structure_document(source, output, {'operations': [{'action': 'accept_revisions'}]})
            self.assertEqual(output.read_bytes(), previous)

    def test_controls_keep_options_and_refuse_stale_choices_and_locks_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            sdt(document.add_paragraph('姓名：'), 11, '请输入姓名')
            sdt(document.add_paragraph('部门：'), 12, '行政', ('行政', '财务'))
            document.save(source)
            original = Document(source).element.xpath('.//w:sdtPr')
            operation = {'action': 'fill_content_control', 'control_id': '11', 'expected_text': '请输入姓名', 'text': '周示例'}
            structure_document(source, output, {'operations': [operation,
                {'action': 'fill_content_control', 'control_id': '12', 'expected_text': '行政', 'text': '财务'}]})
            result = Document(output)
            self.assertEqual([''.join(c.itertext(qn('w:t'))) for c in result.element.xpath('.//w:sdtContent')], ['周示例', '财务'])
            self.assertEqual([etree.tostring(c) for c in original], [etree.tostring(c) for c in result.element.xpath('.//w:sdtPr')])
            previous = output.read_bytes()
            for bad in ({**operation, 'expected_text': '过期值'},
                {'action': 'fill_content_control', 'control_id': '12', 'expected_text': '行政', 'text': '不存在的部门'}):
                with self.assertRaises(ValueError):
                    structure_document(source, output, {'operations': [bad]})
                self.assertEqual(output.read_bytes(), previous)
            document.element.xpath('.//w:sdtPr')[0].append(OxmlElement('w:lock'))
            document.save(source)
            with self.assertRaisesRegex(ValueError, 'protected_control'):
                structure_document(source, output, {'operations': [operation]})
            self.assertEqual(output.read_bytes(), previous)

    def test_metadata_cleanup_preserves_body_and_unrelated_properties(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'input.docx', Path(folder)/'candidate.docx'
            document = Document()
            document.add_paragraph('PRJ-2026-011 预算25,000.00')
            document.core_properties.author = 'PRIVATE_AUTHOR'
            document.core_properties.last_modified_by = 'PRIVATE_MODIFIER'
            document.core_properties.title = '保留标题'
            document.save(source)
            structure_document(source, output, {'operations': [{'action': 'remove_personal_metadata'}]})
            result = Document(output)
            self.assertEqual(result.core_properties.author, '')
            self.assertEqual(result.core_properties.last_modified_by, '')
            self.assertEqual(result.core_properties.title, '保留标题')
            self.assertEqual(result.paragraphs[0].text, document.paragraphs[0].text)
            self.assertEqual(parts(output)['word/document.xml'], parts(source)['word/document.xml'])


if __name__ == '__main__':
    unittest.main()
