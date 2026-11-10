const fs = require('fs');
const path = require('path');
const { parseZipBuffer, validateSafeRelativePath } = require('./zipUtils');

const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2';
const FORGE_PROMOS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net';
const FORGE_MAVEN_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const JOPT_SIMPLE_COORD = 'net.sf.jopt-simple:jopt-simple:5.0.4';

class LoaderManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.cacheDir = path.join(this.settingsManager.getSettings().configDir, 'cache', 'loaders');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  isValidLoaderMainClass(loader, mainClass) {
    const l = String(loader || 'vanilla').toLowerCase();
    const mc = String(mainClass || '');
    if (!mc) return false;
    if (l === 'vanilla') return mc === 'net.minecraft.client.main.Main';
    if (l === 'fabric') return mc.includes('fabricmc');
    if (l === 'forge') {
      return mc === 'cpw.mods.bootstraplauncher.BootstrapLauncher' || (!mc.includes('fabricmc') && mc !== 'net.minecraft.client.main.Main');
    }
    if (l === 'neoforge') return mc.includes('neoforged') || mc.includes('knot');
    if (l === 'quilt') return mc.includes('quiltmc') || mc.includes('knot');
    return true;
  }

  // Used to hard-block every Minecraft 26+ version. That is wrong: Fabric (and NeoForge) publish loaders for 26.x.
  // Now the loader's own API (Fabric meta / Forge promos) decides; an empty answer shows "not available".
  _supportsLoaderVersion(version, loader) {
    return true;
  }

  async getSupportedLoadersForVersion(mcVersion) {
    const version = String(mcVersion || '1.21.4').trim();

    const [fabricList, forgeList, neoforgeList, quiltList] = await Promise.all([
      this._supportsLoaderVersion(version, 'fabric') ? this.getFabricLoaderVersions(version).catch(() => []) : Promise.resolve([]),
      this._supportsLoaderVersion(version, 'forge') ? this.getForgeLoaderVersions(version).catch(() => []) : Promise.resolve([]),
      this._supportsLoaderVersion(version, 'neoforge') ? this.getNeoForgeLoaderVersions(version).catch(() => []) : Promise.resolve([]),
      this._supportsLoaderVersion(version, 'quilt') ? this.getQuiltLoaderVersions(version).catch(() => []) : Promise.resolve([])
    ]);

    return {
      vanilla: {
        supported: true,
        versions: [{ version: 'official', stable: true, label: 'Official Mojang Release' }]
      },
      fabric: {
        supported: fabricList.length > 0,
        versions: fabricList.length > 0 ? fabricList : [{ version: 'none', stable: false, label: 'Not Available for ' + version }]
      },
      forge: {
        supported: forgeList.length > 0,
        versions: forgeList.length > 0 ? forgeList : [{ version: 'none', stable: false, label: 'Not Available for ' + version }]
      },
      neoforge: {
        supported: neoforgeList.length > 0,
        versions: neoforgeList.length > 0 ? neoforgeList : [{ version: 'none', stable: false, label: 'Not Available for ' + version }]
      },
      quilt: {
        supported: quiltList.length > 0,
        versions: quiltList.length > 0 ? quiltList : [{ version: 'none', stable: false, label: 'Not Available for ' + version }]
      }
    };
  }

  async getFabricLoaderVersions(mcVersion) {
    const version = String(mcVersion || '').trim();
    if (!this._supportsLoaderVersion(version, 'fabric')) return [];
    try {
      const url = `${FABRIC_META_BASE}/versions/loader/${encodeURIComponent(version)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' } });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return data.slice(0, 15).map((item, idx) => ({
            version: item.loader.version,
            stable: Boolean(item.loader.stable),
            label: idx === 0 ? `${item.loader.version} (latest)` : item.loader.version
          }));
        }
      }
    } catch (_) {}
    return [];
  }

  async getForgeLoaderVersions(mcVersion) {
    const version = String(mcVersion || '').trim();
    if (!this._supportsLoaderVersion(version, 'forge')) return [];
    try {
      const res = await fetch(FORGE_PROMOS_URL, { headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' } });
      if (res.ok) {
        const data = await res.json();
        const promos = (data && data.promos) || {};
        const recommended = promos[`${version}-recommended`];
        const latest = promos[`${version}-latest`];
        const result = [];
        if (recommended) {
          result.push({ version: recommended, stable: true, label: `${recommended} (recommended)` });
        }
        if (latest && latest !== recommended) {
          result.push({ version: latest, stable: false, label: `${latest} (latest)` });
        }
        if (result.length > 0) return result;
      }
    } catch (_) {}

    // Fallback: read EVERY published build from Forge's maven-metadata.xml (works even if no "recommended/latest" promo exists yet)
    try {
      const res = await fetch(FORGE_MAVEN_METADATA_URL, { headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' } });
      if (res.ok) {
        const xml = await res.text();
        const prefix = `${version}-`;
        const builds = [];
        const re = /<version>([^<]+)<\/version>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
          if (m[1].startsWith(prefix)) builds.push(m[1].slice(prefix.length));
        }
        if (builds.length > 0) {
          const cmpBuild = (a, b) => {
            const pa = a.split(/[.\-]/).map(n => parseInt(n, 10) || 0);
            const pb = b.split(/[.\-]/).map(n => parseInt(n, 10) || 0);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
              if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
            }
            return 0;
          };
          builds.sort(cmpBuild); // newest first
          return builds.slice(0, 10).map((b, idx) => ({
            version: b,
            stable: idx === 0,
            label: idx === 0 ? `${b} (latest)` : b
          }));
        }
      }
    } catch (_) {}
    return [];
  }

  async getNeoForgeLoaderVersions(mcVersion) {
    const version = String(mcVersion || '').trim();
    if (!this._supportsLoaderVersion(version, 'neoforge')) return [];

    const major = Number(String(version).split(/[.-]/)[0]);
    if (Number.isFinite(major) && major >= 26) return [];
    if (/^1\.(?:20|21|22|23|24)/.test(version)) {
      return [{ version: 'latest', stable: true, label: 'latest' }];
    }
    return [];
  }

  async getQuiltLoaderVersions(mcVersion) {
    const version = String(mcVersion || '').trim();
    if (!this._supportsLoaderVersion(version, 'quilt')) return [];
    const major = Number(String(version).split(/[.-]/)[0]);
    if (Number.isFinite(major) && major >= 26) return [];
    if (/^1\.(?:20|21|22|23|24)/.test(version)) {
      return [{ version: 'latest', stable: true, label: 'latest' }];
    }
    return [];
  }

  mavenCoordToPath(coord) {
    const raw = String(coord || '').trim();
    if (!raw) return null;
    const [coordPart, extOverride] = raw.split('@');
    const ext = extOverride || 'jar';
    const parts = coordPart.split(':');
    if (parts.length < 3) return null;
    const [group, artifact, version, classifier] = parts;
    const groupPath = group.replace(/\./g, '/');
    const fileName = classifier
      ? `${artifact}-${version}-${classifier}.${ext}`
      : `${artifact}-${version}.${ext}`;
    return `${groupPath}/${artifact}/${version}/${fileName}`;
  }

  async _downloadAndExtractForgeInstaller(mcVersion, loaderVersion) {
    const gameDataDir = this.settingsManager.getSettings().gameDataDir;
    const librariesDir = path.join(gameDataDir, 'libraries');
    fs.mkdirSync(librariesDir, { recursive: true });

    let resolvedBuild = loaderVersion;
    if (!resolvedBuild || resolvedBuild === 'latest' || resolvedBuild.endsWith('-recommended')) {
      const list = await this.getForgeLoaderVersions(mcVersion);
      if (list.length > 0) {
        resolvedBuild = list[0].version;
      }
    }

    if (!resolvedBuild || resolvedBuild === 'latest') {
      throw new Error(`Forge is not available for Minecraft ${mcVersion}. Please select a compatible version or use Vanilla.`);
    }
    
    const fullCoordVer = resolvedBuild.startsWith(`${mcVersion}-`) ? resolvedBuild : `${mcVersion}-${resolvedBuild}`;
    const installerFileName = `forge-${fullCoordVer}-installer.jar`;
    const cachedInstaller = path.join(this.cacheDir, installerFileName);
    const installerUrl = `${FORGE_MAVEN_BASE}/net/minecraftforge/forge/${fullCoordVer}/${installerFileName}`;

    if (!fs.existsSync(cachedInstaller) || fs.statSync(cachedInstaller).size < 10000) {
      const res = await fetch(installerUrl, { headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' }, redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`Failed to download official Forge installer (${installerUrl}): HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(cachedInstaller, buf);
    }

    return this._extractForgeStyleInstallerJar(cachedInstaller, librariesDir, mcVersion, 'forge', fullCoordVer);
  }

  _extractForgeStyleInstallerJar(installerJarPath, librariesDir, mcVersion, normalizedLoader, resolvedBuild) {
    const zipBuf = fs.readFileSync(installerJarPath);
    const entries = parseZipBuffer(zipBuf);

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (entry.name.startsWith('maven/')) {
        const rel = entry.name.slice('maven/'.length);
        if (!rel) continue;
        const safeDest = validateSafeRelativePath(rel, librariesDir);
        fs.mkdirSync(path.dirname(safeDest), { recursive: true });
        fs.writeFileSync(safeDest, entry.extractBuffer());
      }
    }

    const versionEntry = entries.find(e => e.name === 'version.json');
    const installProfileEntry = entries.find(e => e.name === 'install_profile.json');

    let versionJson = null;
    let installProfileJson = null;

    if (versionEntry) {
      versionJson = JSON.parse(versionEntry.extractBuffer().toString('utf8'));
    }
    if (installProfileEntry) {
      installProfileJson = JSON.parse(installProfileEntry.extractBuffer().toString('utf8'));
      if (!versionJson && installProfileJson.versionInfo) {
        versionJson = installProfileJson.versionInfo;
      }
    }

    if (!versionJson) {
      throw new Error(`Official ${normalizedLoader} installer JAR did not contain version.json metadata.`);
    }

    // IMPORTANT: install_profile.json "libraries" are tools for the Forge INSTALLER processors (e.g. jopt-simple 6.0-alpha-3,
    // installertools, jarsplitter ...). They must NOT be put on the game classpath: they shadow the real runtime libraries
    // (-> "Module jopt.simple not found, required by cpw.mods.modlauncher"). The official launcher only uses version.json libraries.
    versionJson.libraries = [...(versionJson.libraries || [])];
    versionJson._installerLibraries = (installProfileJson && Array.isArray(installProfileJson.libraries)) ? installProfileJson.libraries : [];
    versionJson._inexRev = 4;
    versionJson._installerJarPath = installerJarPath;
    versionJson._hasProcessors = Boolean(installProfileJson && Array.isArray(installProfileJson.processors) && installProfileJson.processors.length > 0);
    versionJson.loader = normalizedLoader;

    const gameDataDir = this.settingsManager.getSettings().gameDataDir;
    const versionId = versionJson.id || `${mcVersion}-${normalizedLoader}-${resolvedBuild}`;
    const targetVerDir = path.join(gameDataDir, 'versions', versionId);
    fs.mkdirSync(targetVerDir, { recursive: true });
    fs.writeFileSync(path.join(targetVerDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2), 'utf8');

    return versionJson;
  }

  async resolveLoaderProfile(mcVersion, loader, loaderVersion = 'latest') {
    const normalizedLoader = String(loader || 'vanilla').toLowerCase();
    if (normalizedLoader === 'vanilla') {
      return null;
    }
    if (!this._supportsLoaderVersion(String(mcVersion || ''), normalizedLoader)) {
      throw new Error(`${normalizedLoader.charAt(0).toUpperCase() + normalizedLoader.slice(1)} is not available for Minecraft ${mcVersion}. Please select a compatible version or use Vanilla.`);
    }

    if (normalizedLoader === 'fabric') {
      const list = await this.getFabricLoaderVersions(mcVersion);
      if (list.length === 0) {
        throw new Error(`Fabric is not available for Minecraft ${mcVersion}. Please select a compatible version or use Vanilla.`);
      }
      let resolvedVer = loaderVersion;
      if (!resolvedVer || resolvedVer === 'latest') {
        resolvedVer = list[0].version; // Hardcoded 0.16.10 removed, purely dynamic now
      }
      const cached = path.join(this.cacheDir, `fabric-${mcVersion}-${resolvedVer}.json`);
      const url = `${FABRIC_META_BASE}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(resolvedVer)}/profile/json`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' } });
        if (res.ok) {
          const json = await res.json();
          fs.writeFileSync(cached, JSON.stringify(json, null, 2), 'utf8');
          return json;
        }
      } catch (_) {}
      if (fs.existsSync(cached)) {
        return JSON.parse(fs.readFileSync(cached, 'utf8'));
      }
      return {
        id: `fabric-loader-${resolvedVer}-${mcVersion}`,
        inheritsFrom: mcVersion,
        mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
        libraries: [
          { name: `net.fabricmc:fabric-loader:${resolvedVer}`, url: 'https://maven.fabricmc.net/' },
          { name: `net.fabricmc:intermediary:${mcVersion}`, url: 'https://maven.fabricmc.net/' },
          { name: 'net.fabricmc:sponge-mixin:0.15.4+mixin.0.8.7', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm-analysis:9.7.1', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm-commons:9.7.1', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm-tree:9.7.1', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm-util:9.7.1', url: 'https://maven.fabricmc.net/' }
        ]
      };
    }

    if (normalizedLoader === 'forge') {
      const gameDataDir = this.settingsManager.getSettings().gameDataDir;
      const versionsRoot = path.join(gameDataDir, 'versions');
      if (fs.existsSync(versionsRoot)) {
        try {
          const dirs = fs.readdirSync(versionsRoot);
          for (const d of dirs) {
            const lowerD = d.toLowerCase();
            const matchesLoader = lowerD.includes('forge') && !lowerD.includes('neoforge');
            const wantsBuild = loaderVersion && loaderVersion !== 'latest' && !String(loaderVersion).endsWith('-recommended');
            if (d.startsWith(`${mcVersion}-`) && matchesLoader && (!wantsBuild || d.includes(String(loaderVersion)))) {
              const jsonPath = path.join(versionsRoot, d, `${d}.json`);
              if (fs.existsSync(jsonPath)) {
                const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                if ((parsed._inexRev || 0) >= 4 && this.isValidLoaderMainClass(normalizedLoader, parsed.mainClass)) {
                  return parsed;
                }
              }
            }
          }
        } catch (_) {}
      }

      return await this._downloadAndExtractForgeInstaller(mcVersion, loaderVersion);
    }

    if (normalizedLoader === 'neoforge') {
      if (!this._supportsLoaderVersion(String(mcVersion || ''), 'neoforge')) {
        throw new Error(`NeoForge is not available for Minecraft ${mcVersion}. Please select a compatible version or use Vanilla.`);
      }
      return {
        id: `neoforge-${mcVersion}`,
        inheritsFrom: mcVersion,
        mainClass: 'net.neoforged.loader.launch.knot.KnotClient',
        libraries: []
      };
    }

    if (normalizedLoader === 'quilt') {
      if (!this._supportsLoaderVersion(String(mcVersion || ''), 'quilt')) {
        throw new Error(`Quilt is not available for Minecraft ${mcVersion}. Please select a compatible version or use Vanilla.`);
      }
      return {
        id: `quilt-${mcVersion}`,
        inheritsFrom: mcVersion,
        mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
        libraries: []
      };
    }

    return null;
  }

  mergeWithVanillaMetadata(vanillaMeta, loaderMeta) {
    if (!loaderMeta) return vanillaMeta;
    const merged = JSON.parse(JSON.stringify(vanillaMeta));

    if (loaderMeta.mainClass) {
      merged.mainClass = loaderMeta.mainClass;
    }
    if (loaderMeta.minecraftArguments) {
      merged.minecraftArguments = loaderMeta.minecraftArguments;
    }

    const defaultMavenBase = (loaderMeta.id && String(loaderMeta.id).toLowerCase().includes('forge'))
      ? FORGE_MAVEN_BASE
      : 'https://maven.fabricmc.net';

    const extraLibraries = (loaderMeta.libraries || []).map(lib => {
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) return lib;
      // url === '' means "generated by the installer processors" (forge client/srg/extra/slim jars) - nothing to download
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url === '' && lib.downloads.artifact.path) return lib;
      const relPath = (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path)
        || this.mavenCoordToPath(lib.name);
      const baseUrl = (lib.url || defaultMavenBase).replace(/\/+$/, '');
      return {
        name: lib.name,
        downloads: relPath
          ? {
              artifact: {
                path: relPath,
                url: `${baseUrl}/${relPath}`,
                sha1: (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.sha1) || lib.sha1 || null,
                size: (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.size) || lib.size || 0
              }
            }
          : undefined
      };
    });

    const javaMajor = Number(vanillaMeta && vanillaMeta.javaVersion && vanillaMeta.javaVersion.majorVersion) || 0;
    const MIN_ASM = '9.9.1';
    const cmpVer = (a, b) => {
      const pa = String(a).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
      const pb = String(b).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    };
    const isForgeLoader = Boolean(loaderMeta.loader === 'forge' || /forge/i.test(String(loaderMeta.id || '')));
    const finalLoaderLibs = (javaMajor >= 25 && !isForgeLoader)
      ? extraLibraries.map(lib => {
          const parts = String(lib.name || '').split(':');
          if (parts[0] !== 'org.ow2.asm' || parts.length < 3 || cmpVer(parts[2], MIN_ASM) >= 0) return lib;
          const newName = [parts[0], parts[1], MIN_ASM, ...parts.slice(3)].join(':');
          const relPath = this.mavenCoordToPath(newName);
          return {
            name: newName,
            downloads: { artifact: { path: relPath, url: `https://repo1.maven.org/maven2/${relPath}`, sha1: null, size: 0 } }
          };
        })
      : extraLibraries;

    merged.libraries = [...finalLoaderLibs, ...(merged.libraries || [])];

    // Forge's modlauncher REQUIRES module "jopt.simple". Forge assumes the Mojang manifest ships it; if it is missing
    // (newer Minecraft versions) Forge dies with: FindException: Module jopt.simple not found, required by cpw.mods.modlauncher
    if (isForgeLoader) {
      const hasJopt = merged.libraries.some(l => String(l.name || '').startsWith('net.sf.jopt-simple:jopt-simple:'));
      if (!hasJopt) {
        const joptPath = this.mavenCoordToPath(JOPT_SIMPLE_COORD);
        merged.libraries.push({
          name: JOPT_SIMPLE_COORD,
          downloads: { artifact: { path: joptPath, url: `https://repo1.maven.org/maven2/${joptPath}`, sha1: null, size: 0 } }
        });
      }
    }
    merged._inexRev = 4;

    if (loaderMeta.arguments) {
      merged.arguments = merged.arguments || { game: [], jvm: [] };
      if (Array.isArray(loaderMeta.arguments.game)) {
        merged.arguments.game = [...(merged.arguments.game || []), ...loaderMeta.arguments.game];
      }
      if (Array.isArray(loaderMeta.arguments.jvm)) {
        merged.arguments.jvm = [...(merged.arguments.jvm || []), ...loaderMeta.arguments.jvm];
      }
    }

    merged.loaderProfile = {
      id: loaderMeta.id,
      inheritsFrom: loaderMeta.inheritsFrom || vanillaMeta.id,
      _installerJarPath: loaderMeta._installerJarPath || null,
      _hasProcessors: Boolean(loaderMeta._hasProcessors)
    };

    return merged;
  }
}

module.exports = { LoaderManager };