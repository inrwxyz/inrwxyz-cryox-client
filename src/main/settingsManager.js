const fs = require('fs');
const path = require('path');
const os = require('os');

const DISCORD_CLIENT_ID = '1568590021332570122';

class SettingsManager {
  constructor(baseDataDir) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    this.configDir = baseDataDir || path.join(appData, 'CryoxClient');
    this.settingsFile = path.join(this.configDir, 'settings.json');

    this.defaults = {
      fullscreen: false,
      windowWidth: 1280,
      windowHeight: 720,
      defaultRamMB: 4096,
      maxRamMB: this._detectSystemRamMB(),
      concurrentDownloads: 8,
      closeBehavior: 'keep-open',
      autoJavaProvision: true,
      showSnapshots: false,
      enableSkinSync: true,
      discordRpcEnabled: true,
      discordClientId: DISCORD_CLIENT_ID,
      discordStatusText: 'CRYOX CLIENT',
      glassIntensity: 24,
      customLogoDataUrl: '',
      uiTheme: 'default',
      wallpaper: '',
      matrixShape: 'round',
      matrixHlStyle: 'solid',
      matrixHlColor: '#ffffff',
      gameDataDir: path.join(appData, '.cryoxclient'),
      installDir: path.join(localAppData, 'CryoxClient'),
      configDir: this.configDir,
      javaDir: path.join(this.configDir, 'runtimes'),
      customJavaPath: '',
      defaultJavaRuntime: 'auto',
      activeHudJar: '',
      hudConfig: {
        showNametagLogo: true,
      },
      jvmExtraArgs: '-XX:+IgnoreUnrecognizedVMOptions -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M',
    };

