import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function version(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : null;
}
export function compare(a, b) {
  const left = version(a), right = version(b);
  if (!left || !right) throw new Error('Unsupported release tag');
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function selectRelease(releases, current, channel) {
  if (!['stable', 'rc'].includes(channel) || !version(current)) throw new Error('Invalid update policy');
  return releases.filter(r => !r.draft && version(r.tag_name) && compare(r.tag_name, current) > 0
    && (channel === 'rc' || (!r.prerelease && !r.tag_name.includes('-'))))
    .sort((a,b) => compare(b.tag_name,a.tag_name))[0] || null;
}

async function get(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Upstream metadata request failed: HTTP ${response.status}`);
  return response;
}
async function main() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const current = JSON.parse(await readFile(join(directory, 'version.lock.json'), 'utf8'));
  const ghHeaders = { 'User-Agent': 'somniq-newapi-compat', Accept: 'application/vnd.github+json' };
  // Tokens, if supplied, are sent only to the fixed GitHub API origin.
  if (process.env.GH_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const releases = await (await get('https://api.github.com/repos/QuantumNous/new-api/releases?per_page=100', ghHeaders)).json();
  const release = selectRelease(releases, current.tag, current.channel);
  if (!release) { console.log('No eligible upstream release.'); if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'candidate=false\n'); return; }
  let ref = await (await get(`https://api.github.com/repos/QuantumNous/new-api/git/ref/tags/${release.tag_name}`, ghHeaders)).json();
  let object = ref.object;
  for (let i = 0; object.type === 'tag' && i < 5; i++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid upstream tag object');
    object = (await (await get(`https://api.github.com/repos/QuantumNous/new-api/git/tags/${object.sha}`, ghHeaders)).json()).object;
  }
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Release does not resolve to a commit');
  const token = await (await get('https://auth.docker.io/token?service=registry.docker.io&scope=repository:calciumion/new-api:pull')).json();
  const manifestResponse = await get(`https://registry-1.docker.io/v2/calciumion/new-api/manifests/${release.tag_name}`, { Authorization: `Bearer ${token.token}`, Accept: 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json' });
  const digest = manifestResponse.headers.get('docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Immutable image digest missing');
  const candidate = { repository: current.repository, tag: release.tag_name, commit: object.sha, image: current.image, digest, channel: current.channel, automaticProductionDeployment: false, adapterContract: current.adapterContract, previousTag: current.tag, releaseUrl: `https://github.com/QuantumNous/new-api/releases/tag/${release.tag_name}`, requiresProductionMigrationReview: true };
  if (process.argv.includes('--write')) await writeFile(join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  console.log(JSON.stringify(candidate, null, 2));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `candidate=true\ntag=${release.tag_name}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
