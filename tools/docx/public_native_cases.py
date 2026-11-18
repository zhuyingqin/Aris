"""Operator plans and semantic assertions for pinned public native-edit tasks."""
import re
import shutil
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from pypdf import PdfReader

NATIVE_KEYS={'0a0faba3','0b17a146','0e47de2a','66399b0d','6ada715d','72b810ef',
             '8472fece','88fe4b2d','936321ce','adf5e2c3','e246f6d8','ecc2413d'}
ENTRY='Steinberg, F. M., Bearden, M. M., & Keen, C. L. (2003). Cocoa and chocolate flavonoids: Implications for cardiovascular health. Journal of the American Dietetic Association, 103(2), 215-223. doi: 10.1053/jada.2003.50028'


def structure(assessment,case,source,read,operations,render=True):
    output=assessment.output/case['id']/source.name
    plan={'path':str(source),'expected_source_revision':read['revision'],'output_path':str(output),'operations':operations,'render_pdf':render}
    result=assessment.ok(assessment.invoke('edit_docx_structure',plan))
    case['outputPath']=str(output)
    if render:
        assessment.page_evidence(case,result,output)
    # Check the real binary ledger and undo a separate candidate, preserving the
    # exact main output for visual inspection.
    scratch=output.with_name('undo-check.docx')
    checked=assessment.ok(assessment.invoke('edit_docx_structure',{**plan,'output_path':str(scratch),'render_pdf':False}))
    assessment.undo(case,checked,scratch,None)
    return output


def odt_case(a,case,source):
    from run_public_acceptance import package,revision
    read=a.ok(a.invoke('read_odt',{'path':str(source)}))
    output=a.output/case['id']/source.name
    plan={'path':str(source),'expected_source_revision':read['revision'],'output_path':str(output)}
    result=a.ok(a.invoke('remove_odt_highlight',plan))
    before,after=package(source),package(output)
    ns={'style':'urn:oasis:names:tc:opendocument:xmlns:style:1.0','fo':'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'}
    allowed=True
    for name,data in before.items():
        if name in ('content.xml','styles.xml'):
            old,new=etree.fromstring(data),etree.fromstring(after[name])
            for doc in (old,new):
                for node in doc.xpath('//style:text-properties',namespaces=ns):
                    node.attrib.pop('{'+ns['fo']+'}background-color',None)
            allowed &= etree.tostring(old,method='c14n')==etree.tostring(new,method='c14n')
            highlights=etree.fromstring(after[name]).xpath('//style:text-properties/@fo:background-color',namespaces=ns)
            allowed &= all(color=='transparent' for color in highlights)
        else:allowed &= data==after[name]
    a.check(case,'only text-highlight attributes change; inherited styles, text, images and ODT package preserved',
            before.keys()==after.keys() and allowed and result['removedHighlights']>0,
            removedHighlights=result['removedHighlights'])
    reread=a.ok(a.invoke('read_odt',{'path':str(output)}))
    a.check(case,'ODT text and revision checked via production reader',read['paragraphs']==reread['paragraphs'] and reread['revision']==revision(output))
    case['outputPath']=str(output)
    a.page_evidence(case,result,output)
    scratch=output.with_name('undo-check.odt')
    checked=a.ok(a.invoke('remove_odt_highlight',{**plan,'output_path':str(scratch),'render_pdf':False}))
    a.undo(case,checked,scratch,None)
    return output


