"""Natural-language requests through Desktop's configured shared Chat runtime.

No anchors, revisions, operation names or tool plans are supplied to the model.
Inputs are anonymous fixtures. The driver uses production routing, prompt and
tools, but does not drive the UI or run the independent Reviewer.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from pypdf import PdfReader
import pypdfium2 as pdfium

from office_fixtures import build
from run_acceptance import NS, package, revision, text, xml
from run_office_acceptance import SOURCES, footer_numbers, pdf_heading_pages

ROOT = Path(__file__).resolve().parents[2]
OFFICE_CASES = ('quotation_table', 'cover_page_numbering', 'external_redaction',
                'automatic_contents', 'fillable_controls', 'accept_revisions',
                'long_table_header', 'landscape_appendix')


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def visible_files(workspace):
    return {str(p.relative_to(workspace)): revision(p) for p in workspace.rglob('*')
            if p.is_file() and p.relative_to(workspace).parts[0] != '.somniq'}


def render(runner, workspace, candidate, directory):
    request = {'tool': 'render_docx', 'input': {'path': str(candidate), 'expected_revision': revision(candidate)}}
    result = subprocess.run([str(runner), str(workspace)], input=json.dumps(request),
                            capture_output=True, encoding='utf-8', errors='replace', timeout=180)
    save(directory/'evaluation-tool-call.json', {**request, 'exitCode': result.returncode,
         'stdout': result.stdout, 'stderr': result.stderr})
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    evidence = json.loads(result.stdout)
    assert evidence['state'] == 'rendered', evidence
    assert evidence['documentRevision'] == revision(candidate)
    assert evidence['pdfRevision'] == revision(Path(evidence['pdfPath']))
    pages = []
    pdf = pdfium.PdfDocument(evidence['pdfPath'])
    reader = PdfReader(evidence['pdfPath'])
    for index in range(len(pdf)):
        page = pdf.get_page(index)
        bitmap = page.render(scale=1.5)
        image_path = directory/f'page-{index + 1:03d}.png'
        with bitmap.to_pil() as image:
            image.save(image_path)
        pages.append({'page': index+1, 'path': str(image_path), 'revision': revision(image_path),
                      'text': reader.pages[index].extract_text(), 'footerNumbers': footer_numbers(reader.pages[index])})
        bitmap.close()
        page.close()
    pdf.close()
    assert len(pages) == evidence['pageCount']
    return evidence, pages


def verify_document(key, source, output, evidence, pages):
    checks = []

    def check(label, value):
        checks.append({'label': label, 'passed': bool(value)})

    document = Document(output)
    original = Document(source)
    final_text = ''.join(text(output))
    pdf_text = ''.join(page['text'] for page in pages)
    if key == 'quotation_table':
        expected = [['品名','数量','单价（元）','小计（元）'], ['打印纸,A4','10','28.50','285.00'],
                    ['文件夹','12','7.25','87.00'], ['记号笔','6','4.50','27.00'], ['合计','','','399.00']]
        check('native table retains all five rows, commas and exact amounts', len(document.tables)==1 and
              [[c.text for c in row.cells] for row in document.tables[0].rows] == expected)
        check('numeric data cells are right aligned', bool(document.tables) and all(
              p.alignment == 2 for row in document.tables[0].rows[1:] for cell in row.cells[1:] for p in cell.paragraphs if p.text))
        delivered = output.with_suffix('.pdf')
        check('requested same-name PDF delivered with all values', delivered.is_file() and
              all(re.sub(r'\s+', '', c) in re.sub(r'\s+', '', ''.join(p.extract_text() for p in PdfReader(delivered).pages))
                  for row in expected for c in row if c))
        check('quotation note preserved on one page', len(pages)==1 and '报价有效期' in pdf_text)
    elif key == 'cover_page_numbering':
        check('original three pages and body text retained', len(pages)==3 and text(source)==text(output))
        check('cover unnumbered, body numbered 1 and 2', [[n['value'] for n in p['footerNumbers']] for p in pages] == [[],['1'],['2']])
        before, after = package(source), package(output)
        check('original headers preserved', all(after.get(n)==v for n,v in before.items() if n.startswith('word/header')))
    elif key == 'external_redaction':
        check('visible contact and phone replaced with requested values', '周示例' not in final_text+pdf_text and
              '010-5550-0199' not in final_text+pdf_text and '联系人A' in final_text and '已隐藏' in final_text)
        check('author and last saver cleared', not document.core_properties.author and not document.core_properties.last_modified_by)
        check('identifier and budget retained', 'PRJ-2026-011' in final_text and '25,000.00' in final_text)
    elif key == 'automatic_contents':
        lines = [p.text for p in document.paragraphs if '\t' in p.text]
        check('native TOC field populated with six entries', len(lines)==6 and
              any('TOC' in (n.text or '').split() for n in xml(output).xpath('//w:instrText', namespaces=NS)))
        check('all headings and body retained', all(p.text in final_text for p in original.paragraphs if p.text != '此处插入自动目录'))
        heading_pages = pdf_heading_pages(evidence['pdfPath'])
        check('each directory number identifies its actual heading page', len(lines)==6 and all(
              re.sub(r'\s+', '', line.rsplit('\t',1)[0]) in heading_pages.get(line.rsplit('\t',1)[1], '') for line in lines))
    elif key == 'fillable_controls':
        before, after = original.element.xpath('.//w:sdt'), document.element.xpath('.//w:sdt')
        check('name filled in retained native control', len(after)==len(before)==2 and ''.join(after[0].itertext(qn('w:t'))) == '周示例')
        check('properties, dropdown and options preserved', len(after)==2 and all(
              etree.tostring(a.find(qn('w:sdtPr')), method='c14n')==etree.tostring(b.find(qn('w:sdtPr')), method='c14n') for a,b in zip(before,after)) and
              etree.tostring(before[1], method='c14n')==etree.tostring(after[1], method='c14n'))
    elif key == 'accept_revisions':
        check('new amount accepted without deleted amount or revision nodes', '11,000.00' in final_text and '10,000.00' not in final_text and
              not document.element.xpath('.//w:ins|.//w:del'))
        check('other contract clause retained', '交付与验收条款维持原约定。' in final_text)
    elif key == 'long_table_header':
        check('native repeat header set', bool(document.element.xpath('.//w:tbl/w:tr[1]/w:trPr/w:tblHeader')))
        check('all original table text retained', text(source)==text(output))
        check('multiple pages with header on each and all 60 records', len(pages)>1 and all('库存编码' in p['text'] for p in pages) and
              all(f'INV-{i:03d}' in pdf_text for i in range(1,61)))
    elif key == 'landscape_appendix':
        check('two sections with only second landscape', len(document.sections)==2 and document.sections[0].page_width<document.sections[0].page_height and
              document.sections[1].page_width>document.sections[1].page_height)
        check('original text retained', text(source)==text(output))
        pdf = PdfReader(evidence['pdfPath'])
        check('actual PDF has portrait cover and landscape appendix', len(pages)==2 and pdf.pages[0].mediabox.width<pdf.pages[0].mediabox.height and
              pdf.pages[1].mediabox.width>pdf.pages[1].mediabox.height)
    return checks


def main(args):
    output = args.output.resolve()
    if output.exists():
        raise ValueError('use a fresh output directory')
    output.mkdir(parents=True)
    fixtures = build(output/'fixtures')
    requirements = json.loads((ROOT/'tools/docx/office_cases.json').read_text(encoding='utf-8'))
    requested = set(args.case or (*OFFICE_CASES, 'only_text', 'latest_no_tables'))
    assert requested <= set((*OFFICE_CASES, 'only_text', 'latest_no_tables'))
    cases = []
    metadata = {'scope': 'Natural-language model runs using Desktop configured connection, product prompt, shared Chat and production builtin routing/tools; no UI automation.',
        'startedAt': datetime.now(timezone.utc).isoformat(), 'agentRunnerRevision': revision(args.agent),
        'toolRunnerRevision': revision(args.runner), 'anonymousFixtures': True, 'originalCustomerFiles': False,
        'implementationRevisions': {name: revision(ROOT/name) for name in (*SOURCES,
            'desktop/src-tauri/examples/office_agent_acceptance.rs', 'tools/docx/run_agent_acceptance.py')},
        'harnessVersion': 2, 'evidenceOutsideWorkspace': True, 'futureTurnsWrittenBeforePresentation': False,
        'independentReviewer': 'not_run', 'wordWpsVerification': 'not_run', 'visualReview': 'pending'}
    for case_index, key in enumerate((*OFFICE_CASES, 'only_text', 'latest_no_tables'), 1):
        if key not in requested:
            continue
        # Neutral names do not disclose a later instruction in a case label.
        workspace = output/'workspaces'/f'case-{case_index:03d}'
        workspace.mkdir(parents=True)
        control = output/'evidence'/key
        control.mkdir(parents=True)
        agent_evidence = control/'agent'
        candidate = workspace/'result.docx'
        source = workspace/'input.docx'
        if key in OFFICE_CASES:
            shutil.copyfile(fixtures[key], source)
            instruction = next(c['request'] for c in requirements['cases'] if c['id']==key)
            if key == 'external_redaction':
                instruction += '姓名改为联系人A，电话改为已隐藏。'
            if key == 'fillable_controls':
                instruction += '姓名填写周示例。'
            request = {'workspace': str(workspace), 'request': f'请处理工作目录中的 input.docx：{instruction} 保留原文件，修改后的文件另存为 result.docx。'}
        elif key == 'only_text':
            source = workspace/'notes.txt'
            source.write_text('系统维护时间：2026年11月16日18:00至20:00。请同事提前保存文件。', encoding='utf-8')
            request = {'workspace': str(workspace), 'request': '读取 notes.txt，把它整理成简洁的办公通知。只在聊天中回复文字，不要创建或修改任何文件。'}
        else:
            request = {'workspace': str(workspace), 'turns': [
                '为办公项目组制作一份人员方案 result.docx，8人由统筹1人、联络1人和执行6人组成。请用表格呈现。',
                '改成总共7个人，统筹和联络各1人不变，其余为执行人员。不用做表格，改为正文段落，更新同一份 result.docx。']}
        before = visible_files(workspace)
        request['evidence_directory'] = str(agent_evidence)
        if key == 'latest_no_tables':
            request['snapshot_artifacts'] = ['result.docx']
        # The request is stdin only until completion. In particular, do not put
        # a future turn in a request.json the model can read before that turn.
        try:
            process = subprocess.run([str(args.agent)], input=json.dumps(request, ensure_ascii=False),
                capture_output=True, encoding='utf-8', errors='replace', cwd=ROOT,
                timeout=900 * len(request.get('turns', [request.get('request')])) + 120)
        finally:
            save(control/'request.json', request)
        save(control/'process.json', {'exitCode': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr})
        case = {'id': key, 'request': request, 'source': str(source) if source.exists() else None,
                'sourceRevision': before.get(source.name), 'checks': [], 'status': 'execution_error'}
        if key in ('only_text','latest_no_tables'):
            case['backendRequirement'] = 'REQ-07' if key=='only_text' else 'REQ-08'
        try:
            summary = json.loads((agent_evidence/'summary.json').read_text(encoding='utf-8'))
            calls_path = agent_evidence/'tool-calls.json'
            calls = json.loads(calls_path.read_text(encoding='utf-8')) if calls_path.exists() else []
            case.update(model=summary['model'], provider=summary['provider'], agentSummary=str(agent_evidence/'summary.json'),
                        toolCalls=len(calls), toolErrors=sum(c.get('error') is not None for c in calls))
            case['checks'].append({'label': 'model conversation completed', 'passed': process.returncode==0 and summary['conversationCompleted']})
            if source.exists():
                case['checks'].append({'label': 'original input unchanged', 'passed': revision(source)==before[source.name]})
                case['checks'].append({'label': 'Agent read the source itself', 'passed': any(c['tool'] in ('read_docx','read_file','read_files') and source.name in json.dumps(c['input']) for c in calls)})
            if key == 'only_text':
                final_text = summary['assistantText'] or ''
                case['checks'].append({'label': 'only chat text; no files created or modified', 'passed':
                    visible_files(workspace) == before and
                    '2026' in final_text and '18:00' in final_text and '20:00' in final_text})
            else:
                assert candidate.is_file(), 'Agent did not produce requested result.docx'
                case['candidate'], case['candidateRevision'] = str(candidate), revision(candidate)
                directory = control/'evaluation'
                directory.mkdir()
                evidence, pages = render(args.runner, workspace, candidate, directory)
                case['evidence'], case['pageImages'] = evidence, pages
                # Evaluator rendering is separate from the model's own actions.
                model_evidence = [json.loads(c['output']).get('evidence', json.loads(c['output']))
                    for c in calls if c.get('output') and c['tool'] in ('render_docx','format_docx','edit_docx_structure','export_docx_pdf','export_docx')]
                case['agentRenderedFinalRevision'] = any(e.get('state')=='rendered' and
                    e.get('documentRevision')==revision(candidate) for e in model_evidence)
                case['checks'].append({'label': 'Agent rendered the final document revision',
                                       'passed': case['agentRenderedFinalRevision']})
                if key in OFFICE_CASES:
                    case['checks'].extend(verify_document(key, source, candidate, evidence, pages))
                else:
                    doc = Document(candidate)
                    body = ''.join(text(candidate))
                    first = next((a for a in summary['turns'][0].get('artifacts', [])
                        if a.get('relativePath') == 'result.docx' and a.get('exists')), None)
                    first_path = Path(first['snapshotPath']) if first else None
                    first_text = ''.join(text(first_path)) if first_path else ''
                    first_valid = bool(first_path and Document(first_path).tables and
                        re.search(r'[8八]\s*[名人]', first_text) and re.search(r'执行.{0,12}[6六]\s*[名人]', first_text))
                    case['firstTurnSnapshot'] = str(first_path) if first_path else None
                    case['firstTurnRevision'] = revision(first_path) if first_path else None
                    case['checks'].append({'label': 'first turn actually produced eight people and a native table', 'passed': first_valid})
                    second = next((a for a in summary['turns'][-1].get('artifacts', [])
                        if a.get('relativePath') == 'result.docx' and a.get('exists')), None)
                    case['checks'].append({'label': 'second turn snapshot is the delivered final document', 'passed': bool(second) and
                        revision(Path(second['snapshotPath'])) == revision(candidate)})
                    case['checks'].append({'label': 'latest instruction yields seven people and no tables', 'passed': len(doc.tables)==0 and
                        bool(re.search(r'[7七]\s*[名人]', body)) and bool(re.search(r'执行.{0,12}[5五]\s*[名人]', body)) and
                        not re.search(r'[8八]\s*[名人]', body)})
                validator = ROOT/'tools/docx/validate/bin/Debug/net6.0/DocxValidate.dll'
                schema = subprocess.run(['dotnet', str(validator), str(candidate), str(source) if source.is_file() and source.suffix=='.docx' else str(candidate)],
                    capture_output=True, encoding='utf-8', errors='replace', timeout=60)
                schema_data = json.loads(schema.stdout)
                save(directory/'schema.json', schema_data)
                case['checks'].append({'label': 'no additional Open XML schema errors', 'passed': schema.returncode==0 and not schema_data['added']})
            case['status'] = 'automated_pass' if all(c['passed'] for c in case['checks']) else 'partial'
        except Exception as error:
            case['error'] = str(error)
        cases.append(case)
        save(output/'results.json', {**metadata, 'runState': 'in_progress', 'counts': dict(Counter(c['status'] for c in cases)), 'results': cases})
        print(key, case['status'], flush=True)
    assert all(revision(ROOT/name)==value for name,value in metadata['implementationRevisions'].items()), 'sources changed during run'
    save(output/'results.json', {**metadata, 'runState': 'complete', 'counts': dict(Counter(c['status'] for c in cases)), 'results': cases})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent', type=Path, required=True)
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', action='append')
    options = parser.parse_args()
    options.agent, options.runner = options.agent.resolve(), options.runner.resolve()
    main(options)
