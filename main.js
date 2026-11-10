const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { SettingsManager } = require('./src/main/settingsManager');
const { VersionManager } = require('./src/main/versionManager');
const { LoaderManager } = require('./src/main/loaderManager');
const { JavaManager } = require('./src/main/javaManager');
const { ProfileManager } = require('./src/main/profileManager');
const { AccountManager } = require('./src/main/accountManager');
const { MinecraftInstaller } = require('./src/main/installer');
const { MinecraftLauncher } = require('./src/main/launcher');
const { ModrinthManager } = require('./src/main/modrinthManager');
const { DiscordRpcManager } = require('./src/main/discordRpcManager');
const { ServerManager } = require('./src/main/serverManager');
const { PlayitManager } = require('./src/main/playitManager');
const { CodeAccess } = require('./src/main/codeAccess');
const { initAppUpdater } = require('./src/main/appUpdater');

let mainWindow = null;

function createWindow() {
  const settingsManager = new SettingsManager();
  const settings = settingsManager.getSettings();

  mainWindow = new BrowserWindow({
    width: settings.windowWidth || 1280,
    height: settings.windowHeight || 720,
    frame: false,
    show: false,
    backgroundColor: '#050508',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized', false));
}

app.whenReady().then(() => {
  createWindow();

  const settingsManager = new SettingsManager();
  const versionManager = new VersionManager(settingsManager);
  const loaderManager = new LoaderManager(settingsManager);
  const javaManager = new JavaManager(settingsManager);
  const profileManager = new ProfileManager(settingsManager);
  const accountManager = new AccountManager(settingsManager);
  const installer = new MinecraftInstaller({ settingsManager, versionManager, loaderManager, javaManager, profileManager });
  const discordRpcManager = new DiscordRpcManager(settingsManager);
  const modrinthManager = new ModrinthManager({ settingsManager, profileManager });
  const launcher = new MinecraftLauncher({ settingsManager, profileManager, versionManager, loaderManager, javaManager, accountManager, installer, discordRpcManager, modrinthManager });
  const serverManager = new ServerManager({ settingsManager, versionManager, javaManager });
  const playitManager = new PlayitManager({ settingsManager });
  const codeAccess = new CodeAccess({ settingsManager });

  discordRpcManager.start();
  discordRpcManager.setLauncherMenuPresence(profileManager.getActiveProfile());

  const syncServerDiscordPresence = (targetId = null) => {
    try {
      const servers = serverManager.listServers();
      const activeSrv = servers.find(s => s.status === 'online' || s.status === 'starting') ||
        (targetId ? servers.find(s => s.id === targetId) : null);
      if (activeSrv && (activeSrv.status === 'online' || activeSrv.status === 'starting')) {
        const playitState = playitManager.getState();
        const tun = (playitState && playitState.tunnels && playitState.tunnels[activeSrv.id]) || null;
        discordRpcManager.setServerPresence({
          ...activeSrv,
          publicAddress: tun && tun.java ? tun.java.display : null
        });
      } else {
        discordRpcManager.setServerPresence(null);
      }
    } catch (_) {}
  };

  initAppUpdater({
    getWindow: () => mainWindow,
    sendToRenderer: (channel, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
    }
  });

  // Window Controls & Helpers
  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', async () => {
    if (serverManager.hasRunning()) {
      await serverManager.stopAll();
    }
    app.quit();
  });
  ipcMain.handle('clipboard:writeText', (_, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('shell:openExternal', async (_, url) => {
    const clean = String(url || '').trim();
    if (/^https?:\/\//i.test(clean)) {
      await shell.openExternal(clean);
      return { opened: true };
    }
    throw new Error('Invalid external URL.');
  });

  // Bootstrap state
  ipcMain.handle('get-bootstrap-state', async () => {
    const settings = settingsManager.getSettings();
    const profilesState = profileManager.listProfiles();
    const accountsState = accountManager.listAccounts();
    const javaRuntimes = javaManager.detectInstalledRuntimes();
    const versionsData = await versionManager.listVersions();
    const runningProfileIds = launcher.getRunningProfiles();
    const discordStatus = discordRpcManager.getStatus();
    return { settings, profilesState, accountsState, javaRuntimes, versionsData, runningProfileIds, discordStatus };
  });

  // Settings
  ipcMain.handle('settings:get', () => settingsManager.getSettings());
  const applyDiscordSetting = () => {
    const on = settingsManager.getSettings().discordRpcEnabled !== false;
    if (typeof profileManager.syncDiscordFlag === "function") profileManager.syncDiscordFlag(on);
    if (on) {
      discordRpcManager.start();
      discordRpcManager.setLauncherMenuPresence(profileManager.getActiveProfile());
      syncServerDiscordPresence();
    } else {
      discordRpcManager.stop();
    }
  };
  ipcMain.handle('settings:update', (_, partial) => {
    const before = settingsManager.getSettings().discordRpcEnabled !== false;
    const result = settingsManager.updateSettings(partial);
    const after = settingsManager.getSettings().discordRpcEnabled !== false;
    if (before !== after) applyDiscordSetting();
    return result;
  });
  ipcMain.handle('settings:reset', () => {
    const result = settingsManager.resetSettings();
    applyDiscordSetting();
    return result;
  });

  // Versions & Loaders
  ipcMain.handle('versions:list', (_, opts) => versionManager.listVersions(opts));
  ipcMain.handle('loaders:supported', (_, mcVersion) => loaderManager.getSupportedLoadersForVersion(mcVersion));

  // Profiles
  ipcMain.handle('profiles:list', () => profileManager.listProfiles());
  ipcMain.handle('profiles:create', (_, payload) => {
    const created = profileManager.createProfile(payload);
    // Performance Pack installs in the background so creating a profile stays instant.
    if (created && created.profile && created.profile.perfPackEnabled) {
      const sendProgress = data => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:install-progress', data);
      };
      modrinthManager.installPerformancePack(created.profile.id, { onProgress: sendProgress })
        .catch(err => console.error('[PerfPack]', err && err.message));
    }
    return created;
  });
  ipcMain.handle('profiles:update', (_, id, updates) => profileManager.updateProfile(id, updates));
  ipcMain.handle('profiles:delete', (_, id) => profileManager.deleteProfile(id));
  ipcMain.handle('profiles:setActive', (_, id) => {
    const state = profileManager.setActiveProfile(id);
    discordRpcManager.setLauncherMenuPresence(profileManager.getActiveProfile());
    return state;
  });
  ipcMain.handle('profiles:openFolder', (_, id) => {
    const p = profileManager.getProfileById(id);
    if (p && p.gameDir) shell.openPath(p.gameDir);
  });
  ipcMain.handle('hud:listJars', (_, profileId) => {
    const p = profileId ? profileManager.getProfileById(profileId) : profileManager.getActiveProfile();
    return { jars: profileManager.listHudJars(p) };
  });
  ipcMain.handle('hud:uploadJar', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select HUD Mod Jar',
      filters: [{ name: 'Minecraft Mod JAR', extensions: ['jar'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const src = res.filePaths[0];
    const fileName = path.basename(src);
    const dest = path.join(profileManager.getHudModsDir(), fileName);
    fs.copyFileSync(src, dest);
    const info = profileManager.listHudJars().find(j => j.fileName === fileName);
    return { canceled: false, fileName, compatible: info ? info.supported : true };
  });

  // Accounts & Skins
  ipcMain.handle('accounts:list', () => accountManager.listAccounts());
  ipcMain.handle('accounts:setActive', (_, id) => accountManager.setActiveAccount(id));
  ipcMain.handle('accounts:addLocal', (_, username) => accountManager.addLocalAccount(username));
  ipcMain.handle('accounts:remove', (_, id) => accountManager.removeAccount(id));
  ipcMain.handle('accounts:microsoftUrl', () => accountManager.getMicrosoftLoginUrl());
  ipcMain.handle('accounts:microsoftLogin', async () => {
    // [ms-login-fix] small Microsoft sign-in window; the redirect is caught automatically (nothing to copy or paste)
    const authUrl = accountManager.getMicrosoftLoginUrl();
    const res = await shell.inexMicrosoftWebLogin({ url: authUrl, redirectPrefix: accountManager.getMicrosoftRedirectUri() });
    if (!res || res.canceled || !res.url) throw new Error('Microsoft login cancelled.');
    return accountManager.completeMicrosoftOAuthRedirect(res.url);
  });

  ipcMain.handle('skins:addSlot', (_, name) => accountManager.addSkinSlot(name));
  ipcMain.handle('skins:updateSlot', (_, slotId, patch) => accountManager.updateSkinSlot(slotId, patch));
  ipcMain.handle('skins:deleteSlot', (_, slotId) => accountManager.deleteSkinSlot(slotId));

  // Modrinth / Content
  ipcMain.handle('content:search', (_, opts) => modrinthManager.searchProjects(opts));
  ipcMain.handle('content:listInstalled', (_, profileId, type) => modrinthManager.listInstalledContent(profileId, type));
  ipcMain.handle('content:install', async (_, opts) => {
    return await modrinthManager.installProject(opts, data => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:install-progress', data);
    });
  });
  ipcMain.handle('content:toggle', (_, opts) => modrinthManager.toggleInstalledContent(opts));
  ipcMain.handle('content:remove', (_, opts) => modrinthManager.removeInstalledContent(opts));

  // Java & Installer
  ipcMain.handle('java:bundle', async (_, major) => {
    const rt = await javaManager.bundlePortableJavaRuntime(major, prog => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('event:install-progress', { stage: prog.stage, percent: prog.percent, detail: prog.detail });
      }
    });
    return { runtimes: javaManager.detectInstalledRuntimes(), runtime: rt };
  });
  ipcMain.handle('installation:cancel', (_, profileId) => installer.cancelInstallation(profileId));

  // Launch & Stop Game
  const doLaunchProfile = async (profileId, joinServer = null) => {
    return await launcher.launchProfile(profileId, {
      joinServer,
      onProgress: data => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:install-progress', data);
      },
      onLog: entry => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:game-log', entry);
      },
      onExit: info => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:game-exit', info);
      }
    });
  };

  ipcMain.handle('profile:launch', async (_, profileId, opts) => {
    const joinServer = opts && typeof opts === 'object' ? opts.joinServer : (typeof opts === 'string' ? opts : null);
    return await doLaunchProfile(profileId, joinServer);
  });
  ipcMain.handle('profile:stop', (_, profileId) => launcher.stopGame(profileId));

  // Dialogs & Dirs
  ipcMain.handle('dialog:selectDirectory', async (_, defaultPath) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Directory',
      defaultPath: defaultPath || app.getPath('userData'),
      properties: ['openDirectory', 'createDirectory']
    });
    return { canceled: res.canceled, path: res.filePaths[0] };
  });
  ipcMain.handle('shell:openDir', (_, key) => {
    const s = settingsManager.getSettings();
    const map = {
      gameDataDir: s.gameDataDir,
      installDir: s.installDir,
      configDir: s.configDir,
      javaDir: s.javaDir,
      hudModsDir: path.join(s.configDir, 'hud-mods')
    };
    const target = map[key] || s.gameDataDir;
    fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
  });
  ipcMain.handle('discord:status', () => discordRpcManager.getStatus());

  // ==================== LOCAL SERVER HOSTING IPC ====================
  const startServerWithTunnel = async id => {
    const srv = await serverManager.startServer(id, p => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-progress', p);
    });
    if (srv.playit) {
      playitManager.share(srv.id, {
        port: srv.port,
        javaTunnel: srv.javaTunnel,
        bedrockPort: srv.bedrock && srv.bedrock.port ? srv.bedrock.port : null,
        openUrl: url => shell.openExternal(url)
      }).catch(() => {});
    }
    syncServerDiscordPresence(id);
    return srv;
  };

  const stopServerWithTunnel = async id => {
    playitManager.release(id);
    const res = await serverManager.stopServer(id);
    syncServerDiscordPresence(id);
    return res;
  };

  const restartServerWithTunnel = async id => {
    const srv = await serverManager.restartServer(id, p => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-progress', p);
    });
    if (srv && srv.playit) {
      playitManager.share(srv.id, {
        port: srv.port,
        javaTunnel: srv.javaTunnel,
        bedrockPort: srv.bedrock && srv.bedrock.port ? srv.bedrock.port : null,
        openUrl: url => shell.openExternal(url)
      }).catch(() => {});
    }
    syncServerDiscordPresence(id);
    return srv;
  };

  ipcMain.handle('servers:list', () => serverManager.listServers());
  ipcMain.handle('servers:get', (_, id) => serverManager.getServer(id));
  ipcMain.handle('servers:versions', (_, loader) => serverManager.getVersionsForLoader(loader));
  ipcMain.handle('servers:memory', () => serverManager.getSystemMemory());
  ipcMain.handle('servers:create', async (_, payload) => {
    return await serverManager.createServer(payload, p => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-progress', p);
    });
  });
  ipcMain.handle('servers:update', (_, id, updates) => serverManager.updateServer(id, updates));
  ipcMain.handle('servers:delete', (_, id) => serverManager.deleteServer(id));
  ipcMain.handle('servers:openFolder', (_, id) => {
    const dir = serverManager.serverDir(id);
    if (fs.existsSync(dir)) shell.openPath(dir);
    return { opened: true };
  });

  ipcMain.handle('servers:start', (_, id) => startServerWithTunnel(id));
  ipcMain.handle('servers:stop', (_, id) => stopServerWithTunnel(id));
  ipcMain.handle('servers:restart', (_, id) => restartServerWithTunnel(id));
  ipcMain.handle('servers:kill', async (_, id) => {
    playitManager.release(id);
    const res = await serverManager.stopServer(id, { force: true });
    syncServerDiscordPresence(id);
    return res;
  });
  ipcMain.handle('servers:command', (_, id, cmd) => serverManager.sendCommand(id, cmd));
  ipcMain.handle('servers:log', (_, id) => serverManager.getLog(id));
  ipcMain.handle('servers:stats', (_, id) => serverManager.getStats(id));

  ipcMain.handle('servers:properties:read', (_, id) => serverManager.readProperties(id));
  ipcMain.handle('servers:properties:write', (_, id, updates) => serverManager.writeProperties(id, updates));

  ipcMain.handle('servers:players:list', (_, id) => serverManager.getPlayerLists(id));
  ipcMain.handle('servers:players:action', (_, id, act, name, reason) => serverManager.playerAction(id, act, name, reason));

  ipcMain.handle('servers:addons:list', (_, id) => serverManager.listServerAddons(id));
  ipcMain.handle('servers:addons:search', (_, id, opts) => serverManager.searchServerAddons(id, opts));
  ipcMain.handle('servers:addons:install', async (_, id, opts) => {
    return await serverManager.installServerAddon(id, opts, p => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-progress', p);
    });
  });
  ipcMain.handle('servers:addons:toggle', (_, id, file) => serverManager.toggleServerAddon(id, file));
  ipcMain.handle('servers:addons:remove', (_, id, file) => serverManager.removeServerAddon(id, file));

  ipcMain.handle('servers:files:list', (_, id, rel) => serverManager.listServerFiles(id, rel));
  ipcMain.handle('servers:files:read', (_, id, rel) => serverManager.readServerFile(id, rel));
  ipcMain.handle('servers:files:write', (_, id, rel, content) => serverManager.writeServerFile(id, rel, content));
  ipcMain.handle('servers:bedrock:install', async (_, id) => {
    return await serverManager.installBedrockSupport(id, p => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-progress', p);
    });
  });
  ipcMain.handle('servers:network', (_, id) => serverManager.getNetwork(id));

  // Host-side executor for Remote Server Editor
  codeAccess.setServerProvider(() => serverManager.listServers());
  codeAccess.setRemoteExecutor(async (method, args) => {
    const srvId = args[0];
    switch (method) {
      case 'listServers': return serverManager.listServers();
      case 'getServer': return serverManager.getServer(srvId);
      case 'getServerLog': return (serverManager.getLog(srvId) || []).slice(-250);
      case 'getServerStats': return serverManager.getStats(srvId);
      case 'getServerPlayers': return serverManager.getPlayerLists(srvId);
      case 'getServerProperties': return serverManager.readProperties(srvId);
      case 'getServerNetwork': return serverManager.getNetwork(srvId);
      case 'listServerAddons': return serverManager.listServerAddons(srvId);
      case 'startServer': return await startServerWithTunnel(srvId);
      case 'stopServer': return await stopServerWithTunnel(srvId);
      case 'restartServer': return await restartServerWithTunnel(srvId);
      case 'sendServerCommand': return serverManager.sendCommand(srvId, args[1]);
      case 'serverPlayerAction': return serverManager.playerAction(srvId, args[1], args[2], args[3]);
      case 'setServerProperties': return serverManager.writeProperties(srvId, args[1]);
      case 'listServerFiles': return serverManager.listServerFiles(srvId, args[1]);
      case 'readServerFile': return serverManager.readServerFile(srvId, args[1]);
      case 'writeServerFile': return serverManager.writeServerFile(srvId, args[1], args[2]);
      case 'toggleServerAddon': return serverManager.toggleServerAddon(srvId, args[1]);
      case 'removeServerAddon': return serverManager.removeServerAddon(srvId, args[1]);
      default: throw new Error(`Unsupported remote method: ${method}`);
    }
  });

  codeAccess.on('state', data => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:access-state', data);
  });
  codeAccess.on('p2p-expect', data => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:p2p-expect', data);
  });
  codeAccess.on('p2p-kick', data => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:p2p-kick', data);
  });

  // Playit.gg IPC
  ipcMain.handle('playit:state', () => playitManager.getState());
  ipcMain.handle('playit:share', (_, id) => {
    const srv = serverManager.getServer(id);
    return playitManager.share(id, {
      port: srv.port,
      javaTunnel: srv.javaTunnel,
      bedrockPort: srv.bedrock && srv.bedrock.port ? srv.bedrock.port : null,
      openUrl: url => shell.openExternal(url)
    });
  });
  ipcMain.handle('playit:release', (_, id) => playitManager.release(id));
  ipcMain.handle('playit:link', () => playitManager.link(url => shell.openExternal(url)));
  ipcMain.handle('playit:cancelLink', () => playitManager.cancelLink());
  ipcMain.handle('playit:unlink', () => playitManager.unlink());
  ipcMain.handle('playit:manage', () => shell.openExternal('https://playit.gg/account')); // inex-playit-fix3

  serverManager.on('log', d => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-log', d);
  });

  // ---- Code access (one-time code -> P2P Remote Server Editor) ----
  ipcMain.handle('access:status', () => codeAccess.getStatus());
  ipcMain.handle('access:create', (_, serverId) => codeAccess.createCode(serverId));
  ipcMain.handle('access:cancel', () => codeAccess.cancelCode());
  ipcMain.handle('access:disconnect', () => codeAccess.disconnect());
  ipcMain.handle('p2p:claim', (_, code, sid) => codeAccess.claim(code, sid));
  ipcMain.handle('p2p:hostOpened', (_, code) => codeAccess.hostOpened(code));
  ipcMain.handle('p2p:hostClosed', (_, code) => codeAccess.hostClosed(code));
  ipcMain.handle('p2p:exec', (_, code, method, args) => codeAccess.p2pExec(code, method, args));

  serverManager.on('status', d => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-status', d);
    syncServerDiscordPresence(d.id);
  });
  serverManager.on('exit', d => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-exit', d);
    syncServerDiscordPresence(d.id);
  });
  serverManager.on('stats', d => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-stats', d);
  });
  serverManager.on('bedrock', d => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:server-bedrock', d);
    try {
      const srv = serverManager.getServer(d.id);
      if (srv && srv.playit && srv.status === 'online') {
        playitManager.share(srv.id, {
          port: srv.port,
          javaTunnel: srv.javaTunnel,
          bedrockPort: d.port || (srv.bedrock && srv.bedrock.port) || 19132,
          openUrl: url => shell.openExternal(url)
        }).catch(() => {});
      }
    } catch (_) {}
  });

  playitManager.on('state', st => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event:playit-state', st);
    syncServerDiscordPresence();
  });

  app.on('window-all-closed', async () => {
    try { await codeAccess.shutdown(); } catch (_) {}
    await serverManager.stopAll();
    playitManager.stopAll();
    if (process.platform !== 'darwin') app.quit();
  });
});