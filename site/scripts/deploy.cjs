const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const host = 'root@106.53.28.124';
const keyPath = 'C:/Users/wt/.ssh/id_rsa';
const remoteDir = '/opt/somniq-remote/nginx';
const siteDist = path.join(__dirname, '..', 'dist');
const mobileDist = fs.existsSync(path.join(__dirname, '..', 'dist', 'remote'))
  ? path.join(__dirname, '..', 'dist', 'remote')
  : path.join(__dirname, '..', 'remote', 'dist');

function uploadFile(localPath, remotePath) {
  const cwd = path.dirname(localPath);
  const baseName = path.basename(localPath);
  const scpCmd = `scp -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "./${baseName}" ${host}:${remotePath}`;
  execSync(scpCmd, { cwd, stdio: 'inherit' });
}

/**
 * Packs `sourceDir` into `tarPath`.
 *
 * The archive is addressed relatively from inside the directory because GNU
 * tar (what Git Bash provides) reads a Windows drive letter as a remote
 * `host:path` and fails with "Cannot connect to F". Windows' own bsdtar is
 * happy either way, so this shape works from every shell.
 */
function packDirectory(sourceDir, tarPath, extraArgs = '') {
  const relativeTar = path.relative(sourceDir, tarPath).split(path.sep).join('/');
  execSync(`tar ${extraArgs} -czf "${relativeTar}" .`.replace(/\s+/g, ' '), {
    cwd: sourceDir,
    stdio: 'inherit',
  });
}

async function main() {
  console.log('📦 Packaging site and remote dists...');
  const siteTar = path.join(__dirname, '..', 'site.tar.gz');
  packDirectory(siteDist, siteTar, '--exclude=remote');

  let mobileTar = '';
  if (fs.existsSync(mobileDist)) {
    mobileTar = path.join(__dirname, '..', 'remote.tar.gz');
    packDirectory(mobileDist, mobileTar);
  }

  console.log(`🚀 Uploading dists to ${host}:${remoteDir}...`);
  await uploadFile(siteTar, `${remoteDir}/site.tar.gz`);
  if (mobileTar && fs.existsSync(mobileTar)) {
    await uploadFile(mobileTar, `${remoteDir}/remote.tar.gz`);
  }

  console.log('🔄 Extracting and reloading Nginx on server...');
  let extractCmd = `mkdir -p ${remoteDir}/site ${remoteDir}/remote && rm -rf ${remoteDir}/site/* && tar -xzf ${remoteDir}/site.tar.gz -C ${remoteDir}/site/ && rm -f ${remoteDir}/site.tar.gz`;
  if (mobileTar) {
    extractCmd += ` && rm -rf ${remoteDir}/remote/* && tar -xzf ${remoteDir}/remote.tar.gz -C ${remoteDir}/remote/ && rm -f ${remoteDir}/remote.tar.gz`;
  }
  extractCmd += ` && chmod 755 ${remoteDir} && chmod -R 755 ${remoteDir}/site ${remoteDir}/remote && docker exec nginx nginx -s reload`;

  execSync(`ssh -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${host} "${extractCmd}"`, { stdio: 'inherit' });

  if (fs.existsSync(siteTar)) fs.unlinkSync(siteTar);
  if (mobileTar && fs.existsSync(mobileTar)) fs.unlinkSync(mobileTar);

  console.log('✅ Deployment successful!');
  console.log('🌐 Main Landing & Auth: https://somni.chat/');
  console.log('📱 Mobile Remote PWA:   https://somni.chat/remote/');
}

main().catch((err) => {
  console.error('❌ Deployment failed:', err);
  process.exit(1);
});
