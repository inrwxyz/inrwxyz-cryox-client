const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { createStoredZipBuffer } = require('./zipUtils');

const MS_CLIENT_ID = '00000000402b5328';
const MS_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';

const { spawnSync } = require('child_process');

// [ms-login-fix] ---- Microsoft sign-in settings (everything client-specific lives here) ----
// To use your own Azure app later, change MS_CLIENT_ID above. Mojang must approve that app,
// otherwise login_with_xbox answers HTTP 403 (invalid app registration).
const MS_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const MS_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MS_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
// login.live.com tokens go to Xbox Live as they are. A v2.0 token (login.microsoftonline.com/consumers) needs 'd=' here.
const MS_RPS_PREFIX = '';
const MS_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh when 5 minutes or less are left
const MS_HTTP_TIMEOUT_MS = 20000;
const MS_RELOGIN_MESSAGE = 'Your Microsoft sign-in has expired. Log out of this account and log in with Microsoft again.';

class MsAuthError extends Error {
  constructor(message, { transient = false, needsRelogin = false, code = 'MS_AUTH' } = {}) {
    super(message);
    this.name = 'MsAuthError';
    this.transient = transient;
    this.needsRelogin = needsRelogin;
    this.code = code;
  }
}

async function msHttp(label, url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MS_HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (_) {
    throw new MsAuthError(`Could not reach ${label}. Check your internet connection and try again.`, { transient: true, code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }
}

async function msReadJson(res) {
  try { return await res.json(); } catch (_) { return null; }
}

function xstsErrorMessage(xerr, status) {
  switch (Number(xerr)) {
    case 2148916227: return 'This Xbox account is banned from Xbox services, so it cannot be used to sign in.';
    case 2148916233: return 'This Microsoft account has no Xbox profile yet. Sign in once at minecraft.net (or xbox.com) to create it, then try again.';
    case 2148916235: return 'Xbox Live is not available in the country or region of this Microsoft account.';
    case 2148916236:
    case 2148916237: return 'This Microsoft account needs adult verification on the Xbox website before it can sign in.';
    case 2148916238: return 'This is a child account. An adult must add it to a Microsoft Family before it can sign in.';
    default: return xerr ? `Xbox sign-in failed (XSTS error ${Number(xerr)}).` : `Xbox sign-in failed (HTTP ${status}).`;
  }
}

// Windows DPAPI through PowerShell. The script travels as -EncodedCommand; the data (never a token on the command line) goes through stdin.
function dpapiScript(method) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Security',
    '$inB64 = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($inB64)',
    `$out = [System.Security.Cryptography.ProtectedData]::${method}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))'
  ].join('\n');
}

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return 'powershell.exe';
}

function runPowerShell(script, stdinText) {
  const r = spawnSync(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: stdinText, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }
  );
  if (r.error || r.status !== 0) throw new Error('Windows data protection (DPAPI) is not available.');
  return String(r.stdout || '').trim();
}

function createPurePng(width, height, getPixel) {
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const [r, g, b, a] = getPixel(x, y);
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a !== undefined ? a : 255;
    }
  }
  const idatData = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const crcTable = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1));
  }
  function makeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'binary');
    const crcVal = crc32(Buffer.concat([t, data]));
    const c = Buffer.alloc(4); c.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, t, data, c]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', idatData), makeChunk('IEND', Buffer.alloc(0))]);
}

class AccountManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    const configDir = this.settingsManager.getSettings().configDir;
    this.accountsFile = path.join(configDir, 'accounts.json');
    this.tokensFile = path.join(configDir, 'auth_tokens.json');
    this.skinsDir = path.join(configDir, 'skins');
    try { fs.mkdirSync(this.skinsDir, { recursive: true }); } catch (_) {}

    this.state = this._load();
    this.tokens = this._loadTokens();
  }

  generateOfflineUuid(username) {
    const md5Bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
    md5Bytes[6] = (md5Bytes[6] & 0x0f) | 0x30;
    md5Bytes[8] = (md5Bytes[8] & 0x3f) | 0x80;
    const hex = md5Bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  _defaultSkinSlots() {
    return [
      { id: 'slot-1', name: 'Slot 1 — Crimson Phantom', model: 'slim', preset: 'crimson-phantom', capePreset: 'inex-crest', customSkinDataUrl: null, active: true },
      { id: 'slot-2', name: 'Slot 2 — Obsidian Knight', model: 'slim', preset: 'obsidian-knight', capePreset: 'inex-crest', customSkinDataUrl: null, active: false }
    ];
  }

  _load() {
    try {
      if (fs.existsSync(this.accountsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8'));
        if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          const globalSlots = parsed.skinSlots || this._defaultSkinSlots();
          parsed.accounts.forEach(acc => {
            if (!acc.skinSlots || !Array.isArray(acc.skinSlots) || acc.skinSlots.length === 0) {
              acc.skinSlots = JSON.parse(JSON.stringify(globalSlots));
            }
            if (!acc.activeSkinSlot) {
              acc.activeSkinSlot = acc.skinSlots[0].id;
            }
          });
          return {
            activeAccountId: parsed.activeAccountId || parsed.accounts[0].id,
            accounts: parsed.accounts
          };
        }
      }
    } catch (_) {}

    const initial = { activeAccountId: null, accounts: [] };
    this._save(initial);
    return initial;
  }

  // [ms-login-fix] Tokens are stored encrypted with Windows DPAPI (CurrentUser): { "v": 2, "dpapi": "<base64>" }
  _dpapiAvailable() {
    return process.platform === 'win32';
  }

  _dpapiProtect(plainText) {
    return runPowerShell(dpapiScript('Protect'), Buffer.from(String(plainText), 'utf8').toString('base64'));
  }

  _dpapiUnprotect(b64) {
    return Buffer.from(runPowerShell(dpapiScript('Unprotect'), String(b64)), 'base64').toString('utf8');
  }

  // Quick check that DPAPI encrypts and decrypts correctly on this PC (no real tokens involved).
  static dpapiSelfTest() {
    const am = Object.create(AccountManager.prototype);
    if (!am._dpapiAvailable()) return { ok: false, reason: 'Not Windows: DPAPI is only available on Windows.' };
    const sample = `inex-selftest-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const enc = am._dpapiProtect(sample);
      const dec = am._dpapiUnprotect(enc);
      const opaque = !Buffer.from(enc, 'base64').toString('latin1').includes(sample);
      return { ok: dec === sample && opaque, roundTrip: dec === sample, encryptedIsOpaque: opaque };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  _loadTokens() {
    let parsed;
    try {
      if (!fs.existsSync(this.tokensFile)) return {};
      parsed = JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'));
    } catch (_) {
      return {}; // unreadable or damaged file: treat as logged out
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    if (parsed.v !== undefined) {
      if (parsed.v !== 2 || typeof parsed.dpapi !== 'string' || !this._dpapiAvailable()) return {};
      try {
        const obj = JSON.parse(this._dpapiUnprotect(parsed.dpapi));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        this._lastPersistedTokens = JSON.stringify(obj);
        return obj;
      } catch (_) {
        // other PC / other Windows user / damaged file: cannot be opened here, so the account is logged out
        console.error('[auth] Saved Microsoft tokens could not be decrypted on this PC/user; please log in again.');
        return {};
      }
    }

    // old plain-text format (no "v"): encrypt it now, or drop the plain file when encryption is impossible
    const legacy = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) legacy[id] = entry;
    }
    let saved = false;
    try { saved = this._persistTokens(legacy); } catch (_) {}
    if (!saved) {
      try { fs.unlinkSync(this.tokensFile); } catch (_) {}
      console.error('[auth] Old plain-text token file could not be encrypted; it was removed.');
    }
    return legacy;
  }

  _persistTokens(tokens) {
    const obj = tokens && typeof tokens === 'object' ? tokens : {};
    if (Object.keys(obj).length === 0) {
      try { if (fs.existsSync(this.tokensFile)) fs.unlinkSync(this.tokensFile); } catch (_) {}
      this._lastPersistedTokens = '{}';
      return true;
    }
    const plain = JSON.stringify(obj);
    if (plain === this._lastPersistedTokens && fs.existsSync(this.tokensFile)) return true; // nothing changed
    if (!this._dpapiAvailable()) {
      if (!this._warnedNoDpapi) {
        this._warnedNoDpapi = true;
        console.error('[auth] Windows DPAPI is not available here: Microsoft tokens are kept in memory only and are NOT saved to disk.');
      }
      return false;
    }
    const encrypted = this._dpapiProtect(plain);
    fs.mkdirSync(path.dirname(this.tokensFile), { recursive: true });
    const tmp = `${this.tokensFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, dpapi: encrypted }), { mode: 0o600 });
    fs.renameSync(tmp, this.tokensFile);
    this._lastPersistedTokens = plain;
    return true;
  }

  _saveTokens() {
    try {
      return this._persistTokens(this.tokens);
    } catch (_) {
      console.error('[auth] Could not save the encrypted Microsoft tokens; they stay in memory for this session.');
      return false;
    }
  }

  _save(state = this.state) {
    try {
      fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
      const tmp = `${this.accountsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.accountsFile);
    } catch (_) {}
  }

  listAccounts() {
    const activeAcc = this.state.accounts.find(a => a.id === this.state.activeAccountId) || this.state.accounts[0];
    const activeSkinSlots = activeAcc && activeAcc.skinSlots ? activeAcc.skinSlots.map(s => ({ ...s })) : [];

    return {
      activeAccountId: this.state.activeAccountId,
      accounts: this.state.accounts.map(acc => ({
        id: acc.id,
        username: acc.username,
        uuid: acc.uuid,
        type: acc.type,
        authenticatedOnline: Boolean(acc.authenticatedOnline),
        addedAt: acc.addedAt,
        activeSkinSlot: acc.activeSkinSlot || (acc.skinSlots && acc.skinSlots.length ? acc.skinSlots[0].id : 'slot-1'),
        hasCustomSkin: Boolean(acc.skinSlots && acc.skinSlots.some(s => s && s.customSkinDataUrl))
      })),
      skinSlots: activeSkinSlots
    };
  }

  getActiveAccount() {
    const acc = this.state.accounts.find(a => a.id === this.state.activeAccountId) || this.state.accounts[0] || null;
    if (!acc) return null;
    const tokenEntry = this.tokens[acc.id] || {};
    return {
      ...acc,
      accessToken: acc.type === 'microsoft' && tokenEntry.mcAccessToken ? tokenEntry.mcAccessToken : '0'
    };
  }

  setActiveAccount(accountId) {
    const found = this.state.accounts.find(a => a.id === accountId);
    if (!found) throw new Error(`Account not found: ${accountId}`);
    this.state.activeAccountId = found.id;
    this._save();
    return this.listAccounts();
  }

  addLocalAccount(username) {
    const clean = String(username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(clean)) {
      throw new Error('Minecraft usernames must be 3–16 characters and contain only letters, numbers, or underscores.');
    }

    const existing = this.state.accounts.find(a => a.username.toLowerCase() === clean.toLowerCase() && a.type === 'local');
    if (existing) {
      this.state.activeAccountId = existing.id;
      this._save();
      return this.listAccounts();
    }

    const newAcc = {
      id: `local-${clean.toLowerCase()}-${crypto.randomBytes(2).toString('hex')}`,
      username: clean,
      uuid: this.generateOfflineUuid(clean),
      type: 'local',
      authenticatedOnline: false,
      addedAt: new Date().toISOString(),
      activeSkinSlot: 'slot-1',
      skinSlots: this._defaultSkinSlots()
    };

    this.state.accounts.unshift(newAcc);
    this.state.activeAccountId = newAcc.id;
    this._save();
    return this.listAccounts();
  }

  // Skins are local-only now (no cloud). Kept as thin wrappers so existing callers keep working.
  async addLocalAccountRestoring(username) {
    return this.addLocalAccount(username);
  }

  async deleteAccountForever(accountId) {
    return this.removeAccount(accountId);
  }

  removeAccount(accountId) {
    const idx = this.state.accounts.findIndex(a => a.id === accountId);
    if (idx === -1) throw new Error('Account not found.');
    const removed = this.state.accounts.splice(idx, 1)[0];
    delete this.tokens[removed.id];
    this._saveTokens();

    if (this.state.activeAccountId === removed.id) {
      this.state.activeAccountId = this.state.accounts.length > 0 ? this.state.accounts[0].id : null;
    }
    this._save();
    return this.listAccounts();
  }

  // [ms-login-fix] Microsoft sign-in: authorization code (from the small login window) -> Xbox -> XSTS -> Minecraft
  getMicrosoftRedirectUri() {
    return MS_REDIRECT_URI;
  }

  getMicrosoftLoginUrl() {
    const state = crypto.randomBytes(16).toString('hex');
    this._msOAuthStates = [...(this._msOAuthStates || []), state].slice(-5);
    const params = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      response_type: 'code',
      redirect_uri: MS_REDIRECT_URI,
      scope: MS_SCOPE,
      prompt: 'select_account',
      state
    });
    return `${MS_AUTHORIZE_URL}?${params.toString()}`;
  }

  async completeMicrosoftOAuthRedirect(redirectUrl) {
    let u;
    try { u = new URL(String(redirectUrl)); } catch (_) {
      throw new MsAuthError('Microsoft sign-in returned an unexpected address.');
    }
    const err = u.searchParams.get('error');
    if (err) {
      if (err === 'access_denied') throw new MsAuthError('Microsoft login cancelled.', { code: 'CANCELLED' });
      throw new MsAuthError(`Microsoft sign-in failed (${String(err).replace(/[^\w.-]/g, '').slice(0, 60)}).`);
    }
    const code = u.searchParams.get('code');
    if (!code) throw new MsAuthError('Microsoft sign-in did not return an authorization code.');
    const st = u.searchParams.get('state');
    if (st && !(this._msOAuthStates || []).includes(st)) {
      throw new MsAuthError('The Microsoft sign-in response did not match this request. Please try again.');
    }
    return this.completeMicrosoftOAuthCode(code);
  }

  async _msTokenRequest(params, isRefresh = false) {
    const res = await msHttp('Microsoft sign-in', MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: MS_CLIENT_ID, ...params })
    });
    const data = await msReadJson(res);
    if (!res.ok) {
      if (isRefresh && (res.status === 400 || res.status === 401)) {
        throw new MsAuthError(MS_RELOGIN_MESSAGE, { needsRelogin: true, code: 'RELOGIN' });
      }
      throw new MsAuthError(
        isRefresh ? `Microsoft is temporarily unavailable (HTTP ${res.status}).` : `Microsoft sign-in failed (HTTP ${res.status}).`,
        { transient: isRefresh && (res.status >= 500 || res.status === 429) }
      );
    }
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
      throw new MsAuthError('Microsoft returned an unexpected response.');
    }
    return data;
  }

  async _authenticateMinecraft(msAccessToken) {
    const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

    const xblRes = await msHttp('Xbox Live', 'https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `${MS_RPS_PREFIX}${msAccessToken}` },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
      })
    });
    if (!xblRes.ok) {
      throw new MsAuthError(`Xbox Live authentication failed (HTTP ${xblRes.status}).`, { transient: xblRes.status >= 500 || xblRes.status === 429 });
    }
    const xblData = await msReadJson(xblRes);
    const xblToken = xblData && xblData.Token;
    const userHash = xblData && xblData.DisplayClaims && xblData.DisplayClaims.xui && xblData.DisplayClaims.xui[0] && xblData.DisplayClaims.xui[0].uhs;
    if (!xblToken || !userHash) throw new MsAuthError('Xbox Live returned an unexpected response.');

    const xstsRes = await msHttp('Xbox Live', 'https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
      })
    });
    if (!xstsRes.ok) {
      const body = await msReadJson(xstsRes);
      const xerr = body && body.XErr;
      throw new MsAuthError(xstsErrorMessage(xerr, xstsRes.status), {
        code: 'XSTS',
        transient: !xerr && (xstsRes.status >= 500 || xstsRes.status === 429)
      });
    }
    const xstsData = await msReadJson(xstsRes);
    const xstsToken = xstsData && xstsData.Token;
    if (!xstsToken) throw new MsAuthError('Xbox Live returned an unexpected response.');

    const mcRes = await msHttp('Minecraft Services', 'https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` })
    });
    if (!mcRes.ok) {
      if (mcRes.status === 403) {
        throw new MsAuthError(
          'Minecraft rejected this launcher (HTTP 403, invalid app registration). The Microsoft app ID used by CRYOX CLIENT is not approved by Mojang.',
          { code: 'APP_REGISTRATION' }
        );
      }
      throw new MsAuthError(`Minecraft Services authentication failed (HTTP ${mcRes.status}).`, { transient: mcRes.status >= 500 || mcRes.status === 429 });
    }
    const mcData = await msReadJson(mcRes);
    if (!mcData || typeof mcData.access_token !== 'string' || !mcData.access_token) {
      throw new MsAuthError('Minecraft Services returned an unexpected response.');
    }
    const expiresIn = Number(mcData.expires_in) > 0 ? Number(mcData.expires_in) : 86400;
    return { mcAccessToken: mcData.access_token, mcExpiresAt: Date.now() + expiresIn * 1000 };
  }

  async completeMicrosoftOAuthCode(authCode) {
    if (!authCode) throw new MsAuthError('Microsoft authorization code was not provided.');

    const msTokenData = await this._msTokenRequest({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: MS_REDIRECT_URI,
      scope: MS_SCOPE
    });
    const mc = await this._authenticateMinecraft(msTokenData.access_token);

    const profileRes = await msHttp('Minecraft Services', 'https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mc.mcAccessToken}` }
    });
    if (profileRes.status === 404) {
      throw new MsAuthError(
        'This Microsoft account does not own Minecraft: Java Edition. (Xbox Game Pass players must sign in once with the official Minecraft Launcher first.)',
        { code: 'NO_JAVA' }
      );
    }
    if (!profileRes.ok) {
      throw new MsAuthError(`Could not load the Minecraft profile (HTTP ${profileRes.status}).`, { transient: profileRes.status >= 500 || profileRes.status === 429 });
    }
    const mcProfile = await msReadJson(profileRes);
    if (!mcProfile || typeof mcProfile.id !== 'string' || !mcProfile.name) {
      throw new MsAuthError('Minecraft Services returned an unexpected profile.');
    }
    const formattedUuid = mcProfile.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

    const accId = `msa-${mcProfile.id}`;
    const existingIdx = this.state.accounts.findIndex(a => a.id === accId);
    const prev = existingIdx >= 0 ? this.state.accounts[existingIdx] : null;
    // logging in again with the same account keeps its skin slots
    const newAcc = {
      ...(prev || {}),
      id: accId,
      username: mcProfile.name,
      uuid: formattedUuid,
      type: 'microsoft',
      authenticatedOnline: true,
      addedAt: prev && prev.addedAt ? prev.addedAt : new Date().toISOString(),
      activeSkinSlot: prev && prev.activeSkinSlot ? prev.activeSkinSlot : 'slot-1',
      skinSlots: prev && Array.isArray(prev.skinSlots) && prev.skinSlots.length ? prev.skinSlots : this._defaultSkinSlots()
    };

    this.tokens[accId] = {
      mcAccessToken: mc.mcAccessToken,
      mcExpiresAt: mc.mcExpiresAt,
      refreshToken: msTokenData.refresh_token || null,
      updatedAt: new Date().toISOString()
    };
    this._saveTokens();

    if (existingIdx >= 0) this.state.accounts[existingIdx] = newAcc;
    else this.state.accounts.unshift(newAcc);

    this.state.activeAccountId = accId;
    this._save();
    return this.listAccounts();
  }

  // Called right before the game starts: renews the Minecraft token when it is (almost) expired.
  async ensureFreshActiveToken() {
    const acc = this.state.accounts.find(a => a.id === this.state.activeAccountId) || this.state.accounts[0] || null;
    if (!acc || acc.type !== 'microsoft') return;
    if (!this._msRefreshing) this._msRefreshing = new Map();
    let p = this._msRefreshing.get(acc.id);
    if (!p) {
      p = this._ensureFreshToken(acc).finally(() => this._msRefreshing.delete(acc.id));
      this._msRefreshing.set(acc.id, p);
    }
    return p;
  }

  async _ensureFreshToken(acc) {
    const entry = this.tokens[acc.id];
    if (!entry || (!entry.mcAccessToken && !entry.refreshToken)) {
      throw new MsAuthError(MS_RELOGIN_MESSAGE, { needsRelogin: true, code: 'NO_SESSION' });
    }
    const now = Date.now();
    const exp = Number(entry.mcExpiresAt) || 0;
    if (entry.mcAccessToken && exp - now > MS_REFRESH_MARGIN_MS) return;
    if (!entry.refreshToken) throw new MsAuthError(MS_RELOGIN_MESSAGE, { needsRelogin: true, code: 'NO_REFRESH' });

    try {
      const msTokenData = await this._msTokenRequest({
        grant_type: 'refresh_token',
        refresh_token: entry.refreshToken,
        redirect_uri: MS_REDIRECT_URI,
        scope: MS_SCOPE
      }, true);
      // Microsoft hands out a new refresh token every time: keep it right away, before the Xbox steps
      if (msTokenData.refresh_token) {
        this.tokens[acc.id] = { ...entry, refreshToken: msTokenData.refresh_token };
        this._saveTokens();
      }
      const mc = await this._authenticateMinecraft(msTokenData.access_token);
      this.tokens[acc.id] = {
        ...this.tokens[acc.id],
        mcAccessToken: mc.mcAccessToken,
        mcExpiresAt: mc.mcExpiresAt,
        updatedAt: new Date().toISOString()
      };
      this._saveTokens();
    } catch (err) {
      // short network/server problem while the old token still works: just launch with it
      if (err && err.transient && entry.mcAccessToken && exp - now > 0) return;
      if (err instanceof MsAuthError) throw err;
      throw new MsAuthError('Could not renew the Microsoft sign-in. Please try again.', { transient: true });
    }
  }

  addSkinSlot(name) {
    const activeAcc = this.state.accounts.find(a => a.id === this.state.activeAccountId);
    if (!activeAcc) throw new Error('No active account found.');

    if (activeAcc.skinSlots.length >= 5) throw new Error('Maximum 5 skin slots per account.');
    const slotNum = activeAcc.skinSlots.length + 1;
    const presets = ['crimson-phantom', 'obsidian-knight', 'ash-valkyrie', 'blood-monarch'];
    const newSlot = {
      id: `slot-${Date.now()}`,
      name: String(name || `Slot ${slotNum}`).trim(),
      model: 'slim',
      preset: presets[(slotNum - 1) % presets.length],
      customSkinDataUrl: null,
      active: false
    };

    activeAcc.skinSlots.push(newSlot);
    this._save();
    return this.listAccounts();
  }

  updateSkinSlot(slotId, { name, model, preset, capePreset, customSkinDataUrl, active }) {
    const activeAcc = this.state.accounts.find(a => a.id === this.state.activeAccountId);
    if (!activeAcc) throw new Error('No active account found.');

    const slot = activeAcc.skinSlots.find(s => s.id === slotId);
    if (!slot) throw new Error('Skin slot not found.');

    if (name !== undefined && String(name).trim()) slot.name = String(name).trim();
    if (model === 'classic' || model === 'slim') slot.model = model;
    if (preset !== undefined) slot.preset = String(preset);
    if (capePreset !== undefined) slot.capePreset = String(capePreset);

    if (customSkinDataUrl !== undefined) {
      if (customSkinDataUrl && !String(customSkinDataUrl).startsWith('data:image/png;base64,')) {
        throw new Error('Skin texture must be a valid PNG image.');
      }
      slot.customSkinDataUrl = customSkinDataUrl;
    }

    if (active) {
      for (const s of activeAcc.skinSlots) {
        s.active = s.id === slotId;
      }
      activeAcc.activeSkinSlot = slotId;
    }

    this._save();
    return this.listAccounts();
  }

  deleteSkinSlot(slotId) {
    const activeAcc = this.state.accounts.find(a => a.id === this.state.activeAccountId);
    if (!activeAcc) throw new Error('No active account found.');
    if (activeAcc.skinSlots.length <= 1) throw new Error('Cannot delete the only skin slot.');

    const idx = activeAcc.skinSlots.findIndex(s => s.id === slotId);
    if (idx === -1) throw new Error('Skin slot not found.');
    const wasActive = activeAcc.skinSlots[idx].active;

    activeAcc.skinSlots.splice(idx, 1);
    if (wasActive && activeAcc.skinSlots.length > 0) {
      activeAcc.skinSlots[0].active = true;
      activeAcc.activeSkinSlot = activeAcc.skinSlots[0].id;
    }
    this._save();
    return this.listAccounts();
  }

  _generatePresetSkinPng(preset) {
    const palettes = {
      'crimson-phantom': {
        skin: [243, 216, 199], hair: [12, 12, 16], eyes: [225, 29, 72],
        coat: [24, 24, 34], trim: [225, 29, 72], pants: [14, 14, 20], shoes: [190, 18, 60]
      },
      'obsidian-knight': {
        skin: [229, 193, 167], hair: [17, 24, 39], eyes: [56, 189, 248],
        coat: [30, 27, 75], trim: [99, 102, 241], pants: [15, 23, 42], shoes: [49, 46, 129]
      },
      'ash-valkyrie': {
        skin: [245, 208, 197], hair: [244, 244, 246], eyes: [244, 63, 94],
        coat: [39, 39, 42], trim: [251, 113, 133], pants: [24, 24, 27], shoes: [159, 18, 57]
      },
      'blood-monarch': {
        skin: [236, 197, 176], hair: [69, 10, 10], eyes: [251, 191, 36],
        coat: [127, 29, 29], trim: [245, 158, 11], pants: [28, 25, 23], shoes: [69, 10, 10]
      }
    };
    const pal = palettes[preset] || palettes['crimson-phantom'];

    return createPurePng(64, 64, (x, y) => {
      if (x >= 8 && x < 16 && y >= 8 && y < 16) {
        if (y < 10) return [...pal.hair, 255];
        if (y >= 12 && y <= 13 && (x === 9 || x === 14)) return [...pal.eyes, 255];
        return [...pal.skin, 255];
      }
      if (x < 32 && y < 16) return [...pal.hair, 255];
      if (x >= 20 && x < 28 && y >= 20 && y < 32) {
        if (x === 23 || x === 24 || y === 31) return [...pal.trim, 255];
        return [...pal.coat, 255];
      }
      if (x >= 16 && x < 40 && y >= 16 && y < 32) return [...pal.coat, 255];
      if (x >= 40 && x < 48 && y >= 20 && y < 32) return [...pal.trim, 255];
      if (x >= 16 && x < 40 && y >= 32 && y < 48) {
        return [...pal.pants, 255];
      }
      if (x >= 16 && x < 40 && y >= 48 && y < 56) {
        return [...pal.shoes, 255];
      }
      return [0, 0, 0, 0];
    });
  }

  _generateCapePng(preset = 'inex-crest') {
    const colors = {
      'inex-crest': [226, 18, 68, 255],
      crimson: [226, 18, 68, 255],
      royal: [66, 108, 255, 255],
      ember: [242, 120, 43, 255],
      obsidian: [33, 37, 61, 255],
      default: [226, 18, 68, 255]
    };
    const color = colors[preset] || colors.default;
    return createPurePng(64, 64, (x, y) => {
      const inside = y > 8 && y < 56 && x > 10 && x < 54;
      if (!inside) return [0, 0, 0, 0];
      const cx = x - 32;
      const cy = y - 32;
      const shoulder = Math.abs(cx) < 16 && y > 10 && y < 56;
      const wing = (Math.abs(cx) < 20 && (cy > -12 && cy < 12)) || (Math.abs(cx) < 10 && y > 14 && y < 50);
      const alpha = shoulder || wing ? 255 : 0;
      const r = color[0];
      const g = color[1];
      const b = color[2];
      return alpha ? [r, g, b, 255] : [0, 0, 0, 0];
    });
  }

  // The active account's custom skin (PNG buffer + model), or null when it uses a preset/default skin.
  _activeCustomSkin() {
    const acc = this.getActiveAccount();
    if (!acc) return null;
    const slots = Array.isArray(acc.skinSlots) ? acc.skinSlots : [];
    const slot = slots.find(s => s.id === acc.activeSkinSlot) || slots.find(s => s.active) || slots[0];
    if (!slot || typeof slot.customSkinDataUrl !== 'string' || !slot.customSkinDataUrl.startsWith('data:image/png;base64,')) return null;
    const buf = Buffer.from(slot.customSkinDataUrl.split(',')[1] || '', 'base64');
    if (buf.length < 8 || buf.length > 1024 * 1024 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { png: buf, model: String(slot.model || 'slim').toLowerCase() === 'classic' ? 'classic' : 'slim' };
  }

  // Local-only skin: writes the player's own skin to <gameDir>/inex-self-skin.png.
  // No cloud, no resource pack, no jar override -> nobody else is affected and nothing is shown to other players.
  // Returns { skinFile, model } (skinFile is null when there is nothing to apply).
  applyLocalCosmeticsToGameDir(gameDir) {
    const result = { skinFile: null, model: 'slim' };
    if (!gameDir) return result;
    fs.mkdirSync(gameDir, { recursive: true });

    // Clean up everything older versions put into the game folder (resource pack, override jar, options.txt entries).
    this._removeLegacyCosmetics(gameDir);
    try {
      this._removeNameplatePack(gameDir);
    } catch (err) {
      console.error('[AccountManager] options.txt cleanup skipped:', err.message);
    }

    const skinFile = path.join(gameDir, 'inex-self-skin.png');
    const settings = this.settingsManager.getSettings();
    const skin = settings.enableSkinSync === false ? null : this._activeCustomSkin();
    if (!skin) {
      fs.rmSync(skinFile, { force: true });
      return result;
    }
    const tmp = `${skinFile}.tmp`;
    fs.writeFileSync(tmp, skin.png);
    fs.renameSync(tmp, skinFile);
    result.skinFile = skinFile;
    result.model = skin.model;
    return result;
  }

  _removeNameplatePack(gameDir) {
    fs.rmSync(path.join(gameDir, 'resourcepacks', 'INEX-Nameplate'), { recursive: true, force: true });
    fs.rmSync(path.join(gameDir, 'resourcepacks', 'INEX-Local-Cosmetics'), { recursive: true, force: true });
    const optionsPath = path.join(gameDir, 'options.txt');
    if (!fs.existsSync(optionsPath)) return;
    let lines;
    try {
      lines = fs.readFileSync(optionsPath, 'utf8').split(/\r?\n/);
    } catch (err) {
      throw new Error(`Could not read Minecraft resource-pack settings: ${err.message}`);
    }

    const packIds = new Set(['file/INEX-Nameplate', 'INEX-Nameplate', 'file/INEX-Local-Cosmetics', 'INEX-Local-Cosmetics']);
    let changed = false;
    const updatedLines = lines.map(line => {
      const separator = line.indexOf(':');
      if (separator < 0 || !['resourcePacks', 'incompatibleResourcePacks'].includes(line.slice(0, separator))) return line;
      let packs;
      try {
        packs = JSON.parse(line.slice(separator + 1));
      } catch (err) {
        throw new Error(`Could not parse Minecraft resource-pack settings: ${err.message}`);
      }
      if (!Array.isArray(packs)) return line;
      const filtered = packs.filter(item => !packIds.has(item));
      if (filtered.length === packs.length) return line;
      changed = true;
      return `${line.slice(0, separator + 1)}${JSON.stringify(filtered)}`;
    });

    if (!changed) return;
    try {
      fs.writeFileSync(optionsPath, updatedLines.join('\n'), 'utf8');
    } catch (err) {
      throw new Error(`Could not update Minecraft resource-pack settings: ${err.message}`);
    }
  }

  _removeLegacyCosmetics(gameDir) {
    try {
      fs.rmSync(path.join(gameDir, 'resourcepacks', 'INEX-Local-Cosmetics'), { recursive: true, force: true });
      fs.rmSync(path.join(gameDir, 'inex-cosmetics-override.jar'), { force: true });
      fs.rmSync(path.join(gameDir, 'inex-cosmetics-state.json'), { force: true });
      fs.rmSync(path.join(gameDir, 'inex-cosmetics-settings.txt'), { force: true });
    } catch (err) {
      console.error('[AccountManager] Could not remove legacy cosmetics files:', err.message);
    }
  }
}

module.exports = { AccountManager, MS_REDIRECT_URI, createPurePng };