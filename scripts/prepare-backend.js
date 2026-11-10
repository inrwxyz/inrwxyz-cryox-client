#!/usr/bin/env node
// Collects the Node backend into ./src-tauri/backend (what ends up as <install dir>/backend):
//   main.js, sidecar/, src/main/**  — and nothing else (no node_modules needed: the backend only uses Node built-ins).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const dst = path.join(root, 'src-tauri', 'backend');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'main.js'), path.join(dst, 'main.js'));
fs.cpSync(path.join(root, 'sidecar'), path.join(dst, 'sidecar'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'main'), path.join(dst, 'src', 'main'), { recursive: true });
// the jar may live in src/main/agent (as in the Electron build) — make sure it is there
const jar = path.join(dst, 'src', 'main', 'agent', 'inex-cosmetics-agent.jar');
if (!fs.existsSync(jar)) console.warn('prepare-backend: WARNING — src/main/agent/inex-cosmetics-agent.jar not found (skins/capes agent will be missing)');
console.log('prepare-backend: src-tauri/backend ready');
