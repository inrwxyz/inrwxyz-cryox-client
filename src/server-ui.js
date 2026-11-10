/**
 * CRYOX CLIENT — Server Hosting UI (Complete File)
 * - Supports Vanilla, Paper, Purpur, and Fabric servers
 * - Play-style Hero Hub (Top-left clean Server List + Right 4 Spec Tiles + Big Start/Stop Bar + 3 Quick Buttons)
 * - Network & Playit Tab simplified to ONE unified Playit.gg card showing real Java IP & Port + Bedrock IP & Port
 * - Properties Tab with "End dimension", working switches, live in-game sync & right-aligned Save Properties button
 */
(function () {
  'use strict';

  const api = window.inexAPI || {};
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (name, cls = 'ico-sm') => `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;

  const LOG_LIMIT = 2000;

  const LOADER_INFO = {
    vanilla: { label: 'Vanilla', note: 'Official Mojang server. No plugins or mods.' },
    paper: { label: 'Paper', note: 'Fast and stable. Best for Spigot/Paper plugins & Bedrock crossplay.' },
    purpur: { label: 'Purpur', note: 'High-performance Paper fork with extra features & plugin support.' },
    fabric: { label: 'Fabric', note: 'Lightweight mod loader for Fabric server mods & Bedrock crossplay.' }
  };
  const STATUS_LABEL = { offline: 'Offline', starting: 'Starting...', online: 'Online', stopping: 'Stopping...' };

  const PROP_GROUPS = [
    {
      title: 'Gameplay',
      fields: [
        { key: 'gamemode', label: 'Default gamemode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
        { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
        { key: 'pvp', label: 'PvP Combat', type: 'bool' },
        { key: 'hardcore', label: 'Hardcore mode', type: 'bool', hint: 'Only applies when a NEW world is created.' },
        { key: 'allow-flight', label: 'Allow flight', type: 'bool' },
        { key: 'allow-nether', label: 'Nether dimension', type: 'bool' },
        { key: 'allow-end', label: 'End dimension', type: 'bool' },
        { key: 'spawn-monsters', label: 'Spawn monsters', type: 'bool' },
        { key: 'enable-command-block', label: 'Command blocks', type: 'bool' },
        { key: 'spawn-animals', label: 'Spawn animals', type: 'bool' },
        { key: 'spawn-npcs', label: 'Spawn villagers (NPCs)', type: 'bool' },
        { key: 'generate-structures', label: 'Generate structures', type: 'bool' },
        { key: 'force-gamemode', label: 'Force default gamemode on join', type: 'bool' }
      ]
    },
    {
      title: 'General',
      fields: [
        { key: 'motd', label: 'Server description (MOTD)', type: 'text', wide: true },
        { key: 'max-players', label: 'Max players', type: 'number', min: 1, max: 1000 },
        { key: 'server-port', label: 'Port', type: 'number', min: 1024, max: 65535 },
        { key: 'level-seed', label: 'World seed', type: 'text' },
        { key: 'view-distance', label: 'View distance (chunks)', type: 'number', min: 3, max: 32 },
        { key: 'simulation-distance', label: 'Simulation distance (chunks)', type: 'number', min: 3, max: 32 },
        { key: 'spawn-protection', label: 'Spawn protection radius', type: 'number', min: 0, max: 1000 },
        { key: 'player-idle-timeout', label: 'Idle kick timeout (minutes, 0 = off)', type: 'number', min: 0, max: 100000 }
      ]
    },
    {
      title: 'Access & Security',
      fields: [
        { key: 'online-mode', label: 'Online mode (premium only)', type: 'bool', hint: 'Keep OFF so local/offline X accounts and Bedrock players can join.' },
        { key: 'white-list', label: 'Whitelist enabled', type: 'bool' },
        { key: 'enforce-whitelist', label: 'Kick non-whitelisted players live', type: 'bool' },
        { key: 'enforce-secure-profile', label: 'Require signed chat (secure profile)', type: 'bool', hint: 'Keep OFF for offline X accounts.' },
        { key: 'enable-status', label: 'Show server in multiplayer list', type: 'bool' },
        { key: 'hide-online-players', label: 'Hide online player list', type: 'bool' },
        { key: 'op-permission-level', label: 'OP permission level', type: 'select', options: ['1', '2', '3', '4'] }
      ]
    }
  ];

  const BOOL_DEFAULTS = {
    pvp: 'true',
    hardcore: 'false',
    'allow-flight': 'false',
    'allow-nether': 'true',
    'allow-end': 'true',
    'spawn-monsters': 'true',
    'enable-command-block': 'true',
    'online-mode': 'false',
    'white-list': 'false',
    'spawn-animals': 'true',
    'spawn-npcs': 'true',
    'generate-structures': 'true',
    'force-gamemode': 'false',
    'enforce-whitelist': 'false',
    'enforce-secure-profile': 'false',
    'enable-status': 'true',
    'hide-online-players': 'false',
    'view-distance': '10',
    'simulation-distance': '10',
    'spawn-protection': '16',
    'player-idle-timeout': '0',
    'op-permission-level': '4'
  };

  const TABS = [
    { key: 'console', label: 'Console', icon: 'terminal' },
    { key: 'players', label: 'Players', icon: 'user' },
    { key: 'addons', label: 'Plugins & Mods', icon: 'cube' },
    { key: 'files', label: 'Files & Editor', icon: 'folder' },
    { key: 'network', label: 'Network', icon: 'compass' },
    { key: 'properties', label: 'Properties', icon: 'sliders' }
  ];

  const S = {
    servers: [],
    selectedId: null,
    mode: 'hub', // 'hub' | 'detail' | 'create'
    tab: 'console',
    logs: new Map(),
    history: [],
    historyIdx: -1,
    versionsCache: {},
    create: { loader: 'paper', version: '', ramGb: 4, creating: false, progress: null, playit: true, bedrock: true, eula: true },
    progress: null,
    memory: { totalMb: 8192, freeMb: 4096 },
    timer: null,
    inited: false,
    network: new Map(),
    playit: { status: 'off', message: '', claimUrl: '', tunnels: {}, linked: false, sharing: [] },
    playersTimer: null,
    installing: false,
    editorPath: null,
    currentFilesDir: '',
    addonsMode: 'browse',
    addonsQuery: '',
    addonsSort: 'downloads',
    addonsOffset: 0,
    addonsLimit: 15,
    addonsTotal: 0,
    addonsHits: [],
    addonsInstalled: [],
    addonsStrictVer: true
  };

  const gb = mb => (mb / 1024).toFixed(mb % 1024 ? 1 : 0);
  const tunnelOf = id => (S.playit.tunnels || {})[id] || null;
  const publicJava = id => {
    const t = tunnelOf(id);
    const disp = t && t.java ? t.java.display : '';
    if (!disp || /^localhost\b|^127\./i.test(disp)) return '';
    return disp;
  };
  const publicBedrock = id => {
    const t = tunnelOf(id);
    const b = t && t.bedrock ? t.bedrock : null;
    if (!b || !b.host || /^localhost\b|^127\./i.test(b.host)) return null;
    return b;
  };

  function injectCustomStyles() {
    let style = $('inex-srv-hero-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'inex-srv-hero-css';
      document.head.appendChild(style);
    }
    style.textContent = `
      .toast-container {
        position: fixed; right: 24px; bottom: 24px; z-index: 9999;
        display: flex; flex-direction: column; gap: 10px; pointer-events: none;
      }
      .toast-item {
        min-width: 240px; max-width: 380px; padding: 11px 16px; border-radius: 12px;
        background: rgba(10, 10, 10, 0.96); border: 1px solid rgba(255, 255, 255, 0.14);
        border-left: 4px solid var(--crimson-500); color: #fff; font-size: 12.5px; font-weight: 700;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65); backdrop-filter: blur(16px);
        pointer-events: auto; animation: inexToastIn 0.2s ease-out;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast-item.leaving { opacity: 0; transform: translateY(8px); }
      @keyframes inexToastIn {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #view-server[data-srv-mode="hub"] > .section-header-row { display: none !important; }
      .srv-hero-frame {
        flex: 1; position: relative; border-radius: 22px; padding: 26px 38px 26px 26px;
        display: flex; align-items: stretch; justify-content: space-between;
        background: #030303;
        border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.5);
        min-height: 0; overflow: hidden;
      }
      .srv-hero-grid {
        width: 100%; height: 100%; display: grid;
        grid-template-columns: 280px minmax(0, 1fr); gap: 42px; align-items: center;
      }
      .srv-left-list-col {
        align-self: start; display: flex; flex-direction: column; width: 100%; max-height: 100%;
        padding: 2px 0 0 2px; background: transparent !important; border: none !important;
        box-shadow: none !important; gap: 10px; min-height: 0;
      }
      .srv-left-head { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 6px 2px; }
      .srv-left-title {
        font-family: var(--font-display); font-size: 12px; font-weight: 900; letter-spacing: 0.14em;
        color: var(--text-secondary); text-transform: uppercase; display: flex; align-items: center; gap: 8px;
      }
      .srv-left-scroll {
        flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; min-height: 0;
      }
      .srv-list-card {
        display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 12px;
        background: rgba(12, 12, 12, 0.72); border: 1px solid rgba(255, 255, 255, 0.08); cursor: pointer; transition: 0.16s;
      }
      .srv-list-card:hover { border-color: rgba(225, 29, 72, 0.6); background: rgba(16, 16, 16, 0.88); box-shadow: 0 0 0 1px rgba(255,255,255,.10), 0 0 16px rgba(225,29,72,.26), 0 0 34px rgba(225,29,72,.10); }
      .srv-list-card.active { border-color: rgba(255, 255, 255, 0.30); background: rgba(255, 255, 255, 0.06); }
      .srv-list-badge {
        width: 34px; height: 34px; border-radius: 9px; background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.14); display: flex; align-items: center; justify-content: center;
        font-weight: 900; font-size: 12.5px; color: #e4e4ec; flex-shrink: 0;
      }
      .srv-list-badge img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; image-rendering: pixelated; display: block; }
      .srv-list-badge.has-logo { background: transparent; padding: 0; overflow: hidden; }
      .srv-logo-drop {
        display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 14px; cursor: pointer;
        border: 1.5px dashed rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.03); transition: 0.15s;
      }
      .srv-logo-drop:hover, .srv-logo-drop.over { border-color: rgba(225, 29, 72, 0.6); background: rgba(255, 255, 255, 0.05); }
      .srv-logo-prev {
        width: 64px; height: 64px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden; color: var(--text-muted); font-size: 24px;
      }
      .srv-logo-prev img { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
      .srv-logo-txt strong { display: block; font-size: 13px; color: #fff; }
      .srv-logo-txt small { font-size: 11.5px; color: var(--text-secondary); }
      .srv-list-info { flex: 1; min-width: 0; }
      .srv-list-name { font-size: 13px; font-weight: 800; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .srv-list-sub { font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
      .srv-prop-bool { cursor: pointer; transition: border-color 0.15s, background 0.15s; }
      .srv-prop-bool:hover { border-color: rgba(225, 29, 72, 0.6); background: rgba(255, 255, 255, 0.06); }
      .srv-props-save {
        display: flex; align-items: center; justify-content: space-between; gap: 14px;
        position: sticky; bottom: 0; padding: 12px 6px 6px 4px;
        background: rgba(7, 7, 7, 0.96); border-top: 1px solid var(--border-subtle);
      }
      .srv-props-save-right { display: flex; align-items: center; gap: 12px; margin-right: 4px; }
      .srv-saved-Floater {
        display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 9px;
        background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.22); color: #e8e8ee;
        font-size: 12px; font-weight: 800; opacity: 0; transform: translateX(8px);
        transition: opacity 0.2s ease, transform 0.2s ease; pointer-events: none;
      }
      .srv-saved-Floater.show { opacity: 1; transform: translateX(0); }
      .srv-mini-bar { width: 100%; height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; margin-top: 4px; }
      .srv-mini-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--crimson-500), var(--crimson-400)); transition: width 0.3s ease; }
      .srv-loaders-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 6px; }
      @media (max-width: 980px) {
        .srv-hero-grid { grid-template-columns: 1fr; gap: 20px; }
        .srv-left-list-col { max-height: 180px; }
        .srv-loaders-4 { grid-template-columns: repeat(2, 1fr); }
      }
    `;
  }

  function toast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const text = String(message && message.message ? message.message : message || '')
      .replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
    if (!text) return;
    const item = document.createElement('div');
    item.className = 'toast-item';
    if (type === 'error') item.style.borderLeftColor = '#ef4444';
    else if (type === 'success') item.style.borderLeftColor = '#10b981';
    else if (type === 'warning') item.style.borderLeftColor = '#f59e0b';
    item.textContent = text;
    container.appendChild(item);
    while (container.children.length > 3) container.firstChild.remove();
    setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 220); }, type === 'error' ? 5000 : 2800);
  }

  function copyText(text, label = 'Copied to clipboard.') {
    if (!text) return;
    try { api.writeClipboardText(String(text)); toast(label, 'success'); } catch (_) {}
  }

  function fmtUptime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s` : `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  function formatCompact(num) {
    const n = Number(num) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function selected() {
    if (S.selectedId) {
      const found = S.servers.find(s => s.id === S.selectedId);
      if (found) return found;
    }
    const running = S.servers.find(s => s.status === 'online' || s.status === 'starting');
    if (running) {
      S.selectedId = running.id;
      return running;
    }
    if (S.servers.length) {
      S.selectedId = S.servers[0].id;
      return S.servers[0];
    }
    return null;
  }

  function renderMain() {
    const main = $('srvMain');
    const sec = $('view-server');
    if (!main) return;
    if (sec) sec.setAttribute('data-srv-mode', S.mode);
    if (S.mode === 'create') return renderCreate(main);
    const srv = selected();
    if (S.mode === 'detail' && srv) return renderDetail(main, srv);
    S.mode = 'hub';
    if (sec) sec.setAttribute('data-srv-mode', 'hub');
    renderHub(main);
  }

  function actionButtons(srv) {
    const st = srv.status;
    if (st === 'offline' || st === 'stopped') {
      return `<button type="button" class="btn btn-launch" data-act="start" data-id="${esc(srv.id)}">${ico('play')}Start Server</button>`;
    }
    if (st === 'starting') {
      return `<button type="button" class="btn btn-danger" data-act="kill" data-id="${esc(srv.id)}">${ico('power')}Stop</button>`;
    }
    if (st === 'online') {
      return `
        <button type="button" class="btn glass-btn" data-act="restart" data-id="${esc(srv.id)}">${ico('refresh')}Restart</button>
        <button type="button" class="btn btn-danger" data-act="stop" data-id="${esc(srv.id)}">${ico('power')}Stop</button>`;
    }
    return `<button type="button" class="btn btn-danger" data-act="kill" data-id="${esc(srv.id)}">${ico('ban')}Force Stop</button>`;
  }

  // ==================== 1. PLAY-STYLE SERVER MAIN MENU (HUB) ====================
  function renderHub(main) {
    if (!S.servers.length) {
      main.innerHTML = `
        <div class="srv-hero-frame" style="align-items:center; justify-content:center;">
          <span class="frame-corner tl"></span>
          <span class="frame-corner br"></span>
          <div style="max-width:560px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:14px;">
            <div class="srv-empty-ico" style="width:68px; height:68px; border-radius:20px;">${ico('server', 'ico-lg')}</div>
            <h1 class="home-brand-title" style="font-size:30px;">X <span>SERVERS</span></h1>
            <p style="color:var(--text-secondary); font-size:13.5px; line-height:1.5;">
              Host your own Paper, Purpur, Fabric, or Vanilla Minecraft server in one click. Automatic Java setup, Playit.gg public IP tunneling, and Bedrock crossplay included.
            </p>
            <button type="button" class="btn btn-launch" id="srvEmptyCreate" style="padding:13px 28px; font-size:14px; margin-top:4px;">
              ${ico('plus')}Create Your First Server
            </button>
          </div>
        </div>`;
      $('srvEmptyCreate').addEventListener('click', openCreate);
      return;
    }

    const srv = selected();
    const info = LOADER_INFO[srv.loader] || { label: srv.loader };
    const isLive = srv.status === 'online' || srv.status === 'starting';
    const cpuPct = isLive ? Math.min(100, Math.max(0, Number(srv.cpu || 0))) : 0;
    const ramMb = isLive ? Math.max(0, Number(srv.usedRamMb || 0)) : 0;
    const pubJava = publicJava(srv.id);
    const pubBed = publicBedrock(srv.id);
    const bedInfo = srv.bedrock || {};
    const hasBedrock = Boolean(bedInfo.geyser || pubBed);

    const serverListHtml = S.servers.map(s => {
      const lInfo = LOADER_INFO[s.loader] || { label: s.loader };
      const isSel = s.id === srv.id;
      const pCount = Array.isArray(s.players) ? s.players.length : 0;
      const statusText = s.status === 'online'
        ? `${pCount}/${s.maxPlayers} Online`
        : (STATUS_LABEL[s.status] || s.status);
      return `
        <div class="srv-list-card${isSel ? ' active' : ''}" data-select-srv="${esc(s.id)}">
          <div class="srv-list-badge${s.logo ? ' has-logo' : ''}">${s.logo ? `<img src="${esc(s.logo)}" alt="" />` : esc(lInfo.label.charAt(0).toUpperCase())}</div>
          <div class="srv-list-info">
            <div class="srv-list-name">${esc(s.name)}</div>
            <div class="srv-list-sub">
              <span class="srv-dot ${esc(s.status)}"></span>
              <span>${esc(lInfo.label)} ${esc(s.version)} &bull; ${esc(statusText)}</span>
            </div>
          </div>
        </div>`;
    }).join('');

    let tunnelHint = pubJava
      ? `Public IP: ${pubJava}${pubBed ? ` • Bedrock: ${pubBed.host}:${pubBed.port}` : ''}`
      : (S.playit.status === 'downloading' || S.playit.status === 'starting' || S.playit.status === 'linking'
        ? (S.playit.message || 'Connecting to Playit.gg tunnel...')
        : (isLive ? 'Connecting tunnel...' : 'Start server to activate the public IP'));

    main.innerHTML = `
      <div class="srv-hero-frame">
        <span class="frame-corner tl"></span>
        <span class="frame-corner br"></span>

        <div class="srv-hero-grid">
          <div class="srv-left-list-col">
            <div class="srv-left-head">
              <div class="srv-left-title"><span class="red-dot"></span>SERVERS (${S.servers.length})</div>
              <button type="button" class="btn btn-sm btn-launch" id="srvHubNewTopBtn">${ico('plus', 'ico-xs')}New</button>
            </div>
            <div class="srv-left-scroll">${serverListHtml}</div>
          </div>

          <div class="home-right-col" style="max-width:640px; justify-self:center;">
            <div class="home-specs-grid">
              <div class="spec-tile">
                <span class="spec-bar"></span>
                <div class="spec-body">
                  <span class="spec-label">SERVER NAME &amp; STATUS:</span>
                  <strong id="hubNameBadge">${esc(srv.name)} &bull; ${esc(STATUS_LABEL[srv.status] || srv.status)}</strong>
                </div>
              </div>

              <div class="spec-tile">
                <span class="spec-bar"></span>
                <div class="spec-body">
                  <span class="spec-label">VERSION &amp; LOADER:</span>
                  <strong id="hubVerBadge">${esc(info.label)} ${esc(srv.version)}${hasBedrock ? ' + Bedrock' : ''}</strong>
                </div>
              </div>

              <div class="spec-tile">
                <span class="spec-bar"></span>
                <div class="spec-body">
                  <span class="spec-label">PLAYERS ONLINE:</span>
                  <strong id="hubPlayersBadge">${srv.status === 'online' ? `${srv.players.length} / ${srv.maxPlayers} Players` : `0 / ${srv.maxPlayers} (Offline)`}</strong>
                </div>
              </div>

              <div class="spec-tile">
                <span class="spec-bar"></span>
                <div class="spec-body">
                  <span class="spec-label">CPU &amp; RAM USAGE:</span>
                  <strong id="hubCpuRamBadge">${isLive ? `${cpuPct.toFixed(1)}% CPU &bull; ${ramMb} / ${srv.ramMb} MB` : `0% CPU &bull; ${gb(srv.ramMb)} GB Allocated`}</strong>
                </div>
              </div>
            </div>

            <div class="launch-cluster">
              <div class="launch-split-box${isLive ? ' running' : ''}" id="hubLaunchBox">
                <button type="button" class="launch-main-btn" id="hubStartStopBtn">
                  <span class="launch-text">
                    <span class="launch-main-title" id="hubMainBtnTitle">${isLive ? 'STOP SERVER' : 'START SERVER'}</span>
                    <span class="launch-main-sub" id="hubMainBtnSub">${esc(srv.name)} &bull; ${esc(info.label)} ${esc(srv.version)}</span>
                    <span class="launch-main-hint" id="hubMainBtnHint">${esc(tunnelHint)}</span>
                  </span>
                </button>
                <button type="button" class="launch-dropdown-trigger" id="hubCopyIpBtn" title="Copy public IP">
                  ${ico('data', 'ico-sm')}
                </button>
              </div>

              <div class="home-quick-profiles">
                <button type="button" class="quick-profile-pill active" id="hubOpenManageBtn">
                  ${ico('terminal', 'ico-xs')}
                  <span>Console &amp; Manage</span>
                </button>
                <button type="button" class="quick-profile-pill" id="hubOpenAddonsBtn">
                  ${ico('cube', 'ico-xs')}
                  <span>Plugins &amp; Mods</span>
                </button>
                <button type="button" class="quick-profile-pill" id="hubOpenPlayersBtn">
                  ${ico('user', 'ico-xs')}
                  <span>Players &amp; Settings</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    $('srvHubNewTopBtn').addEventListener('click', openCreate);

    main.querySelectorAll('[data-select-srv]').forEach(card => {
      card.addEventListener('click', () => {
        S.selectedId = card.getAttribute('data-select-srv');
        renderHub(main);
      });
      card.addEventListener('dblclick', () => {
        openDetail(card.getAttribute('data-select-srv'), 'console');
      });
    });

    $('hubStartStopBtn').addEventListener('click', () => {
      if (srv.status === 'offline' || srv.status === 'stopped') runAction('start', srv.id);
      else if (srv.status === 'stopping' || srv.status === 'starting') runAction('kill', srv.id);
      else runAction('stop', srv.id);
    });

    $('hubCopyIpBtn').addEventListener('click', e => {
      e.stopPropagation();
      const currentPub = publicJava(srv.id);
      if (!currentPub) {
        openDetail(srv.id, 'network');
        return;
      }
      copyText(currentPub, `Copied Public IP: ${currentPub}`);
    });

    $('hubOpenManageBtn').addEventListener('click', () => openDetail(srv.id, 'console'));
    $('hubOpenAddonsBtn').addEventListener('click', () => openDetail(srv.id, 'addons'));
    $('hubOpenPlayersBtn').addEventListener('click', () => openDetail(srv.id, 'players'));
  }

  async function openDetail(id, initialTab = 'console') {
    S.selectedId = id;
    S.mode = 'detail';
    S.tab = initialTab;
    renderMain();
    if (!S.logs.has(id)) {
      try {
        const lines = await api.getServerLog(id);
        S.logs.set(id, (lines || []).map(line => ({ line, stream: 'out' })));
        if (id === S.selectedId && S.tab === 'console' && S.mode === 'detail') renderBody();
      } catch (_) {}
    }
  }

  function backToHub() {
    S.mode = 'hub';
    clearTimeout(S.playersTimer);
    renderMain();
  }

  // ==================== 2. SERVER DETAIL VIEW ====================
  function renderDetail(main, srv) {
    const info = LOADER_INFO[srv.loader] || { label: srv.loader };
    const addonLabel = srv.loader === 'fabric' ? 'Fabric Mods' : 'Plugins & Mods';
    const pubJava = publicJava(srv.id);

    main.innerHTML = `
      <div class="srv-detail glass-panel">
        <div class="srv-head">
          <div class="srv-head-title">
            <button type="button" class="btn btn-sm glass-btn" id="srvBack" style="color:#fff;">
              ${ico('back')}Back to Server Menu
            </button>
            <h3>${esc(srv.name)}</h3>
            <span class="srv-badge">${esc(info.label)} ${esc(srv.version)}</span>
            <span class="srv-status ${esc(srv.status)}" id="srvStatusPill">${STATUS_LABEL[srv.status] || srv.status}</span>
          </div>
          <div class="srv-actions" id="srvActions">${actionButtons(srv)}</div>
        </div>

        <div class="srv-progress" id="srvProgress" style="display:none;">
          <span id="srvProgressText"></span>
          <div class="progress-track"><div class="progress-fill" id="srvProgressFill"></div></div>
        </div>

        <div class="srv-stats">
          <div class="srv-stat" style="cursor:pointer;" id="srvAddrCard" title="Click to copy public IP or open Network tab">
            <span id="srvAddrLabel">${pubJava ? 'PUBLIC IP' : 'PUBLIC TUNNEL'}</span>
            <strong id="srvAddr">${esc(pubJava || 'Not connected (Click to setup)')}</strong>
            <button type="button" class="srv-copy" id="srvCopy" title="Copy Address">${ico('data', 'ico-xs')}</button>
          </div>
          <div class="srv-stat" style="cursor:pointer;" id="srvPlayersStatCard" title="Click to open Players tab">
            <span>PLAYERS ONLINE</span>
            <strong id="srvPlayersStat">0 / ${esc(srv.maxPlayers)}</strong>
          </div>
          <div class="srv-stat">
            <span>LIVE CPU &amp; RAM USAGE</span>
            <strong id="srvCpuRamStat">0% CPU &bull; 0 / ${esc(srv.ramMb)} MB</strong>
            <div class="srv-mini-bar"><div class="srv-mini-fill" id="srvHeaderRamBar" style="width:0%"></div></div>
          </div>
          <div class="srv-stat">
            <span>UPTIME</span>
            <strong id="srvUptime">--</strong>
          </div>
        </div>

        <div class="srv-tabs">
          ${TABS.map(t => {
            const lbl = t.key === 'addons' ? addonLabel : t.label;
            return `<button type="button" class="type-pill-btn${S.tab === t.key ? ' active' : ''}" data-tab="${t.key}">${ico(t.icon)}${lbl}</button>`;
          }).join('')}
          <span class="srv-tabs-spacer"></span>
          <button type="button" class="btn btn-sm glass-btn" id="srvOpenFolderBtn" title="Open Server Folder in Explorer">${ico('folder', 'ico-xs')}Folder</button>
          <button type="button" class="srv-danger" id="srvDelete" title="Delete server">${ico('trash')}Delete</button>
        </div>
        <div class="srv-body" id="srvBody"></div>
      </div>`;

    $('srvBack').addEventListener('click', backToHub);
    $('srvAddrCard').addEventListener('click', () => {
      const currentPub = publicJava(srv.id);
      if (currentPub) {
        copyText(currentPub, `Copied Public IP: ${currentPub}`);
      } else {
        S.tab = 'network';
        main.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.getAttribute('data-tab') === 'network'));
        renderBody();
      }
    });
    $('srvPlayersStatCard').addEventListener('click', () => {
      S.tab = 'players';
      main.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.getAttribute('data-tab') === 'players'));
      renderBody();
    });
    main.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      const topSave = $('srvPropsSaveTop');
      if (topSave && b.getAttribute('data-tab') !== 'properties') topSave.remove();
      S.tab = b.getAttribute('data-tab');
      main.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
      renderBody();
    }));
    $('srvCopy').addEventListener('click', e => {
      e.stopPropagation();
      const currentPub = publicJava(srv.id);
      if (currentPub) copyText(currentPub, `Copied Public IP: ${currentPub}`);
      else toast('Connect Playit.gg in the Network tab first.', 'info');
    });
    $('srvOpenFolderBtn').addEventListener('click', () => {
      if (api.openServerFolder) api.openServerFolder(srv.id).catch(() => {});
    });
    $('srvDelete').addEventListener('click', onDelete);
    bindActions();
    updateHeader();
    renderBody();
  }

  function updateHeader() {
    const srv = selected();
    if (!srv) return;

    const isLive = srv.status === 'online' || srv.status === 'starting';
    const cpuPct = isLive ? Math.min(100, Math.max(0, Number(srv.cpu || 0))) : 0;
    const ramMb = isLive ? Math.max(0, Number(srv.usedRamMb || 0)) : 0;
    const ramPct = srv.ramMb ? Math.min(100, Math.round((ramMb / srv.ramMb) * 100)) : 0;
    const pCount = Array.isArray(srv.players) ? srv.players.length : 0;
    const pubJava = publicJava(srv.id);
    const pubBed = publicBedrock(srv.id);

    if (S.mode === 'hub') {
      const nBadge = $('hubNameBadge');
      if (nBadge) nBadge.textContent = `${srv.name} • ${STATUS_LABEL[srv.status] || srv.status}`;
      const pBadge = $('hubPlayersBadge');
      if (pBadge) pBadge.textContent = srv.status === 'online' ? `${pCount} / ${srv.maxPlayers} Players` : `0 / ${srv.maxPlayers} (Offline)`;
      const crBadge = $('hubCpuRamBadge');
      if (crBadge) crBadge.textContent = isLive ? `${cpuPct.toFixed(1)}% CPU • ${ramMb} / ${srv.ramMb} MB` : `0% CPU • ${gb(srv.ramMb)} GB Allocated`;
      const lBox = $('hubLaunchBox');
      if (lBox) lBox.classList.toggle('running', isLive);
      const bTitle = $('hubMainBtnTitle');
      if (bTitle) bTitle.textContent = isLive ? 'STOP SERVER' : 'START SERVER';
      const bHint = $('hubMainBtnHint');
      if (bHint) {
        if (pubJava) {
          bHint.textContent = `Public IP: ${pubJava}${pubBed ? ` • Bedrock: ${pubBed.host}:${pubBed.port}` : ''}`;
        } else if (S.playit.status === 'downloading' || S.playit.status === 'starting' || S.playit.status === 'linking') {
          bHint.textContent = S.playit.message || 'Connecting to Playit.gg tunnel...';
        } else {
          bHint.textContent = isLive ? 'Connecting tunnel...' : 'Start server to activate the public IP';
        }
      }
      return;
    }

    if (S.mode !== 'detail') return;
    const pill = $('srvStatusPill');
    if (pill) { pill.className = `srv-status ${srv.status}`; pill.textContent = STATUS_LABEL[srv.status] || srv.status; }
    const actions = $('srvActions');
    if (actions && actions.dataset.status !== srv.status) {
      actions.dataset.status = srv.status;
      actions.innerHTML = actionButtons(srv);
      bindActions();
    }
    const pl = $('srvPlayersStat');
    if (pl) {
      pl.textContent = srv.status === 'online' ? `${pCount} / ${srv.maxPlayers} Online` : `0 / ${srv.maxPlayers} (Offline)`;
    }
    const cpuRam = $('srvCpuRamStat');
    if (cpuRam) {
      cpuRam.textContent = isLive
        ? `${cpuPct.toFixed(1)}% CPU • ${ramMb} / ${srv.ramMb} MB (${ramPct}%)`
        : `0% CPU • 0 / ${srv.ramMb} MB`;
    }
    const ramBar = $('srvHeaderRamBar');
    if (ramBar) ramBar.style.width = `${ramPct}%`;

    const addr = $('srvAddr'), label = $('srvAddrLabel');
    if (addr) {
      if (pubJava) {
        addr.textContent = pubBed ? `${pubJava} | Bedrock: ${pubBed.host}:${pubBed.port}` : pubJava;
        if (label) label.textContent = 'PUBLIC IP (LIVE)';
      } else if (S.playit.status === 'downloading' || S.playit.status === 'starting' || S.playit.status === 'linking') {
        addr.textContent = S.playit.message || 'Connecting Playit.gg...';
        if (label) label.textContent = 'PUBLIC TUNNEL';
      } else {
        addr.textContent = 'Not connected (Open Network tab)';
        if (label) label.textContent = 'PUBLIC TUNNEL';
      }
    }
    const up = $('srvUptime');
    if (up) { const sMs = typeof srv.startedAt === 'string' ? Date.parse(srv.startedAt) : Number(srv.startedAt); up.textContent = isLive && sMs && !isNaN(sMs) ? fmtUptime(Date.now() - sMs) : '--'; }
    const cmd = $('srvCmdInput');
    if (cmd) {
      cmd.disabled = !isLive;
      cmd.placeholder = isLive ? 'Type a server command (without /), e.g. op PlayerName, gamemode creative...' : 'Start the server to run console commands';
      const send = $('srvCmdSend');
      if (send) send.disabled = !isLive;
    }
    const prog = $('srvProgress');
    if (prog) {
      const p = S.progress && S.progress.id === srv.id && (srv.status === 'starting' || S.installing) ? S.progress : null;
      prog.style.display = p ? 'flex' : 'none';
      if (p) {
        $('srvProgressText').textContent = p.stage || p.detail || 'Working...';
        $('srvProgressFill').style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
      }
    }
  }

  function renderBody() {
    { const t = $('srvPropsSaveTop'); if (t && S.tab !== 'properties') t.remove(); }
    const body = $('srvBody');
    if (!body) return;
    clearTimeout(S.playersTimer);
    if (S.tab === 'properties') return renderProperties(body);
    if (S.tab === 'players') return renderPlayers(body);
    if (S.tab === 'addons') return renderAddons(body);
    if (S.tab === 'files') return renderFiles(body);
    if (S.tab === 'network') return renderNetwork(body);
    renderConsole(body);
  }

  // ==================== 3. CONSOLE TAB ====================
  function renderConsole(body) {
    body.innerHTML = `
      <div class="srv-console" id="srvConsole"></div>
      <div class="srv-cmd">
        <input type="text" class="inex-input glass-input" id="srvCmdInput" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn btn-crimson" id="srvCmdSend">${ico('next')}Send Command</button>
      </div>`;
    const box = $('srvConsole');
    const lines = S.logs.get(S.selectedId) || [];
    const frag = document.createDocumentFragment();
    lines.forEach(l => frag.appendChild(lineEl(l)));
    box.appendChild(frag);
    if (!lines.length) box.innerHTML = '<div class="srv-console-empty">Console logs appear here once the server starts.</div>';
    box.scrollTop = box.scrollHeight;
    const input = $('srvCmdInput');
    const send = () => {
      const v = input.value.trim().replace(/^\/+/, '');
      if (!v) return;
      S.history.push(v); S.historyIdx = S.history.length;
      input.value = '';
      api.sendServerCommand(S.selectedId, v).catch(err => toast(err, 'error'));
    };
    $('srvCmdSend').addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') send();
      else if (e.key === 'ArrowUp' && S.history.length) { S.historyIdx = Math.max(0, S.historyIdx - 1); input.value = S.history[S.historyIdx] || ''; e.preventDefault(); }
      else if (e.key === 'ArrowDown' && S.history.length) { S.historyIdx = Math.min(S.history.length, S.historyIdx + 1); input.value = S.history[S.historyIdx] || ''; e.preventDefault(); }
    });
    updateHeader();
  }

  function lineEl(entry) {
    const div = document.createElement('div');
    let cls = 'srv-line';
    if (entry.stream === 'err') cls += ' err';
    else if (entry.stream === 'sys') cls += ' sys';
    else if (entry.stream === 'cmd') cls += ' cmd';
    else if (/\/ERROR\]|Exception|\bSEVERE\b/.test(entry.line)) cls += ' err';
    else if (/\/WARN\]/.test(entry.line)) cls += ' warn';
    div.className = cls;
    div.textContent = entry.line;
    return div;
  }

  function pushLog(id, entry) {
    let arr = S.logs.get(id);
    if (!arr) { arr = []; S.logs.set(id, arr); }
    arr.push(entry);
    if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
    if (id === S.selectedId && S.mode === 'detail' && S.tab === 'console') {
      const box = $('srvConsole');
      if (!box) return;
      if (box.querySelector('.srv-console-empty')) box.innerHTML = '';
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      box.appendChild(lineEl(entry));
      while (box.childElementCount > LOG_LIMIT) box.firstChild.remove();
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
  }

  // ==================== 4. PLAYERS TAB ====================
  function playerRow(name, { badge = '', sub = '', buttons = [] } = {}) {
    return `
      <div class="srv-prow">
        <div class="srv-pavatar">${esc(name.replace(/^\./, '').charAt(0).toUpperCase() || '?')}</div>
        <div class="srv-ptext">
          <strong>${esc(name)}</strong>
          ${badge ? `<span class="srv-pbadge">${esc(badge)}</span>` : ''}
          ${sub ? `<small>${esc(sub)}</small>` : ''}
        </div>
        <div class="srv-pbtns">
          ${buttons.map(b => `<button type="button" class="btn btn-sm ${b.primary ? 'btn-crimson' : 'glass-btn'}${b.danger ? ' srv-pdanger' : ''}" data-pa="${b.act}" data-pn="${esc(name)}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}
        </div>
      </div>`;
  }

  function playerSection(title, count, rows, empty, extraRight = '') {
    return `
      <div class="srv-psection" style="background:rgba(11, 11, 11,0.55); border:1px solid rgba(255,255,255,0.07); border-radius:12px; padding:12px 14px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
          <div class="settings-group-label" style="margin:0;">${esc(title.toUpperCase())}${count != null ? ` (${count})` : ''}</div>
          ${extraRight}
        </div>
        ${rows.length ? `<div style="display:flex; flex-direction:column; gap:6px;">${rows.join('')}</div>` : `<div class="srv-pempty">${esc(empty)}</div>`}
      </div>`;
  }

  async function renderPlayers(body) {
    body.innerHTML = '<div class="srv-scroll" id="srvPlayersBox"><div class="srv-console-empty">Loading players...</div></div>';
    await loadPlayers();
  }

  function schedulePlayers(delay = 500) {
    clearTimeout(S.playersTimer);
    S.playersTimer = setTimeout(() => {
      if (S.mode === 'detail' && S.tab === 'players') loadPlayers();
    }, delay);
  }

  async function loadPlayers() {
    const id = S.selectedId;
    let data;
    try { data = await api.getServerPlayers(id); } catch (err) { toast(err, 'error'); return; }
    const box = $('srvPlayersBox');
    if (!box || id !== S.selectedId || S.tab !== 'players') return;
    const on = data.running;

    const onlineRows = (data.online || []).map(n => {
      const isOp = (data.ops || []).some(o => o.name.toLowerCase() === n.toLowerCase());
      const isWhitelisted = (data.whitelist || []).some(w => w.name.toLowerCase() === n.toLowerCase());
      return playerRow(n, {
        badge: isOp ? 'OP' : 'ONLINE',
        sub: isWhitelisted ? 'Whitelisted player' : 'Connected to server',
        buttons: [
          { act: isOp ? 'deop' : 'op', label: isOp ? 'Remove OP' : 'Make OP' },
          ...(!isWhitelisted ? [{ act: 'whitelist-add', label: '+ Whitelist' }] : []),
          { act: 'kick', label: 'Kick', danger: true },
          { act: 'ban', label: 'Ban', danger: true }
        ]
      });
    });

    const opsRows = (data.ops || []).map(o => playerRow(o.name, {
      badge: 'OPERATOR',
      sub: `Permission Level ${o.level || 4}`,
      buttons: [{ act: 'deop', label: 'Remove OP', danger: true }]
    }));

    const bannedRows = (data.banned || []).map(b => playerRow(b.name, {
      badge: 'BANNED',
      sub: b.reason || 'Banned by operator',
      buttons: [{ act: 'pardon', label: 'Unban Player', primary: true }]
    }));

    const whiteRows = (data.whitelist || []).map(w => playerRow(w.name, {
      badge: 'WHITELISTED',
      buttons: [{ act: 'whitelist-remove', label: 'Remove', danger: true }]
    }));

    const onlineLower = new Set((data.online || []).map(n => n.toLowerCase()));
    const recentRows = (data.recent || []).filter(n => !onlineLower.has(n.toLowerCase())).slice(0, 12).map(n => {
      const isOp = (data.ops || []).some(o => o.name.toLowerCase() === n.toLowerCase());
      return playerRow(n, {
        sub: 'Previously joined this server',
        buttons: [
          { act: isOp ? 'deop' : 'op', label: isOp ? 'Remove OP' : 'Make OP' },
          { act: 'whitelist-add', label: '+ Whitelist' },
          { act: 'ban', label: 'Ban', danger: true }
        ]
      });
    });

    const whitelistToggleHtml = `
      <div style="display:inline-flex; align-items:center; gap:8px; font-size:11.5px; color:var(--text-secondary);">
        <span>Whitelist ${data.whitelistEnabled ? 'ON' : 'OFF'}</span>
        <label class="switch"><input type="checkbox" id="srvWhitelistToggle" ${data.whitelistEnabled ? 'checked' : ''}/><span class="slider-toggle"></span></label>
      </div>`;

    const refreshOnlineBtn = `
      <button type="button" class="btn btn-sm glass-btn" id="srvRefreshPlayersBtn">${ico('refresh', 'ico-xs')}Sync Online List</button>`;

    box.innerHTML = `
      <div class="srv-net-card" style="padding:12px 14px;">
        <div class="settings-group-label">QUICK PLAYER ACTION (TYPE USERNAME TO OP, WHITELIST, KICK OR BAN)</div>
        <div class="srv-padd" style="margin-top:4px;">
          <input type="text" class="inex-input glass-input" id="srvPName" maxlength="32" placeholder="Player username (e.g. Steve)" autocomplete="off" spellcheck="false" />
          <input type="text" class="inex-input glass-input" id="srvPReason" maxlength="100" placeholder="Optional reason for Kick / Ban" autocomplete="off" />
          <div class="srv-pbtns">
            <button type="button" class="btn btn-sm glass-btn" data-pa="op" data-pn="*">Make OP</button>
            <button type="button" class="btn btn-sm glass-btn" data-pa="deop" data-pn="*">Remove OP</button>
            <button type="button" class="btn btn-sm glass-btn" data-pa="whitelist-add" data-pn="*">+ Whitelist</button>
            <button type="button" class="btn btn-sm glass-btn srv-pdanger" data-pa="kick" data-pn="*" ${on ? '' : 'disabled'}>Kick</button>
            <button type="button" class="btn btn-sm glass-btn srv-pdanger" data-pa="ban" data-pn="*">Ban</button>
            <button type="button" class="btn btn-sm glass-btn" data-pa="pardon" data-pn="*">Unban</button>
          </div>
        </div>
      </div>

      ${playerSection('Online Players Right Now', (data.online || []).length, onlineRows, on ? 'No players are currently online on the server.' : 'Server is offline. Start the server to see live online players.', refreshOnlineBtn)}
      ${playerSection('Server Operators (OP)', (data.ops || []).length, opsRows, 'No operators added yet.')}
      ${playerSection('Whitelist', (data.whitelist || []).length, whiteRows, 'Whitelist is empty.', whitelistToggleHtml)}
      ${playerSection('Banned Players', (data.banned || []).length, bannedRows, 'No players are banned.')}
      ${recentRows.length ? playerSection('Recent Players History', recentRows.length, recentRows, '') : ''}`;

    const wlToggle = $('srvWhitelistToggle');
    if (wlToggle) {
      wlToggle.addEventListener('change', async () => {
        try {
          await api.serverPlayerAction(id, wlToggle.checked ? 'whitelist-on' : 'whitelist-off', '', '');
          toast(`Whitelist turned ${wlToggle.checked ? 'ON' : 'OFF'}.`, 'success');
          schedulePlayers(250);
        } catch (err) {
          toast(err, 'error');
        }
      });
    }

    const refBtn = $('srvRefreshPlayersBtn');
    if (refBtn) {
      refBtn.addEventListener('click', async () => {
        try {
          await api.serverPlayerAction(id, 'refresh-list', '', '');
          schedulePlayers(400);
          toast('Synced player list.', 'info');
        } catch (_) {}
      });
    }

    box.querySelectorAll('[data-pa]').forEach(btn => btn.addEventListener('click', async () => {
      const act = btn.getAttribute('data-pa');
      let name = btn.getAttribute('data-pn');
      if (name === '*') name = ($('srvPName').value || '').trim();
      if (!name) { toast('Enter a player username first.', 'warning'); return; }
      const reason = ($('srvPReason') && $('srvPReason').value) || '';
      btn.disabled = true;
      try {
        await api.serverPlayerAction(id, act, name, reason);
        toast(`Applied "${act}" to ${name}.`, 'success');
        if ($('srvPName') && btn.getAttribute('data-pn') === '*') $('srvPName').value = '';
        // The server rewrites ops/ban/whitelist JSON a moment after the command, so re-read slightly later.
        await new Promise(r => setTimeout(r, 700));
        await refresh(true);
        schedulePlayers(300);
      } catch (err) {
        toast(err, 'error');
        btn.disabled = false;
      }
    }));

    if (on) {
      S.playersTimer = setTimeout(() => {
        if (S.mode === 'detail' && S.tab === 'players') loadPlayers();
      }, 5000);
    }
  }

  // ==================== 5. PLUGINS & MODS TAB ====================
  async function renderAddons(body) {
    const srv = selected();
    if (!srv || srv.loader === 'vanilla') {
      body.innerHTML = `
        <div class="srv-scroll">
          <div class="vanilla-notice-banner visible" style="display:flex;">
            ${ico('warn')}
            <span><strong>Vanilla Server.</strong> Vanilla servers cannot load plugins or mods. Create a <strong>Paper</strong>, <strong>Purpur</strong>, or <strong>Fabric</strong> server to use plugins and mods.</span>
          </div>
        </div>`;
      return;
    }

    const isPluginSrv = srv.loader === 'paper' || srv.loader === 'purpur';
    const typeLabel = isPluginSrv ? 'Plugins' : 'Fabric Mods';

    body.innerHTML = `
      <div class="srv-scroll" id="srvAddonsScroll">
        <div class="content-subtoolbar" style="margin-bottom:8px;">
          <div class="mode-switch-tabs">
            <button type="button" class="btn btn-sm ${S.addonsMode === 'browse' ? 'btn-crimson' : 'glass-btn'}" id="srvAddonModeBrowse">Browse ${esc(typeLabel)}</button>
            <button type="button" class="btn btn-sm ${S.addonsMode === 'installed' ? 'btn-crimson' : 'glass-btn'}" id="srvAddonModeInstalled">Installed (<span id="srvAddonInstalledCount">0</span>)</button>
          </div>

          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="target-locked-pill">
              ${ico('lock')}
              <span>Matched to</span>
              <strong>${esc(srv.version)} (${esc(srv.loader.toUpperCase())})</strong>
            </div>
            ${isPluginSrv ? `
              <button type="button" class="btn btn-sm ${S.addonsStrictVer ? 'glass-btn' : 'btn-crimson'}" id="srvAddonCompatToggle">
                ${S.addonsStrictVer ? 'Filter: Version + Universal' : 'Filter: All Paper/Purpur Plugins'}
              </button>
            ` : ''}
          </div>

          <div class="content-search" style="max-width:460px;">
            <div class="search-input-wrap" style="flex:1;">
              ${ico('search')}
              <input type="text" class="inex-input glass-input" id="srvAddonsSearch" placeholder="Search ${esc(typeLabel.toLowerCase())} for ${esc(srv.version)}..." value="${esc(S.addonsQuery)}" style="padding-top:7px; padding-bottom:7px;" />
            </div>
            <select class="inex-select glass-input" id="srvAddonsSort" style="width:135px; padding:7px 10px; font-size:12px;">
              <option value="downloads" ${S.addonsSort === 'downloads' ? 'selected' : ''}>Downloads</option>
              <option value="relevance" ${S.addonsSort === 'relevance' ? 'selected' : ''}>Relevance</option>
              <option value="follows" ${S.addonsSort === 'follows' ? 'selected' : ''}>Popularity</option>
              <option value="newest" ${S.addonsSort === 'newest' ? 'selected' : ''}>Newest</option>
            </select>
            <button type="button" class="btn btn-sm glass-btn" id="srvAddonsRefreshBtn" title="Refresh">${ico('refresh')}</button>
          </div>
        </div>

        <div class="modrinth-list" id="srvAddonsList"></div>

        <div class="pagination-bar" id="srvAddonsPagination" style="display:${S.addonsMode === 'browse' ? 'flex' : 'none'};">
          <span id="srvAddonsPageSummary">Loading...</span>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-sm glass-btn" id="srvAddonsPrevBtn">${ico('back')}Previous</button>
            <button type="button" class="btn btn-sm glass-btn" id="srvAddonsNextBtn">Next${ico('next')}</button>
          </div>
        </div>
      </div>`;

    $('srvAddonModeBrowse').addEventListener('click', () => { S.addonsMode = 'browse'; renderAddons(body); });
    $('srvAddonModeInstalled').addEventListener('click', () => { S.addonsMode = 'installed'; renderAddons(body); });

    const compatBtn = $('srvAddonCompatToggle');
    if (compatBtn) {
      compatBtn.addEventListener('click', () => {
        S.addonsStrictVer = !S.addonsStrictVer;
        S.addonsOffset = 0;
        renderAddons(body);
      });
    }

    let debounce = null;
    $('srvAddonsSearch').addEventListener('input', e => {
      S.addonsQuery = e.target.value;
      S.addonsOffset = 0;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (S.addonsMode === 'browse') loadAddonsSearch();
        else paintAddonsInstalled();
      }, 260);
    });

    $('srvAddonsSort').addEventListener('change', e => {
      S.addonsSort = e.target.value;
      S.addonsOffset = 0;
      if (S.addonsMode === 'browse') loadAddonsSearch();
    });

    $('srvAddonsRefreshBtn').addEventListener('click', () => {
      if (S.addonsMode === 'browse') loadAddonsSearch();
      else loadAddonsInstalled();
    });

    $('srvAddonsPrevBtn').addEventListener('click', () => {
      if (S.addonsOffset >= S.addonsLimit) {
        S.addonsOffset -= S.addonsLimit;
        loadAddonsSearch();
      }
    });

    $('srvAddonsNextBtn').addEventListener('click', () => {
      if (S.addonsOffset + S.addonsLimit < S.addonsTotal) {
        S.addonsOffset += S.addonsLimit;
        loadAddonsSearch();
      }
    });

    await loadAddonsInstalled();
    if (S.addonsMode === 'browse') {
      await loadAddonsSearch();
    } else {
      paintAddonsInstalled();
    }
  }

  async function loadAddonsInstalled() {
    const id = S.selectedId;
    try {
      S.addonsInstalled = await api.listServerAddons(id);
    } catch (_) {
      S.addonsInstalled = [];
    }
    const countEl = $('srvAddonInstalledCount');
    if (countEl) countEl.textContent = String(S.addonsInstalled.length);
  }

  function paintAddonsInstalled() {
    const id = S.selectedId;
    const listEl = $('srvAddonsList');
    if (!listEl) return;
    const q = (S.addonsQuery || '').toLowerCase().trim();
    const filtered = S.addonsInstalled.filter(item => !q || item.title.toLowerCase().includes(q) || item.fileName.toLowerCase().includes(q));

    if (!filtered.length) {
      listEl.innerHTML = `<div style="padding:36px; text-align:center; color:var(--text-muted);">No plugins or mods installed yet. Switch to <strong>Browse</strong> to install from Modrinth.</div>`;
      return;
    }

    listEl.innerHTML = filtered.map(item => `
      <div class="modrinth-item-card">
        <div class="modrinth-item-left">
          <div class="mod-icon">${item.iconUrl ? `<img src="${esc(item.iconUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px;" />` : esc(item.title.slice(0, 2).toUpperCase())}</div>
          <div class="mod-details">
            <div class="mod-title-row">
              <span class="mod-title">${esc(item.title)}</span>
              <span class="mod-author">${esc(item.fileName)}</span>
            </div>
            <div class="mod-desc" style="color:${item.enabled ? 'var(--success)' : 'var(--warning)'}; font-weight:600;">
              ${item.enabled ? 'Enabled • Active on server' : 'Disabled'}
            </div>
          </div>
        </div>
        <div class="modrinth-item-actions">
          <button type="button" class="btn btn-sm glass-btn" data-addon-toggle="${esc(item.fileName)}">${item.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" class="btn btn-sm srv-pdanger" data-addon-remove="${esc(item.fileName)}">${ico('trash', 'ico-xs')}Remove</button>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('[data-addon-toggle]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api.toggleServerAddon(id, b.getAttribute('data-addon-toggle'));
        await loadAddonsInstalled();
        paintAddonsInstalled();
        toast('Addon updated.', 'success');
      } catch (err) { toast(err, 'error'); }
    }));

    listEl.querySelectorAll('[data-addon-remove]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api.removeServerAddon(id, b.getAttribute('data-addon-remove'));
        await loadAddonsInstalled();
        paintAddonsInstalled();
        toast('Addon removed.', 'success');
      } catch (err) { toast(err, 'error'); }
    }));
  }

  async function loadAddonsSearch() {
    const id = S.selectedId;
    const listEl = $('srvAddonsList');
    const summaryEl = $('srvAddonsPageSummary');
    if (!listEl) return;

    listEl.innerHTML = '<div style="padding:28px; text-align:center; color:var(--text-muted);">Searching compatible Modrinth projects...</div>';
    try {
      const res = await api.searchServerAddons(id, {
        query: S.addonsQuery,
        offset: S.addonsOffset,
        limit: S.addonsLimit,
        sortIndex: S.addonsSort,
        strictVersion: S.addonsStrictVer
      });
      S.addonsHits = res.hits || [];
      S.addonsTotal = res.totalHits || S.addonsHits.length;

      if (!S.addonsHits.length) {
        listEl.innerHTML = '<div style="padding:36px; text-align:center; color:var(--text-muted);">No matching plugins/mods found.</div>';
        if (summaryEl) summaryEl.textContent = '0 results';
        return;
      }

      const start = S.addonsOffset + 1;
      const end = Math.min(S.addonsOffset + S.addonsHits.length, S.addonsTotal);
      if (summaryEl) summaryEl.textContent = `Showing ${start} to ${end} of ${formatCompact(S.addonsTotal)} compatible projects`;
      if ($('srvAddonsPrevBtn'))$('srvAddonsPrevBtn').disabled = S.addonsOffset <= 0;
      if ($('srvAddonsNextBtn'))$('srvAddonsNextBtn').disabled = S.addonsOffset + S.addonsLimit >= S.addonsTotal;

      listEl.innerHTML = S.addonsHits.map(hit => `
        <div class="modrinth-item-card">
          <div class="modrinth-item-left">
            <div class="mod-icon">${hit.iconUrl ? `<img src="${esc(hit.iconUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px;" />` : esc(hit.title.slice(0, 2).toUpperCase())}</div>
            <div class="mod-details">
              <div class="mod-title-row">
                <span class="mod-title">${esc(hit.title)}</span>
                <span class="mod-author">by ${esc(hit.author)}</span>
                <span class="mod-tag" style="color:var(--crimson-400);">${formatCompact(hit.downloads)} downloads</span>
              </div>
              <div class="mod-desc">${esc(hit.description)}</div>
              <div class="mod-tags">
                ${(hit.categories || []).slice(0, 5).map(c => `<span class="mod-tag">${esc(c)}</span>`).join('')}
              </div>
            </div>
          </div>
          <div class="modrinth-item-actions">
            <button type="button" class="btn btn-sm ${hit.installed ? 'glass-btn' : 'btn-crimson'}" data-addon-install="${esc(hit.projectId)}" data-addon-title="${esc(hit.title)}" data-addon-author="${esc(hit.author)}" data-addon-icon="${esc(hit.iconUrl)}" ${hit.installed ? 'disabled' : ''}>
              ${hit.installed ? ico('check') + 'Installed' : ico('download') + 'Install'}
            </button>
          </div>
        </div>`).join('');

      listEl.querySelectorAll('[data-addon-install]').forEach(b => b.addEventListener('click', async () => {
        const pid = b.getAttribute('data-addon-install');
        const title = b.getAttribute('data-addon-title');
        const author = b.getAttribute('data-addon-author');
        const iconUrl = b.getAttribute('data-addon-icon');
        b.disabled = true;
        b.textContent = 'Installing...';
        try {
          await api.installServerAddon(id, { projectId: pid, title, author, iconUrl });
          toast(`Installed ${title}!`, 'success');
          await loadAddonsInstalled();
          b.className = 'btn btn-sm glass-btn';
          b.innerHTML = ico('check') + 'Installed';
        } catch (err) {
          b.disabled = false;
          b.innerHTML = ico('download') + 'Install';
          toast(err, 'error');
        }
      }));
    } catch (err) {
      listEl.innerHTML = `<div style="padding:24px; text-align:center; color:#f87171;">Could not load search results: ${esc(err.message)}</div>`;
    }
  }

  // ==================== 6. FILES & CONFIG EDITOR TAB ====================
  async function renderFiles(body, openFileRelPath = null) {
    body.innerHTML = `
      <div class="srv-scroll" id="srvFilesView" style="display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;" id="srvFilesBreadcrumb"></div>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-sm glass-btn" id="srvNewFileBtn">${ico('plus', 'ico-xs')}New Config / File</button>
            <button type="button" class="btn btn-sm glass-btn" id="srvOpenRootExplorerBtn">${ico('folder', 'ico-xs')}Open in Explorer</button>
          </div>
        </div>
        <div class="cards-grid" id="srvFilesGrid" style="grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));"></div>
      </div>

      <div class="srv-scroll" id="srvEditorView" style="display:none; flex-direction:column; gap:10px; flex:1; min-height:0;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid var(--border-subtle);">
          <div style="display:flex; align-items:center; gap:8px;">
            ${ico('edit', 'ico-sm')}
            <strong id="srvEditorTitle" style="font-family:Consolas,monospace; font-size:13px; color:#fff;"></strong>
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-sm glass-btn" id="srvEditorBack">${ico('back', 'ico-xs')}Back to Files</button>
            <button type="button" class="btn btn-sm btn-crimson" id="srvEditorSave">${ico('check', 'ico-xs')}Save Changes</button>
          </div>
        </div>
        <textarea class="inex-input glass-input" id="srvEditorArea" style="flex:1; min-height:280px; font-family:Consolas,'Cascadia Mono',monospace; font-size:12.5px; resize:none; line-height:1.55; white-space:pre; tab-size:2;"></textarea>
      </div>`;

    $('srvEditorBack').addEventListener('click', () => {
      $('srvFilesView').style.display = 'flex';$('srvEditorView').style.display = 'none';
      loadFilesDir(S.currentFilesDir || '');
    });

    $('srvEditorSave').addEventListener('click', async () => {
      try {
        await api.writeServerFile(S.selectedId, S.editorPath, $('srvEditorArea').value);
        toast(`Saved ${S.editorPath}`, 'success');
      } catch (err) { toast(err, 'error'); }
    });

    $('srvOpenRootExplorerBtn').addEventListener('click', () => {
      if (api.openServerFolder) api.openServerFolder(S.selectedId).catch(() => {});
    });

    $('srvNewFileBtn').addEventListener('click', async () => {
      const name = prompt('Enter new file name (e.g. config.yml or notes.txt):');
      if (!name || !name.trim()) return;
      const rel = S.currentFilesDir ? `${S.currentFilesDir}/${name.trim()}` : name.trim();
      try {
        await api.writeServerFile(S.selectedId, rel, '');
        openFileInEditor(rel);
      } catch (err) { toast(err, 'error'); }
    });

    if (openFileRelPath) {
      await openFileInEditor(openFileRelPath);
    } else {
      await loadFilesDir(S.currentFilesDir || '');
    }
  }

  async function openFileInEditor(relPath) {
    const id = S.selectedId;
    try {
      const file = await api.readServerFile(id, relPath);
      S.editorPath = relPath;
      $('srvEditorTitle').textContent = file.relPath;
      $('srvEditorArea').value = file.content;
      $('srvFilesView').style.display = 'none';$('srvEditorView').style.display = 'flex';
    } catch (err) {
      toast(err, 'error');
      await loadFilesDir('');
    }
  }

  async function loadFilesDir(relPath) {
    const id = S.selectedId;
    S.currentFilesDir = relPath || '';
    let res;
    try { res = await api.listServerFiles(id, relPath); } catch (err) { toast(err, 'error'); return; }
    const bc = $('srvFilesBreadcrumb'), grid =$('srvFilesGrid');
    if (!bc || !grid) return;

    const parts = res.relDir ? res.relDir.split('/') : [];
    bc.innerHTML = `<button type="button" class="btn btn-sm glass-btn" data-fdir="">root</button>` + parts.map((p, i) => {
      const sub = parts.slice(0, i + 1).join('/');
      return `<span style="color:var(--text-muted);">/</span><button type="button" class="btn btn-sm glass-btn" data-fdir="${esc(sub)}">${esc(p)}</button>`;
    }).join('');
    bc.querySelectorAll('[data-fdir]').forEach(b => b.addEventListener('click', () => loadFilesDir(b.getAttribute('data-fdir'))));

    if (!res.entries.length) {
      grid.innerHTML = '<div class="srv-console-empty">This folder is empty.</div>';
      return;
    }

    grid.innerHTML = res.entries.map(e => `
      <div class="profile-card" style="padding:12px 14px; cursor:pointer;" data-fpath="${esc(e.relPath)}" data-fdir="${e.isDirectory ? '1' : '0'}" data-fedit="${e.editable ? '1' : '0'}">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="profile-avatar" style="width:36px; height:36px; border-radius:8px;">${ico(e.isDirectory ? 'folder' : 'edit', 'ico-xs')}</div>
          <div class="profile-info">
            <div class="profile-name" style="font-size:13.5px;">${esc(e.name)}</div>
            <div class="profile-meta-line">${e.isDirectory ? 'Folder • Click to open' : `${(e.size / 1024).toFixed(1)} KB${e.editable ? ' • Click to edit' : ''}`}</div>
          </div>
        </div>
      </div>`).join('');

    grid.querySelectorAll('[data-fpath]').forEach(card => card.addEventListener('click', async () => {
      const p = card.getAttribute('data-fpath');
      const isDir = card.getAttribute('data-fdir') === '1';
      const editable = card.getAttribute('data-fedit') === '1';
      if (isDir) { loadFilesDir(p); return; }
      if (!editable) { toast('Binary or large files (.jar / world data) cannot be text-edited.', 'warning'); return; }
      openFileInEditor(p);
    }));
  }

  // ==================== 7. NETWORK TAB ====================
  function addrRow(label, value, extra = '') {
    return `
      <div class="srv-net-row">
        <div class="srv-net-label">${esc(label)}</div>
        <code class="srv-net-value">${esc(value)}</code>
        <button type="button" class="icon-btn" data-copy="${esc(value)}" title="Copy">${ico('data', 'ico-xs')}</button>
        ${extra}
      </div>`;
  }

  async function renderNetwork(body) {
    body.innerHTML = '<div class="srv-scroll" id="srvNetBox"><div class="srv-console-empty">Loading tunnel info...</div></div>';
    await loadNetwork();
  }

  async function loadNetwork() {
    const id = S.selectedId;
    try {
      S.network.set(id, await api.getServerNetwork(id));
      if (api.getPlayitState) S.playit = Object.assign({}, S.playit, await api.getPlayitState());
    } catch (err) { toast(err, 'error'); return; }
    paintNetwork();
  }

  function paintNetwork() {
    const box = $('srvNetBox');
    const srv = selected();
    if (!box || !srv || S.mode !== 'detail' || S.tab !== 'network') return;
    const net = S.network.get(srv.id);
    if (!net) return;
    const pl = S.playit;
    const pubJava = publicJava(srv.id);
    const pubBed = publicBedrock(srv.id);
    const bed = net.bedrock || {};
    const useBore = (net.javaTunnel || srv.javaTunnel) === 'bore';
    const provName = useBore ? 'bore.pub' : 'playit.gg';

    let statusBadge = `<span class="srv-status offline">Not Connected</span>`;
    if (pubJava) {
      statusBadge = `<span class="srv-status online">Connected &bull; Live on ${provName}</span>`;
    } else if (pl.status === 'downloading' || pl.status === 'starting' || pl.status === 'linking') {
      statusBadge = `<span class="srv-status starting">${esc(pl.status === 'linking' ? 'Waiting for Approval' : 'Connecting...')}</span>`;
    } else if (pl.status === 'error') {
      statusBadge = `<span class="srv-status stopping">Connection Error</span>`;
    }

    let statusNoticeHtml = '';
    if (pl.status === 'downloading' || pl.status === 'starting') {
      statusNoticeHtml = `<div class="srv-net-note"><span class="srv-spin"></span>${esc(pl.message || 'Connecting to playit.gg & creating your tunnels...')}</div>`;
    } else if (pl.status === 'linking') {
      statusNoticeHtml = `
        <div class="srv-net-note warn">
          <strong>Approve Playit.gg in your browser</strong>
          <span>One-time setup: log in (or create a free Playit account) in the browser and approve the agent. Your permanent Java &amp; Bedrock IPs will appear here automatically.</span>
        </div>`;
    } else if (pl.status === 'error' && pl.message) {
      statusNoticeHtml = `<div class="srv-net-note warn">${esc(pl.message)}</div>`;
    }

    const provBtn = (key, title, sub, active) => `
      <button type="button" class="srv-prov" data-prov="${key}" style="flex:1; min-width:210px; text-align:left; display:flex; flex-direction:column; gap:3px; padding:11px 13px; border-radius:11px; cursor:pointer; color:inherit; font:inherit; background:${active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)'}; border:1px solid ${active ? 'rgba(255,255,255,0.30)' : 'var(--border-subtle)'};">
        <span style="display:flex; align-items:center; gap:8px; font-size:12.5px; font-weight:700; color:#fff;">
          <span style="width:9px; height:9px; border-radius:50%; background:${active ? '#fff' : 'transparent'}; border:2px solid ${active ? '#fff' : 'var(--text-secondary)'};"></span>${esc(title)}
        </span>
        <span style="font-size:11.5px; color:var(--text-secondary); line-height:1.4;">${esc(sub)}</span>
      </button>`;

    box.innerHTML = `
      <div class="srv-net">
        <div class="srv-net-card" style="gap:14px; padding:18px 20px;">
          <div class="srv-net-title">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
              <div class="settings-group-label" style="margin:0; font-size:12px; color:#fff;">PUBLIC TUNNEL</div>
              ${statusBadge}
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="font-size:11.5px; color:var(--text-secondary);">Tunnel ${srv.playit ? 'ON' : 'OFF'}</span>
              <label class="switch"><input type="checkbox" id="srvPlayitToggle"${srv.playit ? ' checked' : ''}/><span class="slider-toggle"></span></label>
            </div>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            ${provBtn('playit', 'Playit.gg', 'Java + Bedrock. Link a free Playit account for a permanent address.', !useBore)}
            ${provBtn('bore', 'bore.pub', 'Java only. No account, no download. Keeps the same port while it is free.', useBore)}
          </div>

          ${statusNoticeHtml}

          ${addrRow('Java Edition IP & Port', pubJava || (srv.playit ? `Not connected — Click "Connect ${provName}" below` : 'Tunnel is OFF — turn it on above'))}

          ${!bed.supported
            ? `<div class="srv-net-hint">Bedrock Edition is not supported on Vanilla servers (Use Paper, Purpur, or Fabric).</div>`
            : bed.geyser
              ? (pubBed
                  ? addrRow('Bedrock Edition IP', pubBed.host) + addrRow('Bedrock UDP Port', String(pubBed.port))
                  : (useBore && !pl.linked ? addrRow('Bedrock Edition IP', 'Needs Playit — switch provider above or link an account') : ''))
              : `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-radius:10px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle);">
                  <span style="font-size:12px; color:var(--text-secondary);">Want Bedrock (Mobile / Console / Windows) players to join?</span>
                  <button type="button" class="btn btn-sm btn-crimson" id="srvAddBedrock" ${S.installing ? 'disabled' : ''}>
                    ${ico('download')}${S.installing ? 'Installing GeyserMC...' : '+ Enable Bedrock Support'}
                  </button>
                </div>`
          }

          <div class="srv-net-btns" style="padding-top:4px; border-top:1px solid rgba(255,255,255,0.07);">
            <button type="button" class="btn btn-sm btn-crimson" id="srvConnectPlayitBtn">
              ${ico('refresh')}${pubJava ? `Refresh ${provName}` : `Connect ${provName}`}
            </button>
            ${!useBore && !pl.linked && pl.status !== 'linking'
              ? `<button type="button" class="btn btn-sm glass-btn" id="srvLinkPlayitBtn">${ico('compass', 'ico-xs')}Link Playit account for permanent IP</button>`
              : ''
            }
            ${pubJava || pl.status === 'starting' || pl.status === 'linking'
              ? `<button type="button" class="btn btn-sm glass-btn" id="srvStopTunnelBtn">${ico('power', 'ico-xs')}Stop Tunnel</button>`
              : ''
            }
            ${bed.geyser && bed.configRelPath
              ? `<button type="button" class="btn btn-sm glass-btn" id="srvEditGeyserCfgBtn">${ico('edit', 'ico-xs')}Edit Geyser Config</button>`
              : ''
            }
            ${!useBore && pl.linked
              ? `<button type="button" class="btn btn-sm glass-btn" id="srvManagePlayitBtn" style="margin-left:auto;">${ico('compass', 'ico-xs')}Manage Playit Account</button>
                 <button type="button" class="btn btn-sm srv-pdanger" id="srvUnlinkPlayitBtn">Unlink Playit Account</button>`
              : ''
            }
          </div>
        </div>
      </div>`;

    box.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      const val = b.getAttribute('data-copy');
      if (!val || val.startsWith('Not connected') || val.startsWith('Waiting')) {
        toast('Connect the tunnel first.', 'warning');
        return;
      }
      copyText(val);
    }));

    box.querySelectorAll('[data-prov]').forEach(btn => btn.addEventListener('click', async () => {
      const want = btn.getAttribute('data-prov');
      if (want === (useBore ? 'bore' : 'playit')) return;
      try {
        await api.updateServer(srv.id, { javaTunnel: want });
        srv.javaTunnel = want;
        const hadTunnel = !!publicJava(srv.id);
        if (srv.status === 'online' && srv.playit) {
          S.playit.status = 'starting';
          S.playit.message = want === 'bore' ? 'Connecting to bore.pub...' : 'Connecting to playit.gg...';
          S.network.set(srv.id, Object.assign({}, S.network.get(srv.id), { javaTunnel: want }));
          paintNetwork();
          await api.playitRelease(srv.id);
          await api.playitShare(srv.id);
        } else if (hadTunnel) {
          await api.playitRelease(srv.id);
        }
        await loadNetwork();
      } catch (err) { toast(err, 'error'); }
    }));

    const toggle = $('srvPlayitToggle');
    if (toggle) {
      toggle.addEventListener('change', async () => {
        const want = toggle.checked;
        try {
          await api.updateServer(srv.id, { playit: want });
          srv.playit = want;
          if (want) {
            S.playit.status = 'starting';
            S.playit.message = `Connecting to ${useBore ? 'bore.pub' : 'playit.gg'}...`;
            paintNetwork();
            await api.playitShare(srv.id);
            await loadNetwork();
          } else {
            await api.playitRelease(srv.id);
            await loadNetwork();
          }
        } catch (err) { toggle.checked = !want; toast(err, 'error'); }
      });
    }

    const connectBtn = $('srvConnectPlayitBtn');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        S.playit.status = 'starting';
        S.playit.message = `Connecting to ${provName}...`;
        paintNetwork();
        await api.playitShare(srv.id);
        await loadNetwork();
      });
    }

    const linkBtn = $('srvLinkPlayitBtn');
    if (linkBtn) {
      linkBtn.addEventListener('click', async () => {
        S.playit.status = 'linking';
        paintNetwork();
        const r = await api.playitLink();
        if (r && r.ok) {
          toast('Linked! Restarting tunnel with a permanent address...', 'success');
          await api.playitRelease(srv.id);
          await api.playitShare(srv.id);
        }
        await loadNetwork();
      });
    }

    const stopTun = $('srvStopTunnelBtn');
    if (stopTun) {
      stopTun.addEventListener('click', async () => {
        if (pl.status === 'linking' && api.playitCancelLink) {
          await api.playitCancelLink();
        }
        await api.playitRelease(srv.id);
        await loadNetwork();
        toast('Tunnel stopped.', 'info');
      });
    }

    const manageBtn = $('srvManagePlayitBtn'); // inex-playit-fix3
    if (manageBtn) {
      manageBtn.addEventListener('click', async () => {
        try { await api.playitManage(); } catch (err) { toast(err, 'error'); }
      });
    }

    const unlinkBtn = $('srvUnlinkPlayitBtn');
    if (unlinkBtn) {
      unlinkBtn.addEventListener('click', async () => {
        await api.playitUnlink();
        S.playit = Object.assign({}, S.playit, { linked: false, status: 'off', tunnels: {} });
        toast('Playit.gg account unlinked.', 'info');
        await loadNetwork();
      });
    }

    const addBed = $('srvAddBedrock');
    if (addBed) {
      addBed.addEventListener('click', async () => {
        S.installing = true;
        paintNetwork();
        try {
          await api.installBedrockSupport(srv.id);
          toast('Bedrock support (GeyserMC) installed!', 'success');
          if (srv.playit || pubJava) {
            await api.playitShare(srv.id);
          }
        } catch (err) { toast(err, 'error'); }
        S.installing = false;
        await refresh(true);
        await loadNetwork();
      });
    }

    const editGeyser = $('srvEditGeyserCfgBtn');
    if (editGeyser && bed.configRelPath) {
      editGeyser.addEventListener('click', () => {
        S.tab = 'files';
        const main = $('srvMain');
        if (main) main.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.getAttribute('data-tab') === 'files'));
        renderFiles($('srvBody'), bed.configRelPath);
      });
    }
  }

  // ==================== 8. PROPERTIES TAB ====================
  async function renderProperties(body) {
    body.innerHTML = '<div class="srv-console-empty">Loading server.properties...</div>';
    const id = S.selectedId;
    let res;
    try { res = await api.getServerProperties(id); } catch (err) { body.innerHTML = ''; toast(err, 'error'); return; }
    if (id !== S.selectedId || S.tab !== 'properties' || !$('srvBody')) return;
    const vals = res.values || {};
    const defs = res.defaults || {};
    const initial = {};
    PROP_GROUPS.forEach(g => g.fields.forEach(f => {
      initial[f.key] = vals[f.key] !== undefined ? String(vals[f.key]) : (defs[f.key] !== undefined ? String(defs[f.key]) : (BOOL_DEFAULTS[f.key] || ''));
    }));

    body.innerHTML = `
      <div class="srv-props" id="srvProps">
        ${PROP_GROUPS.map(g => `
          <div class="srv-props-group">
            <div class="settings-group-label">${esc(g.title.toUpperCase())}</div>
            <div class="srv-props-grid">
              ${g.fields.map(f => propField(f, initial[f.key])).join('')}
            </div>
          </div>`).join('')}
        <div class="srv-props-save">
          <span class="srv-props-note">Gamemode, PvP, Difficulty &amp; Whitelist apply <strong>LIVE</strong> in-game immediately!</span>
          <div class="srv-props-save-right">
            <span class="srv-saved-Floater" id="srvSavedBadge">${ico('check', 'ico-xs')}Settings Saved!</span>
          </div>
        </div>
      </div>`;

    let badgeTimer = null;
    const showSavedPopup = msgText => {
      const badge = $('srvSavedBadge');
      if (badge) {
        badge.innerHTML = `${ico('check', 'ico-xs')}${esc(msgText || 'Settings Saved!')}`;
        badge.classList.add('show');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => {
          if (badge.isConnected) badge.classList.remove('show');
        }, 2400);
      }
      toast(msgText || 'Settings Saved!', 'success');
    };

    const collectAndSave = async () => {
      const updates = {};
      PROP_GROUPS.forEach(g => g.fields.forEach(f => {
        const el = $(`srvp-${f.key}`);
        if (!el) return;
        const v = f.type === 'bool' ? (el.checked ? 'true' : 'false') : String(el.value).trim();
        if (f.type === 'number' && v === '') return;
        updates[f.key] = v;
      }));
      try {
        const result = await api.setServerProperties(id, updates);
        Object.assign(initial, updates);
        if (result && result.restartKeys && result.restartKeys.length) {
          showSavedPopup('Saved. Restart the server to apply: ' + result.restartKeys.join(', '));
        } else {
          showSavedPopup(result && result.appliedLive ? 'Settings Saved & Applied Live!' : 'Settings Saved!');
        }
        refresh(true);
      } catch (err) {
        toast(err, 'error');
      }
    };

    body.querySelectorAll('.srv-prop-bool').forEach(card => {
      const input = card.querySelector('input[type="checkbox"]');
      if (!input) return;
      card.addEventListener('click', e => {
        if (e.target.closest('label.switch') || e.target.tagName === 'LABEL') return;
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change'));
      });
      input.addEventListener('change', () => collectAndSave());
    });

    body.querySelectorAll('select.inex-select').forEach(sel => {
      sel.addEventListener('change', () => collectAndSave());
    });

    // Save button lives in the header, in the same spot as Start Server
    const hdr = $('srvActions');
    const old = $('srvPropsSaveTop');
    if (old) old.remove();
    if (hdr) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-crimson';
      b.id = 'srvPropsSaveTop';
      b.innerHTML = `${ico('check')}Save Properties`;
      b.addEventListener('click', () => collectAndSave());
      hdr.insertBefore(b, hdr.firstChild);
    }
  }

  function propField(f, value) {
    const id = `srvp-${f.key}`;
    if (f.type === 'bool') {
      return `<div class="srv-prop srv-prop-bool">
        <div class="srv-prop-text"><label for="${id}">${esc(f.label)}</label>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>
        <label class="switch"><input type="checkbox" id="${id}"${String(value) === 'true' ? ' checked' : ''}/><span class="slider-toggle"></span></label>
      </div>`;
    }
    let input;
    if (f.type === 'select') {
      input = `<select class="inex-select glass-input" id="${id}">${f.options.map(o => `<option value="${esc(o)}"${String(value) === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.type === 'number') {
      input = `<input type="number" class="inex-input glass-input" id="${id}" min="${f.min}" max="${f.max}" value="${esc(value)}"/>`;
    } else {
      input = `<input type="text" class="inex-input glass-input" id="${id}" value="${esc(value)}" spellcheck="false"/>`;
    }
    return `<div class="srv-prop${f.wide ? ' wide' : ''}"><label class="field-label" for="${id}">${esc(f.label)}</label>${input}</div>`;
  }

  // ==================== 9. CREATE SERVER VIEW (WITH PURPUR SUPPORT!) ====================
  async function openCreate() {
    S.mode = 'create';
    renderAll();
    try { S.memory = await api.getSystemMemory(); } catch (_) {}
    if (S.mode === 'create') renderMain();
    loadVersions(S.create.loader);
  }

  async function loadVersions(loader) {
    const sel = $('srvCVersion');
    if (S.versionsCache[loader] && S.versionsCache[loader].length) { fillVersions(); return; }
    if (sel) { sel.innerHTML = '<option>Loading versions...</option>'; sel.disabled = true; const l = $('srvCVersionLabel'); if (l) l.textContent = 'Loading versions...'; const b = $('srvCVersionBtn'); if (b) b.disabled = true; }
    try {
      S.versionsCache[loader] = await api.getServerVersions(loader);
    } catch (_) {
      S.versionsCache[loader] = [];
    }
    if (S.create.loader === loader) fillVersions();
  }

  function fillVersions() {
    const sel = $('srvCVersion');
    if (!sel) return;
    const list = S.versionsCache[S.create.loader] || [];
    sel.disabled = !list.length;
    sel.innerHTML = list.length ? list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('') : '<option value="">No versions available</option>';
    if (!list.includes(S.create.version)) S.create.version = list[0] || '';
    sel.value = S.create.version;
    syncVersionPicker(list);
  }

  function syncVersionPicker(list) {
    const btn = $('srvCVersionBtn'), menu = $('srvCVersionMenu'), label = $('srvCVersionLabel');
    if (!btn || !menu) return;
    btn.disabled = !list.length;
    label.textContent = list.length ? (S.create.version || list[0]) : 'No versions available';
    menu.innerHTML = list.map(v => `<div class="vsel-opt${v === S.create.version ? ' active' : ''}" role="option" data-v="${esc(v)}">${esc(v)}</div>`).join('');
  }

  function bindVersionPicker() {
    const wrap = $('srvCVersionWrap'), btn = $('srvCVersionBtn'), menu = $('srvCVersionMenu');
    if (!wrap || !btn || !menu) return;
    const close = () => wrap.classList.remove('open');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !wrap.classList.contains('open');
      wrap.classList.toggle('open', opening);
      if (opening) {
        const act = menu.querySelector('.active');
        if (act) menu.scrollTop = Math.max(0, act.offsetTop - 60);
        menu.scrollIntoView({ block: 'nearest' });
      }
    });
    menu.addEventListener('click', e => {
      const opt = e.target.closest('.vsel-opt');
      if (!opt) return;
      const sel = $('srvCVersion');
      sel.value = opt.getAttribute('data-v');
      sel.dispatchEvent(new Event('change'));
      syncVersionPicker(S.versionsCache[S.create.loader] || []);
      close();
    });
    if (bindVersionPicker._off) bindVersionPicker._off();
    const onDoc = e => { if (!wrap.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    bindVersionPicker._off = () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); };
  }

  function logoFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Drop an image file (PNG, JPG, WEBP).'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const x = cv.getContext('2d');
        x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
        const side = Math.min(img.width, img.height);
        x.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  function bindLogoDrop(c) {
    const drop = $('srvCLogoDrop'), file = $('srvCLogoFile'), clr = $('srvCLogoClear');
    if (!drop || !file) return;
    const paint = () => {
      $('srvCLogoPrev').innerHTML = c.logo ? `<img src="${esc(c.logo)}" alt="" />` : '🖼';
      $('srvCLogoTitle').textContent = c.logo ? 'Logo selected' : 'Drag & drop a logo here';
      clr.style.display = c.logo ? '' : 'none';
    };
    const take = async f => {
      try { c.logo = await logoFromFile(f); paint(); } catch (e) { toast(e, 'warning'); }
    };
    drop.addEventListener('click', e => { if (e.target === clr) return; file.click(); });
    file.addEventListener('change', () => { if (file.files && file.files[0]) take(file.files[0]); file.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) take(f); });
    clr.addEventListener('click', e => { e.stopPropagation(); c.logo = ''; paint(); });
  }

  function renderCreate(main) {
    const c = S.create;
    const maxGb = Math.max(2, Math.min(32, Math.floor((S.memory.totalMb || 8192) / 1024)));
    if (c.ramGb > maxGb) c.ramGb = maxGb;
    const supportsBedrock = c.loader !== 'vanilla';

    main.innerHTML = `
      <div class="srv-create glass-panel">
        <div class="srv-create-head">
          <h3>Create a New Minecraft Server</h3>
          <button type="button" class="btn btn-sm glass-btn" id="srvCCancel">${ico('back')}Back to Server Menu</button>
        </div>

        <div class="field-group">
          <label class="field-label" for="srvCName">Server Name</label>
          <input type="text" class="inex-input glass-input" id="srvCName" maxlength="40" value="${esc(c.name || '')}" placeholder="e.g. X Survival SMP" />
        </div>

        <div class="field-group">
          <span class="field-label">Server Logo (optional)</span>
          <div class="srv-logo-drop" id="srvCLogoDrop" title="Drag & drop an image here, or click to choose">
            <div class="srv-logo-prev" id="srvCLogoPrev">${c.logo ? `<img src="${esc(c.logo)}" alt="" />` : '🖼'}</div>
            <div class="srv-logo-txt">
              <strong id="srvCLogoTitle">${c.logo ? 'Logo selected' : 'Drag &amp; drop a logo here'}</strong>
              <small>Any image · auto-resized to 64×64 (server-icon.png) · shown in the server list &amp; in Minecraft</small>
            </div>
            <button type="button" class="btn btn-sm glass-btn" id="srvCLogoClear" style="margin-left:auto;${c.logo ? '' : 'display:none;'}">Remove</button>
            <input type="file" id="srvCLogoFile" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" />
          </div>
        </div>

        <div class="field-group">
          <span class="field-label">Server Software (Loader)</span>
          <div class="srv-loaders-4">
            ${Object.keys(LOADER_INFO).map(k => `
              <button type="button" class="srv-loader${c.loader === k ? ' active' : ''}" data-loader="${k}">
                <strong>${LOADER_INFO[k].label}</strong>
                <small>${LOADER_INFO[k].note}</small>
              </button>`).join('')}
          </div>
        </div>

        <div class="srv-create-row">
          <div class="field-group">
            <label class="field-label" for="srvCVersion">Minecraft Version</label>
            <div class="vsel" id="srvCVersionWrap">
              <select class="inex-select glass-input vsel-native" id="srvCVersion"></select>
              <button type="button" class="vsel-btn" id="srvCVersionBtn" aria-haspopup="listbox"><span id="srvCVersionLabel">Loading...</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
              <div class="vsel-menu" id="srvCVersionMenu" role="listbox"></div>
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="srvCPort">Server Port</label>
            <input type="number" class="inex-input glass-input" id="srvCPort" min="1024" max="65535" value="${esc(c.port || 25565)}" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="srvCRam">
            <span>Allocated Memory (RAM)</span>
            <span class="srv-ram-val" id="srvCRamVal">${c.ramGb} GB</span>
          </label>
          <input type="range" id="srvCRam" min="1" max="${maxGb}" step="0.5" value="${c.ramGb}" class="srv-range" />
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">
          <div class="srv-prop srv-prop-bool" id="srvCPlayitCard">
            <div class="srv-prop-text">
              <label for="srvCPlayit">Auto Playit.gg Tunnel</label>
              <small>Automatically creates Playit.gg public tunnel when server starts</small>
            </div>
            <label class="switch"><input type="checkbox" id="srvCPlayit"${c.playit !== false ? ' checked' : ''}/><span class="slider-toggle"></span></label>
          </div>

          <div class="srv-prop srv-prop-bool" id="srvCBedrockCard" style="opacity:${supportsBedrock ? '1' : '0.45'};">
            <div class="srv-prop-text">
              <label for="srvCBedrock">Bedrock Edition Support (GeyserMC)</label>
              <small>${supportsBedrock ? 'Auto-installs GeyserMC for Bedrock crossplay' : 'Not supported on Vanilla (Pick Paper, Purpur, or Fabric)'}</small>
            </div>
            <label class="switch"><input type="checkbox" id="srvCBedrock"${supportsBedrock && c.bedrock !== false ? ' checked' : ''}${supportsBedrock ? '' : ' disabled'}/><span class="slider-toggle"></span></label>
          </div>
        </div>

        <div class="srv-prop srv-prop-bool" id="srvCEulaCard">
          <div class="srv-prop-text">
            <label for="srvCEula">Accept Minecraft EULA (Required)</label>
            <small>I agree to the official Minecraft End User License Agreement</small>
          </div>
          <label class="switch"><input type="checkbox" id="srvCEula"${c.eula ? ' checked' : ''}/><span class="slider-toggle"></span></label>
        </div>

        <div class="srv-progress" id="srvCProgress" style="display:${c.creating ? 'flex' : 'none'};">
          <span id="srvCProgressText">${esc((c.progress && c.progress.stage) || 'Working...')}</span>
          <div class="progress-track"><div class="progress-fill" id="srvCProgressFill" style="width:${(c.progress && c.progress.percent) || 0}%"></div></div>
        </div>

        <div class="srv-create-actions">
          <button type="button" class="btn btn-launch" id="srvCCreate"${c.creating ? ' disabled' : ''}>
            ${ico('plus')}${c.creating ? 'Downloading & Creating Server...' : 'Create Server'}
          </button>
        </div>
      </div>`;

    $('srvCName').addEventListener('input', e => { c.name = e.target.value; });
    bindLogoDrop(c);
    $('srvCPort').addEventListener('input', e => { c.port = e.target.value; });$('srvCPlayit').addEventListener('change', e => { c.playit = e.target.checked; });
    $('srvCBedrock').addEventListener('change', e => { c.bedrock = e.target.checked; });$('srvCEula').addEventListener('change', e => { c.eula = e.target.checked; });
    $('srvCRam').addEventListener('input', e => { c.ramGb = Number(e.target.value);$('srvCRamVal').textContent = `${c.ramGb} GB`; });
    $('srvCVersion').addEventListener('change', e => { c.version = e.target.value; });

    [['srvCPlayitCard', 'srvCPlayit'], ['srvCBedrockCard', 'srvCBedrock'], ['srvCEulaCard', 'srvCEula']].forEach(([cardId, inputId]) => {
      const card = $(cardId), inp =$(inputId);
      if (card && inp) {
        card.addEventListener('click', e => {
          if (inp.disabled || e.target.closest('label.switch') || e.target.tagName === 'LABEL') return;
          inp.checked = !inp.checked;
          inp.dispatchEvent(new Event('change'));
        });
      }
    });

    main.querySelectorAll('[data-loader]').forEach(b => b.addEventListener('click', () => {
      c.loader = b.getAttribute('data-loader');
      c.version = '';
      renderCreate(main);
      loadVersions(c.loader);
    }));

    $('srvCCancel').addEventListener('click', () => { S.mode = 'hub'; renderAll(); });$('srvCCreate').addEventListener('click', doCreate);
    bindVersionPicker();
    fillVersions();
  }

  async function doCreate() {
    const c = S.create;
    if (c.creating) return;
    if (!(c.name || '').trim()) { toast('Give your server a name.', 'warning'); return; }
    if (!c.version) { toast('Pick a Minecraft version.', 'warning'); return; }
    if (!c.eula) { toast('Accept the Minecraft EULA to continue.', 'warning'); return; }
    c.creating = true;
    c.progress = { stage: 'Downloading server JAR...', percent: 4 };
    renderMain();
    try {
      const srv = await api.createServer({
        name: c.name.trim(),
        loader: c.loader,
        version: c.version,
        ramMb: Math.round(c.ramGb * 1024),
        port: parseInt(c.port, 10) || 25565,
        eulaAccepted: true,
        playit: c.playit !== false,
        logo: c.logo || ''
      });

      if (c.loader !== 'vanilla' && c.bedrock !== false) {
        const t = $('srvCProgressText'), f =$('srvCProgressFill');
        if (t) t.textContent = 'Installing Bedrock Support (GeyserMC)...';
        if (f) f.style.width = '90%';
        try {
          await api.installBedrockSupport(srv.id);
        } catch (_) {}
      }

      toast(`Server "${srv.name}" created!`, 'success');
      c.creating = false; c.progress = null; c.name = ''; c.logo = '';
      S.selectedId = srv.id;
      S.mode = 'hub';
      S.tab = 'console';
      await refresh();
    } catch (err) {
      c.creating = false; c.progress = null;
      toast(err, 'error');
      if (S.mode === 'create') renderMain();
      fillVersions();
    }
  }

  function bindActions() {
    const box = $('srvActions');
    if (!box) return;
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => runAction(b.getAttribute('data-act'), b.getAttribute('data-id'))));
  }

  async function runAction(act, id) {
    const srvId = id || S.selectedId;
    if (!srvId) return;
    try {
      if (act === 'stop') {
        const s = S.servers.find(x => x.id === srvId);
        if (s) { s.status = 'stopping'; updateHeader(); }
        await api.stopServer(srvId);
        return;
      }
      if (act === 'start') await api.startServer(srvId);
      else if (act === 'restart') await api.restartServer(srvId);
      else if (act === 'kill') { await api.killServer(srvId); return; }
      await refresh(true);
    } catch (err) {
      toast(err, 'error');
      refresh();
    }
  }

  async function onDelete() {
    const srv = selected();
    if (!srv) return;
    if (srv.status === 'online' || srv.status === 'starting') { try { await api.killServer(srv.id); } catch (_) {} }
    const btn = $('srvDelete');
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.innerHTML = `${ico('warn')}Click again to confirm delete`;
      setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.innerHTML = `${ico('trash')}Delete`; } }, 4000);
      return;
    }
    try {
      await api.deleteServer(srv.id);
      toast('Server deleted.', 'success');
      S.selectedId = null;
      S.mode = 'hub';
      await refresh();
    } catch (err) { toast(err, 'error'); }
  }

  function renderAll() {
    renderMain();
    if (S.mode === 'create') fillVersions();
  }

  async function refresh(keepView) {
    try { S.servers = await api.listServers(); } catch (_) { S.servers = []; }
    if (S.selectedId && !S.servers.find(s => s.id === S.selectedId)) {
      S.logs.delete(S.selectedId);
      S.selectedId = S.servers[0] ? S.servers[0].id : null;
      if (S.mode === 'detail') S.mode = 'hub';
    }
    if (keepView) {
      if (S.mode === 'hub') renderMain(); else updateHeader();
      return;
    }
    renderAll();
    const id = S.selectedId;
    if (S.mode === 'detail' && id && !S.logs.has(id)) {
      try {
        const lines = await api.getServerLog(id);
        S.logs.set(id, (lines || []).map(line => ({ line, stream: 'out' })));
        if (id === S.selectedId && S.tab === 'console') renderBody();
      } catch (_) {}
    }
  }

  function handlePlayitStateUpdate(st) {
    if (!st) return;
    S.playit = Object.assign({}, S.playit, st);
    if (S.mode === 'hub') updateHeader();
    else if (S.mode === 'detail') {
      updateHeader();
      if (S.tab === 'network') paintNetwork();
    }
  }

  function init() {
    if (S.inited) return;
    S.inited = true;
    window.addEventListener('focus', () => { refresh(true); });
    setInterval(async () => {
      if (S.mode !== 'detail' || !S.selectedId) return;
      try { await api.getServer(S.selectedId); } catch (_) { refresh(); }
    }, 3000);
    injectCustomStyles();

    const newBtn = $('srvNewBtn');
    if (newBtn) newBtn.addEventListener('click', openCreate);

    if (api.getPlayitState) {
      api.getPlayitState().then(st => handlePlayitStateUpdate(st)).catch(() => {});
    }

    if (api.onServerLog) {
      api.onServerLog(d => pushLog(d.id, { line: d.line, stream: d.stream }));
    }

    if (api.onServerStatus) {
      api.onServerStatus(d => {
        const srv = S.servers.find(s => s.id === d.id);
        if (!srv) { refresh(); return; }
        const wasOffline = srv.status === 'offline';
        srv.status = d.status;
        srv.players = d.players || [];
        if (d.status === 'starting' && wasOffline) {
          srv.startedAt = Date.now();
          S.logs.set(d.id, []);
          if (d.id === S.selectedId && S.tab === 'console' && S.mode === 'detail') renderBody();
        }
        if (d.status === 'offline') {
          S.logs.set(d.id, []);
          if (d.id === S.selectedId && S.tab === 'console' && S.mode === 'detail') renderBody();
          S.progress = null;
          srv.cpu = 0;
          srv.usedRamMb = 0;
        }
        if (S.mode === 'hub') { renderMain(); return; }
        if (S.mode === 'detail' && d.id === S.selectedId) {
          updateHeader();
          if (S.tab === 'players') schedulePlayers(350);
          if (S.tab === 'network') loadNetwork();
        }
      });
    }

    if (api.onServerExit) {
      api.onServerExit(d => {
        const srv = S.servers.find(s => s.id === d.id);
        if (d.crashed) toast(`${srv ? srv.name : 'Server'} stopped unexpectedly. Check console.`, 'error');
      });
    }

    if (api.onServerProgress) {
      api.onServerProgress(p => {
        if (S.create.creating) {
          S.create.progress = p;
          const t = $('srvCProgressText'), f =$('srvCProgressFill');
          if (t) t.textContent = p.stage || 'Working...';
          if (f) f.style.width = `${p.percent || 0}%`;
        } else {
          S.progress = p;
          updateHeader();
        }
      });
    }

    if (api.onServerStats) {
      api.onServerStats(d => {
        const srv = S.servers.find(s => s.id === d.id);
        if (srv) {
          srv.cpu = d.cpu;
          srv.usedRamMb = d.ramMb;
        }
        updateHeader();
      });
    }

    if (api.onPlayitState) {
      api.onPlayitState(st => handlePlayitStateUpdate(st));
    }

    if (api.onServerBedrock) {
      api.onServerBedrock(d => {
        const srv = S.servers.find(s => s.id === d.id);
        if (srv) srv.bedrock = { supported: true, geyser: true, port: d.port || 19132, running: true };
        if (d.needsRestart) toast('Bedrock support configured for offline login. Restart server once.', 'info');
        if (S.mode === 'hub') renderMain();
        else if (S.mode === 'detail' && d.id === S.selectedId && S.tab === 'network') loadNetwork();
      });
    }

    S.timer = setInterval(() => {
      const srv = selected();
      if (srv && (srv.status === 'online' || srv.status === 'starting') && S.mode === 'detail' && $('srvUptime')) {const sMs = typeof srv.startedAt === 'string' ? Date.parse(srv.startedAt) : Number(srv.startedAt); $('srvUptime').textContent = sMs && !isNaN(sMs) ? fmtUptime(Date.now() - sMs) : '--';
      }
      if (api.getPlayitState && (S.playit.status === 'downloading' || S.playit.status === 'starting' || S.playit.status === 'linking')) {
        api.getPlayitState().then(st => handlePlayitStateUpdate(st)).catch(() => {});
      }
    }, 1500);
  }

  window.InexServerUI = {
    show() {
      init();
      if (S.mode === 'create' && S.create.creating) { renderAll(); return; }
      if (S.mode === 'create') S.mode = 'hub';
      refresh();
    }
  };
})();