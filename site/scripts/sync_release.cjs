const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const host = 'root@106.53.28.124';
const keyPath = 'C:/Users/wt/.ssh/id_rsa';
const remoteReleasesDir = '/opt/somniq-remote/nginx/releases';
const repoOwner = 'zhuyingqin';
const repoName = 'Aris';
const tunnelPort = 18234;

function downloadFileWithResume(url, destPath, expectedSize) {
  return new Promise((resolve, reject) => {
    let startBytes = 0;
    const isSmallFile = (expectedSize && expectedSize < 64 * 1024) || destPath.endsWith('.json') || destPath.endsWith('.sig');

    if (fs.existsSync(destPath)) {
      startBytes = fs.statSync(destPath).size;
      if (expectedSize && startBytes === expectedSize && !isSmallFile) {
        console.log(`   ⏭️ Asset already complete: ${path.basename(destPath)} (${(startBytes / (1024 * 1024)).toFixed(2)}MB)`);
        return resolve();
      }
      if (isSmallFile || (expectedSize && startBytes >= expectedSize)) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        startBytes = 0;
      }
    }

    const file = fs.createWriteStream(destPath, { flags: startBytes > 0 ? 'a' : 'w' });
    let req = null;
    let finished = false;

    function cleanupAndReject(err) {
      if (finished) return;
      finished = true;
      file.close();
      if (req) req.destroy();
      reject(err);
    }

    function get(currentUrl) {
      const client = currentUrl.startsWith('https') ? https : http;
      const headers = {
        'User-Agent': 'Node-Release-Sync-Script',
        'Accept': 'application/octet-stream, application/json, */*'
      };

      if (startBytes > 0) {
        headers['Range'] = `bytes=${startBytes}-`;
      }

      req = client.get(currentUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return cleanupAndReject(new Error(`Download HTTP error ${res.statusCode} for ${path.basename(destPath)}`));
        }

        let downloadedBytes = startBytes;
        const totalBytes = expectedSize || (parseInt(res.headers['content-length'] || '0', 10) + startBytes);
        let lastReport = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastReport > 3000 || downloadedBytes === totalBytes) {
            const percent = totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : '?';
            const mb = (downloadedBytes / (1024 * 1024)).toFixed(2);
            const totalMb = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(2) : '?';
            console.log(`   ⏳ [${path.basename(destPath)}] ${mb}MB / ${totalMb}MB (${percent}%)`);
            lastReport = now;
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          if (finished) return;
          finished = true;
          file.close(() => {
            console.log(`   ✓ Finished ${path.basename(destPath)}`);
            resolve();
          });
        });
      });

      req.on('error', cleanupAndReject);
      req.setTimeout(60000, () => {
        req.destroy(new Error(`Request timed out for ${path.basename(destPath)}`));
      });
    }

    get(url);
  });
}

async function downloadWithRetry(url, destPath, expectedSize, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await downloadFileWithResume(url, destPath, expectedSize);
      return;
    } catch (err) {
      console.warn(`   ⚠️ [${path.basename(destPath)}] Attempt ${attempt} failed: ${err.message}. Retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`Failed to download ${path.basename(destPath)} after ${maxRetries} attempts`);
}

async function fetchLatestRelease(tag) {
  const url = tag
    ? `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${tag}`
    : `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;

  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Node-Release-Sync-Script',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function startLocalHttpServer(serveDir, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const safeSuffix = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
      const filePath = path.join(serveDir, safeSuffix);
      
      console.log(`   [HTTP] ${req.method} ${req.url} -> ${filePath}`);

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Connection': 'close' });
        return res.end('Not Found\n');
      }

      const fileBuffer = fs.readFileSync(filePath);
      const totalSize = fileBuffer.length;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        
        if (start >= totalSize) {
          console.log(`   [HTTP] Range ${range} start >= totalSize ${totalSize} -> 200 OK empty`);
          res.writeHead(200, {
            'Content-Length': 0,
            'Content-Type': 'application/octet-stream',
            'Connection': 'close'
          });
          return res.end();
        }

        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const slice = fileBuffer.subarray(start, end + 1);

        console.log(`   [HTTP] Serving slice ${start}-${end}/${totalSize} (${(slice.length / (1024*1024)).toFixed(2)}MB)`);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': slice.length,
          'Content-Type': 'application/octet-stream',
          'Connection': 'close'
        });

        res.end(slice);
      } else {
        console.log(`   [HTTP] Serving full file ${filePath} (${(totalSize / (1024*1024)).toFixed(2)}MB)`);
        res.writeHead(200, {
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
          'Connection': 'close'
        });

        res.end(fileBuffer);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function runRemoteScript(remoteScript) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-i', keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', `${tunnelPort}:127.0.0.1:${tunnelPort}`,
        host,
        remoteScript,
      ],
      { stdio: 'inherit', windowsHide: true },
    );

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`SSH sync failed with ${reason}`));
    });
  });
}

