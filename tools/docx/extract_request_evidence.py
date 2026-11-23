"""Index authentic user instructions in a local, read-only backend JSONL snapshot.

Run only on a private archive; output includes original user wording and must
remain outside Git. Public acceptance fixtures are manually anonymised and cite
the source refs emitted here. Repeated inference calls are not separate users.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

WORD = re.compile(r'\.docx?\b|\bword\b|排版|公文|字体|行距|两页|2页|格式|不用做表格|统筹成\s*[7七]\s*人', re.I)
INTERNAL = (
    '[Inter-agent message', 'This session is being continued',
    'This message is a direct compaction task', 'You are ', 'Existing intent:',
    'User request:', 'Candidate USER observations,', 'Review attempt ',
    'Runtime delivery checkpoint reached.',
)


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def plain(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(part.get('text', '') for part in value if isinstance(part, dict)
                         and part.get('type') in ('text', 'input_text'))
    return ''


def records(path):
    with path.open(encoding='utf-8-sig') as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


def extract(path: Path):
    counts = Counter()
    observations = {}
    scope = None
    for row in records(path):
        if row.get('kind') == 'scope':
            scope = row
            continue
        counts['selectedInferenceRecords'] += 1
        body = row.get('requestBody')
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                body = None
        if not isinstance(body, dict):
            counts['bodyUnavailable'] += 1
            continue
        messages = body.get('messages', body.get('input', []))
        if not isinstance(messages, list):
            counts['unknownEnvelope'] += 1
            continue
        system = '\n'.join(plain(m.get('content')) for m in messages if isinstance(m, dict) and m.get('role') == 'system')
        if not body.get('tools') and 'Desktop Chat runs' not in system:
            counts['excludedBackgroundRecords'] += 1
            continue
        if row.get('question', '').lstrip().startswith(INTERNAL):
            counts['excludedInternalCurrentRequests'] += 1
            continue
        counts['desktopConversationRecords'] += 1
        contextual_word = bool(WORD.search(row.get('question', '')))
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or message.get('role') != 'user':
                continue
            text = plain(message.get('content')).strip()
            if not text or text.startswith(INTERNAL):
                continue
            # Attachment content is evidence, not the user's instruction.
            instruction = re.split(r'\n\s*\[Attached file:|\nAttachments:', text)[0].strip()
            if not instruction or len(instruction) > 12_000:
                continue
            if not WORD.search(instruction) and not (contextual_word and len(instruction) < 1600):
                continue
            key = digest(str(row.get('userId', 'unknown')) + '\n' + instruction)
            ref = digest(str(row['id']) + ':' + str(index))[:20]
            source = {'ref': ref, 'requestId': row['id'], 'messageIndex': index,
                      'observedInRequestAt': row.get('startedAt'), 'role': 'user'}
            if key not in observations:
                observations[key] = {'instruction': instruction, 'instructionSha256': digest(instruction), 'sources': []}
            observations[key]['sources'].append(source)
            counts['userMessageOccurrences'] += 1
    counts['distinctInstructionsWithinAccount'] = len(observations)
    counts['duplicateMessageOccurrences'] = counts['userMessageOccurrences'] - len(observations)
    return {'scope': scope, 'snapshotSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'counts': dict(counts), 'observations': list(observations.values()),
            'limitations': ['Keyword-selected snapshot is bounded at 800 inference records, not a population survey.',
                            'Historical user messages repeat across calls; counts are deduplicated within account.',
                            'Request timestamps date the containing inference, not necessarily the original user turn.',
                            'Assistant, Reviewer, memory and attachment text are not user acceptance requirements.',
                            'Original attached DOCX files are not part of this snapshot.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--private-output', type=Path, required=True)
    args = parser.parse_args()
    if '.somniq' not in args.private_output.parts:
        parser.error('Keep original request evidence in a private .somniq directory')
    result = extract(args.snapshot)
    args.private_output.parent.mkdir(parents=True, exist_ok=True)
    args.private_output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'counts': result['counts'], 'snapshotSha256': result['snapshotSha256']}, indent=2))
