/**
 * X Automatic Public Tunnel Manager (Zero-Login Direct Tunnel + Playit.gg)
 * - Generates a local SSH keypair automatically using Windows OpenSSH (ssh-keygen) so
 *   a.pinggy.io / serveo.net authenticate in 2 seconds with ZERO login and ZERO popups!
 * - Also supports existing Playit.gg keys if present on the system, without ever forcing a login popup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { BoreManager } = require('./boreManager');

const API = 'https://api.playit.gg';
const UA = 'Cryox-Client-Launcher/1.0 (playit)';
const RELEASE_BASE = 'https://github.com/playit-cloud/playit-agent/releases/latest/download';

function agentAsset() {
  const arch = os.arch();
  if (process.platform === 'win32') return { file: 'playit-windows-x86_64-signed.exe', local: 'playit.exe' };
  if (process.platform === 'darwin') return { file: arch === 'arm64' ? 'playit-darwin-aarch64' : 'playit-darwin-intel', local: 'playit' };
  return { file: arch === 'arm64' ? 'playit-linux-aarch64' : 'playit-linux-amd64', local: 'playit' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// inex-playit-fix2: GitHub API for the real agent asset name + fetch with a timeout (no endless CONNECTING...)
const AGENT_LATEST_API = 'https://api.github.com/repos/playit-cloud/playit-agent/releases/latest';
const fetchT = (url, opts = {}, ms = 20000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });

class PlayitManager extends EventEmitter {
  constructor({ settingsManager }) {
    super();
    this.settingsManager = settingsManager;
    this.proc = null;
    this.directProcs = new Map(); // serverId -> child_process
    this.users = new Set();
    this.busy = null;
    this.gen = new Map(); // serverId -> counter, bumped by release() so a late share() can't resurrect a stopped tunnel
    this.bore = new BoreManager({ settingsManager });
    this.bore.on('exit', ({ serverId }) => {
      if (this.users.has(serverId)) {
        this._set({ status: 'error', message: 'bore.pub tunnel disconnected. Click Refresh Tunnel to reconnect.' });
      }
    });
    this.linkToken = 0;
    this.linking = false; // true while an account link is running: auto tunnels must stay out of the way
    this.autoSharing = new Set(); // serverIds currently connecting through the zero-login auto tunnel
    this.state = { status: 'off', message: '', claimUrl: '', tunnels: {} };
  }

  get baseDir() {
    return path.join(this.settingsManager.getSettings().gameDataDir, 'servers', '.playit');
  }

  get globalKeyFile() {
    return path.join(this.settingsManager.getSettings().configDir, 'playit-account.json');
  }

  get agentPath() {
    return path.join(this.baseDir, agentAsset().local);
  }

  get keyFile() {
    return path.join(this.baseDir, 'account.json');
  }

  get oldKeyFile() { // inex-playit-fix2: key kept after "Unlink" so a re-link can reuse the same agent
    return path.join(this.baseDir, 'account.unlinked.json');
  }

  get sshKeyPath() {
    return path.join(this.baseDir, 'inex_tunnel_ed25519');
  }

  _discoverSystemPlayitKey() {
    if (this._unlinkedExplicitly || fs.existsSync(path.join(this.baseDir, '.unlinked'))) {
      return null;
    }

    const jsonFiles = [this.keyFile, this.globalKeyFile];
    for (const jf of jsonFiles) {
      try {
        if (fs.existsSync(jf)) {
          const parsed = JSON.parse(fs.readFileSync(jf, 'utf8'));
          if (parsed && parsed.secretKey && String(parsed.secretKey).trim().length >= 16) {
            return String(parsed.secretKey).trim();
          }
        }
      } catch (_) {}
    }

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const tomlPaths = [
      path.join(localAppData, 'playit_gg', 'playit.toml'),
      path.join(appData, 'playit_gg', 'playit.toml'),
      path.join(localAppData, 'playit', 'playit.toml'),
      path.join(appData, 'playit', 'playit.toml'),
      path.join(os.homedir(), '.config', 'playit_gg', 'playit.toml')
    ];

    for (const tf of tomlPaths) {
      try {
        if (fs.existsSync(tf)) {
          const raw = fs.readFileSync(tf, 'utf8');
          const m = raw.match(/secret_key\s*=\s*["']?([A-Za-z0-9_-]{16,})["']?/i);
          if (m && m[1]) {
            return m[1];
          }
        }
      } catch (_) {}
    }
    return null;
  }

  _readKey() {
    return this._discoverSystemPlayitKey();
  }

  _writeKey(secretKey) {
    if (!secretKey) return;
    this._unlinkedExplicitly = false;
    try {
      const marker = path.join(this.baseDir, '.unlinked');
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch (_) {}

    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      fs.writeFileSync(this.keyFile, JSON.stringify({ secretKey }), 'utf8');
      fs.writeFileSync(path.join(this.baseDir, 'playit.toml'), `secret_key = "${secretKey}"\n`, 'utf8');
    } catch (_) {}

    try {
      fs.mkdirSync(path.dirname(this.globalKeyFile), { recursive: true });
      fs.writeFileSync(this.globalKeyFile, JSON.stringify({ secretKey }), 'utf8');
    } catch (_) {}

    try {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const pdir = path.join(localAppData, 'playit_gg');
      fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(path.join(pdir, 'playit.toml'), `secret_key = "${secretKey}"\n`, 'utf8');
    } catch (_) {}
  }

  isLinked() {
    return !!this._readKey();
  }

  unlink() {
    this._unlinkedExplicitly = true;
    this.stopAll();

    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      fs.writeFileSync(path.join(this.baseDir, '.unlinked'), 'unlinked', 'utf8');
    } catch (_) {}

    try { if (fs.existsSync(this.keyFile)) fs.unlinkSync(this.keyFile); } catch (_) {}
    try { if (fs.existsSync(this.globalKeyFile)) fs.unlinkSync(this.globalKeyFile); } catch (_) {}
    try { if (fs.existsSync(this.oldKeyFile)) fs.unlinkSync(this.oldKeyFile); } catch (_) {}
    try {
      const btoml = path.join(this.baseDir, 'playit.toml');
      if (fs.existsSync(btoml)) fs.unlinkSync(btoml);
    } catch (_) {}

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const tomlPaths = [
      path.join(localAppData, 'playit_gg', 'playit.toml'),
      path.join(appData, 'playit_gg', 'playit.toml'),
      path.join(localAppData, 'playit', 'playit.toml'),
      path.join(appData, 'playit', 'playit.toml')
    ];
    for (const tf of tomlPaths) {
      try { if (fs.existsSync(tf)) fs.unlinkSync(tf); } catch (_) {}
    }

    this._set({ status: 'off', message: '', claimUrl: '', tunnels: {} }, true);
    return { unlinked: true };
  }

  cancelLink() {
    this.linkToken++; // aborts a running link() poll loop
    this._set({ status: 'off', message: '', claimUrl: '' }, true);
    return { cancelled: true };
  }

  getState() {
    return { ...this.state, linked: this.isLinked(), sharing: Array.from(this.users) };
  }

  _set(patch, force) {
    if (this.linking && !force && patch) {
      // While an account link is running only the link flow may change the visible status.
      const { status, message, claimUrl, ...rest } = patch;
      patch = rest;
    }
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  // ---------- Zero-Login Direct SSH Key & Tunnel Engine ----------
  _ensureSshKey() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (fs.existsSync(this.sshKeyPath)) return this.sshKeyPath;

    const keygenBin = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe')
      ? 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'
      : 'ssh-keygen';

    try {
      execFileSync(keygenBin, ['-t', 'ed25519', '-f', this.sshKeyPath, '-N', '', '-q'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 6000
      });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(this.sshKeyPath, 0o600); } catch (_) {}
      }
      return fs.existsSync(this.sshKeyPath) ? this.sshKeyPath : null;
    } catch (_) {
      return null;
    }
  }

  _stopDirectTunnel(serverId) {
    const p = this.directProcs.get(serverId);
    if (p) {
      this.directProcs.delete(serverId);
      try { p.removeAllListeners(); p.kill(); } catch (_) {}
    }
  }

  _trySingleSshProvider(serverId, { port, bedrockPort, provider }) {
    const sshBin = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
      ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
      : 'ssh';
    const keyPath = this._ensureSshKey();
    const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';

    const args = [];
    if (keyPath) args.push('-i', keyPath);
    if (provider === 'pinggy') {
      args.push(
        '-p', '443',
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${nullFile}`,
        '-o', 'ServerAliveInterval=25',
        '-o', 'ConnectTimeout=10',
        '-T',
        `-R0:127.0.0.1:${port}`,
        'tcp@a.pinggy.io'
      );
    } else {
      args.push(
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${nullFile}`,
        '-o', 'ServerAliveInterval=25',
        '-o', 'ConnectTimeout=10',
        '-T',
        `-R0:127.0.0.1:${port}`,
        'serveo.net'
      );
    }

    return new Promise(resolve => {
      let proc;
      try {
        proc = spawn(sshBin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (_) {
        resolve(null);
        return;
      }

      let resolved = false;
      let output = '';
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { proc.kill(); } catch (_) {}
          resolve(null);
        }
      }, 12000);

      const checkOutput = chunk => {
        output += chunk.toString('utf8');
        const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

        // Match Pinggy TCP URL (e.g. tcp://rnpob-103-...a.free.pinggy.link:41289)
        const pinggyMatch =
          clean.match(/tcp:\/\/([a-zA-Z0-9.-]+\.pinggy\.link):(\d+)/i) ||
          clean.match(/([a-zA-Z0-9.-]+\.pinggy\.link):(\d+)/i);

        // Match Serveo TCP URL (e.g. Forwarding TCP connections from serveo.net:54321)
        const serveoMatch =
          clean.match(/Forwarding TCP connections from\s+([a-zA-Z0-9.-]+):(\d+)/i);

        const match = pinggyMatch || serveoMatch;
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          const host = match[1];
          const pubPort = parseInt(match[2], 10);
          this.directProcs.set(serverId, proc);

          proc.on('exit', () => {
            if (this.directProcs.get(serverId) === proc) {
              this.directProcs.delete(serverId);
              if (this.users.has(serverId)) {
                this._set({ status: 'error', message: 'Public tunnel disconnected. Click Refresh Tunnel to reconnect.' });
              }
            }
          });

          const res = {
            java: { host, port: pubPort, display: `${host}:${pubPort}` }
          };
          if (bedrockPort) {
            res.bedrock = { host, port: bedrockPort, display: `${host}:${bedrockPort}` };
          }
          resolve(res);
        }
      };

      proc.stdout.on('data', checkOutput);
      proc.stderr.on('data', checkOutput);
      proc.on('error', () => {
        if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
      });
      proc.on('exit', () => {
        if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
      });
    });
  }

  async _startDirectAutoTunnel(serverId, { port, bedrockPort }) {
    this._stopDirectTunnel(serverId);
    // Try Pinggy first (Port 443 TCP, works through all firewalls with SSH key)
    let res = await this._trySingleSshProvider(serverId, { port, bedrockPort, provider: 'pinggy' });
    if (res && res.java) return res;
    if (this.linking) return res;
    // Fallback to Serveo TCP tunnel
    res = await this._trySingleSshProvider(serverId, { port, bedrockPort, provider: 'serveo' });
    return res;
  }

  // ---------- Playit.gg API (Used if Playit secretKey already exists on PC) ----------
  async _call(route, body, secretKey) {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': UA };
    if (secretKey) headers.Authorization = `Agent-Key ${secretKey}`;
    const res = await fetchT(`${API}${route}`, { method: 'POST', headers, body: JSON.stringify(body || {}) }, 15000);
    const json = await res.json();
    if (json && json.status === 'success') return json.data;
    let detail = '';
    try {
      const d = json && json.data;
      detail = d ? (typeof d === 'string' ? d : (d.message || d.type || JSON.stringify(d))) : '';
    } catch (_) {}
    throw new Error('Playit API error' + (detail ? ': ' + String(detail).slice(0, 120) : ''));
  }

  async _agentDownloadUrls() {
    const asset = agentAsset();
    const urls = [];
    try {
      const r = await fetchT(AGENT_LATEST_API, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, 15000);
      if (r.ok) {
        const j = await r.json();
        const plat = process.platform === 'win32' ? /windows/i : process.platform === 'darwin' ? /darwin|macos/i : /linux/i;
        const wantArm = /arm|aarch/i.test(asset.file);
        const score = n => (/x86_64|amd64|x64/i.test(n) ? 3 : 0) + (/signed/i.test(n) ? 2 : 0);
        (j.assets || [])
          .filter(a => a && a.browser_download_url && plat.test(String(a.name)))
          .filter(a => !/\.(msi|zip|tar|gz|deb|rpm|sha256|sig|txt|json)$/i.test(String(a.name)))
          .filter(a => (process.platform !== 'win32' || /\.exe$/i.test(String(a.name))) && /arm|aarch/i.test(String(a.name)) === wantArm)
          .sort((a, b) => score(String(b.name)) - score(String(a.name)))
          .forEach(a => urls.push(a.browser_download_url));
      }
    } catch (_) {}
    urls.push(`${RELEASE_BASE}/${asset.file}`);
    if (process.platform === 'win32') urls.push(`${RELEASE_BASE}/playit-windows-x86-signed.exe`);
    return Array.from(new Set(urls));
  }

  async _ensureAgent() {
    if (fs.existsSync(this.agentPath) && fs.statSync(this.agentPath).size > 1_000_000) return;
    fs.mkdirSync(this.baseDir, { recursive: true });
    const errors = [];
    for (const url of await this._agentDownloadUrls()) {
      try {
        const res = await fetchT(url, { headers: { 'User-Agent': UA }, redirect: 'follow' }, 120000);
        if (!res.ok) { errors.push(`HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1_000_000) { errors.push('file too small'); continue; }
        if (process.platform === 'win32' && !(buf[0] === 0x4d && buf[1] === 0x5a)) { errors.push('not an exe'); continue; }
        const tmp = `${this.agentPath}.part`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, this.agentPath);
        if (process.platform !== 'win32') { try { fs.chmodSync(this.agentPath, 0o755); } catch (_) {} }
        this._agentFresh = true;
        return;
      } catch (e) {
        errors.push(e && e.message ? e.message : String(e));
      }
    }
    throw new Error('Playit agent download failed (' + errors.slice(0, 3).join(', ') + ')');
  }

  _addressOf(tunnel, kind) {
    const host = tunnel.custom_domain || tunnel.assigned_domain;
    const port = tunnel.port && tunnel.port.from;
    const hostOnly = kind === 'java' && /\.joinmc\.link$/i.test(host || '');
    return { host, port, display: hostOnly ? host : `${host}:${port}` };
  }

  async _ensurePlayitTunnel(secretKey, run, { kind, localPort }) {
    const type = kind === 'java' ? 'minecraft-java' : 'minecraft-bedrock';
    const proto = kind === 'java' ? 'tcp' : 'udp';
    const find = data => {
      const active = (data.tunnels || []).filter(t =>
        t.tunnel_type === type &&
        !t.disabled &&
        (t.custom_domain || t.assigned_domain)
      );
      // Prefer exact local_port match
      const exact = active.find(t => t.local_port === localPort);
      if (exact) return exact;
      // Re-use previously created tunnel on this agent
      return active[0] || null;
    };
    let existing = find(run);
    if (existing) return existing;

    const pending = (run.pending || []).find(t => t.tunnel_type === type);
    if (!pending) {
      const createPayload = {
        name: `X ${kind}${localPort}`,
        tunnel_type: type,
        port_type: proto,
        port_count: 1,
        origin: { type: 'agent', data: { agent_id: run.agent_id, local_ip: '127.0.0.1', local_port: localPort } },
        enabled: true,
        alloc: { type: 'region', details: { region: 'global' } },
        firewall_id: null
      };
      try {
        await this._call('/tunnels/create', createPayload, secretKey);
      } catch (err) {
        if (err && /body|validation|alloc/i.test(String(err.message))) {
          createPayload.alloc = null;
          await this._call('/tunnels/create', createPayload, secretKey);
        } else {
          throw err;
        }
      }
    }
    for (let i = 0; i < 15; i++) {
      await sleep(1200);
      const data = await this._call('/agents/rundata', {}, secretKey);
      existing = find(data);
      if (existing) return existing;
    }
    throw new Error('Playit tunnel timeout');
  }

  // Starts playit.exe and waits a few seconds to see that it really stays alive.
  _startPlayitAgent(secretKey) {
    if (this.proc) return Promise.resolve();
    if (!this._agentStarting) {
      this._agentStarting = this._startPlayitAgentImpl(secretKey).finally(() => { this._agentStarting = null; });
    }
    return this._agentStarting;
  }

  async _startPlayitAgentImpl(secretKey) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const logFile = path.join(this.baseDir, 'agent.log');
    try { fs.writeFileSync(logFile, ''); } catch (_) {}

    // Ensure the key is written to baseDir AND LOCALAPPDATA so playit.exe finds it
    this._writeKey(secretKey);

    const attempts = [['--stdout'], []];
    let tail = '';
    for (let round = 0; round < 2; round++) {
      for (const args of attempts) {
        const r = await this._spawnAgentOnce(secretKey, args, logFile);
        if (r.alive) return;
        tail = r.tail || tail;
      }
      if (round === 0) {
        if (this._agentFresh) break;
        try { fs.unlinkSync(this.agentPath); await this._ensureAgent(); } catch (_) { break; }
      }
    }
    throw new Error('Playit agent could not start' + (tail ? ': ' + tail.replace(/\s+/g, ' ').slice(0, 140) : ''));
  }

  _spawnAgentOnce(secretKey, args, logFile) {
    return new Promise(resolve => {
      const mask = s => String(s).split(secretKey).join('***');
      const shown = args.map(a => (a === secretKey ? '***' : a)).join(' ');
      try { fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} playit ${shown}\n`); } catch (_) {}
      let tail = '';
      let written = 0;
      let done = false;
      let timer = null;
      let proc;
      const finish = r => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
      try {
        proc = spawn(this.agentPath, args, {
          cwd: this.baseDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SECRET_KEY: secretKey }
        });
      } catch (e) {
        finish({ alive: false, tail: mask(e && e.message ? e.message : e) });
        return;
      }
      const onData = d => {
        const t = mask(d.toString('utf8'));
        tail = (tail + t).slice(-600);
        if (written < 1_000_000) { written += t.length; try { fs.appendFileSync(logFile, t); } catch (_) {} }
        if (/InvalidAgentKey/i.test(t)) {
          try { proc.kill(); } catch (_) {}
          finish({ alive: false, tail: 'Playit agent key is invalid or deleted. Please re-link account.' });
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', e => finish({ alive: false, tail: tail || mask(e && e.message ? e.message : e) }));
      proc.on('exit', code => {
        if (this.proc === proc) this.proc = null;
        finish({ alive: false, tail: tail.trim() || `exit code ${code}` });
      });
      timer = setTimeout(() => {
        if (done) return;
        this.proc = proc;
        finish({ alive: true });
      }, 3500);
    });
  }

  // Re-use the key saved by a previous "Unlink" (if Playit still accepts it) instead of creating one more agent.
  async _tryRestoreKey() {
    let key = null;
    try {
      const j = JSON.parse(fs.readFileSync(this.oldKeyFile, 'utf8'));
      key = j && j.secretKey ? String(j.secretKey).trim() : null;
    } catch (_) {}
    if (!key || key.length < 16) return false;
    try {
      const run = await this._call('/agents/rundata', {}, key);
      if (!run || !run.agent_id) return false;
      this._writeKey(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Right after linking: start the agent so playit.gg sees it online (this is what the browser page waits for).
  async _afterLink() {
    const key = this._readKey();
    if (!key) return;
    this._set({ status: 'linking', message: 'Starting Playit agent...', claimUrl: '' }, true);
    try {
      await this._ensureAgent();
      await this._startPlayitAgent(key);
      this._set({ status: 'off', message: '', claimUrl: '' }, true);
    } catch (e) {
      this._set({ status: 'error', message: 'Playit linked, but the agent could not start: ' + (e && e.message ? e.message : e), claimUrl: '' }, true);
    }
  }

  _stopPlayitAgent() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.removeAllListeners(); p.kill(); } catch (_) {}
  }


  // ---------- One-time link (makes the tunnel address PERMANENT) ----------
  // Runs ONLY when the user clicks "Make address permanent". Never opens by itself.
  // NOTE: the Playit claim page requires a (free) Playit login, there is no guest option.
  // The secret key is saved once; after that every start/stop reuses the same tunnel + address.
  async link(openUrl) {
    if (this.linking) return { ok: false, error: 'Link already in progress' };
    this.linking = true;
    try {
      this._pauseAutoTunnels();
      this._unlinkedExplicitly = false;
      const marker = path.join(this.baseDir, '.unlinked');
      try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch (_) {}

      // If an existing key exists, test whether it is genuinely valid on Playit.gg
      const existingKey = this._readKey();
      if (existingKey) {
        try {
          const run = await this._call('/agents/rundata', {}, existingKey);
          if (run && run.agent_id) {
            await this._afterLink();
            return { ok: true, already: true };
          }
        } catch (_) {
          // Key was invalid or expired on Playit: clean it up completely so user can link freshly
          this.unlink();
          this._unlinkedExplicitly = false;
          try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch (_) {}
        }
      }

      return await this._linkFlow(openUrl);
    } finally {
      this.linking = false;
    }
  }

  // Stops the zero-login auto tunnels (and drops ones still connecting) so they cannot interfere with the account link.
  _pauseAutoTunnels() {
    const ids = new Set([...this.directProcs.keys(), ...this.autoSharing]);
    if (!ids.size) return;
    const tunnels = { ...this.state.tunnels };
    for (const id of ids) {
      this.gen.set(id, (this.gen.get(id) || 0) + 1);
      this._stopDirectTunnel(id);
      this.users.delete(id);
      delete tunnels[id];
    }
    this._set({ tunnels });
  }

  async _linkFlow(openUrl) {
    const token = ++this.linkToken;
    const code = require('crypto').randomBytes(5).toString('hex');
    const claimUrl = 'https://playit.gg/claim/' + code;
    const asString = d => (typeof d === 'string' ? d : (d && (d.status || d.state || Object.keys(d)[0])) || '');
    try {
      await this._call('/claim/setup', { code, agent_type: 'self-managed', version: 'inex-launcher' });
    } catch (e) {
      this._set({ status: 'error', message: 'Could not start Playit link. Check your internet and try again.', claimUrl: '' }, true);
      return { ok: false, error: e.message };
    }
    this._set({ status: 'linking', message: 'Log in to Playit in the browser and approve.', claimUrl }, true);
    try { if (typeof openUrl === 'function') openUrl(claimUrl); } catch (_) {}

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (token !== this.linkToken) {
        this._set({ status: 'off', message: '', claimUrl: '' }, true);
        return { ok: false, cancelled: true };
      }
      await sleep(3000);
      let st = '';
      try { st = asString(await this._call('/claim/setup', { code, agent_type: 'self-managed', version: 'inex-launcher' })); } catch (_) { continue; }
      if (/UserRejected/i.test(st)) {
        this._set({ status: 'error', message: 'Playit link was rejected.', claimUrl: '' }, true);
        return { ok: false, error: 'rejected' };
      }
      if (/limit/i.test(st)) {
        this._set({ status: 'error', message: 'Your Playit account reached its agent limit. Open playit.gg > Manage Agent, delete old agents, then link again.', claimUrl: '' }, true);
        return { ok: false, error: 'agent limit' };
      }
      if (/UserAccepted/i.test(st)) {
        try {
          const ex = await this._call('/claim/exchange', { code });
          const key = ex && (ex.secret_key || ex.secretKey);
          if (!key) throw new Error('no key');
          this._writeKey(String(key).trim());
          await this._afterLink(); // inex-playit-fix2: start the agent now, otherwise playit.gg says "Agent is offline"
          return { ok: true };
        } catch (e) {
          this._set({ status: 'error', message: 'Playit approved, but key exchange failed. Try again.', claimUrl: '' }, true);
          return { ok: false, error: e.message };
        }
      }
    }
    this._set({ status: 'error', message: 'Playit link timed out. If the Playit page said "Agent limit reached", delete old agents at playit.gg > Manage Agent, then try again.', claimUrl: '' }, true);
    return { ok: false, error: 'timeout' };
  }

  // ---------- Public Share API ----------
  async share(serverId, opts = {}) {
    if (this.busy) await this.busy.catch(() => {});
    const token = (this.gen.get(serverId) || 0) + 1;
    this.gen.set(serverId, token);
    const job = this._share(serverId, opts);
    this.busy = job;
    try {
      const res = await job;
      if (this.gen.get(serverId) !== token) {
        // Released (or restarted) while we were connecting: drop whatever this run created.
        if (this.gen.get(serverId) > token) {
          this.release(serverId);
        }
        return { ok: false, cancelled: true };
      }
      return res;
    } finally { if (this.busy === job) this.busy = null; }
  }

  // bore.pub for Java (no login). Bedrock (UDP) still comes from Playit when an account is linked.
  async _shareViaBore(serverId, { port, bedrockPort }) {
    this._set({ status: 'starting', message: 'Connecting to bore.pub...', claimUrl: '' });
    let java;
    try {
      java = await this.bore.start(serverId, port);
    } catch (e) {
      this._set({ status: 'error', message: `bore.pub failed: ${e && e.message ? e.message : e}`, claimUrl: '' });
      return { ok: false, error: e && e.message };
    }
    const result = { java };
    const key = bedrockPort ? this._readKey() : null;
    if (key) {
      try {
        await this._ensureAgent();
        const run = await this._call('/agents/rundata', {}, key);
        if (run && run.agent_id) {
          const bedrock = await this._ensurePlayitTunnel(key, run, { kind: 'bedrock', localPort: bedrockPort });
          result.bedrock = this._addressOf(bedrock, 'bedrock');
          await this._startPlayitAgent(key);
        }
      } catch (_) {}
    }
    this.users.add(serverId);
    this._set({ status: 'running', message: '', claimUrl: '', tunnels: { ...this.state.tunnels, [serverId]: result } });
    return { ok: true, ...result };
  }

  async _share(serverId, { port, bedrockPort, javaTunnel }) {
    if (javaTunnel === 'bore') return this._shareViaBore(serverId, { port, bedrockPort });
    if (this.linking) return { ok: false, error: 'Playit link in progress' };
    this.bore.stop(serverId);
    const existingPlayitKey = this._readKey();
    this._set({
      status: 'starting',
      message: existingPlayitKey ? 'Connecting to playit.gg...' : 'Auto-generating public server IP & tunnel...',
      claimUrl: ''
    });

    // 1. If a Playit.gg secretKey is already present on the PC, use Playit.gg directly (no popup)
    if (existingPlayitKey) {
      this._lastPlayitError = null;
      try {
        await this._ensureAgent();
        // Start the agent first so playit.gg sees it online while the tunnels are being created.
        await this._startPlayitAgent(existingPlayitKey);
        const run = await this._call('/agents/rundata', {}, existingPlayitKey);
        if (run && run.agent_id) {
          const result = {};
          const java = await this._ensurePlayitTunnel(existingPlayitKey, run, { kind: 'java', localPort: port });
          result.java = this._addressOf(java, 'java');
          if (bedrockPort) {
            try {
              const fresh = await this._call('/agents/rundata', {}, existingPlayitKey);
              const bedrock = await this._ensurePlayitTunnel(existingPlayitKey, fresh, { kind: 'bedrock', localPort: bedrockPort });
              result.bedrock = this._addressOf(bedrock, 'bedrock');
            } catch (e) {
              // inex-playit-fix3: never invent a Bedrock address from the Java tunnel (a TCP host does not carry Bedrock UDP).
              // No Bedrock tunnel => no Bedrock address is shown. The reason goes to .playit/agent.log.
              try { fs.appendFileSync(path.join(this.baseDir, 'agent.log'), `\n--- ${new Date().toISOString()} bedrock tunnel unavailable: ${e && e.message ? e.message : e}\n`); } catch (_) {}
            }
          }
          this.users.add(serverId);
          await this._startPlayitAgent(existingPlayitKey);
          this._set({ status: 'running', message: '', claimUrl: '', tunnels: { ...this.state.tunnels, [serverId]: result } });
          return { ok: true, ...result };
        }
      } catch (e) {
        this._lastPlayitError = e && e.message;
        if (/invalid|expired|auth/i.test(this._lastPlayitError || '')) {
          this.unlink();
        }
      }

      // Account is linked: show the real problem instead of silently handing out a random address.
      const why = this._lastPlayitError ? ' (' + this._lastPlayitError + ')' : '';
      this._set({
        status: 'error',
        message: 'Could not connect to Playit.gg' + why + '. If your Playit account says "Agent limit reached", delete old agents at playit.gg > Manage Agent. Then click Connect Playit.gg again.',
        claimUrl: ''
      });
      return { ok: false, error: 'Playit connection failed' };
    }

    // 2. Zero-login temporary tunnel. Address changes on every restart (free relay limitation).
    //    Link a Playit account once to get a fixed address.
    this.autoSharing.add(serverId);
    let direct;
    try {
      direct = await this._startDirectAutoTunnel(serverId, { port, bedrockPort });
    } finally {
      this.autoSharing.delete(serverId);
    }
    if (direct && direct.java) {
      direct.temporary = true;
      delete direct.bedrock; // SSH relays are TCP only: Bedrock (UDP) needs the permanent Playit tunnel
      this.users.add(serverId);
      this._set({ status: 'running', message: 'Temporary address (changes on restart).', claimUrl: '', tunnels: { ...this.state.tunnels, [serverId]: direct } });
      return { ok: true, ...direct };
    }

    this._set({
      status: 'error',
      message: 'Could not reach public tunnel server. Check your internet connection and click Refresh Tunnel.',
      claimUrl: ''
    });
    return { ok: false, error: 'Could not establish public tunnel.' };
  }

  release(serverId) {
    this.gen.set(serverId, (this.gen.get(serverId) || 0) + 1);
    this.users.delete(serverId);
    this._stopDirectTunnel(serverId);
    this.bore.stop(serverId);
    const tunnels = { ...this.state.tunnels };
    delete tunnels[serverId];
    if (!this.users.size) {
      this._stopPlayitAgent();
      this._set({ status: 'off', message: '', claimUrl: '', tunnels });
    } else {
      this._set({ tunnels });
    }
  }

  stopAll() {
    for (const id of this.directProcs.keys()) {
      this._stopDirectTunnel(id);
    }
    this.bore.stopAll();
    this.users.clear();
    this._stopPlayitAgent();
    this.state = { ...this.state, status: 'off', tunnels: {} };
  }
}

module.exports = { PlayitManager };