// Low-end / integrated-GPU friendly Minecraft defaults (no mods needed).
// Rules:
//  - runs ONCE per profile (marker file), on its first launch
//  - only for PCs whose ONLY graphics adapter is integrated (Intel UHD/Iris/HD, AMD Radeon Graphics/Vega ...)
//  - only ADDS options that are missing from options.txt, so it never overrides a choice the player already made
//  - dedicated-GPU PCs are never touched
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'inex-lowend-defaults.json';

// Values are the plain options.txt format. Keys a given Minecraft version doesn't know are simply ignored by the game.
const LOW_END_OPTIONS = {
  renderDistance: '6',
  simulationDistance: '6',
  graphicsMode: '0',          // 0 = Fast (1.21.5+)
  fancyGraphics: 'false',     // Fast (older versions)
  particles: '2',             // Minimal
  entityShadows: 'false',
  ao: 'false',                // smooth lighting off
  biomeBlendRadius: '0',
  mipmapLevels: '0',
  cloudStatus: '"off"',
  entityDistanceScaling: '0.75'
};

const DISCRETE_RE = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon\s*rx|radeon\s*pro|\barc\b|firepro|titan/i;

let cachedGpuNames = null;

function detectGpuNames() {
  if (cachedGpuNames) return cachedGpuNames;
  let names = [];
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'], {
        encoding: 'utf8', timeout: 8000, windowsHide: true
      });
      if (r.status === 0 && r.stdout) names = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (_) {}
    if (!names.length) {
      try {
        const r = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        if (r.status === 0 && r.stdout) names = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'name');
      } catch (_) {}
    }
  }
  cachedGpuNames = names;
  return names;
}

// true only when at least one adapter exists and NONE of them is a discrete GPU.
function isIntegratedOnly(names) {
  const real = (names || []).filter(n => !/microsoft basic|remote|virtual|parsec|displaylink|meta virtual/i.test(n));
  if (!real.length) return false;
  return !real.some(n => DISCRETE_RE.test(n));
}

function applyLowEndDefaults(gameDir, { detect = detectGpuNames } = {}) {
  const result = { applied: false, skipped: null, gpus: [], added: [] };
  if (!gameDir) { result.skipped = 'no-gamedir'; return result; }
  const marker = path.join(gameDir, MARKER);
  if (fs.existsSync(marker)) { result.skipped = 'already-done'; return result; }

  fs.mkdirSync(gameDir, { recursive: true });
  const gpus = detect();
  result.gpus = gpus;
  const integrated = isIntegratedOnly(gpus);

  if (integrated) {
    const optionsPath = path.join(gameDir, 'options.txt');
    let text = '';
    try { if (fs.existsSync(optionsPath)) text = fs.readFileSync(optionsPath, 'utf8'); } catch (_) {}
    const have = new Set(text.split(/\r?\n/).map(l => l.split(':')[0].trim()).filter(Boolean));
    const lines = [];
    for (const [k, v] of Object.entries(LOW_END_OPTIONS)) {
      if (!have.has(k)) { lines.push(`${k}:${v}`); result.added.push(k); }
    }
    if (lines.length) {
      const base = text.trim() ? text.replace(/\s*$/, '\n') : '';
      fs.writeFileSync(optionsPath, base + lines.join('\n') + '\n', 'utf8');
    }
    result.applied = true;
  } else {
    result.skipped = gpus.length ? 'dedicated-gpu' : 'gpu-unknown';
  }

  try {
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), gpus, integrated, added: result.added }, null, 2), 'utf8');
  } catch (_) {}
  return result;
}

module.exports = { applyLowEndDefaults, isIntegratedOnly, detectGpuNames, LOW_END_OPTIONS };
