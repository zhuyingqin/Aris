"""Snapshot public office requirements; retain exact URLs, time and hashes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import urllib.request

from lxml import html

MANIFEST = Path(__file__).with_name('office_cases.json')


def fetch(source, output):
    request = urllib.request.Request(source['url'], headers={'User-Agent': 'SomniQ-office-acceptance/1.0'})
    with urllib.request.urlopen(request, timeout=40) as response:
        data = response.read(4_000_001)
        if len(data) > 4_000_000:
            raise ValueError('source exceeds snapshot limit')
        final_url, status = response.url, response.status
    document = html.fromstring(data)
    title = ' '.join(document.xpath('//title/text()'))
    if status != 200 or 'Microsoft Support' not in title:
        raise ValueError(f'unexpected public source: {title}')
    for node in document.xpath('//script|//style|//nav|//footer|//header'):
        node.drop_tree()
    main = (document.xpath('//main') or [document])[0]
    text = '\n'.join(' '.join(value.split()) for value in main.xpath(
        './/h1//text()|.//h2//text()|.//h3//text()|.//p//text()|.//li//text()') if value.strip())
    if len(text) < 200:
        raise ValueError('public source has no readable content')
    raw_path, text_path = output / (source['id'] + '.html'), output / (source['id'] + '.txt')
    raw_path.write_bytes(data)
    text_path.write_text(text, encoding='utf-8')
    return {**source, 'finalUrl': final_url, 'status': status, 'title': title,
            'fetchedAt': datetime.now(timezone.utc).isoformat(),
            'htmlPath': str(raw_path.resolve()), 'sha256': hashlib.sha256(data).hexdigest(),
            'textPath': str(text_path.resolve()), 'textSha256': hashlib.sha256(text_path.read_bytes()).hexdigest()}


def main(output):
    if output.exists() and any(output.iterdir()):
        raise ValueError('use a fresh output directory; retain earlier snapshots')
    output.mkdir(parents=True, exist_ok=True)
    requirements = json.loads(MANIFEST.read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda source: fetch(source, output), requirements['sources']))
    (output / 'manifest.json').write_text(json.dumps({
        'requirementsRevision': 'sha256:' + hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
        'sources': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'sourcesFetched': len(results), 'manifest': str(output / 'manifest.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args().output.resolve())
