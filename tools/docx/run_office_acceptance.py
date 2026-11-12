"""Exercise full office requirements through the production native tool driver.

Fixtures are original anonymous examples. Plans are explicit, operator-authored
inputs, not a model-conversation benchmark. Unsupported work remains a gap.
"""
import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import traceback

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from pypdf import PdfReader
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from office_fixtures import build
from run_acceptance import NS, package, revision, text, xml

ROOT = Path(__file__).resolve().parents[2]
REQUIREMENTS = Path(__file__).with_name('office_cases.json')
SOURCES = ('crates/runtime/src/document_export.rs', 'crates/runtime/src/docx.rs',
           'crates/runtime/assets/docx/format_docx.py', 'crates/runtime/assets/docx/structure_docx.py',
           'crates/runtime/assets/docx/format_odt.py', 'crates/tools/src/lib.rs',
           'crates/runtime/assets/docx/office_docx.py', 'crates/runtime/assets/docx/toc_index.py',
           'crates/chat/src/lib.rs', 'crates/runtime/assets/prompts/system.md',
           'tools/docx/run_office_acceptance.py', 'tools/docx/office_fixtures.py',
           'tools/docx/office_cases.json')


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def canonical(node):
    return etree.tostring(node, method='c14n')


def pdf_heading_pages(path):
    """Read actual heading glyphs; pypdf can reorder CJK glyphs in text runs."""
    pdf = pdfium.PdfDocument(path)
    result = {}
    try:
        for index in range(len(pdf)):
            page = pdf.get_page(index)
            text_page = page.get_textpage()
            try:
                heading = ''.join(text_page.get_text_range(i, 1) for i in range(text_page.count_chars())
                    if pdfium_raw.FPDFText_GetFontSize(text_page, i) >= 13.5)
                result[str(index + 1)] = re.sub(r'\s+', '', heading)
            finally:
                text_page.close()
                page.close()
    finally:
        pdf.close()
    return result


def other_parts_equal(a, b):
    first, second = package(a), package(b)
    return first.keys() == second.keys() and all(second[name] == value
        for name, value in first.items() if name != 'word/document.xml')


def table_geometry(path):
    return [(canonical(t.find(qn('w:tblPr'))), canonical(t.find(qn('w:tblGrid'))),
        [(canonical(n) if n is not None else None) for n in t.xpath('.//w:tcPr|./w:tr/w:trPr', namespaces=NS)])
        for t in xml(path).xpath('//w:tbl', namespaces=NS)]


def run_properties(path):
    return [canonical(n) for n in xml(path).xpath('//w:rPr|//w:pPr', namespaces=NS)]


def footer_numbers(page):
    found = []
    def visitor(value, cm, tm, font, size):
        value = value.strip()
        x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
        if value.isdecimal() and 0 <= y < float(page.mediabox.height) * .15:
            found.append({'value': value, 'x': x, 'y': y})
    page.extract_text(visitor_text=visitor)
    return found


