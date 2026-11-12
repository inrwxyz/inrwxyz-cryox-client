/**
 * CRYOX CLIENT — P2P Link (WebRTC DataChannel) for one-time-code Server Access
 * NO server is involved. The WebRTC handshake is done by copy-paste:
 *   1) host   -> friend : "host code"  (made when the host presses Generate)
 *   2) friend -> host   : "reply code" (made when the friend pastes the host code)
 * As soon as the host pastes the reply code, the DataChannel opens and everything goes directly peer-to-peer.
 *
 * Friend side
 *   inexP2P.parseOffer(text)            validate a host code -> { code }
 *   inexP2P.connect(text, onReply)      onReply(replyCode) is called when the reply code is ready; resolves when the link is open
 *   inexP2P.abort()                     cancel a connect that is still waiting
 *   inexP2P.call(code, method, args)    run a command on the host over P2P
 *   inexP2P.close(code)                 close the editor link
 *   inexP2P.onState(cb)                 cb({ hostUid: code, state })  state: connecting | open | closed
 * Host side
 *   inexP2P.getOffer(code)              { offerCode, error } once the host code is ready (null before)
 *   inexP2P.acceptAnswer(code, text)    host pastes the friend's reply code
 *   inexP2P.onHost(cb)                  cb({ code, kind })  kind: offer | error | open
 */
