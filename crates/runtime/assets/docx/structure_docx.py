"""Bounded native edits using python-docx; no pagination or general editor.

Paragraph IDs refer to the original snapshot. Explicit text/offset anchors are
required; there is no implicit cursor. Unselected package members stay byte exact.
"""
import csv
from copy import deepcopy
from io import BytesIO
import re
from zipfile import ZipFile

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree

from format_docx import ALIGNMENTS, check_document, paragraph_at, text_runs, split_run, signature


def grid_table(table, document):
    if 'Table Grid' in document.styles:
        table.style = 'Table Grid'
        return
    # Imported DOCX files need not define Word's built-in Table Grid style.
    # Direct native borders avoid modifying or replacing their style catalogue.
    borders = OxmlElement('w:tblBorders')
    for edge in ('top','left','bottom','right','insideH','insideV'):
        border = OxmlElement('w:' + edge)
        for key,value in (('val','single'),('sz','4'),('space','0'),('color','auto')):
            border.set(qn('w:'+key),value)
        borders.append(border)
    table._tbl.tblPr.insert_element_before(borders,'w:shd','w:tblLayout','w:tblCellMar',
        'w:tblLook','w:tblCaption','w:tblDescription','w:tblPrChange')


def plain(paragraph, expected, allow_numbering=False, allow_tabs=False):
    text_runs(paragraph, allow_tabs=allow_tabs)
    if paragraph.text != expected:
        raise ValueError('text_conflict: exact original paragraph text required')
    protected = ('sectPr',) if allow_numbering else ('sectPr', 'numPr')
    if paragraph.paragraph_format.page_break_before or any(list(paragraph._p.iter(qn('w:' + tag))) for tag in protected):
        raise ValueError('protected_paragraph: section, numbering or page boundary')


def at_offset(paragraph, offset):
    """Return the run before which insertion occurs; split only plain text runs."""
    runs = text_runs(paragraph)
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= len(paragraph.text):
        raise ValueError('invalid_offset: use zero-based Unicode code points')
    position = 0
    for run in runs:
        end = position + len(run.text)
        if position == offset:
            return run._r
        if position < offset < end:
            split_run(run, offset - position)
            return run._r.getnext()
        position = end
    return None


def insert_run(paragraph, offset):
    next_element = at_offset(paragraph, offset)
    run = paragraph.add_run()
    if next_element is not None:
        next_element.addprevious(run._r)
    return run


def field_run(paragraph, instruction, result):
    # The document skill and Pandoc's DOCX writer use the same OOXML field
    # sequence. python-docx has no public field API; keep this helper bounded.
    run = paragraph.add_run()
    begin, code, separate, end = [OxmlElement('w:' + name) for name in
                                 ('fldChar', 'instrText', 'fldChar', 'fldChar')]
    begin.set(qn('w:fldCharType'), 'begin')
    begin.set(qn('w:dirty'), 'true')
    code.set(qn('xml:space'), 'preserve')
    code.text = ' ' + instruction + ' '
    separate.set(qn('w:fldCharType'), 'separate')
    end.set(qn('w:fldCharType'), 'end')
    run._r.extend((begin, code, separate))
    text = OxmlElement('w:t')
    text.text = result
    run._r.extend((text, end))
    return run


def merge_package(original, output, document, touched_parts, overrides=None):
    """Save via upstream, publish only intentional parts and additive rels/types."""
    memory = BytesIO()
    document.save(memory)
    with ZipFile(memory) as saved:
        new_parts = set(saved.namelist()) - set(original.namelist())
        changes = {'word/document.xml': saved.read('word/document.xml')}
        for name in touched_parts:
            changes[name] = saved.read(name)
        changes.update(overrides or {})
        for name in ('word/_rels/document.xml.rels', '[Content_Types].xml'):
            old, new = etree.fromstring(original.read(name)), etree.fromstring(saved.read(name))
            identity = lambda node: node.get('Id') if name.endswith('.rels') else (node.tag, node.get('PartName') or node.get('Extension'))
            entries = {identity(node): node for node in old}
            added = False
            for node in new:
                key = identity(node)
                if key not in entries:
                    if name == '[Content_Types].xml':
                        # python-docx can promote an old default content type
                        # into redundant overrides (e.g. embedded TTF fonts).
                        # Only new parts need added type declarations.
                        part, extension = node.get('PartName'), node.get('Extension')
                        needed = (part is not None and part.lstrip('/') in new_parts) or (
                            extension is not None and any(path.rsplit('.', 1)[-1] == extension for path in new_parts))
                        if not needed:
                            continue
                    old.append(deepcopy(node))
                    added = True
                elif dict(entries[key].attrib) != dict(node.attrib):
                    raise ValueError('protected_relationship_changed: ' + name)
            if added:
                changes[name] = etree.tostring(old, xml_declaration=True, encoding='UTF-8', standalone=True)
        for name in new_parts:
            if name not in touched_parts and not name.startswith('word/media/'):
                raise ValueError('unexpected_new_part: ' + name)
            changes[name] = saved.read(name)
        with ZipFile(output, 'w') as target:
            target.comment = original.comment
            for item in original.infolist():
                # ZipFile updates header_offset while writing a ZipInfo. Keep
                # the input archive usable for the staged TOC and final save.
                target.writestr(deepcopy(item), changes.pop(item.filename, original.read(item)))
            for name, data in changes.items():
                target.writestr(name, data)


