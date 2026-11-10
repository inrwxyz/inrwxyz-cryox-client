/**
 * X Server Manager
 * - Supports Vanilla, Paper, Purpur, and Fabric servers
 * - Live Online-Mode (Premium Only) verification & instant kick for offline/cracked accounts
 * - Built-in INEX-FlightHelper plugin generator so "Allow flight" lets Survival players double-jump to fly live!
 * - Only runs live commands for properties that actually changed (Zero whitelist chat spam!)
 * - Removed auto-OP (Players only become OP when "Make OP" is clicked)
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { validateSafeRelativePath, createStoredZipBuffer } = require('./zipUtils');

const UA = 'Cryox-Client-Launcher/1.0 (server-manager)';
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const PAPER_V2_API = 'https://api.papermc.io/v2/projects/paper';
const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const META_FILE = 'inex-server.json';
const ADDON_LOCK_FILE = 'inex-server-addons.json';
const FLIGHT_PLUGIN_JAR = 'INEX-FlightHelper.jar';
const FLIGHT_FLAG_FILE = 'inex-allow-flight.flag';
const LOG_LIMIT = 2000;
const LOADERS = ['vanilla', 'paper', 'purpur', 'fabric'];
const PLAYER_NAME_RE = /^[A-Za-z0-9_.\-]{1,32}$/;
const GEYSER_URL = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads';
const STATS_KEEP = 60;

const EDITABLE_EXTENSIONS = new Set([
  '.yml', '.yaml', '.json', '.properties', '.toml', '.txt', '.conf', '.cfg', '.ini', '.log', '.mcmeta'
]);

const DEFAULT_PROPERTIES = {
  'server-port': '25565',
  motd: 'An CRYOX CLIENT server',
  'max-players': '20',
  'online-mode': 'false',
  'white-list': 'false',
  'enforce-whitelist': 'false',
  pvp: 'true',
  difficulty: 'easy',
  gamemode: 'survival',
  'force-gamemode': 'true',
  'view-distance': '10',
  'simulation-distance': '10',
  'allow-flight': 'false',
  'allow-nether': 'true',
  'allow-end': 'true',
  'spawn-monsters': 'true',
  'generate-structures': 'true',
  'hardcore': 'false',
  'hide-online-players': 'false',
  'enforce-secure-profile': 'false',
  'accepts-transfers': 'false',
  'log-ips': 'true',
  'sync-chunk-writes': 'true',
  'enable-status': 'true',
  'broadcast-console-to-ops': 'true',
  'spawn-protection': '0',
  'player-idle-timeout': '0',
  'enable-command-block': 'false'
};

function slugify(name) {
  return String(name || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
}

function offlineUuidForName(username) {
  const md5Bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  md5Bytes[6] = (md5Bytes[6] & 0x0f) | 0x30;
  md5Bytes[8] = (md5Bytes[8] & 0x3f) | 0x80;
  const hex = md5Bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds a tiny, 100% valid Bukkit/Paper plugin JAR (INEX-FlightHelper.jar) in pure Node.js
 * so toggling "Allow flight" in Properties lets Survival players double-jump to fly in-game!
 */