(function () {
  'use strict';
  const api = window.inexAPI || {};
  const C = window.inexCodec;
  const RTC_CFG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };
  const CHUNK = 12000;
  const CALL_TIMEOUT_MS = 20000;
  const GATHER_MAX_MS = 6000;      // max time to find our public address
  const GATHER_EXTRA_MS = 700;     // after the first public address, wait a little for the others
  const HANDSHAKE_MS = 30000;      // host: after pasting the reply, the link must open within this
  const JOIN_WAIT_MS = 4 * 60 * 1000; // friend: how long to wait for the host to paste the reply
  const FAILED_GRACE_MS = 45000;   // friend: ICE "failed" before the host pasted is not fatal for this long
  const OFFER_TTL_MIN = 15;        // must match CODE_TTL_MS in codeAccess.js
  const DISCONNECT_GRACE_MS = 12000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toLowerCase();
  const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const friendLinks = new Map(); // code -> link   (I joined with a code)
  const hostLinks = new Map();   // code -> link   (my own code)
  const listeners = new Set();
  const hostListeners = new Set();
  const emit = (code, state) => listeners.forEach(cb => { try { cb({ hostUid: code, state }); } catch (_) {} });
  const hostEvt = (code, kind) => hostListeners.forEach(cb => { try { cb({ code, kind }); } catch (_) {} });
  let connecting = false;
  let currentJoin = null;

  /* ---------- framing: JSON message -> chunks -> JSON message ---------- */
  async function sendMsg(link, obj) {
    const dc = link.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('P2P link is not open.');
    const json = JSON.stringify(obj);
    const id = rid();
    const n = Math.max(1, Math.ceil(json.length / CHUNK));
    for (let i = 0; i < n; i++) {
      while (dc.bufferedAmount > 1024 * 1024) {
        if (dc.readyState !== 'open') throw new Error('P2P link closed.');
        await sleep(15);
      }
      dc.send(JSON.stringify({ i: id, n, s: i, d: json.slice(i * CHUNK, (i + 1) * CHUNK) }));
    }
  }

  const MAX_BUF_CHUNKS = 2048;
  const MAX_BUF_ENTRIES = 32;
  const BUF_TTL_MS = 30000;

  function onRaw(link, raw, handler) {
    let f;
    try { f = JSON.parse(raw); } catch (_) { return; }
    if (!f || typeof f.i !== 'string' || !f.i || f.i.length > 64) return;
    if (!Number.isInteger(f.n) || f.n < 1 || f.n > MAX_BUF_CHUNKS) return;
    if (!Number.isInteger(f.s) || f.s < 0 || f.s >= f.n) return;
    if (typeof f.d !== 'string') return;

    const now = Date.now();
    for (const [k, v] of link.buf) {
      if (now - v.ts > BUF_TTL_MS) link.buf.delete(k);
    }

    let b = link.buf.get(f.i);
    if (!b) {
      if (link.buf.size >= MAX_BUF_ENTRIES) {
        const oldestKey = link.buf.keys().next().value;
        if (oldestKey !== undefined) link.buf.delete(oldestKey);
      }
      b = { n: f.n, parts: new Array(f.n), got: 0, ts: now };
      link.buf.set(f.i, b);
    } else if (f.n !== b.n) {
      return;
    } else {
      b.ts = now;
    }

    if (b.parts[f.s] === undefined) { b.parts[f.s] = f.d; b.got++; }
    if (b.got >= b.n) {
      link.buf.delete(f.i);
      let msg;
      try { msg = JSON.parse(b.parts.join('')); } catch (_) { return; }
      handler(msg);
    }
  }

  function newLink(extra) {
    return Object.assign({ pending: new Map(), buf: new Map(), dead: false, lost: false, opened: false }, extra);
  }

  function newPc(link) {
    const pc = new RTCPeerConnection(RTC_CFG);
    link.pc = pc;
    return pc;
  }

  // Wait until our public address is known (ICE gathering). No trickle: everything goes into the code.
  function waitGathered(pc) {
    return new Promise(resolve => {
      let done = false, soft = null;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(hard); clearTimeout(soft);
        pc.removeEventListener('icegatheringstatechange', chk);
        pc.removeEventListener('icecandidate', onc);
        resolve();
      };
      const chk = () => { if (pc.iceGatheringState === 'complete') fin(); };
      const onc = e => {
        if (!e.candidate) { fin(); return; }
        if (!soft && / typ srflx /.test(e.candidate.candidate || '')) soft = setTimeout(fin, GATHER_EXTRA_MS);
      };
      const hard = setTimeout(fin, GATHER_MAX_MS);
      pc.addEventListener('icegatheringstatechange', chk);
      pc.addEventListener('icecandidate', onc);
      chk();
    });
  }

  function destroy(link) {
    link.dead = true;
    if (link.discTimer) { clearTimeout(link.discTimer); link.discTimer = null; }
    try { if (link.dc) { link.dc.onclose = null; link.dc.close(); } } catch (_) {}
    try { if (link.pc) { link.pc.onconnectionstatechange = null; link.pc.close(); } } catch (_) {}
    link.pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('P2P link closed.')); });
    link.pending.clear();
    link.buf.clear();
  }

  /* ================= FRIEND SIDE (pastes the host code) ================= */
  function parseOffer(text) {
    const dec = C.decode(text);
    if (dec.type !== 'offer') throw new Error('That is a reply code. Paste the code the host gave you.');
    const age = C.nowMinutes() - dec.minutes;
    if (age > OFFER_TTL_MIN + 2 || age < -10) throw new Error('This code has expired. Ask the host for a new one.');
    return { code: dec.code, dec };
  }

  function handleJoinerMsg(link, msg) {
    if (!msg) return;
    if (msg.t === 'bye') { // host disconnected us
      linkLost(link);
      return;
    }
    if (msg.t === 'res') {
      const p = link.pending.get(msg.id);
      if (!p) return;
      link.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.d === undefined ? null : msg.d);
      else p.reject(new Error(msg.e || 'Host rejected the request.'));
    }
  }

  // A code is one-time: when the link drops there is NO silent reconnect. Ask the host for a new code.
  function linkLost(link) {
    if (link.lost) return;
    link.lost = true;
    link.pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('P2P connection lost.')); });
    link.pending.clear();
    emit(link.code, 'closed');
  }

  async function connect(offerText, onReply) {
    if (connecting) throw new Error('Already connecting. Please wait.');
    if (!C) throw new Error('P2P module did not load (p2p-codec.js).');
    connecting = true;
    let link = null;
    try {
      const { code, dec } = parseOffer(offerText);
      const old = friendLinks.get(code);
      if (old && !old.dead && !old.lost && old.dc && old.dc.readyState === 'open') throw new Error('You are already connected with this code.');
      if (old) { destroy(old); friendLinks.delete(code); }
      emit(code, 'connecting');
      link = newLink({ code, sid: rid(), failedAt: 0, aborted: false });
      friendLinks.set(code, link);
      currentJoin = link;

      const pc = newPc(link);
      pc.ondatachannel = e => {
        const dc = e.channel;
        link.dc = dc;
        dc.onopen = () => { link.opened = true; };
        dc.onmessage = ev => onRaw(link, ev.data, msg => handleJoinerMsg(link, msg));
        dc.onclose = () => { if (!link.dead && link.opened) linkLost(link); };
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (link.dead) return;
        if (st === 'connected') { link.failedAt = 0; return; }
        if (['failed', 'closed'].includes(st)) {
          if (link.opened) linkLost(link);
          else if (!link.failedAt) link.failedAt = Date.now(); // the host may not have pasted the reply yet
        }
      };

      const gathered = waitGathered(pc);
      await pc.setRemoteDescription({ type: 'offer', sdp: C.toSdp(dec.info, 'offer') });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered;
      if (link.dead) throw new Error(link.aborted ? 'Cancelled.' : 'Connection closed.');
      const reply = C.encode({ type: 'answer', code, info: C.parseSdp(pc.localDescription.sdp) });
      if (typeof onReply === 'function') onReply(reply);

      const deadline = Date.now() + JOIN_WAIT_MS;
      while (!link.opened && !link.dead && Date.now() < deadline) {
        if (link.failedAt && Date.now() - link.failedAt > FAILED_GRACE_MS) {
          throw new Error('Could not connect. A firewall / router may block direct connections, or the host used an old code. Ask the host for a new code.');
        }
        await sleep(250);
      }
      if (link.dead) throw new Error(link.aborted ? 'Cancelled.' : 'Connection closed.');
      if (!link.opened) throw new Error('The host did not paste your reply in time. Ask the host for a new code.');
      emit(code, 'open');
      return true;
    } catch (e) {
      if (link) {
        destroy(link);
        friendLinks.delete(link.code);
        emit(link.code, 'closed');
      }
      throw e;
    } finally {
      connecting = false;
      currentJoin = null;
    }
  }

  function abort() {
    const l = currentJoin;
    if (!l) return;
    l.aborted = true;
    destroy(l);
  }

  function call(code, method, args) {
    const link = friendLinks.get(code);
    if (!link || link.dead || link.lost || !link.dc || link.dc.readyState !== 'open') {
      return Promise.reject(new Error('Not connected to the host.'));
    }
    return new Promise((resolve, reject) => {
      const id = rid();
      const timer = setTimeout(() => { link.pending.delete(id); reject(new Error('Host did not answer in time.')); }, CALL_TIMEOUT_MS);
      link.pending.set(id, { resolve, reject, timer });
      sendMsg(link, { t: 'req', id, m: String(method), a: Array.isArray(args) ? args : [] }).catch(err => {
        link.pending.delete(id); clearTimeout(timer); reject(err);
      });
    });
  }

  async function close(code) {
    const link = friendLinks.get(code);
    if (!link) return;
    try { await sendMsg(link, { t: 'bye' }); } catch (_) {}
    destroy(link);
    friendLinks.delete(code);
    emit(code, 'closed');
  }

  /* ================= HOST SIDE (my own code) ================= */
  function hostGone(code, link) {
    if (link.dead) return;
    destroy(link);
    if (hostLinks.get(code) === link) hostLinks.delete(code);
    api.p2pHostClosed(code).catch(() => {});   // frees the "someone is connected" lock
  }

  // Called when the host generates a code: build the WebRTC offer and turn it into the short host code.
  async function prepareHost(code) {
    const old = hostLinks.get(code);
    if (old) { destroy(old); hostLinks.delete(code); }
    const link = newLink({ uid: code, sid: null, offerCode: null, error: null, accepted: false });
    hostLinks.set(code, link);
    try {
      if (!C) throw new Error('P2P module did not load (p2p-codec.js).');
      const pc = newPc(link);
      const dc = pc.createDataChannel('inex', { ordered: true });
      link.dc = dc;
      dc.onopen = () => { link.opened = true; api.p2pHostOpened(code).catch(() => {}); hostEvt(code, 'open'); };
      dc.onmessage = ev => onRaw(link, ev.data, msg => handleHostMsg(code, link, msg));
      dc.onclose = () => hostGone(code, link);
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (!link.accepted) return; // nothing to lose before the friend's reply is in
        if (['failed', 'closed'].includes(st)) { hostGone(code, link); return; }
        if (st === 'disconnected') {
          if (!link.discTimer) link.discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') hostGone(code, link); }, DISCONNECT_GRACE_MS);
        } else if (link.discTimer) { clearTimeout(link.discTimer); link.discTimer = null; }
      };
      const gathered = waitGathered(pc);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered;
      if (link.dead) return;
      link.offerCode = C.encode({ type: 'offer', code, info: C.parseSdp(pc.localDescription.sdp) });
      hostEvt(code, 'offer');
    } catch (e) {
      if (link.dead) return;
      link.error = String((e && e.message) || e);
      try { if (link.pc) link.pc.close(); } catch (_) {}
      hostEvt(code, 'error');
    }
  }

  function getOffer(code) {
    const l = hostLinks.get(normCode(code));
    if (!l || l.dead) return null;
    if (l.error) return { offerCode: null, error: l.error };
    return l.offerCode ? { offerCode: l.offerCode, error: null } : null;
  }

  // The host pasted the friend's reply code.
  async function acceptAnswer(codeIn, text) {
    const code = normCode(codeIn);
    const link = hostLinks.get(code);
    if (!link || link.dead || !link.offerCode) throw new Error('This code is not active. Generate a new one.');
    if (link.accepted) throw new Error('A reply was already used for this code.');
    const dec = C.decode(text);
    if (dec.type !== 'answer') throw new Error('That is the host code. Paste the REPLY code your friend sent back to you.');
    if (dec.code !== code) throw new Error('This reply belongs to a different code. Ask your friend to use your latest code.');
    link.accepted = true;
    link.sid = rid();
    try { await api.p2pClaim(code, link.sid); } // the code dies now: nobody else can use it
    catch (e) { link.accepted = false; throw e; }
    try {
      await link.pc.setRemoteDescription({ type: 'answer', sdp: C.toSdp(dec.info, 'answer') });
    } catch (_) {
      hostGone(code, link);
      throw new Error('That reply code could not be used. Generate a new code and try again.');
    }
    const deadline = Date.now() + HANDSHAKE_MS;
    while (!link.opened && !link.dead && Date.now() < deadline) await sleep(250);
    if (!link.opened) {
      hostGone(code, link);
      throw new Error('Could not connect. A firewall / router may block direct connections, or the reply was too late. Generate a new code and try again.');
    }
    return true;
  }

  async function handleHostMsg(code, link, msg) {
    if (!msg) return;
    if (msg.t === 'bye') { hostGone(code, link); return; }
    if (msg.t !== 'req') return;
    let out;
    try {
      // Permission check (active session + this server + allowed method) happens in the main process.
      const data = await api.p2pExec(code, msg.m, msg.a);
      out = { t: 'res', id: msg.id, ok: true, d: data === undefined ? null : data };
    } catch (e) {
      const m = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      out = { t: 'res', id: msg.id, ok: false, e: m.slice(0, 300) };
    }
    try { await sendMsg(link, out); } catch (_) {}
  }

  if (api.onP2PExpect) api.onP2PExpect(d => { if (d && d.code) prepareHost(d.code).catch(() => {}); });
  if (api.onP2PKick) api.onP2PKick(async d => {
    const l = d && hostLinks.get(d.code);
    if (!l) return;
    hostLinks.delete(d.code);
    try { await sendMsg(l, { t: 'bye' }); await sleep(150); } catch (_) {}
    destroy(l);
  });
  window.addEventListener('beforeunload', () => {
    friendLinks.forEach(l => { try { sendMsg(l, { t: 'bye' }); } catch (_) {} });
  });

  window.inexP2P = {
    parseOffer: t => { const r = parseOffer(t); return { code: r.code }; },
    connect,
    abort,
    call,
    close,
    getOffer,
    acceptAnswer,
    isOpen: code => { const l = friendLinks.get(code); return Boolean(l && l.dc && l.dc.readyState === 'open'); },
    onState: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    onHost: cb => { hostListeners.add(cb); return () => hostListeners.delete(cb); }
  };
})();
