import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('extract_request_evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class RequestEvidenceTests(unittest.TestCase):
    def test_replayed_turns_background_and_assistant_rules_are_not_user_requirements(self):
        messages = [{'role': 'system', 'content': 'Desktop Chat runs in a workspace.'},
                    {'role': 'user', 'content': '合并 Word 文档'},
                    {'role': 'assistant', 'content': '必须使用两张表格，并限制每段字数。'},
                    {'role': 'user', 'content': '不用做表格，只需要把事情表述清楚就行'}]
        rows = [{'kind': 'request', 'id': str(index), 'userId': 7, 'question': '合并 Word 文档',
                 'requestBody': json.dumps({'messages': messages})} for index in range(2)]
        rows.append({'kind': 'request', 'id': 'memory', 'question': 'Word memory extraction',
                     'requestBody': json.dumps({'messages': [{'role': 'user', 'content': 'Word 字数配额 500'}]})})
        rows.append({'kind': 'request', 'id': 'review', 'question': '[Inter-agent message from /root] Word',
                     'requestBody': json.dumps({'messages': messages})})
        rows.append({'kind': 'request', 'id': 'checkpoint', 'question': 'Word 排版',
                     'requestBody': json.dumps({'messages': [
                         {'role': 'system', 'content': 'Desktop Chat runs in a workspace.'},
                         {'role': 'user', 'content': 'Runtime delivery checkpoint reached. Word document created.'}]})})
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'records.jsonl'
            source.write_text('\n'.join(json.dumps(row) for row in rows), encoding='utf-8')
            result = evidence.extract(source)
        self.assertEqual(result['counts']['distinctInstructionsWithinAccount'], 2)
        self.assertEqual(result['counts']['duplicateMessageOccurrences'], 2)
        self.assertEqual(result['counts']['excludedBackgroundRecords'], 1)
        self.assertEqual(result['counts']['excludedInternalCurrentRequests'], 1)
        self.assertEqual([item['instruction'] for item in result['observations']],
                         ['合并 Word 文档', '不用做表格，只需要把事情表述清楚就行'])


if __name__ == '__main__':
    unittest.main()
