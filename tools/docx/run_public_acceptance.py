"""Assess every pinned OSWorld Writer task against production native DOCX tools.

This is an operator-planned tool assessment, NOT an OSWorld VM/agent benchmark
score. No generated Python edits or UI fallbacks are counted as native support.
Selected, audited upstream scoring functions are loaded unchanged via AST so
their unused OCR dependencies do not have to be installed.
"""
import argparse
import ast
from collections import Counter
import contextlib
import colorsys
import hashlib
import io
import json
import logging
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Dict, List
from zipfile import ZipFile

from docx import Document
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml.ns import qn
from lxml import etree
from pypdf import PdfReader
import pypdfium2 as pdfium
from PIL import ImageChops

from fetch_public_corpus import OSWORLD_COMMIT, DATASET_COMMIT, TASK_DIRECTORY
from public_native_cases import NATIVE_KEYS, native_case, odt_case

ROOT = Path(__file__).resolve().parents[2]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
LABELS = {
    '0810415c': '前两段双倍行距', '0a0faba3': '制表位左右对齐',
    '0b17a146': 'H2O 数字下标', '0e47de2a': '每页左下角页码',
    '0e763496': '全文 Times New Roman', '3ef2b351': '标题居中',
    '4bcb1253': '同名 PDF 导出', '66399b0d': '插入 7 列 5 行空表',
    '6a33f9b9': '删除 ODT 高亮', '6ada715d': '在光标处插入图片',
    '6f81754e': '列车记录按编号去重', '72b810ef': '末段添加删除线',
    '8472fece': '词表按元音分类着色', '88fe4b2d': '每句后加入空行',
    '936321ce': '逗号文本转换为表格', 'adf5e2c3': '文献及原生交叉引用',
    'b21acd93': '三段不同倍数行距和 12 磅字', 'bb8ccc78': '团队实时协作',
    'd53ff5ee': '全文转小写', 'e246f6d8': '仅斜体词改 14 磅',
    'e528b65e': '逐词首字母大写', 'ecc2413d': '插入空白页',
    'f178a4a9': '编辑器默认字体',
}
SELECTED_FUNCTIONS = {'compare_docx_files', 'compare_line_spacing', 'compare_font_names',
                      'is_first_line_centered', 'compare_unique_train_records',
                      'evaluate_strike_through_last_paragraph','check_italic_font_size_14',
                      'evaluate_colored_words_in_tables','_effective_run_rgb','_color_family',
                      'has_page_numbers_in_footers','contains_page_break'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def revision(path):
    return 'sha256:' + digest(path)


def package(path):
    with ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def document_xml(path):
    return etree.fromstring(package(path)['word/document.xml'])


def content_signature(path):
    root = document_xml(path)
    return ([''.join(p.itertext(qn('w:t'))) for p in root.iter(qn('w:p'))],
            [etree.tostring(node,method='c14n') for node in root.iter(qn('m:oMath'))])


def unchanged_parts(before, after):
    a, b = package(before), package(after)
    return a.keys() == b.keys() and all(data == b[name] for name, data in a.items()
                                     if name != 'word/document.xml')


def formatting_signature(path):
    return [etree.tostring(node, method='c14n') for node in document_xml(path).iter()
            if node.tag in (qn('w:rPr'), qn('w:pPr'))]


def load_scorers(corpus):
    path = corpus / 'source/desktop_env/evaluators/metrics/docs.py'
    tree = ast.parse(path.read_text(encoding='utf-8'))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                and node.name in SELECTED_FUNCTIONS]
    assert {node.name for node in selected} == SELECTED_FUNCTIONS
    namespace = {'Document': Document, 'WD_PARAGRAPH_ALIGNMENT': WD_PARAGRAPH_ALIGNMENT,
                 're': re, 'logger': logging.getLogger('upstream-docx-score'),
                 'List': List, 'Dict': Dict, 'Any': Any, 'colorsys':colorsys}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


def capitalise_words(text):
    # Apostrophes inside a word do not start a new word (America’s, Marquez’s).
    return re.sub(r"[^\W\d_][\w'’]*", lambda match: match[0][0].upper() + match[0][1:], text)


