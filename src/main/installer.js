const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { extractZipFiltered } = require('./zipUtils');

const RESOURCES_BASE_URL = 'https://resources.download.minecraft.net';

class MinecraftInstaller {
  constructor({ settingsManager, versionManager, loaderManager, javaManager, profileManager }) {
    this.settingsManager = settingsManager;
    this.versionManager = versionManager;
    this.loaderManager = loaderManager;
    this.javaManager = javaManager;
    this.profileManager = profileManager;
    this.activeControllers = new Map();
  }

  cancelInstallation(profileId) {
    const controller = this.activeControllers.get(profileId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(profileId);
      return { cancelled: true, profileId };
    }
    return { cancelled: false, profileId };
  }

  _computeFileSha1(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      const hash = crypto.createHash('sha1');
      const data = fs.readFileSync(filePath);
      hash.update(data);
      return hash.digest('hex').toLowerCase();
    } catch (_) {
      return null;
    }
  }

  _isFileValid(filePath, expectedSha1, expectedSize) {
    if (!fs.existsSync(filePath)) return false;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) return false;
      if (expectedSize && expectedSize > 0 && stat.size !== expectedSize) {
        return false;
      }
      if (expectedSha1) {
        const actualSha1 = this._computeFileSha1(filePath);
        return actualSha1 === String(expectedSha1).toLowerCase();
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Evaluates Mojang library OS & architecture rules accurately.
   * Ensures 32-bit (x86) and ARM64 native libraries are NOT mixed into 64-bit Windows classpaths!
   */
  _evaluateRules(rules, targetOs = 'windows', targetArch = 'x64') {
    if (!Array.isArray(rules) || rules.length === 0) return true;
    let allowed = false;
    for (const rule of rules) {
      let matches = true;
      if (rule.os) {
        if (rule.os.name && rule.os.name !== targetOs) {
          matches = false;
        }
        if (rule.os.arch) {
          const ruleArch = String(rule.os.arch).toLowerCase();
          if (targetArch === 'x64' && ruleArch !== 'x64' && ruleArch !== 'amd64' && ruleArch !== 'x86_64') {
            matches = false;
          } else if (targetArch !== 'x64' && ruleArch !== targetArch) {
            matches = false;
          }
        }
      }
      if (matches) {
        allowed = rule.action === 'allow';
      }
    }
    return allowed;
  }

  async _downloadFileWithVerify({ url, destPath, sha1, size, signal, retries = 3 }) {
    if (this._isFileValid(destPath, sha1, size)) {
      return { cached: true, bytes: size || 0 };
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal && signal.aborted) {
        throw new Error('Installation cancelled by user.');
      }
      try {
        const res = await fetch(url, {
          signal,
          headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' }
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} while downloading ${url}`);
        }
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);

        if (sha1) {
          const actualSha1 = crypto.createHash('sha1').update(buf).digest('hex').toLowerCase();
          if (actualSha1 !== String(sha1).toLowerCase()) {
            throw new Error(`SHA1 mismatch for ${path.basename(destPath)} (expected ${sha1}, got ${actualSha1})`);
          }
        }

        fs.writeFileSync(tmpPath, buf);
        fs.renameSync(tmpPath, destPath);
        return { cached: false, bytes: buf.length };
      } catch (err) {
        lastError = err;
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}
        if (signal && signal.aborted) {
          throw new Error('Installation cancelled by user.');
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw lastError || new Error(`Failed to download ${url}`);
  }

  async _runConcurrentQueue(tasks, concurrency, signal, onItemComplete) {
    let index = 0;
    let completed = 0;
    const total = tasks.length;

    const worker = async () => {
      while (index < total) {
        if (signal && signal.aborted) {
          throw new Error('Installation cancelled by user.');
        }
        const currentIndex = index++;
        const task = tasks[currentIndex];
        const result = await task();
        completed++;
        if (onItemComplete) {
          onItemComplete(completed, total, result);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker());
    await Promise.all(workers);
  }

  /**
   * Collects and deduplicates required libraries for Windows x64,
   * supporting BOTH legacy `lib.natives` classifiers AND modern Minecraft 1.19–26.x `:natives-windows` artifacts.
   */
  collectRequiredLibraries(mergedMeta, targetOs = 'windows') {
    const librariesDir = path.join(this.settingsManager.getSettings().gameDataDir, 'libraries');
    const downloads = [];
    const nativeJars = [];
    const classpathEntries = [];
    const seenMavenKeys = new Set();

    for (const lib of mergedMeta.libraries || []) {
      if (!this._evaluateRules(lib.rules, targetOs, 'x64')) continue;

      // Filter out 32-bit x86 or arm64 native artifacts on 64-bit Windows
      const coordParts = String(lib.name || '').split(':');
      const groupArtifactKey = coordParts.length >= 2
        ? `${coordParts[0]}:${coordParts[1]}:${coordParts[3] || ''}`
        : lib.name;

      if (coordParts[3]) {
        const classifier = coordParts[3].toLowerCase();
        if (classifier.includes('x86') || classifier.includes('arm64') || classifier.includes('linux') || classifier.includes('macos') || classifier.includes('osx')) {
          continue;
        }
      }

      if (seenMavenKeys.has(groupArtifactKey)) {
        continue;
      }
      seenMavenKeys.add(groupArtifactKey);

      const art = (lib.downloads && lib.downloads.artifact) ? lib.downloads.artifact : null;
      const relPath = (art && art.path) || this.loaderManager.mavenCoordToPath(lib.name);
      if (relPath) {
        const destPath = path.join(librariesDir, relPath);
        if (art && art.url) {
          downloads.push({
            name: lib.name,
            url: art.url,
            destPath,
            sha1: art.sha1 || null,
            size: art.size || 0
          });
        }
        classpathEntries.push(destPath);

        // In Minecraft 1.19+, Windows native DLLs are inside artifacts with `:natives-windows`
        if (String(lib.name).toLowerCase().includes(':natives-windows') || relPath.toLowerCase().includes('natives-windows')) {
          nativeJars.push({
            jarPath: destPath,
            exclude: ['META-INF/']
          });
        }
      }

      // Also check legacy native classifiers for 1.8.9 - 1.18.2
      if (lib.natives && lib.natives[targetOs] && lib.downloads && lib.downloads.classifiers) {
        const classifierKey = lib.natives[targetOs].replace('${arch}', '64');
        const classifierObj = lib.downloads.classifiers[classifierKey];
        if (classifierObj && classifierObj.url) {
          const destPath = path.join(librariesDir, classifierObj.path);
          downloads.push({
            name: `${lib.name} (${classifierKey})`,
            url: classifierObj.url,
            destPath,
            sha1: classifierObj.sha1 || null,
            size: classifierObj.size || 0
          });
          nativeJars.push({
            jarPath: destPath,
            exclude: (lib.extract && lib.extract.exclude) || ['META-INF/']
          });
        }
      }
    }

    return { downloads, nativeJars, classpathEntries };
  }

  /**
   * Runs the official Forge/NeoForge installer headless (--installClient) WITHOUT blocking the Electron main thread.
   */
  _runLoaderInstaller(javaPath, installerJar, gameDataDir, signal) {
    return new Promise(resolve => {
      let tail = '';
      const child = spawn(javaPath, ['-jar', installerJar, '--installClient', gameDataDir], {
        cwd: gameDataDir,
        windowsHide: true
      });
      const keep = chunk => { tail = (tail + String(chunk)).slice(-600); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 5 * 60 * 1000);
      const onAbort = () => { try { child.kill(); } catch (_) {} };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', err => { clearTimeout(timer); resolve({ ok: false, code: -1, tail: err.message }); });
      child.on('close', code => {
        clearTimeout(timer);
        const finished = /You can delete this installer|Successfully installed client profile/i.test(tail);
        resolve({ ok: code === 0 || finished, code, tail: tail.replace(/\s+/g, ' ').trim() });
      });
    });
  }

  async installProfile(profileId, onProgress = () => {}) {
    const profile = this.profileManager.getProfileById(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    if (this.activeControllers.has(profileId)) {
      throw new Error(`Installation is already in progress for "${profile.name}".`);
    }

    const controller = new AbortController();
    this.activeControllers.set(profileId, controller);
    const { signal } = controller;

    const settings = this.settingsManager.getSettings();
    const gameDataDir = settings.gameDataDir;
    const versionDir = path.join(gameDataDir, 'versions', profile.version);
    const nativesDir = path.join(versionDir, 'natives');
    const assetsIndexesDir = path.join(gameDataDir, 'assets', 'indexes');
    const assetsObjectsDir = path.join(gameDataDir, 'assets', 'objects');
    const concurrency = settings.concurrentDownloads || 8;

    const emit = (stage, percent, detail, extra = {}) => {
      onProgress({
        profileId: profile.id,
        profileName: profile.name,
        stage,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        detail,
        ...extra
      });
    };

    try {
      // Step 1 & 2: Resolve version and retrieve official metadata
      emit('Resolving version metadata', 3, `Fetching Mojang metadata for Minecraft ${profile.version}...`);
      const vanillaMeta = await this.versionManager.resolveVersionMetadata(profile.version);

      // Step 3: Resolve loader metadata if needed
      let loaderMeta = null;
      if (profile.loader && profile.loader !== 'vanilla') {
        emit('Resolving mod loader', 8, `Fetching ${profile.loader.toUpperCase()} loader metadata...`);
        loaderMeta = await this.loaderManager.resolveLoaderProfile(profile.version, profile.loader, profile.loaderVersion);
      }

      const mergedMeta = this.loaderManager.mergeWithVanillaMetadata(vanillaMeta, loaderMeta);

      // Prepare directories & auto-attach default Cryox Client HUD JARs
      fs.mkdirSync(versionDir, { recursive: true });
      fs.mkdirSync(nativesDir, { recursive: true });
      fs.mkdirSync(assetsIndexesDir, { recursive: true });
      fs.mkdirSync(assetsObjectsDir, { recursive: true });
      fs.mkdirSync(profile.gameDir, { recursive: true });
      this.profileManager.attachDefaultClientMods(profile);

      // Step 4: Download Client JAR
      const clientDownload = mergedMeta.downloads && mergedMeta.downloads.client;
      if (!clientDownload || !clientDownload.url) {
        throw new Error(`Official client JAR download URL missing for Minecraft ${profile.version}`);
      }
      const clientJarPath = path.join(versionDir, `${profile.version}.jar`);
      emit('Downloading Client JAR', 14, `Downloading ${profile.version}.jar...`);
      await this._downloadFileWithVerify({
        url: clientDownload.url,
        destPath: clientJarPath,
        sha1: clientDownload.sha1,
        size: clientDownload.size,
        signal
      });

      // Step 5: Download required libraries
      const { downloads: libDownloads, nativeJars } = this.collectRequiredLibraries(mergedMeta, 'windows');
      emit('Downloading libraries', 22, `Verifying and downloading ${libDownloads.length} libraries...`);

      const libTasks = libDownloads.map(item => async () => {
        try {
          const res = await this._downloadFileWithVerify({
            url: item.url,
            destPath: item.destPath,
            sha1: item.sha1,
            size: item.size,
            signal
          });
          return { name: item.name, ...res };
        } catch (err) {
          // Forge/NeoForge list processor-generated jars (…-client.jar, srg, extra, slim) that do not exist
          // on any maven. They are built later by the installer step, so a 404 here must not abort.
          // Only skip files that are REALLY built later by the Forge processors (client / srg / extra / slim / shim ...).
          // Any other missing library (e.g. jopt-simple) must fail loudly instead of crashing the game later.
          const isLoaderLib = Boolean(loaderMeta) && !item.sha1;
          const looksGenerated = /:(client|srg|extra|slim|shim|mappings|merged|universal)(@|$|:)/i.test(String(item.name));
          if (isLoaderLib && looksGenerated && !(signal && signal.aborted)) {
            return { name: `${item.name} (generated later)`, cached: false, bytes: 0, skipped: true };
          }
          throw err;
        }
      });

      await this._runConcurrentQueue(libTasks, concurrency, signal, (done, total, last) => {
        const pct = 22 + (done / Math.max(1, total)) * 32;
        emit('Downloading libraries', pct, `Libraries (${done}/${total}): ${last.name}`, {
          current: done,
          total
        });
      });

      // Extract native DLLs (both legacy and modern 1.19+ LWJGL natives)
      if (nativeJars.length > 0) {
        emit('Extracting native libraries', 55, `Extracting ${nativeJars.length} native runtime archives...`);
        for (const nat of nativeJars) {
          if (fs.existsSync(nat.jarPath)) {
            try {
              extractZipFiltered(nat.jarPath, nativesDir, entryName => {
                if (nat.exclude.some(ex => entryName.startsWith(ex))) return null;
                if (entryName.endsWith('.git') || entryName.endsWith('.sha1')) return null;
                return path.basename(entryName);
              });
            } catch (_) {}
          }
        }
      }

      // Step 6 & 7: Download Asset Index and required Assets
      if (mergedMeta.assetIndex && mergedMeta.assetIndex.url) {
        const indexId = mergedMeta.assetIndex.id || profile.version;
        const indexPath = path.join(assetsIndexesDir, `${indexId}.json`);
        emit('Downloading asset index', 58, `Fetching asset index (${indexId}.json)...`);
        await this._downloadFileWithVerify({
          url: mergedMeta.assetIndex.url,
          destPath: indexPath,
          sha1: mergedMeta.assetIndex.sha1,
          size: mergedMeta.assetIndex.size,
          signal
        });

        const indexJson = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const objects = Object.entries(indexJson.objects || {});
        const totalAssets = objects.length;

        emit('Verifying & downloading assets', 60, `Checking ${totalAssets} game assets...`);
        const assetTasks = objects.map(([assetName, obj]) => async () => {
          const hash = obj.hash;
          const prefix = hash.slice(0, 2);
          const destPath = path.join(assetsObjectsDir, prefix, hash);
          const url = `${RESOURCES_BASE_URL}/${prefix}/${hash}`;
          const res = await this._downloadFileWithVerify({
            url,
            destPath,
            sha1: hash,
            size: obj.size,
            signal
          });
          return { name: assetName, ...res };
        });

        await this._runConcurrentQueue(assetTasks, concurrency * 2, signal, (done, total) => {
          if (done % 25 === 0 || done === total) {
            const pct = 60 + (done / Math.max(1, total)) * 28;
            emit('Downloading game assets', pct, `Game assets (${done}/${total})`, {
              current: done,
              total
            });
          }
        });
      }

      // Step 8: Resolve or Auto-Bundle Required Portable Java Runtime!
      const requiredJava = this.versionManager.getRequiredJavaMajor(profile.version, mergedMeta);
      emit('Verifying / Bundling Java Runtime', 90, `Checking Java ${requiredJava} runtime compatibility...`);
      const javaCheck = await this.javaManager.ensureJavaForVersion(
        requiredJava,
        profile.javaRuntime,
        prog => emit(prog.stage || 'Bundling Portable Java', 90 + (prog.percent || 0) * 0.08, prog.detail)
      );

      // Step 8.5: If Forge/NeoForge installer has client processors, run headless --installClient with resolved Java
      if (loaderMeta && loaderMeta._installerJarPath && fs.existsSync(loaderMeta._installerJarPath)) {
        const launcherProfilesFile = path.join(gameDataDir, 'launcher_profiles.json');
        if (!fs.existsSync(launcherProfilesFile)) {
          fs.writeFileSync(launcherProfilesFile, JSON.stringify({ profiles: {} }, null, 2), 'utf8');
        }
        if (loaderMeta._hasProcessors) {
          if (!(javaCheck && javaCheck.found && javaCheck.runtime && javaCheck.runtime.path)) {
            throw new Error(`${profile.loader.toUpperCase()} needs Java to build its patched client, but no compatible Java was found.`);
          }
          emit('Running ' + profile.loader.toUpperCase() + ' Client Processor', 95, 'Building patched client libraries for ' + profile.loader.toUpperCase() + ' (this can take 1-3 minutes)...');
          const procResult = await this._runLoaderInstaller(javaCheck.runtime.path, loaderMeta._installerJarPath, gameDataDir, signal);
          if (!procResult.ok) {
            throw new Error(`${profile.loader.toUpperCase()} installer failed (exit ${procResult.code}). Last output: ${procResult.tail}`);
          }
        }
      }

      // Step 9: Write loader & launch configuration markers
      const markerPayload = loaderMeta || { id: `${profile.version}-${profile.loader}`, loader: profile.loader };
      if (profile.loader && profile.loader !== 'vanilla') {
        const loaderMarkerPath = path.join(versionDir, `loader-${profile.loader}.json`);
        fs.writeFileSync(loaderMarkerPath, JSON.stringify(markerPayload, null, 2), 'utf8');
      }
      const effectiveMetaPath = path.join(versionDir, `effective-${profile.loader || 'vanilla'}.json`);
      fs.writeFileSync(effectiveMetaPath, JSON.stringify(mergedMeta, null, 2), 'utf8');

      const updated = this.profileManager.updateProfile(profile.id, {});
      emit('Installation complete', 100, `Minecraft ${profile.version} (${profile.loader}) is ready to launch.`, {
        javaCheck,
        installed: true
      });

      return {
        success: true,
        profile: updated.profile,
        javaCheck
      };
    } finally {
      this.activeControllers.delete(profileId);
    }
  }
}

module.exports = { MinecraftInstaller };
