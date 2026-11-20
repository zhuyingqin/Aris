"""Apply a bounded formatting plan through python-docx, preserving package parts.

The Rust host owns revisions, paths, process lifetime, audit and publication.
Formatting preserves content; a separate mode deletes explicitly verified plain
body paragraphs through python-docx's existing XML tree, never rebuilding text.
"""
import argparse
import json
import platform
import re
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx import __version__ as docx_version
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree

ALIGNMENTS = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'center': WD_ALIGN_PARAGRAPH.CENTER,
              'right': WD_ALIGN_PARAGRAPH.RIGHT, 'justify': WD_ALIGN_PARAGRAPH.JUSTIFY}
PROTECTED = ('ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'altChunk', 'fldSimple',
             'fldChar', 'instrText', 'customXml', 'pPrChange', 'rPrChange')
NUMERIC = {'font_size_pt': (5, 72), 'line_spacing': (0.5, 4),
           'space_before_pt': (0, 144), 'space_after_pt': (0, 144),
           'first_line_indent_pt': (-144, 144)}
ALLOWED = {'paragraph_id', 'style', 'font_name', 'east_asia_font', 'alignment',
           'keep_with_next', 'widow_control', 'compact_empty_paragraph', 'range',
           'run_filter', 'subscript', 'superscript', 'strikethrough', 'color',
           'tab_stops', *NUMERIC}
CHARACTER = {'font_name', 'east_asia_font', 'font_size_pt', 'subscript',
             'superscript', 'strikethrough', 'color'}


def signature(root):
    # Formatting-only operations must preserve all visible text and native math.
    # Splitting an existing run must not change visible text or object order.
    # Keep per-paragraph boundaries and all non-formatting inline XML opaque.
    text = []
    for paragraph in root.iter(qn('w:p')):
        tokens = []
        for node in paragraph:
            if node.tag == qn('w:pPr'):
                continue
            if node.tag == qn('w:r'):
                for child in node:
                    if child.tag == qn('w:rPr'):
                        continue
                    if child.tag == qn('w:t'):
                        if tokens and isinstance(tokens[-1], str):
                            tokens[-1] += child.text or ''
                        else:
                            tokens.append(child.text or '')
                    else:
                        tokens.append(etree.tostring(child, method='c14n'))
            elif node.tag == qn('w:hyperlink'):
                clone = deepcopy(node)
                for props in list(clone.iter(qn('w:rPr'))):
                    props.getparent().remove(props)
                tokens.append(etree.tostring(clone, method='c14n'))
            else:
                tokens.append(etree.tostring(node, method='c14n'))
        text.append(tokens)
    math = [etree.tostring(node, method='c14n') for node in root.iter(qn('m:oMath'))]
    return text, math


def text_runs(paragraph, allow_tabs=False):
    """Plain direct runs only; never split a drawing, field, bookmark or link."""
    element = paragraph._p
    if any(child.tag not in {qn('w:pPr'), qn('w:r'), qn('w:proofErr')} for child in element):
        raise ValueError('protected_range: requires plain direct text runs')
    runs = list(paragraph.runs)
    allowed = {qn('w:rPr'), qn('w:t')}
    if allow_tabs:
        allowed.add(qn('w:tab'))
    if any(child.tag not in allowed for run in runs for child in run._r):
        raise ValueError('protected_range: range crosses an object or structural boundary')
    return runs


def split_run(run, offset):
    """Copy rPr/attributes, using python-docx to encode the two text fragments."""
    if offset <= 0 or offset >= len(run.text):
        return
    text = run.text
    right_element = deepcopy(run._r)
    # Some imported files repeat identical size properties. Do not multiply
    # their baseline schema errors into each newly split fragment. Keep the
    # original node intact, and only collapse identical sizes in the new copy.
    if right_element.rPr is not None:
        for tag in ('sz', 'szCs'):
            sizes = right_element.rPr.findall(qn('w:' + tag))
            if len(sizes) > 1:
                first = etree.tostring(sizes[0], method='c14n')
                if any(etree.tostring(node, method='c14n') != first for node in sizes[1:]):
                    raise ValueError('protected_range: conflicting duplicate run sizes')
                for node in sizes[1:]:
                    right_element.rPr.remove(node)
    run._r.addnext(right_element)
    right = Run(right_element, run._parent)
    run.text, right.text = text[:offset], text[offset:]


