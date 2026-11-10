/**
 * CRYOX CLIENT — Accounts header styling (Holographic Skin Studio controls)
 * Keeps the compact 32px look of the Skin Sync pill + "New Skin Slot" button.
 * (The old Friends / Online buttons were removed together with the friend system.)
 */
(function () {
  'use strict';
  const st = document.createElement('style');
  st.textContent = `
  #view-accounts .studio-controls {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  #view-accounts .studio-controls > .btn,
  #view-accounts .studio-controls > .skin-sync-pill {
    height: 32px !important;
    min-height: 32px !important;
    padding: 0 11px !important;
    font-size: 11.5px !important;
    border-radius: 9px !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 7px !important;
    box-sizing: border-box !important;
  }
  #view-accounts .studio-controls .sync-bolt-icon {
    width: 18px !important; height: 18px !important;
  }
  #view-accounts .studio-controls .sync-text-col {
    display: flex !important; flex-direction: row !important; align-items: center !important; gap: 5px !important; line-height: 1 !important;
  }
  #view-accounts .studio-controls .sync-label { font-size: 10px !important; }
  #view-accounts .studio-controls .sync-sub { font-size: 10px !important; }
  #view-accounts .studio-controls .switch {
    width: 34px !important; height: 18px !important;
  }
  #view-accounts .studio-controls .slider-toggle:before {
    width: 12px !important; height: 12px !important; left: 3px !important; bottom: 3px !important;
  }
  #view-accounts .studio-controls .switch input:checked + .slider-toggle:before {
    transform: translateX(16px) !important;
  }`;
  document.head.appendChild(st);
})();
