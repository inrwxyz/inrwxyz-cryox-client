const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspectHudJar, checkHudCompat } = require('./hudJar');

const SUPPORTED_LOADERS = ['vanilla', 'fabric', 'forge'];

const AGENT_JAR_NAMES = ['inex-cosmetics-agent.jar'];

class ProfileManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.profilesFile = path.join(this.settingsManager.getSettings().configDir, 'profiles.json');
    this.hudModsDir = path.join(this.settingsManager.getSettings().configDir, 'hud-mods');
    this.defaultModsDir = path.join(this.settingsManager.getSettings().configDir, 'default-mods');
    try {
      fs.mkdirSync(this.hudModsDir, { recursive: true });
      fs.mkdirSync(this.defaultModsDir, { recursive: true });
    } catch (_) {}
    try {
      const gameDataDir = this.settingsManager.getSettings().gameDataDir;
      const versionsRoot = path.join(gameDataDir, 'versions');
      if (fs.existsSync(versionsRoot)) {
        for (const vDir of fs.readdirSync(versionsRoot)) {
          const legacyEff = path.join(versionsRoot, vDir, 'effective.json');
          if (fs.existsSync(legacyEff)) {
            try { fs.unlinkSync(legacyEff); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    this.state = this._load();
  }

  _getProfilesBaseDir() {
    return path.join(this.settingsManager.getSettings().gameDataDir, 'profiles');
  }

  _ensureProfileDirectories(profile) {
    if (!profile || !profile.gameDir) return;
    const dir = profile.gameDir;
    const subdirs = [
      dir,
      path.join(dir, 'mods'),
      path.join(dir, 'resourcepacks'),
      path.join(dir, 'shaderpacks'),
      path.join(dir, 'datapacks'),
      path.join(dir, 'saves'),
      path.join(dir, 'config'),
      path.join(dir, 'logs')
    ];
    for (const d of subdirs) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch (_) {}
    }
    this.attachDefaultClientMods(profile);
  }

  getHudModsDir() {
    try { fs.mkdirSync(this.hudModsDir, { recursive: true }); } catch (_) {}
    return this.hudModsDir;
  }

  _collectHudJarFiles(mcVersion) {
    const roots = [this.hudModsDir, this.defaultModsDir];
    const appDefaultRoots = [
      path.resolve(__dirname, '..', 'default-mods'),
      path.resolve(__dirname, '..', '..', 'src', 'default-mods'),
      path.resolve(__dirname, '..', '..', '..', 'src', 'default-mods')
    ];
    for (const dir of appDefaultRoots) {
      if (dir && !roots.includes(dir)) roots.push(dir);
    }

    const dirs = [];
    for (const root of roots) {
      if (!root) continue;
      dirs.push(root);
      if (mcVersion) dirs.push(path.join(root, String(mcVersion)));
    }

    const files = [];
    const seen = new Set();
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.toLowerCase().endsWith('.jar')) continue;
          if (AGENT_JAR_NAMES.includes(entry.toLowerCase())) continue;
          const full = path.join(dir, entry);
          if (!fs.statSync(full).isFile()) continue;
          const key = `${dir}:${entry}`;
          if (seen.has(key)) continue;
          seen.add(key);
          files.push({ fileName: entry, fullPath: full });
        }
      } catch (_) {}
    }
    return files;
  }

  listHudJars(profile = null) {
    const loader = profile ? profile.loader : null;
    const version = profile ? profile.version : null;
    return this._collectHudJarFiles(version).map(f => {
      const info = inspectHudJar(f.fullPath);
      const compat = profile ? checkHudCompat(info, loader, version) : { ok: Boolean(info.kind), reason: info.error || '' };
      return {
        fileName: f.fileName,
        kind: info.kind,
        mcRange: info.mcRange || null,
        supported: compat.ok,
        reason: compat.reason
      };
    });
  }

  attachDefaultClientMods(profile) {
    this.lastHudSkipped = [];
    if (!profile || !profile.gameDir) return [];

    const modsDir = path.join(profile.gameDir, 'mods');
    const configDir = path.join(profile.gameDir, 'config');
    const trackFile = path.join(profile.gameDir, 'inex-hud-attached.json');
    try {
      fs.mkdirSync(modsDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
    } catch (_) {
      return [];
    }

    for (const legacy of AGENT_JAR_NAMES) {
      try {
        const p = path.join(modsDir, legacy);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }

    const hudConfigPath = path.join(configDir, 'inex-hud.json');
    try {
      if (fs.existsSync(hudConfigPath)) fs.unlinkSync(hudConfigPath);
    } catch (_) {}

    let tracked = [];
    try {
      if (fs.existsSync(trackFile)) tracked = JSON.parse(fs.readFileSync(trackFile, 'utf8')).files || [];
    } catch (_) {}

    const attached = [];
    const enabled = profile.loader !== 'vanilla' && profile.hudEnabled !== false;
    const chosenJar = String((this.settingsManager.getSettings().activeHudJar) || '');
    const wanted = chosenJar === '__none__' ? [] : null;

    if (enabled && !(wanted && wanted.length === 0)) {
      for (const f of this._collectHudJarFiles(profile.version)) {
        if (chosenJar && chosenJar !== '__none__' && f.fileName !== chosenJar) continue;
        const info = inspectHudJar(f.fullPath);
        const compat = checkHudCompat(info, profile.loader, profile.version);
        const sourceIsDefaultMod = [this.defaultModsDir, path.resolve(__dirname, '..', 'default-mods'), path.resolve(__dirname, '..', '..', 'src', 'default-mods')]
          .some(root => f.fullPath.startsWith(String(root))) || path.basename(f.fullPath).includes('inex-client-hud');
        if (!compat.ok && !sourceIsDefaultMod) {
          this.lastHudSkipped.push({ fileName: f.fileName, reason: compat.reason });
          continue;
        }
        try {
          const dest = path.join(modsDir, f.fileName);
          const srcSize = fs.statSync(f.fullPath).size;
          if (!fs.existsSync(dest) || fs.statSync(dest).size !== srcSize) {
            fs.copyFileSync(f.fullPath, dest);
          }
          if (!attached.includes(f.fileName)) attached.push(f.fileName);
        } catch (err) {
          this.lastHudSkipped.push({ fileName: f.fileName, reason: err.message });
        }
      }
    }

    for (const old of tracked) {
      if (attached.includes(old)) continue;
      try {
        const p = path.join(modsDir, old);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }

    try {
      fs.writeFileSync(trackFile, JSON.stringify({ files: attached }, null, 2), 'utf8');
      if (attached.length || profile.loader !== 'vanilla') {
        const hudJson = {
          showNametagLogo: true,
          activeHudJar: attached[0] || chosenJar || '',
          attachedFiles: attached
        };
        fs.writeFileSync(hudConfigPath, JSON.stringify(hudJson, null, 2), 'utf8');
      }
    } catch (_) {}
    return attached;
  }

  _slugify(name) {
    return String(name || 'profile')
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile';
  }

  _load() {
    try {
      if (fs.existsSync(this.profilesFile)) {
        const raw = fs.readFileSync(this.profilesFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.profiles)) {
          const userProfiles = parsed.profiles;
          for (const p of userProfiles) {
            this._ensureProfileDirectories(p);
            p.installed = this.verifyInstallationState(p);
          }
          const activeExists = userProfiles.some(p => p.id === parsed.activeProfileId);
          const nextState = {
            activeProfileId: activeExists ? parsed.activeProfileId : userProfiles[0] ? userProfiles[0].id : null,
            profiles: userProfiles
          };
          return nextState;
        }
      }
    } catch (err) {}

    const emptyState = { activeProfileId: null, profiles: [] };
    this._save(emptyState);
    return emptyState;
  }

  _save(state = this.state) {
    try {
      fs.mkdirSync(path.dirname(this.profilesFile), { recursive: true });
      const tmp = `${this.profilesFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.profilesFile);
    } catch (err) {}
  }

  verifyInstallationState(profile) {
    if (!profile || !profile.version) return false;
    const gameDataDir = this.settingsManager.getSettings().gameDataDir;
    const versionDir = path.join(gameDataDir, 'versions', profile.version);
    const clientJar = path.join(versionDir, `${profile.version}.jar`);
    const versionJson = path.join(versionDir, `${profile.version}.json`);

    if (!fs.existsSync(clientJar) || !fs.existsSync(versionJson)) return false;

    try {
      if (fs.statSync(clientJar).size < 1024) return false;
    } catch (_) { return false; }

    const effectiveMetaPath = path.join(versionDir, `effective-${profile.loader || 'vanilla'}.json`);
    if (profile.loader && profile.loader !== 'vanilla') {
      const loaderMarker = path.join(versionDir, `loader-${profile.loader}.json`);
      if (!fs.existsSync(loaderMarker) || !fs.existsSync(effectiveMetaPath)) return false;
      try {
        const eff = JSON.parse(fs.readFileSync(effectiveMetaPath, 'utf8'));
        const mc = String(eff.mainClass || '');
        if (!mc || mc === 'net.minecraft.client.main.Main') return false;
        if (profile.loader === 'fabric' && !mc.includes('fabricmc')) return false;
        if (profile.loader === 'forge' && mc.includes('fabricmc')) return false;
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  getContentCounts(profile) {
    const counts = { mods: 0, resourcepacks: 0, shaderpacks: 0, datapacks: 0 };
    if (!profile || !profile.gameDir) return counts;
    const checkDir = (sub, exts) => {
      const full = path.join(profile.gameDir, sub);
      if (!fs.existsSync(full)) return 0;
      try {
        return fs.readdirSync(full).filter(f => exts.some(ext => f.toLowerCase().endsWith(ext))).length;
      } catch (_) { return 0; }
    };
    counts.mods = profile.loader === 'vanilla' ? 0 : checkDir('mods', ['.jar', '.jar.disabled']);
    counts.resourcepacks = checkDir('resourcepacks', ['.zip']);
    counts.shaderpacks = checkDir('shaderpacks', ['.zip']);
    counts.datapacks = checkDir('datapacks', ['.zip']);
    return counts;
  }

  listProfiles() {
    for (const p of this.state.profiles) {
      p.installed = this.verifyInstallationState(p);
      p.contentCounts = this.getContentCounts(p);
    }
    return {
      activeProfileId: this.state.activeProfileId,
      profiles: this.state.profiles.map(p => ({ ...p }))
    };
  }

  getActiveProfile() {
    if (!this.state.profiles.length) return null;
    const found = this.state.profiles.find(p => p.id === this.state.activeProfileId) || this.state.profiles[0] || null;
    if (found) {
      found.installed = this.verifyInstallationState(found);
      found.contentCounts = this.getContentCounts(found);
    }
    return found ? { ...found } : null;
  }

  getProfileById(id) {
    const found = this.state.profiles.find(p => p.id === id);
    if (!found) return null;
    found.installed = this.verifyInstallationState(found);
    found.contentCounts = this.getContentCounts(found);
    return { ...found };
  }

  setActiveProfile(id) {
    const found = this.state.profiles.find(p => p.id === id);
    if (!found) throw new Error(`Profile not found: ${id}`);
    this.state.activeProfileId = found.id;
    this._save();
    return this.listProfiles();
  }

  createProfile(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Profile configuration is required.');
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Profile name cannot be empty.');
    const version = String(payload.version || '').trim();
    if (!version) throw new Error('Minecraft version is required.');
    const loader = String(payload.loader || 'vanilla').toLowerCase();
    if (!SUPPORTED_LOADERS.includes(loader)) throw new Error(`Unsupported mod loader: ${loader}`);

    const maxRam = this.settingsManager.getSettings().maxRamMB || 16384;
    const rawRam = Number(payload.ramMB || this.settingsManager.getSettings().defaultRamMB || 4096);
    const ramMB = Number.isFinite(rawRam) ? Math.max(1024, Math.min(maxRam, Math.round(rawRam / 256) * 256)) : 4096;

    const id = `${this._slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const gameDir = payload.gameDir && String(payload.gameDir).trim()
      ? path.resolve(String(payload.gameDir).trim())
      : path.join(this._getProfilesBaseDir(), id);

    const newProfile = {
      id, name, version, loader,
      loaderVersion: loader === 'vanilla' ? 'official' : String(payload.loaderVersion || 'latest').trim(),
      javaRuntime: String(payload.javaRuntime || 'auto').trim(),
      ramMB, gameDir, installed: false,
      createdAt: new Date().toISOString(), lastPlayed: null,
      modpackInfo: loader === 'vanilla' ? null : (payload.modpackInfo || null),
      hudEnabled: loader !== 'vanilla' && payload.hudEnabled !== false,
      // Performance Pack: Fabric only, decided once at creation (no toggle afterwards), never for modpack profiles.
      perfPackEnabled: loader === 'fabric' && payload.perfPack !== false && !payload.modpackInfo
    };

    newProfile.installed = this.verifyInstallationState(newProfile);
    this._ensureProfileDirectories(newProfile);

    this.state.profiles.unshift(newProfile);
    this.state.activeProfileId = newProfile.id;
    this._save();
    return {
      profile: { ...newProfile, contentCounts: this.getContentCounts(newProfile) },
      state: this.listProfiles()
    };
  }

  updateProfile(id, updates) {
    const idx = this.state.profiles.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`Profile not found: ${id}`);
    const current = this.state.profiles[idx];

    if (updates.name !== undefined) {
      const trimmed = String(updates.name).trim();
      if (!trimmed) throw new Error('Profile name cannot be empty.');
      current.name = trimmed;
    }
    if (updates.version !== undefined && String(updates.version).trim()) {
      current.version = String(updates.version).trim();
    }
    if (updates.loader !== undefined) {
      const l = String(updates.loader).toLowerCase();
      if (!SUPPORTED_LOADERS.includes(l)) throw new Error(`Unsupported loader: ${l}`);
      current.loader = l;
      if (l === 'vanilla') { current.modpackInfo = null; current.hudEnabled = false; }
    }
    if (updates.loaderVersion !== undefined) current.loaderVersion = String(updates.loaderVersion).trim() || 'latest';
    if (updates.javaRuntime !== undefined) current.javaRuntime = String(updates.javaRuntime).trim() || 'auto';
    if (updates.hudEnabled !== undefined) current.hudEnabled = current.loader !== 'vanilla' && Boolean(updates.hudEnabled);
    if (updates.ramMB !== undefined) {
      const maxRam = this.settingsManager.getSettings().maxRamMB || 16384;
      const rawRam = Number(updates.ramMB);
      if (Number.isFinite(rawRam)) {
        current.ramMB = Math.max(1024, Math.min(maxRam, Math.round(rawRam / 256) * 256));
      }
    }
    if (updates.lastPlayed !== undefined) current.lastPlayed = updates.lastPlayed;
    if (updates.modpackInfo !== undefined) current.modpackInfo = current.loader === 'vanilla' ? null : updates.modpackInfo;

    current.installed = this.verifyInstallationState(current);
    this._ensureProfileDirectories(current);
    this._save();

    return {
      profile: { ...current, contentCounts: this.getContentCounts(current) },
      state: this.listProfiles()
    };
  }

  deleteProfile(id) {
    const idx = this.state.profiles.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`Profile not found: ${id}`);
    const removed = this.state.profiles.splice(idx, 1)[0];
    if (this.state.activeProfileId === removed.id) {
      this.state.activeProfileId = this.state.profiles[0] ? this.state.profiles[0].id : null;
    }
    this._save();
    return this.listProfiles();
  }
}

module.exports = { ProfileManager, SUPPORTED_LOADERS };