function buildInexFlightPluginJarBuffer() {
  const u1 = v => Buffer.from([v & 0xff]);
  const u2 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; };
  const i2 = v => { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b; };
  const u4 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };

  const cpEntries = [];
  let cpIndex = 1;
  const utf8Map = new Map();
  const clsMap = new Map();

  const addUtf8 = str => {
    if (utf8Map.has(str)) return utf8Map.get(str);
    const buf = Buffer.from(str, 'utf8');
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(1), u2(buf.length), buf]));
    utf8Map.set(str, idx);
    return idx;
  };
  const addClass = name => {
    if (clsMap.has(name)) return clsMap.get(name);
    const nameIdx = addUtf8(name);
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(7), u2(nameIdx)]));
    clsMap.set(name, idx);
    return idx;
  };
  const addString = str => {
    const uIdx = addUtf8(str);
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(8), u2(uIdx)]));
    return idx;
  };
  const addNameAndType = (name, desc) => {
    const nIdx = addUtf8(name);
    const dIdx = addUtf8(desc);
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(12), u2(nIdx), u2(dIdx)]));
    return idx;
  };
  const addMethod = (clsName, name, desc) => {
    const cIdx = addClass(clsName);
    const ntIdx = addNameAndType(name, desc);
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(10), u2(cIdx), u2(ntIdx)]));
    return idx;
  };
  const addInterfaceMethod = (clsName, name, desc) => {
    const cIdx = addClass(clsName);
    const ntIdx = addNameAndType(name, desc);
    const idx = cpIndex++;
    cpEntries.push(Buffer.concat([u1(11), u2(cIdx), u2(ntIdx)]));
    return idx;
  };
  const addLong = (hi, lo) => {
    const idx = cpIndex;
    cpIndex += 2; // Long takes 2 constant pool slots
    cpEntries.push(Buffer.concat([u1(5), u4(hi), u4(lo)]));
    return idx;
  };

  const thisCls = addClass('inex/FlightPlugin');
  const superCls = addClass('org/bukkit/plugin/java/JavaPlugin');
  const runnableCls = addClass('java/lang/Runnable');
  const clsFile = addClass('java/io/File');
  const clsPlayer = addClass('org/bukkit/entity/Player');

  const mSuperInit = addMethod('org/bukkit/plugin/java/JavaPlugin', '<init>', '()V');
  const mGetScheduler = addMethod('org/bukkit/Bukkit', 'getScheduler', '()Lorg/bukkit/scheduler/BukkitScheduler;');
  const imSchedule = addInterfaceMethod('org/bukkit/scheduler/BukkitScheduler', 'scheduleSyncRepeatingTask', '(Lorg/bukkit/plugin/Plugin;Ljava/lang/Runnable;JJ)I');
  const cLong10 = addLong(0, 10);
  const cLong20 = addLong(0, 20);

  const strFlag = addString(FLIGHT_FLAG_FILE);
  const strSurv = addString('SURVIVAL');
  const strAdv = addString('ADVENTURE');

  const mFileInit = addMethod('java/io/File', '<init>', '(Ljava/lang/String;)V');
  const mFileExists = addMethod('java/io/File', 'exists', '()Z');
  const mGetPlayers = addMethod('org/bukkit/Bukkit', 'getOnlinePlayers', '()Ljava/util/Collection;');
  const imIter = addInterfaceMethod('java/util/Collection', 'iterator', '()Ljava/util/Iterator;');
  const imHasNext = addInterfaceMethod('java/util/Iterator', 'hasNext', '()Z');
  const imNext = addInterfaceMethod('java/util/Iterator', 'next', '()Ljava/lang/Object;');
  const imGetGm = addInterfaceMethod('org/bukkit/entity/Player', 'getGameMode', '()Lorg/bukkit/GameMode;');
  const mGmName = addMethod('org/bukkit/GameMode', 'name', '()Ljava/lang/String;');
  const mStrEq = addMethod('java/lang/String', 'equals', '(Ljava/lang/Object;)Z');
  const imGetAllowFlight = addInterfaceMethod('org/bukkit/entity/Player', 'getAllowFlight', '()Z');
  const imSetAllowFlight = addInterfaceMethod('org/bukkit/entity/Player', 'setAllowFlight', '(Z)V');
  const imSetFlying = addInterfaceMethod('org/bukkit/entity/Player', 'setFlying', '(Z)V');

  const utfCode = addUtf8('Code');
  const utfInit = addUtf8('<init>');
  const utfOnEnable = addUtf8('onEnable');
  const utfRun = addUtf8('run');
  const utfVoidDesc = addUtf8('()V');

  const makeMethod = (nameIdx, descIdx, maxStack, maxLocals, codeBuf) => {
    const attrLen = 2 + 2 + 4 + codeBuf.length + 2 + 2;
    return Buffer.concat([
      u2(0x0001), // ACC_PUBLIC
      u2(nameIdx),
      u2(descIdx),
      u2(1), // 1 attribute (Code)
      u2(utfCode),
      u4(attrLen),
      u2(maxStack),
      u2(maxLocals),
      u4(codeBuf.length),
      codeBuf,
      u2(0), // exception_table_length
      u2(0)  // attributes_count
    ]);
  };

  // 1. <init>()V
  const initCode = Buffer.concat([
    u1(0x2a),
    u1(0xb7), u2(mSuperInit),
    u1(0xb1)
  ]);

  // 2. onEnable()V
  const onEnableCode = Buffer.concat([
    u1(0xb8), u2(mGetScheduler),
    u1(0x2a),
    u1(0x2a),
    u1(0x14), u2(cLong10),
    u1(0x14), u2(cLong20),
    u1(0xb9), u2(imSchedule), u1(7), u1(0),
    u1(0x57),
    u1(0xb1)
  ]);

  // 3. run()V (Offsets verified byte-for-byte: 0..124)
  const LOOP_START = 23;
  const IS_SURV_POS = 75;
  const DISALLOW_POS = 98;
  const RETURN_POS = 124;

  const runCode = Buffer.concat([
    u1(0xbb), u2(clsFile),                      // 0..2
    u1(0x59),                                   // 3
    u1(0x13), u2(strFlag),                      // 4..6
    u1(0xb7), u2(mFileInit),                    // 7..9
    u1(0xb6), u2(mFileExists),                  // 10..12
    u1(0x3c),                                   // 13 (istore_1)
    u1(0xb8), u2(mGetPlayers),                  // 14..16
    u1(0xb9), u2(imIter), u1(1), u1(0),         // 17..21
    u1(0x4d),                                   // 22 (astore_2)
    // LOOP_START (23):
    u1(0x2c),                                   // 23
    u1(0xb9), u2(imHasNext), u1(1), u1(0),      // 24..28
    u1(0x99), i2(RETURN_POS - 29),              // 29..31 (ifeq RETURN_POS)
    u1(0x2c),                                   // 32
    u1(0xb9), u2(imNext), u1(1), u1(0),         // 33..37
    u1(0xc0), u2(clsPlayer),                    // 38..40
    u1(0x4e),                                   // 41 (astore_3)
    u1(0x2d),                                   // 42
    u1(0xb9), u2(imGetGm), u1(1), u1(0),        // 43..47
    u1(0xb6), u2(mGmName),                      // 48..50
    u1(0x3a), u1(4),                            // 51..52 (astore 4)
    u1(0x19), u1(4),                            // 53..54 (aload 4)
    u1(0x13), u2(strSurv),                      // 55..57
    u1(0xb6), u2(mStrEq),                       // 58..60
    u1(0x9a), i2(IS_SURV_POS - 61),             // 61..63 (ifne IS_SURV_POS)
    u1(0x19), u1(4),                            // 64..65
    u1(0x13), u2(strAdv),                       // 66..68
    u1(0xb6), u2(mStrEq),                       // 69..71
    u1(0x99), i2(LOOP_START - 72),              // 72..74 (ifeq LOOP_START)
    // IS_SURV_POS (75):
    u1(0x1b),                                   // 75 (iload_1)
    u1(0x99), i2(DISALLOW_POS - 76),            // 76..78 (ifeq DISALLOW_POS)
    u1(0x2d),                                   // 79
    u1(0xb9), u2(imGetAllowFlight), u1(1), u1(0), // 80..84
    u1(0x9a), i2(LOOP_START - 85),              // 85..87 (ifne LOOP_START)
    u1(0x2d),                                   // 88
    u1(0x04),                                   // 89 (iconst_1)
    u1(0xb9), u2(imSetAllowFlight), u1(2), u1(0), // 90..94
    u1(0xa7), i2(LOOP_START - 95),              // 95..97 (goto LOOP_START)
    // DISALLOW_POS (98):
    u1(0x2d),                                   // 98
    u1(0xb9), u2(imGetAllowFlight), u1(1), u1(0), // 99..103
    u1(0x99), i2(LOOP_START - 104),             // 104..106 (ifeq LOOP_START)
    u1(0x2d),                                   // 107
    u1(0x03),                                   // 108 (iconst_0)
    u1(0xb9), u2(imSetFlying), u1(2), u1(0),    // 109..113
    u1(0x2d),                                   // 114
    u1(0x03),                                   // 115 (iconst_0)
    u1(0xb9), u2(imSetAllowFlight), u1(2), u1(0), // 116..120
    u1(0xa7), i2(LOOP_START - 121),             // 121..123 (goto LOOP_START)
    // RETURN_POS (124):
    u1(0xb1)                                    // 124 (return)
  ]);

  const classBuf = Buffer.concat([
    u4(0xcafebabe),
    u2(0), u2(50), // Java 6 bytecode (version 50.0) - runs on all JVMs (8..25+) without StackMapTable
    u2(cpIndex),
    ...cpEntries,
    u2(0x0021), // ACC_PUBLIC | ACC_SUPER
    u2(thisCls),
    u2(superCls),
    u2(1), u2(runnableCls), // implements Runnable
    u2(0), // fields_count
    u2(3), // methods_count
    makeMethod(utfInit, utfVoidDesc, 1, 1, initCode),
    makeMethod(utfOnEnable, utfVoidDesc, 8, 1, onEnableCode),
    makeMethod(utfRun, utfVoidDesc, 3, 5, runCode),
    u2(0)  // attributes_count
  ]);

  const pluginYml = Buffer.from(
    'name: INEXFlightHelper\nversion: 1.0.0\nmain: inex.FlightPlugin\napi-version: "1.13"\n',
    'utf8'
  );

  return createStoredZipBuffer({
    'plugin.yml': pluginYml,
    'inex/FlightPlugin.class': classBuf
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for${url}`);
  return res.json();
}

class ServerManager extends EventEmitter {
  constructor({ settingsManager, versionManager, javaManager }) {
    super();
    this.settingsManager = settingsManager;
    this.versionManager = versionManager;
    this.javaManager = javaManager;
    this.runtime = new Map();
    this.creating = new Set();
    this.lastLogs = new Map();
  }

  get rootDir() {
    return path.join(this.settingsManager.getSettings().gameDataDir, 'servers');
  }

  serverDir(id) {
    const safe = String(id || '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(safe)) throw new Error('Invalid server id.');
    return path.join(this.rootDir, safe);
  }

  _readMeta(id) {
    const file = path.join(this.serverDir(id), META_FILE);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  _writeMeta(meta) {
    fs.writeFileSync(path.join(this.serverDir(meta.id), META_FILE), JSON.stringify(meta, null, 2), 'utf8');
  }

  _requireMeta(id) {
    const meta = this._readMeta(id);
    if (!meta) throw new Error('Server not found.');
    return meta;
  }

  _isPluginLoader(loader) {
    return loader === 'paper' || loader === 'purpur';
  }

  // Returns Set of lowercase usernames that are local (offline/cracked) accounts in Cryox Client
  _getLocalOfflineAccountNames() {
    const out = new Set();
    try {
      const cfgDir = this.settingsManager.getSettings().configDir;
      const accFile = path.join(cfgDir, 'accounts.json');
      if (!fs.existsSync(accFile)) return out;
      const parsed = JSON.parse(fs.readFileSync(accFile, 'utf8'));
      for (const acc of (parsed && Array.isArray(parsed.accounts) ? parsed.accounts : [])) {
        if (acc && acc.username && acc.type !== 'microsoft') {
          out.add(String(acc.username).toLowerCase());
        }
      }
    } catch (_) {}
    return out;
  }

  _syncFlightHelperAndFlag(id, props) {
    try {
      const meta = this._requireMeta(id);
      const dir = this.serverDir(id);
      const flagPath = path.join(dir, FLIGHT_FLAG_FILE);
      const allowFlight = String((props || {})['allow-flight']) === 'true';

      if (allowFlight) {
        fs.writeFileSync(flagPath, 'true\n', 'utf8');
      } else if (fs.existsSync(flagPath)) {
        try { fs.unlinkSync(flagPath); } catch (_) {}
      }

      if (this._isPluginLoader(meta.loader)) {
        const pluginsDir = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const jarPath = path.join(pluginsDir, FLIGHT_PLUGIN_JAR);
        const fresh = buildInexFlightPluginJarBuffer();
        let same = false;
        try { same = fs.existsSync(jarPath) && fs.readFileSync(jarPath).equals(fresh); } catch (_) {}
        if (!same) {
          // also replaces older broken helper jars from earlier launcher versions
          fs.writeFileSync(jarPath, fresh);
          return { jarWritten: true };
        }
      }
    } catch (_) {}
    return { jarWritten: false };
  }

  getSystemMemory() {
    return { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) };
  }

  // server-icon.png (64x64) is the standard Minecraft server icon; the launcher shows the same file as the server logo.
  _readLogo(id) {
    try {
      const f = path.join(this.serverDir(id), 'server-icon.png');
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 200 * 1024) return '';
      this._logoCache = this._logoCache || new Map();
      const c = this._logoCache.get(id);
      if (c && c.mtime === st.mtimeMs) return c.url;
      const url = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      this._logoCache.set(id, { mtime: st.mtimeMs, url });
      return url;
    } catch (_) { return ''; }
  }

  _writeLogo(dir, dataUrl) {
    try {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      if (!m) return;
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length < 8 || buf.length > 200 * 1024 || buf.slice(0, 4).toString('hex') !== '89504e47') return;
      fs.writeFileSync(path.join(dir, 'server-icon.png'), buf);
    } catch (_) {}
  }

  _publicState(meta) {
    const rt = this.runtime.get(meta.id);
    const lastStat = rt && rt.stats.length ? rt.stats[rt.stats.length - 1] : null;
    let maxPlayers = 20;
    try {
      const p = this.readProperties(meta.id).values;
      maxPlayers = parseInt(p['max-players'], 10) || 20;
    } catch (_) {}

    return {
      ...meta,
      maxPlayers,
      status: rt ? rt.status : 'offline',
      players: rt ? Array.from(rt.players) : [],
      startedAt: rt ? rt.startedAt : null,
      cpu: rt && lastStat ? lastStat.cpu : 0,
      usedRamMb: rt && lastStat ? lastStat.ramMb : 0,
      bedrock: this.detectBedrock(meta.id),
      logo: this._readLogo(meta.id)
    };
  }

  listServers() {
    const out = [];
    if (!fs.existsSync(this.rootDir)) return out;
    for (const d of fs.readdirSync(this.rootDir)) {
      try {
        const meta = this._readMeta(d);
        if (meta) out.push(this._publicState(meta));
      } catch (_) {}
    }
    return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  getServer(id) {
    return this._publicState(this._requireMeta(id));
  }

  async getVersionsForLoader(loader) {
    const l = String(loader || 'vanilla').toLowerCase();
    if (!LOADERS.includes(l)) throw new Error('Unsupported loader.');
    if (l === 'vanilla') {
      const data = await this.versionManager.listVersions({ includeSnapshots: false });
      return data.versions.filter(v => v.type === 'release').map(v => v.id);
    }
    if (l === 'paper') {
      try {
        const data = await fetchJson(PAPER_API);
        const groups = data.versions || {};
        const all = Object.values(groups).flat();
        return all.sort((a, b) => this._cmpVersion(b, a)).filter(v => /^\d+(\.\d+)*$/.test(v));
      } catch (_) {
        const data = await fetchJson(PAPER_V2_API);
        return (data.versions || []).slice().reverse();
      }
    }
    if (l === 'purpur') {
      const data = await fetchJson(PURPUR_API);
      return (data.versions || []).slice().reverse();
    }
    const games = await fetchJson(`${FABRIC_META}/versions/game`);
    return games.filter(g => g.stable).map(g => g.version);
  }

  _cmpVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  }

  async _resolveJarUrl(loader, version) {
    if (loader === 'vanilla') {
      const meta = await this.versionManager.resolveVersionMetadata(version);
      const url = meta && meta.downloads && meta.downloads.server && meta.downloads.server.url;
      if (!url) throw new Error(`Minecraft ${version} has no official server download.`);
      return { url, loaderVersion: 'official', javaMajor: this.versionManager.getRequiredJavaMajor(version, meta) };
    }
    const meta = await this.versionManager.resolveVersionMetadata(version).catch(() => null);
    const javaMajor = this.versionManager.getRequiredJavaMajor(version, meta);

    if (loader === 'paper') {
      try {
        const builds = await fetchJson(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds`);
        if (Array.isArray(builds) && builds.length) {
          const stable = builds.find(b => b.channel === 'STABLE') || builds[0];
          const url = stable && stable.downloads && stable.downloads['server:default'] && stable.downloads['server:default'].url;
          if (url) return { url, loaderVersion: `build ${stable.id}`, javaMajor };
        }
      } catch (_) {}
      const v2 = await fetchJson(`${PAPER_V2_API}/versions/${encodeURIComponent(version)}/builds`);
      const builds = v2.builds || [];
      if (!builds.length) throw new Error(`Paper is not available for Minecraft ${version}.`);
      const last = builds[builds.length - 1];
      const dlName = (last.downloads && last.downloads.application && last.downloads.application.name) || `paper-${version}-${last.build}.jar`;
      return {
        url: `${PAPER_V2_API}/versions/${encodeURIComponent(version)}/builds/${last.build}/downloads/${dlName}`,
        loaderVersion: `build ${last.build}`,
        javaMajor
      };
    }

    if (loader === 'purpur') {
      const info = await fetchJson(`${PURPUR_API}/${encodeURIComponent(version)}`);
      const latestBuild = (info && info.builds && info.builds.latest) || 'latest';
      return {
        url: `${PURPUR_API}/${encodeURIComponent(version)}/${encodeURIComponent(latestBuild)}/download`,
        loaderVersion: `build ${latestBuild}`,
        javaMajor
      };
    }

    const [loaders, installers] = await Promise.all([
      fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(version)}`),
      fetchJson(`${FABRIC_META}/versions/installer`)
    ]);
    if (!Array.isArray(loaders) || !loaders.length) throw new Error(`Fabric is not available for Minecraft ${version}.`);
    const loaderVer = (loaders.find(x => x.loader && x.loader.stable) || loaders[0]).loader.version;
    const installerVer = (installers.find(x => x.stable) || installers[0]).version;
    return {
      url: `${FABRIC_META}/versions/loader/${encodeURIComponent(version)}/${loaderVer}/${installerVer}/server/jar`,
      loaderVersion: loaderVer,
      javaMajor
    };
  }

  async _download(url, dest, onProgress) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        if (total && onProgress) onProgress(Math.round((got / total) * 100));
      }
      await new Promise((resolve, reject) => { out.end(err => (err ? reject(err) : resolve())); });
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
    fs.renameSync(tmp, dest);
  }

  async createServer(payload, onProgress = () => {}) {
    const name = String((payload && payload.name) || '').trim().slice(0, 40);
    const loader = String((payload && payload.loader) || 'paper').toLowerCase();
    const version = String((payload && payload.version) || '').trim();
    if (!name) throw new Error('Give your server a name.');
    if (!LOADERS.includes(loader)) throw new Error('Unsupported loader.');
    if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error('Pick a Minecraft version.');
    if (!payload.eulaAccepted) throw new Error('You must accept the Minecraft EULA to create a server.');
    const ramMb = Math.min(Math.max(Number(payload.ramMb) || 2048, 512), 65536);
    const port = Math.min(Math.max(parseInt(payload.port, 10) || 25565, 1024), 65535);

    let id = slugify(name);
    while (fs.existsSync(path.join(this.rootDir, id)) || this.creating.has(id)) {
      id = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    this.creating.add(id);
    const dir = path.join(this.rootDir, id);
    try {
      onProgress({ id, stage: 'Looking up server files', percent: 3 });
      const jar = await this._resolveJarUrl(loader, version);
      fs.mkdirSync(dir, { recursive: true });
      if (this._isPluginLoader(loader)) fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      if (loader === 'fabric') fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });

      onProgress({ id, stage: `Downloading ${loader} ${version}`, percent: 8 });
      await this._download(jar.url, path.join(dir, 'server.jar'), p => {
        onProgress({ id, stage: `Downloading ${loader} ${version}`, percent: 8 + Math.round(p * 0.8) });
      });
      fs.writeFileSync(path.join(dir, 'eula.txt'), '# Accepted in CRYOX CLIENT\neula=true\n', 'utf8');
      const props = { ...DEFAULT_PROPERTIES, 'server-port': String(port), motd: `${name} · CRYOX CLIENT` };
      this._writeProperties(dir, props);

      const meta = {
        id, name, loader, version,
        loaderVersion: jar.loaderVersion,
        javaMajor: jar.javaMajor,
        ramMb, port,
        playit: payload.playit !== false,
        eulaAccepted: true,
        createdAt: Date.now()
      };
      this._writeMeta(meta);
      this._writeLogo(dir, payload.logo);
      this._syncFlightHelperAndFlag(id, props);
      onProgress({ id, stage: 'Server ready', percent: 100 });
      return this._publicState(meta);
    } catch (err) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      throw err;
    } finally {
      this.creating.delete(id);
    }
  }

  updateServer(id, updates) {
    const meta = this._requireMeta(id);
    if (updates && typeof updates.name === 'string' && updates.name.trim()) meta.name = updates.name.trim().slice(0, 40);
    if (updates && updates.ramMb !== undefined) meta.ramMb = Math.min(Math.max(Number(updates.ramMb) || meta.ramMb, 512), 65536);
    if (updates && typeof updates.playit === 'boolean') meta.playit = updates.playit;
    if (updates && (updates.javaTunnel === 'bore' || updates.javaTunnel === 'playit')) meta.javaTunnel = updates.javaTunnel;
    this._writeMeta(meta);
    return this._publicState(meta);
  }

  async deleteServer(id) {
    this._requireMeta(id);
    const rt = this.runtime.get(id);
    if (rt && rt.proc) throw new Error('Stop the server before deleting it.');
    this.runtime.delete(id);
    fs.rmSync(this.serverDir(id), { recursive: true, force: true });
    return { deleted: true };
  }

  // ---------- properties ----------
  _readBukkitAllowEnd(dir) {
    const bukkitFile = path.join(dir, 'bukkit.yml');
    if (!fs.existsSync(bukkitFile)) return null;
    try {
      const raw = fs.readFileSync(bukkitFile, 'utf8');
      const m = raw.match(/^\s*allow-end:\s*(true|false)\b/m);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  _writeBukkitAllowEnd(dir, allowEndStr) {
    const bukkitFile = path.join(dir, 'bukkit.yml');
    const val = String(allowEndStr) === 'false' ? 'false' : 'true';
    try {
      if (fs.existsSync(bukkitFile)) {
        const raw = fs.readFileSync(bukkitFile, 'utf8');
        if (/^\s*allow-end:\s*(true|false)\b/m.test(raw)) {
          fs.writeFileSync(bukkitFile, raw.replace(/^(\s*allow-end:\s*)(true|false)\b/m, `$1${val}`), 'utf8');
          return;
        }
      } else {
        fs.writeFileSync(bukkitFile, `settings:\n  allow-end: ${val}\n`, 'utf8');
      }
    } catch (_) {}
  }

  readProperties(id) {
    this._requireMeta(id);
    const dir = this.serverDir(id);
    const file = path.join(dir, 'server.properties');
    const values = {};
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    const bukkitEnd = this._readBukkitAllowEnd(dir);
    if (bukkitEnd !== null && values['allow-end'] === undefined) {
      values['allow-end'] = bukkitEnd;
    }
    const rt = this.runtime.get(id);
    if (rt && rt.pendingProps) {
      Object.assign(values, rt.pendingProps);
    }
    return { values, defaults: DEFAULT_PROPERTIES };
  }

  _writeProperties(dir, updates) {
    const file = path.join(dir, 'server.properties');
    let lines = [];
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const pending = { ...updates };
    if (pending['allow-end'] !== undefined) {
      this._writeBukkitAllowEnd(dir, pending['allow-end']);
    }
    lines = lines.map(line => {
      if (!line || line.startsWith('#')) return line;
      const i = line.indexOf('=');
      if (i <= 0) return line;
      const key = line.slice(0, i).trim();
      if (Object.prototype.hasOwnProperty.call(pending, key)) {
        const v = pending[key];
        delete pending[key];
        return `${key}=${v}`;
      }
      return line;
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const [k, v] of Object.entries(pending)) lines.push(`${k}=${v}`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  }

  _isPlayerCrackedOrOffline(id, playerName) {
    const rt = this.runtime.get(id);
    const lower = String(playerName || '').toLowerCase();
    // 1. Check if this username is registered as a Local (Offline) account in X Launcher
    const localSet = this._getLocalOfflineAccountNames();
    if (localSet.has(lower)) return true;
    // 2. Check if the UUID logged by the server for this player is an OfflinePlayer v3 UUID
    if (rt && rt.playerUuids && rt.playerUuids.has(lower)) {
      const loggedUuid = rt.playerUuids.get(lower);
      const expectedOfflineUuid = offlineUuidForName(playerName).toLowerCase();
      if (loggedUuid === expectedOfflineUuid || /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-/i.test(loggedUuid)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Applies ONLY the properties that actually changed (`changedOnly`), silencing command feedback
   * so in-game chat is never spammed with "[Server: Reloaded the whitelist]"!
   */
  _applyLivePropertyCommands(id, changedOnly) {
    const rt = this.runtime.get(id);
    if (!rt || rt.status !== 'online') return;
    const keys = Object.keys(changedOnly || {});
    if (!keys.length) return;

    const runSilent = cmd => {
      try { this.sendCommand(id, cmd, { silent: true }); } catch (_) {}
    };

    // Silence in-game "[Server: ...]" broadcast spam while applying settings
    runSilent('gamerule sendCommandFeedback false');
    runSilent('gamerule send_command_feedback false');

    // 1. Default Gamemode changed
    if (changedOnly.gamemode && ['survival', 'creative', 'adventure', 'spectator'].includes(changedOnly.gamemode)) {
      runSilent(`defaultgamemode ${changedOnly.gamemode}`);
      runSilent(`gamemode ${changedOnly.gamemode} @a`);
      for (const p of rt.players) {
        runSilent(`gamemode ${changedOnly.gamemode} ${p}`);
      }
    }

    // 2. Difficulty changed
    if (changedOnly.difficulty && ['peaceful', 'easy', 'normal', 'hard'].includes(changedOnly.difficulty)) {
      runSilent(`difficulty ${changedOnly.difficulty}`);
    }

    // 3. PvP Combat changed
    if (changedOnly.pvp !== undefined) {
      const pvpOn = changedOnly.pvp === 'true';
      runSilent(`gamerule pvp ${pvpOn ? 'true' : 'false'}`);
      if (!pvpOn) {
        runSilent('team add inex_nopvp');
        runSilent('team modify inex_nopvp friendlyFire false');
        runSilent('team modify inex_nopvp seeFriendlyInvisibles false');
        runSilent('team join inex_nopvp @a');
        for (const p of rt.players) {
          runSilent(`team join inex_nopvp ${p}`);
        }
      } else {
        runSilent('team empty inex_nopvp');
        runSilent('team remove inex_nopvp');
      }
    }

    // 3b. Command blocks changed (new Minecraft: command_blocks_work, older: commandBlocksEnabled)
    if (changedOnly['enable-command-block'] !== undefined) {
      const on = changedOnly['enable-command-block'] === 'true' ? 'true' : 'false';
      runSilent(`gamerule command_blocks_work ${on}`);
      runSilent(`gamerule commandBlocksEnabled ${on}`);
    }

    // 4. Whitelist / enforce-whitelist changed
    if (changedOnly['white-list'] !== undefined || changedOnly['enforce-whitelist'] !== undefined) {
      const cur = this.readProperties(id).values;
      const wlOn = String(cur['white-list']) === 'true';
      if (changedOnly['white-list'] !== undefined) runSilent(wlOn ? 'whitelist on' : 'whitelist off');
      runSilent('whitelist reload');
      // The running server saves `white-list` itself; stop our saved copy from overriding it later.
      setTimeout(() => { if (rt.pendingProps) delete rt.pendingProps['white-list']; }, 3000);
      // enforce-whitelist is only read by the server at startup, so kick non-whitelisted players ourselves.
      if (wlOn && String(cur['enforce-whitelist']) === 'true') {
        setTimeout(() => this._kickNonWhitelisted(id), 800);
      }
    }

    // 5. Online-Mode (Premium Only) changed LIVE -> Kick any offline/cracked players immediately!
    if (changedOnly['online-mode'] === 'true') {
      for (const p of Array.from(rt.players)) {
        if (this._isPlayerCrackedOrOffline(id, p)) {
          runSilent(`kick ${p} Online Mode (Premium Only) is enabled on this server!`);
        }
      }
    }
  }

  _kickNonWhitelisted(id) {
    const rt = this.runtime.get(id);
    if (!rt || rt.status !== 'online') return;
    const dir = this.serverDir(id);
    const names = file => new Set((Array.isArray(this._readJson(path.join(dir, file), [])) ? this._readJson(path.join(dir, file), []) : [])
      .filter(x => x && x.name).map(x => String(x.name).toLowerCase()));
    const allowed = names('whitelist.json');
    const ops = names('ops.json'); // ops are exempt from the whitelist, like in vanilla
    for (const p of Array.from(rt.players)) {
      const n = p.toLowerCase();
      if (!allowed.has(n) && !ops.has(n)) {
        try { this.sendCommand(id, `kick ${p} You are not whitelisted on this server!`, { silent: true }); } catch (_) {}
      }
    }
  }

  writeProperties(id, updates) {
    const meta = this._requireMeta(id);
    const prevValues = this.readProperties(id).values;
    const clean = {};
    const changedOnly = {};

    for (const [k, v] of Object.entries(updates || {})) {
      if (!/^[a-z0-9._-]+$/i.test(k)) continue;
      const valStr = String(v).replace(/[\r\n]+/g, ' ').trim();
      clean[k] = valStr;
      const prevStr = prevValues[k] !== undefined ? String(prevValues[k]) : (DEFAULT_PROPERTIES[k] !== undefined ? String(DEFAULT_PROPERTIES[k]) : '');
      if (valStr !== prevStr) {
        changedOnly[k] = valStr;
      }
    }

    if (changedOnly.gamemode) {
      clean['force-gamemode'] = 'true';
    }

    const dir = this.serverDir(id);
    this._writeProperties(dir, clean);
    const flightSync = this._syncFlightHelperAndFlag(id, { ...prevValues, ...clean });

    if (clean['server-port']) {
      const p = parseInt(clean['server-port'], 10);
      if (p >= 1024 && p <= 65535) { meta.port = p; this._writeMeta(meta); }
    }

    const rt = this.runtime.get(id);
    if (rt) {
      rt.pendingProps = Object.assign(rt.pendingProps || {}, clean);
      this._applyLivePropertyCommands(id, changedOnly);
    }

    const RESTART_KEYS = ['server-port', 'level-seed', 'max-players', 'view-distance', 'simulation-distance', 'enable-command-block', 'enable-status', 'hide-online-players', 'enforce-secure-profile', 'op-permission-level', 'player-idle-timeout', 'spawn-protection', 'generate-structures', 'spawn-animals', 'spawn-npcs'];
    const restartKeys = rt ? Object.keys(changedOnly).filter(k => RESTART_KEYS.includes(k)) : [];
    // Flight plugin only loads at server start: first time it is created it needs one restart.
    if (rt && changedOnly['allow-flight'] === 'true' && ((flightSync && flightSync.jarWritten) || !this._isPluginLoader(meta.loader))) restartKeys.push('allow-flight');
    return { saved: true, appliedLive: !!(rt && rt.status === 'online'), restartNeeded: this.runtime.has(id), restartKeys };
  }

  // ---------- live stats ----------
  _startSampler(id, rt) {
    const pid = rt.proc && rt.proc.pid;
    if (!pid) return;
    const cores = os.cpus().length || 1;
    const push = (cpu, ramMb) => {
      if (!Number.isFinite(cpu) || !Number.isFinite(ramMb)) return;
      const sample = { t: Date.now(), cpu: Math.max(0, Math.min(100, Number(cpu.toFixed(1)))), ramMb: Math.round(ramMb) };
      rt.stats.push(sample);
      if (rt.stats.length > STATS_KEEP) rt.stats.shift();
      this.emit('stats', { id, ...sample });
    };

    if (process.platform === 'win32') {
      const script = `$last=$null;$lt=[DateTime]::UtcNow;while($true){try{$q=Get-Process -Id ${pid} -ErrorAction Stop;$now=[DateTime]::UtcNow;$c=$q.TotalProcessorTime.TotalSeconds;$pct=0;if($last -ne $null){$dt=($now-$lt).TotalSeconds;if($dt -gt 0){$pct=(($c-$last)/$dt)/${cores}*100}};$last=$c;$lt=$now;[Console]::Out.WriteLine([string]::Format([Globalization.CultureInfo]::InvariantCulture,'{0:0.0} {1:0}',$pct,($q.WorkingSet64/1MB)))}catch{exit};Start-Sleep -Seconds 2}`;
      let ps;
      try {
        ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) { return; }
      let buf = '';
      ps.stdout.setEncoding('utf8');
      ps.stdout.on('data', chunk => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          const [cpu, ram] = line.trim().split(' ').map(Number);
          push(cpu, ram);
        }
      });
      ps.on('error', () => {});
      rt.sampler = { stop: () => { try { ps.kill(); } catch (_) {} } };
      return;
    }

    const timer = setInterval(() => {
      execFile('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], (err, out) => {
        if (err || !out) return;
        const [cpu, rssKb] = out.trim().split(/\s+/).map(Number);
        push(cpu / cores, rssKb / 1024);
      });
    }, 2000);
    rt.sampler = { stop: () => clearInterval(timer) };
  }

  getStats(id) {
    const rt = this.runtime.get(id);
    return rt ? rt.stats.slice() : [];
  }

  // ---------- players ----------
  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
  }

  _writeJson(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
  }

  getPlayerLists(id) {
    const meta = this._requireMeta(id);
    const dir = this.serverDir(id);
    const rt = this.runtime.get(id);

    if (rt && rt.status === 'online' && (!rt.lastListPoll || Date.now() - rt.lastListPoll > 4000)) {
      rt.lastListPoll = Date.now();
      try { this.sendCommand(id, 'list', { silent: true }); } catch (_) {}
    }

    const ops = this._readJson(path.join(dir, 'ops.json'), []);
    const banned = this._readJson(path.join(dir, 'banned-players.json'), []);
    const white = this._readJson(path.join(dir, 'whitelist.json'), []);
    const cache = this._readJson(path.join(dir, 'usercache.json'), []);
    const props = this.readProperties(id).values;
    return {
      running: !!(rt && rt.status === 'online'),
      status: rt ? rt.status : 'offline',
      online: rt ? Array.from(rt.players) : [],
      ops: (Array.isArray(ops) ? ops : []).filter(o => o && o.name).map(o => ({ name: o.name, level: o.level || 4 })),
      banned: (Array.isArray(banned) ? banned : []).filter(b => b && b.name).map(b => ({ name: b.name, reason: b.reason || 'Banned by operator' })),
      whitelist: (Array.isArray(white) ? white : []).filter(w => w && w.name).map(w => ({ name: w.name })),
      recent: (Array.isArray(cache) ? cache : []).filter(c => c && c.name).map(c => c.name).slice(0, 30),
      whitelistEnabled: String(props['white-list']) === 'true',
      loader: meta.loader
    };
  }

  playerAction(id, action, name, reason) {
    this._requireMeta(id);
    const dir = this.serverDir(id);
    const rt = this.runtime.get(id);
    const isOnline = !!(rt && (rt.status === 'online' || rt.status === 'starting'));

    if (action === 'whitelist-on' || action === 'whitelist-off') {
      const enable = action === 'whitelist-on';
      this.writeProperties(id, { 'white-list': enable ? 'true' : 'false' });
      return { ok: true, whitelistEnabled: enable };
    }

    if (action === 'refresh-list') {
      if (isOnline) {
        try { this.sendCommand(id, 'list', { silent: true }); } catch (_) {}
      }
      return { ok: true };
    }

    const who = String(name || '').trim();
    if (!PLAYER_NAME_RE.test(who)) throw new Error('Enter a valid Minecraft player username.');
    const why = String(reason || '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '').trim().slice(0, 100);

    const table = {
      kick: () => `kick ${who}${why ? ' ' + why : ''}`,
      ban: () => `ban ${who}${why ? ' ' + why : ''}`,
      pardon: () => `pardon ${who}`,
      op: () => `op ${who}`,
      deop: () => `deop ${who}`,
      'whitelist-add': () => `whitelist add ${who}`,
      'whitelist-remove': () => `whitelist remove ${who}`
    };
    if (!table[action]) throw new Error('Unknown player action.');

    if (action === 'kick' && !isOnline) {
      throw new Error('Server must be online to kick an active player.');
    }

    // Server running: ONLY send the real command. The server keeps ops / bans / whitelist in memory
    // and owns those JSON files; editing them behind its back makes it answer "Nothing changed".
    const live = !!(rt && rt.status === 'online');
    if (live) {
      this.sendCommand(id, table[action]());
      if (action === 'whitelist-add' || action === 'whitelist-remove') {
        try { this.sendCommand(id, 'whitelist reload', { silent: true }); } catch (_) {}
        if (action === 'whitelist-remove') {
          const cur = this.readProperties(id).values;
          if (String(cur['white-list']) === 'true' && String(cur['enforce-whitelist']) === 'true') {
            setTimeout(() => this._kickNonWhitelisted(id), 800);
          }
        }
      }
      if (action === 'kick' || action === 'ban') {
        for (const p of Array.from(rt.players)) {
          if (p.toLowerCase() === who.toLowerCase()) rt.players.delete(p);
        }
        this._setStatus(id, rt.status);
      }
      return { sent: true, offlineUpdated: false };
    }
    if (isOnline) {
      throw new Error('Server is still starting. Wait until it is online, then try again.');
    }

    // Server offline: edit the JSON files directly (applied on next start).
    const uuid = offlineUuidForName(who);
    const same = x => x && String(x.name).toLowerCase() === who.toLowerCase();
    const edit = (fileName, fn) => {
      const file = path.join(dir, fileName);
      const list = this._readJson(file, []);
      this._writeJson(file, fn(Array.isArray(list) ? list : []));
    };
    if (action === 'op') {
      edit('ops.json', l => l.some(same) ? l : [...l, { uuid, name: who, level: 4, bypassesPlayerLimit: false }]);
    } else if (action === 'deop') {
      edit('ops.json', l => l.filter(x => !same(x)));
    } else if (action === 'ban') {
      edit('banned-players.json', l => l.some(same) ? l : [...l, {
        uuid, name: who, created: new Date().toISOString().replace('T', ' ').replace(/\..+$/, ' +0000'),
        source: 'X Server Console', expires: 'forever', reason: why || 'Banned by an operator.'
      }]);
    } else if (action === 'pardon') {
      edit('banned-players.json', l => l.filter(x => !same(x)));
    } else if (action === 'whitelist-add') {
      edit('whitelist.json', l => l.some(same) ? l : [...l, { uuid, name: who }]);
    } else if (action === 'whitelist-remove') {
      edit('whitelist.json', l => l.filter(x => !same(x)));
    }
    return { sent: false, offlineUpdated: true };
  }

  // ---------- Modrinth Addons ----------
  _addonLockPath(id) {
    return path.join(this.serverDir(id), ADDON_LOCK_FILE);
  }

  _readAddonLock(id) {
    try { return JSON.parse(fs.readFileSync(this._addonLockPath(id), 'utf8')); } catch (_) { return { items: {} }; }
  }

  _writeAddonLock(id, data) {
    fs.writeFileSync(this._addonLockPath(id), JSON.stringify(data, null, 2), 'utf8');
  }

  listServerAddons(id) {
    const meta = this._requireMeta(id);
    if (meta.loader === 'vanilla') return [];
    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    fs.mkdirSync(folder, { recursive: true });
    const lock = this._readAddonLock(id);
    const items = [];
    for (const fileName of fs.readdirSync(folder)) {
      if (fileName === FLIGHT_PLUGIN_JAR || fileName === `${FLIGHT_PLUGIN_JAR}.disabled`) continue;
      const full = path.join(folder, fileName);
      let st;
      try { st = fs.statSync(full); if (!st.isFile()) continue; } catch (_) { continue; }
      if (!fileName.toLowerCase().endsWith('.jar') && !fileName.toLowerCase().endsWith('.jar.disabled')) continue;
      const enabled = !fileName.toLowerCase().endsWith('.disabled');
      const baseName = enabled ? fileName : fileName.slice(0, -'.disabled'.length);
      const info = (lock.items && lock.items[baseName]) || null;
      items.push({
        fileName,
        baseName,
        enabled,
        size: st.size,
        title: (info && info.title) || baseName.replace(/\.jar$/i, ''),
        author: (info && info.author) || 'Installed JAR',
        versionNumber: (info && info.versionNumber) || '',
        iconUrl: (info && info.iconUrl) || '',
        projectId: (info && info.projectId) || null
      });
    }
    return items;
  }

  async searchServerAddons(id, { query = '', offset = 0, limit = 15, sortIndex = 'downloads', strictVersion = true } = {}) {
    const meta = this._requireMeta(id);
    if (meta.loader === 'vanilla') {
      return { hits: [], totalHits: 0, vanillaLocked: true, version: meta.version, loader: meta.loader };
    }
    const isPluginSrv = this._isPluginLoader(meta.loader);
    const buildFacets = useStrictVer => {
      const f = [
        isPluginSrv ? ['categories:paper', 'categories:purpur', 'categories:spigot', 'categories:bukkit'] : ['categories:fabric'],
        isPluginSrv ? ['project_type:plugin', 'project_type:mod'] : ['project_type:mod']
      ];
      if (useStrictVer) {
        f.unshift([`versions:${meta.version}`]);
      }
      return f;
    };

    const runSearch = async useStrictVer => {
      const params = new URLSearchParams({
        query: String(query || '').trim(),
        facets: JSON.stringify(buildFacets(useStrictVer)),
        index: sortIndex || 'downloads',
        offset: String(Math.max(0, Number(offset) || 0)),
        limit: String(Math.max(1, Math.min(30, Number(limit) || 15)))
      });
      const res = await fetch(`${MODRINTH_API}/search?${params.toString()}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`Modrinth search failed (HTTP ${res.status})`);
      return res.json();
    };

    let usedStrict = strictVersion !== false;
    let data = await runSearch(usedStrict);

    if (usedStrict && isPluginSrv && Number(offset) === 0 && (!data.hits || data.hits.length < 6) && strictVersion !== 'force') {
      const broadData = await runSearch(false);
      if (broadData && Array.isArray(broadData.hits) && broadData.hits.length > (data.hits ? data.hits.length : 0)) {
        const seen = new Set((data.hits || []).map(h => h.project_id));
        const mergedHits = [...(data.hits || [])];
        for (const h of broadData.hits) {
          if (!seen.has(h.project_id) && mergedHits.length < (Number(limit) || 15)) {
            seen.add(h.project_id);
            mergedHits.push(h);
          }
        }
        data = {
          hits: mergedHits,
          total_hits: Math.max(data.total_hits || 0, broadData.total_hits || mergedHits.length)
        };
        usedStrict = false;
      }
    }

    const installedList = this.listServerAddons(id);
    const installedIds = new Set(installedList.map(x => x.projectId).filter(Boolean));
    const hits = (data.hits || []).map(h => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      author: h.author || 'Creator',
      description: h.description || '',
      downloads: h.downloads || 0,
      iconUrl: h.icon_url || '',
      categories: h.categories || [],
      installed: installedIds.has(h.project_id)
    }));
    return {
      hits,
      totalHits: data.total_hits || hits.length,
      version: meta.version,
      loader: meta.loader,
      strictVersionUsed: usedStrict
    };
  }

  async installServerAddon(id, { projectId, title = '', author = '', iconUrl = '' }, onProgress = () => {}) {
    const meta = this._requireMeta(id);
    if (meta.loader === 'vanilla') throw new Error('Vanilla servers cannot install plugins or mods.');
    const isPluginSrv = this._isPluginLoader(meta.loader);
    const loaders = isPluginSrv ? ['paper', 'purpur', 'spigot', 'bukkit'] : ['fabric'];

    onProgress({ id, stage: `Matching ${title || projectId} for ${meta.version}`, percent: 15 });

    const exactParams = new URLSearchParams({
      game_versions: JSON.stringify([meta.version]),
      loaders: JSON.stringify(loaders)
    });
    let res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${exactParams.toString()}`, {
      headers: { 'User-Agent': UA }
    });
    let versions = res.ok ? await res.json() : [];

    if ((!Array.isArray(versions) || !versions.length) && isPluginSrv) {
      const fallbackParams = new URLSearchParams({
        loaders: JSON.stringify(loaders)
      });
      res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${fallbackParams.toString()}`, {
        headers: { 'User-Agent': UA }
      });
      if (res.ok) versions = await res.json();
    }

    const matched = (Array.isArray(versions) ? versions : []).find(v =>
      Array.isArray(v.game_versions) && v.game_versions.includes(meta.version) &&
      Array.isArray(v.loaders) && v.loaders.some(l => loaders.includes(l))
    ) || (Array.isArray(versions) ? versions[0] : null);

    if (!matched) {
      throw new Error(`No compatible release found for Minecraft ${meta.version} (${meta.loader}).`);
    }
    const file = (matched.files || []).find(f => f.primary) || (matched.files || [])[0];
    if (!file || !file.url) throw new Error('No downloadable JAR file found for this project.');

    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    fs.mkdirSync(folder, { recursive: true });
    const safeDest = validateSafeRelativePath(path.basename(file.filename), folder);

    onProgress({ id, stage: `Downloading ${file.filename}`, percent: 45 });
    await this._download(file.url, safeDest, p => {
      onProgress({ id, stage: `Downloading ${file.filename}`, percent: 45 + Math.round(p * 0.5) });
    });

    const lock = this._readAddonLock(id);
    lock.items = lock.items || {};
    lock.items[path.basename(safeDest)] = {
      projectId,
      title: title || path.basename(safeDest),
      author: author || 'Modrinth',
      versionNumber: matched.version_number || '',
      iconUrl: iconUrl || '',
      installedAt: new Date().toISOString()
    };
    this._writeAddonLock(id, lock);
    onProgress({ id, stage: 'Installed', percent: 100 });
    return {
      installed: true,
      fileName: path.basename(safeDest),
      restartNeeded: this.runtime.has(id),
      items: this.listServerAddons(id)
    };
  }

  toggleServerAddon(id, fileName) {
    const meta = this._requireMeta(id);
    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    const currentPath = validateSafeRelativePath(path.basename(fileName), folder);
    if (!fs.existsSync(currentPath)) throw new Error('Addon file not found.');
    const nextName = fileName.endsWith('.disabled')
      ? fileName.slice(0, -'.disabled'.length)
      : `${fileName}.disabled`;
    const nextPath = validateSafeRelativePath(path.basename(nextName), folder);
    fs.renameSync(currentPath, nextPath);
    return { items: this.listServerAddons(id), restartNeeded: this.runtime.has(id) };
  }

  removeServerAddon(id, fileName) {
    const meta = this._requireMeta(id);
    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    const safePath = validateSafeRelativePath(path.basename(fileName), folder);
    if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
    const baseName = fileName.endsWith('.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName;
    const lock = this._readAddonLock(id);
    if (lock.items && lock.items[baseName]) {
      delete lock.items[baseName];
      this._writeAddonLock(id, lock);
    }
    return { items: this.listServerAddons(id), restartNeeded: this.runtime.has(id) };
  }

  // ---------- Server File & Config Editor ----------
  listServerFiles(id, relDir = '') {
    const root = this.serverDir(id);
    const cleanRel = String(relDir || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const target = cleanRel ? validateSafeRelativePath(cleanRel, root) : root;
    if (!fs.existsSync(target)) return { relDir: cleanRel, entries: [] };

    const entries = [];
    for (const name of fs.readdirSync(target)) {
      if (name === META_FILE || name === ADDON_LOCK_FILE || name === FLIGHT_FLAG_FILE || name === FLIGHT_PLUGIN_JAR || name.endsWith('.part')) continue;
      const full = path.join(target, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      const entryRel = cleanRel ? `${cleanRel}/${name}` : name;
      const ext = path.extname(name).toLowerCase();
      entries.push({
        name,
        relPath: entryRel,
        isDirectory: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        editable: !st.isDirectory() && (EDITABLE_EXTENSIONS.has(ext) || name === 'eula.txt') && st.size <= 1024 * 1024
      });
    }
    entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    return { relDir: cleanRel, entries };
  }

  readServerFile(id, relPath) {
    const root = this.serverDir(id);
    const safe = validateSafeRelativePath(relPath, root);
    if (!fs.existsSync(safe) || fs.statSync(safe).isDirectory()) throw new Error('File not found.');
    const stat = fs.statSync(safe);
    if (stat.size > 1024 * 1024) throw new Error('File is too large to edit in the launcher (>1 MB).');
    return {
      relPath,
      name: path.basename(safe),
      content: fs.readFileSync(safe, 'utf8')
    };
  }

  writeServerFile(id, relPath, content) {
    const root = this.serverDir(id);
    const safe = validateSafeRelativePath(relPath, root);
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, String(content == null ? '' : content), 'utf8');
    return { saved: true, relPath, restartNeeded: this.runtime.has(id) };
  }

  // ---------- Bedrock (Geyser) ----------
  _pluginFolder(meta) {
    return meta.loader === 'fabric' ? 'mods' : 'plugins';
  }

  _geyserConfigPath(meta) {
    const dir = this.serverDir(meta.id);
    return meta.loader === 'fabric'
      ? path.join(dir, 'config', 'Geyser-Fabric', 'config.yml')
      : path.join(dir, 'plugins', 'Geyser-Spigot', 'config.yml');
  }

  detectBedrock(id) {
    const meta = this._requireMeta(id);
    if (meta.loader === 'vanilla') return { supported: false, geyser: false, port: null, running: false, configRelPath: null };
    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    let jars = [];
    try { jars = fs.readdirSync(folder).filter(f => /\.jar$/i.test(f)); } catch (_) {}
    const geyser = jars.some(f => /geyser/i.test(f));
    let port = 19132;
    const cfgPath = this._geyserConfigPath(meta);
    const configRelPath = fs.existsSync(cfgPath)
      ? path.relative(this.serverDir(meta.id), cfgPath).replace(/\\/g, '/')
      : null;
    try {
      const yml = fs.readFileSync(cfgPath, 'utf8');
      const m = yml.match(/^bedrock:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+port:\s*(\d+)/m);
      if (m) port = parseInt(m[1], 10) || port;
    } catch (_) {}
    const rt = this.runtime.get(id);
    if (rt && rt.bedrockPort) port = rt.bedrockPort;
    const active = geyser || !!(rt && rt.bedrockPort);
    return {
      supported: true,
      geyser: active,
      port: active ? port : null,
      running: !!(rt && rt.bedrockPort),
      configRelPath
    };
  }

  async installBedrockSupport(id, onProgress = () => {}) {
    const meta = this._requireMeta(id);
    if (meta.loader === 'vanilla') throw new Error('Vanilla servers cannot load Bedrock support. Create a Paper, Purpur, or Fabric server.');
    if (this.detectBedrock(id).geyser) return { installed: true, already: true };
    const platform = meta.loader === 'fabric' ? 'fabric' : 'spigot';
    const folder = path.join(this.serverDir(id), this._pluginFolder(meta));
    fs.mkdirSync(folder, { recursive: true });
    const fileName = `Geyser-${platform === 'fabric' ? 'Fabric' : 'Spigot'}.jar`;
    const dest = path.join(folder, fileName);

    onProgress({ id, stage: 'Downloading GeyserMC (Bedrock Support)', percent: 10 });
    await this._download(`${GEYSER_URL}/${platform}`, dest, p => {
      onProgress({ id, stage: 'Downloading GeyserMC (Bedrock Support)', percent: 10 + Math.round(p * 0.85) });
    });

    const props = this.readProperties(id).values;
    const cfgPath = this._geyserConfigPath(meta);
    if (!fs.existsSync(cfgPath) && String(props['online-mode']) !== 'true') {
      try {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(
          cfgPath,
          `# Generated by CRYOX CLIENT for Bedrock + Java Crossplay\nbedrock:\n  address: 0.0.0.0\n  port: 19132\n  clone-remote-port: false\n  motd1: "${meta.name}"\n  motd2: "X Bedrock Server"\n  server-name: "${meta.name}"\nremote:\n  address: auto\n  port: ${meta.port || 25565}\n  auth-type: offline\n`,
          'utf8'
        );
      } catch (_) {}
    }

    onProgress({ id, stage: 'Bedrock support ready', percent: 100 });
    return { installed: true, restartNeeded: this.runtime.has(id) };
  }

  _applyGeyserAuth(id, props) {
    try {
      const meta = this._requireMeta(id);
      if (String((props || {})['online-mode']) === 'true') return false;
      const file = this._geyserConfigPath(meta);
      if (!fs.existsSync(file)) return false;
      const yml = fs.readFileSync(file, 'utf8');
      if (/^\s*auth-type:\s*offline\b/m.test(yml)) return false;
      if (!/^\s*auth-type:/m.test(yml)) return false;
      fs.writeFileSync(file, yml.replace(/^(\s*auth-type:\s*)\S+/m, '$1offline'), 'utf8');
      return true;
    } catch (_) { return false; }
  }

  getNetwork(id) {
    const meta = this._requireMeta(id);
    const rt = this.runtime.get(id);
    return {
      port: (rt && rt.port) || meta.port,
      playit: !!meta.playit,
      javaTunnel: meta.javaTunnel === 'bore' ? 'bore' : 'playit',
      bedrock: this.detectBedrock(id)
    };
  }

  // ---------- run ----------
  _isPortFree(port) {
    return new Promise(resolve => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '0.0.0.0');
    });
  }

  _setStatus(id, status) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.status = status;
    this.emit('status', { id, status, players: Array.from(rt.players) });
  }

  _onPlayerJoinedLive(id, playerName) {
    const rt = this.runtime.get(id);
    if (!rt || rt.status !== 'online') return;
    const props = this.readProperties(id).values;

    // 1. Live Online-Mode (Premium Only) check: if online-mode is ON, block offline/cracked accounts immediately!
    if (String(props['online-mode']) === 'true' && this._isPlayerCrackedOrOffline(id, playerName)) {
      try {
        this.sendCommand(id, `kick ${playerName} Failed to verify username! Server is in Online Mode (Premium Only).`, { silent: true });
      } catch (_) {}
      rt.players.delete(playerName);
      this._setStatus(id, rt.status);
      return;
    }

    // 2. Enforce live PvP state when player joins
    if (String(props.pvp) === 'false') {
      try {
        this.sendCommand(id, 'gamerule sendCommandFeedback false', { silent: true });
        this.sendCommand(id, 'gamerule send_command_feedback false', { silent: true });
        this.sendCommand(id, 'gamerule pvp false', { silent: true });
        this.sendCommand(id, 'team add inex_nopvp', { silent: true });
        this.sendCommand(id, 'team modify inex_nopvp friendlyFire false', { silent: true });
        this.sendCommand(id, `team join inex_nopvp ${playerName}`, { silent: true });
      } catch (_) {}
    }

    // 3. Enforce live Gamemode when player joins
    const gm = props.gamemode;
    if (gm && ['survival', 'creative', 'adventure', 'spectator'].includes(gm)) {
      try {
        this.sendCommand(id, 'gamerule sendCommandFeedback false', { silent: true });
        this.sendCommand(id, 'gamerule send_command_feedback false', { silent: true });
        this.sendCommand(id, `gamemode ${gm} ${playerName}`, { silent: true });
      } catch (_) {}
    }
  }

  _parsePlayerEventsFromLine(id, text) {
    try {
      const rt = this.runtime.get(id);
      if (!rt) return false;

      const clean = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9A-FK-ORa-fk-or]/g, '');

      // Track player UUID from authenticator log: "UUID of player PlayerName is xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      const uuidMatch = clean.match(/UUID of player\s+([A-Za-z0-9_.\-]{1,32})\s+is\s+([0-9a-fA-F-]{32,36})/i);
      if (uuidMatch && PLAYER_NAME_RE.test(uuidMatch[1])) {
        if (!rt.playerUuids) rt.playerUuids = new Map();
        rt.playerUuids.set(uuidMatch[1].toLowerCase(), uuidMatch[2].toLowerCase());
      }

      const joinMatch = clean.match(/:\s+([A-Za-z0-9_.\-]{1,32})\s+joined the game/i);
      if (joinMatch && PLAYER_NAME_RE.test(joinMatch[1])) {
        const name = joinMatch[1];
        rt.players.add(name);
        this._setStatus(id, rt.status);
        this._onPlayerJoinedLive(id, name);
        return true;
      }

      const loginMatch = clean.match(/:\s+([A-Za-z0-9_.\-]{1,32})\[\/[^\]]+\]\s+logged in with entity id/i);
      if (loginMatch && PLAYER_NAME_RE.test(loginMatch[1])) {
        const name = loginMatch[1];
        rt.players.add(name);
        this._setStatus(id, rt.status);
        this._onPlayerJoinedLive(id, name);
        return true;
      }

      const leftMatch =
        clean.match(/:\s+([A-Za-z0-9_.\-]{1,32})\s+left the game/i) ||
        clean.match(/:\s+([A-Za-z0-9_.\-]{1,32})\s+lost connection:/i);
      if (leftMatch && PLAYER_NAME_RE.test(leftMatch[1])) {
        const target = leftMatch[1].toLowerCase();
        for (const p of Array.from(rt.players)) {
          if (p.toLowerCase() === target) rt.players.delete(p);
        }
        this._setStatus(id, rt.status);
        return true;
      }

      const listMatch = clean.match(/There are\s+(\d+)\s+of a max of\s+\d+\s+players online:(.*)$/i);
      if (listMatch) {
        const count = parseInt(listMatch[1], 10) || 0;
        const namesRaw = (listMatch[2] || '').trim();
        rt.players.clear();
        if (count > 0 && namesRaw) {
          for (const part of namesRaw.split(',')) {
            const n = part.trim().split(/\s+/).pop();
            if (n && PLAYER_NAME_RE.test(n)) rt.players.add(n);
          }
        }
        this._setStatus(id, rt.status);
        return 'list-output';
      }
    } catch (_) {}
    return false;
  }

  _pushLog(id, line, stream = 'out') {
    const rt = this.runtime.get(id);
    if (!rt) return;
    const text = String(line || '').replace(/\x1b\[[0-9;]*m/g, '');

    if (/\]: Done \([0-9.,]+s\)! For help/i.test(text) || /^Done \([0-9.,]+s\)!/i.test(text)) {
      this._setStatus(id, 'online');
      try {
        this.sendCommand(id, 'gamerule sendCommandFeedback false', { silent: true });
        this.sendCommand(id, 'gamerule send_command_feedback false', { silent: true });
      } catch (_) {}
    }

    const geyser = text.match(/Started Geyser on (?:UDP )?port (\d+)/i);
    if (geyser) {
      rt.bedrockPort = parseInt(geyser[1], 10);
      const changed = this._applyGeyserAuth(id, this.readProperties(id).values);
      if (changed) this._pushLog(id, '[X] Geyser was set to offline login for this server. Restart once so Bedrock players can join.', 'sys');
      this.emit('bedrock', { id, port: rt.bedrockPort, needsRestart: changed });
    }

    const parsedKind = this._parsePlayerEventsFromLine(id, text);
    if (parsedKind === 'list-output' && rt.silentListPending && Date.now() - rt.silentListPending < 2500) {
      rt.silentListPending = 0;
      return;
    }

    rt.log.push(text);
    if (rt.log.length > LOG_LIMIT) rt.log.splice(0, rt.log.length - LOG_LIMIT);
    this.emit('log', { id, line: text, stream });
  }

  getLog(id) {
    const log = this.lastLogs.get(id);
    return log ? log.slice() : [];
  }

  async startServer(id, onProgress = () => {}) {
    const meta = this._requireMeta(id);
    const existingRt = this.runtime.get(id);
    if (existingRt) {
      if (existingRt.proc && !existingRt.proc.killed) {
        throw new Error('This server is already running.');
      }
      this.runtime.delete(id);
    }

    const dir = this.serverDir(id);
    if (!fs.existsSync(path.join(dir, 'server.jar'))) throw new Error('server.jar is missing. Delete and re-create the server.');

    for (const [otherId, other] of Array.from(this.runtime.entries())) {
      if (!other.proc || other.proc.killed) {
        this.runtime.delete(otherId);
        this.emit('status', { id: otherId, status: 'offline', players: [] });
      }
    }

    const props = this.readProperties(id).values;
    this._syncFlightHelperAndFlag(id, props);

    const port = parseInt(props['server-port'], 10) || meta.port || 25565;

    for (const [otherId, other] of this.runtime) {
      if (otherId !== id && other.port === port) {
        throw new Error(`Port ${port} is currently used by another running X server. Stop it first or change the port in Properties.`);
      }
    }
    if (!(await this._isPortFree(port))) {
      throw new Error(`Port ${port} is already in use on your PC. Stop the other server or change the port in Properties.`);
    }

    const rt = {
      proc: null,
      status: 'starting',
      players: new Set(),
      playerUuids: new Map(),
      log: [],
      startedAt: Date.now(),
      stopTimer: null,
      exitWaiters: [],
      port,
      stats: [],
      sampler: null,
      bedrockPort: null,
      lastListPoll: 0,
      silentListPending: 0,
      pendingProps: null
    };
    this.runtime.set(id, rt);
    this.lastLogs.set(id, rt.log);
    this._setStatus(id, 'starting');

    try {
      onProgress({ id, stage: `Preparing Java ${meta.javaMajor}`, percent: 0 });
      const res = await this.javaManager.ensureJavaForVersion(meta.javaMajor, 'auto', p => onProgress({ id, ...p }));
      if (!res || !res.runtime) throw new Error(res && res.message ? res.message : `Java ${meta.javaMajor} is required.`);
      const java = res.runtime.path;

      const ram = Math.round(meta.ramMb);
      const args = [`-Xms${Math.min(512, ram)}M`, `-Xmx${ram}M`, '-jar', 'server.jar', 'nogui'];
      this._pushLog(id, `[X] Starting ${meta.loader} ${meta.version} with ${ram} MB RAM on port ${port}`, 'sys');
      this._pushLog(id, `[X] Java: ${java}`, 'sys');

      const proc = spawn(java, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      rt.proc = proc;
      this._applyGeyserAuth(id, props);
      this._startSampler(id, rt);

      const pipe = (stream, kind) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          buf += chunk;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop();
          for (const p of parts) if (p.length) this._pushLog(id, p, kind);
        });
        stream.on('end', () => { if (buf.length) this._pushLog(id, buf, kind); });
      };
      pipe(proc.stdout, 'out');
      pipe(proc.stderr, 'err');
      proc.stdin.on('error', () => {});

      proc.on('error', err => this._pushLog(id, `[X] Could not start Java: ${err.message}`, 'err'));
      proc.on('exit', (code, signal) => {
        if (rt.pendingProps && Object.keys(rt.pendingProps).length) {
          try { this._writeProperties(dir, rt.pendingProps); } catch (_) {}
        }
        this._pushLog(id, `[X] Server stopped (${signal || 'exit code ' + code}).`, 'sys');
        if (rt.stopTimer) clearTimeout(rt.stopTimer);
        if (rt.sampler) rt.sampler.stop();
        const waiters = rt.exitWaiters;
        this.runtime.delete(id);
        this.emit('status', { id, status: 'offline', players: [], exitCode: code });
        this.emit('exit', { id, code, signal, crashed: rt.status !== 'stopping' && code !== 0 });
        waiters.forEach(fn => fn());
      });

      return this._publicState(meta);
    } catch (err) {
      if (rt.sampler) rt.sampler.stop();
      this.runtime.delete(id);
      this.emit('status', { id, status: 'offline', players: [] });
      throw err;
    }
  }

  sendCommand(id, command, { silent = false } = {}) {
    const rt = this.runtime.get(id);
    if (!rt || !rt.proc || !rt.proc.stdin.writable) throw new Error('Server is not running.');
    const cmd = String(command || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cmd) return { sent: false };
    if (silent && cmd.toLowerCase() === 'list') {
      rt.silentListPending = Date.now();
    }
    if (!silent) this._pushLog(id, `> ${cmd}`, 'cmd');
    rt.proc.stdin.write(cmd + '\n');
    return { sent: true };
  }

  stopServer(id, { force = false } = {}) {
    const rt = this.runtime.get(id);
    if (!rt) {
      this.emit('status', { id, status: 'offline', players: [] });
      return Promise.resolve({ stopped: true });
    }
    if (!rt.proc || rt.proc.killed) {
      if (rt.stopTimer) clearTimeout(rt.stopTimer);
      if (rt.sampler) rt.sampler.stop();
      this.runtime.delete(id);
      this.emit('status', { id, status: 'offline', players: [] });
      return Promise.resolve({ stopped: true });
    }
    return new Promise(resolve => {
      rt.exitWaiters.push(() => resolve({ stopped: true }));
      if (force) {
        try { rt.proc.kill('SIGKILL'); } catch (_) { try { rt.proc.kill(); } catch (__) {} }
        return;
      }
      if (rt.status !== 'stopping') {
        this._setStatus(id, 'stopping');
        try { rt.proc.stdin.write('stop\n'); } catch (_) {}
        rt.stopTimer = setTimeout(() => {
          this._pushLog(id, '[X] Server did not stop in time, forcing shutdown.', 'sys');
          try { rt.proc.kill('SIGKILL'); } catch (_) { try { rt.proc.kill(); } catch (__) {} }
        }, 15000);
      }
    });
  }

  async restartServer(id, onProgress) {
    await this.stopServer(id);
    return this.startServer(id, onProgress);
  }

  async stopAll() {
    await Promise.all(Array.from(this.runtime.keys()).map(id => this.stopServer(id)));
  }

  hasRunning() {
    return this.runtime.size > 0;
  }
}

module.exports = { ServerManager, DEFAULT_PROPERTIES };