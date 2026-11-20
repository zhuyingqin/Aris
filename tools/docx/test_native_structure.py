"""Regressions at rich-run, package-part, field and ODF inheritance boundaries."""
from pathlib import Path
import sys
import tempfile
import unittest

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'crates/runtime/assets/docx'))
import format_docx as formatter
from structure_docx import structure_document
from format_odt import remove_highlight
from tools.docx.test_format_docx import parts

PID = 'word/document.xml:p1'


class NativeDocumentTests(unittest.TestCase):
    def test_unicode_range_preserves_rich_text_and_only_changes_requested_character(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'a.docx', Path(folder)/'b.docx'
            doc = Document()
            p = doc.add_paragraph()
            p.add_run('水😀H').bold = True
            rich=p.add_run('2O mixed')
            rich.italic = True
            rich.font.size=Pt(12)
            from copy import deepcopy
            rich._r.rPr.append(deepcopy(rich._r.rPr.find(qn('w:sz'))))
            doc.save(source)
            formatter.format_document(source, output, {'operations':[{
                'paragraph_id':PID,'range':{'start':3,'end':4,'expected_text':'2'},'subscript':True}]})
            result = Document(output).paragraphs[0]
            self.assertEqual(result.text, '水😀H2O mixed')
            self.assertEqual([(r.text,r.font.subscript) for r in result.runs], [('水😀H',None),('2',True),('O mixed',None)])
            self.assertTrue(result.runs[0].bold)
            self.assertTrue(result.runs[1].italic)
            self.assertTrue(result.runs[2].italic)
            self.assertEqual(len(result.runs[1]._r.rPr.findall(qn('w:sz'))),2)
            self.assertEqual(len(result.runs[2]._r.rPr.findall(qn('w:sz'))),1)
            self.assertEqual(result.runs[2].font.size.pt,12)
            before, after = parts(source),parts(output)
            self.assertTrue(all(data == after[name] for name,data in before.items() if name != 'word/document.xml'))
            # A mismatched second range must not replace an existing candidate.
            previous = output.read_bytes()
            with self.assertRaisesRegex(ValueError,'text_conflict'):
                formatter.format_document(source, output, {'operations':[
                    {'paragraph_id':PID,'font_size_pt':14},
                    {'paragraph_id':PID,'range':{'start':3,'end':4,'expected_text':'wrong'},'color':'FF0000'}]})
            self.assertEqual(output.read_bytes(),previous)

    def test_italic_filter_resolves_styles_and_direct_false(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.docx',Path(folder)/'b.docx'
            doc=Document()
            style=doc.styles.add_style('InheritedItalic',WD_STYLE_TYPE.PARAGRAPH)
            style.font.italic=True
            p=doc.add_paragraph(style=style)
            p.add_run('inherited ')
            p.add_run('explicitly plain').italic=False
            for r in p.runs:r.font.size=Pt(12)
            doc.save(source)
            formatter.format_document(source,output,{'operations':[{'paragraph_id':PID,'run_filter':'italic','font_size_pt':14}]})
            runs=Document(output).paragraphs[0].runs
            self.assertEqual([r.font.size.pt for r in runs],[14,12])

    def test_range_rejects_drawings_without_rewriting_them(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.docx',Path(folder)/'b.docx'
            doc=Document()
            p=doc.add_paragraph('H2O')
            p.runs[0]._r.append(OxmlElement('w:drawing'))
            doc.save(source)
            with self.assertRaisesRegex(ValueError,'protected_range'):
                formatter.format_document(source,output,{'operations':[{'paragraph_id':PID,'range':{'start':1,'end':2,'expected_text':'2'},'subscript':True}]})
            self.assertFalse(output.exists())

    def test_runless_empty_paragraph_mark_is_compacted_in_both_scripts(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.docx',Path(folder)/'b.docx'
            doc=Document()
            p=doc.add_paragraph()
            props=OxmlElement('w:rPr')
            for name in ('sz','szCs'):
                n=OxmlElement('w:'+name);n.set(qn('w:val'),'30');props.append(n)
            p._p.get_or_add_pPr().append(props)
            doc.save(source)
            formatter.format_document(source,output,{'operations':[{'paragraph_id':PID,'compact_empty_paragraph':True}]})
            p=Document(output).paragraphs[0]
            self.assertFalse(p.runs)
            for name in ('sz','szCs'):
                self.assertEqual(p._p.pPr.find(qn('w:rPr')).find(qn('w:'+name)).get(qn('w:val')),'2')
            self.assertEqual(p._p.pPr.find(qn('w:snapToGrid')).get(qn('w:val')),'0')

    def test_multiple_breaks_and_delimited_table_preserve_all_nonseparator_text_and_emphasis(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.docx',Path(folder)/'b.docx'
            doc=Document();p=doc.add_paragraph('One. Two.')
            numbering=p._p.get_or_add_pPr().get_or_add_numPr()
            numbering.get_or_add_numId().val=5
            original_numbering=numbering.xml
            p.paragraph_format.page_break_before=False
            p._p.pPr.find(qn('w:pageBreakBefore')).set(qn('w:val'),'false')
            for kind in ('spellStart','spellEnd'):
                marker=OxmlElement('w:proofErr');marker.set(qn('w:type'),kind)
                if kind=='spellStart':p._p.insert(0,marker)
                else:p._p.append(marker)
            doc.styles['Table Grid'].delete()  # Imported public files omit it.
            doc.add_paragraph('Name,Count')
            p=doc.add_paragraph();p.add_run('Alice').bold=True;p.add_run(',16')
            doc.save(source)
            structure_document(source,output,{'operations':[
                {'action':'insert_breaks','paragraph_id':PID,'expected_text':'One. Two.','breaks':[
                    {'offset':4,'kind':'line'},{'offset':4,'kind':'line'},{'offset':9,'kind':'line'}]},
                {'action':'text_to_table','paragraphs':[
                    {'paragraph_id':'word/document.xml:p2','expected_text':'Name,Count'},
                    {'paragraph_id':'word/document.xml:p3','expected_text':'Alice,16'}],'delimiter':','}]})
            result=Document(output)
            self.assertEqual(result.paragraphs[0].text,'One.\n\n Two.\n')
            self.assertEqual(result.paragraphs[0]._p.pPr.numPr.xml,original_numbering)
            self.assertFalse(result.paragraphs[0].paragraph_format.page_break_before)
            self.assertEqual([n.get(qn('w:type')) for n in result.paragraphs[0]._p.findall(qn('w:proofErr'))],['spellStart','spellEnd'])
            self.assertEqual([[c.text for c in r.cells] for r in result.tables[0].rows],[['Name','Count'],['Alice','16']])
            self.assertTrue(result.tables[0].cell(1,0).paragraphs[0].runs[0].bold)
            self.assertIsNotNone(result.tables[0]._tbl.tblPr.find(qn('w:tblBorders')))

    def test_image_and_footer_fields_preserve_untouched_package_parts(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output,image=Path(folder)/'a.docx',Path(folder)/'b.docx',Path(folder)/'image.png'
            with Image.new('RGB',(40,20),'red') as bitmap:bitmap.save(image)
            doc=Document();doc.add_paragraph('Before after')
            # Unrelated TOC field must survive a footer/image operation exactly.
            p=doc.add_paragraph('TOC ')
            from structure_docx import field_run
            field_run(p,'TOC \\o "1-3"','Existing directory')
            doc.sections[0].different_first_page_header_footer=True
            doc.settings.odd_and_even_pages_header_footer=True
            doc.save(source)
            structure_document(source,output,{'_resources':{'picture':str(image)},'operations':[
                {'action':'insert_image','paragraph_id':PID,'expected_text':'Before after','offset':7,'image_path':'picture','width_pt':40},
                {'action':'insert_blank_page','paragraph_id':'word/document.xml:p2','expected_text':'TOC Existing directory'},
                {'action':'page_numbers','alignment':'left'}]})
            before,after=parts(source),parts(output)
            mutable={'word/document.xml','word/_rels/document.xml.rels','[Content_Types].xml'}
            self.assertTrue(all(data==after[name] for name,data in before.items() if name not in mutable))
            footers=[data for name,data in after.items() if name.startswith('word/footer')]
            self.assertEqual(len(footers),3)
            self.assertTrue(all(b' PAGE ' in data for data in footers))
            result=Document(output)
            self.assertEqual(result.paragraphs[0].text,'Before after')
            self.assertEqual(len(result.inline_shapes),1)
            self.assertEqual(result.paragraphs[2].text,'')
            self.assertTrue(result.paragraphs[2].paragraph_format.page_break_before)
            self.assertEqual(len(result.paragraphs[2]._p.xpath('.//w:br[@w:type="page"]')),1)
            self.assertIn(image.read_bytes(),after.values())

    def test_cross_reference_links_exact_marker_and_refuses_nonempty_footer_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.docx',Path(folder)/'b.docx'
            doc=Document();doc.add_paragraph('Evidence <add here> remains.');anchor=doc.add_paragraph('Previous reference')
            anchor.runs[0].font.name='Arial'
            anchor.runs[0].font.size=Pt(12)
            anchor._p.get_or_add_pPr().get_or_add_numPr().get_or_add_numId().val=5
            doc.sections[0].footer.paragraphs[0].text='Keep footer'
            doc.save(source)
            op={'action':'bibliography_reference','paragraph_id':PID,'expected_text':'Evidence <add here> remains.',
                'marker':'<add here>','after_paragraph_id':'word/document.xml:p2','after_expected_text':'Previous reference',
                'bookmark':'Study2026','number':2,'entry':'Exact authors and title.'}
            structure_document(source,output,{'operations':[op]})
            data=parts(output)['word/document.xml']
            self.assertIn(b'REF Study2026',data)
            self.assertIn(b'w:name="Study2026"',data)
            self.assertEqual(Document(output).paragraphs[0].text,'Evidence 2 remains.')
            added=Document(output).paragraphs[2].runs[0]
            self.assertEqual((added.font.name,added.font.size.pt),('Arial',12))
            previous=output.read_bytes()
            with self.assertRaisesRegex(ValueError,'nonempty_footer'):
                structure_document(source,output,{'operations':[op,{'action':'page_numbers','alignment':'left'}]})
            self.assertEqual(output.read_bytes(),previous)
            with self.assertRaisesRegex(ValueError,'reference_number_conflict'):
                structure_document(source,output,{'operations':[{**op,'number':99}]})
            self.assertEqual(output.read_bytes(),previous)

    def test_odt_inherited_highlights_removed_without_losing_text_or_other_parts(self):
        from odf.opendocument import OpenDocumentText,load
        from odf.style import Style,TextProperties
        from odf.text import P,Span
        from odf.namespaces import FONS
        with tempfile.TemporaryDirectory() as folder:
            source,output=Path(folder)/'a.odt',Path(folder)/'b.odt'
            doc=OpenDocumentText()
            base=Style(name='Base',family='text');base.addElement(TextProperties(backgroundcolor='#ffff00',fontweight='bold'))
            child=Style(name='Child',family='text',parentstylename=base)
            doc.styles.addElement(base);doc.styles.addElement(child)
            p=P(text='Plain ');p.addElement(Span(stylename=child,text='中文 😀 highlighted'))
            doc.text.addElement(p);doc.save(str(source))
            count=remove_highlight(source,output)
            self.assertEqual(count,1)
            result=load(str(output))
            props=result.getElementsByType(TextProperties)[0]
            self.assertEqual(props.getAttrNS(FONS,'background-color'),'transparent')
            self.assertEqual(props.getAttrNS(FONS,'font-weight'),'bold')
            before,after=parts(source),parts(output)
            self.assertEqual(before['content.xml'],after['content.xml'])
            self.assertTrue(all(data==after[name] for name,data in before.items() if name!='styles.xml'))


if __name__=='__main__':unittest.main()