def range_runs(paragraph, selection, allow_tabs=False):
    runs = text_runs(paragraph, allow_tabs=allow_tabs)
    if not isinstance(selection, dict) or set(selection) != {'start', 'end', 'expected_text'}:
        raise ValueError('invalid_range: start, end and expected_text required')
    start, end = selection['start'], selection['end']
    text = paragraph.text
    if any(isinstance(n, bool) or not isinstance(n, int) for n in (start, end)) or not 0 <= start < end <= len(text):
        raise ValueError('invalid_range: offsets are zero-based Unicode code points')
    if text[start:end] != selection['expected_text']:
        raise ValueError('text_conflict: range text does not match')
    for boundary in (end, start):
        position = 0
        for run in text_runs(paragraph, allow_tabs=allow_tabs):
            if position < boundary < position + len(run.text):
                split_run(run, boundary - position)
                break
            position += len(run.text)
    selected, position = [], 0
    for run in text_runs(paragraph, allow_tabs=allow_tabs):
        if start <= position < end and run.text:
            selected.append(run)
        position += len(run.text)
    return selected


def effective_italic(run, paragraph, document):
    if run.italic is not None:
        return run.italic
    # OOXML style booleans are toggle properties, unlike direct formatting.
    default = document.styles.element.find(qn('w:docDefaults'))
    value = False
    if default is not None:
        node = default.find('.//' + qn('w:i'))
        value = node is not None and node.get(qn('w:val'), '1') not in ('0', 'false', 'off')
    for style in (paragraph.style, run.style):
        chain, seen = [], set()
        while style is not None and style.style_id not in seen:
            seen.add(style.style_id)
            chain.append(style)
            style = style.base_style
        for item in reversed(chain):
            if item.font.italic:
                value = not value
    return value


def check_document(original, root, allow_fields=False, allow_tags=()):
    if any(name.startswith('_xmlsignatures/') for name in original.namelist()):
        raise ValueError('signed_document: editing invalidates signatures')
    tags = [tag for tag in PROTECTED if tag not in allow_tags and (not allow_fields or tag not in ('fldSimple', 'fldChar', 'instrText'))]
    if any(list(root.iter(qn('w:' + tag))) for tag in tags):
        raise ValueError('protected_document: fields, tracked changes and controls require a specialised editor')


def paragraph_at(paragraphs, identity):
    prefix = 'word/document.xml:p'
    if not isinstance(identity, str) or not identity.startswith(prefix) or not identity[len(prefix):].isdigit():
        raise ValueError('paragraph_not_found: only main-document paragraph IDs are supported')
    index = int(identity[len(prefix):]) - 1
    if index < 0 or index >= len(paragraphs):
        raise ValueError('paragraph_not_found')
    return paragraphs[index]


def plain_body_paragraph(element, document):
    if element.getparent() is not document.element.body:
        raise ValueError('protected_paragraph: only direct body paragraphs can be removed or compacted')
    # Reject native math, fields, breaks, sections, references, links, drawings,
    # text boxes and unknown content. Formatting properties remain opaque.
    content = [element, *element.iterchildren()]
    for child in element:
        if child.tag == qn('w:r'):
            content.extend(child)
    if any(node.tag not in {qn('w:' + name) for name in ('p', 'pPr', 'r', 'rPr', 't')} for node in content):
        raise ValueError('protected_paragraph: paragraph contains objects or structural content')
    if any(list(element.iter(qn('w:' + name))) for name in ('sectPr', 'numPr', 'pageBreakBefore')):
        raise ValueError('protected_paragraph: paragraph has a section, numbering or page break')
    paragraph = Paragraph(element, document)
    style = paragraph.style
    visited = set()
    while style is not None and style.style_id not in visited:
        visited.add(style.style_id)
        if style.paragraph_format.page_break_before or list(style.element.iter(qn('w:numPr'))):
            raise ValueError('protected_paragraph: paragraph inherits a page break or numbering')
        style = style.base_style
    return paragraph


def write_main_document(original, output, root):
    xml = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    with ZipFile(output, 'w') as target:
        target.comment = original.comment
        for item in original.infolist():
            target.writestr(item, xml if item.filename == 'word/document.xml' else original.read(item))


