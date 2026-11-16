/**
 * CRYOX CLIENT — Renderer Application Controller (Fixed Direct IPC + Full Features)
 */
(function () {
  'use strict';

  const PRESET_VERSION_CARDS = [
    { id: '26.3', title: '26.3', subtitle: 'The Next Dimension', badge: 'LATEST', icon: 'star', bg: 'linear-gradient(155deg, #e11d48 0%, #4c0519 55%, #040404 100%)' },
    { id: '26.2', title: '26.2', subtitle: 'Garden & Deep Trials', badge: 'STABLE', icon: 'layers', bg: 'linear-gradient(155deg, #9333ea 0%, #3b0764 55%, #060606 100%)' },
    { id: '1.21.4', title: '1.21.4', subtitle: 'The Garden Awakens', badge: 'LTS', icon: 'shield', bg: 'linear-gradient(155deg, #be123c 0%, #3f0d1c 55%, #0c0c0c 100%)' },
    { id: '1.21.1', title: '1.21.1', subtitle: 'Tricky Trials', badge: 'POPULAR', icon: 'bolt', bg: 'linear-gradient(155deg, #9f1239 0%, #1e293b 60%, #111111 100%)' },
    { id: '1.20.4', title: '1.20.4', subtitle: 'Trails & Tales', badge: 'MODDED', icon: 'hex', bg: 'linear-gradient(155deg, #881337 0%, #31102f 60%, #0a0a0a 100%)' },
    { id: '1.19.4', title: '1.19.4', subtitle: 'The Wild Update', badge: 'LEGACY', icon: 'compass', bg: 'linear-gradient(155deg, #065f46 0%, #111111 65%, #060606 100%)' },
    { id: '1.16.5', title: '1.16.5', subtitle: 'Nether Update', badge: 'FORGE', icon: 'flame', bg: 'linear-gradient(155deg, #7f1d1d 0%, #101010 65%, #060606 100%)' },
    { id: '1.8.9',  title: '1.8.9',  subtitle: 'Bountiful PvP', badge: 'PVP', icon: 'sword', bg: 'linear-gradient(155deg, #1d4ed8 0%, #172554 65%, #060606 100%)' }
  ];

  const api = window.inexAPI;

  const state = {
    activeTab: 'home',
    settings: {},
    profiles: [],
    activeProfileId: null,
    accounts: [],
    activeAccountId: null,
    skinSlots: [],
    versions: [],
    javaRuntimes: [],
    runningProfileIds: new Set(),
    discordStatus: null,
    advancedSetupOpen: false,
    pendingDeleteProfileId: null,
    contentType: 'mod',
    contentMode: 'browse',
    modrinthHits: [],
    modrinthTotal: 0,
    modrinthOffset: 0,
    modrinthLimit: 15,
    installedItems: [],
    selectedProjectForModal: null,
    pendingUploadSlotId: null,
    activityName: ''
  };

  const $ = id => document.getElementById(id);
  const on = (idOrEl, evt, fn) => {
    const el = typeof idOrEl === 'string' ? $(idOrEl) : idOrEl;
    if (el) el.addEventListener(evt, fn);
  };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (name, cls = 'ico-sm') => `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;
  const spineFor = version => {
    const card = PRESET_VERSION_CARDS.find(c => c.id === version);
    return card ? card.bg.replace('155deg', '180deg') : 'linear-gradient(180deg, #e11d48, #4c0519)';
  };

  function patchIconStrokes() {
    document.querySelectorAll('symbol [stroke-width]').forEach(el => {
      el.style.strokeWidth = `var(--ico-sw, ${el.getAttribute('stroke-width')})`;
    });
  }

  // ---------- CRYOX theme (light default / dark) ----------
  function getCryoxTheme() {
    try { return localStorage.getItem('cryox_theme') === 'dark' ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }
  function applyCryoxTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.theme-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === t));
  }
  function setCryoxTheme(theme) {
    try { localStorage.setItem('cryox_theme', theme === 'dark' ? 'dark' : 'light'); } catch (_) {}
    applyCryoxTheme(theme);
  }

  // ---------- Rust Native Engine (Horizon) ----------
  const RUST_BUILDS_FALLBACK = [
    { id: 'horizon-26.3', name: 'Horizon 26.3', channel: 'Stable', desc: 'Stable Horizon build. Pure Rust wgpu renderer, vanilla parity.', installed: false },
    { id: 'horizon-nightly', name: 'Horizon Nightly', channel: 'Nightly', desc: 'Latest experimental build. Newest features, may be unstable.', installed: false }
  ];
  const rustSettingsKey = 'cryox_rust_settings';
  function loadRustSettings() {
    try { return Object.assign({ backend: 'auto', gameDir: '', syncPacks: true }, JSON.parse(localStorage.getItem(rustSettingsKey) || '{}')); }
    catch (_) { return { backend: 'auto', gameDir: '', syncPacks: true }; }
  }
  function saveRustSettings(partial) {
    const next = Object.assign(loadRustSettings(), partial);
    try { localStorage.setItem(rustSettingsKey, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  async function rustApiCall(name, payload) {
    if (api && typeof api[name] === 'function') return api[name](payload);
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      const channelMap = {
        listRustVersions: 'rust:listVersions',
        installRust: 'rust:install',
        launchRust: 'rust:launch',
        openRustFolder: 'rust:openFolder'
      };
      const chan = channelMap[name] || name;
      return window.__TAURI__.core.invoke('inex_invoke', { channel: chan, args: payload !== undefined ? [payload] : [] });
    }
    throw new Error('Rust backend command "' + name + '" is not connected yet.');
  }
  const rustProfilesKey = 'cryox_rust_profiles';
  function loadRustProfiles() {
    try {
      const d = JSON.parse(localStorage.getItem(rustProfilesKey) || '{}');
      const list = Array.isArray(d.list) ? d.list : [];
      return { list, active: list.some(p => p.id === d.active) ? d.active : (list[0] ? list[0].id : null) };
    } catch (_) { return { list: [], active: null }; }
  }
  function saveRustProfiles(d) { try { localStorage.setItem(rustProfilesKey, JSON.stringify(d)); } catch (_) {} }
  let rustBuildsCache = RUST_BUILDS_FALLBACK;
  const rustBuildName = id => { const b = rustBuildsCache.find(x => x.id === id); return b ? (b.name || b.id) : id; };

  function renderRustHome() {
    const d = loadRustProfiles();
    const prof = d.list.find(p => p.id === d.active) || null;
    const rs = loadRustSettings();
    const backendNames = { auto: 'Auto', dx12: 'DirectX 12', vulkan: 'Vulkan' };
    if ($('rustBackendBadge')) $('rustBackendBadge').textContent = backendNames[rs.backend] || 'Auto';
    $('rustBuildBadge').textContent = prof ? rustBuildName(prof.build) : 'No profile selected';

    const isRunning = prof && state.runningProfileIds && state.runningProfileIds.has(prof.id);
    const splitBox = $('rustLaunchSplitBox');
    if (splitBox) splitBox.classList.toggle('running', Boolean(isRunning));

    if (isRunning) {
      $('rustStatusBadge').textContent = 'Status: Game Running';
      $('rustMainPlayTitle').textContent = 'STOP GAME';
      $('rustMainPlaySub').textContent = `${prof.name} \u2022 Running (Click to stop)`;
      if ($('rustMainPlayHint')) $('rustMainPlayHint').textContent = 'Click to stop the running Horizon engine';
    } else {
      $('rustStatusBadge').textContent = prof ? ('Profile: ' + prof.name) : 'Create a Rust profile to play';
      $('rustMainPlayTitle').textContent = prof ? 'PLAY' : 'CREATE RUST PROFILE';
      $('rustMainPlaySub').textContent = prof ? (prof.name + ' \u2022 ' + rustBuildName(prof.build)) : 'No Rust profile yet. Click to create one.';
      if ($('rustMainPlayHint')) $('rustMainPlayHint').textContent = 'Zero JVM \u2022 Horizon native engine';
    }

    const dd = $('rustProfileDropdown');
    dd.innerHTML = '';
    if (!d.list.length) {
      const it = document.createElement('div'); it.className = 'dropdown-item';
      it.innerHTML = '<div style="font-weight:700; font-size:13px;">+ Create your first Rust profile</div>';
      it.addEventListener('click', () => { dd.classList.remove('open'); showRustSub('create'); });
      dd.appendChild(it);
    }
    d.list.forEach(p => {
      const it = document.createElement('div'); it.className = 'dropdown-item' + (p.id === d.active ? ' active' : '');
      const t = document.createElement('div'); t.style.cssText = 'font-weight:700; font-size:13px;'; t.textContent = p.name;
      const s = document.createElement('div'); s.style.cssText = 'font-size:11px; opacity:.7;'; s.textContent = rustBuildName(p.build);
      const wrap = document.createElement('div'); wrap.appendChild(t); wrap.appendChild(s); it.appendChild(wrap);
      it.addEventListener('click', () => { saveRustProfiles({ list: d.list, active: p.id }); dd.classList.remove('open'); renderRustHome(); });
      dd.appendChild(it);
    });

    const row = $('rustQuickProfilesRow');
    if (row) {
      row.querySelectorAll('.rust-pill').forEach(n => n.remove());
    }
  }
  const RUST_PRESETS = [
    { id: 'nightly', title: 'Horizon Nightly', subtitle: 'MC 26.3 Experimental', badge: 'LATEST', icon: 'star' },
    { id: 'v0.2.97', title: 'Horizon 0.2.97', subtitle: 'Vanilla Parity Stable', badge: 'STABLE', icon: 'layers' },
    { id: 'vulkan-fast', title: 'Vulkan Engine', subtitle: 'Ultra High FPS (wgpu)', badge: 'FAST', icon: 'bolt', backend: 'vulkan' },
    { id: 'dx12-native', title: 'DirectX 12', subtitle: 'Native Windows Pipeline', badge: 'NATIVE', icon: 'monitor', backend: 'dx12' },
  ];

  function renderRustPresets(selectedBuild) {
    const grid = $('rustVersionPostersGrid');
    if (!grid) return;
    grid.innerHTML = '';
    RUST_PRESETS.forEach(p => {
      const isSel = (p.id === selectedBuild) || (p.id === 'nightly' && String(selectedBuild).includes('nightly'));
      const card = document.createElement('div');
      card.className = 'engine-preset-card' + (isSel ? ' selected' : '');
      card.innerHTML = `
        <div class="preset-icon-box">${ico(p.icon, 'ico')}</div>
        <div class="preset-info">
          <div class="preset-ver">${esc(p.title)}</div>
          <div class="preset-sub">${esc(p.subtitle)}</div>
        </div>
        <span class="preset-badge">${esc(p.badge)}</span>
      `;
      card.addEventListener('click', () => {
        const sel = $('rustProfileBuildSelect');
        if (p.backend && $('rustProfileBackendSelect')) {
          $('rustProfileBackendSelect').value = p.backend;
        }
        if (sel && (p.id === 'nightly' || p.id === 'v0.2.97')) {
          let found = Array.from(sel.options).find(o => o.value === p.id || o.value.includes(p.id));
          if (found) sel.value = found.value;
        }
        renderRustPresets(p.id);
        const nameInp = $('rustProfileNameInput');
        if (nameInp && (!nameInp.value || nameInp.value.startsWith('Horizon-'))) {
          nameInp.value = p.title.replace(/\s+/g, '-');
        }
      });
      grid.appendChild(card);
    });
  }

  let editingRustProfileId = null;

  function populateRustCreateForm(editingProfile = null) {
    editingRustProfileId = editingProfile ? editingProfile.id : null;
    const sel = $('rustProfileBuildSelect');
    if (sel) {
      sel.innerHTML = '';
      const builds = (rustBuildsCache && rustBuildsCache.length) ? rustBuildsCache : RUST_BUILDS_FALLBACK;
      builds.forEach(b => {
        const o = document.createElement('option');
        o.value = b.id;
        o.textContent = b.name || b.id;
        sel.appendChild(o);
      });
      if (editingProfile && editingProfile.build) {
        sel.value = editingProfile.build;
      } else if (sel.options.length > 0 && !sel.value) {
        sel.selectedIndex = 0;
      }
    }
    const curBuild = (sel && sel.value) || 'nightly';
    const nameInp = $('rustProfileNameInput');
    if (nameInp) {
      nameInp.value = editingProfile ? editingProfile.name : (nameInp.value || 'Horizon-Nightly');
    }
    if ($('rustProfileBackendSelect')) {
      $('rustProfileBackendSelect').value = (editingProfile && editingProfile.backend) || 'auto';
    }
    if ($('rustCreateHeaderTitle')) {
      $('rustCreateHeaderTitle').textContent = editingProfile ? `Edit ${editingProfile.name}` : 'Create Rust Profile';
    }
    if ($('rustCreateFormModeLabel')) {
      $('rustCreateFormModeLabel').textContent = editingProfile ? 'EDIT RUST PROFILE' : 'CREATE RUST PROFILE';
    }
    if ($('rustProfileSaveBtn')) {
      $('rustProfileSaveBtn').textContent = editingProfile ? 'Save Changes' : 'Create Rust Profile';
    }
    renderRustPresets(curBuild);
    if (nameInp) nameInp.focus();
  }

  function showRustSub(which, extra = null) {
    $('rustHomeSubView').style.display = which === 'home' ? 'flex' : 'none';
    $('view-rust').classList.toggle('rust-home-on', which === 'home');
    $('rustProfilesSubView').style.display = which === 'profiles' ? 'flex' : 'none';
    if ($('rustCreateProfileSubView')) {
      $('rustCreateProfileSubView').style.display = which === 'create' ? 'flex' : 'none';
    }
    if (which === 'home') renderRustHome();
    else if (which === 'profiles') renderRustProfilesPage();
    else if (which === 'create') populateRustCreateForm(extra);
  }

  function renderRustProfilesPage() {
    const grid = $('rustProfilesGrid');
    if (!grid) return;
    const d = loadRustProfiles();
    const q = String(($('rustProfileSearchInput') && $('rustProfileSearchInput').value) || '').toLowerCase().trim();
    grid.innerHTML = '';
    d.list.filter(p => !q || p.name.toLowerCase().includes(q) || rustBuildName(p.build).toLowerCase().includes(q)).forEach(p => {
      const isSel = p.id === d.active;
      const card = document.createElement('div');
      card.className = 'profile-card' + (isSel ? ' active' : '');
      const top = document.createElement('div'); top.className = 'profile-card-top';
      const av = document.createElement('div'); av.className = 'profile-avatar'; av.textContent = '⚡';
      const info = document.createElement('div'); info.className = 'profile-info';
      const nm = document.createElement('div'); nm.className = 'profile-name'; nm.textContent = p.name;
      const meta = document.createElement('div'); meta.className = 'profile-meta-line'; meta.textContent = 'Horizon (Rust) \u2022 ' + rustBuildName(p.build);
      info.appendChild(nm); info.appendChild(meta);
      top.appendChild(av); top.appendChild(info);
      if (isSel) { const bd = document.createElement('div'); bd.className = 'active-check-badge'; bd.innerHTML = ico('check', 'ico-xs'); top.appendChild(bd); }
      top.addEventListener('click', () => { saveRustProfiles({ list: d.list, active: p.id }); renderRustProfilesPage(); });
      const acts = document.createElement('div'); acts.className = 'profile-card-actions';
      const isRunning = state.runningProfileIds && state.runningProfileIds.has(p.id);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'btn btn-sm btn-launch ' + (isRunning ? 'btn-stop' : 'btn-play');
      play.innerHTML = isRunning ? (ico('square') + 'Stop') : (ico('play') + 'Play');
      play.addEventListener('click', async (e) => {
        e.stopPropagation();
        saveRustProfiles({ list: d.list, active: p.id });
        renderRustHome();
        await playRustActive();
      });

      const divider = document.createElement('span'); divider.className = 'action-divider';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'icon-btn';
      editBtn.title = 'Edit profile';
      editBtn.innerHTML = ico('edit');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRustCreateForm(p);
      });

      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'icon-btn';
      folderBtn.title = 'Open profile folder';
      folderBtn.innerHTML = ico('folder');
      folderBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await rustApiCall('openRustFolder', p.id);
          showToast('Folder opened');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn danger';
      del.title = 'Delete Rust profile';
      del.innerHTML = ico('trash');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const nl = d.list.filter(x => x.id !== p.id);
        saveRustProfiles({ list: nl, active: d.active === p.id ? (nl[0] ? nl[0].id : null) : d.active });
        renderRustProfilesPage();
        renderRustHome();
      });

      acts.appendChild(play);
      acts.appendChild(divider);
      acts.appendChild(editBtn);
      acts.appendChild(folderBtn);
      acts.appendChild(del);
      card.appendChild(top);
      card.appendChild(acts);
      grid.appendChild(card);
    });
    const tile = document.createElement('div'); tile.className = 'add-card-tile';
    tile.innerHTML = ico('plus') + '<span>Create profile</span>';
    tile.addEventListener('click', () => openRustCreateForm());
    grid.appendChild(tile);
  }

  function openRustCreateForm(editingProfile = null) {
    showRustSub('create', editingProfile);
  }

  function saveRustProfileFromForm() {
    const nameInp = $('rustProfileNameInput');
    const name = nameInp ? nameInp.value.trim() : '';
    if (!name) { showToast('Give the Rust profile a name.', 'info'); return; }
    const sel = $('rustProfileBuildSelect');
    const build = (sel && sel.value) || 'nightly';
    const backend = ($('rustProfileBackendSelect') && $('rustProfileBackendSelect').value) || 'auto';
    const d = loadRustProfiles();

    if (editingRustProfileId) {
      const existing = d.list.find(p => p.id === editingRustProfileId);
      if (existing) {
        existing.name = name;
        existing.build = build;
        existing.backend = backend;
        saveRustProfiles({ list: d.list, active: editingRustProfileId });
        if (backend && backend !== 'auto') {
          saveRustSettings({ backend });
        }
        editingRustProfileId = null;
        showToast('Rust profile updated: ' + name, 'success');
        showRustSub('profiles');
        renderRustHome();
        return;
      }
    }

    const id = 'rp-' + Date.now().toString(36);
    d.list.push({ id, name, build, backend });
    saveRustProfiles({ list: d.list, active: id });
    if (backend && backend !== 'auto') {
      saveRustSettings({ backend });
    }
    showToast('Rust profile created: ' + name, 'success');
    showRustSub('profiles');
    renderRustHome();
  }

  async function playRustActive() {
    const acc = getActiveAccount();
    if (!acc) {
      showToast('Add an account in the Accounts tab before launching.', 'error');
      switchNavigation('accounts');
      return;
    }

    const d = loadRustProfiles();
    const prof = d.list.find(p => p.id === d.active);
    if (!prof) { openRustCreateForm(); return; }

    if (state.runningProfileIds && state.runningProfileIds.has(prof.id)) {
      try {
        await api.stopProfile(prof.id);
        state.runningProfileIds.delete(prof.id);
        syncGameRunningMode();
        renderRustHome();
        renderRustProfilesPage();
        showToast('Game stopped');
      } catch (err) {
        showToast('Failed to stop game: ' + err.message, 'error');
      }
      return;
    }

    try {
      state.activityName = prof.name;
      progressShow(`Preparing ${prof.name}`, 20, 'Checking Horizon engine & files…');

      const res = await rustApiCall('launchRust', { id: prof.build, profile: prof, settings: loadRustSettings() });
      if (res && (res.launched || res.success)) {
        state.runningProfileIds.add(prof.id);
        syncGameRunningMode();
        renderRustHome();
        renderRustProfilesPage();
        progressDone('Game launched');
        showToast('Game launched', 'success');
        if (state.settings && state.settings.closeBehavior === 'minimize') {
          try { api.minimizeWindow(); } catch (_) {}
        }
      } else {
        progressHide();
      }
    } catch (err) {
      progressHide();
      appendConsoleLog(`[HORIZON ERROR] ${cleanErrorMessage(err.message)}`, 'error');
      showToast(err.message, 'error');
    } finally {
      state.activityName = '';
    }
  }

  async function renderRustView() {
    const list = $('rustVersionsList');
    if (!list) return;
    let builds = RUST_BUILDS_FALLBACK;
    try {
      const r = await rustApiCall('listRustVersions');
      if (Array.isArray(r) && r.length) builds = r;
      else if (r && Array.isArray(r.versions) && r.versions.length) builds = r.versions;
    } catch (_) { /* backend not wired: show default Horizon builds */ }
    rustBuildsCache = builds;
    renderRustHome();
    list.innerHTML = '';
    builds.forEach(b => {
      const card = document.createElement('div');
      card.className = 'rust-card';
      const ico = document.createElement('div'); ico.className = 'rust-card-ico'; ico.textContent = '⚡';
      const body = document.createElement('div'); body.className = 'rust-card-body';
      const title = document.createElement('div'); title.className = 'rust-card-title';
      title.appendChild(document.createTextNode(b.name || b.id));
      const tag = document.createElement('span'); tag.className = 'rust-tag' + (b.installed ? ' ok' : '');
      tag.textContent = b.installed ? 'INSTALLED' : (b.channel || 'AVAILABLE').toUpperCase();
      title.appendChild(tag);
      const sub = document.createElement('div'); sub.className = 'rust-card-sub'; sub.textContent = b.desc || 'Horizon native build';
      body.appendChild(title); body.appendChild(sub);
      const actions = document.createElement('div'); actions.className = 'rust-card-actions';
      const instBtn = document.createElement('button'); instBtn.type = 'button'; instBtn.className = 'btn'; instBtn.textContent = b.installed ? 'Reinstall' : 'Install';
      instBtn.addEventListener('click', async () => {
        try {
          instBtn.disabled = true;
          instBtn.textContent = 'Installing…';
          showToast('Downloading & installing ' + (b.name || b.id) + '…', 'info');
          await rustApiCall('installRust', { id: b.id, downloadUrl: b.downloadUrl });
          showToast((b.name || b.id) + ' installed successfully!', 'success');
          renderRustView();
        } catch (err) {
          instBtn.disabled = false;
          instBtn.textContent = b.installed ? 'Reinstall' : 'Install';
          showToast(err.message, 'error');
        }
      });
      actions.appendChild(instBtn);
      card.appendChild(ico); card.appendChild(body); card.appendChild(actions);
      list.appendChild(card);
    });
  }
  function renderRustSettings() {
    const r = loadRustSettings();
    if ($('rustGraphicsBackend')) $('rustGraphicsBackend').value = r.backend;
    if ($('rustGameDirInput')) $('rustGameDirInput').value = r.gameDir || '';
    if ($('rustSyncPacksToggle')) $('rustSyncPacksToggle').checked = !!r.syncPacks;
  }

  function applyAppearanceSettings() {
    const blurPx = Number(state.settings.glassIntensity) || 24;
    document.documentElement.style.setProperty('--glass-blur', `${blurPx}px`);
    applyCryoxTheme(getCryoxTheme());
    // Matrix theme options: corner shape, highlight style and highlight colour
    const mxHex = /^#[0-9a-f]{6}$/i.test(state.settings.matrixHlColor || '') ? state.settings.matrixHlColor : '#ffffff';
    const mxGlass = state.settings.matrixHlStyle === 'glass';
    const mxRgb = [1, 3, 5].map(i => parseInt(mxHex.slice(i, i + 2), 16));
    const mxLum = (0.299 * mxRgb[0] + 0.587 * mxRgb[1] + 0.114 * mxRgb[2]) / 255;
    document.body.dataset.nxShape = state.settings.matrixShape === 'default' ? 'default' : 'round';
    document.body.dataset.nxHl = mxGlass ? 'glass' : 'solid';
    document.body.style.setProperty('--nx-hl', mxHex);
    document.body.style.setProperty('--nx-hl-bg', mxGlass ? `rgba(${mxRgb.join(',')},.22)` : mxHex);
    document.body.style.setProperty('--nx-hl-fg', mxGlass ? '#fff' : (mxLum > 0.6 ? '#000' : '#fff'));
    // Single wallpaper, shown inside the border on both Play and Server screens
    const wp = state.settings.wallpaper || '';
    document.body.classList.toggle('has-wp', !!wp);
    if (wp) document.body.style.setProperty('--wp', `url("${wp}")`);
    else document.body.style.removeProperty('--wp');
    const embeddedLogo = window.INEX_DEFAULT_LOGO || '';
    const customLogo = state.settings.customLogoDataUrl || '';
    document.querySelectorAll('.custom-logo-target').forEach(img => {
      img.onerror = () => {
        if (embeddedLogo && img.getAttribute('src') !== embeddedLogo) {
          img.onerror = null;
          img.src = embeddedLogo;
        }
      };
      img.src = customLogo || 'inex-logo.png';
    });
  }

  function versionBadge(profile) {
    const v = String((profile && profile.version) || '').trim();
    const parts = v.split('.');
    let out = '';
    if (parts[0] === '1' && parts[1]) out = parts[1];
    else if (parts[0]) out = parts[0];
    out = out.replace(/[^0-9A-Za-z]/g, '').slice(0, 3);
    return (out || String((profile && profile.name) || '?').slice(0, 2)).toUpperCase();
  }

  function cleanErrorMessage(msg) {
    return String(msg || 'Something went wrong')
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^(Uncaught\s+)?Error:\s*/i, '')
      .trim();
  }

  function showToast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const text = type === 'error' ? cleanErrorMessage(message) : String(message || '').trim();
    if (!text) return;
    for (const el of container.children) {
      if (el.textContent === text) return;
    }
    const item = document.createElement('div');
    item.className = 'toast-item';
    if (type === 'error') item.style.borderLeftColor = '#ef4444';
    else if (type === 'success') item.style.borderLeftColor = '#10b981';
    else if (type === 'warning') item.style.borderLeftColor = '#f59e0b';
    item.textContent = text;
    container.appendChild(item);
    while (container.children.length > 3) container.firstChild.remove();
    const life = type === 'error' ? 6000 : 3200;
    setTimeout(() => {
      item.classList.add('leaving');
      setTimeout(() => item.remove(), 220);
    }, life);
  }

  let progressHideTimer = null;

  function progressShow(title, percent = 0, sub = '') {
    clearTimeout(progressHideTimer);
    const d = $('installProgressDrawer');
    if (!d) return;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    d.classList.remove('done');
    d.classList.add('visible');
    if ($('progressStageText')) $('progressStageText').textContent = title;
    if ($('progressDetailText')) $('progressDetailText').textContent = sub;
    if ($('progressPercentText')) $('progressPercentText').textContent = `${p}%`;
    if ($('progressBarFill')) $('progressBarFill').style.width = `${p}%`;
  }

  function progressDone(title, sub = '') {
    clearTimeout(progressHideTimer);
    const d = $('installProgressDrawer');
    if (!d) return;
    d.classList.add('visible', 'done');
    if ($('progressStageText')) $('progressStageText').textContent = title;
    if ($('progressDetailText')) $('progressDetailText').textContent = sub;
    if ($('progressPercentText')) $('progressPercentText').textContent = '100%';
    if ($('progressBarFill')) $('progressBarFill').style.width = '100%';
    progressHideTimer = setTimeout(progressHide, 1700);
  }

  function progressHide() {
    clearTimeout(progressHideTimer);
    const d = $('installProgressDrawer');
    if (d) d.classList.remove('visible', 'done');
  }

  function describeProgress(data) {
    const stage = String(data.stage || '');
    const name = state.activityName || '';
    const lower = stage.toLowerCase();
    let title = stage || 'Working…';
    if (data.projectId) {
      if (lower.includes('download')) title = name ? `Downloading ${name}` : 'Downloading';
      else title = name ? `Installing ${name}` : 'Installing';
    } else if (lower.includes('java')) {
      title = 'Preparing Java';
    } else if (lower.includes('librar') || lower.includes('asset') || lower.includes('native')) {
      title = 'Downloading game files';
    } else if (lower.includes('client processor')) {
      title = 'Setting up your loader';
    }
    let sub = '';
    if (!data.projectId && data.detail && !/[A-Za-z]:\\|\\|\//.test(data.detail)) {
      sub = data.detail;
    }
    return { title, sub };
  }

  function appendConsoleLog(line, level = 'info') {
    const box = $('logConsoleOutput');
    if (!box) return;
    // Keep the console small: it used to grow forever and re-layout on every game log line.
    while (box.childElementCount >= 300) box.removeChild(box.firstElementChild);
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    if (level === 'error') div.style.color = '#f87171';
    else if (level === 'warn') div.style.color = '#fbbf24';
    else if (level === 'debug') div.style.color = '#9ca3af';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // While the game runs, the launcher stops all animations/blur so it does not steal GPU from Minecraft.
  function syncGameRunningMode() {
    document.body.classList.toggle('game-running', state.runningProfileIds && state.runningProfileIds.size > 0);
  }

  function formatCompactNumber(num) {
    const n = Number(num) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function getActiveProfile() {
    if (!state.profiles.length) return null;
    return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0] || null;
  }

  function getActiveAccount() {
    return state.accounts.find(a => a.id === state.activeAccountId) || state.accounts[0] || null;
  }

  function openProfileContentBrowser(contentType = 'mod') {
    const prof = getActiveProfile();
    if (!prof) {
      showToast('Create a profile first to manage mods, resource packs and shaders.', 'info');
      switchNavigation('profiles');
      openCreateProfileForm();
      return;
    }
    state.contentType = contentType;
    state.activeTab = 'content';
    document.body.setAttribute('data-active-tab', 'content');

    document.querySelectorAll('.nav-btn[data-nav]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-nav') === 'profiles');
    });
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    if ($('view-content')) $('view-content').classList.add('active');
    refreshContentBrowser();
  }

  // used by online-ui.js after "log in with username + password" so the Identities list updates
  window.inexRefreshAccounts = async () => {
    try {
      const u = await api.listAccounts();
      state.accounts = u.accounts; state.activeAccountId = u.activeAccountId; state.skinSlots = u.skinSlots || [];
      renderAccountsView();
    } catch (_) {}
  };

  function switchNavigation(targetNav) {
    if (!targetNav) return;
    state.activeTab = targetNav;
    document.body.setAttribute('data-active-tab', targetNav);

    document.querySelectorAll('.nav-btn[data-nav]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-nav') === targetNav);
    });
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

    if (targetNav === 'home') {
      if ($('view-home')) $('view-home').classList.add('active');
      renderHomeView();
    } else if (targetNav === 'profiles') {
      if ($('view-profiles')) $('view-profiles').classList.add('active');
      if ($('profilesListSubView')) $('profilesListSubView').style.display = 'block';
      if ($('createProfileSubView')) $('createProfileSubView').style.display = 'none';
      renderProfilesView();
    } else if (targetNav === 'accounts') {
      if ($('view-accounts')) $('view-accounts').classList.add('active');
      if ($('accountsListSubView')) $('accountsListSubView').style.display = 'grid';
      if ($('addAccountSubView')) $('addAccountSubView').style.display = 'none';
      if ($('skinsManagerSubView')) $('skinsManagerSubView').style.display = 'flex';
      renderAccountsView();
    } else if (targetNav === 'server') {
      if ($('view-server')) $('view-server').classList.add('active');
      if (window.InexServerUI) window.InexServerUI.show();
    } else if (targetNav === 'rust') {
      if ($('view-rust')) $('view-rust').classList.add('active');
      renderRustView();
      showRustSub('home');
    } else if (targetNav === 'settings') {
      if ($('view-settings')) $('view-settings').classList.add('active');
      renderSettingsView();
      renderRustSettings();
      applyCryoxTheme(getCryoxTheme());
    }
  }

  function renderHeaderBar() {
    const prof = getActiveProfile();
    const dot = $('headerProfileDot');
    if (prof && $('headerProfileName')) {
      $('headerProfileName').textContent = prof.name;
      if (dot) dot.className = 'pill-status-dot' + (prof.installed ? '' : ' local');
    } else if ($('headerProfileName')) {
      $('headerProfileName').textContent = 'No profile';
    }
    const acc = getActiveAccount();
    if (acc && $('headerAccountName')) {
      $('headerAccountName').textContent = acc.username;
      if ($('headerAccountType')) $('headerAccountType').textContent = acc.type === 'microsoft' ? 'Microsoft' : 'Local';
      if ($('headerAccountAvatar')) $('headerAccountAvatar').innerHTML = renderMiniFaceSvg(acc.username);
    }
  }

  function renderMiniFaceSvg(seedStr) {
    const colors = ['#e11d48', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];
    const idx = String(seedStr || 'A').charCodeAt(0) % colors.length;
    const accent = colors[idx];
    return `<svg width="24" height="24" viewBox="0 0 24 24">
      <rect width="24" height="24" fill="#101010"/>
      <rect x="3" y="3" width="18" height="7" fill="#090909"/>
      <rect x="5" y="11" width="4" height="3" fill="${accent}"/>
      <rect x="15" y="11" width="4" height="3" fill="${accent}"/>
      <rect x="9" y="16" width="6" height="2" fill="#e5e5e5"/>
    </svg>`;
  }

  // 1. PLAY / MAIN MENU
  function renderHomeView() {
    renderHeaderBar();
    const prof = getActiveProfile();
    const splitBox = $('launchSplitBox');
    const dropdown = $('homeProfileDropdown');
    const row = $('homeQuickProfilesRow');
    if (!splitBox || !dropdown || !row) return;

    dropdown.innerHTML = '';
    row.innerHTML = '';

    if (!prof) {
      splitBox.classList.remove('running');
      $('homeVersionBadge').textContent = 'No profile selected';
      $('homeLoaderBadge').textContent = 'None';
      $('homeRamBadge').textContent = 'No profile';
      $('homeInstallBadge').textContent = 'Create a profile to play';

      $('mainPlayTitle').textContent = 'CREATE PROFILE';
      $('mainPlaySub').textContent = 'No profile yet. Click to create one.';
      $('mainPlayHint').textContent = 'Supports Fabric, Forge and Vanilla';

      const emptyItem = document.createElement('div');
      emptyItem.className = 'dropdown-item';
      emptyItem.innerHTML = `<div style="font-weight:700; font-size:13px;">+ Create your first profile</div>`;
      emptyItem.addEventListener('click', () => {
        dropdown.classList.remove('open');
        switchNavigation('profiles');
        openCreateProfileForm();
      });
      dropdown.appendChild(emptyItem);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'quick-profile-pill';
      addBtn.innerHTML = `<span>+ Add a Profile</span>`;
      addBtn.addEventListener('click', () => {
        switchNavigation('profiles');
        openCreateProfileForm();
      });
      row.appendChild(addBtn);
      return;
    }

    const loaderLabel = prof.loader ? prof.loader.charAt(0).toUpperCase() + prof.loader.slice(1) : 'Vanilla';
    const isRunning = state.runningProfileIds.has(prof.id);

    $('homeVersionBadge').textContent = `Minecraft ${prof.version}`;
    $('homeLoaderBadge').textContent = `${loaderLabel} (${prof.loaderVersion || 'latest'})`;
    $('homeRamBadge').textContent = `${(prof.ramMB / 1024).toFixed(1)} GB RAM`;
    $('homeInstallBadge').textContent = isRunning
      ? 'Game Running'
      : prof.installed
      ? 'Ready to Launch'
      : 'Installs on launch';

    splitBox.classList.toggle('running', isRunning);

    $('mainPlayTitle').textContent = isRunning ? 'STOP GAME' : 'LAUNCH GAME';
    $('mainPlaySub').textContent = `${prof.name} • ${loaderLabel} ${prof.version}`;
    $('mainPlayHint').textContent = isRunning ? 'Click to stop the running game' : 'Ready • Auto-Java';

    state.profiles.forEach(p => {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (p.id === prof.id ? ' active' : '');
      const lName = p.loader ? p.loader.charAt(0).toUpperCase() + p.loader.slice(1) : 'Vanilla';
      item.innerHTML = `
        <div>
          <div style="font-weight:700; font-size:13px;">${esc(p.name)}</div>
          <div style="font-size:11px; color:var(--text-secondary);">${lName} ${esc(p.version)} • ${(p.ramMB / 1024).toFixed(1)} GB</div>
        </div>
        <span style="font-size:11px; color:${p.installed ? 'var(--success)' : 'var(--crimson-400)'}; font-weight:700;">
          ${p.installed ? 'Ready' : 'Needs install'}
        </span>
      `;
      item.addEventListener('click', async () => {
        dropdown.classList.remove('open');
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        renderHomeView();
        renderRustHome();
        renderRustProfilesPage();
      });
      dropdown.appendChild(item);
    });

    const activePill = document.createElement('button');
    activePill.type = 'button';
    activePill.className = 'quick-profile-pill active';
    activePill.innerHTML = `
      <div class="quick-pill-icon">${esc(versionBadge(prof))}</div>
      <div style="text-align:left; flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(prof.name)}</div>
        <div style="font-size:10.5px; color:var(--text-secondary);">${loaderLabel} ${esc(prof.version)}</div>
      </div>
      <span style="font-size:10px; color:var(--text-muted);">&#9656;</span>
    `;
    activePill.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    row.appendChild(activePill);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'quick-profile-pill';
    addBtn.innerHTML = `<span>+ Add a Profile</span>`;
    addBtn.addEventListener('click', () => {
      switchNavigation('profiles');
      openCreateProfileForm();
    });
    row.appendChild(addBtn);

    const modsBtn = document.createElement('button');
    modsBtn.type = 'button';
    modsBtn.className = 'quick-profile-pill';
    modsBtn.innerHTML = `${ico('gear', 'ico-xs')}<span style="line-height:1.15; text-align:center;">Profile Mods &amp;<br/>Packs</span>`;
    modsBtn.addEventListener('click', () => openProfileContentBrowser('mod'));
    row.appendChild(modsBtn);
  }

  // 2. PROFILES & CREATE PROFILE
  function renderProfilesView() {
    renderHeaderBar();
    const grid = $('profilesGridContainer');
    if (!grid) return;

    const query = String(($('profileSearchInput') && $('profileSearchInput').value) || '').toLowerCase().trim();
    const sortBy = ($('profileSortSelect') && $('profileSortSelect').value) || 'version';

    const list = state.profiles
      .filter(p => !query || p.name.toLowerCase().includes(query) || p.version.toLowerCase().includes(query) || p.loader.toLowerCase().includes(query))
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'recent') return String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || ''));
        return String(b.version).localeCompare(String(a.version));
      });

    grid.innerHTML = '';

    list.forEach(p => {
      const isSelected = p.id === state.activeProfileId;
      const lName = p.loader ? p.loader.charAt(0).toUpperCase() + p.loader.slice(1) : 'Vanilla';
      const card = document.createElement('div');
      card.className = 'profile-card' + (isSelected ? ' active' : '');
      card.style.setProperty('--spine', spineFor(p.version));

      card.innerHTML = `
        <div class="profile-card-top">
          <div class="profile-avatar">${esc(versionBadge(p))}</div>
          <div class="profile-info">
            <div class="profile-name">${esc(p.name)}</div>
            <div class="profile-meta-line">
              ${p.loader === 'vanilla' ? '<span style="color:#fbbf24; font-weight:700;">Vanilla (no mods)</span> &bull; ' : ''}${lName} ${esc(p.version)}
            </div>
            <div class="profile-sub-badge">
              <span>${(p.ramMB / 1024).toFixed(1)} GB RAM</span>
              <span>&bull;</span>
              <span style="color:${p.installed ? 'var(--success)' : 'var(--crimson-400)'}; font-weight:600;">
                ${p.installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
          </div>
          ${isSelected ? `<div class="active-check-badge" title="Active profile">${ico('check', 'ico-xs')}</div>` : ''}
        </div>

        <div class="profile-card-actions">
          <button type="button" class="btn btn-sm btn-launch btn-play" data-action="play">${ico('play')}Play</button>
          <button type="button" class="icon-btn" data-action="mods" title="Mods">${ico('cube')}</button>
          <button type="button" class="icon-btn" data-action="modpacks" title="Modpacks">${ico('box')}</button>
          <button type="button" class="icon-btn" data-action="resourcepacks" title="Resource packs">${ico('image')}</button>
          <button type="button" class="icon-btn" data-action="shaders" title="Shaders">${ico('spark')}</button>
          <span class="action-divider"></span>
          <button type="button" class="icon-btn" data-action="edit" title="Edit profile">${ico('edit')}</button>
          <button type="button" class="icon-btn" data-action="folder" title="Open game folder">${ico('folder')}</button>
          <button type="button" class="icon-btn danger" data-action="delete" title="Delete profile">${ico('trash')}</button>
        </div>
      `;

      card.querySelector('.profile-card-top').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        renderProfilesView();
      });

      card.querySelector('[data-action="play"]').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        switchNavigation('home');
        triggerPlayOrStop();
      });

      card.querySelector('[data-action="mods"]').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        openProfileContentBrowser('mod');
      });

      card.querySelector('[data-action="modpacks"]').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        openProfileContentBrowser('modpack');
      });

      card.querySelector('[data-action="resourcepacks"]').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        openProfileContentBrowser('resourcepack');
      });

      card.querySelector('[data-action="shaders"]').addEventListener('click', async () => {
        const updated = await api.setActiveProfile(p.id);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        openProfileContentBrowser('shader');
      });

      card.querySelector('[data-action="edit"]').addEventListener('click', () => openCreateProfileForm(p));
      card.querySelector('[data-action="folder"]').addEventListener('click', async () => {
        await api.openProfileFolder(p.id);
        showToast('Folder opened');
      });
      card.querySelector('[data-action="delete"]').addEventListener('click', () => {
        state.pendingDeleteProfileId = p.id;
        $('deleteConfirmMessage').textContent = `Delete profile "${p.name}" (${lName} ${p.version})?`;
        $('deleteConfirmModalBackdrop').classList.add('open');
      });

      grid.appendChild(card);
    });

    const createTile = document.createElement('button');
    createTile.type = 'button';
    createTile.className = 'add-card-tile';
    createTile.innerHTML = `${ico('plus', 'ico')}<span>Create profile</span>`;
    createTile.addEventListener('click', () => openCreateProfileForm());
    grid.appendChild(createTile);
  }

  async function openCreateProfileForm(editingProfile = null) {
    if ($('profilesListSubView')) $('profilesListSubView').style.display = 'none';
    if ($('createProfileSubView')) $('createProfileSubView').style.display = 'flex';

    const vSelect = $('profileVersionSelect');
    if (!vSelect) return;
    vSelect.innerHTML = '';

    state.versions.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.type === 'snapshot' ? `${v.id} (Snapshot)` : v.type === 'old_beta' ? `${v.id} (Old Beta)` : v.type === 'old_alpha' ? `${v.id} (Old Alpha)` : v.id;
      vSelect.appendChild(opt);
    });

    fillJavaSelect($('profileJavaSelect'), 'Launcher default', editingProfile ? editingProfile.javaRuntime : 'auto');

    if (editingProfile) {
      $('profileModalTitle').textContent = `Edit ${editingProfile.name}`;
      $('formModeLabel').textContent = 'EDIT PROFILE';
      $('editingProfileIdInput').value = editingProfile.id;
      $('profileNameInput').value = editingProfile.name;
      vSelect.value = editingProfile.version;
      $('profileLoaderSelect').value = editingProfile.loader;
      if ($('profileHudEnabledInput')) $('profileHudEnabledInput').checked = editingProfile.hudEnabled !== false;
      $('profileRamSlider').value = editingProfile.ramMB;
      $('profileRamValueLabel').textContent = `${(editingProfile.ramMB / 1024).toFixed(1)} GB`;
      $('saveProfileSubmitBtn').textContent = `Save ${editingProfile.version} Profile`;
    } else {
      const firstRelease = state.versions.find(v => v.type === 'release') || state.versions[0];
      const defaultVer = firstRelease ? firstRelease.id : '1.21.4';
      $('profileModalTitle').textContent = 'Create Profile';
      $('formModeLabel').textContent = 'CREATE PROFILE';
      $('editingProfileIdInput').value = '';
      vSelect.value = defaultVer;
      $('profileLoaderSelect').value = 'fabric';
      if ($('profileHudEnabledInput')) $('profileHudEnabledInput').checked = true;
      if ($('profilePerfPackInput')) $('profilePerfPackInput').checked = true;
      $('profileNameInput').value = `${defaultVer}-Fabric`;
      const defRam = state.settings.defaultRamMB || 4096;
      $('profileRamSlider').value = defRam;
      $('profileRamValueLabel').textContent = `${(defRam / 1024).toFixed(1)} GB`;
      $('saveProfileSubmitBtn').textContent = `Create ${defaultVer} Profile`;
    }

    renderVersionPostersGrid(vSelect.value);
    await refreshSupportedLoadersForForm(vSelect.value);
    checkVanillaLoaderUi();
  }

  function checkVanillaLoaderUi() {
    const loader = $('profileLoaderSelect') ? $('profileLoaderSelect').value : 'fabric';
    const isVanilla = loader === 'vanilla';
    if ($('vanillaFormNoticePill')) $('vanillaFormNoticePill').style.display = isVanilla ? 'flex' : 'none';
    if ($('formBrowseModpacksBtn')) $('formBrowseModpacksBtn').style.display = isVanilla ? 'none' : 'inline-flex';
    if ($('profileHudField')) $('profileHudField').style.display = isVanilla ? 'none' : 'flex';
    // Performance Pack: only when CREATING a Fabric profile (no toggle on existing profiles).
    const creating = !($('editingProfileIdInput') && $('editingProfileIdInput').value);
    if ($('profilePerfField')) $('profilePerfField').style.display = (creating && loader === 'fabric') ? 'flex' : 'none';
  }

  function renderVersionPostersGrid(selectedVersion) {
    const grid = $('versionPostersGrid');
    if (!grid) return;
    grid.innerHTML = '';

    PRESET_VERSION_CARDS.forEach(card => {
      const div = document.createElement('div');
      div.className = 'engine-preset-card' + (card.id === selectedVersion ? ' selected' : '');
      div.innerHTML = `
        <div class="preset-icon-box">${ico(card.icon, 'ico')}</div>
        <div class="preset-info">
          <div class="preset-ver">${esc(card.title)}</div>
          <div class="preset-sub">${esc(card.subtitle)}</div>
        </div>
        <span class="preset-badge">${esc(card.badge)}</span>
      `;
      div.addEventListener('click', async () => {
        const vSelect = $('profileVersionSelect');
        if (!Array.from(vSelect.options).some(o => o.value === card.id)) {
          const opt = document.createElement('option');
          opt.value = card.id;
          opt.textContent = card.id;
          vSelect.appendChild(opt);
        }
        vSelect.value = card.id;
        renderVersionPostersGrid(card.id);
        await refreshSupportedLoadersForForm(card.id);
        updateAutoProfileName();
      });
      grid.appendChild(div);
    });
  }

  async function refreshSupportedLoadersForForm(mcVersion) {
    const loaderSelect = $('profileLoaderSelect');
    const loaderVerSelect = $('profileLoaderVersionSelect');
    if (!loaderSelect || !loaderVerSelect) return;

    try {
      const matrix = await api.getSupportedLoaders(mcVersion);
      Array.from(loaderSelect.options).forEach(opt => {
        const val = opt.value;
        const loaderInfo = matrix && matrix[val];
        const isSupported = Boolean(loaderInfo && loaderInfo.supported);
        opt.disabled = !isSupported;
        const baseName = val.charAt(0).toUpperCase() + val.slice(1);
        if (!isSupported) {
          opt.textContent = `${baseName} (not available for ${mcVersion})`;
        } else {
          opt.textContent = val === 'fabric' ? 'Fabric (Default & Recommended)' : val === 'vanilla' ? 'Vanilla (no mods)' : baseName;
        }
      });

      if (loaderSelect.selectedOptions[0] && loaderSelect.selectedOptions[0].disabled) {
        const prevLoader = loaderSelect.value;
        loaderSelect.value = (matrix && matrix.fabric && matrix.fabric.supported) ? 'fabric' : 'vanilla';
        checkVanillaLoaderUi();
        try { showToast(`${prevLoader} is not available for ${mcVersion}. Switched to ${loaderSelect.value}.`, 'warning'); } catch (_) {}
      }

      const activeLoader = loaderSelect.value;
      const activeLoaderInfo = (matrix && matrix[activeLoader]) || (matrix && matrix.vanilla) || { versions: [{ version: 'latest', label: 'latest' }] };
      loaderVerSelect.innerHTML = '';
      (activeLoaderInfo.versions || [{ version: 'latest', label: 'latest' }]).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.version;
        opt.textContent = v.label || v.version;
        loaderVerSelect.appendChild(opt);
      });
    } catch (_) {}

    const vObj = state.versions.find(v => v.id === mcVersion);
    const reqJava = vObj ? vObj.requiredJava : 21;
    if ($('javaRequirementHint')) {
      $('javaRequirementHint').textContent = `Minecraft ${mcVersion} uses Java ${reqJava}. CRYOX CLIENT detects or bundles Java ${reqJava} on launch.`;
    }
  }

  function updateAutoProfileName() {
    if ($('editingProfileIdInput') && $('editingProfileIdInput').value) return;
    const ver = $('profileVersionSelect').value;
    const loader = $('profileLoaderSelect').value;
    const lName = loader.charAt(0).toUpperCase() + loader.slice(1);
    $('profileNameInput').value = `${ver}-${lName}`;
    $('saveProfileSubmitBtn').textContent = `Create ${ver} Profile`;
  }

  // 3. CONTENT BROWSER
  async function refreshContentBrowser() {
    renderHeaderBar();
    const prof = getActiveProfile();
    if (!prof) {
      switchNavigation('profiles');
      return;
    }

    // native folder watcher for this profile (mods added/removed by hand show up without any polling)
    if (api.watchContent && state.watchedContentProfileId !== prof.id) {
      state.watchedContentProfileId = prof.id;
      api.watchContent(prof.id).catch(() => { state.watchedContentProfileId = null; });
    }

    const lName = prof.loader.charAt(0).toUpperCase() + prof.loader.slice(1);
    $('contentProfileBadgeIcon').textContent = versionBadge(prof);
    $('contentProfileBadgeName').textContent = prof.name;
    $('contentProfileBadgeMeta').textContent = `${prof.version} • ${lName}`;

    const targetSelect = $('contentTargetProfileSelect');
    targetSelect.innerHTML = '';
    state.profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.version})`;
      if (p.id === prof.id) opt.selected = true;
      targetSelect.appendChild(opt);
    });

    document.querySelectorAll('.type-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-content-type') === state.contentType);
    });

    const isVanilla = prof.loader === 'vanilla';
    if ($('targetVersionLockLabel')) $('targetVersionLockLabel').textContent = `${prof.version} (${lName})`;
    if ($('vanillaNoticeBanner')) {
      $('vanillaNoticeBanner').classList.toggle('visible', isVanilla && (state.contentType === 'mod' || state.contentType === 'modpack'));
    }
    if ($('modpackNoticeBanner')) {
      $('modpackNoticeBanner').classList.toggle('visible', !isVanilla && state.contentType === 'modpack');
    }

    state.installedItems = await api.listInstalledContent(prof.id, state.contentType);
    $('installedCountSpan').textContent = String(state.installedItems.length);

    $('modeBrowseBtn').className = 'btn btn-sm' + (state.contentMode === 'browse' ? ' btn-crimson' : ' glass-btn');
    $('modeInstalledBtn').className = 'btn btn-sm' + (state.contentMode === 'installed' ? ' btn-crimson' : ' glass-btn');

    if (state.contentMode === 'installed') {
      $('modrinthPaginationBar').style.display = 'none';
      renderInstalledContentList();
      checkInstalledUpdates();
    } else {
      $('modrinthPaginationBar').style.display = 'flex';
      await executeModrinthSearch();
    }
  }

  async function executeModrinthSearch() {
    const prof = getActiveProfile();
    if (!prof) return;
    const container = $('modrinthResultsContainer');
    container.innerHTML = `<div style="padding:32px; text-align:center; color:var(--text-secondary);">Searching content for Minecraft ${esc(prof.version)} (${esc(prof.loader)})...</div>`;

    try {
      const res = await api.searchModrinth({
        query: $('modrinthSearchInput').value,
        projectType: state.contentType,
        profileId: prof.id,
        offset: state.modrinthOffset,
        limit: state.modrinthLimit,
        sortIndex: $('modrinthSortSelect').value
      });
      state.modrinthHits = res.hits || [];
      state.modrinthTotal = res.totalHits || state.modrinthHits.length;
      renderModrinthHits();
    } catch (err) {
      container.innerHTML = `<div style="padding:32px; text-align:center; color:#f87171;">Could not load content: ${esc(err.message)}</div>`;
    }
  }

  function renderModrinthHits() {
    const prof = getActiveProfile();
    const isVanilla = prof && prof.loader === 'vanilla';
    const container = $('modrinthResultsContainer');
    container.innerHTML = '';

    if (!state.modrinthHits.length) {
      container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted);">No matching projects found.</div>`;
      $('modrinthPageSummary').textContent = '0 results';
      return;
    }

    const start = state.modrinthOffset + 1;
    const end = Math.min(state.modrinthOffset + state.modrinthHits.length, state.modrinthTotal);
    $('modrinthPageSummary').textContent = `Showing ${start} to ${end} of ${formatCompactNumber(state.modrinthTotal)} compatible projects`;

    state.modrinthHits.forEach(hit => {
      const card = document.createElement('div');
      card.className = 'modrinth-item-card';
      const iconHtml = hit.iconUrl
        ? `<img src="${esc(hit.iconUrl)}" alt="" class="mod-icon" />`
        : `<div class="mod-icon">${esc((hit.title || 'M').slice(0, 2).toUpperCase())}</div>`;
      const tagsHtml = (hit.categories || []).slice(0, 4).map(c => `<span class="mod-tag">${esc(c)}</span>`).join('');

      card.innerHTML = `
        <div class="modrinth-item-left">
          ${iconHtml}
          <div class="mod-details">
            <div class="mod-title-row">
              <span class="mod-title">${esc(hit.title)}</span>
              <span class="mod-author">by ${esc(hit.author)}</span>
              <span class="mod-tag" style="color:var(--crimson-400);">${formatCompactNumber(hit.downloads)} downloads</span>
            </div>
            <div class="mod-desc">${esc(hit.description)}</div>
            <div class="mod-tags">${tagsHtml}</div>
          </div>
        </div>
        <div class="modrinth-item-actions">
          <button type="button" class="btn btn-sm glass-btn" data-action="details">Details</button>
          ${isVanilla && (state.contentType === 'mod' || state.contentType === 'modpack')
            ? `<button type="button" class="btn btn-sm glass-btn" data-action="install" disabled>${ico('ban')}Vanilla locked</button>`
            : `<button type="button" class="btn btn-sm ${hit.installed ? 'glass-btn' : 'btn-crimson'}" data-action="install" ${hit.installed ? 'disabled' : ''}>
                ${hit.installed ? ico('check') + 'Installed' : ico('download') + 'Install'}
              </button>`
          }
        </div>
      `;

      card.querySelector('[data-action="details"]').addEventListener('click', async () => {
        state.selectedProjectForModal = hit;
        $('detailModalTitle').textContent = `${hit.title} by ${hit.author}`;
        $('detailModalBody').innerHTML = `<p style="margin-bottom:10px;">${esc(hit.description)}</p>`;
        $('detailModalInstallBtn').disabled = Boolean(hit.installed);
        $('detailModalInstallBtn').textContent = hit.installed ? 'Already installed' : `Install into ${getActiveProfile().name}`;
        $('projectDetailsModalBackdrop').classList.add('open');
      });

      card.querySelector('[data-action="install"]').addEventListener('click', async e => {
        await handleInstallModrinthHit(hit, e.currentTarget);
      });

      container.appendChild(card);
    });
  }

  // Re-reads what is installed (also files that were copied in by hand) and updates Browse + Installed without a new search.
  async function syncInstalledState() {
    const prof = getActiveProfile();
    if (!prof || !api.syncInstalledContent) return;
    const type = state.contentType;
    try {
      const res = await api.syncInstalledContent(prof.id, type);
      const cur = getActiveProfile();
      if (!res || !cur || cur.id !== prof.id || type !== state.contentType) return;
      state.installedItems = res.items || [];
      $('installedCountSpan').textContent = String(state.installedItems.length);

      const ids = new Set(res.projectIds || []);
      const localIds = new Set(res.localIds || []);
      let changed = false;
      (state.modrinthHits || []).forEach(hit => {
        const slug = String(hit.slug || '').toLowerCase().replace(/_/g, '-');
        const now = ids.has(hit.projectId) || (type === 'mod' && localIds.has(slug));
        if (Boolean(hit.installed) !== now) {
          hit.installed = now;
          changed = true;
        }
      });

      if (state.contentMode === 'installed') {
        renderInstalledContentList();
        checkInstalledUpdates();
      } else if (changed) {
        renderModrinthHits();
      }
    } catch (_) { /* offline / profile gone: the next change event tries again */ }
  }

  async function handleInstallModrinthHit(hit, btnElement) {
    const prof = getActiveProfile();
    if (!prof) return;
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = 'Installing...';
    }
    state.activityName = hit.title;
    progressShow(`Installing ${hit.title}`, 3);

    try {
      await api.installModrinthContent({
        profileId: prof.id,
        projectId: hit.projectId,
        projectType: state.contentType,
        title: hit.title,
        author: hit.author,
        iconUrl: hit.iconUrl
      });
      hit.installed = true;
      if (btnElement) {
        btnElement.className = 'btn btn-sm glass-btn';
        btnElement.innerHTML = ico('check') + 'Installed';
      }
      const refreshedProfiles = await api.listProfiles();
      state.profiles = refreshedProfiles.profiles;
      state.installedItems = await api.listInstalledContent(prof.id, state.contentType);
      $('installedCountSpan').textContent = String(state.installedItems.length);
      progressDone(`${hit.title} installed`);
      showToast(`${hit.title} installed`, 'success');
    } catch (err) {
      progressHide();
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerHTML = ico('download') + 'Install';
      }
      showToast(err.message, 'error');
    } finally {
      state.activityName = '';
    }
  }

  // ---- installed content: icons + "new version available" (Modrinth, matched by file hash) ----
  let installedUpdateMap = {};   // file name on disk -> { newVersionId, newVersionNumber, currentVersion, ... }
  let installedCheckSeq = 0;

  async function checkInstalledUpdates() {
    const prof = getActiveProfile();
    if (!prof) return;
    const type = state.contentType;
    const seq = ++installedCheckSeq;
    try {
      const res = await api.checkContentUpdates(prof.id, type);
      const now = getActiveProfile();
      if (seq !== installedCheckSeq || !now || now.id !== prof.id || state.contentType !== type) return;
      state.installedItems = res.items || state.installedItems;
      installedUpdateMap = {};
      (res.updates || []).forEach(u => { installedUpdateMap[u.fileName] = u; });
      if (state.contentMode === 'installed') renderInstalledContentList();
    } catch (_) {
      /* offline / Modrinth unreachable: the list simply stays as it is */
    }
  }

  async function applyInstalledUpdate(item, btn) {
    const prof = getActiveProfile();
    const upd = installedUpdateMap[item.fileName];
    if (!prof || !upd) return false;
    if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }
    try {
      const res = await api.updateInstalledContent({
        profileId: prof.id,
        projectType: state.contentType,
        fileName: item.fileName,
        versionId: upd.newVersionId
      });
      delete installedUpdateMap[item.fileName];
      state.installedItems = res.items || state.installedItems;
      return true;
    } catch (err) {
      showToast(`${item.title || item.fileName}: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
      return false;
    }
  }

  function renderInstalledContentList() {
    const container = $('modrinthResultsContainer');
    container.innerHTML = '';
    if (!state.installedItems.length) {
      container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted);">Nothing installed in this profile yet.</div>`;
      return;
    }
    const prof = getActiveProfile();

    const pendingCount = state.installedItems.filter(it => installedUpdateMap[it.fileName]).length;
    if (pendingCount) {
      const bar = document.createElement('div');
      bar.className = 'modrinth-item-card';
      bar.innerHTML = `
        <div class="modrinth-item-left"><div class="mod-details"><div class="mod-title-row">
          <span class="mod-title">${pendingCount} update${pendingCount === 1 ? '' : 's'} available</span>
        </div><div class="mod-desc">Newer releases for Minecraft ${esc(prof.version)} (${esc(prof.loader)}) were found on Modrinth.</div></div></div>
        <div class="modrinth-item-actions"><button type="button" class="btn btn-sm btn-crimson" data-action="update-all">Update all</button></div>`;
      bar.querySelector('[data-action="update-all"]').addEventListener('click', async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const todo = state.installedItems.filter(it => installedUpdateMap[it.fileName]);
        let done = 0;
        for (const it of todo) {
          btn.textContent = `Updating ${done + 1}/${todo.length}...`;
          if (await applyInstalledUpdate(it, null)) done++;
        }
        showToast(`${done} of ${todo.length} updated`, done === todo.length ? 'success' : 'info');
        renderInstalledContentList();
      });
      container.appendChild(bar);
    }

    state.installedItems.forEach(item => {
      const upd = installedUpdateMap[item.fileName];
      const card = document.createElement('div');
      card.className = 'modrinth-item-card';
      const initials = esc((item.title || 'M').slice(0, 2).toUpperCase());
      const iconHtml = item.iconUrl
        ? `<img src="${esc(item.iconUrl)}" alt="" class="mod-icon" onerror="this.outerHTML='<div class=&quot;mod-icon&quot;>${initials}</div>'" />`
        : `<div class="mod-icon">${initials}</div>`;
      const updHtml = upd
        ? ` <span class="mod-tag" style="color:var(--crimson-400);">Update: ${esc(upd.currentVersion || '')} &rarr; ${esc(upd.newVersionNumber || '')}</span>`
        : '';
      card.innerHTML = `
        <div class="modrinth-item-left">
          ${iconHtml}
          <div class="mod-details">
            <div class="mod-title-row">
              <span class="mod-title">${esc(item.title)}</span>
              <span class="mod-author">${esc(item.fileName)}</span>
            </div>
            <div class="mod-desc">${item.enabled ? 'Enabled' : 'Disabled'}${updHtml}</div>
          </div>
        </div>
        <div class="modrinth-item-actions">
          ${upd ? '<button type="button" class="btn btn-sm btn-crimson" data-action="update">Update</button>' : ''}
          <button type="button" class="btn btn-sm glass-btn" data-action="toggle">${item.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="remove">Remove</button>
        </div>
      `;
      const updBtn = card.querySelector('[data-action="update"]');
      if (updBtn) {
        updBtn.addEventListener('click', async () => {
          if (await applyInstalledUpdate(item, updBtn)) {
            showToast(`${item.title || item.fileName} updated`, 'success');
            renderInstalledContentList();
          }
        });
      }
      card.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
        try {
          const res = await api.toggleInstalledContent(prof.id, item.fileName, state.contentType);
          // a toggled file gets/loses ".disabled": keep its pending update under the new name
          if (upd) { delete installedUpdateMap[item.fileName]; }
          state.installedItems = res.items;
          renderInstalledContentList();
          checkInstalledUpdates();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      card.querySelector('[data-action="remove"]').addEventListener('click', async () => {
        try {
          const res = await api.removeInstalledContent(prof.id, item.fileName, state.contentType);
          delete installedUpdateMap[item.fileName];
          state.installedItems = res.items;
          $('installedCountSpan').textContent = String(state.installedItems.length);
          renderInstalledContentList();
          showToast('Removed');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      container.appendChild(card);
    });
  }

  // 4. IDENTITIES & HOLOGRAPHIC SKIN STUDIO
  function updateSkinSyncUI() {
    const syncOn = state.settings.enableSkinSync !== false;
    const toggle = $('skinSyncToggleInput');
    const pill = $('skinSyncPillBox');
    const text = $('skinSyncStateText');
    if (toggle) toggle.checked = syncOn;
    if (pill) pill.classList.toggle('sync-on', syncOn);
    if (text) text.innerHTML = syncOn ? 'ON &bull; LOCAL SKIN' : 'OFF &bull; DEFAULT SKINS';
  }

  function renderAccountsView() {
    renderHeaderBar();
    updateSkinSyncUI();

    const grid = $('accountsGridContainer');
    if (!grid) return;

    const q = String(($('accountSearchInput') && $('accountSearchInput').value) || '').toLowerCase().trim();
    grid.innerHTML = '';

    const filtered = state.accounts.filter(a => !q || a.username.toLowerCase().includes(q));
    if (!filtered.length) {
      grid.innerHTML = `<div style="padding:18px; text-align:center; color:var(--text-muted); font-size:12.5px;">No identities linked yet. Click "+ Link Account" above to add one.</div>`;
    } else {
      filtered.forEach(acc => {
        const isSelected = acc.id === state.activeAccountId;
        const card = document.createElement('div');
        card.className = 'identity-card' + (isSelected ? ' active' : '');

        card.innerHTML = `
          <div class="identity-avatar">${renderMiniFaceSvg(acc.username)}</div>
          <div class="identity-meta">
            <div class="identity-name">${esc(acc.username)}</div>
            <div class="identity-type">${acc.type === 'microsoft' ? 'MICROSOFT (ONLINE)' : 'LOCAL (OFFLINE)'}</div>
          </div>
          <button type="button" class="identity-remove-btn" data-action="remove" title="${acc.type === 'microsoft' ? 'Log out' : 'Remove identity'}">&times;</button>
        `;

        card.addEventListener('click', async e => {
          if (e.target.closest('[data-action="remove"]')) return;
          const updated = await api.setActiveAccount(acc.id);
          state.accounts = updated.accounts;
          state.activeAccountId = updated.activeAccountId;
          state.skinSlots = updated.skinSlots || [];
          renderAccountsView();
        });

        card.querySelector('[data-action="remove"]').addEventListener('click', async e => {
          e.stopPropagation();
          const doRemove = async deleteCloud => {
            try {
              const updated = await api.removeAccount(acc.id, deleteCloud);
              state.accounts = updated.accounts;
              state.activeAccountId = updated.activeAccountId;
              state.skinSlots = updated.skinSlots || [];
              renderAccountsView();
              showToast(deleteCloud ? 'Identity deleted forever' : (acc.type === 'microsoft' ? 'Logged out' : 'Identity removed')); // [ms-login-fix]
            } catch (err) {
              showToast(err.message, 'error');
            }
          };
          doRemove(false);
        });

        grid.appendChild(card);
      });
    }

    renderSkinSlots();
    drawMinecraftSkinPreview();
  }

  function renderSkinSlots() {
    const container = $('skinSlotsContainer');
    if (!container) return;
    container.innerHTML = '';

    const activeAcc = getActiveAccount();

    if (state.skinSlots && state.skinSlots.length) {
      state.skinSlots.forEach(s => {
        if (!s.customSkinDataUrl) {
          if (s.preset === 'crimson-phantom' || (s.name && s.name.includes('Crimson Phantom'))) {
            s.name = 'Slot 1 — Steve';
            s.model = 'classic';
            s.preset = 'steve';
          } else if (s.preset === 'obsidian-knight' || (s.name && s.name.includes('Obsidian Knight'))) {
            s.name = 'Slot 2 — Alex';
            s.model = 'slim';
            s.preset = 'alex';
          }
        }
      });
    }

    const slots = state.skinSlots && state.skinSlots.length ? state.skinSlots : [
      { id: 'slot-1', name: 'Slot 1 — Steve', model: 'classic', preset: 'steve', customSkinDataUrl: null, active: true },
      { id: 'slot-2', name: 'Slot 2 — Alex', model: 'slim', preset: 'alex', customSkinDataUrl: null, active: false }
    ];

    slots.forEach(slot => {
      const card = document.createElement('div');
      card.className = 'skin-slot-card' + (slot.active ? ' active' : '');
      const modelLabel = slot.model === 'slim' ? 'SLIM (ALEX)' : 'CLASSIC (STEVE)';
      const isOfficial = !slot.customSkinDataUrl && activeAcc && activeAcc.skinUrl;
      const sourceLabel = slot.customSkinDataUrl
        ? `<span style="color:#e8e8ee;">CUSTOM UPLOAD</span>`
        : isOfficial
        ? `<span style="color:#38bdf8;">OFFICIAL MINECRAFT SKIN</span>`
        : `DEFAULT: ${slot.model === 'slim' ? 'ALEX (SLIM)' : 'STEVE (CLASSIC)'}`;

      card.innerHTML = `
        <div class="skin-slot-head">
          <div class="skin-slot-who">
            <div class="avatar-head" style="width:36px; height:36px; border-radius:9px;">${renderMiniFaceSvg(slot.name)}</div>
            <div>
              <div class="slot-title">${esc(slot.name)}</div>
              <div class="slot-sub">${sourceLabel} &nbsp;|&nbsp; MODEL: ${slot.model === 'slim' ? 'SLIM' : 'CLASSIC'}</div>
            </div>
          </div>
          ${slot.active ? `<span class="equipped-pill">&#10003; EQUIPPED</span>` : ''}
        </div>
        <div class="skin-slot-actions">
          <button type="button" class="btn btn-sm glass-btn" data-action="upload">${ico('upload', 'ico-xs')} UPLOAD PNG</button>
          <button type="button" class="btn btn-sm glass-btn" data-action="model">${ico('layers', 'ico-xs')} ${modelLabel}</button>
          <button type="button" class="btn btn-sm ${slot.active ? 'btn-slot-active' : 'btn-crimson'}" data-action="apply">
            ${slot.active ? ico('shield', 'ico-xs') + ' ACTIVE' : ico('bolt', 'ico-xs') + ' APPLY'}
          </button>
          <button type="button" class="icon-btn danger" data-action="delete" title="Delete slot">${ico('trash', 'ico-xs')}</button>
        </div>
      `;

      card.querySelector('[data-action="upload"]').addEventListener('click', () => {
        if (!state.accounts.length) {
          showToast('Link an account first before uploading a skin.', 'warning');
          return;
        }
        state.pendingUploadSlotId = slot.id;
        if ($('skinFileUploadInput')) $('skinFileUploadInput').click();
      });

      card.querySelector('[data-action="model"]').addEventListener('click', async () => {
        try {
          const nextModel = slot.model === 'slim' ? 'classic' : 'slim';
          const updated = await api.updateSkinSlot(slot.id, { model: nextModel });
          state.skinSlots = updated.skinSlots;
          renderSkinSlots();
          drawMinecraftSkinPreview();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      card.querySelector('[data-action="apply"]').addEventListener('click', async () => {
        try {
          const updated = await api.updateSkinSlot(slot.id, { active: true });
          state.skinSlots = updated.skinSlots;
          renderSkinSlots();
          drawMinecraftSkinPreview();
          showToast(`Equipped "${slot.name}"`, 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        try {
          const updated = await api.deleteSkinSlot(slot.id);
          state.skinSlots = updated.skinSlots;
          renderSkinSlots();
          drawMinecraftSkinPreview();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      container.appendChild(card);
    });

    const addSlotBtn = $('addSkinSlotBtn');
    if (addSlotBtn) {
      const full = slots.length >= 5;
      addSlotBtn.disabled = full;
      addSlotBtn.style.opacity = full ? '0.45' : '';
      addSlotBtn.style.cursor = full ? 'not-allowed' : '';
      addSlotBtn.title = full ? 'Maximum 5 skin slots per account' : '';
    }
  }

  const skinImageCache = new Map();
  function getCachedImage(dataUrl) {
    if (!dataUrl) return null;
    if (skinImageCache.has(dataUrl)) return skinImageCache.get(dataUrl);
    const img = new Image();
    img.onload = () => drawMinecraftSkinPreview();
    img.src = dataUrl;
    skinImageCache.set(dataUrl, img);
    return img;
  }

  const STEVE_SKIN_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAdVBMVEUAAAAKvLwAzMwmGgokGAgrHg0zJBE/KhW3g2uzeV5SPYn///+qclmbY0mQWT8Af38AaGhVVVWUYD52SzOBUzmPXj5JJRBCHQp3QjVqQDA0JRIoKCg3Nzc/Pz9KSko6MYlBNZtGOqUDenoFiIgElZUApKQAr6/wvakZAAAAAXRSTlMAQObYZgAAAolJREFUeNrt1l1rHucZReFrj/whu5hSCCQtlOTE/f+/Jz4q9Cu0YIhLcFVpVg+FsOCVehi8jmZgWOzZz33DM4CXlum3gH95GgeAzQZVeL4gTm6Cbp4vqFkD8HwBazPY8wWbMq9utu3mNZ5fotVezbzOE3kBEFbaZuc8kb00NTMUbWJp678Xf2GV7RRtx1TDQQ6XBNvsmL2+2vHq1TftmMPIyAWujtN2cl274ua2jpVpZneXEjjo7XW1q53V9ds4ODO5xIuhvGHvfLI3aixauig415uuO2+vl9+cncfsFw25zL650fXn687jqnXuP68/X3+eV3zE7y6u9eB73MlfAcfbTf3yR8CfAX+if8S/H5/EAbAxj5LN48tULvEBOh8V1AageMTXe2YHAOwHbZxrzPkSR3+ffr8TR2JDzE/4Fj8CDgEwDsW+q+9GsR07hhg2CsALBgMo2v5wNxXnQXMeGQVW7gUAyKI2m6KDsJ8Au3++F5RZO+kKNQjQcLLWgjwUjBXLltFgWWMUUlviocBgNoxNGgMjSxiYAA7zgLFo2hgIENiDU8gQCzDOmViGFAsEuBcQSDCothhpJaDRA8E5fHqH2nTbYm5fHLo1V0u3B7DAuheoeScRYabjjjuzs17cHVaTrTXmK78m9swP34d9oK/dfeXSIH2PW/MXwPvxN/bJlxw8zlYAcEyeI6gNgA/O8P8neN8xe1IHP2gTzegjvhUDfuRygmwEs2GE4mkCDIAzm2R4yAuPsIdR9k8AvMc+3L9+2UEjo4WP0FpgP19O0MzCsqxIoMsdDBvYcQyGmO0ZJRoYCKjLJWY0BAhYwGUBCgkh8MRdOKt+ruqMwAB2OcEX94U1TPbYJP0PkyyAI1S6cSIAAAAASUVORK5CYII=';
  const ALEX_SKIN_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAZlBMVEUAAAD////v2r/r0LDvu7HfxKLUt4/zqFiUyJKMvorrmD+GuYTljT97snjegS5xq26UlmuAglpvb29lZWV8Vz51UDhYWFhyTjZPT09sRi5kQSwjYiQrVChcOyc/Pz82NjYYOBYoKCgm8xoJAAAAAXRSTlMAQObYZgAAAwZJREFUeNrtlu1W6jAQRWtjWiaZtCC9/YgC8v4vec9Mg6Uur6b8ve6S0Lo8O2NYmClusOMGF7Nr8HKu2IoDTYPk44K6lvBciePNAm7mlTGz3G2voAaYZg9vFzCCjtnZqoHjAYHDJjAM1tqqgmR7Bahf9tFaA6zND6JwXRpxxosZIkz4uQzOWFmTrJPOUgdjOP1hzu7flmNrJe4wtCBoMgR1LVE1mNIYNbAurpafN5N5Xto8vZbl65PhWg0aRiU/C2Rpa0x5w/LHnjQwZVTgGk755+eyNMbWXDeukQIwMjaRm6qyJjmMtTAi1ziHF0OQQwsul+u1SJBnZsTbRJEgIqzxD8H1erksAt80MLTtCawFpvpScDqtKzhUYpA8yKgAv7Wq4GCripmT4PsKPFGIQxdjbFsPCPiDsbY6tAvBU2K+KRZiCHHquimC0ylGCoH8vjSmVEG4xb0Mmb2MYmGYpgH5boBA7iAIPuxL5CUtT0Q72u0wy6SDioVOosh3k5ggQIZgQB4iDITlOqwoFiaJwzJAcMJARhOShUCX3AGjWMWYYqHv+zghHntwPPaoWQJh58mLRe5FUSpQ6BenWDgi1B81rCAki0oIgiDvQRRlMkh+JdDgi2b78zieEUKEWglRG4gQp+8EEupTeOz78f39/U32n1oKb3iAQ642CWQfPlWAUAr3MtoQ2jck4XmTe7wL7ykPrFkJRkm9HCUuopF8CN6TXsGTEAjvt2+7Gu4Fl/N5xN+PMs6XCwZJLv4BER480MzHFsyfwi9ZpDNSYH7IIKcDPKB4iHSwPk7tVo974ZDYZ1VQ/PKfg9Nsddg6ouWfyCMNh2OqzBbBCdxXUDMq2Cq4r6CmDRVEoRvm4z4Q8OwowdmCbgDThEq8Jwg8pb4gSzANU5cY4l1ngCtDMM0NR4yYwfS5LzgoewXPXwuQ1bZDsIJJ2OJHPvcL49wQJEyGQI+5pV/o9Sj8IKcCSd31C5sFEhrv+gVrzAbBul9QINiwB+t+QdHWLBmyPgXtF8CtX5CO4LsK/gL4WlU0/HKH/gAAAABJRU5ErkJggg==';

  const DEFAULT_SKIN_PALETTES = {
    'steve':           { hair: '#4a321d', skin: '#c68c59', eyes: '#2c358f', coat: '#00a29e', trim: '#00a29e', pants: '#2b307d', shoes: '#4e4e4e' },
    'alex':            { hair: '#cf6b32', skin: '#e0ab88', eyes: '#4b7b3b', coat: '#5f873e', trim: '#443122', pants: '#443122', shoes: '#302720' },
    'crimson-phantom': { hair: '#080808', skin: '#f3d8c7', eyes: '#e11d48', coat: '#111111', trim: '#e11d48', pants: '#0a0a0a', shoes: '#be123c' },
    'obsidian-knight': { hair: '#111111', skin: '#e5c1a7', eyes: '#38bdf8', coat: '#1e1b4b', trim: '#6366f1', pants: '#111111', shoes: '#312e81' },
    'ash-valkyrie':    { hair: '#f4f4f6', skin: '#f5d0c5', eyes: '#f43f5e', coat: '#191919', trim: '#fb7185', pants: '#101010', shoes: '#9f1239' },
    'blood-monarch':   { hair: '#450a0a', skin: '#ecc5b0', eyes: '#fbbf24', coat: '#7f1d1d', trim: '#f59e0b', pants: '#101010', shoes: '#450a0a' }
  };
  const defaultSkinCache = {};

  function getDefaultSkinCanvas(presetId) {
    const key = DEFAULT_SKIN_PALETTES[presetId] ? presetId : 'steve';
    if (defaultSkinCache[key]) return defaultSkinCache[key];
    const pal = DEFAULT_SKIN_PALETTES[key];
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const R = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

    // Head: front, top, bottom, sides, back
    R(pal.hair, 0, 0, 32, 16);
    R(pal.skin, 8, 8, 8, 8);
    R(pal.hair, 8, 8, 8, 2); R(pal.hair, 8, 10, 1, 2); R(pal.hair, 15, 10, 1, 2);
    R('#ffffff', 9, 12, 2, 1); R(pal.eyes, 10, 12, 1, 1);
    R('#ffffff', 13, 12, 2, 1); R(pal.eyes, 13, 12, 1, 1);
    // Torso: front, back, top, bottom, sides
    R(pal.coat, 16, 16, 24, 16);
    R(pal.trim, 23, 20, 2, 12);
    R(pal.trim, 35, 20, 2, 12);
    // Arms
    R(pal.coat, 40, 16, 16, 16);
    R(pal.skin, 40, 28, 16, 4);
    R(pal.coat, 32, 48, 16, 16);
    R(pal.skin, 32, 60, 16, 4);
    // Legs
    R(pal.pants, 0, 16, 16, 16);
    R(pal.shoes, 0, 28, 16, 4);
    R(pal.pants, 16, 48, 16, 16);
    R(pal.shoes, 16, 60, 16, 4);

    defaultSkinCache[key] = c;
    return c;
  }

  function drawMinecraftSkinPreview() {
    const canvas = $('skinCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;

    const activeSlot = state.skinSlots.find(s => s.active) || state.skinSlots[0] || { model: 'classic', preset: 'steve' };
    const activeAcc = getActiveAccount();
    let tex = null;
    if (activeSlot.customSkinDataUrl) {
      const img = getCachedImage(activeSlot.customSkinDataUrl);
      if (img && img.complete && img.naturalWidth >= 64) tex = img;
    } else if (activeAcc && activeAcc.skinUrl) {
      const img = getCachedImage(activeAcc.skinUrl);
      if (img && img.complete && img.naturalWidth >= 64) tex = img;
    }
    if (!tex) {
      const defUrl = activeSlot.model === 'slim' ? ALEX_SKIN_DATA_URL : STEVE_SKIN_DATA_URL;
      const img = getCachedImage(defUrl);
      if (img && img.complete && img.naturalWidth >= 64) tex = img;
    }
    if (!tex) tex = getDefaultSkinCanvas(activeSlot.model === 'slim' ? 'alex' : (activeSlot.preset || 'steve'));

    const isSlim = activeSlot.model === 'slim';
    const tw = tex.width || tex.naturalWidth;
    const th = tex.height || tex.naturalHeight;
    const k = tw / 64;
    const legacy = (th * 2 === tw);

    const S = 7;
    const armPx = isSlim ? 3 : 4;
    const cxFront = W * 0.34;
    const cxBack = W * 0.66;
    const topY = 26;

    const drawPart = (sx, sy, sw, sh, px, py, flip = false) => {
      ctx.save();
      if (flip) {
        ctx.translate(px + sw * S, py);
        ctx.scale(-1, 1);
        ctx.drawImage(tex, sx * k, sy * k, sw * k, sh * k, 0, 0, sw * S, sh * S);
      } else {
        ctx.drawImage(tex, sx * k, sy * k, sw * k, sh * k, px, py, sw * S, sh * S);
      }
      ctx.restore();
    };

    const hXF = cxFront - 4 * S;
    const bXF = cxFront - 4 * S, bYF = topY + 8 * S;
    const raXF = cxFront - 4 * S - armPx * S, raYF = topY + 8 * S;
    const laXF = cxFront + 4 * S, laYF = topY + 8 * S;
    const rlXF = cxFront - 4 * S, rlYF = topY + 20 * S;
    const llXF = cxFront, llYF = topY + 20 * S;

    drawPart(8, 8, 8, 8, hXF, topY, false);
    drawPart(20, 20, 8, 12, bXF, bYF, false);
    drawPart(44, 20, armPx, 12, raXF, raYF, false);
    if (legacy) {
      drawPart(44, 20, armPx, 12, laXF, laYF, true);
      drawPart(4, 20, 4, 12, llXF, llYF, true);
    } else {
      drawPart(36, 52, armPx, 12, laXF, laYF, false);
      drawPart(20, 52, 4, 12, llXF, llYF, false);
    }
    drawPart(4, 20, 4, 12, rlXF, rlYF, false);

    drawPart(40, 8, 8, 8, hXF, topY, false);
    if (!legacy) {
      drawPart(20, 36, 8, 12, bXF, bYF, false);
      drawPart(44, 36, armPx, 12, raXF, raYF, false);
      drawPart(52, 52, armPx, 12, laXF, laYF, false);
      drawPart(4, 36, 4, 12, rlXF, rlYF, false);
      drawPart(4, 52, 4, 12, llXF, llYF, false);
    }

    const hXB = cxBack - 4 * S;
    const bXB = cxBack - 4 * S, bYB = topY + 8 * S;
    const laXB = cxBack - 4 * S - armPx * S, laYB = topY + 8 * S;
    const raXB = cxBack + 4 * S, raYB = topY + 8 * S;
    const llXB = cxBack - 4 * S, llYB = topY + 20 * S;
    const rlXB = cxBack, rlYB = topY + 20 * S;

    drawPart(24, 8, 8, 8, hXB, topY, false);
    drawPart(32, 20, 8, 12, bXB, bYB, false);
    if (legacy) {
      drawPart(52, 20, armPx, 12, laXB, laYB, true);
      drawPart(12, 20, 4, 12, llXB, llYB, true);
    } else {
      drawPart(isSlim ? 43 : 44, 52, armPx, 12, laXB, laYB, false);
      drawPart(28, 52, 4, 12, llXB, llYB, false);
    }
    drawPart(isSlim ? 51 : 52, 20, armPx, 12, raXB, raYB, false);
    drawPart(12, 20, 4, 12, rlXB, rlYB, false);

    drawPart(56, 8, 8, 8, hXB, topY, false);
    if (!legacy) {
      drawPart(32, 36, 8, 12, bXB, bYB, false);
      drawPart(isSlim ? 59 : 60, 52, armPx, 12, laXB, laYB, false);
      drawPart(isSlim ? 51 : 52, 36, armPx, 12, raXB, raYB, false);
      drawPart(12, 52, 4, 12, llXB, llYB, false);
      drawPart(12, 36, 4, 12, rlXB, rlYB, false);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '700 11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FRONT VIEW', cxFront, H - 14);
    ctx.fillText('BACK VIEW', cxBack, H - 14);
  }

  async function renderHudModList() {
    const el = $('hudModListText');
    const sel = $('hudJarSelect');
    if (el) el.textContent = '';
    try {
      const prof = getActiveProfile();
      const res = api.listHudMods ? await api.listHudMods(prof ? prof.id : null) : { jars: [] };
      const jars = (res && res.jars) || [];
      const saved = (state.settings && state.settings.activeHudJar) || '';

      if (sel) {
        sel.innerHTML = '';
        const add = (value, label) => {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = label;
          sel.appendChild(o);
        };
        add('', 'Auto (all supported HUD jars)');
        add('__none__', 'None (HUD off)');
        jars.forEach(j => add(j.fileName, `${j.fileName}${j.supported ? '' : '  (not supported by active profile)'}`));
        if (saved && saved !== '__none__' && !jars.some(j => j.fileName === saved)) add(saved, `${saved}  (file missing)`);
        sel.value = saved;
      }

      if (el) {
        if (!jars.length) {
          el.textContent = 'No HUD jar found yet. Drop your .jar into the HUD Mods folder or upload it.';
        } else {
          jars.forEach(j => {
            const row = document.createElement('div');
            row.textContent = `${j.supported ? '\u2713' : '\u2717'} ${j.fileName} \u2014 ` +
              (j.supported ? 'works with the active profile' : (j.reason || 'not supported by the active profile'));
            el.appendChild(row);
          });
        }
      }
    } catch (_) {}
  }

  function uniqueJavaRuntimes() {
    const seen = new Map();
    (state.javaRuntimes || []).forEach(rt => {
      const key = `${rt.major}:${rt.version}`;
      if (!seen.has(key)) seen.set(key, rt);
    });
    return Array.from(seen.values()).sort((a, b) => b.major - a.major || String(b.version).localeCompare(String(a.version)));
  }

  function javaLabel(rt) {
    const src = rt.source === 'bundled' ? '  \u00b7  bundled' : rt.source === 'system' ? '  \u00b7  system' : '';
    return `Java ${rt.major}  \u00b7  ${rt.version}${src}`;
  }

  // Shows which Java the ACTIVE profile will really launch with (and where it comes from), so a manual download is never a guess.
  async function refreshJavaStatus() {
    const badge = $('javaStatusBadge');
    const text = $('javaStatusText');
    const pathEl = $('javaStatusPath');
    if (!badge || !text || !api.getJavaStatus) return;
    const prof = getActiveProfile();
    if (!prof) {
      badge.textContent = '-';
      text.textContent = 'No profile selected.';
      if (pathEl) pathEl.textContent = '';
      return;
    }
    const vObj = (state.versions || []).find(v => v.id === prof.version);
    const req = vObj && vObj.requiredJava ? vObj.requiredJava : 21;
    try {
      const st = await api.getJavaStatus(req, prof.javaRuntime || 'auto');
      // the runtime list now knows which Java is bundled / system
      if (st && Array.isArray(st.runtimes) && st.runtimes.length) {
        state.javaRuntimes = st.runtimes;
        fillJavaSelect($('settingDefaultJavaSelect'), 'Auto (recommended)', (state.settings && state.settings.defaultJavaRuntime) || 'auto');
      }
      const rt = st && st.runtime;
      const who = `${prof.name} (Minecraft ${prof.version} needs Java ${st.requiredMajor})`;
      const why = st.reason === 'profile' ? 'chosen in this profile'
        : st.reason === 'settings' ? 'chosen as Default Java in Settings' : 'picked automatically';
      if (rt && st.compatible) {
        const srcName = st.source === 'bundled' ? 'bundled by CRYOX CLIENT' : 'installed on this PC';
        badge.textContent = `Java ${rt.major}`;
        badge.style.color = 'var(--success)';
        text.textContent = `${who} will launch with Java ${rt.major} (${rt.version}), ${srcName}, ${why}.`;
        if (pathEl) pathEl.textContent = rt.path || '';
      } else {
        badge.textContent = 'Missing';
        badge.style.color = 'var(--crimson-400)';
        text.textContent = st.autoProvision
          ? `${who}: no matching Java yet. It will be downloaded automatically the first time you press Play (or download Java ${st.requiredMajor} below now).`
          : `${who}: no matching Java and auto-download is off. Download Java ${st.requiredMajor} below.`;
        if (pathEl) pathEl.textContent = rt ? `Selected Java ${rt.major} is too old: ${rt.path || ''}` : '';
      }
    } catch (err) {
      badge.textContent = '?';
      text.textContent = `Could not check Java: ${err.message}`;
    }
  }

  function fillJavaSelect(select, autoLabel, current) {
    if (!select) return;
    const list = uniqueJavaRuntimes();
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = autoLabel;
    select.appendChild(auto);
    list.forEach(rt => {
      const opt = document.createElement('option');
      opt.value = rt.path;
      opt.textContent = javaLabel(rt);
      select.appendChild(opt);
    });
    let wanted = current && current !== 'auto' ? current : 'auto';
    if (wanted !== 'auto' && !list.some(rt => rt.path === wanted)) {
      const twin = (state.javaRuntimes || []).find(rt => rt.path === wanted);
      const match = twin && list.find(rt => rt.major === twin.major && rt.version === twin.version);
      wanted = match ? match.path : 'auto';
    }
    select.value = wanted;
  }

  // 5. SETTINGS VIEW
  async function renderSettingsView() {
    const s = state.settings;
    if (!s) return;

    if ($('settingDiscordToggle'))$('settingDiscordToggle').checked = s.discordRpcEnabled !== false;
    if ($('settingGlassSlider'))$('settingGlassSlider').value = s.glassIntensity || 24;
    if ($('settingGlassValueLabel'))$('settingGlassValueLabel').textContent = `${s.glassIntensity || 24}px`;
    if ($('settingThemeSelect')) $('settingThemeSelect').value = s.uiTheme === 'nothing' ? 'nothing' : 'default';
    if ($('matrixOptions')) $('matrixOptions').style.display = 'none';
    if ($('settingMatrixShape')) $('settingMatrixShape').value = s.matrixShape === 'default' ? 'default' : 'round';
    if ($('settingMatrixHlStyle')) $('settingMatrixHlStyle').value = s.matrixHlStyle === 'glass' ? 'glass' : 'solid';
    if ($('settingMatrixHlColor')) $('settingMatrixHlColor').value = s.matrixHlColor || '#ffffff';
    document.querySelectorAll('.mx-swatch').forEach(b => b.classList.toggle('active', b.dataset.color === (s.matrixHlColor || '#ffffff')));

    if ($('settingFullscreenToggle'))$('settingFullscreenToggle').checked = Boolean(s.fullscreen);
    if ($('settingWindowWidthInput'))$('settingWindowWidthInput').value = s.windowWidth || 1280;
    if ($('settingWindowHeightInput'))$('settingWindowHeightInput').value = s.windowHeight || 720;
    if ($('settingGameDataDirText'))$('settingGameDataDirText').textContent = s.gameDataDir || '';
    if ($('settingInstallDirText'))$('settingInstallDirText').textContent = s.installDir || '';
    if ($('settingConfigDirText'))$('settingConfigDirText').textContent = s.configDir || '';
    if ($('settingJavaDirText'))$('settingJavaDirText').textContent = s.javaDir || '';
    if ($('settingDefaultRamSlider'))$('settingDefaultRamSlider').value = s.defaultRamMB || 4096;
    if ($('settingDefaultRamLabel'))$('settingDefaultRamLabel').textContent = `${((s.defaultRamMB || 4096) / 1024).toFixed(1)} GB`;
    if ($('settingConcurrentInput'))$('settingConcurrentInput').value = s.concurrentDownloads || 8;
    if ($('settingCloseBehaviorSelect'))$('settingCloseBehaviorSelect').value = s.closeBehavior || 'keep-open';
    if ($('settingSnapshotsToggle'))$('settingSnapshotsToggle').checked = Boolean(s.showSnapshots);

    fillJavaSelect($('settingDefaultJavaSelect'), 'Auto (recommended)', s.defaultJavaRuntime || 'auto');
    const n = uniqueJavaRuntimes().length;
    if ($('detectedJavaSummaryText')) {$('detectedJavaSummaryText').textContent = n
        ? `${n} Java version${n === 1 ? '' : 's'} found on this PC. Auto picks the right one for each Minecraft version.`
        : 'No Java found yet. Download one below, or just launch a game and CRYOX CLIENT will get it for you.';
    }
    refreshJavaStatus();

    try {
      const dStatus = await api.getDiscordStatus();
      if (dStatus && $('discordStatusBadge')) {$('discordStatusBadge').textContent = dStatus.statusText || (dStatus.enabled ? 'Active' : 'Disabled');
      }
    } catch (_) {}

    renderHudModList();
  }

  async function triggerPlayOrStop() {
    const acc = getActiveAccount();
    if (!acc) {
      showToast('Add an account in the Accounts tab before launching.', 'error');
      switchNavigation('accounts');
      return;
    }

    const prof = getActiveProfile();
    if (!prof) {
      switchNavigation('profiles');
      openCreateProfileForm();
      return;
    }

    if (state.runningProfileIds.has(prof.id)) {
      await api.stopProfile(prof.id);
      state.runningProfileIds.delete(prof.id);
      syncGameRunningMode();
      renderHomeView();
      showToast('Game stopped');
      return;
    }

    try {
      state.activityName = prof.name;
      progressShow(`Preparing ${prof.name}`, 4, 'Checking game files…');

      const res = await api.launchProfile(prof.id);
      if (res && res.launched) {
        state.runningProfileIds.add(prof.id);
        syncGameRunningMode();
        const refreshed = await api.listProfiles();
        state.profiles = refreshed.profiles;
        renderHomeView();
        renderRustHome();
        renderRustProfilesPage();
        progressDone('Game launched');
        showToast('Game launched', 'success');
        if (state.settings && state.settings.closeBehavior === 'minimize') {
          try { api.minimizeWindow(); } catch (_) {}
        }
      } else {
        progressHide();
      }
    } catch (err) {
      progressHide();
      appendConsoleLog(`[LAUNCH ERROR] ${cleanErrorMessage(err.message)}`, 'error');
      showToast(err.message, 'error');
    } finally {
      state.activityName = '';
    }
  }

  function bindEvents() {
    on('winMinBtn', 'click', () => api.minimizeWindow());
    on('winMaxBtn', 'click', () => api.maximizeWindow());
    on('winCloseBtn', 'click', () => api.closeWindow());

    on('openLogsBtn', 'click', () => $('logsModalBackdrop').classList.add('open'));
    on('closeLogsModalBtn', 'click', () => $('logsModalBackdrop').classList.remove('open'));
    on('clearLogsBtn', 'click', () => { $('logConsoleOutput').innerHTML = ''; });
    on('copyLogsBtn', 'click', async () => {
      const output = $('logConsoleOutput');
      const logs = output ? Array.from(output.children, line => line.textContent).join('\n') : '';
      if (!logs) {
        showToast('There are no logs to copy.', 'info');
        return;
      }
      try {
        await api.writeClipboardText(logs);
        showToast('Console logs copied.', 'success');
      } catch (err) {
        showToast(`Could not copy console logs: ${err.message}`, 'error');
      }
    });

    document.querySelectorAll('.nav-btn[data-nav]').forEach(btn => {
      on(btn, 'click', () => switchNavigation(btn.getAttribute('data-nav')));
    });

    // theme switch + Rust UI wiring
    applyCryoxTheme(getCryoxTheme());
    document.querySelectorAll('.theme-seg-btn').forEach(b => on(b, 'click', () => setCryoxTheme(b.dataset.themeChoice)));
    on('rustGoToProfilesBtn', 'click', () => {
      switchNavigation('rust');
      showRustSub('profiles');
    });
    on('rustBackBtn', 'click', () => showRustSub('home'));
    on('rustCreateProfileBtn', 'click', () => openRustCreateForm());
    on('closeRustCreateProfileBtn', 'click', () => showRustSub('profiles'));
    on('rustProfileSearchInput', 'input', () => renderRustProfilesPage());
    on('rustMainPlayBtn', 'click', () => playRustActive());
    on('rustLaunchDropdownBtn', 'click', e => { e.stopPropagation(); $('rustProfileDropdown').classList.toggle('open'); });
    document.addEventListener('click', () => { if ($('rustProfileDropdown')) $('rustProfileDropdown').classList.remove('open'); });
    on('rustProfileSaveBtn', 'click', () => saveRustProfileFromForm());
    on('rustProfileCancelBtn', 'click', () => showRustSub('profiles'));
    on('rustFullRefreshBtn', 'click', async () => { await renderRustView(); populateRustCreateForm(); });
    on('rustProfileBuildSelect', 'change', e => { renderRustPresets(e.target.value); });
    on('rustRefreshBtn', 'click', () => renderRustView());
    on('rustGraphicsBackend', 'change', e => { saveRustSettings({ backend: e.target.value }); renderRustHome(); });
    on('rustGameDirInput', 'change', e => saveRustSettings({ gameDir: e.target.value.trim() }));
    on('rustSyncPacksToggle', 'change', e => saveRustSettings({ syncPacks: e.target.checked }));

    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      on(btn, 'click', () => {
        const target = btn.getAttribute('data-settings-tab');
        document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.settings-tab-pane').forEach(p => {
          p.classList.toggle('active', p.getAttribute('data-settings-pane') === target);
        });
      });
    });

    // About & Update system
    on('openGithubProfileBtn', 'click', () => {
      api.openExternal('https://github.com/inrwxyz');
    });
    on('openGithubRepoBtn', 'click', () => {
      api.openExternal('https://github.com/inrwxyz/inrwxyz-cryox-client');
    });

    const autoUpToggle = $('autoUpdateToggleInput');
    if (autoUpToggle) {
      autoUpToggle.checked = localStorage.getItem('cryox_auto_update') !== 'false';
      on(autoUpToggle, 'change', e => {
        localStorage.setItem('cryox_auto_update', e.target.checked);
      });
    }

    let latestReleaseUrl = null;
    function compareSemVer(a, b) {
      const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
      }
      return 0;
    }

    async function checkForLauncherUpdates(manual = false) {
      const statusBox = $('updateStatusBox');
      const statusMsg = $('updateStatusMsg');
      const actionArea = $('updateActionArea');
      const subtitle = $('updateStatusSubtitle');
      const checkBtn = $('checkUpdatesBtn');

      if (checkBtn) {
        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking...';
      }
      if (statusBox) {
        statusBox.style.display = 'block';
        if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--text-secondary);">Checking GitHub for new releases…</span>';
        if (actionArea) actionArea.style.display = 'none';
      }

      try {
        const resp = await fetch('https://api.github.com/repos/inrwxyz/inrwxyz-cryox-client/releases/latest', {
          headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!resp.ok) {
          if (resp.status === 404) {
            if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--success); font-weight:800;">✓ CRYOX CLIENT is up to date (v1.0.1)</span>';
            if (subtitle) subtitle.textContent = 'CRYOX CLIENT v1.0.1 is the latest release';
            if (manual) showToast('CRYOX CLIENT is up to date!', 'success');
            return;
          }
          throw new Error('HTTP ' + resp.status);
        }
        const data = await resp.json();
        const remoteTag = (data.tag_name || '').replace(/^v/, '').trim();
        const currentVer = '1.0.1';

        const isNewer = compareSemVer(remoteTag, currentVer) > 0;
        if (isNewer) {
          latestReleaseUrl = data.html_url || 'https://github.com/inrwxyz/inrwxyz-cryox-client/releases';
          const exeAsset = (data.assets || []).find(a => a.name && a.name.endsWith('.exe'));
          if (exeAsset && exeAsset.browser_download_url) {
            latestReleaseUrl = exeAsset.browser_download_url;
          }

          if (statusMsg) {
            statusMsg.innerHTML = `<span style="color:#f43f5e; font-weight:800;">⚡ New Update Available: v${esc(remoteTag)}</span><br/><span style="color:var(--text-secondary); font-size:11.5px; margin-top:4px; display:inline-block;">${esc(data.name || 'CRYOX CLIENT update')}</span>`;
          }
          if (actionArea) actionArea.style.display = 'block';
          if (subtitle) subtitle.textContent = `Update available: v${remoteTag}`;
          showToast(`CRYOX CLIENT v${remoteTag} is available!`, 'info');
        } else {
          if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--success); font-weight:800;">✓ CRYOX CLIENT is up to date (v1.0.1)</span>';
          if (subtitle) subtitle.textContent = 'CRYOX CLIENT v1.0.1 is the latest release';
          if (manual) showToast('CRYOX CLIENT is up to date!', 'success');
        }
      } catch (err) {
        if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--success); font-weight:800;">✓ CRYOX CLIENT is up to date (v1.0.1)</span>';
        if (manual) showToast('CRYOX CLIENT is up to date!', 'info');
      } finally {
        if (checkBtn) {
          checkBtn.disabled = false;
          checkBtn.innerHTML = ico('refresh', 'ico-xs') + ' Check for Updates';
        }
      }
    }

    on('checkUpdatesBtn', 'click', () => checkForLauncherUpdates(true));
    on('downloadUpdateBtn', 'click', () => {
      if (latestReleaseUrl) api.openExternal(latestReleaseUrl);
    });

    if (localStorage.getItem('cryox_auto_update') !== 'false') {
      setTimeout(() => checkForLauncherUpdates(false), 4000);
    }

    on('mainPlayBtn', 'click', () => triggerPlayOrStop());
    on('launchDropdownBtn', 'click', e => {
      e.stopPropagation();
      $('homeProfileDropdown').classList.toggle('open');
    });
    document.addEventListener('click', () => {
      if ($('homeProfileDropdown'))$('homeProfileDropdown').classList.remove('open');
    });

    on('cancelInstallBtn', 'click', async () => {
      const prof = getActiveProfile();
      if (prof) {
        await api.cancelInstallation(prof.id);
        progressHide();
        showToast('Cancelled');
      }
    });

    on('profileSearchInput', 'input', () => renderProfilesView());
    on('profileSortSelect', 'change', () => renderProfilesView());
    on('openCreateProfileBtn', 'click', () => openCreateProfileForm());
    on('closeCreateProfileBtn', 'click', () => {
      $('createProfileSubView').style.display = 'none';$('profilesListSubView').style.display = 'block';
    });
    on('cancelProfileFormBtn', 'click', () => {
      $('createProfileSubView').style.display = 'none';$('profilesListSubView').style.display = 'block';
    });

    on('formBrowseModpacksBtn', 'click', () => openProfileContentBrowser('modpack'));
    on('toggleAdvancedSetupBtn', 'click', () => {
      state.advancedSetupOpen = !state.advancedSetupOpen;
      if ($('advancedProfileFields')) {$('advancedProfileFields').style.display = state.advancedSetupOpen ? 'flex' : 'none';
      }
    });

    on('profileVersionSelect', 'change', async e => {
      const ver = e.target.value;
      renderVersionPostersGrid(ver);
      await refreshSupportedLoadersForForm(ver);
      updateAutoProfileName();
    });

    on('profileLoaderSelect', 'change', async () => {
      await refreshSupportedLoadersForForm($('profileVersionSelect').value);
      checkVanillaLoaderUi();
      updateAutoProfileName();
    });

    on('profileRamSlider', 'input', e => {
      $('profileRamValueLabel').textContent = `${(Number(e.target.value) / 1024).toFixed(1)} GB`;
    });

    on('refreshManifestBtn', 'click', async () => {
      const data = await api.listVersions({ forceRefresh: true, includeSnapshots: state.settings.showSnapshots });
      state.versions = data.versions || [];
      showToast('Version list refreshed', 'success');
      openCreateProfileForm();
    });

    on('saveProfileSubmitBtn', 'click', async () => {
      const editId = $('editingProfileIdInput').value;
      const payload = {
        name: $('profileNameInput').value,
        version: $('profileVersionSelect').value,
        loader: $('profileLoaderSelect').value,
        loaderVersion: ($('profileLoaderVersionSelect') &&$('profileLoaderVersionSelect').value) || 'latest',
        javaRuntime: ($('profileJavaSelect') &&$('profileJavaSelect').value) || 'auto',
        ramMB: Number($('profileRamSlider').value),
        hudEnabled: $('profileHudEnabledInput') ?$('profileHudEnabledInput').checked : true,
        perfPack: $('profilePerfPackInput') ? $('profilePerfPackInput').checked : false
      };

      const loaderOpt = $('profileLoaderSelect').selectedOptions[0];
      if (loaderOpt && loaderOpt.disabled) {
        showToast(`${payload.loader.toUpperCase()} is not available for Minecraft ${payload.version}.`, 'error');
        return;
      }

      try {
        if (editId) {
          const res = await api.updateProfile(editId, payload);
          state.profiles = res.state.profiles;
          state.activeProfileId = res.state.activeProfileId;
          showToast('Profile saved', 'success');
        } else {
          const res = await api.createProfile(payload);
          state.profiles = res.state.profiles;
          state.activeProfileId = res.state.activeProfileId;
          showToast('Profile created', 'success');
        }
        $('createProfileSubView').style.display = 'none';$('profilesListSubView').style.display = 'block';
        renderProfilesView();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('cancelDeleteProfileBtn', 'click', () => $('deleteConfirmModalBackdrop').classList.remove('open'));
    on('confirmDeleteProfileBtn', 'click', async () => {
      if (!state.pendingDeleteProfileId) return;
      try {
        const updated = await api.deleteProfile(state.pendingDeleteProfileId);
        state.profiles = updated.profiles;
        state.activeProfileId = updated.activeProfileId;
        $('deleteConfirmModalBackdrop').classList.remove('open');
        renderProfilesView();
        showToast('Profile deleted.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('contentTargetProfileSelect', 'change', async e => {
      const updated = await api.setActiveProfile(e.target.value);
      state.profiles = updated.profiles;
      state.activeProfileId = updated.activeProfileId;
      state.modrinthOffset = 0;
      refreshContentBrowser();
    });
    document.querySelectorAll('.type-pill-btn').forEach(btn => {
      on(btn, 'click', () => {
        state.contentType = btn.getAttribute('data-content-type');
        state.modrinthOffset = 0;
        refreshContentBrowser();
      });
    });
    on('backToProfilesFromContentBtn', 'click', () => switchNavigation('profiles'));
    on('modeBrowseBtn', 'click', () => { state.contentMode = 'browse'; refreshContentBrowser(); });
    on('modeInstalledBtn', 'click', () => { state.contentMode = 'installed'; refreshContentBrowser(); });

    let searchDebounce = null;
    on('modrinthSearchInput', 'input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.modrinthOffset = 0;
        if (state.contentMode === 'browse') executeModrinthSearch();
      }, 280);
    });
    on('modrinthSortSelect', 'change', () => { state.modrinthOffset = 0; executeModrinthSearch(); });
    on('modrinthRefreshBtn', 'click', () => executeModrinthSearch());
    on('modrinthPrevPageBtn', 'click', () => {
      if (state.modrinthOffset >= state.modrinthLimit) { state.modrinthOffset -= state.modrinthLimit; executeModrinthSearch(); }
    });
    on('modrinthNextPageBtn', 'click', () => {
      if (state.modrinthOffset + state.modrinthLimit < state.modrinthTotal) { state.modrinthOffset += state.modrinthLimit; executeModrinthSearch(); }
    });
    on('closeProjectDetailsBtn', 'click', () => $('projectDetailsModalBackdrop').classList.remove('open'));
    on('detailModalInstallBtn', 'click', async () => {
      if (!state.selectedProjectForModal) return;
      await handleInstallModrinthHit(state.selectedProjectForModal, $('detailModalInstallBtn'));$('projectDetailsModalBackdrop').classList.remove('open');
      renderModrinthHits();
    });

    // Accounts & Holographic Skin Studio
    on('accountSearchInput', 'input', () => renderAccountsView());
    on('openAddAccountBtn', 'click', () => {
      $('accountsListSubView').style.display = 'none';$('addAccountSubView').style.display = 'flex';
    });
    on('closeAddAccountBtn', 'click', () => {
      $('addAccountSubView').style.display = 'none';$('accountsListSubView').style.display = 'grid';
    });

    on('selectMsAccountTile', 'click', () => {
      $('selectMsAccountTile').classList.add('selected');$('selectLocalAccountTile').classList.remove('selected');
      $('msAccountFormPanel').style.display = 'flex';$('localAccountFormPanel').style.display = 'none';
    });
    on('selectLocalAccountTile', 'click', () => {
      $('selectLocalAccountTile').classList.add('selected');$('selectMsAccountTile').classList.remove('selected');
      $('localAccountFormPanel').style.display = 'flex';$('msAccountFormPanel').style.display = 'none';
    });

    on('signInMicrosoftBtn', 'click', async () => {
      try {
        const updated = await api.loginMicrosoftAccount();
        state.accounts = updated.accounts;
        state.activeAccountId = updated.activeAccountId;
        state.skinSlots = updated.skinSlots || [];
        $('addAccountSubView').style.display = 'none';$('accountsListSubView').style.display = 'grid';
        renderAccountsView();
        showToast('Signed in with Microsoft.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('createLocalAccountBtn', 'click', async () => {
      try {
        const updated = await api.addLocalAccount($('localUsernameInput').value);
        state.accounts = updated.accounts;
        state.activeAccountId = updated.activeAccountId;
        state.skinSlots = updated.skinSlots || [];
        $('localUsernameInput').value = '';
        $('addAccountSubView').style.display = 'none';$('accountsListSubView').style.display = 'grid';
        renderAccountsView();
        showToast('Local account added.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('skinSyncToggleInput', 'change', async e => {
      const enabled = e.target.checked;
      try {
        state.settings = await api.updateSettings({ enableSkinSync: enabled });
        updateSkinSyncUI();
        showToast(
          enabled
            ? 'Skin Sync ON: your skin is shown in your own game (local only, nobody else sees it).'
            : 'Skin Sync OFF: default skins everywhere.',
          enabled ? 'success' : 'info'
        );
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('addSkinSlotBtn', 'click', async () => {
      try {
        const updated = await api.addSkinSlot();
        state.skinSlots = updated.skinSlots;
        renderSkinSlots();
        showToast('Added new skin slot.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    on('skinFileUploadInput', 'change', e => {
      const file = e.target.files && e.target.files[0];
      if (!file || !state.pendingUploadSlotId) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const updated = await api.updateSkinSlot(state.pendingUploadSlotId, {
            customSkinDataUrl: String(reader.result),
            active: true
          });
          state.skinSlots = updated.skinSlots;
          renderSkinSlots();
          drawMinecraftSkinPreview();
          showToast('Skin uploaded', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
      reader.readAsDataURL(file);
    });

    // Settings Events
    const saveSettingsField = async partial => {
      try {
        state.settings = await api.updateSettings(partial);
        applyAppearanceSettings();
        renderSettingsView();
        showToast('Settings saved.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    on('settingDiscordToggle', 'change', e => saveSettingsField({ discordRpcEnabled: e.target.checked }));
    on('settingGlassSlider', 'input', e => {
      const px = Number(e.target.value);
      $('settingGlassValueLabel').textContent = `${px}px`;
      document.documentElement.style.setProperty('--glass-blur', `${px}px`);
    });
    on('settingGlassSlider', 'change', e => saveSettingsField({ glassIntensity: Number(e.target.value) }));
    on('settingThemeSelect', 'change', e => saveSettingsField({ uiTheme: e.target.value }));
    on('settingMatrixShape', 'change', e => saveSettingsField({ matrixShape: e.target.value }));
    on('settingMatrixHlStyle', 'change', e => saveSettingsField({ matrixHlStyle: e.target.value }));
    on('settingMatrixHlColor', 'change', e => saveSettingsField({ matrixHlColor: e.target.value }));
    document.querySelectorAll('.mx-swatch').forEach(b => b.addEventListener('click', () => saveSettingsField({ matrixHlColor: b.dataset.color })));
    on('wpPick', 'click', () => $('wpFile').click());
    on('wpClear', 'click', () => saveSettingsField({ wallpaper: '' }));
    on('wpFile', 'change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * sc);
          c.height = Math.round(img.height * sc);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          saveSettingsField({ wallpaper: c.toDataURL('image/jpeg', 0.82) });
        };
        img.onerror = () => showToast('Image load hoynai', 'error');
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });

    on('settingDefaultJavaSelect', 'change', e => saveSettingsField({ defaultJavaRuntime: e.target.value || 'auto' }));

    const handleBundleJavaClick = async major => {
      const btn = $('bundleJavaBtn');
      if (btn) btn.disabled = true;
      state.activityName = `Java ${major}`;
      progressShow(`Downloading Java ${major}`, 3);
      try {
        const res = await api.bundlePortableJava(major);
        if (res && res.runtimes) state.javaRuntimes = res.runtimes;
        renderSettingsView();
        progressDone(`Java ${major} ready`);
        showToast(`Java ${major} downloaded and ready. Auto uses it for every Minecraft version that needs Java ${major}.`, 'success');
      } catch (err) {
        progressHide();
        showToast(err.message, 'error');
      } finally {
        state.activityName = '';
        if (btn) btn.disabled = false;
      }
    };

    on('bundleJavaBtn', 'click', () => handleBundleJavaClick(Number($('bundleJavaMajorSelect').value) || 21));

    on('settingFullscreenToggle', 'change', e => saveSettingsField({ fullscreen: e.target.checked }));
    on('settingWindowWidthInput', 'change', e => saveSettingsField({ windowWidth: Number(e.target.value) }));
    on('settingWindowHeightInput', 'change', e => saveSettingsField({ windowHeight: Number(e.target.value) }));
    on('settingDefaultRamSlider', 'input', e => {
      $('settingDefaultRamLabel').textContent = `${(Number(e.target.value) / 1024).toFixed(1)} GB`;
    });
    on('settingDefaultRamSlider', 'change', e => saveSettingsField({ defaultRamMB: Number(e.target.value) }));
    on('settingConcurrentInput', 'change', e => saveSettingsField({ concurrentDownloads: Number(e.target.value) }));
    on('settingCloseBehaviorSelect', 'change', e => saveSettingsField({ closeBehavior: e.target.value }));
    on('settingSnapshotsToggle', 'change', async e => {
      await saveSettingsField({ showSnapshots: e.target.checked });
      const vData = await api.listVersions({ includeSnapshots: e.target.checked });
      state.versions = vData.versions || [];
    });

    on('changeGameDataDirBtn', 'click', async () => {
      const res = await api.selectDirectoryDialog(state.settings.gameDataDir);
      if (!res.canceled && res.path) await saveSettingsField({ gameDataDir: res.path });
    });

    document.querySelectorAll('[data-open-dir]').forEach(btn => {
      on(btn, 'click', async () => {
        await api.openDirectoryInExplorer(btn.getAttribute('data-open-dir'));
        showToast('Folder opened');
      });
    });

    on('resetSettingsBtn', 'click', async () => {
      state.settings = await api.resetSettings();
      applyAppearanceSettings();
      renderSettingsView();
      updateSkinSyncUI();
      showToast('Settings restored to defaults.');
    });

    on('hudJarSelect', 'change', async e => {
      await saveSettingsField({ activeHudJar: e.target.value });
      showToast(e.target.value === '__none__' ? 'HUD turned off' : e.target.value ? 'HUD mod selected' : 'HUD: automatic');
    });

    on('uploadHudJarBtn', 'click', async () => {
      try {
        const res = await api.uploadHudMod();
        if (res && res.rejected) {
          showToast('That file is not a valid mod', 'error');
        } else if (res && !res.canceled && res.fileName) {
          if (res.compatible === false) {
            showToast('HUD mod added, but this profile can\'t use it', 'warning');
          } else {
            showToast('HUD mod added', 'success');
          }
          renderHudModList();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    if (api.onContentChanged) {
      let contentChangeTimer = null;
      api.onContentChanged(data => {
        const prof = getActiveProfile();
        if (!prof || (data && data.profileId && data.profileId !== prof.id)) return;
        clearTimeout(contentChangeTimer);
        contentChangeTimer = setTimeout(syncInstalledState, 150);
      });
    }

    if (api.onInstallProgress) {
      api.onInstallProgress(data => {
        const pct = Number(data.percent) || 0;
        const stage = String(data.stage || '').toLowerCase();
        const finished = pct >= 100 || stage === 'installed' || stage.includes('installation complete');
        if (finished) {
          const label = data.projectId && state.activityName
            ? `${state.activityName} installed`
            : stage.includes('installation complete') ? 'Ready to play' : 'Done';
          progressDone(label);
          return;
        }
        const { title, sub } = describeProgress(data);
        progressShow(title, pct, sub);
      });
    }

    if (api.onGameLog) api.onGameLog(entry => appendConsoleLog(entry.line, entry.level));
    if (api.onGameExit) {
      api.onGameExit(info => {
        state.runningProfileIds.delete(info.profileId);
        syncGameRunningMode();
        if (state.runningProfileIds.size === 0) {
          const consoleOutput = $('logConsoleOutput');
          if (consoleOutput) consoleOutput.replaceChildren();
        }
        renderHomeView();
        renderRustHome();
        renderRustProfilesPage();
        showToast(info && info.code && info.code !== 0 ? 'Game closed unexpectedly. Open Logs for details.' : 'Game closed', info && info.code && info.code !== 0 ? 'warning' : 'info');
      });
    }
  }

  async function initApp() {
    bindEvents();
    try {
      const boot = await api.getBootstrapState();
      state.settings = boot.settings || {};
      state.profiles = (boot.profilesState && boot.profilesState.profiles) || [];
      state.activeProfileId = (boot.profilesState && boot.profilesState.activeProfileId) || (state.profiles[0] && state.profiles[0].id) || null;
      state.accounts = (boot.accountsState && boot.accountsState.accounts) || [];
      state.activeAccountId = (boot.accountsState && boot.accountsState.activeAccountId) || (state.accounts[0] && state.accounts[0].id) || null;

      const initialActiveAcc = state.accounts.find(a => a.id === state.activeAccountId) || state.accounts[0];
      state.skinSlots = (boot.accountsState && boot.accountsState.skinSlots) || (initialActiveAcc && initialActiveAcc.skinSlots) || [];

      state.javaRuntimes = boot.javaRuntimes || [];
      state.versions = (boot.versionsData && boot.versionsData.versions) || [];
      state.runningProfileIds = new Set(boot.runningProfileIds || []);
      state.discordStatus = boot.discordStatus || null;

      patchIconStrokes();
      applyAppearanceSettings();
      updateSkinSyncUI();
      appendConsoleLog('[X] Launcher initialized. Auto-Java Bundler, Default HUD Hook & Discord Rich Presence ready.');
      renderHomeView();
    } catch (err) {
      appendConsoleLog(`[BOOT ERROR] ${err.message}`, 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();