async function main() {
  const requestedTag = process.argv[2];
  console.log(`🔍 Fetching GitHub release info ${requestedTag ? `for tag ${requestedTag}` : '(latest)'}...`);

  const release = await fetchLatestRelease(requestedTag);
  const tag = release.tag_name;
  const version = tag.replace(/^v/, '');
  console.log(`🏷️ Target Release: ${tag} (version ${version})`);
  console.log(`📋 Found ${release.assets.length} assets on GitHub.`);

  const tempDir = path.join(__dirname, '..', `temp_release_${tag}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Download all assets in parallel (concurrency pool)
  console.log('\n⬇️ Downloading assets in parallel locally from GitHub with resume support...');
  const downloadPromises = release.assets.map((asset) => {
    const dest = path.join(tempDir, asset.name);
    return downloadWithRetry(asset.browser_download_url, dest, asset.size);
  });

  await Promise.all(downloadPromises);
  console.log('\n✅ All assets successfully downloaded locally!');

  // Adjust latest.json for server hosting
  const latestJsonPath = path.join(tempDir, 'latest.json');
  if (fs.existsSync(latestJsonPath)) {
    console.log('\n🔧 Customizing latest.json for somni.chat endpoint...');
    const latestData = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
    
    if (latestData.platforms) {
      for (const platformKey of Object.keys(latestData.platforms)) {
        const p = latestData.platforms[platformKey];
        if (p && p.url) {
          const originalUrl = p.url;
          const fileName = path.basename(originalUrl);
          p.url = `https://somni.chat/releases/${tag}/${fileName}`;
        }
      }
    }
    fs.writeFileSync(latestJsonPath, JSON.stringify(latestData, null, 2), 'utf8');
    console.log('   ✓ latest.json rewritten with https://somni.chat/releases/ URLs.');
  }

  // Start local HTTP server for high-speed reverse tunnel transfer
  console.log(`\n🌐 Starting local streaming HTTP server on port ${tunnelPort}...`);
  const httpServer = await startLocalHttpServer(tempDir, tunnelPort);

  const remoteTagDir = `${remoteReleasesDir}/${tag}`;
  const exeFileName = `SomniQ.Studio_${version}_x64-setup.exe`;

  console.log('\n🚀 Transferring assets to server via SSH reverse tunnel at maximum speed...');

  const smallFiles = [
    'latest.json',
    `${exeFileName}.sig`,
    'SomniQ.Studio.app.tar.gz.sig'
  ];

  const largeFiles = [
    exeFileName,
    `SomniQ.Studio_${version}_universal.dmg`,
    'SomniQ.Studio.app.tar.gz'
  ];

  const smallCurlCommands = smallFiles.map(file => 
    `echo "Fetching ${file}..." && curl -sS -O "http://127.0.0.1:${tunnelPort}/${file}" && echo "✓ Done ${file}"`
  ).join(' && ');

  const largeCurlCommands = largeFiles.map(file => 
    `echo "Transferring ${file}..." && curl -C - -sS -O "http://127.0.0.1:${tunnelPort}/${file}" && echo "✓ Done ${file}"`
  ).join(' && ');

  const remoteScript = [
    `killall curl 2>/dev/null || true`,
    `mkdir -p "${remoteTagDir}" "${remoteReleasesDir}/latest/download"`,
    `cd "${remoteTagDir}"`,
    smallCurlCommands,
    largeCurlCommands,
    `cp "${remoteTagDir}/latest.json" "${remoteReleasesDir}/latest.json"`,
    `ln -sf "../${tag}/${exeFileName}" "${remoteReleasesDir}/latest/SomniQ.Studio_latest_x64-setup.exe"`,
    `ln -sf "../latest.json" "${remoteReleasesDir}/latest/latest.json"`,
    `ln -sf "../../latest.json" "${remoteReleasesDir}/latest/download/latest.json"`,
    `chmod -R 755 "${remoteReleasesDir}"`,
    `docker exec nginx nginx -s reload || true`
  ].join(' && ');

  try {
    await runRemoteScript(remoteScript);
  } finally {
    httpServer.close();
  }

  console.log(`\n🎉 Successfully synced ${tag} to server!`);
  console.log(`   Direct exe:     https://somni.chat/releases/${tag}/${exeFileName}`);
  console.log(`   Latest link:    https://somni.chat/releases/latest/SomniQ.Studio_latest_x64-setup.exe`);
  console.log(`   Latest json:    https://somni.chat/releases/latest.json`);
}

main().catch((err) => {
  console.error('\n❌ Release sync failed:', err);
  process.exit(1);
});
