// Usage (project root theke):  node agent-src/build-agent.js
// JDK thakle seta use kore, na thakle Temurin JDK 21 nijei download kore (ekbar, ~200MB).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const here = __dirname;
const exe = n => (isWin ? `${n}.exe` : n);

function which(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split(/\r?\n/)[0] || '').trim() || null : null;
}

function scanDirs(roots) {
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const direct = path.join(root, 'bin', exe('javac'));
      if (fs.existsSync(direct)) return direct;
      for (const d of fs.readdirSync(root)) {
        const p = path.join(root, d, 'bin', exe('javac'));
        if (fs.existsSync(p)) return p;
        const p2 = path.join(root, d, 'Contents', 'Home', 'bin', 'javac'); // macOS
        if (fs.existsSync(p2)) return p2;
      }
    } catch (_) {}
  }
  return null;
}

function findJavac() {
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', exe('javac'));
    if (fs.existsSync(p)) return p;
  }
  const w = which('javac');
  if (w && fs.existsSync(w)) return w;
  return scanDirs([
    path.join(here, '.jdk'),
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    path.join(os.homedir(), '.jdks')
  ]);
}


// ---- jar-ta Node diye-i banai (JDK-r `jar` tool lagbe na) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  }
  return out;
}
function writeJar(classesDir, manifestPath, jarOut) {
  const entries = [{ name: 'META-INF/MANIFEST.MF', data: fs.readFileSync(manifestPath) }, ...listFiles(classesDir)];
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + size;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(jarOut, Buffer.concat([...local, cd, eocd]));
}

async function downloadJdk() {
  const osName = isWin ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/21/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
  console.log('JDK paoa jayni. Temurin JDK 21 download hocche (ekbar-i, ~200MB)...');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const archive = path.join(os.tmpdir(), isWin ? 'inex-jdk.zip' : 'inex-jdk.tar.gz');
  fs.writeFileSync(archive, buf);
  const dest = path.join(here, '.jdk');
  fs.mkdirSync(dest, { recursive: true });
  const r = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`], { stdio: 'inherit' })
    : spawnSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('JDK extract failed');
  try { fs.unlinkSync(archive); } catch (_) {}
}

async function main() {
  let javac = findJavac();
  if (!javac) {
    await downloadJdk();
    javac = findJavac();
  }
  if (!javac) throw new Error('javac paoa jay ni. JDK 17+ install koro (adoptium.net) ba JAVA_HOME set koro.');
  console.log('javac:', javac);

  const out = path.join(here, 'out');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const r = spawnSync(javac, ['--release', '8', '-encoding', 'UTF-8', '-d', out, path.join(here, 'inex', 'InexSkinAgent.java')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('javac compile failed (upore error ta dekho)');

  const jarOut = path.join(here, 'inex-cosmetics-agent.jar');
  writeJar(out, path.join(here, 'manifest.txt'), jarOut);
  console.log('BUILD OK ->', jarOut);

  // Launcher-er pashe agent/ folder-e copy (src/main/agent/)
  const mainDir = path.join(here, '..', 'src', 'main');
  if (fs.existsSync(mainDir)) {
    const target = path.join(mainDir, 'agent');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(jarOut, path.join(target, 'inex-cosmetics-agent.jar'));
    console.log('Copied ->', path.join(target, 'inex-cosmetics-agent.jar'));
  }
}

if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
module.exports = { writeJar };
