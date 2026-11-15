"""Download pinned public OSWorld Writer tasks, inputs and gold files.

Only downloads data. Does not execute benchmark setup commands, GUI actions or
network services. Documents stay in the ignored local corpus directory.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

OSWORLD_COMMIT = '9466ba2c7e19ad6dea076ad9cf27a2eca6f11336'
DATASET_COMMIT = '1e112283c4ecb08d6fed8069bca7de74fa2f12aa'
TASK_DIRECTORY = 'evaluation_examples/examples/libreoffice_writer/'
EXTRA_SOURCES = ('README.md', 'LICENSE', 'desktop_env/evaluators/metrics/docs.py',
                 'desktop_env/evaluators/metrics/pdf.py')


def get(url, maximum=32 * 1024 * 1024):
    request = urllib.request.Request(url, headers={'User-Agent': 'SomniQ-public-docx-evaluation'})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('public source exceeds bounded download size')
    return data


def cloud_files(value):
    if isinstance(value, list):
        for item in value:
            yield from cloud_files(item)
    elif isinstance(value, dict):
        if value.get('type') == 'cloud_file':
            yield from value['path'] if isinstance(value['path'], list) else [value['path']]
        else:
            for item in value.values():
                yield from cloud_files(item)


def fetch(output):
    if output.exists() and any(output.iterdir()):
        raise ValueError('Use a fresh directory to preserve previous corpus evidence')
    output.mkdir(parents=True, exist_ok=True)
    tree = json.loads(get(f'https://api.github.com/repos/xlang-ai/OSWorld/git/trees/{OSWORLD_COMMIT}?recursive=1'))
    assert not tree.get('truncated'), 'cannot establish complete task coverage from truncated tree'
    paths = [x['path'] for x in tree['tree'] if x['type'] == 'blob'
             and ((x['path'].startswith(TASK_DIRECTORY) and x['path'].endswith('.json'))
                  or x['path'] in EXTRA_SOURCES)]

    def source(path):
        url = f'https://raw.githubusercontent.com/xlang-ai/OSWorld/{OSWORLD_COMMIT}/{path}'
        data = get(url, 8 * 1024 * 1024)
        destination = output / 'source' / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        return {'path': path, 'url': url, 'sha256': hashlib.sha256(data).hexdigest()}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        sources = list(pool.map(source, paths))
    (output / 'sources.json').write_text(json.dumps({'repository': 'xlang-ai/OSWorld',
        'commit': OSWORLD_COMMIT, 'files': sources}, indent=2), encoding='utf-8')
    (output / 'dataset.json').write_text(json.dumps({'repository': 'xlangai/ubuntu_osworld_file_cache',
        'commit': DATASET_COMMIT, 'license': 'apache-2.0'}, indent=2), encoding='utf-8')
    requests = []
    task_paths = sorted((output / 'source' / TASK_DIRECTORY).glob('*.json'))
    for path in task_paths:
        task = json.loads(path.read_text(encoding='utf-8'))
        inputs = [item['url'] for step in task.get('config', []) if step.get('type') == 'download'
                  for item in step['parameters']['files']]
        for url in sorted(set(inputs + list(cloud_files(task['evaluator'].get('expected'))))):
            requests.append((task['id'], url, 'input' if url in inputs else 'gold'))

    def asset(item):
        task_id, original_url, role = item
        url = original_url.replace('/resolve/main/', f'/resolve/{DATASET_COMMIT}/')
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'huggingface.co':
            raise ValueError('unexpected public corpus download host')
        name = Path(urllib.parse.unquote(parsed.path)).name
        data = get(url)
        destination = output / 'assets' / task_id / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        print('Downloaded ' + task_id + '/' + name, flush=True)
        return {'taskId': task_id, 'role': role, 'originalUrl': original_url, 'url': url,
                'localPath': str(destination.relative_to(output)), 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'download': 'ok'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        assets = list(pool.map(asset, requests))
    (output / 'asset-manifest.json').write_text(json.dumps(assets, indent=2), encoding='utf-8')
    print(json.dumps({'tasks': len(task_paths), 'downloadedAssets': len(assets)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    fetch(parser.parse_args().output.resolve())
