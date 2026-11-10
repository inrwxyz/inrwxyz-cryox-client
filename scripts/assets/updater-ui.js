/* Update card + Tauri updater wiring. Card markup/CSS comes from the old Electron appUpdater.js. */
(function () {
  'use strict';
  var T = window.__TAURI__;
  if (!T || !T.updater) return;
  var OVERLAY_ID = 'inex-update-overlay';
  function overlayScript(state) {
    const data = JSON.stringify(state);
    return `(() => {
      const s = ${data};
      let el = document.getElementById('${OVERLAY_ID}');
      if (s.stage === 'hide') { if (el) el.remove(); return; }
      if (!document.getElementById('${OVERLAY_ID}-css')) {
        const css = document.createElement('style');
        css.id = '${OVERLAY_ID}-css';
        css.textContent = \`
          #${OVERLAY_ID}{position:fixed;right:22px;bottom:22px;width:318px;z-index:2147483000;padding:16px 16px 14px;
            border-radius:16px;color:#f5f1f3;font:13px/1.4 system-ui,"Segoe UI",sans-serif;
            background:linear-gradient(160deg,rgba(32,10,18,.92),rgba(10,6,10,.94));
            border:1px solid rgba(225,29,72,.38);box-shadow:0 18px 50px rgba(0,0,0,.6),0 0 40px rgba(225,29,72,.16);
            backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);animation:inexUpIn .4s cubic-bezier(.2,.9,.3,1.2)}
          @keyframes inexUpIn{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}
          #${OVERLAY_ID} .u-top{display:flex;align-items:center;gap:11px}
          #${OVERLAY_ID} .u-ico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex:none;
            background:rgba(225,29,72,.16);border:1px solid rgba(225,29,72,.4)}
          #${OVERLAY_ID} .u-ico svg{width:18px;height:18px;stroke:#fb7185;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
          #${OVERLAY_ID} .u-ico.spin svg{animation:inexUpSpin 1s linear infinite}
          @keyframes inexUpSpin{to{transform:rotate(360deg)}}
          #${OVERLAY_ID} .u-title{font-weight:700;letter-spacing:.02em}
          #${OVERLAY_ID} .u-sub{color:#b9a9ae;font-size:12px;margin-top:1px}
          #${OVERLAY_ID} .u-bar{height:7px;border-radius:99px;margin-top:13px;background:rgba(255,255,255,.09);overflow:hidden}
          #${OVERLAY_ID} .u-fill{height:100%;width:0;border-radius:99px;transition:width .35s ease;
            background:linear-gradient(90deg,#be123c,#fb7185);box-shadow:0 0 14px rgba(225,29,72,.7)}
          #${OVERLAY_ID} .u-fill.indet{width:40%!important;animation:inexUpSlide 1.1s ease-in-out infinite}
          @keyframes inexUpSlide{0%{margin-left:-40%}100%{margin-left:100%}}
          #${OVERLAY_ID} .u-row{display:flex;gap:8px;margin-top:13px}
          #${OVERLAY_ID} button{flex:1;cursor:pointer;border-radius:10px;padding:8px 10px;font:600 12.5px system-ui;color:#fff;
            border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06)}
          #${OVERLAY_ID} button:hover{background:rgba(255,255,255,.12)}
          #${OVERLAY_ID} button.go{background:linear-gradient(135deg,#e11d48,#9f1239);border-color:rgba(251,113,133,.5);
            box-shadow:0 6px 20px rgba(225,29,72,.35)}
          #${OVERLAY_ID} button.go:hover{filter:brightness(1.12)}\`;
        document.head.appendChild(css);
      }
      if (!el) { el = document.createElement('div'); el.id = '${OVERLAY_ID}'; document.body.appendChild(el); }
      const icons = {
        down: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
        ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
        spin: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>'
      };
      let html = '';
      if (s.stage === 'downloading') {
        html = '<div class="u-top"><div class="u-ico">'+icons.down+'</div><div><div class="u-title">Downloading update'+(s.version?' v'+s.version:'')+'</div>'
          + '<div class="u-sub">'+(s.percent||0)+'% — you can keep using the launcher</div></div></div>'
          + '<div class="u-bar"><div class="u-fill" style="width:'+(s.percent||0)+'%"></div></div>';
      } else if (s.stage === 'ready') {
        html = '<div class="u-top"><div class="u-ico">'+icons.ok+'</div><div><div class="u-title">Update v'+(s.version||'')+' is available</div>'
          + '<div class="u-sub">Installs in a few seconds and reopens automatically.</div></div></div>'
          + '<div class="u-row"><button type="button" data-later>Later</button><button type="button" class="go" data-go>Update now</button></div>';
      } else if (s.stage === 'installing') {
        html = '<div class="u-top"><div class="u-ico spin">'+icons.spin+'</div><div><div class="u-title">Installing update…</div>'
          + '<div class="u-sub">Launcher will reopen on its own.</div></div></div>'
          + '<div class="u-bar"><div class="u-fill indet"></div></div>';
      }
      el.innerHTML = html;
      const go = el.querySelector('[data-go]'); if (go) go.onclick = () => window.dispatchEvent(new CustomEvent("inex-update",{detail:"install"}));
      const later = el.querySelector('[data-later]'); if (later) later.onclick = () => window.dispatchEvent(new CustomEvent("inex-update",{detail:"later"}));
    })();`;
  }

  var pending = null;
  var busy = false;
  function draw(state) { try { (0, eval)(overlayScript(state)); } catch (e) { console.error(e); } }

  window.addEventListener('inex-update', function (ev) {
    if (ev.detail === 'later') { draw({ stage: 'hide' }); return; }
    if (ev.detail !== 'install' || !pending || busy) return;
    busy = true;
    var total = 0, got = 0, version = pending.version;
    draw({ stage: 'downloading', percent: 0, version: version });
    pending.downloadAndInstall(function (e) {
      if (e.event === 'Started') total = (e.data && e.data.contentLength) || 0;
      else if (e.event === 'Progress') {
        got += (e.data && e.data.chunkLength) || 0;
        draw({ stage: 'downloading', percent: total ? Math.min(100, Math.round(got * 100 / total)) : 0, version: version });
      } else if (e.event === 'Finished') draw({ stage: 'installing' });
    }).then(function () {
      // On Windows the installer takes over and closes the launcher itself; relaunch only matters elsewhere.
      if (T.process && T.process.relaunch) return T.process.relaunch();
    }).catch(function (err) {
      console.error('[update]', err);
      busy = false;
      draw({ stage: 'hide' });
    });
  });

  function check() {
    if (busy) return;
    T.updater.check().then(function (u) {
      if (u) { pending = u; draw({ stage: 'ready', version: u.version }); }
    }).catch(function (e) { console.warn('[update] check failed', e); });
  }
  setTimeout(check, 5000);
  setInterval(check, 2 * 60 * 60 * 1000);
})();
