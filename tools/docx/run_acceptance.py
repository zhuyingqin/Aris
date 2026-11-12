"""Exercise the production Rust tools using anonymised request-derived fixtures.

This verifies deterministic tools, not full LLM conversations or Word/WPS fidelity.
Requires a built crates/tools/examples/docx_acceptance driver and local engines.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from zipfile import ZipFile

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math'}


def revision(path):
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()


def package(path):
    with ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def xml(path):
    return etree.fromstring(package(path)['word/document.xml'])


def text(path):
    return xml(path).xpath('//w:t/text()', namespaces=NS)


def invoke(runner, tool, data, expect_error=False):
    response = subprocess.run([str(runner), str(ROOT)], input=json.dumps({'tool': tool, 'input': data}),
                              capture_output=True, encoding='utf-8', timeout=360, cwd=ROOT)
    if expect_error:
        assert response.returncode != 0, 'expected rejection: ' + tool
        return response.stderr[-4000:]
    if response.returncode:
        raise RuntimeError(response.stderr[-4000:])
    return json.loads(response.stdout)


def export(runner, source, output, reference=None):
    data = {'source_path': str(source), 'expected_source_revision': revision(source), 'output_path': str(output)}
    if reference:
        data['reference_doc'] = str(reference)
    result = invoke(runner, 'export_docx', data)
    assert result['revision'] == revision(output)
    return result


def rendered(result, expected_pages=None):
    evidence = result['evidence']
    assert evidence['state'] == 'rendered', evidence
    assert evidence['documentRevision'] == result['revision']
    assert evidence['pdfRevision'] == revision(Path(evidence['pdfPath']))
    assert evidence['visualReview'] == 'pending'
    assert evidence['targetEditorVerification'] == 'unverified'
    if expected_pages is not None:
        assert evidence['pageCount'] == expected_pages, evidence
    return evidence


def run(runner, output):
    if output.exists() and any(output.iterdir()):
        raise ValueError('Use a fresh output directory; previous evidence must remain immutable')
    output.mkdir(parents=True, exist_ok=True)
    acceptance_path = ROOT / 'docs/development-logic/docx-user-acceptance.json'
    acceptance = json.loads(acceptance_path.read_text(encoding='utf-8'))
    known_checks = set(acceptance['toolChecks'])
    results = []

    def record(case, artifacts, checks):
        assert case in known_checks, 'tool check missing from public acceptance manifest: ' + case
        results.append({'case': case, 'automaticChecks': checks, 'automaticPass': True,
                        'requestCases': [item['id'] for item in acceptance['requestCases'] if case in item['toolChecks']],
                        'artifacts': artifacts, 'visualReview': 'pending',
                        'taskConversationReplay': 'not_run', 'wordWpsVerification': 'not_run'})
        print('PASS ' + case, flush=True)

    source = output / 'research.md'
    source.write_text('---\ntitle: 研究报告排版验收\n---\n\n# 研究结果\n\n'
                      '本段保留 16 个班级和 480 名参与者。行内公式 $x_1^2+\\hat{y}$。\n\n'
                      '$$\\frac{a}{b}+\\sqrt{x}$$\n\n'
                      '$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$\n\n'
                      '| 项目 | 数量 |\n|:--|--:|\n| 班级 | 16 |\n| 参与者 | 480 |\n', encoding='utf-8')
    report = output / 'research.docx'
    generated = export(runner, source, report)
    assert generated['nativeEquationCount'] == 3
    body = ''.join(text(report))
    assert all(marker in body for marker in ('16', '480', '研究结果'))
    rendered(generated)
    record('native_math_and_template', generated, ['3 native OMML formulas', 'required numbers and text preserved', 'PDF hash and revision match'])

    original_parts = package(report)
    read = invoke(runner, 'read_docx', {'path': str(report), 'limit': 100})
    target = next(p for p in read['paragraphs'] if '本段保留' in p['text'])
    changed = invoke(runner, 'edit_docx', {'path': str(report), 'expected_revision': read['revision'], 'edits': [
        {'paragraph_id': target['id'], 'old_string': '本段保留', 'new_string': '报告保留'}]})
    edited_parts = package(report)
    assert all(data == edited_parts[name] for name, data in original_parts.items() if name != 'word/document.xml')
    assert xml(report).xpath('count(//m:oMath)', namespaces=NS) == 3
    restored = invoke(runner, 'change_revert', {'change_id': changed['changeId']})
    assert restored['reverted']
    assert package(report) == original_parts
    record('text_edit_preserves_format', {'filePath': str(report)}, ['non-target package parts identical', 'native math preserved', 'undo restores exact package'])

    prose = output / 'prose.md'
    prose.write_text('# 统筹事项说明\n\n合并后的材料统一表述需求。\n\n'
                     '本次统筹选派 7 名人员，角色甲与角色乙共用人员，不重复计算。\n\n'
                     '后续安排采用文字说明，各项职责按段落表述。\n', encoding='utf-8')
    no_tables = output / 'prose.docx'
    prose_result = export(runner, prose, no_tables)
    assert not xml(no_tables).xpath('//w:tbl', namespaces=NS)
    assert '7' in ''.join(text(no_tables))
    rendered(prose_result)
    record('latest_instruction_no_tables', prose_result, ['zero Word tables', 'requested total 7 preserved'])

    reference = output / 'institution-reference.docx'
    custom = Document(ROOT / 'crates/runtime/assets/docx/research-reference.docx')
    custom.styles['Body Text'].font.size = Pt(14)
    custom.sections[0].left_margin = Mm(31)
    custom.save(reference)
    customised = output / 'custom-template.docx'
    custom_result = export(runner, prose, customised, reference)
    styles = etree.fromstring(package(customised)['word/styles.xml'])
    assert styles.xpath('//w:style[@w:styleId="BodyText"]/w:rPr/w:sz/@w:val', namespaces=NS) == ['28']
    assert xml(customised).xpath('//w:sectPr/w:pgMar/@w:left', namespaces=NS) == [str(round(31 * 1440 / 25.4))]
    assert custom_result['templateRevision'] == revision(reference)
    rendered(custom_result)
    record('supplied_template_is_authority', custom_result, ['supplied body style and margin used', 'template revision recorded'])

    facing = output / 'two-pages-input.docx'
    document = Document(ROOT / 'crates/runtime/assets/docx/research-reference.docx')
    # Remove the Pandoc reference's sample body while keeping its actual styles.
    for node in list(document.element.body):
        if node.tag != qn('w:sectPr'):
            document.element.body.remove(node)
    document.add_paragraph('山间晨光', 'Title')
    for page in range(2):
        if page:
            document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        for line in range(20):
            paragraph = document.add_paragraph(f'第{page + 1}面第{line + 1:02d}句 清晨的光映在窗前 我们在平静中读懂新的篇章')
            paragraph.runs[0].font.size = Pt(24)
            paragraph.paragraph_format.line_spacing = 1.5
    document.save(facing)
    before_text = text(facing)
    read = invoke(runner, 'read_docx', {'path': str(facing), 'limit': 100})
    baseline = invoke(runner, 'render_docx', {'path': str(facing), 'expected_revision': read['revision']})
    assert baseline['state'] == 'rendered' and baseline['pageCount'] > 2, baseline
    operations = [{'paragraph_id': p['id'], 'font_name': 'Times New Roman', 'east_asia_font': '宋体',
                   'font_size_pt': 12, 'line_spacing': 1.15, 'space_before_pt': 0, 'space_after_pt': 4,
                   'keep_with_next': False, 'widow_control': True} for p in read['paragraphs']
                  if p['part'] == 'word/document.xml']
    operations.append({'paragraph_id': read['paragraphs'][0]['id'], 'font_size_pt': 20, 'alignment': 'center', 'keep_with_next': True})
    formatted = output / 'two-pages.docx'
    formatted_result = invoke(runner, 'format_docx', {'path': str(facing), 'expected_source_revision': read['revision'],
        'output_path': str(formatted), 'operations': operations})
    assert text(formatted) == before_text
    assert all(data == package(formatted)[name] for name, data in package(facing).items() if name != 'word/document.xml')
    body_paragraphs = [p for p in Document(formatted).paragraphs if p.text.startswith('第')]
    assert len(body_paragraphs) == 40
    assert all(p.paragraph_format.line_spacing == 1.15 and p.runs[0].font.size.pt == 12 for p in body_paragraphs)
    rendered(formatted_result, expected_pages=2)
    formatted_result['baselineEvidence'] = baseline
    record('two_pages_text_unchanged', formatted_result, ['input exceeds 2 pages; final is exactly 2 rendered pages', 'first and subsequent body paragraphs share font size and spacing', 'all text nodes identical', 'all other package parts identical'])

    old = report.read_bytes()
    bad = output / 'unsupported-math.md'
    bad.write_text('Unsupported $\\somniqUnknownCommand{x}$.', encoding='utf-8')
    invoke(runner, 'export_docx', {'source_path': str(bad), 'expected_source_revision': revision(bad),
           'output_path': str(report), 'expected_revision': revision(report)}, expect_error=True)
    assert report.read_bytes() == old
    invoke(runner, 'export_docx', {'source_path': str(source), 'expected_source_revision': 'sha256:stale',
           'output_path': str(report), 'expected_revision': revision(report)}, expect_error=True)
    assert report.read_bytes() == old
    missing = output / 'not-attached.md'
    invoke(runner, 'export_docx', {'source_path': str(missing), 'expected_source_revision': 'sha256:missing',
           'output_path': str(report), 'expected_revision': revision(report)}, expect_error=True)
    assert report.read_bytes() == old
    record('failed_or_unreadable_input_preserves_output', {'filePath': str(report)}, ['unsupported math rejected', 'stale version rejected', 'unreadable source rejected', 'previous output unchanged'])

    protected = output / 'protected.docx'
    document = Document()
    paragraph = document.add_paragraph('需要保留的域')
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    paragraph._p.append(field)
    document.save(protected)
    rejected_output = output / 'must-not-exist.docx'
    invoke(runner, 'format_docx', {'path': str(protected), 'expected_source_revision': revision(protected),
        'output_path': str(rejected_output), 'operations': [{'paragraph_id': 'word/document.xml:p1', 'font_size_pt': 12}]}, expect_error=True)
    assert not rejected_output.exists()
    record('protected_objects_fail_closed', {'filePath': str(protected)}, ['field-containing formatting rejected', 'no partial output published'])

    from PIL import Image
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading
    figure = output / 'local figure.png'
    Image.new('RGB', (320, 160), '#2878b4').save(figure)
    image_source = output / 'local-image.md'
    image_source.write_text('# 本地图片\n\n![示意图](local%20figure.png)\n', encoding='utf-8')
    image_output = output / 'local-image.docx'
    image_result = export(runner, image_source, image_output)
    assert any(name.startswith('word/media/') and data == figure.read_bytes() for name, data in package(image_output).items())
    assert image_result['resources'] == [{'filePath': str(figure), 'revision': revision(figure)}]
    rendered(image_result)
    record('local_images_embedded', image_result, ['local image bytes embedded unchanged', 'image revision recorded', 'rendered without dropping image'])

    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(figure.read_bytes())
        def log_message(self, *_):
            pass
    server = HTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        remote = output / 'remote-image.md'
        remote.write_text(f'![remote](http://127.0.0.1:{server.server_port}/image.png)', encoding='utf-8')
        invoke(runner, 'export_docx', {'source_path': str(remote), 'expected_source_revision': revision(remote),
               'output_path': str(report), 'expected_revision': revision(report)}, expect_error=True)
        assert not requests, 'export fetched a remote resource'
        assert report.read_bytes() == old
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
    record('external_resources_not_fetched', {'filePath': str(report)}, ['remote image rejected before fetch', 'zero localhost probe requests', 'previous document unchanged'])

    # Rasterise the exact evidence PDF for human/independent inspection, never
    # automatically promote that inspection to a pass.
    import pypdfium2 as pdfium
    from pypdf import PdfReader
    import importlib.metadata
    for result in results:
        evidence = result['artifacts'].get('evidence')
        if not evidence or not evidence.get('pdfPath'):
            continue
        pdf = pdfium.PdfDocument(evidence['pdfPath'])
        pages = output / (result['case'] + '-pages')
        pages.mkdir(exist_ok=True)
        page_records = []
        for index in range(len(pdf)):
            page = pdf.get_page(index)
            bitmap = page.render(scale=1.5)
            page_path = pages / f'page-{index + 1}.png'
            with bitmap.to_pil() as page_image:
                page_image.save(page_path)
            page_records.append({'page': index + 1, 'path': str(page_path), 'revision': revision(page_path)})
            bitmap.close()
            page.close()
        result['pageImages'] = str(pages)
        result['pageRecords'] = page_records
        fonts = set()
        for page in PdfReader(evidence['pdfPath']).pages:
            font_dictionary = page.get('/Resources', {}).get_object().get('/Font', {})
            for font in font_dictionary.get_object().values():
                fonts.add(str(font.get_object().get('/BaseFont', 'unknown')))
        result['pdfFonts'] = sorted(fonts)
        pdf.close()
    manifest = {'scope': 'production tool integration on anonymised request-derived fixtures and engineering controls',
                'acceptanceManifestRevision': revision(acceptance_path),
                'runnerRevision': revision(runner),
                'runtimeSourceRevision': revision(ROOT / 'crates/runtime/src/document_export.rs'),
                'formatterSourceRevision': revision(ROOT / 'crates/runtime/assets/docx/format_docx.py'),
                'rasterizer': 'pypdfium2 ' + importlib.metadata.version('pypdfium2'),
                'originalUserDocuments': False, 'results': results,
                'visualReview': 'pending', 'wordWpsVerification': 'not_run', 'taskConversationReplay': 'not_run'}
    (output / 'results.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': len(results), 'results': str(output / 'results.json'), 'visualReview': 'pending'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.runner.resolve(), args.output.resolve())
