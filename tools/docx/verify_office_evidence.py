"""Check saved office-run integrity without rerunning tools or claiming review approval."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def revision(path):
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()


def verify(run, observations, runner):
    result = read(run / 'results.json')
    cases = result['results']
    requirements = read(ROOT / 'tools/docx/office_cases.json')
    assert result['runState'] == 'complete'
    assert len(cases) == len({c['id'] for c in cases}) == len(requirements['cases'])
    assert {c['id'] for c in cases} == {c['id'] for c in requirements['cases']}
    assert result['counts'] == dict(Counter(c['status'] for c in cases))
    assert result['runnerRevision'] == revision(runner)
    assert revision(Path(result['buildManifest'])) == result['buildManifestRevision']
    assert all(revision(ROOT / name) == expected
               for name, expected in result['implementationRevisions'].items())
    inputs = read(run / 'inputs.json')
    assert len(inputs) == len(cases)
    assert {i['case'] for i in inputs} == {c['id'] for c in cases}
    assert result['allOriginalInputsUnchanged']
    assert all(revision(Path(i['path'])) == i['revision'] for i in inputs)

    source_path = Path(result['sourceManifest'])
    assert revision(source_path) == result['sourceManifestRevision']
    sources = read(source_path)
    assert sources['requirementsRevision'] == revision(ROOT / 'tools/docx/office_cases.json')
    assert {s['id'] for s in sources['sources']} == {s['id'] for s in requirements['sources']}
    for source in sources['sources']:
        assert source['status'] == 200
        assert revision(Path(source['htmlPath'])) == 'sha256:' + source['sha256']
        assert revision(Path(source['textPath'])) == 'sha256:' + source['textSha256']

    observed = read(observations)
    assert observed['reviewerRole'] == 'executor'
    assert observed['independentReviewer'] == 'not_run'
    assert observed['resultsRevision'] == revision(run / 'results.json')
    observed_keys, expected_keys = [], []
    for page in observed['observations']:
        observed_keys.append((page['case'], page['kind'], page['page']))
        assert revision(Path(page['imagePath'])) == page['imageRevision']
        assert revision(Path(page['documentPath'])) == page['documentRevision']
        assert revision(Path(page['pdfPath'])) == page['pdfRevision']
        assert page['notes'].strip()
    candidates, diagnostics = 0, 0
    for case in cases:
        if case['status'] == 'automated_pass':
            assert case['checks'] and all(c['passed'] for c in case['checks'])
            assert case.get('outputPath') and case.get('pageImages')
        for kind, evidence_key, images_key in (
            ('candidate', 'evidence', 'pageImages'),
            ('diagnostic', 'diagnosticEvidence', 'diagnosticPageImages'),
        ):
            images = case.get(images_key, [])
            if not images:
                continue
            evidence = case[evidence_key]
            document = Path(case['outputPath'] if kind == 'candidate' else case['sourcePath'])
            assert revision(document) == evidence['documentRevision']
            assert revision(Path(evidence['pdfPath'])) == evidence['pdfRevision']
            assert evidence['state'] == 'rendered'
            assert evidence['visualReview'] == 'pending'
            assert evidence['targetEditorVerification'] == 'unverified'
            assert [p['page'] for p in images] == list(range(1, evidence['pageCount'] + 1))
            for page in images:
                assert revision(Path(page['path'])) == page['revision']
                expected_keys.append((case['id'], kind, page['page']))
            if kind == 'candidate':
                candidates += len(images)
            else:
                diagnostics += len(images)
    assert len(observed_keys) == len(set(observed_keys))
    assert set(observed_keys) == set(expected_keys)
    for page in observed['observations']:
        case = next(c for c in cases if c['id'] == page['case'])
        diagnostic = page['kind'] == 'diagnostic'
        evidence = case['diagnosticEvidence' if diagnostic else 'evidence']
        images = case['diagnosticPageImages' if diagnostic else 'pageImages']
        expected_page = next(p for p in images if p['page'] == page['page'])
        assert Path(page['imagePath']) == Path(expected_page['path'])
        assert page['imageRevision'] == expected_page['revision']
        assert Path(page['pdfPath']) == Path(evidence['pdfPath'])
        assert page['pdfRevision'] == evidence['pdfRevision']
        assert Path(page['documentPath']) == Path(case['sourcePath'] if diagnostic else case['outputPath'])
        assert page['documentRevision'] == evidence['documentRevision']
    assert candidates == result['renderedCandidatePages']
    assert diagnostics == result['diagnosticPages']

    schemas = read(run / 'schema-validation.json')
    assert {c['case'] for c in schemas} == {c['id'] for c in cases if c.get('outputPath')}
    for schema in schemas:
        case = next(c for c in cases if c['id'] == schema['case'])
        assert not schema['added']
        assert schema['candidateRevision'] == revision(Path(case['outputPath']))
        assert schema['baselineRevision'] == case['sourceRevision']
    calls = read(run / 'tool-calls.json')
    audits = [a for c in cases for a in c.get('auditChecks', [])]
    assert all(a['reversibleBinaryRecord'] and a['actualUndo'] in (
        'restored_exact_previous_bytes', 'removed_new_file') for a in audits)
    reverted = [c for c in calls if c['tool'] == 'change_revert']
    assert len(reverted) == len(audits)
    assert all(c['exitCode'] == 0 and c['result']['reverted'] for c in reverted)
    assert result['visualReview'] == 'pending'
    assert all(result[k] == 'not_run' for k in (
        'wordWpsVerification', 'independentVisualReviewer', 'taskConversationReplay'))
    return {
        'verifiedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'Saved evidence integrity; does not turn failed tasks or executor observations into independent approval.',
        'run': str(run), 'runnerRevision': revision(runner),
        'resultsRevision': revision(run / 'results.json'),
        'observationsRevision': revision(observations),
        'allIntegrityChecksPassed': True, 'cases': len(cases), 'rawCounts': result['counts'],
        'publicSources': len(sources['sources']), 'originalInputsUnchanged': len(inputs),
        'candidateDocuments': len(schemas), 'candidatePagesObserved': candidates,
        'diagnosticPagesObserved': diagnostics, 'schemaAdditionalErrors': sum(len(s['added']) for s in schemas),
        'actualUndoChecks': len(audits), 'toolCalls': len(calls),
        'toolCallsReturningErrors': sum(c['exitCode'] != 0 for c in calls),
        'independentReviewer': 'not_run', 'wordWpsVerification': 'not_run', 'taskConversationReplay': 'not_run',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--observations', type=Path, required=True)
    parser.add_argument('--runner', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.run.resolve(), args.observations.resolve(), args.runner.resolve()),
                     ensure_ascii=False, indent=2))
