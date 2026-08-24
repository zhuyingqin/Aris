const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const host = 'root@106.53.28.124';
const keyPath = 'C:/Users/wt/.ssh/id_rsa';
const remoteSrcDir = '/opt/somniq-remote/src';
const repoRoot = path.join(__dirname, '..', '..');
const serverTar = path.join(__dirname, '..', 'server_update.tar.gz');

async function main() {
  console.log('📦 Packaging server backend sources and dependencies...');
  
  // Package site/server (excluding target and .git), crates/remote-protocol, Cargo.toml, Cargo.lock
  const tarCmd = `tar --exclude="site/server/target" --exclude="site/node_modules" --exclude="site/dist" -czf "${serverTar}" -C "${repoRoot}" Cargo.toml Cargo.lock crates/remote-protocol site/server`;
  execSync(tarCmd, { stdio: 'inherit' });

  console.log(`🚀 Uploading server sources to ${host}:/opt/somniq-remote/...`);
  execSync(`scp -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${serverTar}" ${host}:/opt/somniq-remote/`, { stdio: 'inherit' });

  console.log('🔄 Extracting and building Docker container on server...');
  const remoteCmd = [
    `mkdir -p ${remoteSrcDir}`,
    `tar -xzf /opt/somniq-remote/server_update.tar.gz -C ${remoteSrcDir}`,
    `rm -f /opt/somniq-remote/server_update.tar.gz`,
    `cd ${remoteSrcDir}/site/server/deploy/behind-existing-nginx`,
    `docker compose -f compose.yml --env-file /opt/somniq-remote/.env up -d --build gateway`,
    `sleep 3`,
    `docker compose -f compose.yml --env-file /opt/somniq-remote/.env ps`
  ].join(' && ');

  execSync(`ssh -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${host} "${remoteCmd}"`, { stdio: 'inherit' });

  if (fs.existsSync(serverTar)) fs.unlinkSync(serverTar);

  console.log('✅ Server backend updated and restarted successfully!');
}

main().catch((err) => {
  if (fs.existsSync(serverTar)) fs.unlinkSync(serverTar);
  console.error('❌ Server deployment failed:', err);
  process.exit(1);
});
