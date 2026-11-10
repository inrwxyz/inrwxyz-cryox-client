/**
 * CRYOX CLIENT — P2P handshake codec (no server).
 *
 * Packs only what WebRTC really needs (ICE user/pass, DTLS fingerprint, public IP:port) into a short
 * copy-paste code, and rebuilds a full SDP from it on the other side.
 *
 *   offer code  (host  -> friend): session code + created-at minute + ICE + fingerprint + addresses
 *   answer code (friend -> host) : session code + ICE + fingerprint + addresses
 *
 * Code text = base32 (32 symbols, no I/O/0/1) + CRC16, shown in groups: ABCDEF-GHJKLM-...
 * Works in the renderer (window.inexCodec) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const EPOCH_MIN = Math.floor(Date.UTC(2026, 0, 1) / 60000);
  const VERSION = 1;
  const MAX_CANDS = 3;

  const nowMinutes = () => Math.floor(Date.now() / 60000) - EPOCH_MIN;

  /* ---------------- base32 ---------------- */
  function b32enc(bytes) {
    let out = '', buf = 0, bits = 0;
    for (const b of bytes) {
      buf = (buf << 8) | b; bits += 8;
      while (bits >= 5) { out += ALPHA[(buf >> (bits - 5)) & 31]; bits -= 5; }
      buf &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHA[(buf << (5 - bits)) & 31];
    return out;
  }
  function b32dec(str) {
    const bytes = [];
    let buf = 0, bits = 0;
    for (const ch of str) {
      const v = ALPHA.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 5) | v; bits += 5;
      if (bits >= 8) { bytes.push((buf >> (bits - 8)) & 255); bits -= 8; }
      buf &= (1 << bits) - 1;
    }
    return Uint8Array.from(bytes);
  }
  const clean = s => String(s || '').toUpperCase().split('').filter(c => ALPHA.indexOf(c) >= 0).join('');
  const group = s => s.replace(/(.{6})(?=.)/g, '$1-');

  function crc16(bytes) {
    let c = 0xffff;
    for (const b of bytes) {
      c ^= b << 8;
      for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  }

  /* ---------------- session code (8 symbols) <-> 5 bytes ---------------- */
  function codeToBytes(code) {
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('Bad session code.');
    return b32dec(code).slice(0, 5);
  }
  function bytesToCode(b) { return b32enc(b).slice(0, 8); }

  /* ---------------- SDP -> info ---------------- */
  function parseSdp(sdp) {
    const info = { ufrag: '', pwd: '', fp: null, passive: false, cands: [], host: false };
    const srflx = [], host = [];
    String(sdp).split(/\r?\n/).forEach(l => {
      if (l.startsWith('a=ice-ufrag:') && !info.ufrag) info.ufrag = l.slice(12).trim();
      else if (l.startsWith('a=ice-pwd:') && !info.pwd) info.pwd = l.slice(10).trim();
      else if (l.startsWith('a=setup:')) info.passive = l.slice(8).trim() === 'passive';
      else if (l.startsWith('a=fingerprint:') && !info.fp) {
        const m = l.match(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/);
        if (m && m[1].toLowerCase() === 'sha-256') {
          const hex = m[2].split(':');
          if (hex.length === 32) info.fp = Uint8Array.from(hex.map(h => parseInt(h, 16)));
        }
      } else if (l.startsWith('a=candidate:')) {
        const t = l.slice(12).trim().split(/\s+/);
        if (t.length < 8 || t[1] !== '1' || t[2].toLowerCase() !== 'udp' || t[6] !== 'typ') return;
        const ip = t[4].split('.').map(Number);
        const port = Number(t[5]);
        if (ip.length !== 4 || ip.some(n => !(n >= 0 && n <= 255)) || !(port > 0 && port < 65536)) return; // IPv4 only (skips xxxx.local too)
        const key = ip.join('.') + ':' + port;
        const list = t[7] === 'srflx' ? srflx : (t[7] === 'host' ? host : null);
        if (list && !list.some(c => c.key === key)) list.push({ ip, port, key });
      }
    });
    const pick = srflx.length ? srflx : host;
    info.host = !srflx.length && host.length > 0;
    info.cands = pick.slice(0, MAX_CANDS).map(c => ({ ip: c.ip, port: c.port }));
    if (!info.ufrag || !info.pwd || !info.fp) throw new Error('Could not read the connection data (WebRTC).');
    if (!info.cands.length) throw new Error('Could not find your public address. Check your internet connection (STUN is blocked?).');
    return info;
  }

  /* ---------------- info -> SDP ---------------- */
  function toSdp(info, kind) {
    const fp = Array.from(info.fp).map(b => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(':');
    const L = [
      'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0'
    ];
    info.cands.forEach((c, i) => {
      const ip = c.ip.join('.');
      L.push(info.host
        ? `a=candidate:${i + 1} 1 udp 2122260223 ${ip} ${c.port} typ host generation 0`
        : `a=candidate:${i + 1} 1 udp 1677729535 ${ip} ${c.port} typ srflx raddr 0.0.0.0 rport 0 generation 0`);
    });
    L.push(
      'a=ice-ufrag:' + info.ufrag, 'a=ice-pwd:' + info.pwd,
      'a=fingerprint:sha-256 ' + fp,
      'a=setup:' + (kind === 'offer' ? 'actpass' : (info.passive ? 'passive' : 'active')),
      'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144'
    );
    return L.join('\r\n') + '\r\n';
  }

  /* ---------------- encode / decode ---------------- */
  const isB64 = s => s.split('').every(c => B64.indexOf(c) >= 0);

  function encode({ type, code, minutes, info }) {
    const isAnswer = type === 'answer';
    const compact = info.ufrag.length === 4 && info.pwd.length === 24 && isB64(info.ufrag + info.pwd);
    const n = Math.min(info.cands.length, MAX_CANDS);
    const out = [];
    out.push((VERSION << 6) | ((isAnswer ? 1 : 0) << 5) | ((isAnswer && info.passive ? 1 : 0) << 4) | ((compact ? 1 : 0) << 3) | (n << 1) | (info.host ? 1 : 0));
    out.push(...codeToBytes(code));
    if (!isAnswer) {
      const m = Math.max(0, Math.min(0xffffff, minutes == null ? nowMinutes() : minutes));
      out.push((m >> 16) & 255, (m >> 8) & 255, m & 255);
    }
    if (compact) {
      let buf = 0, bits = 0;
      for (const ch of info.ufrag + info.pwd) {
        buf = (buf << 6) | B64.indexOf(ch); bits += 6;
        while (bits >= 8) { out.push((buf >> (bits - 8)) & 255); bits -= 8; }
        buf &= (1 << bits) - 1;
      }
      if (bits > 0) out.push((buf << (8 - bits)) & 255);
    } else {
      const u = Array.from(info.ufrag, c => c.charCodeAt(0) & 127), p = Array.from(info.pwd, c => c.charCodeAt(0) & 127);
      out.push(u.length, ...u, p.length, ...p);
    }
    out.push(...info.fp);
    info.cands.slice(0, n).forEach(c => out.push(...c.ip, (c.port >> 8) & 255, c.port & 255));
    const crc = crc16(out);
    out.push((crc >> 8) & 255, crc & 255);
    return group(b32enc(out));
  }

  function decode(text) {
    const bad = () => new Error('This code is incomplete or has a typo. Copy the whole code again.');
    const bytes = b32dec(clean(text));
    if (bytes.length < 40) throw bad();
    const body = bytes.slice(0, bytes.length - 2);
    const crc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    // a code can have up to 4 spare padding bits at the end, so try the exact length first
    if (crc16(body) !== crc) throw bad();
    const b0 = body[0];
    if ((b0 >> 6) !== VERSION) throw new Error('This code comes from a different X version. Update the launcher on both sides.');
    const isAnswer = ((b0 >> 5) & 1) === 1;
    const info = { ufrag: '', pwd: '', fp: null, passive: ((b0 >> 4) & 1) === 1, cands: [], host: (b0 & 1) === 1 };
    const compact = ((b0 >> 3) & 1) === 1;
    const n = (b0 >> 1) & 3;
    let i = 1;
    const code = bytesToCode(body.slice(i, i + 5)); i += 5;
    let minutes = null;
    if (!isAnswer) { minutes = (body[i] << 16) | (body[i + 1] << 8) | body[i + 2]; i += 3; }
    if (compact) {
      let s = '', buf = 0, bits = 0, got = 0;
      while (got < 28) {
        buf = (buf << 8) | body[i++]; bits += 8;
        while (bits >= 6 && got < 28) { s += B64[(buf >> (bits - 6)) & 63]; bits -= 6; got++; }
        buf &= (1 << bits) - 1;
      }
      info.ufrag = s.slice(0, 4); info.pwd = s.slice(4);
    } else {
      const ul = body[i++]; info.ufrag = String.fromCharCode(...body.slice(i, i + ul)); i += ul;
      const pl = body[i++]; info.pwd = String.fromCharCode(...body.slice(i, i + pl)); i += pl;
    }
    info.fp = body.slice(i, i + 32); i += 32;
    for (let k = 0; k < n; k++) {
      info.cands.push({ ip: Array.from(body.slice(i, i + 4)), port: (body[i + 4] << 8) | body[i + 5] });
      i += 6;
    }
    if (i !== body.length || info.fp.length !== 32 || !info.cands.length) throw bad();
    return { type: isAnswer ? 'answer' : 'offer', code, minutes, info };
  }

  const api = { encode, decode, parseSdp, toSdp, nowMinutes, clean, group };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.inexCodec = api;
})(typeof window !== 'undefined' ? window : globalThis);
