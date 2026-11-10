const fs = require('fs');
const { parseZipBuffer } = require('./zipUtils');

function parseVer(v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(n => parseInt(n, 10)) : null;
}

function cmp(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function matchComparator(token, ver) {
  const t = String(token).trim();
  if (!t || t === '*') return true;
  const wild = t.match(/^(\d+(?:\.\d+)*)\.(?:x|\*)$/i);
  if (wild) {
    const p = parseVer(wild[1]);
    return p.every((n, i) => ver[i] === n);
  }
  const m = t.match(/^(>=|<=|>|<|=|~|\^)?\s*(\d+(?:\.\d+)*)/);
  if (!m) return true;
  const op = m[1] || '=';
  const p = parseVer(m[2]);
  const c = cmp(ver, p);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '~': return c >= 0 && cmp(ver, p.length >= 2 ? [p[0], p[1] + 1] : [p[0] + 1]) < 0;
    case '^': return c >= 0 && cmp(ver, [p[0] + 1]) < 0;
    default: return true;
  }
}

function fabricRangeMatches(range, mcVersion) {
  const ver = parseVer(mcVersion);
  if (!ver) return true;
  const alts = Array.isArray(range) ? range : [range];
  for (const alt of alts) {
    for (const orPart of String(alt).split('||')) {
      const tokens = orPart.trim().split(/\s+/).filter(Boolean);
      if (tokens.every(tok => matchComparator(tok, ver))) return true;
    }
  }
  return false;
}

function mavenRangeMatches(range, mcVersion) {
  const ver = parseVer(mcVersion);
  if (!ver) return true;
  const re = /([\[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?))?\s*([\])])/g;
  let m;
  let sawRange = false;
  while ((m = re.exec(String(range))) !== null) {
    sawRange = true;
    const [, open, lo, hi, close] = m;
    if (hi === undefined) {
      const p = parseVer(lo);
      if (p && cmp(ver, p) === 0) return true;
      continue;
    }
    const pl = lo ? parseVer(lo) : null;
    const ph = hi ? parseVer(hi) : null;
    const okLo = !pl || (open === '[' ? cmp(ver, pl) >= 0 : cmp(ver, pl) > 0);
    const okHi = !ph || (close === ']' ? cmp(ver, ph) <= 0 : cmp(ver, ph) < 0);
    if (okLo && okHi) return true;
  }
  if (!sawRange) {
    const p = parseVer(range);
    return p ? cmp(ver, p) >= 0 : true;
  }
  return false;
}

function readEntryText(entries, name) {
  const e = entries.find(x => x.name === name);
  if (!e) return null;
  return e.extractBuffer().toString('utf8').replace(/^\uFEFF/, '');
}

function tomlMinecraftRange(text) {
  const blocks = String(text).split(/\[\[\s*dependencies\.[^\]]*\]\]/);
  for (const b of blocks) {
    if (/modId\s*=\s*["']minecraft["']/.test(b)) {
      const r = b.match(/versionRange\s*=\s*["']([^"']+)["']/);
      if (r) return r[1];
    }
  }
  return null;
}

function inspectHudJar(jarPath) {
  try {
    const entries = parseZipBuffer(fs.readFileSync(jarPath));

    const fabricTxt = readEntryText(entries, 'fabric.mod.json');
    if (fabricTxt) {
      const j = JSON.parse(fabricTxt);
      const dep = j.depends && j.depends.minecraft;
      return { kind: 'fabric', id: j.id, name: j.name || j.id, mcRange: dep === undefined ? null : dep };
    }

    const forgeTxt = readEntryText(entries, 'META-INF/mods.toml');
    if (forgeTxt) {
      return { kind: 'forge', id: (forgeTxt.match(/modId\s*=\s*["']([^"']+)["']/) || [])[1], mcRange: tomlMinecraftRange(forgeTxt) };
    }

    return { kind: null, error: 'no fabric.mod.json / mods.toml inside (not a mod jar)' };
  } catch (err) {
    return { kind: null, error: err.message };
  }
}

const LOADERS_FOR_KIND = {
  fabric: ['fabric'],
  forge: ['forge']
};

function checkHudCompat(info, loader, mcVersion) {
  if (!info || !info.kind) return { ok: false, reason: (info && info.error) || 'not a mod jar' };
  const okLoaders = LOADERS_FOR_KIND[info.kind] || [];
  if (!okLoaders.includes(String(loader))) {
    return { ok: false, reason: `built for ${info.kind}, profile uses ${loader}` };
  }
  if (info.mcRange) {
    const match = info.kind === 'forge'
      ? mavenRangeMatches(info.mcRange, mcVersion)
      : fabricRangeMatches(info.mcRange, mcVersion);
    if (!match) {
      return { ok: false, reason: `supports Minecraft ${Array.isArray(info.mcRange) ? info.mcRange.join(' or ') : info.mcRange}, profile is ${mcVersion}` };
    }
  }
  return { ok: true, reason: '' };
}

module.exports = { inspectHudJar, checkHudCompat, fabricRangeMatches, mavenRangeMatches };