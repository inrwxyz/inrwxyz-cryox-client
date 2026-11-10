'use strict';
// Minimal stand-in for require('electron') so the existing main-process code (main.js + src/main/*)
// runs unchanged inside a plain Node process that is hosted by the Tauri (Rust) shell.
//
// Wire protocol: newline-delimited JSON on stdin/stdout.
//   Rust -> Node : {t:'invoke', id, channel, args}   run an ipcMain.handle() handler
//                  {t:'hostres', id, ok, result|error}  answer to a host call made by Node
//                  {t:'window-all-closed'}           user closed the window
//   Node -> Rust : {t:'res', id, ok, result|error}   answer to an invoke
//                  {t:'event', channel, data}        webContents.send() -> frontend
//                  {t:'host', id, method, args}      ask Rust to do something native
const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const util = require('util');

const protocolOut = process.stdout;
const writeLine = obj => { try { protocolOut.write(JSON.stringify(obj) + '\n'); } catch (_) {} };

// Nothing but protocol lines may reach stdout, so every console.* goes to stderr (-> sidecar.log).
const toStderr = (...a) => { try { process.stderr.write(util.format(...a) + '\n'); } catch (_) {} };
console.log = console.info = console.debug = console.warn = console.error = toStderr;

// ---- calls from Node into Rust ----
let hostSeq = 0;
const hostPending = new Map();
function host(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++hostSeq;
    hostPending.set(id, { resolve, reject });
    writeLine({ t: 'host', id, method, args });
  });
}
function onHostResult(m) {
  const p = hostPending.get(m.id);
  if (!p) return;
  hostPending.delete(m.id);
  if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Host call failed'));
}

// ---- ipcMain ----
const handlers = new Map();
const ipcMain = {
  handle: (channel, fn) => { handlers.set(channel, fn); },
  handleOnce: (channel, fn) => { handlers.set(channel, fn); },
  removeHandler: channel => { handlers.delete(channel); },
  on: () => {},
  once: () => {}
};

// ---- window / webContents ----
let maximized = false;
const webContents = {
  send: (channel, data) => writeLine({ t: 'event', channel, data: data === undefined ? null : data }),
  on: () => {},
  once: () => {},
  executeJavaScript: () => Promise.resolve(),
  isDestroyed: () => false
};
class BrowserWindow extends EventEmitter {
  constructor() { super(); this.webContents = webContents; }
  loadFile() {}
  loadURL() {}
  show() {}
  focus() {}
  minimize() { host('window.minimize').catch(() => {}); }
  maximize() { host('window.maximize').catch(() => {}); }
  unmaximize() { host('window.unmaximize').catch(() => {}); }
  isMaximized() { return maximized; }
  isDestroyed() { return false; }
  close() { host('quit').catch(() => {}); }
}

// ---- app ----
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const app = Object.assign(new EventEmitter(), {
  isPackaged: process.env.INEX_PACKAGED === '1',
  getVersion: () => process.env.INEX_VERSION || '0.0.0',
  getName: () => 'CRYOX CLIENT',
  whenReady: () => Promise.resolve(),
  quit: () => { host('quit').catch(() => process.exit(0)); },
  exit: () => { host('quit').catch(() => process.exit(0)); },
  getPath: name => {
    switch (name) {
      case 'userData': return path.join(appData, 'CRYOX CLIENT');
      case 'appData': return appData;
      case 'home': return os.homedir();
      case 'temp': return os.tmpdir();
      case 'desktop': return path.join(os.homedir(), 'Desktop');
      case 'downloads': return path.join(os.homedir(), 'Downloads');
      case 'documents': return path.join(os.homedir(), 'Documents');
      default: return path.join(appData, 'CRYOX CLIENT');
    }
  }
});

// ---- dialog / shell / clipboard ----
const splitArgs = (a, b) => (b === undefined && a && !a.webContents ? [a] : [b]);
const dialog = {
  showOpenDialog: async (a, b) => {
    const [opts] = splitArgs(a, b);
    const r = await host('dialog.open', opts || {});
    return { canceled: !!(r && r.canceled), filePaths: (r && r.filePaths) || [] };
  },
  showMessageBox: async (a, b) => {
    const [opts] = splitArgs(a, b);
    const r = await host('dialog.message', opts || {});
    return { response: r && typeof r.response === 'number' ? r.response : 0 };
  }
};
const shell = {
  openExternal: url => host('shell.openExternal', String(url)),
  openPath: async p => { try { await host('shell.openPath', String(p)); return ''; } catch (e) { return e.message; } },
  // [ms-login-fix] small Microsoft sign-in window (handled by the Tauri shell); resolves { canceled, url }
  inexMicrosoftWebLogin: opts => host('webview.msLogin', opts)
};
// The frontend copies to the clipboard itself (navigator.clipboard) — see src/tauri-bridge.js.
const clipboard = { writeText: () => {} };

module.exports = {
  app, BrowserWindow, ipcMain, dialog, shell, clipboard,
  // internal, used by sidecar/index.js
  __internals: {
    handlers, onHostResult, writeLine,
    setMaximized: v => { maximized = !!v; }
  }
};
