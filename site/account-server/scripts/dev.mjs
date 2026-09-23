// Creates a loopback-only development stack. Secrets stay in ignored .local.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentRealm } from './development-realm.mjs';
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(directory, '.local');
await mkdir(local, { recursive: true });
const file = join(local, 'development.json');
let config = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
const random = () => randomBytes(32).toString('base64url');
if (!config) {
  config = { testSubject: randomUUID(), accountKey: random(), oidcSecret: random(), newapiSecret: random(), keycloakAdminPassword: `Aa1!${random()}`, newapiAdminPassword: `Aa1!${random()}`, testPassword: `Aa1!${random()}`, sessionSecret: random() };
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const realm = developmentRealm(config);
const publicOrigin = process.env.SOMNIQ_ACCOUNT_PUBLIC_URL || 'http://127.0.0.1:8800';
if (!['http://127.0.0.1:8800', 'http://127.0.0.1:5180'].includes(publicOrigin)) throw new Error('Development service is loopback-only on port 8800 or 5180');
await writeFile(join(local, 'somniq-realm.json'), JSON.stringify(realm, null, 2) + '\n', { mode: 0o600 });
const lock = JSON.parse(await readFile(join(directory, '../../deploy/newapi/version.lock.json'), 'utf8'));
const composeEnv = { ...process.env, KEYCLOAK_ADMIN_PASSWORD: config.keycloakAdminPassword, NEWAPI_SESSION_SECRET: config.sessionSecret, NEWAPI_IMAGE: `${lock.image}@${lock.digest}` };
const composeFile = join(directory, 'compose.dev.yml');
const mode = process.argv[2] || 'init';
if (mode === 'init') {
  console.log(`Development configuration created in ${local}. The local test login is alice; its password is in development.json.`);
} else if (mode === 'up' || mode === 'down' || mode === 'check') {
  const result = spawnSync('docker', ['compose','-f',composeFile, ...(mode === 'up' ? ['up','-d'] : mode === 'check' ? ['config','--quiet'] : ['down'])], { env:composeEnv, stdio:'inherit', windowsHide:true });
  process.exitCode = result.status ?? 1;
} else if (mode === 'configure-newapi') {
  const origin = 'http://127.0.0.1:18881';
  async function api(path, data, token, method='POST') {
    const response=await fetch(`${origin}${path}`, { method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data) });
    const value=await response.json(); if(!response.ok||!value.success) throw new Error(`Local New API configuration failed: ${path}`); return value.data;
  }
  const setup=await (await fetch(`${origin}/api/setup`)).json();
  if(!setup.data.status) await api('/api/setup',{username:'localadmin',password:config.newapiAdminPassword,confirmPassword:config.newapiAdminPassword,SelfUseModeEnabled:false});
  const login=await api('/api/user/login',{username:'localadmin',password:config.newapiAdminPassword});
  const options={ServerAddress:publicOrigin,RegisterEnabled:'true',PasswordRegisterEnabled:'false','oidc.client_id':'newapi','oidc.client_secret':config.newapiSecret,'oidc.authorization_endpoint':'http://127.0.0.1:18882/realms/somniq/protocol/openid-connect/auth','oidc.token_endpoint':'http://keycloak:8080/realms/somniq/protocol/openid-connect/token','oidc.user_info_endpoint':'http://keycloak:8080/realms/somniq/protocol/openid-connect/userinfo','oidc.enabled':'true'};
  for(const [key,value] of Object.entries(options)) await api('/api/option/',{key,value},login.access_token,'PUT');
  console.log('Local New API configured. No model channels or paid credentials were installed.');
} else if (mode === 'serve') {
  const agreement = process.env.SOMNIQ_AGREEMENT_FILE || join(local,'development-agreement.txt');
  if(!process.env.SOMNIQ_AGREEMENT_FILE) await writeFile(agreement,'SomniQ 本地开发环境测试协议。仅用于账号链路验证，不是生产用户服务协议。\n');
  const env={...process.env,SOMNIQ_ACCOUNT_ADMIN_SUBJECTS:process.env.SOMNIQ_ACCOUNT_ADMIN_SUBJECTS||config.testSubject||'',SOMNIQ_ACCOUNT_BIND:'127.0.0.1:8800',SOMNIQ_ACCOUNT_PUBLIC_URL:publicOrigin,SOMNIQ_ACCOUNT_HOME_PATH:publicOrigin.endsWith(':5180')?'/account.html':'/account/',SOMNIQ_OIDC_ISSUER:'http://127.0.0.1:18882/realms/somniq',SOMNIQ_OIDC_CLIENT_ID:'somniq-web',SOMNIQ_OIDC_CLIENT_SECRET:config.oidcSecret,SOMNIQ_NEWAPI_URL:'http://127.0.0.1:18881',SOMNIQ_NEWAPI_OIDC_CLIENT_ID:'newapi',SOMNIQ_NEWAPI_INSTANCE_ID:'local-development',SOMNIQ_ACCOUNT_DATABASE:join(local,'accounts.sqlite3'),SOMNIQ_ACCOUNT_KEY:config.accountKey,SOMNIQ_AGREEMENT_VERSION:process.env.SOMNIQ_AGREEMENT_VERSION||'development-only',SOMNIQ_AGREEMENT_FILE:agreement,RUST_LOG:'somniq_account_server=info'};
  const child=spawn('cargo',['run','--locked','--manifest-path',join(directory,'Cargo.toml')],{env,stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
} else { throw new Error('Use init, check, up, configure-newapi, serve, or down'); }
