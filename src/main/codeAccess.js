'use strict';
/**
 * CRYOX CLIENT — Code Access (one-time code -> WebRTC P2P Remote Server Editor)
 *
 *  - Host picks a server and generates a one-time code. The code is made locally: NO server is involved.
 *  - The renderer (p2p-link.js) turns it into a short "host code" that contains the WebRTC offer.
 *    The friend pastes it, gets a "reply code" back and sends it to the host. The host pastes the reply -> P2P opens.
 *  - The host accepts exactly ONE reply (claim); after that the code is dead (and after 15 minutes if unused).
 *  - While someone is connected nobody else can use a code and the host cannot generate a new one.
 *  - This file only keeps the host-side state and checks the permission of every remote command.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { isAllowed } = require('./cohostPolicy');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I / O / 0 / 1
const CODE_LEN = 8;                     // 8 symbols = 40 bits = exactly 5 bytes inside the host code
const SID_RE = /^[a-z0-9]{6,20}$/;
const CODE_TTL_MS = 15 * 60 * 1000;      // unused code lifetime (keep in sync with OFFER_TTL_MIN in p2p-link.js)
const CLAIM_TIMEOUT_MS = 45 * 1000;      // after the host pasted the reply, the P2P link must open within this

class CodeAccess extends EventEmitter {
  constructor({ remoteExecutor, serverProvider } = {}) {
    super();
    this.remoteExecutor = remoteExecutor || null;
    this.serverProvider = serverProvider || null;
    this.pending = null;   // { code, serverId, exp, timer }
    this.session = null;   // { id, serverId, since, sid, opened, timer }
    this._creating = false;
  }

  setRemoteExecutor(fn) { this.remoteExecutor = fn; }
  setServerProvider(fn) { this.serverProvider = fn; }

  _newCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return s;
  }

  static normalize(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  async shutdown() {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
    if (this.session) { clearTimeout(this.session.timer); this.session = null; }
  }

  /* ---------------- status ---------------- */
  getStatus() {
    const phase = this.session ? 'connected' : (this.pending ? 'waiting' : 'idle');
    const src = this.session || this.pending || {};
    return {
      configured: true,
      phase,
      code: this.pending ? this.pending.code : null,
      serverId: src.serverId || null,
      exp: this.pending ? this.pending.exp : null,
      since: this.session ? this.session.since : null
    };
  }

  _emitState() { this.emit('state', this.getStatus()); }

  /* ---------------- host: create / cancel / disconnect ---------------- */
  async createCode(serverId) {
    if (this._creating) throw new Error('Already generating a code. Please wait.');
    if (this.session) throw new Error('Someone is connected right now. Disconnect them first.');
    if (this.pending) return this.getStatus(); // one active code at a time, never a second one
    this._creating = true; // set BEFORE any await so a second tap can never start a second code
    try {
      if (this.serverProvider) {
        const list = (await this.serverProvider()) || [];
        if (!list.some(s => s.id === serverId)) throw new Error('That server was not found.');
      }
      if (this.session || this.pending) return this.getStatus(); // state changed while we were awaiting
      const code = this._newCode();
      const exp = Date.now() + CODE_TTL_MS;
      this.pending = { code, serverId, exp, timer: setTimeout(() => this._expire(code), CODE_TTL_MS) };
      this._emitState();
      this.emit('p2p-expect', { code, exp });
      return this.getStatus();
    } finally {
      this._creating = false;
    }
  }

  _expire(code) {
    if (!this.pending || this.pending.code !== code) return;
    this._dropPending(true);
  }

  _dropPending(kick) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    if (kick) this.emit('p2p-kick', { code: p.code });
    this._emitState();
  }

  async cancelCode() {
    this._dropPending(true);
    return this.getStatus();
  }

  _endSession(code, kick) {
    const s = this.session;
    if (!s || s.id !== code) return;
    clearTimeout(s.timer);
    this.session = null;
    if (kick) this.emit('p2p-kick', { code });
    this._emitState();
  }

  /** Host pressed Disconnect (or Cancel code). */
  async disconnect() {
    if (this.session) this._endSession(this.session.id, true);
    else this._dropPending(true);
    return this.getStatus();
  }

  /* ---------------- host: the first valid reply code claims the code ---------------- */
  async claim(code, sid) {
    code = CodeAccess.normalize(code);
    if (!this.pending || this.pending.code !== code) throw new Error('This code is not active.');
    if (!SID_RE.test(String(sid || ''))) throw new Error('Bad session id.');
    const p = this.pending;
    clearTimeout(p.timer);
    this.pending = null;
    const timer = setTimeout(() => {
      if (this.session && this.session.id === code && !this.session.opened) this._endSession(code, true);
    }, CLAIM_TIMEOUT_MS);
    this.session = { id: code, serverId: p.serverId, since: Date.now(), sid, opened: false, timer };
    this._emitState();
    return { ok: true };
  }

  hostOpened(code) {
    code = CodeAccess.normalize(code);
    const s = this.session;
    if (!s || s.id !== code) return { ok: false };
    s.opened = true;
    clearTimeout(s.timer);
    s.timer = null;
    this._emitState();
    return { ok: true };
  }

  hostClosed(code) {
    this._endSession(CodeAccess.normalize(code), false);
    return { ok: true };
  }

  /* ---------------- host: permission check for every remote command ---------------- */
  async p2pExec(code, method, args) {
    code = CodeAccess.normalize(code);
    const s = this.session;
    if (!s || s.id !== code) throw new Error('This editor session is not active. Ask the host for a new code.');
    if (!isAllowed(method)) throw new Error(`"${method}" is not allowed over a code session.`);
    if (!this.remoteExecutor) throw new Error('Host is not ready.');
    const list = Array.isArray(args) ? args : [];
    if (method === 'listServers') {
      const all = (await this.remoteExecutor('listServers', [])) || [];
      return all.filter(sv => sv.id === s.serverId);
    }
    if (String(list[0] || '') !== s.serverId) throw new Error('This code only gives access to one server.');
    return this.remoteExecutor(method, list);
  }
}

module.exports = { CodeAccess };