def native_case(a,case,source,read,paragraphs):
    from run_public_acceptance import package,document_xml,content_signature
    key=case['id'][:8]
    before=Document(source)
    if key=='0b17a146':
        ops=[]
        for p in paragraphs:
            for match in re.finditer('H2O',p['text']):
                ops.append({'paragraph_id':p['id'],'range':{'start':match.start()+1,'end':match.start()+2,'expected_text':'2'},'subscript':True})
        assert ops
        output=a.format(case,source,read,ops)
        for p in Document(output).paragraphs:
            offset=0
            selected={m.start()+1 for m in re.finditer('H2O',p.text)}
            for run in p.runs:
                if run.font.subscript:
                    a.check(case,'only H2O digit 2 is subscripted',set(range(offset,offset+len(run.text)))<=selected)
                offset+=len(run.text)
        a.check(case,'every requested H2O digit is a native subscript',sum(r.text.count('2') for p in Document(output).paragraphs for r in p.runs if r.font.subscript)==len(ops),occurrences=len(ops))
    elif key=='72b810ef':
        p=next(p for p in reversed(paragraphs) if p['text'].strip())
        output=a.format(case,source,read,[{'paragraph_id':p['id'],'strikethrough':True}])
        a.check(case,'last text paragraph is struck through',all(r.font.strike for r in Document(output).paragraphs[-1].runs if r.text))
        a.check(case,'upstream strike score',a.score(case,'evaluate_strike_through_last_paragraph',str(output),str(source))==1)
    elif key=='e246f6d8':
        ops=[{'paragraph_id':p['id'],'run_filter':'italic','font_size_pt':14} for p in paragraphs]
        output=a.format(case,source,read,ops)
        pairs=[(old,new) for p,q in zip(before.paragraphs,Document(output).paragraphs) for old,new in zip(p.runs,q.runs)]
        a.check(case,'italic runs are 14 pt; every other run size is unchanged',all(new.font.size.pt==14 if old.italic else old.font.size==new.font.size for old,new in pairs))
        a.check(case,'upstream italic-size score',a.score(case,'check_italic_font_size_14',str(output),str(source))==1)
    elif key=='8472fece':
        ops=[]
        body=document_xml(source).find(qn('w:body'))
        for p,element in zip(paragraphs,body.iter(qn('w:p'))):
            if not any(parent.tag==qn('w:tc') for parent in element.iterancestors()):continue
            for match in re.finditer(r"[^\W\d_]+(?:['’][^\W\d_]+)*",p['text']):
                color='FF0000' if match[0][0].lower() in 'aeiou' else '0000FF'
                ops.append({'paragraph_id':p['id'],'range':{'start':match.start(),'end':match.end(),'expected_text':match[0]},'color':color})
        assert len(ops)==52
        output=a.format(case,source,read,ops)
        a.check(case,'all 52 table words classified by first vowel/consonant; exact table text retained',a.score(case,'evaluate_colored_words_in_tables',str(output),str(source))==1)
    elif key=='0a0faba3':
        ops=[]
        width=(before.sections[0].page_width-before.sections[0].left_margin-before.sections[0].right_margin)/12700
        for p in paragraphs:
            words=list(re.finditer(r'\S+',p['text']))
            if len(words)<=3:continue
            ops.append({'action':'insert_breaks','paragraph_id':p['id'],'expected_text':p['text'],'breaks':[{'offset':words[2].end(),'kind':'tab'}]})
        intermediate=structure(a,case,source,read,ops,render=False)
        step=a.read(intermediate)
        final=intermediate.with_name('aligned.docx')
        result=a.ok(a.invoke('format_docx',{'path':str(intermediate),'expected_source_revision':step['revision'],'output_path':str(final),
            'operations':[{'paragraph_id':p['id'],'alignment':'left','tab_stops':[{'position_pt':width,'alignment':'right'}]} for p in step['paragraphs'] if '\t' in p['text']]}))
        a.page_evidence(case,result,final);case['outputPath']=str(final);output=final
        a.check(case,'first three words left of native tab; remaining words end at right margin',all(
            len(p.text.split('\t')[0].split())==3 and any(t.alignment==2 and abs(t.position.pt-width)<.1 for t in p.paragraph_format.tab_stops)
            for p in Document(final).paragraphs if '\t' in p.text))
        a.check(case,'no non-tab text lost', [p.text for p in before.paragraphs]==[p.text.replace('\t','') for p in Document(final).paragraphs])
    elif key=='0e47de2a':
        output=structure(a,case,source,read,[{'action':'page_numbers','alignment':'left'}])
        a.check(case,'upstream footer number score',a.score(case,'has_page_numbers_in_footers',str(output))==1)
        pages=PdfReader(case['evidence']['pdfPath']).pages
        positions=[]
        for i,p in enumerate(pages,1):
            found=[]
            def visitor(text,cm,tm,font,size):
                if text.strip()==str(i):
                    x=tm[4]*cm[0]+tm[5]*cm[2]+cm[4]
                    y=tm[4]*cm[1]+tm[5]*cm[3]+cm[5]
                    if 0<=x<float(p.mediabox.width)*.3 and 0<=y<float(p.mediabox.height)*.15:
                        found.append({'x':x,'y':y})
            p.extract_text(visitor_text=visitor)
            positions.append({'page':i,'bottomLeftNumbers':found})
        a.check(case,'every rendered page has its native page number at bottom left',all(p['bottomLeftNumbers'] for p in positions),pageCount=len(pages),positions=positions)
        a.check(case,'body text/objects preserved',content_signature(source)==content_signature(output))
    elif key=='66399b0d':
        # The pinned gold consumes the final whitespace spacers when inserting
        # its table. Explicitly compact those same three trailing paragraphs;
        # their two 133 pt after-spaces otherwise split the small empty table.
        trailing=paragraphs[76:79]
        assert len(trailing)==3 and [p['text'] for p in trailing]==['',' ','']
        prepared=a.output/case['id']/'prepared'/source.name
        prepared.parent.mkdir()
        a.ok(a.invoke('format_docx',{'path':str(source),'expected_source_revision':read['revision'],
            'output_path':str(prepared),'render_pdf':False,'operations':[
                {'paragraph_id':p['id'],'compact_empty_paragraph':True} for p in trailing]}))
        p=trailing[0]
        case['anchorEvidence']='Pinned gold inserts the second table after the existing table and replaces trailing whitespace spacing. Explicitly compact p77-p79, preserve their text, then insert after p77; no VM cursor replay.'
        output=structure(a,case,prepared,a.read(prepared),[{'action':'insert_table','paragraph_id':p['id'],'expected_text':p['text'],'position':'after','rows':5,'columns':7}])
        tables=Document(output).tables
        a.check(case,'adds one empty 5-row 7-column native table; original table retained',len(tables)==len(before.tables)+1 and len(tables[-1].rows)==5 and all(len(r.cells)==7 and all(not c.text for c in r.cells) for r in tables[-1].rows)
            and tables[0]._tbl.xml==before.tables[0]._tbl.xml)
        a.check(case,'small added table fits on the second page without a blank spill page',case['evidence']['pageCount']==2 and case['blankPages']==[])
    elif key=='6ada715d':
        p=paragraphs[6]
        assert not p['text']
        image=a.corpus/next(item['localPath'] for item in case['assets'] if item['localPath'].endswith('1.png'))
        from run_public_acceptance import revision
        case['anchorEvidence']='Pinned gold places the added image in paragraph 7 before Figure 1; VM cursor movement is not replayed.'
        section=before.sections[0]
        width=(section.page_width-section.left_margin-section.right_margin)/12700
        output=structure(a,case,source,read,[{'action':'insert_image','paragraph_id':p['id'],'expected_text':p['text'],'offset':0,'image_path':str(image),'image_revision':revision(image),'width_pt':width}])
        old,new=package(source),package(output)
        a.check(case,'exact supplied PNG embedded; all old media and body text retained',image.read_bytes() in new.values() and all(new[n]==v for n,v in old.items() if n.startswith('word/media/')) and content_signature(source)==content_signature(output))
        a.check(case,'image is anchored before Figure 1',len(Document(output).paragraphs[6]._p.xpath('.//w:drawing'))==1)
    elif key=='88fe4b2d':
        p=paragraphs[0]
        ends=[m.end() for m in re.finditer(r'[.!?](?=\s|$)',p['text'])]
        assert len(ends)==7
        output=structure(a,case,source,read,[{'action':'insert_breaks','paragraph_id':p['id'],'expected_text':p['text'],
            'breaks':[{'offset':end,'kind':'line'} for end in ends for _ in range(2)]}])
        after=Document(output).paragraphs[0].text
        a.check(case,'seven sentences each followed by an empty line; exact original text retained',after.count('\n\n')==7 and after.replace('\n','')==p['text'])
    elif key=='936321ce':
        selected=paragraphs[7:12]
        assert all(p['text'].count(',')==3 for p in selected)
        output=structure(a,case,source,read,[{'action':'text_to_table','paragraphs':[{'paragraph_id':p['id'],'expected_text':p['text']} for p in selected],'delimiter':','}])
        values=[[c.text for c in row.cells] for row in Document(output).tables[0].rows]
        expected=[p['text'].split(',') for p in selected]
        a.check(case,'comma-separated body text becomes a native 5x4 table with exact cell values',values==expected)
        a.check(case,'other existing tables retained',len(Document(output).tables)==len(before.tables)+1)
    elif key=='adf5e2c3':
        p=next(p for p in paragraphs if '<add here>' in p['text']);anchor=paragraphs[32]
        output=structure(a,case,source,read,[{'action':'bibliography_reference','paragraph_id':p['id'],'expected_text':p['text'],'marker':'<add here>',
            'after_paragraph_id':anchor['id'],'after_expected_text':anchor['text'],'bookmark':'Steinberg2003','number':14,'entry':ENTRY}])
        doc=Document(output)
        a.check(case,'exact bibliography entry added once, with native numbering and REF number field',sum(p.text==ENTRY for p in doc.paragraphs)==1 and ' REF Steinberg2003 \\r \\h ' in [n.text for n in doc.element.iter(qn('w:instrText'))]
            and doc.paragraphs[33]._p.pPr.numPr is not None)
        a.check(case,'only marker replaced in fourth essay paragraph',doc.paragraphs[10].text==before.paragraphs[10].text.replace('<add here>','14'))
        old_run=next(r for r in before.paragraphs[32].runs if r.text.strip())
        new_run=doc.paragraphs[33].runs[0]
        a.check(case,'new bibliography entry inherits preceding entry character formatting',new_run._r.rPr.xml==old_run._r.rPr.xml)
        a.check(case,'render resolves cross-reference and bibliography without an error',all('Error!' not in (p.extract_text() or '') and 'Reference source not found' not in (p.extract_text() or '') for p in PdfReader(case['evidence']['pdfPath']).pages))
    elif key=='ecc2413d':
        # Keep the full cover paragraph unchanged; place a separate empty page
        # before the original p6 page break. End-of-paragraph breaks alone can
        # collapse or move a long anchor paragraph in LibreOffice.
        p=paragraphs[4]
        case['anchorEvidence']='Insert a separate native empty-page paragraph after the full cover paragraph p5, before the original p6 page break. Preserve cover text and its paragraph properties; no implicit live cursor.'
        output=structure(a,case,source,read,[{'action':'insert_blank_page','paragraph_id':p['id'],'expected_text':p['text']}])
        a.check(case,'upstream explicit page-break count is 5',a.score(case,'contains_page_break',str(output),{'page_break_count':5})==1)
        a.check(case,'second page intentionally blank',2 in case['blankPages'],blankPages=case['blankPages'])
        # An inserted empty paragraph intentionally increases the paragraph
        # signature length. Remove exactly that new node before comparing the
        # complete original XML, rather than rejecting the intended insertion.
        from run_public_acceptance import unchanged_parts
        old_root,new_root=document_xml(source),document_xml(output)
        added=new_root.find(qn('w:body'))[5]
        empty=added.tag==qn('w:p') and not list(added.iter(qn('w:t')))
        new_root.find(qn('w:body')).remove(added)
        a.check(case,'only one empty-page paragraph added; every original XML node and other package part retained',empty and
            etree.tostring(old_root,method='c14n')==etree.tostring(new_root,method='c14n') and unchanged_parts(source,output))
    else:raise AssertionError(key)
    return output
