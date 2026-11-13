"""Small office adapters over python-docx/OOXML and LibreOffice's index engine.

No pagination implementation: LibreOffice calculates the TOC cache. Untargeted
parts and original body nodes are retained by structure_docx.merge_package.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree


def native_page_numbers(document, op, touched, field_run, alignments):
    skip = op.get('skip_first_page', False)
    start = op.get('start_at')
    if start is not None and (isinstance(start, bool) or not 1 <= start <= 100000):
        raise ValueError('invalid_page_start: first visible number must be 1-100000')
    for index, section in enumerate(document.sections):
        if skip and index == 0:
            if not section.different_first_page_header_footer:
                # Enabling Different First Page also affects the header. Copy
                # the existing header so hiding a footer cannot hide its text.
                source = section.header
                if not source.is_linked_to_previous:
                    first = section.first_page_header
                    if not first.is_linked_to_previous and (first.tables or any(p.text for p in first.paragraphs)):
                        raise ValueError('nonempty_first_header: preserve existing first-page header')
                    for child in list(first._element):
                        first._element.remove(child)
                    for child in source._element:
                        if child.xpath('.//@r:id | .//@r:embed | .//@r:link'):
                            raise ValueError('linked_first_header: requires dedicated header relationship mapping')
                        first._element.append(deepcopy(child))
                    touched.add(str(first.part.partname).lstrip('/'))
                section.different_first_page_header_footer = True
            first_footer = section.first_page_footer
            if first_footer.tables or any(p.text.strip() or p._p.xpath('.//w:fldChar | .//w:fldSimple | .//w:drawing') for p in first_footer.paragraphs):
                raise ValueError('nonempty_footer: preserve existing first-page footer')
            touched.add(str(first_footer.part.partname).lstrip('/'))
        if index == 0 and (start is not None or skip):
            props = section._sectPr
            numbering = props.find(qn('w:pgNumType'))
            if numbering is None:
                numbering = OxmlElement('w:pgNumType')
                props.insert_element_before(numbering, 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid')
            numbering.set(qn('w:start'), str((start or 1) - int(skip)))
        footers = [section.footer]
        if section.different_first_page_header_footer and not (skip and index == 0):
            footers.append(section.first_page_footer)
        if document.settings.odd_and_even_pages_header_footer:
            footers.append(section.even_page_footer)
        for footer in footers:
            name = str(footer.part.partname).lstrip('/')
            if name in touched:
                continue
            if footer.tables or any(p.text.strip() or p._p.xpath('.//w:fldChar | .//w:fldSimple | .//w:drawing') for p in footer.paragraphs):
                raise ValueError('nonempty_footer: preserve existing footer; specialised placement required')
            paragraph = footer.paragraphs[0]
            paragraph.alignment = alignments[op['alignment']]
            field_run(paragraph, 'PAGE', str(start or 1))
            touched.add(name)


def repeat_table_header(document, paragraph, op):
    if paragraph.text != op['expected_text']:
        raise ValueError('text_conflict: table anchor changed')
    cells = paragraph._p.xpath('ancestor::w:tc')
    if not cells:
        raise ValueError('invalid_table_anchor: select a paragraph in the first row')
    row = cells[-1].getparent()
    table = row.getparent()
    rows = table.findall(qn('w:tr'))
    count = op.get('header_rows', 1)
    if not rows or rows[0] is not row or isinstance(count, bool) or not 1 <= count <= min(16, len(rows)):
        raise ValueError('invalid_header_rows: must include the first row')
    for row in rows[:count]:
        props = row.get_or_add_trPr()
        # CT_TrPr has no public repeat-header API in python-docx 1.2.0.
        nodes = props.findall(qn('w:tblHeader'))
        if len(nodes) > 1:
            raise ValueError('invalid_header_rows: duplicate existing properties')
        header = nodes[0] if nodes else OxmlElement('w:tblHeader')
        header.set(qn('w:val'), 'on')
        if not nodes:
            props.insert_element_before(header, 'w:tblCellSpacing', 'w:jc', 'w:hidden', 'w:ins', 'w:del', 'w:trPrChange')


def section_orientation(document, op):
    index = op['section_index']
    if isinstance(index, bool) or not 0 <= index < len(document.sections):
        raise ValueError('section_not_found: use zero-based section_index')
    section = document.sections[index]
    width, height = section.page_width, section.page_height
    if width is None or height is None:
        raise ValueError('missing_section_size')
    if op['orientation'] == 'landscape':
        section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width, section.page_height = max(width, height), min(width, height)
    elif op['orientation'] == 'portrait':
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width, section.page_height = min(width, height), max(width, height)
    else:
        raise ValueError('invalid_orientation')


def remove_personal_metadata(document, original, touched, overrides):
    document.core_properties.author = ''
    document.core_properties.last_modified_by = ''
    touched.add('docProps/core.xml')
    if 'docProps/app.xml' in original.namelist():
        root = etree.fromstring(original.read('docProps/app.xml'))
        for name in ('Company', 'Manager'):
            for node in root.findall('{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}' + name):
                node.text = None
        overrides['docProps/app.xml'] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


def accept_revisions(root):
    # Standard WordprocessingML run revisions: retain inserted runs, discard
    # deleted runs, retain current run/paragraph properties. Complex structural
    # or move revisions are rejected rather than silently flattening them.
    unsupported = ('moveFrom', 'moveTo', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'cellIns', 'cellDel', 'cellMerge', 'tblPrChange', 'tblGridChange', 'trPrChange', 'tcPrChange', 'sectPrChange', 'numberingChange')
    if any(list(root.iter(qn('w:' + tag))) for tag in unsupported):
        raise ValueError('unsupported_revision: structural or move revisions require a dedicated revision engine')
    for node in [n for n in root.iter() if n.tag in (qn('w:ins'), qn('w:del'))]:
        if node.getparent().tag not in (qn('w:p'), qn('w:hyperlink')) or any(child.tag != qn('w:r') for child in node):
            raise ValueError('unsupported_revision: only inline run insertion/deletion is supported')
    for node in [n for n in root.iter() if n.tag in {qn('w:' + tag) for tag in ('ins', 'del', 'rPrChange', 'pPrChange')}]:
        parent = node.getparent()
        if node.tag == qn('w:ins'):
            for child in list(node):
                node.addprevious(child)
        parent.remove(node)


def fill_content_control(root, op):
    matches = [node for node in root.iter(qn('w:sdt')) if
               node.find('w:sdtPr/w:id', root.nsmap) is not None and
               node.find('w:sdtPr/w:id', root.nsmap).get(qn('w:val')) == op['control_id']]
    if len(matches) != 1:
        raise ValueError('control_not_found: copy the unique control_id from read_docx')
    control = matches[0]
    props, content = control.find(qn('w:sdtPr')), control.find(qn('w:sdtContent'))
    if content is None or props.find(qn('w:dataBinding')) is not None or props.find(qn('w:lock')) is not None:
        raise ValueError('protected_control: bound or locked controls require their specialised workflow')
    if ''.join(content.itertext(qn('w:t'))) != op['expected_text']:
        raise ValueError('text_conflict: control value changed')
    value = op['text']
    if not isinstance(value, str) or len(value) > 16384 or any(ch in value for ch in '\r\n\t\x00'):
        raise ValueError('invalid_control_text: one plain text value required')
    dropdown = props.find(qn('w:dropDownList'))
    if props.find(qn('w:text')) is None and dropdown is None:
        raise ValueError('unsupported_control: only plain text and dropdown values are supported')
    if dropdown is not None:
        allowed = [item.get(qn('w:displayText')) or item.get(qn('w:value')) for item in dropdown]
        if value not in allowed:
            raise ValueError('invalid_control_choice: select an existing displayText')
    runs = list(content)
    if not runs or any(node.tag != qn('w:r') or any(c.tag not in (qn('w:rPr'), qn('w:t')) for c in node) for node in runs):
        raise ValueError('protected_control: only inline plain runs may be filled')
    # Reuse upstream run text encoding; do not replace the sdt or its options.
    Run(runs[0], None).text = value
    for node in runs[1:]:
        Run(node, None).text = ''


def populate_toc(document, anchor, levels, staged, original, touched, merge_package, field_run, overrides):
    if isinstance(levels, bool) or not 1 <= levels <= 9:
        raise ValueError('invalid_toc_levels')
    if any('TOC' in (node.text or '').split() for node in document.element.iter(qn('w:instrText'))):
        raise ValueError('existing_toc: insert requires a document without a TOC')
    marker = 'SOMNIQ_TOC_' + uuid.uuid4().hex
    anchor.clear()
    anchor.add_run(marker)
    update = document.settings.element.find(qn('w:updateFields'))
    if update is None:
        update = OxmlElement('w:updateFields')
        document.settings.element.insert_element_before(update, 'w:hdrShapeDefaults', 'w:footnotePr', 'w:endnotePr', 'w:compat', 'w:docVars', 'w:rsids', 'm:mathPr')
    update.set(qn('w:val'), 'true')
    touched.add('word/settings.xml')
    with tempfile.TemporaryDirectory(prefix='toc-', dir=Path(staged).parent) as folder:
        folder = Path(folder)
        source, result = folder/'index.docx', folder/'index.json'
        merge_package(original, source, document, touched, overrides)
        soffice = Path(os.environ.get('SOMNIQ_LIBREOFFICE', 'soffice.com' if os.name == 'nt' else 'soffice'))
        python = Path(os.environ.get('SOMNIQ_LIBREOFFICE_PYTHON', str(soffice.parent / ('python.exe' if os.name == 'nt' else 'python3'))))
        if not python.is_file():
            raise ValueError('toc_engine_unavailable: configure SOMNIQ_LIBREOFFICE_PYTHON with a Python runtime importing LibreOffice uno')
        env = dict(os.environ)
        env.pop('PYTHONPATH', None)
        env.pop('PYTHONHOME', None)
        command = [str(python), str(Path(__file__).with_name('toc_index.py')), str(soffice), str(source), str(result), marker, str(levels)]
        completed = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=95,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if completed.returncode:
            raise ValueError('toc_engine_failed: ' + completed.stderr[-3000:])
        entries = json.loads(result.read_text(encoding='utf-8'))['entries']
    if not entries or len(entries) > 4096 or not all('\t' in line['text'] and line['text'].rsplit('\t', 1)[1].strip() for line in entries):
        raise ValueError('toc_not_populated: the index engine returned no complete entries')
    anchor.clear()
    code_run = field_run(anchor, f'TOC \\o "1-{levels}" \\z \\u', '')
    end = code_run._r.find('w:fldChar[@w:fldCharType="end"]', document.element.nsmap)
    code_run._r.remove(end)
    nodes = list(code_run._r)
    anchor._p.remove(code_run._r)
    for node in nodes:
        if node.tag != qn('w:t'):
            anchor.add_run()._r.append(node)
    previous = anchor
    for index, entry in enumerate(entries):
        if index == 0:
            paragraph = anchor
        else:
            paragraph = document.add_paragraph()
            previous._p.addnext(paragraph._p)
        paragraph.paragraph_format.left_indent = Pt(14 * max(0, entry['level'] - 1))
        section = document.sections[0]
        paragraph.paragraph_format.tab_stops.add_tab_stop(section.page_width - section.left_margin - section.right_margin,
                                                         WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        paragraph.add_run(entry['text'])
        previous = paragraph
    run = previous.add_run()
    run._r.append(end)
