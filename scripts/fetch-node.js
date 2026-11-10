#!/usr/bin/env node
// Tauri "externalBin": copies the Node runtime that is running this script to
//   src-tauri/binaries/inex-node-<target-triple>.exe
// It is installed next to the launcher as inex-node.exe and runs the backend (sidecar/index.js).
// No download needed — it simply reuses the node.exe you already have (CI: the one from setup-node).
'use strict';
const fs = require('fs');
const path = require('path');

const triples = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc' };
const triple = triples[process.arch];
if (process.platform !== 'win32' || !triple) {
  // Non-Windows dev machines: still create a stub so `tauri dev` can compile; the shell falls back to `node` from PATH.
  const t = { linux: 'x86_64-unknown-linux-gnu', darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin' }[process.platform];
  if (!t) { console.error('fetch-node: unsupported platform'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'src-tauri', 'binaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(dir, `inex-node-${t}`));
  console.log('fetch-node: dev stub for', t);
  process.exit(0);
}
const dir = path.join(__dirname, '..', 'src-tauri', 'binaries');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `inex-node-${triple}.exe`);
fs.copyFileSync(process.execPath, dest);
console.log(`fetch-node: ${process.version} -> ${path.relative(path.join(__dirname, '..'), dest)} (${(fs.statSync(dest).size / 1048576).toFixed(0)} MB)`);