def format_document(source: Path, output: Path, plan: dict) -> None:
    with ZipFile(source) as original:
        document = Document(source)
        root = document.element
        check_document(original, root)
        before = signature(root)
        paragraphs = list(root.iter(qn('w:p')))
        operations = plan['operations']
        if not 1 <= len(operations) <= 64:
            raise ValueError('format_limit: supply 1-64 operations')
        for operation in operations:
            if not isinstance(operation, dict) or set(operation) - ALLOWED:
                raise ValueError('unsupported_property')
            element = paragraph_at(paragraphs, operation['paragraph_id'])
            paragraph = Paragraph(element, document)
            for key, (low, high) in NUMERIC.items():
                if key in operation:
                    value = operation[key]
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                        raise ValueError('invalid_value: ' + key)
            for key in ('style', 'font_name', 'east_asia_font'):
                if key in operation and (not isinstance(operation[key], str) or not operation[key].strip() or len(operation[key]) > 128):
                    raise ValueError('invalid_value: ' + key)
            for key in ('keep_with_next', 'widow_control', 'compact_empty_paragraph', 'subscript', 'superscript', 'strikethrough'):
                if key in operation and not isinstance(operation[key], bool):
                    raise ValueError('invalid_value: ' + key)
            if 'range' in operation or 'run_filter' in operation:
                if set(operation) - {'paragraph_id', 'range', 'run_filter', *CHARACTER}:
                    raise ValueError('conflicting_properties: range/filter accepts character properties only')
                if not set(operation) & CHARACTER:
                    raise ValueError('invalid_range: character property required')
            if 'run_filter' in operation and operation['run_filter'] != 'italic':
                raise ValueError('invalid_value: run_filter must be italic')
            if operation.get('subscript') and operation.get('superscript'):
                raise ValueError('conflicting_properties: subscript and superscript')
            if 'color' in operation and not re.fullmatch(r'[0-9a-fA-F]{6}', operation['color']):
                raise ValueError('invalid_value: color must be six hexadecimal digits')
            if operation.get('compact_empty_paragraph'):
                plain_body_paragraph(element, document)
                if paragraph.text.strip():
                    raise ValueError('not_empty: only empty or whitespace-only body paragraphs can be compacted')
                if set(operation) - {'paragraph_id', 'compact_empty_paragraph', 'font_name', 'east_asia_font'}:
                    raise ValueError('conflicting_properties: compact mode owns empty-paragraph spacing and size')
                fmt = paragraph.paragraph_format
                fmt.space_before = fmt.space_after = Pt(0)
                fmt.line_spacing = Pt(1)
                fmt.keep_with_next = fmt.keep_together = fmt.widow_control = False
                # Empty paragraphs often have NO runs. WPS also measures the
                # paragraph-mark rPr (including complex-script size).
                ppr = element.get_or_add_pPr()
                marker = ppr.find(qn('w:rPr'))
                if marker is None:
                    marker = OxmlElement('w:rPr')
                    ppr.append(marker)
                for tag in ('sz', 'szCs'):
                    node = marker.find(qn('w:' + tag))
                    if node is None:
                        node = OxmlElement('w:' + tag)
                        marker.append(node)
                    node.set(qn('w:val'), '2')
                snap = ppr.find(qn('w:snapToGrid'))
                if snap is None:
                    snap = OxmlElement('w:snapToGrid')
                    ppr.insert_element_before(snap, 'w:spacing', 'w:ind', 'w:contextualSpacing',
                        'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection',
                        'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId',
                        'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange')
                snap.set(qn('w:val'), '0')
            if 'style' in operation:
                paragraph.style = document.styles[operation['style']]
            if 'alignment' in operation:
                paragraph.alignment = ALIGNMENTS[operation['alignment']]
            fmt = paragraph.paragraph_format
            for key in ('keep_with_next', 'widow_control', 'line_spacing'):
                if key in operation:
                    setattr(fmt, key, operation[key])
            for key in ('space_before_pt', 'space_after_pt', 'first_line_indent_pt'):
                if key in operation:
                    setattr(fmt, key.removesuffix('_pt'), Pt(operation[key]))
            if 'tab_stops' in operation:
                stops = operation['tab_stops']
                if not isinstance(stops, list) or not 1 <= len(stops) <= 16:
                    raise ValueError('invalid_value: supply 1-16 tab stops')
                for stop in stops:
                    if set(stop) != {'position_pt', 'alignment'} or stop['alignment'] not in ('left', 'right', 'center', 'decimal'):
                        raise ValueError('invalid_value: tab stop')
                    position = stop['position_pt']
                    if isinstance(position, bool) or not isinstance(position, (int, float)) or not 0 < position <= 1584:
                        raise ValueError('invalid_value: tab position')
                    fmt.tab_stops.add_tab_stop(Pt(position), getattr(WD_TAB_ALIGNMENT, stop['alignment'].upper()), WD_TAB_LEADER.SPACES)
            runs = list(paragraph.runs)
            for hyperlink in paragraph.hyperlinks:
                runs.extend(hyperlink.runs)
            if 'range' in operation:
                runs = range_runs(paragraph, operation['range'])
            if 'run_filter' in operation:
                runs = [run for run in runs if effective_italic(run, paragraph, document)]
            for run in runs:
                if operation.get('compact_empty_paragraph'):
                    run.font.size = Pt(1)
                if 'font_name' in operation:
                    run.font.name = operation['font_name']
                    for theme in ('asciiTheme', 'hAnsiTheme'):
                        run._r.rPr.rFonts.attrib.pop(qn('w:' + theme), None)
                if 'font_size_pt' in operation:
                    run.font.size = Pt(operation['font_size_pt'])
                if 'east_asia_font' in operation:
                    fonts = run._r.get_or_add_rPr().get_or_add_rFonts()
                    fonts.set(qn('w:eastAsia'), operation['east_asia_font'])
                    fonts.attrib.pop(qn('w:eastAsiaTheme'), None)
                for key, attribute in (('subscript', 'subscript'), ('superscript', 'superscript'), ('strikethrough', 'strike')):
                    if key in operation:
                        setattr(run.font, attribute, operation[key])
                if 'color' in operation:
                    run.font.color.rgb = RGBColor.from_string(operation['color'])
                    color = run._r.rPr.find(qn('w:color'))
                    for key in ('themeColor', 'themeTint', 'themeShade'):
                        color.attrib.pop(qn('w:' + key), None)
        if signature(root) != before:
            raise ValueError('protected_content_changed')
        # python-docx supplies the XML. Preserve every other original ZIP member,
        # including media, styles, relationships, notes and original metadata.
        write_main_document(original, output, root)


