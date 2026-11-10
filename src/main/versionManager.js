const fs = require('fs');
const path = require('path');

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const FALLBACK_VERSIONS = [
  { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:12:57+00:00', url: 'https://piston-meta.mojang.com/v1/packages/a3bc74f63222b233c5d4c55b52809822d0b443e0/1.21.4.json', javaVersion: 21 },
  { id: '1.21.3', type: 'release', releaseTime: '2024-10-23T13:18:09+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.21.3.json', javaVersion: 21 },
  { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.21.1.json', javaVersion: 21 },
  { id: '1.21', type: 'release', releaseTime: '2024-06-13T08:32:38+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.21.json', javaVersion: 21 },
  { id: '1.20.6', type: 'release', releaseTime: '2024-04-29T12:14:20+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.20.6.json', javaVersion: 21 },
  { id: '1.20.4', type: 'release', releaseTime: '2023-12-07T12:56:20+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.20.4.json', javaVersion: 17 },
  { id: '1.20.2', type: 'release', releaseTime: '2023-09-21T09:35:30+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.20.2.json', javaVersion: 17 },
  { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T13:25:11+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.20.1.json', javaVersion: 17 },
  { id: '1.19.4', type: 'release', releaseTime: '2023-03-14T12:56:18+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.19.4.json', javaVersion: 17 },
  { id: '1.19.2', type: 'release', releaseTime: '2022-08-05T11:57:05+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.19.2.json', javaVersion: 17 },
  { id: '1.18.2', type: 'release', releaseTime: '2022-02-28T10:48:16+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.18.2.json', javaVersion: 17 },
  { id: '1.17.1', type: 'release', releaseTime: '2021-07-06T12:04:40+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.17.1.json', javaVersion: 16 },
  { id: '1.16.5', type: 'release', releaseTime: '2021-01-15T16:05:32+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.16.5.json', javaVersion: 8 },
  { id: '1.12.2', type: 'release', releaseTime: '2017-09-18T08:39:46+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.12.2.json', javaVersion: 8 },
  { id: '1.8.9', type: 'release', releaseTime: '2015-12-09T09:24:39+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.8.9.json', javaVersion: 8 },
  { id: '1.7.10', type: 'release', releaseTime: '2014-05-14T17:29:23+00:00', url: 'https://piston-meta.mojang.com/v1/packages/1.7.10.json', javaVersion: 8 }
];

class VersionManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.manifestCachePath = path.join(this.settingsManager.getSettings().configDir, 'cache', 'version_manifest_v2.json');
    this.cachedManifest = null;
  }

  getRequiredJavaMajor(mcVersion, versionMeta = null) {
    if (versionMeta && versionMeta.javaVersion && Number.isFinite(Number(versionMeta.javaVersion.majorVersion))) {
      return Number(versionMeta.javaVersion.majorVersion);
    }
    const v = String(mcVersion || '').trim();
    // Old Alpha / Beta / Classic / Infdev / pre-classic builds (a1.2.6, b1.7.3, c0.30_01c, inf-2010..., rd-132211)
    if (/^(?:[abc]\d|rd-|inf-)/i.test(v)) return 8;
    const parts = v.split('.').map(n => parseInt(n, 10));
    if (parts[0] === 1) {
      const minor = parts[1] || 0;
      const patch = parts[2] || 0;
      if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
      if (minor >= 18) return 17;
      if (minor === 17) return 16;
      return 8;
    }
    // Modern Mojang year-based versioning (e.g. 26.1, 26.2, 26.3) or snapshots
    if (parts[0] >= 26 || /^2[6-9]w/i.test(v)) return 25;
    return 21;
  }

  async getVersionManifest(forceRefresh = false) {
    if (!forceRefresh && this.cachedManifest) {
      return this.cachedManifest;
    }

    if (!forceRefresh && fs.existsSync(this.manifestCachePath)) {
      try {
        const stat = fs.statSync(this.manifestCachePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 6 * 60 * 60 * 1000) {
          const parsed = JSON.parse(fs.readFileSync(this.manifestCachePath, 'utf8'));
          if (parsed && Array.isArray(parsed.versions)) {
            this.cachedManifest = parsed;
            return parsed;
          }
        }
      } catch (_) {}
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(MOJANG_MANIFEST_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Mojang manifest HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && Array.isArray(data.versions)) {
        fs.mkdirSync(path.dirname(this.manifestCachePath), { recursive: true });
        fs.writeFileSync(this.manifestCachePath, JSON.stringify(data, null, 2), 'utf8');
        this.cachedManifest = data;
        return data;
      }
    } catch (err) {
      if (fs.existsSync(this.manifestCachePath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.manifestCachePath, 'utf8'));
          if (parsed && Array.isArray(parsed.versions)) {
            this.cachedManifest = parsed;
            return { ...parsed, offlineCache: true };
          }
        } catch (_) {}
      }
      return {
        latest: { release: FALLBACK_VERSIONS[0].id, snapshot: FALLBACK_VERSIONS[0].id },
        versions: FALLBACK_VERSIONS,
        offlineFallback: true,
        error: err.message
      };
    }
  }

  async listVersions({ includeSnapshots = false, forceRefresh = false } = {}) {
    const manifest = await this.getVersionManifest(forceRefresh);
    const showSnaps = includeSnapshots || this.settingsManager.getSettings().showSnapshots;
    const filtered = (manifest.versions || [])
      .filter(v => {
        if (v.type === 'release') return true;
        if (showSnaps && v.type === 'snapshot') return true;
        // Old Beta / Old Alpha versions are always listed
        if (v.type === 'old_beta' || v.type === 'old_alpha') return true;
        return false;
      })
      .map(v => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
        url: v.url,
        sha1: v.sha1 || null,
        requiredJava: this.getRequiredJavaMajor(v.id)
      }));

    const firstRelease = filtered.find(v => v.type === 'release');
    return {
      latest: manifest.latest || { release: firstRelease ? firstRelease.id : null },
      offline: Boolean(manifest.offlineFallback || manifest.offlineCache),
      versions: filtered
    };
  }

  async resolveVersionMetadata(versionId) {
    const gameDataDir = this.settingsManager.getSettings().gameDataDir;
    const versionDir = path.join(gameDataDir, 'versions', versionId);
    const localJsonPath = path.join(versionDir, `${versionId}.json`);

    if (fs.existsSync(localJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
        if (parsed && parsed.id === versionId && parsed.downloads) {
          return parsed;
        }
      } catch (_) {}
    }

    let manifest = await this.getVersionManifest(false);
    let entry = (manifest.versions || []).find(v => v.id === versionId);
    if (!entry || !entry.url) {
      manifest = await this.getVersionManifest(true);
      entry = (manifest.versions || []).find(v => v.id === versionId);
    }
    if (!entry || !entry.url) {
      throw new Error(`Minecraft version "${versionId}" was not found in the official Mojang version manifest.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(entry.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Failed to fetch version metadata for ${versionId} (HTTP ${res.status})`);
    }
    const meta = await res.json();
    meta.id = versionId; // Ensure id matches requested version
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(localJsonPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }
}

module.exports = { VersionManager, MOJANG_MANIFEST_URL, FALLBACK_VERSIONS };
