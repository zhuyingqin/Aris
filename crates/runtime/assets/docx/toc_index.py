"""Read updated index entries using an owned headless LibreOffice UNO instance.

The private pipe/profile never attaches to desktop Word/WPS or another LO. The
host's managed process group owns this helper and its descendants on cancellation.
Only index text is returned: the original DOCX is never round-tripped to publish.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    node = PropertyValue()
    node.Name, node.Value = name, value
    return node


def main(soffice, source, output, marker, levels):
    pipe = 'somniq_toc_' + uuid.uuid4().hex
    profile = source.parent / 'profile'
    profile.mkdir()
    command = [str(soffice), '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo', '--nodefault', '--norestore',
               '--accept=pipe,name=' + pipe + ';urp;StarOffice.ComponentContext']
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    desktop, document = None, None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        deadline = time.monotonic() + 45
        while True:
            try:
                context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
                break
            except Exception:
                if time.monotonic() >= deadline or process.poll() is not None:
                    raise RuntimeError('owned LibreOffice index engine did not start')
                time.sleep(.2)
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        never = uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')
        document = desktop.loadComponentFromURL(source.as_uri(), '_blank', 0,
                                               (prop('Hidden', True), prop('ReadOnly', False), prop('MacroExecutionMode', never), prop('UpdateDocMode', 3)))
        if document is None:
            raise RuntimeError('index document could not be loaded')
        search = document.createSearchDescriptor()
        search.SearchString = marker
        anchor = document.findFirst(search)
        if anchor is None or document.findNext(anchor.getEnd(), search) is not None:
            raise RuntimeError('one exact index placeholder required')
        index = document.createInstance('com.sun.star.text.ContentIndex')
        index.Title = ''
        index.CreateFromOutline = True
        index.Level = levels
        styles = document.getStyleFamilies().getByName('ParagraphStyles')
        for level in range(1, levels + 1):
            name = 'SomniQ TOC ' + str(level)
            style = document.createInstance('com.sun.star.style.ParagraphStyle')
            styles.insertByName(name, style)
            style.ParentStyle = anchor.ParaStyleName
            for key in ('CharFontName', 'CharFontNameAsian', 'CharHeight', 'CharHeightAsian',
                        'ParaLineSpacing', 'ParaTopMargin', 'ParaBottomMargin'):
                style.setPropertyValue(key, anchor.getPropertyValue(key))
            style.ParaLeftMargin = round(14 * 2540 / 72 * (level - 1))
            index.setPropertyValue('ParaStyleLevel' + str(level), name)
        anchor.getText().insertTextContent(anchor, index, True)
        document.refresh()
        index.update()
        entries = []
        enumeration = index.getAnchor().createEnumeration()
        while enumeration.hasMoreElements():
            paragraph = enumeration.nextElement()
            value = paragraph.getString()
            if not value.strip():
                continue
            style = paragraph.getPropertyValue('ParaStyleName')
            number = style.rsplit(' ', 1)[-1]
            entries.append({'text': value, 'level': int(number) if number.isdecimal() else 1})
        output.write_text(json.dumps({'entries': entries}, ensure_ascii=False), encoding='utf-8')
    finally:
        if document is not None:
            document.close(True)
        if desktop is not None:
            desktop.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)


if __name__ == '__main__':
    main(*(Path(arg).resolve() for arg in sys.argv[1:4]), sys.argv[4], int(sys.argv[5]))
