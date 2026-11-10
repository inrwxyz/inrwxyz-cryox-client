const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inexAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  writeClipboardText: text => ipcRenderer.invoke('clipboard:writeText', text),
  openExternal: url => ipcRenderer.invoke('shell:openExternal', url),

  getBootstrapState: () => ipcRenderer.invoke('get-bootstrap-state'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: partial => ipcRenderer.invoke('settings:update', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  listVersions: opts => ipcRenderer.invoke('versions:list', opts),
  getSupportedLoaders: mcVersion => ipcRenderer.invoke('loaders:supported', mcVersion),

  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: payload => ipcRenderer.invoke('profiles:create', payload),
  updateProfile: (id, updates) => ipcRenderer.invoke('profiles:update', id, updates),
  deleteProfile: id => ipcRenderer.invoke('profiles:delete', id),
  setActiveProfile: id => ipcRenderer.invoke('profiles:setActive', id),
  openProfileFolder: id => ipcRenderer.invoke('profiles:openFolder', id),

  listHudMods: profileId => ipcRenderer.invoke('hud:listJars', profileId),
  uploadHudMod: () => ipcRenderer.invoke('hud:uploadJar'),

  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  setActiveAccount: id => ipcRenderer.invoke('accounts:setActive', id),
  addLocalAccount: username => ipcRenderer.invoke('accounts:addLocal', username),
  removeAccount: (id, deleteCloud) => ipcRenderer.invoke('accounts:remove', id, deleteCloud),
  getMicrosoftLoginUrl: () => ipcRenderer.invoke('accounts:microsoftUrl'),
  loginMicrosoftAccount: () => ipcRenderer.invoke('accounts:microsoftLogin'),

  addSkinSlot: name => ipcRenderer.invoke('skins:addSlot', name),
  updateSkinSlot: (slotId, patch) => ipcRenderer.invoke('skins:updateSlot', slotId, patch),
  deleteSkinSlot: slotId => ipcRenderer.invoke('skins:deleteSlot', slotId),

  searchModrinth: opts => ipcRenderer.invoke('content:search', opts),
  listInstalledContent: (profileId, type) => ipcRenderer.invoke('content:listInstalled', profileId, type),
  installModrinthContent: opts => ipcRenderer.invoke('content:install', opts),
  // the UI calls these as (profileId, fileName, projectType); a single object is accepted too
  toggleInstalledContent: (profileId, fileName, projectType) => ipcRenderer.invoke('content:toggle',
    profileId && typeof profileId === 'object' ? profileId : { profileId, fileName, projectType }),
  removeInstalledContent: (profileId, fileName, projectType) => ipcRenderer.invoke('content:remove',
    profileId && typeof profileId === 'object' ? profileId : { profileId, fileName, projectType }),
  checkContentUpdates: (profileId, projectType) => ipcRenderer.invoke('content:checkUpdates', profileId, projectType),
  updateInstalledContent: opts => ipcRenderer.invoke('content:update', opts),
  // re-scans the profile's content folder (finds files that were added by hand) and returns what is installed
  syncInstalledContent: (profileId, projectType) => ipcRenderer.invoke('content:syncInstalled', profileId, projectType),
  // native folder watcher (no polling): the backend sends 'event:content-changed' when files change in the profile folders
  watchContent: profileId => ipcRenderer.invoke('content:watch', profileId),
  onContentChanged: cb => ipcRenderer.on('event:content-changed', (_, data) => cb(data)),

  bundlePortableJava: major => ipcRenderer.invoke('java:bundle', major),
  // which Java will really be used (read-only): (requiredMajor, profileJavaSetting) => { runtime, source, reason, runtimes, ... }
  getJavaStatus: (requiredMajor, javaSetting) => ipcRenderer.invoke('java:status', requiredMajor, javaSetting),
  cancelInstallation: profileId => ipcRenderer.invoke('installation:cancel', profileId),

  launchProfile: (profileId, opts) => ipcRenderer.invoke('profile:launch', profileId, opts),
  stopProfile: profileId => ipcRenderer.invoke('profile:stop', profileId),

  selectDirectoryDialog: defaultPath => ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  openDirectoryInExplorer: key => ipcRenderer.invoke('shell:openDir', key),
  getDiscordStatus: () => ipcRenderer.invoke('discord:status'),

  // Server API
  listServers: () => ipcRenderer.invoke('servers:list'),
  getServer: id => ipcRenderer.invoke('servers:get', id),
  getServerVersions: loader => ipcRenderer.invoke('servers:versions', loader),
  getSystemMemory: () => ipcRenderer.invoke('servers:memory'),
  createServer: payload => ipcRenderer.invoke('servers:create', payload),
  updateServer: (id, updates) => ipcRenderer.invoke('servers:update', id, updates),
  deleteServer: id => ipcRenderer.invoke('servers:delete', id),
  openServerFolder: id => ipcRenderer.invoke('servers:openFolder', id),

  startServer: id => ipcRenderer.invoke('servers:start', id),
  stopServer: id => ipcRenderer.invoke('servers:stop', id),
  restartServer: id => ipcRenderer.invoke('servers:restart', id),
  killServer: id => ipcRenderer.invoke('servers:kill', id),
  sendServerCommand: (id, cmd) => ipcRenderer.invoke('servers:command', id, cmd),
  getServerLog: id => ipcRenderer.invoke('servers:log', id),
  getServerStats: id => ipcRenderer.invoke('servers:stats', id),

  getServerProperties: id => ipcRenderer.invoke('servers:properties:read', id),
  setServerProperties: (id, updates) => ipcRenderer.invoke('servers:properties:write', id, updates),

  getServerPlayers: id => ipcRenderer.invoke('servers:players:list', id),
  serverPlayerAction: (id, act, name, reason) => ipcRenderer.invoke('servers:players:action', id, act, name, reason),

  listServerAddons: id => ipcRenderer.invoke('servers:addons:list', id),
  searchServerAddons: (id, opts) => ipcRenderer.invoke('servers:addons:search', id, opts),
  installServerAddon: (id, opts) => ipcRenderer.invoke('servers:addons:install', id, opts),
  toggleServerAddon: (id, file) => ipcRenderer.invoke('servers:addons:toggle', id, file),
  removeServerAddon: (id, file) => ipcRenderer.invoke('servers:addons:remove', id, file),

  listServerFiles: (id, rel) => ipcRenderer.invoke('servers:files:list', id, rel),
  readServerFile: (id, rel) => ipcRenderer.invoke('servers:files:read', id, rel),
  writeServerFile: (id, rel, content) => ipcRenderer.invoke('servers:files:write', id, rel, content),
  installBedrockSupport: id => ipcRenderer.invoke('servers:bedrock:install', id),
  getServerNetwork: id => ipcRenderer.invoke('servers:network', id),

  playitShare: id => ipcRenderer.invoke('playit:share', id),
  playitRelease: id => ipcRenderer.invoke('playit:release', id),
  playitLink: () => ipcRenderer.invoke('playit:link'),
  playitCancelLink: () => ipcRenderer.invoke('playit:cancelLink'),
  playitUnlink: () => ipcRenderer.invoke('playit:unlink'),
  playitManage: () => ipcRenderer.invoke('playit:manage'), // inex-playit-fix3
  getPlayitState: () => ipcRenderer.invoke('playit:state'),

  // Code access (one-time code -> P2P Remote Server Editor)
  accessStatus: () => ipcRenderer.invoke('access:status'),
  accessCreate: serverId => ipcRenderer.invoke('access:create', serverId),
  accessCancel: () => ipcRenderer.invoke('access:cancel'),
  accessDisconnect: () => ipcRenderer.invoke('access:disconnect'),
  p2pClaim: (code, sid) => ipcRenderer.invoke('p2p:claim', code, sid),
  p2pHostOpened: code => ipcRenderer.invoke('p2p:hostOpened', code),
  p2pHostClosed: code => ipcRenderer.invoke('p2p:hostClosed', code),
  p2pExec: (code, method, args) => ipcRenderer.invoke('p2p:exec', code, method, args),
  onP2PExpect: cb => ipcRenderer.on('event:p2p-expect', (_, data) => cb(data)),
  onP2PKick: cb => ipcRenderer.on('event:p2p-kick', (_, data) => cb(data)),
  onAccessState: cb => ipcRenderer.on('event:access-state', (_, data) => cb(data)),

  onInstallProgress: cb => ipcRenderer.on('event:install-progress', (_, data) => cb(data)),
  onGameLog: cb => ipcRenderer.on('event:game-log', (_, entry) => cb(entry)),
  onGameExit: cb => ipcRenderer.on('event:game-exit', (_, info) => cb(info)),

  onServerLog: cb => ipcRenderer.on('event:server-log', (_, data) => cb(data)),
  onServerStatus: cb => ipcRenderer.on('event:server-status', (_, data) => cb(data)),
  onServerExit: cb => ipcRenderer.on('event:server-exit', (_, data) => cb(data)),
  onServerProgress: cb => ipcRenderer.on('event:server-progress', (_, data) => cb(data)),
  onServerStats: cb => ipcRenderer.on('event:server-stats', (_, data) => cb(data)),
  onServerBedrock: cb => ipcRenderer.on('event:server-bedrock', (_, data) => cb(data)),
  onPlayitState: cb => ipcRenderer.on('event:playit-state', (_, data) => cb(data))
});