def delete_paragraphs(source: Path, output: Path, plan: dict) -> int:
    with ZipFile(source) as original:
        document = Document(source)
        root = document.element
        check_document(original, root)
        paragraphs = list(root.iter(qn('w:p')))
        deletions = plan['deletions']
        if not 1 <= len(deletions) <= 128:
            raise ValueError('delete_limit: supply 1-128 verified paragraphs')
        selected, identities = [], set()
        for deletion in deletions:
            if not isinstance(deletion, dict) or set(deletion) != {'paragraph_id', 'expected_text'}:
                raise ValueError('invalid_deletion: exact paragraph_id and expected_text required')
            identity = deletion['paragraph_id']
            if identity in identities:
                raise ValueError('duplicate_paragraph')
            identities.add(identity)
            element = paragraph_at(paragraphs, identity)
            paragraph = plain_body_paragraph(element, document)
            if not isinstance(deletion['expected_text'], str) or paragraph.text != deletion['expected_text']:
                raise ValueError('text_conflict: reread the paragraph and copy its exact text')
            selected.append(element)
        remaining = [element for element in paragraphs if element not in selected]
        if not remaining:
            raise ValueError('empty_document: keep at least one paragraph')
        before = [etree.tostring(element, method='c14n') for element in document.element.body if element not in selected]
        for element in selected:
            element.getparent().remove(element)
        after = [etree.tostring(element, method='c14n') for element in document.element.body]
        if before != after:
            raise ValueError('protected_content_changed: non-target document children changed')
        write_main_document(original, output, root)
        return len(selected)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--mode', choices=('format', 'delete_paragraphs', 'structure', 'odt_highlight'), default='format')
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    result = {'engineVersion': 'python-docx ' + docx_version, 'pythonVersion': platform.python_version()}
    if args.mode == 'structure':
        from structure_docx import structure_document
        result['appliedOperations'] = structure_document(args.source, args.output, plan)
    elif args.mode == 'odt_highlight':
        from importlib.metadata import version
        from format_odt import remove_highlight
        result['engineVersion'] = 'odfpy ' + version('odfpy') + ' / lxml ' + etree.__version__
        result['removedHighlights'] = remove_highlight(args.source, args.output)
    elif args.mode == 'delete_paragraphs':
        result['deletedParagraphs'] = delete_paragraphs(args.source, args.output, plan)
    else:
        format_document(args.source, args.output, plan)
    print(json.dumps(result))