class OfficeAcceptance:
    def __init__(self, runner, output, source_manifest, build_manifest):
        if output.exists() and any(output.iterdir()):
            raise ValueError('use a fresh output directory; previous evidence is immutable')
        output.mkdir(parents=True, exist_ok=True)
        self.runner, self.output = runner, output
        self.requirements = json.loads(REQUIREMENTS.read_text(encoding='utf-8'))
        self.source_manifest = json.loads(source_manifest.read_text(encoding='utf-8'))
        assert self.source_manifest['requirementsRevision'] == revision(REQUIREMENTS)
        assert {r['id'] for r in self.source_manifest['sources']} == {r['id'] for r in self.requirements['sources']}
        for source in self.source_manifest['sources']:
            assert source['status'] == 200
            assert revision(Path(source['htmlPath'])) == 'sha256:' + source['sha256']
            assert revision(Path(source['textPath'])) == 'sha256:' + source['textSha256']
        recorded = json.loads(build_manifest.read_text(encoding='utf-8'))
        assert recorded['runnerRevision'] == revision(runner), 'driver build hash mismatch'
        for name, expected in recorded['implementationRevisions'].items():
            assert revision(ROOT / name) == expected, ('driver source has changed', name)
        self.revisions = {name: revision(ROOT / name) for name in SOURCES}
        self.metadata = {'scope': self.requirements['scope'], 'startedAt': datetime.now(timezone.utc).isoformat(),
            'runnerRevision': revision(runner), 'buildManifest': str(build_manifest),
            'buildManifestRevision': revision(build_manifest), 'implementationRevisions': self.revisions,
            'sourceManifest': str(source_manifest), 'sourceManifestRevision': revision(source_manifest),
            'sourceDocuments': 'authored_anonymous_fixtures', 'taskConversationReplay': 'not_run',
            'independentVisualReviewer': 'not_run', 'wordWpsVerification': 'not_run', 'visualReview': 'pending'}
        self.calls, self.results = [], []
        self.inputs = build(output / 'inputs')
        self.input_revisions = {key: revision(value) for key, value in self.inputs.items()}
        assert set(self.inputs) == {case['id'] for case in self.requirements['cases']}
        save(output / 'inputs.json', [{'case': key, 'path': str(path), 'revision': self.input_revisions[key]}
            for key, path in self.inputs.items()])

    def checkpoint(self, complete=False):
        save(self.output / 'results.json', {**self.metadata, 'runState': 'complete' if complete else 'in_progress',
            'counts': dict(Counter(r['status'] for r in self.results)), 'results': self.results,
            'renderedCandidatePages': sum(len(c.get('pageImages', [])) for c in self.results),
            'diagnosticPages': sum(len(c.get('diagnosticPageImages', [])) for c in self.results),
            'allOriginalInputsUnchanged': all(revision(p) == self.input_revisions[k] for k, p in self.inputs.items())})

    def invoke(self, tool, data, expect_error=None):
        process = subprocess.run([str(self.runner), str(ROOT)], input=json.dumps({'tool': tool, 'input': data}),
            capture_output=True, encoding='utf-8', errors='replace', cwd=ROOT, timeout=360)
        call = {'tool': tool, 'input': data, 'exitCode': process.returncode}
        if process.returncode:
            call['error'] = process.stderr[-8000:]
        else:
            call['result'] = json.loads(process.stdout)
        self.calls.append(call)
        save(self.output / 'tool-calls.json', self.calls)
        if expect_error is not None:
            assert process.returncode != 0, f'expected documented native rejection: {tool}'
            assert any(token.lower() in call['error'].lower() for token in expect_error), call['error']
            return call
        if process.returncode:
            raise RuntimeError(call['error'])
        return call['result']

    def read(self, path):
        paragraphs, offset = [], 0
        while True:
            result = self.invoke('read_docx', {'path': str(path), 'offset': offset, 'limit': 100})
            paragraphs.extend(result['paragraphs'])
            if result.get('nextOffset') is None:
                result['paragraphs'] = paragraphs
                return result
            offset = result['nextOffset']

    @staticmethod
    def paragraph(read, value):
        matching = [p for p in read['paragraphs'] if value in p['text']]
        assert len(matching) == 1, (value, [p['text'] for p in matching])
        return matching[0]

    @staticmethod
    def check(case, label, passed, **details):
        case['checks'].append({'label': label, 'passed': bool(passed), **details})

    def mutate(self, case, tool, plan, output, before=None):
        plan = deepcopy(plan)
        if tool != 'edit_docx':
            plan['render_pdf'] = False
        first = self.invoke(tool, plan)
        record = self.invoke('change_get', {'change_id': first['changeId']})['record']
        assert record['reversible'] and record['after']['contentKind'] == 'binary'
        reverted = self.invoke('change_revert', {'change_id': first['changeId']})
        assert reverted['reverted'] and (not output.exists() if before is None else output.read_bytes() == before)
        case.setdefault('auditChecks', []).append({'tool': tool, 'reversibleBinaryRecord': True,
            'actualUndo': 'restored_exact_previous_bytes' if before is not None else 'removed_new_file'})
        return self.invoke(tool, plan)

    def format(self, case, source, output, operations):
        return self.mutate(case, 'format_docx', {'path': str(source), 'expected_source_revision': revision(source),
            'output_path': str(output), 'operations': operations}, output)

    def structure(self, case, source, output, operations):
        return self.mutate(case, 'edit_docx_structure', {'path': str(source), 'expected_source_revision': revision(source),
            'output_path': str(output), 'operations': operations}, output)

    def edit(self, case, source, output, replacements):
        shutil.copy2(source, output)
        read = self.read(output)
        edits = []
        for needle, old, new in replacements:
            paragraph = self.paragraph(read, needle)
            edits.append({'paragraph_id': paragraph['id'], 'old_string': old, 'new_string': new})
        return self.mutate(case, 'edit_docx', {'path': str(output), 'expected_revision': read['revision'],
            'edits': edits}, output, source.read_bytes())

    def render(self, case, path, diagnostic=False, named_pdf=False):
        if named_pdf:
            published = self.invoke('export_docx_pdf', {'path': str(path), 'expected_source_revision': revision(path)})
            evidence = published['evidence']
            assert Path(published['filePath']).name == path.with_suffix('.pdf').name
            assert revision(Path(published['filePath'])) == evidence['pdfRevision']
            case['pdfDelivery'] = published
        else:
            evidence = self.invoke('render_docx', {'path': str(path), 'expected_revision': revision(path)})
        assert evidence['state'] == 'rendered'
        assert evidence['documentRevision'] == revision(path)
        assert evidence['pdfRevision'] == revision(Path(evidence['pdfPath']))
        assert evidence['visualReview'] == 'pending' and evidence['targetEditorVerification'] == 'unverified'
        directory = self.output / case['id'] / ('diagnostic-pages' if diagnostic else 'pages')
        directory.mkdir(parents=True, exist_ok=True)
        images = []
        pdf = pdfium.PdfDocument(evidence['pdfPath'])
        extracted = PdfReader(evidence['pdfPath'])
        for index in range(len(pdf)):
            page = pdf.get_page(index)
            bitmap = page.render(scale=1.5)
            page_path = directory / f'page-{index + 1:03d}.png'
            with bitmap.to_pil() as image:
                image.save(page_path)
                white = all(low == high == 255 for low, high in image.convert('RGB').getextrema())
            images.append({'page': index + 1, 'path': str(page_path), 'revision': revision(page_path),
                'allWhite': white, 'footerNumbers': footer_numbers(extracted.pages[index]),
                'text': extracted.pages[index].extract_text()})
            bitmap.close()
            page.close()
        pdf.close()
        assert len(images) == evidence['pageCount']
        if diagnostic:
            case['diagnosticEvidence'], case['diagnosticPageImages'] = evidence, images
        else:
            case['outputPath'], case['evidence'], case['pageImages'] = str(path), evidence, images
        return images

    def gap(self, case, source, plan, tool='edit_docx_structure', expected=('unknown variant',)):
        output = Path(plan.get('output_path', self.output / case['id'] / 'must-not-exist.docx'))
        before = revision(source)
        call = self.invoke(tool, plan, expect_error=expected)
        assert revision(source) == before and not output.exists()
        case['contractProbe'] = {'tool': tool, 'error': call['error'], 'rejected': True,
            'sourceUnchanged': True, 'noCandidatePublished': True}
        case['status'] = 'native_capability_gap'

    def run_case(self, definition):
        key = definition['id']
        case = {**definition, 'checks': [], 'visualReview': 'pending', 'wordWpsVerification': 'not_run',
            'independentVisualReviewer': 'not_run', 'taskConversationReplay': 'not_run'}
        source = self.inputs[key]
        directory = self.output / key
        directory.mkdir()
        output = directory / (key + '.docx')
        case['sourcePath'], case['sourceRevision'] = str(source), revision(source)
        read = self.read(source)
        paragraphs = [p for p in read['paragraphs'] if p['part'] == 'word/document.xml']
        if key == 'office_notice':
            ops = [{'paragraph_id': p['id'], 'font_name': 'Times New Roman', 'east_asia_font': '宋体',
                'font_size_pt': 12, 'line_spacing': 1.15, 'space_before_pt': 0, 'space_after_pt': 6,
                'keep_with_next': False} for p in paragraphs]
            ops.append({'paragraph_id': paragraphs[0]['id'], 'font_size_pt': 18, 'alignment': 'center', 'keep_with_next': True})
            time = self.paragraph(read, '维护时间')
            marker = '2026年11月16日 18:00—20:00'
            start = time['text'].index(marker)
            ops.append({'paragraph_id': time['id'], 'range': {'start': start, 'end': start + len(marker),
                'expected_text': marker}, 'color': 'C00000'})
            self.format(case, source, output, ops)
            candidate = Document(output)
            self.check(case, 'notification text and other package parts retained', text(source) != [] and
                [''.join(p.itertext(qn('w:t'))) for p in xml(source).iter(qn('w:p'))] ==
                [''.join(p.itertext(qn('w:t'))) for p in xml(output).iter(qn('w:p'))] and other_parts_equal(source, output))
            self.check(case, 'title centered at 18 pt; body 12 pt at 1.15 line spacing',
                candidate.paragraphs[0].alignment == 1 and all(r.font.size.pt == 18 for r in candidate.paragraphs[0].runs)
                and all(p.paragraph_format.line_spacing == 1.15 and all(r.font.size.pt == 12 for r in p.runs if r.text)
                        for p in candidate.paragraphs[1:]))
            selected = next(p for p in candidate.paragraphs if '维护时间' in p.text)
            self.check(case, 'only exact maintenance-time range is red', ''.join(r.text for r in selected.runs
                if str(r.font.color.rgb) == 'C00000') == marker)
            pages = self.render(case, output)
            self.check(case, 'exactly one A4 page without blank pages', len(pages) == 1 and not pages[0]['allWhite']
                and abs(candidate.sections[0].page_width.mm - 210) < .1 and abs(candidate.sections[0].page_height.mm - 297) < .1)
        elif key in ('meeting_minutes', 'contract_edit', 'expense_form'):
            replacements = {
                'meeting_minutes': [('陈工', '陈工', '李工'), ('2026-11-18', '2026-11-18', '2026-11-20')],
                'contract_edit': [('12,800.00', '12,800.00', '13,500.00'), ('交付日期', '2026年11月25日', '2026年12月01日')],
                'expense_form': [('960.00', '960.00', '1,000.00'), ('1,480.00', '1,480.00', '1,520.00')]}[key]
            self.edit(case, source, output, replacements)
            expected = [''.join(p.itertext(qn('w:t'))) for p in xml(source).iter(qn('w:p'))]
            for index, value in enumerate(expected):
                for needle, old, new in replacements:
                    if needle in value:
                        value = value.replace(old, new)
                expected[index] = value
            actual = [''.join(p.itertext(qn('w:t'))) for p in xml(output).iter(qn('w:p'))]
            self.check(case, 'only explicitly selected text changed', actual == expected)
            self.check(case, 'table geometry, merged cells, run/paragraph properties and other parts retained',
                table_geometry(source) == table_geometry(output) and run_properties(source) == run_properties(output)
                and other_parts_equal(source, output))
            if key == 'expense_form':
                from decimal import Decimal
                t = Document(output).tables[0]
                amounts = [Decimal(t.cell(i, 2).text.replace(',', '')) for i in (3, 4, 5)]
                self.check(case, 'expense total matches specified line amounts', sum(amounts) == Decimal(t.cell(6, 2).text.replace(',', '')))
            pages = self.render(case, output)
            self.check(case, 'one complete nonblank page', len(pages) == 1 and not pages[0]['allWhite'])
        elif key == 'quotation_table':
            selected = [p for p in paragraphs if '\t' in p['text']]
            intermediate = directory / 'table.docx'
            self.structure(case, source, intermediate, [{'action': 'text_to_table', 'delimiter': '\t',
                'paragraphs': [{'paragraph_id': p['id'], 'expected_text': p['text']} for p in selected]}])
            next_read = self.read(intermediate)
            operations = []
            for p in next_read['paragraphs']:
                op = {'paragraph_id': p['id'], 'font_size_pt': 11}
                if re.fullmatch(r'\d+(?:\.\d+)?', p['text']):
                    op['alignment'] = 'right'
                operations.append(op)
            operations.append({'paragraph_id': next_read['paragraphs'][0]['id'],
                'font_size_pt': 18, 'alignment': 'center', 'keep_with_next': True})
            self.format(case, intermediate, output, operations)
            t = Document(output).tables[0]
            expected = [p['text'].split('\t') for p in selected]
            self.check(case, 'native 5 by 4 table with comma-containing product and every number intact',
                len(t.rows) == 5 and [list(c.text for c in r.cells) for r in t.rows] == expected)
            self.check(case, 'all numeric cells right aligned', all(c.paragraphs[0].alignment == 2
                for row in t.rows for c in row.cells if re.fullmatch(r'\d+(?:\.\d+)?', c.text)))
            pages = self.render(case, output, named_pdf=True)
            pdf_text = re.sub(r'\s+', '', ''.join(p['text'] for p in pages))
            self.check(case, 'named PDF preserves every cell value and note on one nonblank page', len(pages) == 1
                and all(re.sub(r'\s+', '', c) in pdf_text for row in expected for c in row if c)
                and '报价有效期' in pdf_text and not pages[0]['allWhite'])
        elif key in ('report_pagination', 'cover_page_numbering'):
            alignment = 'right' if key == 'report_pagination' else 'center'
            op = {'action': 'page_numbers', 'alignment': alignment}
            if key == 'cover_page_numbering':
                op.update(skip_first_page=True, start_at=1)
            self.structure(case, source, output, [op])
            pages = self.render(case, output)
            self.check(case, 'original three pages and body text retained', len(pages) == 3 and text(source) == text(output))
            before, after = package(source), package(output)
            self.check(case, 'all original headers retained byte for byte', all(after[n] == v for n, v in before.items() if n.startswith('word/header')))
            numbers = [[n['value'] for n in p['footerNumbers']] for p in pages]
            if key == 'report_pagination':
                width = float(PdfReader(case['evidence']['pdfPath']).pages[0].mediabox.width)
                self.check(case, 'pages 1 through 3 numbered at bottom right', numbers == [['1'], ['2'], ['3']]
                    and all(n['x'] > width * .65 for p in pages for n in p['footerNumbers']), observed=numbers)
            else:
                self.check(case, 'cover has no footer page number', numbers[0] == [], observed=numbers[0])
                self.check(case, 'body begins at 1 then 2', numbers[1:] == [['1'], ['2']], observed=numbers[1:])
        elif key == 'contact_deduplication':
            seen, kept, deletions = set(), [], []
            for p in paragraphs[1:]:
                identifier = p['text'].split('｜')[0]
                if identifier in seen:
                    deletions.append({'paragraph_id': p['id'], 'expected_text': p['text']})
                else:
                    seen.add(identifier)
                    kept.append(p['text'])
            self.mutate(case, 'delete_docx_paragraphs', {'path': str(source), 'expected_source_revision': revision(source),
                'output_path': str(output), 'deletions': deletions}, output)
            self.check(case, 'six unique records in original first-occurrence order', [p.text for p in Document(output).paragraphs[1:]] == kept and len(kept) == 6)
            source_root = xml(source)
            original_paragraphs = list(source_root.iter(qn('w:p')))
            for item in deletions:
                node = original_paragraphs[int(item['paragraph_id'].split(':p')[1]) - 1]
                node.getparent().remove(node)
            self.check(case, 'remaining XML and all other parts unchanged; no cleared empty paragraphs',
                canonical(source_root) == canonical(xml(output)) and other_parts_equal(source, output)
                and all(p.text for p in Document(output).paragraphs))
            pages = self.render(case, output)
            self.check(case, 'one nonblank page', len(pages) == 1 and not pages[0]['allWhite'])
        elif key == 'external_redaction':
            intermediate = directory / 'visible-redaction.docx'
            self.edit(case, source, intermediate, [('周示例', '周示例', '联系人A'), ('010-5550-0199', '010-5550-0199', '已隐藏')])
            self.structure(case, intermediate, output, [{'action': 'remove_personal_metadata'}])
            pages = self.render(case, output)
            visible = ''.join(text(output)) + ''.join(p['text'] for p in pages)
            self.check(case, 'visible name and phone removed from document text and PDF',
                '周示例' not in visible and '010-5550-0199' not in visible)
            props = package(output)['docProps/core.xml']
            markers = [s for s in ('OFFICE_TEST_AUTHOR_031', 'OFFICE_TEST_REVIEWER_009') if s.encode() in props]
            self.check(case, 'hidden author and last-modified identity removed', not markers,
                remainingTestMarkers=markers, packagePart='docProps/core.xml')
            self.check(case, 'project identifier and budget preserved', 'PRJ-2026-011' in visible and '25,000.00' in visible)
        elif key == 'long_table_header':
            header = self.paragraph(read, '库存编码')
            self.structure(case, source, output, [{'action':'repeat_table_header', 'paragraph_id':header['id'],
                'expected_text':header['text'], 'header_rows':1}])
            self.check(case, 'native first-row repeat-header property', bool(xml(output).xpath('//w:tbl/w:tr[1]/w:trPr/w:tblHeader', namespaces=NS)))
            self.check(case, 'all original table text preserved', text(source) == text(output))
            pages = self.render(case, output)
            self.check(case, 'table spans multiple pages and retains all 60 inventory IDs', len(pages) > 1 and
                all(f'INV-{i:03d}' in ''.join(p['text'] for p in pages) for i in range(1, 61)))
            self.check(case, 'header visible on every actual page', all('库存编码' in p['text'] for p in pages))
        elif key == 'landscape_appendix':
            self.structure(case, source, output, [{'action':'section_orientation','section_index':1,'orientation':'landscape'}])
            sections = Document(output).sections
            self.check(case, 'only second of two sections is landscape', len(sections)==2 and sections[0].page_width < sections[0].page_height and sections[1].page_width > sections[1].page_height)
            self.check(case, 'all original table text and geometry preserved', text(source)==text(output) and table_geometry(source)==table_geometry(output))
            pages = self.render(case, output)
            pdf = PdfReader(case['evidence']['pdfPath'])
            self.check(case, 'portrait cover then landscape appendix in actual PDF', len(pages)==2 and pdf.pages[0].mediabox.width < pdf.pages[0].mediabox.height and pdf.pages[1].mediabox.width > pdf.pages[1].mediabox.height)
        elif key == 'accept_revisions':
            self.structure(case, source, output, [{'action':'accept_revisions'}])
            self.check(case, 'all inline insert/delete revisions accepted', not xml(output).xpath('//w:ins|//w:del', namespaces=NS))
            value=''.join(text(output))
            self.check(case, 'new amount and original other clauses retained', '11,000.00' in value and '10,000.00' not in value and '交付与验收条款维持原约定。' in value)
            pages=self.render(case, output)
            self.check(case, 'accepted new amount appears in PDF without deleted amount', '11,000.00' in ''.join(p['text'] for p in pages) and '10,000.00' not in ''.join(p['text'] for p in pages))
        elif key == 'automatic_contents':
            anchor = self.paragraph(read, '此处插入自动目录')
            self.structure(case, source, output, [{'action':'insert_table_of_contents','paragraph_id':anchor['id'],
                'expected_text':anchor['text'],'levels':2}])
            self.check(case, 'native updatable TOC field with six populated heading entries',
                any('TOC' in (n.text or '').split() for n in xml(output).xpath('//w:instrText', namespaces=NS)) and
                len([p for p in Document(output).paragraphs if '\t' in p.text])==6)
            before = [canonical(p._p) for p in Document(source).paragraphs if p.text != anchor['text']]
            after = [canonical(p._p) for p in Document(output).paragraphs if '\t' not in p.text]
            self.check(case, 'original heading/body XML retained beyond the directory', before==after)
            pages = self.render(case, output)
            final_pdf=''.join(p['text'] for p in pages)
            self.check(case, 'all directory entries and headings visible without placeholder',
                all(f'{i}.1 进度与成果' in final_pdf for i in range(1,4)) and '此处插入自动目录' not in final_pdf)
            # Each cached number must identify a PDF page containing its actual heading.
            heading_pages = pdf_heading_pages(case['evidence']['pdfPath'])
            self.check(case, 'cached directory page numbers match actual heading pages', all(
                re.sub(r'\s+','',line.rsplit('\t',1)[0]) in heading_pages.get(line.rsplit('\t',1)[1], '')
                for line in (p.text for p in Document(output).paragraphs if '\t' in p.text)))
        elif key == 'fillable_controls':
            control=next(c for c in read['documentStructure']['contentControls'] if c['value']=='请输入姓名')
            self.structure(case, source, output, [{'action':'fill_content_control','control_id':control['controlId'],
                'expected_text':control['value'],'text':'周示例'}])
            before, after = xml(source).xpath('//w:sdt',namespaces=NS),xml(output).xpath('//w:sdt',namespaces=NS)
            self.check(case, 'text filled and both native controls retained', len(after)==len(before)==2 and ''.join(after[0].itertext(qn('w:t')))=='周示例')
            self.check(case, 'control properties and dropdown options retained exactly', all(canonical(a.find(qn('w:sdtPr')))==canonical(b.find(qn('w:sdtPr'))) for a,b in zip(before,after)) and canonical(before[1])==canonical(after[1]))
            pages=self.render(case, output)
            self.check(case, 'filled name visible in final PDF', '周示例' in ''.join(p['text'] for p in pages))
        else:
            raise ValueError('unknown office case: ' + key)
        assert revision(source) == self.input_revisions[key]
        case['originalInputUnchanged'] = True
        if 'status' not in case:
            case['status'] = 'automated_pass' if all(c['passed'] for c in case['checks']) else 'partial'
        return case

    def schema(self):
        validator = ROOT / 'tools/docx/validate/bin/Debug/net6.0/DocxValidate.dll'
        if not validator.exists():
            raise RuntimeError('Build tools/docx/validate first; do not skip schema validation silently')
        records = []
        for case in self.results:
            if not case.get('outputPath'):
                continue
            process = subprocess.run(['dotnet', str(validator), case['outputPath'], case['sourcePath']],
                capture_output=True, encoding='utf-8', errors='replace', cwd=ROOT, timeout=60)
            result = json.loads(process.stdout)
            records.append({'case': case['id'], 'candidateRevision': revision(Path(case['outputPath'])),
                'baselineRevision': case['sourceRevision'], **result})
            self.check(case, 'Open XML SDK finds no additional schema errors', process.returncode == 0 and not result['added'])
            if result['added']:
                case['status'] = 'partial'
        save(self.output / 'schema-validation.json', records)

    def run(self):
        for definition in self.requirements['cases']:
            try:
                case = self.run_case(definition)
            except Exception as error:
                case = {**definition, 'status': 'execution_error', 'error': str(error), 'traceback': traceback.format_exc()}
            self.results.append(case)
            self.checkpoint()
            print(definition['id'], case['status'], flush=True)
        self.schema()
        assert all(revision(p) == self.input_revisions[k] for k, p in self.inputs.items())
        assert all(revision(ROOT / name) == expected for name, expected in self.revisions.items())
        self.checkpoint(complete=True)
        print(json.dumps({'counts': dict(Counter(c['status'] for c in self.results)), 'results': str(self.output / 'results.json')}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--build-manifest', type=Path, required=True,
        help='Previous build/run metadata binding the reused driver to its actual production sources')
    args = parser.parse_args()
    OfficeAcceptance(args.runner.resolve(), args.output.resolve(), args.sources.resolve(), args.build_manifest.resolve()).run()
