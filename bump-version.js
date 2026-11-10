#!/usr/bin/env node
// CRYOX CLIENT — one command to change the version everywhere (and optionally release).
//   node bump-version.js 1.0.7            -> changes the version in every place
//   node bump-version.js 1.0.7 --push     -> same + git add -A, commit, tag v1.0.7, push (GitHub Actions builds the release)
// Place this file in the project root (next to package.json) or in scripts/ — it finds the root by itself.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ver = process.argv[2];
const push = process.argv.includes('--push');
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) { console.error('Usage: node bump-version.js 1.0.7 [--push]'); process.exit(1); }

let root = __dirname;
if (!fs.existsSync(path.join(root, 'package.json'))) root = path.join(__dirname, '..');
if (!fs.existsSync(path.join(root, 'package.json'))) { console.error('package.json not found. Put this file in the project folder.'); process.exit(1); }

const rel = p => path.relative(root, p).replace(/\\/g, '/');
const read = p => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
const log = (p, from) => console.log('version  ' + rel(p) + '   ' + from + ' -> ' + ver);

// 1) package.json  (tauri.conf.json reads its version from here: "version": "../package.json")
{
  const p = path.join(root, 'package.json');
  let s = read(p);
  const m = s.match(/("version"\s*:\s*")([^"]+)(")/);
  if (!m) { console.error('no "version" in package.json'); process.exit(1); }
  write(p, s.replace(m[0], m[1] + ver + m[3]));
  log(p, m[2]);
}

// 2) package-lock.json (top-level + packages[""])
{
  const p = path.join(root, 'package-lock.json');
  if (fs.existsSync(p)) {
    let s = read(p);
    let n = 0;
    s = s.replace(/^(\s*"version"\s*:\s*")([^"]+)(",?\s*)$/m, (a, b, c, d) => { n++; return b + ver + d; });
    s = s.replace(/("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/, (a, b, c, d) => { n++; return b + ver + d; });
    if (n) { write(p, s); log(p, '(updated)'); }
  }
}

// 3) tauri.conf.json — only if it has a literal version (yours points at package.json, so it is left alone)
{
  const p = path.join(root, 'src-tauri', 'tauri.conf.json');
  if (fs.existsSync(p)) {
    const s = read(p);
    const m = s.match(/("version"\s*:\s*")(\d+\.\d+\.\d+[^"]*)(")/);
    if (m) { write(p, s.replace(m[0], m[1] + ver + m[3])); log(p, m[2]); }
    else console.log('skip     src-tauri/tauri.conf.json (reads version from package.json)');
  }
}

// 4) src-tauri/Cargo.toml  — [package] version only
{
  const p = path.join(root, 'src-tauri', 'Cargo.toml');
  if (fs.existsSync(p)) {
    const s = read(p);
    const re = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
    const m = s.match(re);
    if (m) { write(p, s.replace(re, (a, b, c, d) => b + ver + d)); log(p, m[2]); }
  }
}

// 5) src-tauri/Cargo.lock — the inex-client entry (keeps `cargo --locked` builds happy)
{
  const p = path.join(root, 'src-tauri', 'Cargo.lock');
  if (fs.existsSync(p)) {
    const s = read(p);
    const re = /(name = "inex-client"\r?\nversion = ")([^"]+)(")/;
    const m = s.match(re);
    if (m) { write(p, s.replace(re, (a, b, c, d) => b + ver + d)); log(p, m[2]); }
  }
}

console.log('\nDONE: version is now ' + ver + ' everywhere.');

if (push) {
  const sh = c => { console.log('> ' + c); execSync(c, { cwd: root, stdio: 'inherit' }); };
  sh('git add -A');
  sh('git commit -m "release ' + ver + '"');
  sh('git tag -a v' + ver + ' -m "' + ver + '"');
  sh('git push');
  sh('git push origin v' + ver);
  console.log('\nPushed v' + ver + '. Watch GitHub -> Actions; the release appears in Releases when it finishes.');
} else {
  console.log('Next (manual):  git add -A  ->  git commit -m "release ' + ver + '"  ->  git tag -a v' + ver + ' -m "' + ver + '"  ->  git push  ->  git push origin v' + ver);
}
