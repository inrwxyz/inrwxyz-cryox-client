/**
 * X bore.pub tunnel (Java Edition only, TCP). Pure Node.js - NO .exe is downloaded or started,
 * so Windows Defender / SmartScreen has nothing to block.
 *
 * It speaks the open `bore` protocol (github.com/ekzhang/bore, MIT) directly:
 *   - control connection to bore.pub:7835, messages are JSON terminated by a NUL byte
 *   - client -> {"Hello": <port or 0>}        server -> {"Hello": <public port>}
 *   - server -> "Heartbeat" (every ~500 ms)   server -> {"Connection": "<id>"} when a player connects
 *   - for every Connection we open a 2nd socket to bore.pub:7835, send {"Accept": "<id>"} and then
 *     pipe raw bytes between that socket and the local Minecraft server.
 * The public port is remembered per server and requested again next time, so the address stays the
 * same as long as that port is still free on bore.pub (otherwise a new one is used).
 * bore cannot carry Bedrock (UDP); Bedrock still needs the Playit tunnel.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const BORE_HOST = 'bore.pub';
const CONTROL_PORT = 7835;
const HELLO_TIMEOUT_MS = 10000;
const DEAD_AFTER_MS = 9000; // server heartbeats every 500 ms

class BoreManager extends EventEmitter {
  constructor({ settingsManager, host = BORE_HOST, controlPort = CONTROL_PORT } = {}) {
    super();
    this.settingsManager = settingsManager;
    this.host = host;
    this.controlPort = controlPort;
    this.tunnels = new Map(); // serverId -> { control, sockets:Set, watchdog }
  }

  get baseDir() {
    return path.join(this.settingsManager.getSettings().gameDataDir, 'servers', '.bore');
  }

  get portsFile() {
    return path.join(this.baseDir, 'ports.json');
  }

  _readPorts() {
    try { return JSON.parse(fs.readFileSync(this.portsFile, 'utf8')) || {}; } catch (_) { return {}; }
  }

  _savePort(serverId, port) {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const all = this._readPorts();
      all[serverId] = port;
      fs.writeFileSync(this.portsFile, JSON.stringify(all, null, 2), 'utf8');
    } catch (_) {}
  }

  /** Splits NUL-terminated JSON frames; returns a feed(chunk) function. */
  _frameReader(onMessage) {
    let buf = Buffer.alloc(0);
    return chunk => {
      buf = Buffer.concat([buf, chunk]);
      let idx;
      while ((idx = buf.indexOf(0)) !== -1) {
        const raw = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { continue; }
        onMessage(msg);
      }
    };
  }

  /** One control connection attempt. Resolves { remotePort, control } or rejects with a reason. */
  _openControl(wantedPort) {
    return new Promise((resolve, reject) => {
      const control = net.connect({ host: this.host, port: this.controlPort });
      control.setNoDelay(true);
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { control.destroy(); } catch (_) {}
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => fail(new Error('bore.pub did not answer in time. Check your internet connection.')), HELLO_TIMEOUT_MS);

      const state = { handler: null };
      const feed = this._frameReader(msg => {
        if (settled) { if (state.handler) state.handler(msg); return; }
        if (msg && typeof msg === 'object' && Number.isInteger(msg.Hello)) {
          settled = true;
          clearTimeout(timer);
          control.removeAllListeners('error');
          control.removeAllListeners('close');
          resolve({ remotePort: msg.Hello, control, setHandler: fn => { state.handler = fn; } });
        } else if (msg && typeof msg === 'object' && msg.Error) {
          fail(new Error(String(msg.Error)));
        } else if (msg && typeof msg === 'object' && msg.Challenge) {
          fail(new Error('bore.pub asked for a secret (not supported).'));
        }
      });
      control.on('data', chunk => feed(chunk));
      control.on('connect', () => {
        try { control.write(JSON.stringify({ Hello: wantedPort || 0 }) + '\0'); } catch (e) { fail(e); }
      });
      control.on('error', err => fail(err));
      control.on('close', () => fail(new Error('bore.pub closed the connection.')));
    });
  }

  _handleConnection(serverId, localPort, id, entry) {
    const remote = net.connect({ host: this.host, port: this.controlPort });
    const local = net.connect({ host: '127.0.0.1', port: localPort });
    entry.sockets.add(remote);
    entry.sockets.add(local);
    remote.setNoDelay(true);
    local.setNoDelay(true);
    remote.pause();
    const cleanup = () => {
      entry.sockets.delete(remote);
      entry.sockets.delete(local);
      try { remote.destroy(); } catch (_) {}
      try { local.destroy(); } catch (_) {}
    };
    remote.on('error', cleanup);
    local.on('error', cleanup);
    remote.on('close', cleanup);
    local.on('close', cleanup);
    remote.on('connect', () => {
      try { remote.write(JSON.stringify({ Accept: id }) + '\0'); } catch (_) { cleanup(); }
    });
    local.on('connect', () => {
      remote.pipe(local);
      local.pipe(remote);
      remote.resume();
    });
  }

  async start(serverId, localPort) {
    this.stop(serverId);
    const saved = this._readPorts()[serverId];
    let opened = null;
    if (saved) {
      try { opened = await this._openControl(saved); } catch (_) { opened = null; }
    }
    if (!opened) opened = await this._openControl(0);

    const { remotePort, control, setHandler } = opened;
    const entry = { control, sockets: new Set(), watchdog: null, stopped: false };
    this.tunnels.set(serverId, entry);

    let lastSeen = Date.now();
    const onDead = () => {
      if (entry.stopped) return;
      entry.stopped = true;
      this._teardown(entry);
      if (this.tunnels.get(serverId) === entry) {
        this.tunnels.delete(serverId);
        this.emit('exit', { serverId });
      }
    };
    setHandler(msg => {
      lastSeen = Date.now();
      if (msg && typeof msg === 'object' && msg.Connection) {
        this._handleConnection(serverId, localPort, msg.Connection, entry);
      } else if (msg && typeof msg === 'object' && msg.Error) {
        onDead();
      }
    });
    control.on('error', onDead);
    control.on('close', onDead);
    entry.watchdog = setInterval(() => {
      if (Date.now() - lastSeen > DEAD_AFTER_MS) onDead();
    }, 2000);
    if (entry.watchdog.unref) entry.watchdog.unref();

    this._savePort(serverId, remotePort);
    return { host: this.host, port: remotePort, display: `${this.host}:${remotePort}`, provider: 'bore' };
  }

  _teardown(entry) {
    entry.stopped = true;
    if (entry.watchdog) { clearInterval(entry.watchdog); entry.watchdog = null; }
    for (const s of Array.from(entry.sockets)) { try { s.destroy(); } catch (_) {} }
    entry.sockets.clear();
    try { entry.control.removeAllListeners(); entry.control.on('error', () => {}); entry.control.destroy(); } catch (_) {}
  }

  stop(serverId) {
    const entry = this.tunnels.get(serverId);
    if (!entry) return;
    this.tunnels.delete(serverId);
    this._teardown(entry);
  }

  stopAll() {
    for (const id of Array.from(this.tunnels.keys())) this.stop(id);
  }
}

module.exports = { BoreManager };
