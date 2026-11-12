"""Original anonymous office fixtures; not customer or institutional documents."""
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor


def base(title):
    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.top_margin = section.bottom_margin = Mm(22)
    section.left_margin = section.right_margin = Mm(24)
    for name in ('Normal', 'Title', 'Heading 1', 'Heading 2'):
        style = document.styles[name]
        style.font.name, style.font.size = 'Times New Roman', Pt(12)
        style.font.color.rgb = RGBColor.from_string('000000')
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '宋体')
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.line_spacing = 1.15
    document.styles['Title'].font.size = Pt(20)
    document.styles['Heading 1'].font.size = Pt(16)
    document.styles['Heading 2'].font.size = Pt(14)
    document.core_properties.author = 'OFFICE_FIXTURE'
    document.core_properties.last_modified_by = 'OFFICE_FIXTURE'
    document.add_paragraph(title, 'Title')
    return document


def table(document, rows):
    result = document.add_table(rows=0, cols=len(rows[0]))
    result.style = 'Table Grid'
    for values in rows:
        cells = result.add_row().cells
        for cell, value in zip(cells, values):
            cell.text = value
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(4)
    return result


def sdt(paragraph, identifier, value, options=None):
    node, properties, content = [OxmlElement('w:' + name) for name in ('sdt', 'sdtPr', 'sdtContent')]
    identity = OxmlElement('w:id')
    identity.set(qn('w:val'), str(identifier))
    properties.append(identity)
    if options:
        dropdown = OxmlElement('w:dropDownList')
        for option in options:
            item = OxmlElement('w:listItem')
            item.set(qn('w:displayText'), option)
            item.set(qn('w:value'), option)
            dropdown.append(item)
        properties.append(dropdown)
    else:
        properties.append(OxmlElement('w:text'))
    run, text = OxmlElement('w:r'), OxmlElement('w:t')
    text.text = value
    run.append(text)
    content.append(run)
    node.extend((properties, content))
    paragraph._p.append(node)


