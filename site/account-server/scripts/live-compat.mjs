// Run the real upstream release in a disposable database. Only the identity
// provider and paid model channel are fixtures; no production credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { developmentRealm } from './development-realm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tag = process.env.NEWAPI_TEST_TAG || 'v1.0.0-rc.39';
assert.match(tag, /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
const scratch = await mkdtemp(join(root, '.tmp-account-compat-'));
const cache = join(root, '.codex', 'newapi-binaries');
await mkdir(cache, { recursive: true });
const windows = process.platform === 'win32';
assert.ok(windows || process.platform === 'linux', 'live runner supports Windows and Linux');
assert.equal(process.arch, 'x64', 'release filename below is for x64');
const asset = `new-api-${tag}${windows ? '.exe' : ''}`;
const binary = join(cache, asset);
const releaseUrl = `https://github.com/QuantumNous/new-api/releases/download/${tag}`;
const checksumsResponse = await fetch(`${releaseUrl}/checksums-${windows ? 'windows' : 'linux'}.txt`);
assert.ok(checksumsResponse.ok, 'upstream release checksums available');
const checksums = await checksumsResponse.text();
const expectedHash = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === asset)?.[0];
assert.match(expectedHash || '', /^[a-f0-9]{64}$/i, 'upstream checksum must identify the exact asset');
let bytes = await readFile(binary).catch(() => null);
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
  console.log(`Downloading verified upstream binary ${tag}`);
  const response = await fetch(`${releaseUrl}/${asset}`);
  assert.ok(response.ok, 'upstream binary available');
  bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, 'release checksum matches');
  await writeFile(binary, bytes);
  if (!windows) await chmod(binary, 0o700);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'compat-key', use: 'sig', alg: 'RS256' };