class Assessment:
    def __init__(self, corpus, runner, output, task_prefixes=None):
        if output.exists() and any(output.iterdir()):
            raise ValueError('Use a fresh output directory; evidence is immutable')
        output.mkdir(parents=True, exist_ok=True)
        self.corpus, self.runner, self.output = corpus, runner, output
        self.task_prefixes=task_prefixes
        self.calls, self.results, self.page_files = [], [], []
        self.implementation_revisions = {p:revision(ROOT/p) for p in (
            'crates/runtime/src/document_export.rs','crates/runtime/src/docx.rs',
            'crates/runtime/assets/docx/format_docx.py','crates/runtime/assets/docx/structure_docx.py',
            'crates/runtime/assets/docx/format_odt.py','tools/docx/run_public_acceptance.py','tools/docx/public_native_cases.py',
            'crates/tools/src/lib.rs','crates/chat/src/lib.rs','crates/runtime/assets/prompts/system.md')}
        self.sources = json.loads((corpus / 'sources.json').read_text(encoding='utf-8'))
        self.assets = json.loads((corpus / 'asset-manifest.json').read_text(encoding='utf-8'))
        assert self.sources['commit'] == OSWORLD_COMMIT
        assert json.loads((corpus / 'dataset.json').read_text())['commit'] == DATASET_COMMIT
        for item in self.sources['files']:
            assert digest(corpus / 'source' / item['path']) == item['sha256'], item['path']
        for item in self.assets:
            assert item['download'] == 'ok'
            assert digest(corpus / item['localPath']) == item['sha256'], item['localPath']
        self.scorers = load_scorers(corpus)

    def undo(self, case, result, output, expected):
        record = self.ok(self.invoke('change_get', {'change_id': result['changeId']}))['record']
        self.check(case, 'published output has a reversible binary audit record',
                   record['reversible'] and record['after']['contentKind'] == 'binary')
        reverted = self.ok(self.invoke('change_revert', {'change_id': result['changeId']}))
        self.check(case, 'undo restores exact previous bytes or removes a newly created output',
                   reverted['reverted'] and (not output.exists() if expected is None else output.read_bytes() == expected))

    def invoke(self, tool, data):
        response = subprocess.run([str(self.runner), str(ROOT)],
            input=json.dumps({'tool': tool, 'input': data}), capture_output=True,
            encoding='utf-8', errors='replace', timeout=360, cwd=ROOT)
        record = {'tool': tool, 'input': data, 'exitCode': response.returncode}
        if response.returncode:
            record['error'] = response.stderr[-4000:]
        else:
            record['result'] = json.loads(response.stdout)
        self.calls.append(record)
        (self.output / 'tool-calls.json').write_text(json.dumps(self.calls, ensure_ascii=False, indent=2), encoding='utf-8')
        return record

    @staticmethod
    def ok(call):
        if call['exitCode']:
            raise RuntimeError(call['error'])
        return call['result']

    def read(self, source):
        paragraphs, offset = [], 0
        while True:
            read = self.ok(self.invoke('read_docx', {'path': str(source), 'offset': offset, 'limit': 100}))
            paragraphs.extend(read['paragraphs'])
            if read.get('nextOffset') is None:
                read['paragraphs'] = paragraphs
                return read
            offset = read['nextOffset']

    def check(self, case, label, condition, **facts):
        case.setdefault('checks', []).append({'label': label, 'passed': bool(condition), **facts})

    def score(self, case, name, *args):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            score = self.scorers[name](*args)
        case.setdefault('upstreamScores', []).append({'function': name, 'score': score,
                                                    'diagnostic': buffer.getvalue()[-2000:]})
        return score

    def page_evidence(self, case, result, source):
        evidence = result.get('evidence', result)
        case['evidence'] = evidence
        if evidence['state'] != 'rendered':
            self.check(case, 'production PDF rendering completed', False, state=evidence['state'])
            return
        self.check(case, 'PDF and exact input revision bound to evidence',
                   evidence['documentRevision'] == revision(source)
                   and evidence['pdfRevision'] == revision(Path(evidence['pdfPath'])))
        self.check(case, 'native evidence has not claimed independent visual approval',
                   evidence['visualReview'] == 'pending'
                   and evidence['targetEditorVerification'] == 'unverified')
        page_dir = self.output / case['id'] / 'pages'
        page_dir.mkdir(parents=True, exist_ok=True)
        pdf = pdfium.PdfDocument(evidence['pdfPath'])
        text_pages = PdfReader(evidence['pdfPath']).pages
        blank_pages = []
        try:
            assert len(pdf) == evidence['pageCount']
            for index in range(len(pdf)):
                page = pdf[index]
                bitmap = page.render(scale=1.4)
                target = page_dir / f'page-{index + 1:03d}.png'
                with bitmap.to_pil().convert('RGB') as page_image:
                    page_image.save(target)
                    white = page_image.copy()
                    white.paste((255, 255, 255), (0, 0, *white.size))
                    blank = ImageChops.difference(page_image, white).getbbox() is None
                    white.close()
                if blank:
                    blank_pages.append(index + 1)
                bitmap.close()
                page.close()
                record = {'taskId': case['id'], 'page': index + 1, 'path': str(target), 'sha256': digest(target),
                          'allWhite': blank, 'extractedCharacters': len(text_pages[index].extract_text() or '')}
                self.page_files.append(record)
        finally:
            pdf.close()
        case['pageImages'] = [p for p in self.page_files if p['taskId'] == case['id']]
        case['blankPages'] = blank_pages

    def format(self, case, source, read, operations):
        output = self.output / case['id'] / source.name
        result = self.ok(self.invoke('format_docx', {'path': str(source),
            'expected_source_revision': read['revision'], 'output_path': str(output),
            'operations': operations}))
        case['outputPath'] = str(output)
        self.check(case, 'all source text nodes and other package parts preserved',
                   content_signature(source) == content_signature(output)
                   and unchanged_parts(source, output))
        self.page_evidence(case, result, output)
        return output

    def text_case(self, case, source, read, transform):
        output = self.output / case['id'] / source.name
        shutil.copyfile(source, output)
        xml = document_xml(source)
        read_by_id = {p['id']: p for p in read['paragraphs']}
        edits = []
        expected = []
        for index, paragraph in enumerate(xml.iter(qn('w:p')), 1):
            paragraph_id = f'word/document.xml:p{index}'
            snapshot = read_by_id[paragraph_id]
            for node in paragraph.iter(qn('w:t')):
                old = node.text or ''
                new = transform(old)
                expected.append(new)
                if new == old:
                    continue
                assert sum(segment.count(old) for segment in snapshot['editableSegments']) == 1, 'nonunique run text'
                edits.append({'paragraph_id': paragraph_id, 'old_string': old, 'new_string': new})
        for start in range(0, len(edits), 64):
            self.ok(self.invoke('edit_docx', {'path': str(output), 'expected_revision': revision(output),
                                           'edits': edits[start:start + 64]}))
        self.check(case, 'all text nodes transformed without changing run distribution',
                   document_xml(output).xpath('//w:t/text()', namespaces=NS) == [v for v in expected if v])
        self.check(case, 'original paragraph/run properties and other package parts preserved',
                   formatting_signature(source) == formatting_signature(output)
                   and unchanged_parts(source, output))
        gold = next(a for a in case['assets'] if a['role'] == 'gold')
        self.check(case, 'upstream text comparison matches public gold',
                   self.score(case, 'compare_docx_files', str(output), str(self.corpus / gold['localPath'])) == 1)
        self.page_evidence(case, self.ok(self.invoke('render_docx', {'path': str(output), 'expected_revision': revision(output)})), output)
        case['outputPath'] = str(output)

    def deduplicate(self, case, source, read):
        output = self.output / case['id'] / source.name
        seen, deletions, retained = set(), [], []
        for paragraph in read['paragraphs']:
            text = paragraph['text'].strip()
            parts = text.split(',')
            if len(parts) != 4:
                continue
            if parts[1] in seen:
                deletions.append({'paragraph_id': paragraph['id'], 'expected_text': paragraph['text']})
            else:
                seen.add(parts[1])
                retained.append(paragraph['text'])
        assert len(deletions) == 92 and len(retained) == 8
        plan = {'path': str(source), 'expected_source_revision': read['revision'],
                'output_path': str(output), 'deletions': deletions}
        result = self.ok(self.invoke('delete_docx_paragraphs', plan))
        self.check(case, 'one atomic batch removes exactly 92 records and retains first occurrences in order',
                   result['deletedParagraphs'] == 92
                   and [p.text for p in Document(output).paragraphs if p.text.strip()] == retained)
        selected = {item['paragraph_id'] for item in deletions}
        body = document_xml(source).find(qn('w:body'))
        ids = {p: f'word/document.xml:p{i}' for i, p in enumerate(body.iter(qn('w:p')), 1)}
        expected_children = [etree.tostring(child, method='c14n') for child in body if ids.get(child) not in selected]
        self.check(case, 'all remaining document children and other package parts preserved',
                   expected_children == [etree.tostring(child, method='c14n') for child in document_xml(output).find(qn('w:body'))]
                   and unchanged_parts(source, output))
        gold = next(a for a in case['assets'] if a['role'] == 'gold')
        self.check(case, 'upstream train-record deduplication score',
                   self.score(case, 'compare_unique_train_records', str(output), [str(self.corpus / gold['localPath']), str(source)]) == 1)
        old_blanks = sum(not p.text.strip() for p in Document(source).paragraphs)
        new_blanks = sum(not p.text.strip() for p in Document(output).paragraphs)
        self.check(case, 'deleted records do not leave extra empty paragraphs', new_blanks <= old_blanks,
                   beforeEmptyParagraphs=old_blanks, afterEmptyParagraphs=new_blanks,
                   explanation='Additional product-quality check; the upstream metric ignores empty paragraphs.')
        self.page_evidence(case, result, output)
        self.check(case, 'deduplicated records fit on one nonblank page',
                   case['evidence']['pageCount'] == 1 and case['blankPages'] == [])
        case['outputPath'] = str(output)
        # Exercise both real in-place replacement and candidate creation undo.
        scratch = output.with_name('undo-deletion.docx')
        scratch.write_bytes(source.read_bytes())
        replaced = self.ok(self.invoke('delete_docx_paragraphs', {**plan, 'path': str(scratch),
            'output_path': str(scratch), 'expected_revision': read['revision'], 'render_pdf': False}))
        self.undo(case, replaced, scratch, source.read_bytes())
        created = scratch.with_name('undo-created.docx')
        creation = self.ok(self.invoke('delete_docx_paragraphs', {**plan, 'output_path': str(created), 'render_pdf': False}))
        self.undo(case, creation, created, None)

    def run_task(self, task):
        key = task['id'][:8]
        (self.output / task['id']).mkdir(parents=True, exist_ok=True)
        case = {'id': task['id'], 'label': LABELS[key], 'instruction': task['instruction'],
                'origin': task.get('source'),
                'taskUrl': f'https://github.com/xlang-ai/OSWorld/blob/{OSWORLD_COMMIT}/{TASK_DIRECTORY}{task["id"]}.json',
                'assets': [a for a in self.assets if a['taskId'] == task['id']],
                'taskConversationReplay': 'not_run', 'wordWpsVerification': 'not_run',
                'independentVisualReview': 'not_run', 'executorVisualReview': 'pending'}
        inputs = [a for a in case['assets'] if a['role'] == 'input']
        main = next(a for a in inputs if a['localPath'].endswith(('.docx', '.odt')))
        source = self.corpus / main['localPath']
        source_hash = digest(source)
        try:
            if source.suffix == '.docx':
                read = self.read(source)
                case['inputInspection'] = {'state': 'read', 'paragraphs': read['totalParagraphs'],
                                           'revision': read['revision']}
            else:
                odt_case(self,case,source)
                case['status']='automated_pass' if all(c['passed'] for c in case['checks']) else 'partial'
                return case
            paragraphs = [p for p in read['paragraphs'] if p['part'] == 'word/document.xml']
            if key in ('bb8ccc78', 'f178a4a9'):
                case['status'] = 'outside_native_document_scope'
                case['executorVisualReview'] = 'not_applicable'
                case['limitation'] = ('上游自身标记 infeasible；未进行任何分享或外部上传。' if key == 'bb8ccc78'
                                      else '要求更改编辑器全局配置，不是文件字体；本轮只读，不修改系统设置。')
            elif key in NATIVE_KEYS:
                output=native_case(self,case,source,read,paragraphs)
            elif key == '0810415c':
                selected = [p for p in paragraphs if p['text'].strip()][:2]
                output = self.format(case, source, read, [{'paragraph_id': p['id'], 'line_spacing': 2} for p in selected])
                golds = [self.corpus / a['localPath'] for a in case['assets'] if a['role'] == 'gold']
                scores = [self.score(case, 'compare_line_spacing', str(output), str(g)) for g in golds]
                self.check(case, 'one of the upstream accepted line-spacing golds matches', max(scores) == 1)
            elif key == '0e763496':
                body = document_xml(source).find(qn('w:body'))
                all_paragraphs = list(body.iter(qn('w:p')))
                trailing=[]
                for p in reversed(list(body)[:-1]):
                    if p.tag!=qn('w:p') or ''.join(p.itertext(qn('w:t'))).strip():break
                    trailing.append(p)
                assert len(trailing)==3
                compact_ids = {f'word/document.xml:p{all_paragraphs.index(p) + 1}' for p in trailing}
                operations = [{'paragraph_id': p['id'], 'font_name': 'Times New Roman',
                    **({'compact_empty_paragraph': True} if p['id'] in compact_ids else {})} for p in paragraphs]
                output = self.format(case, source, read, operations)
                self.check(case, 'explicit trailing-empty-paragraph compaction removes the blank fourth page',
                           case['evidence']['pageCount'] == 3 and case['blankPages'] == [],
                           compactedParagraphIds=sorted(compact_ids))
                self.check(case, 'all trailing paragraph marks and complex-script sizes are explicitly 1 pt', all(
                    p.xpath('./w:pPr/w:rPr/w:sz/@w:val',namespaces=NS)==['2'] and
                    p.xpath('./w:pPr/w:rPr/w:szCs/@w:val',namespaces=NS)==['2']
                    for index,p in enumerate(document_xml(output).iter(qn('w:p')),1) if f'word/document.xml:p{index}' in compact_ids))
                self.check(case, 'upstream font-name score', self.score(case, 'compare_font_names', str(output), {'font_name': 'Times New Roman'}) == 1)
                runs = document_xml(output).xpath('//w:r[w:t]', namespaces=NS)
                self.check(case, 'font applied to all text including table cells', all(
                    r.xpath('./w:rPr/w:rFonts/@w:ascii', namespaces=NS) == ['Times New Roman']
                    and r.xpath('./w:rPr/w:rFonts/@w:hAnsi', namespaces=NS) == ['Times New Roman'] for r in runs))
            elif key == '3ef2b351':
                output = self.format(case, source, read, [{'paragraph_id': paragraphs[0]['id'], 'alignment': 'center'}])
                self.check(case, 'upstream heading-centering score', self.score(case, 'is_first_line_centered', str(output)) == 1)
            elif key == 'b21acd93':
                selected = [p for p in paragraphs if p['text'].strip()]
                assert len(selected) == 3
                output = self.format(case, source, read, [{'paragraph_id': p['id'], 'line_spacing': spacing,
                    'font_size_pt': 12} for p, spacing in zip(selected, (1, 2, 1.5))])
                gold = next(a for a in case['assets'] if a['role'] == 'gold')
                self.check(case, 'upstream three-paragraph spacing score', self.score(case, 'compare_line_spacing', str(output), str(self.corpus / gold['localPath'])) == 1)
                self.check(case, 'all essay text runs are 12 pt', all(r.font.size.pt == 12 for p in Document(output).paragraphs for r in p.runs if r.text))
            elif key in ('d53ff5ee', 'e528b65e'):
                self.text_case(case, source, read, str.lower if key == 'd53ff5ee' else capitalise_words)
            elif key == '6f81754e':
                self.deduplicate(case, source, read)
            elif key == '4bcb1253':
                copied_source = self.output / case['id'] / source.name
                shutil.copyfile(source, copied_source)
                plan = {'path': str(copied_source), 'expected_source_revision': read['revision']}
                result = self.ok(self.invoke('export_docx_pdf', plan))
                evidence = result['evidence']
                gold = next(a for a in case['assets'] if a['role'] == 'gold')
                gold_pdf = self.corpus / gold['localPath']
                pdf = Path(result['filePath'])
                case['outputPath'] = str(pdf)
                self.check(case, 'deliverable equals the audited rendered PDF bytes',
                           result['revision'] == revision(pdf) == evidence['pdfRevision']
                           and pdf.read_bytes() == Path(evidence['pdfPath']).read_bytes())
                actual, expected = PdfReader(pdf), PdfReader(gold_pdf)
                normalize = lambda text: re.sub(r'\s+', '', text or '')
                self.check(case, 'rendered PDF page count matches public reference', len(actual.pages) == len(expected.pages),
                           actual=len(actual.pages), expected=len(expected.pages))
                self.check(case, 'rendered PDF text matches reference on every page',
                    [normalize(p.extract_text()) for p in actual.pages] == [normalize(p.extract_text()) for p in expected.pages])
                self.check(case, 'original file stem retained for deliverable PDF', pdf.stem == source.stem,
                    actual=pdf.name, expected=source.with_suffix('.pdf').name)
                self.undo(case, result, pdf, None)
                result = self.ok(self.invoke('export_docx_pdf', plan))
                original_pdf = pdf.read_bytes()
                conflict = self.invoke('export_docx_pdf', plan)
                self.check(case, 'existing PDF cannot be overwritten without its current version',
                           conflict['exitCode'] != 0 and 'revision_conflict' in conflict['error']
                           and pdf.read_bytes() == original_pdf)
                replacement = self.ok(self.invoke('export_docx_pdf', {**plan, 'expected_revision': revision(pdf)}))
                self.undo(case, replacement, pdf, original_pdf)
                self.check(case, 'DOCX source is unchanged after PDF export and undo', digest(copied_source) == source_hash)
                # Rasterize the final deliverable's exact evidence after undo tests.
                self.page_evidence(case, result, copied_source)
                self.check(case, 'final PDF remains bound to its source and evidence',
                           revision(pdf) == result['revision'] == result['evidence']['pdfRevision']
                           and result['evidence']['documentRevision'] == revision(copied_source)
                           and [normalize(p.extract_text()) for p in PdfReader(pdf).pages]
                               == [normalize(p.extract_text()) for p in expected.pages])
                case['upstreamPdfMetric'] = 'not_run; original compare_pdfs requires separate image/VM dependencies; page and text checks are separate'
            else:
                raise AssertionError('task has no assessment: ' + key)
            if 'status' not in case:
                case['status'] = 'automated_pass' if all(c['passed'] for c in case['checks']) else 'partial'
        except Exception as error:
            case['status'] = 'failed'
            case['error'] = type(error).__name__ + ': ' + str(error)
        finally:
            assert digest(source) == source_hash, 'public input changed'
        return case

    def run(self):
        task_paths = sorted((self.corpus / 'source' / TASK_DIRECTORY).glob('*.json'))
        assert len(task_paths) == len(LABELS), 'upstream corpus changed; explicitly triage every task'
        if self.task_prefixes:
            assert set(self.task_prefixes)<=set(LABELS), 'unknown task prefix'
            task_paths=[p for p in task_paths if p.stem[:8] in self.task_prefixes]
        for path in task_paths:
            task = json.loads(path.read_text(encoding='utf-8'))
            case = self.run_task(task)
            self.results.append(case)
            print(case['id'][:8], case['status'], flush=True)
            self.save()
        # Corpus files remain pristine after all tool invocations.
        for item in self.assets:
            assert digest(self.corpus / item['localPath']) == item['sha256']
        return self.save()

    def save(self):
        result = {'scope': 'operator-planned production native DOCX/ODT tools; not a full model or OSWorld VM run',
            'osworldCommit': OSWORLD_COMMIT, 'datasetCommit': DATASET_COMMIT,
            'counts': dict(Counter(r['status'] for r in self.results)),
            'selectedTaskPrefixes':self.task_prefixes,
            'runnerRevision': revision(self.runner),
            'implementationRevisions': self.implementation_revisions,
            'results': self.results, 'pageImages': self.page_files}
        (self.output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--task-prefix',action='append',help='Focused rerun; omit for all 23 tasks')
    args = parser.parse_args()
    summary = Assessment(args.corpus.resolve(), args.runner.resolve(), args.output.resolve(),args.task_prefix).run()
    print(json.dumps(summary['counts']))