    this.settings = this._load();
    this._ensureDirectories();
  }

  _detectSystemRamMB() {
    const totalBytes = os.totalmem();
    const totalMB = Math.floor(totalBytes / (1024 * 1024));
    return Math.max(16384, Math.min(65536, totalMB));
  }

  _ensureDirectories() {
    const dirs = [
      this.configDir,
      this.settings.gameDataDir,
      this.settings.installDir,
      this.settings.javaDir,
      path.join(this.settings.gameDataDir, 'versions'),
      path.join(this.settings.gameDataDir, 'libraries'),
      path.join(this.settings.gameDataDir, 'assets', 'indexes'),
      path.join(this.settings.gameDataDir, 'assets', 'objects'),
      path.join(this.settings.gameDataDir, 'profiles'),
      path.join(this.configDir, 'cache'),
      path.join(this.configDir, 'skins'),
      path.join(this.configDir, 'hud-mods')
    ];
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
  }

  _load() {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      if (fs.existsSync(this.settingsFile)) {
        const raw = fs.readFileSync(this.settingsFile, 'utf8');
        const parsed = JSON.parse(raw);
        const validated = this._validate({ ...this.defaults, ...parsed });
        this._saveToFile(validated);
        return validated;
      }
    } catch (err) {
      console.error('[SettingsManager] Failed to load settings, using defaults:', err.message);
    }
    const initial = { ...this.defaults };
    this._saveToFile(initial);
    return initial;
  }

  _validate(input) {
    const validated = { ...this.defaults, ...(input || {}) };

    validated.fullscreen = Boolean(input.fullscreen);

    const width = Number(input.windowWidth);
    validated.windowWidth = Number.isFinite(width) ? Math.max(640, Math.min(7680, Math.round(width))) : 1280;

    const height = Number(input.windowHeight);
    validated.windowHeight = Number.isFinite(height) ? Math.max(480, Math.min(4320, Math.round(height))) : 720;

    const ram = Number(input.defaultRamMB);
    validated.defaultRamMB = Number.isFinite(ram) ? Math.max(1024, Math.min(validated.maxRamMB, Math.round(ram / 256) * 256)) : 4096;

    const conc = Number(input.concurrentDownloads);
    validated.concurrentDownloads = Number.isFinite(conc) ? Math.max(1, Math.min(32, Math.round(conc))) : 8;

    const validBehaviors = ['keep-open', 'minimize', 'close'];
    validated.closeBehavior = validBehaviors.includes(input.closeBehavior) ? input.closeBehavior : 'keep-open';

    validated.autoJavaProvision = input.autoJavaProvision !== undefined ? Boolean(input.autoJavaProvision) : true;
    validated.showSnapshots = Boolean(input.showSnapshots);
    validated.enableSkinSync = input.enableSkinSync !== undefined ? Boolean(input.enableSkinSync) : true;

    validated.discordRpcEnabled = input.discordRpcEnabled !== undefined ? Boolean(input.discordRpcEnabled) : true;
    validated.discordClientId = DISCORD_CLIENT_ID;
    validated.discordStatusText = typeof input.discordStatusText === 'string' && input.discordStatusText.trim()
      ? input.discordStatusText.trim()
      : this.defaults.discordStatusText;

    const glass = Number(input.glassIntensity);
    validated.glassIntensity = Number.isFinite(glass) ? Math.max(8, Math.min(40, Math.round(glass))) : 24;

    validated.customLogoDataUrl = typeof input.customLogoDataUrl === 'string' ? input.customLogoDataUrl : '';
    validated.uiTheme = input.uiTheme === 'nothing' ? 'nothing' : 'default';
    validated.matrixShape = input.matrixShape === 'default' ? 'default' : 'round';
    validated.matrixHlStyle = input.matrixHlStyle === 'glass' ? 'glass' : 'solid';
    validated.matrixHlColor = typeof input.matrixHlColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.matrixHlColor) ? input.matrixHlColor.toLowerCase() : '#ffffff';
    // One wallpaper for both Play and Server screens. Older versions had two separate keys:
    // migrate (Play first, then Server) and drop them so "Remove" really removes it.
    validated.wallpaper = typeof input.wallpaper === 'string' && input.wallpaper
      ? input.wallpaper
      : (typeof input.wallpaperHome === 'string' && input.wallpaperHome)
        ? input.wallpaperHome
        : (typeof input.wallpaperServer === 'string' ? input.wallpaperServer : '');
    delete validated.wallpaperHome;
    delete validated.wallpaperServer;

    if (typeof input.gameDataDir === 'string' && input.gameDataDir.trim()) {
      validated.gameDataDir = path.resolve(input.gameDataDir.trim());
    }
    if (typeof input.installDir === 'string' && input.installDir.trim()) {
      validated.installDir = path.resolve(input.installDir.trim());
    }
    if (typeof input.configDir === 'string' && input.configDir.trim()) {
      validated.configDir = path.resolve(input.configDir.trim());
    }
    if (typeof input.javaDir === 'string' && input.javaDir.trim()) {
      validated.javaDir = path.resolve(input.javaDir.trim());
    }
    validated.customJavaPath = typeof input.customJavaPath === 'string' ? input.customJavaPath.trim() : '';
    validated.defaultJavaRuntime = typeof input.defaultJavaRuntime === 'string' && input.defaultJavaRuntime.trim()
      ? input.defaultJavaRuntime.trim()
      : 'auto';
    validated.jvmExtraArgs = typeof input.jvmExtraArgs === 'string' ? input.jvmExtraArgs.trim() : this.defaults.jvmExtraArgs;

    validated.activeHudJar = typeof input.activeHudJar === 'string' ? input.activeHudJar.trim() : '';

    const nextHudConfig = {
      ...(this.defaults.hudConfig || {}),
      ...(input && typeof input.hudConfig === 'object' && input.hudConfig ? input.hudConfig : {})
    };
    validated.hudConfig = {
      showNametagLogo: nextHudConfig.showNametagLogo !== false,
    };

    return validated;
  }

  _saveToFile(data) {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      const tmpFile = `${this.settingsFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.settingsFile);
    } catch (err) {
      console.error('[SettingsManager] Failed to save settings:', err.message);
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(partial) {
    if (!partial || typeof partial !== 'object') {
      throw new Error('Invalid settings payload');
    }
    this.settings = this._validate({ ...this.settings, ...partial });
    this._ensureDirectories();
    this._saveToFile(this.settings);
    return this.getSettings();
  }

  resetSettings() {
    this.settings = { ...this.defaults };
    this._ensureDirectories();
    this._saveToFile(this.settings);
    return this.getSettings();
  }
}

module.exports = { SettingsManager, DISCORD_CLIENT_ID };