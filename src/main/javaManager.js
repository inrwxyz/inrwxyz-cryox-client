const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseZipBuffer, validateSafeRelativePath } = require('./zipUtils');

class JavaManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
  }

  _parseJavaVersionOutput(output) {
    const text = String(output || '');
    // Match version strings like:
    //   java version "25" 2025-09-16 LTS
    //   java version "25.0.1"
    //   openjdk version "21.0.4" 2024-07-16 LTS
    //   openjdk 21.0.2 2024-01-16
    //   java version "1.8.0_412"
    const match =
      text.match(/version\s+"([^"]+)"/i) ||
      text.match(/(?:openjdk|java)\s+(\d+[\w.-]*)/i);
    if (!match) return null;

    const rawVersion = match[1];
    const parts = rawVersion.split(/[._+-]/);
    let major = parseInt(parts[0], 10);
    if (major === 1 && parts.length > 1) {
      major = parseInt(parts[1], 10);
    }
    if (!Number.isFinite(major)) return null;
    const is64Bit = /64-Bit|x86_64|amd64|aarch64/i.test(text) || process.arch === 'x64';
    return {
      version: rawVersion,
      major,
      arch: is64Bit ? 'x64' : 'x86'
    };
  }

  /**
   * Probes a Java executable safely using spawnSync so BOTH stderr and stdout are captured!
   * (Fixes the bug where `java -version` exited with 0 and wrote to stderr while execFileSync only returned stdout.)
   */
  probeJavaBinary(javaExecPath) {
    try {
      if (!javaExecPath) return null;
      const normalized = String(javaExecPath).trim();
      if (!normalized) return null;
      if (normalized !== 'java' && normalized !== 'java.exe' && !fs.existsSync(normalized)) {
        return null;
      }

      for (const flag of ['-version', '--version']) {
        const res = spawnSync(normalized, [flag], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true
        });
        const combined = `${res.stderr || ''}\n${res.stdout || ''}`;
        const parsed = this._parseJavaVersionOutput(combined);
        if (parsed) {
          return { path: normalized, ...parsed };
        }
      }
    } catch (_) {}
    return null;
  }

  _scanDirectoryForJava(baseDir, maxDepth = 3, candidates) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    const isWin = process.platform === 'win32';
    const targetNames = isWin ? new Set(['java.exe']) : new Set(['java']);

    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        return;
      }
      for (const item of entries) {
        const full = path.join(dir, item);
        if (targetNames.has(item.toLowerCase())) {
          candidates.add(full);
        } else if (depth < maxDepth) {
          try {
            if (fs.statSync(full).isDirectory()) {
              const binJava = path.join(full, 'bin', isWin ? 'java.exe' : 'java');
              if (fs.existsSync(binJava)) {
                candidates.add(binJava);
              } else {
                walk(full, depth + 1);
              }
            }
          } catch (_) {}
        }
      }
    };
    walk(baseDir, 0);
  }

  _queryWindowsRegistryJavaPaths(candidates) {
    if (process.platform !== 'win32') return;
    const regKeys = [
      'HKLM\\SOFTWARE\\JavaSoft\\JDK',
      'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
      'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
      'HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE',
      'HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK',
      'HKLM\\SOFTWARE\\AdoptOpenJDK\\JRE',
      'HKLM\\SOFTWARE\\AdoptOpenJDK\\JDK',
      'HKLM\\SOFTWARE\\Microsoft\\JDK',
      'HKLM\\SOFTWARE\\Azul Systems\\Zulu',
      'HKLM\\SOFTWARE\\BellSoft\\Liberica'
    ];

    for (const key of regKeys) {
      try {
        const res = spawnSync('reg', ['query', key, '/s', '/v', 'JavaHome'], {
          encoding: 'utf8',
          timeout: 2500,
          windowsHide: true
        });
        const out = `${res.stdout || ''}\n${res.stderr || ''}`;
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/JavaHome\s+REG_SZ\s+(.+)$/i);
          if (match && match[1]) {
            const javaHome = match[1].trim();
            candidates.add(path.join(javaHome, 'bin', 'java.exe'));
          }
        }
      } catch (_) {}
    }
  }

  _getCandidatePaths() {
    const candidates = new Set();
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'java.exe' : 'java';

    const settings = this.settingsManager.getSettings();
    if (settings.customJavaPath && settings.customJavaPath.trim()) {
      const custom = settings.customJavaPath.trim();
      if (custom.toLowerCase().endsWith(binName)) {
        candidates.add(custom);
      } else {
        candidates.add(path.join(custom, 'bin', binName));
        candidates.add(path.join(custom, binName));
      }
    }

    // 1. Check Cryox Client bundled runtimes directory first (`CryoxClient/runtimes`)
    if (settings.javaDir) {
      this._scanDirectoryForJava(settings.javaDir, 4, candidates);
    }
    // Also check project-local `./runtimes` or `./jre` folder inside the launcher directory
    this._scanDirectoryForJava(path.join(process.cwd(), 'runtimes'), 4, candidates);
    this._scanDirectoryForJava(path.join(process.cwd(), 'runtime'), 4, candidates);

    // 2. Check JAVA_HOME environment variable
    if (process.env.JAVA_HOME) {
      candidates.add(path.join(process.env.JAVA_HOME, 'bin', binName));
    }

    if (isWin) {
      // 3. Query `where.exe java` to find all Java binaries in Windows PATH
      try {
        const whereRes = spawnSync('where.exe', ['java'], {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true
        });
        const lines = String(whereRes.stdout || '')
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean);
        for (const line of lines) {
          candidates.add(line);
        }
      } catch (_) {}

      // 4. Oracle JDK 21 / 25 default symlink path on Windows
      candidates.add('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe');
      candidates.add('C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\javapath\\java.exe');

      // 5. Query Windows Registry for JavaHome entries (works even if installed on D:\ or E:\ drive!)
      this._queryWindowsRegistryJavaPaths(candidates);

      // 6. Standard Windows Program Files vendor directories
      const programFiles = [
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
        process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.jdks') : null,
        process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'apps') : null
      ].filter(Boolean);

      const vendors = [
        'Java',
        'Eclipse Adoptium',
        'AdoptOpenJDK',
        'Microsoft',
        'BellSoft',
        'Zulu',
        'Amazon Corretto',
        'SapMachine',
        'GraalVM'
      ];

      for (const pf of programFiles) {
        this._scanDirectoryForJava(pf, 2, candidates);
        for (const vendor of vendors) {
          this._scanDirectoryForJava(path.join(pf, vendor), 3, candidates);
        }
      }

      // 7. Existing Minecraft / Modrinth / CurseForge / Feather / Lunar bundled Java runtimes on the PC
      const appData = process.env.APPDATA || '';
      const localAppData = process.env.LOCALAPPDATA || '';
      const launcherRuntimeDirs = [
        path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Minecraft Launcher', 'runtime'),
        path.join(appData, '.minecraft', 'runtime'),
        path.join(appData, 'ModrinthApp', 'meta', 'java_versions'),
        path.join(appData, 'com.modrinth.theseus', 'meta', 'java_versions'),
        path.join(localAppData, 'Programs', 'Modrinth App', 'runtime'),
        path.join(appData, '.feather', 'jre'),
        path.join(process.env.USERPROFILE || '', '.lunarclient', 'jre')
      ];
      for (const rtBase of launcherRuntimeDirs) {
        this._scanDirectoryForJava(rtBase, 5, candidates);
      }
    } else {
      const unixDirs = ['/usr/lib/jvm', '/usr/java', '/Library/Java/JavaVirtualMachines'];
      for (const d of unixDirs) {
        this._scanDirectoryForJava(d, 4, candidates);
      }
    }

    candidates.add('java');
    return Array.from(candidates);
  }

  detectInstalledRuntimes() {
    const seenPaths = new Map();
    for (const candidate of this._getCandidatePaths()) {
      const info = this.probeJavaBinary(candidate);
      if (info) {
        // Deduplicate by resolved realpath + version so symlinks don't duplicate
        let key = `${info.major}:${info.version}:${info.path}`;
        try {
          if (fs.existsSync(info.path)) {
            key = fs.realpathSync(info.path).toLowerCase();
          }
        } catch (_) {}
        if (!seenPaths.has(key)) {
          seenPaths.set(key, info);
        }
      }
    }
    return Array.from(seenPaths.values()).sort((a, b) => b.major - a.major);
  }

  /**
   * Resolves the best Java runtime for a required major version (e.g. 8, 17, 21, 25).
   * Prefers exact major match first (e.g., Java 21 for MC 1.21.4 even if Java 25 is also installed)
   * so Fabric/Forge bytecode/Mixin ASM never clashes with newer classfile versions,
   * and falls back to any compatible runtime >= requiredMajor.
   */
  resolveJavaForVersion(requiredMajor = 21, preferredSetting = 'auto') {
    const installed = this.detectInstalledRuntimes();
    const req = Number(requiredMajor) || 21;

    // A profile left on "auto" follows the Java chosen in Settings -> Java runtime (if any).
    if (!preferredSetting || preferredSetting === 'auto') {
      try {
        const chosen = this.settingsManager.getSettings().defaultJavaRuntime;
        if (chosen && chosen !== 'auto') preferredSetting = chosen;
      } catch (_) {}
    }

    if (preferredSetting && preferredSetting !== 'auto') {
      const custom = this.probeJavaBinary(preferredSetting);
      if (custom) {
        const compatible = custom.major >= req;
        return {
          found: true,
          exactMatch: custom.major === req,
          compatible,
          runtime: custom,
          requiredMajor: req,
          installed,
          message: compatible
            ? `Using selected Java ${custom.major} (${custom.version})`
            : `Selected Java ${custom.major} is older than required Java ${req}.`
        };
      }
    }

    // 1. Prefer exact major match (e.g. Java 21 for MC 1.21.4, Java 17 for MC 1.20.4, Java 8 for MC 1.8.9, Java 25 for MC 26.x)
    let match = installed.find(r => r.major === req);
    if (match) {
      return {
        found: true,
        exactMatch: true,
        compatible: true,
        runtime: match,
        requiredMajor: req,
        installed,
        message: `Resolved exact match Java ${match.major} (${match.version}) at ${match.path}`
      };
    }

    // 2. Otherwise pick the closest compatible newer runtime (smallest major >= req)
    const compatibleNewer = installed
      .filter(r => r.major >= req)
      .sort((a, b) => a.major - b.major);

    if (compatibleNewer.length > 0) {
      match = compatibleNewer[0];
      return {
        found: true,
        exactMatch: false,
        compatible: true,
        runtime: match,
        requiredMajor: req,
        installed,
        message: `Resolved compatible Java ${match.major} (${match.version}) for Java ${req} requirement`
      };
    }

    return {
      found: false,
      exactMatch: false,
      compatible: false,
      runtime: null,
      requiredMajor: req,
      installed,
      message: installed.length === 0
        ? `No system Java detected; CRYOX CLIENT will automatically bundle Portable Java ${req}.`
        : `Installed Java (${installed.map(i => 'Java ' + i.major).join(', ')}) is older than required Java ${req}.`
    };
  }

  /**
   * Automatically downloads and bundles a portable Windows x64 Java Runtime (JRE)
   * into `CryoxClient/runtimes/java-<major>` if no compatible Java is found (or when requested).
   * Uses Eclipse Adoptium official API (`.zip` on Windows) and extracts with pure Node.js.
   */
  async bundlePortableJavaRuntime(targetMajor = 21, onProgress = () => {}) {
    const major = [8, 17, 21, 25].includes(Number(targetMajor)) ? Number(targetMajor) : 21;
    const settings = this.settingsManager.getSettings();
    const runtimesRoot = settings.javaDir || path.join(settings.configDir, 'runtimes');
    const destFolder = path.join(runtimesRoot, `java-${major}`);

    // Check if already bundled in destFolder
    const existingCandidates = new Set();
    this._scanDirectoryForJava(destFolder, 4, existingCandidates);
    for (const c of existingCandidates) {
      const info = this.probeJavaBinary(c);
      if (info && info.major >= major) {
        return info;
      }
    }

    fs.mkdirSync(destFolder, { recursive: true });

    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const archName = process.arch === 'arm64' ? 'aarch64' : 'x64';
    // Try JRE first, fallback to JDK (for versions like Java 25 where JRE or JDK might be published)
    const urlsToTry = [
      `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${archName}/jre/hotspot/normal/eclipse`,
      `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${archName}/jdk/hotspot/normal/eclipse`,
      `https://api.adoptium.net/v3/binary/latest/21/ga/${osName}/${archName}/jre/hotspot/normal/eclipse`
    ];

    onProgress({
      stage: `Bundling Portable Java ${major}`,
      percent: 10,
      detail: `Downloading official Portable Java ${major} (${osName}-${archName}) into Cryox Client...`
    });

    let zipBuffer = null;
    let lastError = null;

    for (const url of urlsToTry) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Cryox-Client-Launcher/1.0.0' },
          redirect: 'follow'
        });
        if (!res.ok) {
          lastError = new Error(`HTTP ${res.status} from ${url}`);
          continue;
        }
        const contentLen = Number(res.headers.get('content-length')) || 50 * 1024 * 1024;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
          const chunks = [];
          let received = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            received += value.length;
            const pct = Math.min(85, 10 + Math.round((received / contentLen) * 75));
            onProgress({
              stage: `Bundling Portable Java ${major}`,
              percent: pct,
              detail: `Downloading Portable Java ${major} (${(received / (1024 * 1024)).toFixed(1)} MB)...`
            });
          }
          zipBuffer = Buffer.concat(chunks);
        } else {
          zipBuffer = Buffer.from(await res.arrayBuffer());
        }
        if (zipBuffer && zipBuffer.length > 100000) {
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!zipBuffer || zipBuffer.length < 100000) {
      throw new Error(`Failed to download Portable Java ${major}: ${lastError ? lastError.message : 'Network error'}`);
    }

    onProgress({
      stage: `Extracting Portable Java ${major}`,
      percent: 90,
      detail: `Extracting Portable Java ${major} into ${destFolder}...`
    });

    const entries = parseZipBuffer(zipBuffer);
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      // Strip top-level archive folder name (e.g. jdk-21.0.5+11-jre/...)
      const parts = entry.name.split('/').filter(Boolean);
      const relPath = parts.length > 1 ? parts.slice(1).join('/') : entry.name;
      if (!relPath) continue;

      const safeDest = validateSafeRelativePath(relPath, destFolder);
      fs.mkdirSync(path.dirname(safeDest), { recursive: true });
      fs.writeFileSync(safeDest, entry.extractBuffer());
      if (process.platform !== 'win32' && safeDest.endsWith('/bin/java')) {
        try {
          fs.chmodSync(safeDest, 0o755);
        } catch (_) {}
      }
    }

    const extractedCandidates = new Set();
    this._scanDirectoryForJava(destFolder, 4, extractedCandidates);
    for (const c of extractedCandidates) {
      const info = this.probeJavaBinary(c);
      if (info) {
        onProgress({
          stage: `Portable Java ${info.major} Ready`,
          percent: 100,
          detail: `Bundled Portable Java ${info.version} ready at ${info.path}`
        });
        return info;
      }
    }

    throw new Error(`Extracted Portable Java ${major}, but java executable could not be verified.`);
  }

  /**
   * Ensures a compatible Java runtime is ready for the given Minecraft version requirement.
   * If not found on the system (or if an exact match is needed and autoJavaProvision is enabled),
   * automatically downloads & bundles Portable Java!
   */
  async ensureJavaForVersion(requiredMajor = 21, preferredSetting = 'auto', onProgress = () => {}) {
    const initial = this.resolveJavaForVersion(requiredMajor, preferredSetting);
    if (initial.found && initial.compatible) {
      return initial;
    }

    const settings = this.settingsManager.getSettings();
    if (settings.autoJavaProvision !== false) {
      const bundledRuntime = await this.bundlePortableJavaRuntime(requiredMajor, onProgress);
      return {
        found: true,
        exactMatch: bundledRuntime.major === Number(requiredMajor),
        compatible: true,
        runtime: bundledRuntime,
        requiredMajor: Number(requiredMajor),
        installed: this.detectInstalledRuntimes(),
        message: `Bundled & resolved Portable Java ${bundledRuntime.major} (${bundledRuntime.version})`
      };
    }

    return initial;
  }
}

module.exports = { JavaManager };