const authorizationCodes = new Map();
const accessTokens = new Map();
const modelCalls = [];
const children = [];
let identityOrigin;
const secret = () => randomBytes(32).toString('base64url');
const clientSecrets = { 'somniq-web': secret(), newapi: secret() };
function jwt(claims) {
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'compat-key' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
const provider = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, identityOrigin);
    if (url.pathname === '/.well-known/openid-configuration') return json(res, { issuer: `${identityOrigin}/`, authorization_endpoint: `${identityOrigin}/authorize`, token_endpoint: `${identityOrigin}/token`, userinfo_endpoint: `${identityOrigin}/userinfo`, jwks_uri: `${identityOrigin}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] });
    if (url.pathname === '/jwks') return json(res, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = secret();
      const entry = Object.fromEntries(url.searchParams);
      assert.ok(clientSecrets[entry.client_id], 'known OIDC client');
      authorizationCodes.set(code, entry);
      const target = new URL(entry.redirect_uri);
      target.searchParams.set('code', code); target.searchParams.set('state', entry.state);
      res.writeHead(302, { location: target.href }); return res.end();
    }
    if (url.pathname === '/token') {
      const values = new URLSearchParams(await body(req));
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':') : [];
      const client = basic[0] || values.get('client_id');
      assert.equal(basic[1] || values.get('client_secret'), clientSecrets[client], 'OIDC client authentication');
      const entry = authorizationCodes.get(values.get('code')); authorizationCodes.delete(values.get('code'));
      assert.ok(entry, 'authorization code must be unused'); assert.equal(entry.client_id, client); assert.equal(values.get('redirect_uri'), entry.redirect_uri);
      if (entry.code_challenge) assert.equal(createHash('sha256').update(values.get('code_verifier')).digest('base64url'), entry.code_challenge, 'PKCE challenge');
      const access = secret();
      const claims = { iss: `${identityOrigin}/`, aud: client, sub: 'compat-alice', email: 'compat-alice@example.invalid', email_verified: true, preferred_username: 'compat_alice', name: 'Compat Alice', exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...(entry.nonce ? { nonce: entry.nonce } : {}) };
      accessTokens.set(access, claims);
      return json(res, { access_token: access, token_type: 'Bearer', expires_in: 600, id_token: jwt(claims) });
    }
    if (url.pathname === '/userinfo') {
      const claims = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      return json(res, claims || { error: 'invalid_token' }, claims ? 200 : 401);
    }
    if (url.pathname === '/model/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer fixture-model-key');
      const request = JSON.parse(await body(req)); modelCalls.push(request);
      const choice = { index: 0, message: { role: 'assistant', content: 'SomniQ compatibility verified.' }, finish_reason: 'stop' };
      const base = { id: 'chatcmpl-compat', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model, usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: choice.message.content }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      return json(res, { ...base, choices: [choice] });
    }
    json(res, { error: 'not_found' }, 404);
  } catch (error) { json(res, { error: 'fixture_assertion_failed' }, 500); console.error(error.message); }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
identityOrigin = `http://127.0.0.1:${provider.address().port}`;
async function freePort() { const s = createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; }
const newapiOrigin = `http://127.0.0.1:${await freePort()}`;
const accountOrigin = `http://127.0.0.1:${await freePort()}`;
const keycloakHome = process.env.SOMNIQ_KEYCLOAK_HOME;
const accountBackend = keycloakHome ? `http://127.0.0.1:${await freePort()}` : accountOrigin;
async function launch(file, args, env, name) {
  const child = spawn(file, args, { cwd: scratch, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => console.error(`${name}: ${error.message}`));
  child.done = once(child, 'exit').then(() => writeFile(join(scratch, `${name}.log`), output));
  return child;
}
async function waitFor(url, child, attempts = 120) {
  for (let n = 0; n < attempts; n++) {
    if (child.exitCode !== null) throw new Error(`Service exited during startup; inspect local logs in ${scratch}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Service startup timed out; inspect ${scratch}`);
}
async function request(base, path, data, token) {
  const response = await fetch(new URL(path, base), { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const value = await response.json(); assert.ok(response.ok && value.success, `Upstream ${path}: ${value.message || response.status}`); return value.data;
}
try {
  let issuer = `${identityOrigin}/`;
  let authorizationEndpoint = `${identityOrigin}/authorize`;
  let tokenEndpoint = `${identityOrigin}/token`;
  let userinfoEndpoint = `${identityOrigin}/userinfo`;
  const testPassword = `Aa1!${secret()}`;
  if (keycloakHome) {
    console.log('Starting isolated Keycloak and Site browser validation');
    const home = join(scratch, 'keycloak');
    await cp(resolve(keycloakHome), home, { recursive: true });
    await mkdir(join(home, 'data/import'), { recursive: true });
    await writeFile(join(home, 'data/import/somniq-realm.json'), JSON.stringify(developmentRealm({ testSubject: '11111111-2222-4333-8444-555555555555', oidcSecret: clientSecrets['somniq-web'], newapiSecret: clientSecrets.newapi, testPassword }, [accountOrigin])));
    const keycloakOrigin = `http://127.0.0.1:${await freePort()}`;
    issuer = `${keycloakOrigin}/realms/somniq`;
    authorizationEndpoint = `${issuer}/protocol/openid-connect/auth`;
    tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
    userinfoEndpoint = `${issuer}/protocol/openid-connect/userinfo`;
    const javaArgs = ['-Xms128m', '-Xmx768m', '--add-opens=java.base/java.util=ALL-UNNAMED', '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED', '--add-opens=java.base/java.security=ALL-UNNAMED', '--add-opens=java.base/java.lang=ALL-UNNAMED', '-Djava.util.concurrent.ForkJoinPool.common.threadFactory=io.quarkus.bootstrap.forkjoin.QuarkusForkJoinWorkerThreadFactory', `-Dkc.home.dir=${home}`, `-Djboss.server.config.dir=${join(home,'conf')}`, '-cp', join(home,'lib/quarkus-run.jar'), 'io.quarkus.bootstrap.runner.QuarkusEntryPoint', 'start-dev', '--import-realm', '--http-host=127.0.0.1', `--http-port=${new URL(keycloakOrigin).port}`, '--http-management-host=127.0.0.1', `--http-management-port=${await freePort()}`, `--hostname=${keycloakOrigin}`];
    const env = { KC_BOOTSTRAP_ADMIN_USERNAME: 'localadmin', KC_BOOTSTRAP_ADMIN_PASSWORD: secret() };
    let keycloak = await launch(process.env.SOMNIQ_JAVA || 'java', javaArgs, env, 'keycloak-build');
    try { await waitFor(`${issuer}/.well-known/openid-configuration`, keycloak, 480); }
    catch (error) {
      if (keycloak.exitCode !== 10) throw error;
      keycloak = await launch(process.env.SOMNIQ_JAVA || 'java', ['-Dkc.config.built=true', ...javaArgs], env, 'keycloak');
      await waitFor(`${issuer}/.well-known/openid-configuration`, keycloak, 480);
    }
    console.log('Keycloak ready');
  }
  const newapi = await launch(binary, ['--port', new URL(newapiOrigin).port, '--log-dir', join(scratch, 'logs')], { SQL_DSN: '', LOG_SQL_DSN: '', SQLITE_PATH: join(scratch, 'new-api.db'), REDIS_CONN_STRING: '', SESSION_SECRET: secret(), CRYPTO_SECRET: secret(), SESSION_COOKIE_SECURE: 'false', BATCH_UPDATE_ENABLED: 'false', GIN_MODE: 'release' }, 'newapi');
  await waitFor(`${newapiOrigin}/api/setup`, newapi);
  const password = `Aa1!${secret()}`;
  await request(newapiOrigin, '/api/setup', { username: 'compatroot', password, confirmPassword: password, SelfUseModeEnabled: false, DemoSiteEnabled: false });
  const rootSession = await request(newapiOrigin, '/api/user/login', { username: 'compatroot', password });
  assert.ok(rootSession.access_token, 'modern upstream login contract');
  const options = { ServerAddress: accountOrigin, RegisterEnabled: 'true', PasswordRegisterEnabled: 'false', QuotaForNewUser: '1000000', 'oidc.client_id': 'newapi', 'oidc.client_secret': clientSecrets.newapi, 'oidc.authorization_endpoint': authorizationEndpoint, 'oidc.token_endpoint': tokenEndpoint, 'oidc.user_info_endpoint': userinfoEndpoint, 'oidc.enabled': 'true' };
  for (const [key, value] of Object.entries(options)) {
    const response = await fetch(`${newapiOrigin}/api/option/`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${rootSession.access_token}` }, body: JSON.stringify({ key, value }) });
    const data = await response.json(); assert.ok(data.success, `Configure ${key}: ${data.message}`);
  }
  await request(newapiOrigin, '/api/channel/', { mode: 'single', channel: { type: 1, key: 'fixture-model-key', name: 'compat-model', base_url: `${identityOrigin}/model`, models: 'gpt-4o-mini,gpt-4o,gpt-4', group: 'default', status: 1 } }, rootSession.access_token);
  const agreementFile = join(scratch, 'agreement.txt'); await writeFile(agreementFile, 'SomniQ local integration test agreement.');
  const accountBinary = process.env.SOMNIQ_ACCOUNT_BINARY || join(root, 'site/account-server/target/debug', `somniq-account-server${windows ? '.exe' : ''}`);
  const account = await launch(accountBinary, [], { SOMNIQ_ACCOUNT_ADMIN_SUBJECTS: keycloakHome ? '11111111-2222-4333-8444-555555555555' : 'compat-alice', SOMNIQ_ACCOUNT_BIND: `127.0.0.1:${new URL(accountBackend).port}`, SOMNIQ_ACCOUNT_PUBLIC_URL: accountOrigin, SOMNIQ_ACCOUNT_HOME_PATH: keycloakHome ? '/account.html' : '/account/', SOMNIQ_OIDC_ISSUER: issuer, SOMNIQ_OIDC_CLIENT_ID: 'somniq-web', SOMNIQ_OIDC_CLIENT_SECRET: clientSecrets['somniq-web'], SOMNIQ_NEWAPI_URL: newapiOrigin, SOMNIQ_NEWAPI_OIDC_CLIENT_ID: 'newapi', SOMNIQ_NEWAPI_INSTANCE_ID: 'compat', SOMNIQ_ACCOUNT_DATABASE: join(scratch, 'accounts.sqlite3'), SOMNIQ_ACCOUNT_KEY: secret(), SOMNIQ_AGREEMENT_VERSION: 'compat-v1', SOMNIQ_AGREEMENT_FILE: agreementFile, RUST_LOG: 'warn' }, 'account');
  await waitFor(`${accountBackend}/healthz`, account);
  if (keycloakHome) {
    const site = await launch(process.execPath, [join(root,'site/node_modules/vite/bin/vite.js'), join(root,'site'), '--host', '127.0.0.1', '--port', new URL(accountOrigin).port, '--strictPort'], { VITE_ACCOUNT_MODE: 'independent', SOMNIQ_DEV_ACCOUNT_UPSTREAM: accountBackend }, 'site');
    await waitFor(`${accountOrigin}/account.html`, site);
    const { browserSmoke } = await import('./browser-smoke.mjs');
    const checks = await browserSmoke({ origin: accountOrigin, password: testPassword, scratch, stopCompute: async () => { newapi.kill(); await once(newapi, 'exit'); } });
    await writeFile(join(scratch, 'validation.json'), JSON.stringify({ tag, binarySha256: expectedHash, passed: true, identityProvider: 'Keycloak 26.7.4, native isolated development database', modelChannel: 'local fixture (no paid calls)', checks, testedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(JSON.stringify({ tag, passed: true, checks, report: join(scratch, 'validation.json') }, null, 2));
  } else {
  const cookies = new Map();
  async function browser(url, options = {}) {
    url = new URL(url, accountOrigin);
    const response = await fetch(url, { redirect: 'manual', ...options, headers: { ...(url.origin === accountOrigin ? { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') } : {}), ...options.headers } });
    if (url.origin === accountOrigin) for (const cookie of response.headers.getSetCookie()) { const [name, ...value] = cookie.split(';')[0].split('='); cookies.set(name, value.join('=')); }
    return response;
  }
  async function redirects(url) { for (let n = 0; n < 8; n++) { const response = await browser(url); if (![302,303].includes(response.status)) return response; url = new URL(response.headers.get('location'), url).href; } throw new Error('Too many authentication redirects'); }
  async function action(path, data) { return browser(path, { method: 'POST', headers: { origin: accountOrigin, 'content-type': 'application/json' }, body: JSON.stringify(data) }); }
  assert.equal((await redirects(`${accountOrigin}/v2/account/login`)).status, 200, 'SomniQ login works');
  const me = await (await browser('/v2/account/me')).json(); assert.match(me.user.id, /^[a-f0-9-]{36}$/); assert.equal(me.agreement_required, true);
  const agreement = await (await browser('/v2/account/agreement')).json();
  assert.equal((await action('/v2/account/consent', { version: agreement.version, content_hash: agreement.content_hash, accepted: true })).status, 204);
  const connectResponse = await action('/v2/account/compute/connect', {}); assert.equal(connectResponse.status, 200);
  const connect = await connectResponse.json();
  const finish = await redirects(connect.authorization_url); assert.equal(finish.status, 200, `New API OIDC connection (${await finish.text()})`);
  const connected = await (await browser('/v2/account/me')).json(); assert.equal(connected.compute_connected, true);
  const { configureMembership, exerciseMembership } = await import('./membership-compat.mjs');
  const memberCall = async (path, method = 'GET', value) => {
    const response = await browser(path, { method, headers: { origin: accountOrigin, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  };
  await configureMembership(memberCall, me.user.id);
  await exerciseMembership(memberCall, me.user.id);
  const previousCalls = modelCalls.length;
  const models = await (await browser('/v1/models')).json(); assert.ok(models.data.some(model => model.id === 'gpt-4o-mini'), 'model entitlement');
  const chat = await action('/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }], stream: true });
  const stream = await chat.text();
  if (chat.status !== 200) await writeFile(join(scratch, 'model-failure.json'), stream);
  assert.equal(chat.status, 200); assert.ok(stream.includes('[DONE]')); assert.ok(stream.includes('SomniQ compatibility verified.')); assert.equal(modelCalls.length, previousCalls + 1);
  const quota = await (await browser('/v2/account/compute')).json(); assert.equal(quota.unit, 'newapi_quota');
  assert.equal((await action('/v2/account/logout', {})).status, 204);
  assert.equal((await browser('/v2/account/me')).status, 401);
  assert.equal((await redirects(`${accountOrigin}/v2/account/login`)).status, 200);
  const again = await (await browser('/v2/account/me')).json(); assert.equal(again.user.id, me.user.id); assert.equal(again.agreement_required, false);
  const reconnect = await (await action('/v2/account/compute/connect', {})).json(); assert.equal((await redirects(reconnect.authorization_url)).status, 200);
  newapi.kill(); await once(newapi, 'exit');
  assert.equal((await browser('/v2/account/me')).status, 200, 'own account survives upstream outage');
  const report = { tag, binarySha256: expectedHash, passed: true, identityProvider: 'local RSA/OIDC fixture (not Keycloak)', modelChannel: 'local fixture (no paid calls)', checks: ['OIDC + PKCE login', 'independent UUID', 'consent snapshot', 'real New API OIDC account creation', 'real per-user model key', 'streamed model response', 'Go/Plus/Pro membership matrix', 'real upstream allowlist synchronization', 'downgrade and revocation', 'quota projection', 'logout', 'stable identity after re-login', 'repeat connection', 'New API outage isolation'], testedAt: new Date().toISOString() };
  await writeFile(join(scratch, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ tag, passed: true, checks: report.checks, report: join(scratch, 'validation.json') }, null, 2));
  }
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.allSettled(children.map(child => child.done));
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