def structure_document(source, output, plan):
    with ZipFile(source) as original:
        document = Document(source)
        root = document.element
        from office_docx import (native_page_numbers, repeat_table_header, section_orientation,
                                 remove_personal_metadata, accept_revisions, fill_content_control, populate_toc)
        operations = plan['operations']
        actions = {op['action'] for op in operations}
        accept = 'accept_revisions' in actions
        controls = 'fill_content_control' in actions
        if accept and actions - {'accept_revisions', 'remove_personal_metadata'}:
            raise ValueError('revision_batch: accept revisions in a separate snapshot before other edits')
        if controls and actions - {'fill_content_control', 'remove_personal_metadata'}:
            raise ValueError('control_batch: fill controls in a separate snapshot before other edits')
        allowed = ('ins', 'del', 'pPrChange', 'rPrChange') if accept else ('sdt',) if controls else ()
        check_document(original, root, allow_fields=True, allow_tags=allowed)
        # Existing fields may be outside the selected text (e.g. a TOC in a
        # page-number task). Retain their nodes and bytes; targeted text-run
        # operations still refuse to cross any field boundary.
        original_fields = [(node, etree.tostring(node,method='c14n')) for node in root.iter()
                           if node.tag in {qn('w:'+tag) for tag in ('fldSimple','fldChar','instrText')}]
        paragraphs = list(root.iter(qn('w:p')))
        if not 1 <= len(operations) <= 64:
            raise ValueError('structure_limit: supply 1-64 operations')
        touched, seen, overrides = set(), set(), {}
        toc = None
        protected_math = signature(root)[1]
        for op in operations:
            action = op['action']
            if action == 'page_numbers':
                native_page_numbers(document, op, touched, field_run, ALIGNMENTS)
                continue
            if action == 'section_orientation':
                section_orientation(document, op)
                continue
            if action == 'remove_personal_metadata':
                remove_personal_metadata(document, original, touched, overrides)
                continue
            if action == 'accept_revisions':
                accept_revisions(root)
                for name in original.namelist():
                    if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml', name):
                        story = etree.fromstring(original.read(name))
                        before = etree.tostring(story, method='c14n')
                        accept_revisions(story)
                        if etree.tostring(story, method='c14n') != before:
                            overrides[name] = etree.tostring(story, xml_declaration=True, encoding='UTF-8', standalone=True)
                continue
            if action == 'fill_content_control':
                fill_content_control(root, op)
                continue
            identity = op.get('paragraph_id')
            if action == 'text_to_table':
                selected = []
                for item in op['paragraphs']:
                    element = paragraph_at(paragraphs, item['paragraph_id'])
                    p = Paragraph(element, document)
                    plain(p, item['expected_text'], allow_tabs=True)
                    if element.getparent() is not root.body:
                        raise ValueError('protected_paragraph: table conversion requires direct body paragraphs')
                    selected.append(p)
                if not 1 <= len(selected) <= 128 or len({id(p._p) for p in selected}) != len(selected):
                    raise ValueError('invalid_table_selection')
                if any(a._p.getnext() is not b._p for a,b in zip(selected, selected[1:])):
                    raise ValueError('noncontiguous_table_selection')
                for item in op['paragraphs']:
                    if item['paragraph_id'] in seen:
                        raise ValueError('overlapping_operations: use each snapshot paragraph once')
                    seen.add(item['paragraph_id'])
                delimiter = op['delimiter']
                if len(delimiter) != 1 or delimiter in '\r\n\x00':
                    raise ValueError('invalid_delimiter')
                rows = list(csv.reader([p.text for p in selected], delimiter=delimiter, strict=True))
                columns = len(rows[0])
                if not 1 <= columns <= 32 or any(len(row) != columns for row in rows):
                    raise ValueError('uneven_table: every row must have the same number of cells')
                table = document.add_table(rows=len(rows), cols=columns)
                grid_table(table, document)
                selected[0]._p.addprevious(table._tbl)
                for row, values, source_p in zip(table.rows, rows, selected):
                    # Keep existing rich-run emphasis in unquoted delimited
                    # text; quoting needs a dedicated lossless mapping.
                    if '"' in source_p.text:
                        raise ValueError('quoted_table_text: rich quoted CSV is unsupported')
                    from format_docx import range_runs
                    offset = 0
                    for cell, value in zip(row.cells, values):
                        target_p = cell.paragraphs[0]
                        if source_p._p.pPr is not None:
                            target_p._p.insert(0, deepcopy(source_p._p.pPr))
                        if value:
                            runs = range_runs(source_p, {'start':offset,'end':offset+len(value),'expected_text':value}, allow_tabs=True)
                            for run in runs:
                                target_p._p.append(deepcopy(run._r))
                        offset += len(value) + len(delimiter)
                for p in selected:
                    p._p.getparent().remove(p._p)
                continue
            if identity in seen:
                raise ValueError('overlapping_operations: use each snapshot paragraph once')
            seen.add(identity)
            element = paragraph_at(paragraphs, identity)
            paragraph = Paragraph(element, document)
            if action == 'repeat_table_header':
                repeat_table_header(document, paragraph, op)
            elif action == 'insert_table_of_contents':
                plain(paragraph, op['expected_text'])
                if element.getparent() is not root.body or toc is not None:
                    raise ValueError('invalid_toc_anchor: one direct body placeholder required')
                toc = (paragraph, op.get('levels', 3))
            elif action == 'insert_blank_page':
                if element.getparent() is not root.body or paragraph.text != op['expected_text']:
                    raise ValueError('invalid_page_anchor: exact body paragraph required')
                if element.pPr is not None and element.pPr.find(qn('w:sectPr')) is not None:
                    raise ValueError('protected_page_anchor: section carrier')
                # Use upstream paragraph and break APIs. A separate empty
                # paragraph avoids splitting the anchor's content/keep rules;
                # pageBreakBefore plus the trailing break enclose an empty page.
                blank = document.add_paragraph()
                blank.paragraph_format.page_break_before = True
                blank.paragraph_format.keep_with_next = False
                blank.paragraph_format.keep_together = False
                blank.paragraph_format.space_before = Pt(0)
                blank.paragraph_format.space_after = Pt(0)
                blank.add_run().add_break(WD_BREAK.PAGE)
                element.addnext(blank._p)
            elif action == 'insert_image':
                # Objects outside this simple target paragraph remain opaque.
                plain(paragraph, op['expected_text'])
                width = op['width_pt']
                if not 1 <= width <= 1584:
                    raise ValueError('invalid_image_width')
                # Rust stages a verified, local resource; never read an arbitrary
                # tool-supplied path or fetch an external relationship here.
                resource = plan['_resources'][op['image_path']]
                run = insert_run(paragraph, op['offset'])
                run.add_picture(resource, width=Pt(width))
            elif action == 'insert_breaks':
                # Breaks within a list item do not change its numbering or
                # paragraph properties. Keep that native list definition intact.
                plain(paragraph, op['expected_text'], allow_numbering=True)
                breaks = op['breaks']
                if not 1 <= len(breaks) <= 256:
                    raise ValueError('break_limit')
                anchors = {offset: at_offset(paragraph, offset) for offset in sorted({item['offset'] for item in breaks}, reverse=True)}
                for item in breaks:
                    run = paragraph.add_run()
                    anchor = anchors[item['offset']]
                    if anchor is not None:
                        anchor.addprevious(run._r)
                    if item['kind'] == 'tab':
                        run.add_tab()
                    elif item['kind'] in ('line', 'page'):
                        run.add_break(WD_BREAK.LINE if item['kind'] == 'line' else WD_BREAK.PAGE)
                    else:
                        raise ValueError('invalid_break_kind')
            elif action == 'insert_table':
                if element.getparent() is not root.body or paragraph.text != op['expected_text']:
                    raise ValueError('invalid_table_anchor: exact body paragraph required')
                rows, columns = op['rows'], op['columns']
                if not 1 <= rows <= 128 or not 1 <= columns <= 32 or rows * columns > 1024:
                    raise ValueError('table_limit')
                table = document.add_table(rows=rows, cols=columns)
                grid_table(table, document)
                if op['position'] == 'before':
                    element.addprevious(table._tbl)
                elif op['position'] == 'after':
                    element.addnext(table._tbl)
                else:
                    raise ValueError('invalid_table_position')
            elif action == 'bibliography_reference':
                plain(paragraph, op['expected_text'])
                name, number, entry = op['bookmark'], op['number'], op['entry']
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,39}', name) or not 1 <= number <= 100000:
                    raise ValueError('invalid_reference')
                if not entry.strip() or len(entry) > 16384 or '\n' in entry or '\r' in entry:
                    raise ValueError('invalid_bibliography_entry')
                if any(n.get(qn('w:name')) == name for n in root.iter(qn('w:bookmarkStart'))):
                    raise ValueError('duplicate_bookmark')
                marker = op['marker']
                if not marker or paragraph.text.count(marker) != 1:
                    raise ValueError('ambiguous_reference_marker')
                start = paragraph.text.index(marker)
                # Split exact marker boundaries, then replace only the selected
                # text with a native REF field linked to a bookmarked number.
                from format_docx import range_runs
                selected = range_runs(paragraph, {'start':start, 'end':start+len(marker), 'expected_text':marker})
                target = field_run(paragraph, 'REF ' + name + ' \\r \\h', str(number))
                selected[0]._r.addprevious(target._r)
                for run in selected:
                    element.remove(run._r)
                anchor_element = paragraph_at(paragraphs, op['after_paragraph_id'])
                anchor = Paragraph(anchor_element, document)
                if anchor_element.getparent() is not root.body or anchor.text != op['after_expected_text']:
                    raise ValueError('invalid_bibliography_anchor')
                numbering = anchor_element.pPr.numPr if anchor_element.pPr is not None else None
                if numbering is None or numbering.numId is None or numbering.numId.val == 0:
                    raise ValueError('numbered_bibliography_required: anchor must have direct native numbering')
                if anchor_element.pPr.find(qn('w:sectPr')) is not None:
                    raise ValueError('protected_bibliography_anchor: section carrier')
                num_id = numbering.numId.val
                level = numbering.ilvl.val if numbering.ilvl is not None else 0
                definitions = document.part.numbering_part.element
                nums = definitions.xpath(f'w:num[@w:numId="{num_id}"]')
                if len(nums) != 1:
                    raise ValueError('invalid_numbering_definition')
                abstract_id = nums[0].abstractNumId.val
                levels = definitions.xpath(f'w:abstractNum[@w:abstractNumId="{abstract_id}"]/w:lvl[@w:ilvl="{level}"]')
                if len(levels) != 1 or levels[0].find(qn('w:numFmt')) is None or levels[0].find(qn('w:numFmt')).get(qn('w:val')) != 'decimal':
                    raise ValueError('unsupported_bibliography_numbering: decimal list required')
                start_node = levels[0].find(qn('w:start'))
                start_values = nums[0].xpath(f'w:lvlOverride[@w:ilvl="{level}"]/w:startOverride/@w:val') or [start_node.get(qn('w:val')) if start_node is not None else '1']
                preceding = 0
                for p in paragraphs:
                    props = p.pPr.numPr if p.pPr is not None else None
                    if props is not None and props.numId is not None and props.numId.val == num_id:
                        p_level = props.ilvl.val if props.ilvl is not None else 0
                        if p_level != level:
                            raise ValueError('unsupported_bibliography_numbering: mixed levels')
                        preceding += 1
                    if p is anchor_element:
                        break
                if int(start_values[0]) + preceding != number:
                    raise ValueError('reference_number_conflict: supplied number is not the next native list number')
                added = document.add_paragraph()
                anchor_element.addnext(added._p)
                # Use the preceding entry's existing paragraph/run styles.
                if anchor_element.pPr is not None:
                    added._p.insert(0, deepcopy(anchor_element.pPr))
                ids = [int(n.get(qn('w:id'))) for n in root.iter(qn('w:bookmarkStart')) if (n.get(qn('w:id')) or '').isdigit()]
                bookmark_id = str(max(ids, default=0) + 1)
                begin, end = OxmlElement('w:bookmarkStart'), OxmlElement('w:bookmarkEnd')
                begin.set(qn('w:id'), bookmark_id)
                begin.set(qn('w:name'), name)
                end.set(qn('w:id'), bookmark_id)
                added._p.append(begin)
                added_run = added.add_run(entry)
                exemplar = next((run for run in anchor.runs if run.text.strip()), None)
                if exemplar is not None and exemplar._r.rPr is not None:
                    added_run._r.insert(0, deepcopy(exemplar._r.rPr))
                added._p.append(end)
            else:
                raise ValueError('unsupported_structure_operation: ' + action)
        if signature(root)[1] != protected_math:
            raise ValueError('protected_equations_changed')
        if any(node.getparent() is None or etree.tostring(node,method='c14n') != data for node,data in original_fields):
            raise ValueError('protected_fields_changed')
        if toc is not None:
            populate_toc(document, *toc, output, original, touched, merge_package, field_run, overrides)
        merge_package(original, output, document, touched, overrides)
        return len(operations)
