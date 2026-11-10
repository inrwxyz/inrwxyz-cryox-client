'use strict';
// Entry point of the Node sidecar. Started by the Tauri shell (src-tauri/src/lib.rs).
const Module = require('module');
const path = require('path');
const readline = require('readline');

const shim = require('./electron-shim');
const { app, __internals } = shim;

// Anything that does require('electron') gets the shim. electron-updater is intentionally NOT
// resolvable, so appUpdater.js skips itself (updates are handled by the Tauri updater instead).
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return shim;
  return origLoad.call(this, request, ...rest);
};

// launcher.js looks for the cosmetics agent jar relative to process.resourcesPath.
if (!process.resourcesPath) process.resourcesPath = process.env.INEX_RESOURCES || path.join(__dirname, '..');

process.on('uncaughtException', e => console.error('[sidecar] uncaughtException', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[sidecar] unhandledRejection', e && e.stack || e));

// Load the original main process. It registers all ipcMain handlers inside app.whenReady().
require(path.join(__dirname, '..', 'main.js'));

async function runInvoke(m) {
  const fn = __internals.handlers.get(m.channel);
  if (!fn) return __internals.writeLine({ t: 'res', id: m.id, ok: false, error: `No handler registered for '${m.channel}'` });
  try {
    const result = await fn({ sender: null }, ...(Array.isArray(m.args) ? m.args : []));
    __internals.writeLine({ t: 'res', id: m.id, ok: true, result: result === undefined ? null : result });
  } catch (e) {
    __internals.writeLine({ t: 'res', id: m.id, ok: false, error: (e && e.message) || String(e) });
  }
}

// Start reading requests only after main.js had its chance to register handlers (whenReady is a microtask).
setImmediate(() => {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    switch (m.t) {
      case 'invoke': runInvoke(m); break;
      case 'hostres': __internals.onHostResult(m); break;
      case 'window-maximized': __internals.setMaximized(m.value); break;
      case 'window-all-closed': app.emit('window-all-closed'); break;
      default: break;
    }
  });
  // The Rust side went away (crash, forced update install...) -> don't linger as an orphan process.
  rl.on('close', () => process.exit(0));
  __internals.writeLine({ t: 'ready' });
});
