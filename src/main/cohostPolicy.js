'use strict';
// What a friend may do on the HOST's launcher. Enforced on the host side (main process); never trust the friend's UI.
// Access is per server: the friend can only touch the server(s) the host picked for them,
// and only the one server whose editor they have opened and the host has approved (see OnlineManager.p2pExec).
//
// Allowed: look, start/stop/restart, console commands, players, server.properties, files & config editor,
//          manage INSTALLED plugins/mods (enable / disable / remove).
// Blocked: delete server, create server, update server settings, kill, open folder, playit/tunnel control,
//          browsing + installing plugins/mods (the Browse / Install option is hidden for friends).
const ALLOWED = new Set([
  'listServers', 'getServer', 'getServerLog', 'getServerStats', 'getServerPlayers',
  'getServerProperties', 'getServerNetwork', 'listServerAddons', 'listServerFiles', 'readServerFile',
  'startServer', 'stopServer', 'restartServer', 'sendServerCommand', 'serverPlayerAction',
  'setServerProperties', 'toggleServerAddon', 'removeServerAddon', 'writeServerFile'
]);

function isAllowed(method) {
  return ALLOWED.has(String(method));
}

module.exports = { ALLOWED, isAllowed };
