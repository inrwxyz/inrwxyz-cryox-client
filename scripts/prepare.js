#!/usr/bin/env node
// One command that gets everything Tauri needs in place. Called by `npm run dev|build` and by tauri.conf.json (beforeBuildCommand).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const root = path.join(__dirname, '..');
const run = f => execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', cwd: root });

run('build-ui.js');

// Ensure cosmetics agent jar is in place for Tauri resources
const agentSrc = path.join(root, 'src', 'main', 'agent', 'inex-cosmetics-agent.jar');
const agentDst = path.join(root, 'src-tauri', 'resources', 'inex-cosmetics-agent.jar');
if (fs.existsSync(agentSrc)) {
  fs.mkdirSync(path.dirname(agentDst), { recursive: true });
  fs.copyFileSync(agentSrc, agentDst);
  fs.copyFileSync(agentSrc, path.join(root, 'src', 'default-mods', 'inex-cosmetics-agent.jar'));
  fs.copyFileSync(agentSrc, path.join(root, 'dist-ui', 'default-mods', 'inex-cosmetics-agent.jar'));
}

console.log('prepare: 100% Native Rust build prepared (no Node sidecar needed)');

// App icons for the exe / installer / window, generated once from the launcher logo.
if (!fs.existsSync(path.join(root, 'src-tauri', 'icons', 'icon.ico'))) {
  console.log('prepare: generating Tauri icons from src/inex-logo.png');
  execSync('npx --no-install tauri icon src/inex-logo.png', { stdio: 'inherit', cwd: root });
}
