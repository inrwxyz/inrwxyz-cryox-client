#!/usr/bin/env node
// Prepares ./dist-ui, the folder Tauri embeds as the web frontend:
//  - copies src/* EXCEPT src/main (that is backend code, shipped separately as the "backend" resource)
//  - generates tauri-bridge.js (window.inexAPI on top of Tauri) from preload.js
//  - adds the update card script
//  - injects both <script> tags into the COPY of index.html (src/index.html itself stays untouched)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const dst = path.join(root, 'dist-ui');

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(src)) {
  if (name === 'main') continue;
  fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
}

execFileSync(process.execPath, [path.join(__dirname, 'gen-bridge.js')], { stdio: 'inherit' });
fs.copyFileSync(path.join(__dirname, 'assets', 'updater-ui.js'), path.join(dst, 'updater-ui.js'));

const htmlPath = path.join(dst, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('tauri-bridge.js')) {
  const firstScript = html.search(/<script\b/i);
  if (firstScript < 0) throw new Error('build-ui: no <script> tag found in index.html');
  html = html.slice(0, firstScript) + '<script src="tauri-bridge.js"></script>\n  ' + html.slice(firstScript);
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyEnd < 0) throw new Error('build-ui: no </body> in index.html');
  html = html.slice(0, bodyEnd) + '  <script src="updater-ui.js"></script>\n' + html.slice(bodyEnd);
  fs.writeFileSync(htmlPath, html);
}
console.log('build-ui: dist-ui ready');