def build(directory):
    directory.mkdir(parents=True, exist_ok=True)
    documents = {}

    d = base('系统维护通知')
    for value in ('办公室通知 2026-11-11', '各部门同事：',
                  '为完成网络设备升级，信息中心安排统一维护。',
                  '维护时间：2026年11月16日 18:00—20:00。',
                  '影响范围：办公网络及内部文件服务。',
                  '请提前保存工作文件，维护期间暂停上传大文件。',
                  '紧急事项请联系信息中心值班人员。', '办公室', '2026年11月11日'):
        p = d.add_paragraph(value)
        p.runs[0].font.size = Pt(14)
        p.paragraph_format.space_after = Pt(12)
    documents['office_notice'] = d

    d = base('项目例会纪要')
    d.add_paragraph('会议日期：2026年11月11日；地点：会议室A。')
    d.add_paragraph('参会人员：项目组示例成员；记录人：办公室。')
    table(d, [('行动项', '负责人', '截止日期'), ('整理采购清单', '陈工', '2026-11-18'),
              ('核对测试设备', '杨工', '2026-11-19'), ('汇总实施风险', '周工', '2026-11-21')])
    d.add_paragraph('下次会议：2026年11月23日；未决事项继续跟踪。')
    documents['meeting_minutes'] = d

    d = base('设备采购合同')
    d.add_paragraph('甲方：示例科技有限公司；乙方：示例设备有限公司。')
    p = d.add_paragraph('合同价款为人民币 ')
    p.add_run('12,').bold = True
    p.add_run('800.00').bold = True
    p.add_run(' 元（')
    p.add_run('含税').italic = True
    p.add_run('）。')
    d.add_paragraph('交付日期：2026年11月25日。')
    d.add_paragraph('验收标准：设备到货并完成双方确认，其他条款保持有效。')
    d.add_paragraph('甲方签字：________________    乙方签字：________________')
    documents['contract_edit'] = d

    d = base('差旅费用报销单')
    t = table(d, [('行政部', '', '项目号：OFF-011', ''), ('报销人', '周示例', '期间', '2026-11'),
                  ('项目', '单据数', '金额（元）', '说明'), ('交通', '2', '320.00', '高铁'),
                  ('住宿', '2', '960.00', '会议住宿'), ('补贴', '2', '200.00', '100元/天'),
                  ('合计', '', '1,480.00', '共6张单据')])
    t.cell(0, 0).merge(t.cell(0, 1))
    t.cell(0, 2).merge(t.cell(0, 3))
    t.cell(6, 0).merge(t.cell(6, 1))
    d.add_paragraph('经办人：____________  部门负责人：____________  财务复核：____________')
    documents['expense_form'] = d

    d = base('办公用品报价单')
    for value in ('品名\t数量\t单价（元）\t小计（元）', '打印纸,A4\t10\t28.50\t285.00',
                  '文件夹\t12\t7.25\t87.00', '记号笔\t6\t4.50\t27.00', '合计\t\t\t399.00'):
        d.add_paragraph(value)
    d.add_paragraph('报价有效期：2026年11月30日；价格含税，不含运输。')
    documents['quotation_table'] = d

    for key, title in (('report_pagination', '年度项目执行情况'), ('cover_page_numbering', '项目总结报告')):
        d = base(title)
        d.sections[0].header.paragraphs[0].text = '示例单位 · 内部资料'
        if key == 'cover_page_numbering':
            d.sections[0].different_first_page_header_footer = True
            d.add_paragraph('报告日期：2026年11月11日')
            d.add_paragraph('封面不显示页码，正文从下一页开始。')
        for page in range(3 if key == 'report_pagination' else 2):
            if page or key == 'cover_page_numbering':
                d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            d.add_paragraph(f'第{page + 1}部分 执行记录', 'Heading 1')
            for line in range(8):
                d.add_paragraph(f'RPT-{page + 1}-{line + 1:02d} 本期事项按计划推进，交付物与责任人已核对。')
        documents[key] = d

    d = base('项目联络名单')
    records = [f'{i:03d}｜成员示例{i}｜项目组｜010-5550-01{i:02d}' for i in range(1, 7)]
    for value in (records[0], records[1], records[2], records[1], records[3], records[0], records[4], records[5]):
        d.add_paragraph(value)
    documents['contact_deduplication'] = d

    d = base('对外情况说明')
    d.add_paragraph('联系人：周示例；电话：010-5550-0199。')
    d.add_paragraph('项目编号：PRJ-2026-011；预算金额：25,000.00元。')
    d.add_paragraph('本文仅用于说明本期项目进度。')
    d.core_properties.author = 'OFFICE_TEST_AUTHOR_031'
    d.core_properties.last_modified_by = 'OFFICE_TEST_REVIEWER_009'
    documents['external_redaction'] = d

    d = base('库存盘点明细')
    t = table(d, [('库存编码', '物品名称', '数量', '存放位置')] + [
        (f'INV-{i:03d}', f'办公物品{i:03d}', str(i % 9 + 1), f'A区{i % 5 + 1}架') for i in range(1, 61)])
    for row in t.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(4)
                p.paragraph_format.line_spacing = 1.0
                for run in p.runs:
                    run.font.size = Pt(10)
    documents['long_table_header'] = d

    d = base('库存分析报告')
    d.add_paragraph('本页为纵向封面，附件从下一节开始。')
    d.add_section(WD_SECTION_START.NEW_PAGE)
    d.add_paragraph('附录 库存汇总表', 'Heading 1')
    table(d, [tuple(f'字段{i}' for i in range(1, 11))] + [tuple(f'{i}-{j}' for j in range(1, 11)) for i in range(1, 5)])
    documents['landscape_appendix'] = d

    d = base('采购合同修订稿')
    p = d.add_paragraph('合同价款为人民币 ')
    for tag, value, identity in (('del', '10,000.00', '1'), ('ins', '11,000.00', '2')):
        node = OxmlElement('w:' + tag)
        for name, val in (('id', identity), ('author', '示例审阅人'), ('date', '2026-11-11T00:00:00Z')):
            node.set(qn('w:' + name), val)
        run = OxmlElement('w:r')
        text = OxmlElement('w:delText' if tag == 'del' else 'w:t')
        text.text = value
        run.append(text)
        node.append(run)
        p._p.append(node)
    p.add_run(' 元。')
    d.add_paragraph('交付与验收条款维持原约定。')
    documents['accept_revisions'] = d

    d = base('季度工作报告')
    d.add_paragraph('此处插入自动目录')
    for number in range(1, 4):
        d.add_paragraph(f'{number} 本期工作', 'Heading 1')
        d.add_paragraph(f'{number}.1 进度与成果', 'Heading 2')
        d.add_paragraph(f'季度事项{number}：过程记录及交付清单完整。')
    documents['automatic_contents'] = d

    d = base('人员信息登记表')
    sdt(d.add_paragraph('姓名：'), 1101, '请输入姓名')
    sdt(d.add_paragraph('部门：'), 1102, '行政', ('行政', '财务', '采购'))
    d.add_paragraph('请保留文字控件和部门下拉选项。')
    documents['fillable_controls'] = d

    paths = {}
    for key, document in documents.items():
        path = directory / (key + '.docx')
        document.save(path)
        paths[key] = path
    return paths
