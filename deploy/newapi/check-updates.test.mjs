import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, selectRelease } from './check-updates.mjs';

test('rc tags are excluded from stable even when GitHub marks them non-prerelease', () => {
  assert.equal(selectRelease([{ tag_name: 'v1.0.0-rc.40', prerelease: false }], 'v0.13.2', 'stable'), null);
});
test('rc channel advances numerically without downgrading to an older stable version', () => {
  assert.equal(selectRelease([{tag_name:'v0.13.5'},{tag_name:'v1.0.0-rc.9'},{tag_name:'v1.0.0-rc.40',prerelease:false}], 'v1.0.0-rc.39', 'rc').tag_name, 'v1.0.0-rc.40');
  assert.equal(compare('v1.0.0', 'v1.0.0-rc.99'), 1);
});
test('rejects draft, unsupported tag syntax and invalid policies', () => {
  assert.equal(selectRelease([{tag_name:'v1.1.0',draft:true},{tag_name:'main; echo bad'}], 'v1.0.0', 'stable'), null);
  assert.throws(() => selectRelease([], 'latest', 'stable'));
  assert.throws(() => selectRelease([], 'v1.0.0', 'anything'));
});
