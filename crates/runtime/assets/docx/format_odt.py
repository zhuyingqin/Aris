"""Remove ODF text highlighting using odfpy's text-property vocabulary.

Publish only the relevant attributes in content/styles, leaving other ZIP parts
byte exact. Do not convert the user's ODT to another format.
"""
from zipfile import ZipFile
from odf.opendocument import load
from odf.style import TextProperties
from odf.namespaces import FONS, STYLENS
from lxml import etree


def remove_highlight(source, output):
    document = load(str(source))
    properties = document.getElementsByType(TextProperties)
    highlighted = [p for p in properties if p.getAttrNS(FONS, 'background-color') not in (None, 'transparent')]
    changes, count = {}, 0
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    with ZipFile(source) as archive:
        for name in ('content.xml', 'styles.xml'):
            if name not in archive.namelist():
                continue
            root = etree.fromstring(archive.read(name), parser)
            previous_count = count
            for node in root.iter('{' + STYLENS + '}text-properties'):
                key = '{' + FONS + '}background-color'
                if key in node.attrib and node.get(key) != 'transparent':
                    # Explicit transparent also defeats inherited highlighting.
                    node.set(key, 'transparent')
                    count += 1
            if count != previous_count:
                changes[name] = etree.tostring(root, xml_declaration=True, encoding='UTF-8')
        if count < len(highlighted):
            raise ValueError('unhandled_highlight: nested or unsupported ODF style')
        with ZipFile(output, 'w') as target:
            target.comment = archive.comment
            for item in archive.infolist():
                target.writestr(item, changes.get(item.filename, archive.read(item)))
    load(str(output))  # The mature ODF reader must also accept the candidate.
    return count
