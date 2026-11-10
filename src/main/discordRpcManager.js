const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// The Discord application this launcher belongs to (same ID that worked in test-discord.js).
// Always used for the handshake, never read from settings.json.
const DISCORD_CLIENT_ID = '1568590021332570122';

/**
 * Pure Node.js Discord Rich Presence IPC Client for Windows/Desktop.
 * Connects directly to Discord's local IPC socket (\\.\pipe\discord-ipc-0..9 on Windows)
 * without requiring any native C++ addons or external dependencies.
 */
class DiscordRpcManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.connectedUser = null;
    this.sessionStartTimestamp = Math.floor(Date.now() / 1000);
    this.baseActivity = {
      details: 'In Launcher Menu',
      state: 'CRYOX CLIENT • Windows Edition',
      startTimestamp: this.sessionStartTimestamp
    };
    this.currentActivity = { ...this.baseActivity };
    this.hostedServerInfo = null; // Tracks running local server for combined RPC status
    this.reconnectTimer = null;
    this.retryWithoutAssets = false;
    this.lastError = null;
  }

  _getIpcPath(index = 0) {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\discord-ipc-${index}`;
    }
    const runtimeDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
    return path.join(runtimeDir, `discord-ipc-${index}`);
  }

  _encodeFrame(opcode, payloadObj) {
    const jsonStr = JSON.stringify(payloadObj);
    const dataBuf = Buffer.from(jsonStr, 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(dataBuf.length, 4);
    return Buffer.concat([header, dataBuf]);
  }

  start() {
    const settings = this.settingsManager.getSettings();
    if (!settings.discordRpcEnabled) {
      this.stop();
      return;
    }
    this._tryConnectPipe(0);
    if (!this.reconnectTimer) {
      this.reconnectTimer = setInterval(() => {
        const s = this.settingsManager.getSettings();
        if (s.discordRpcEnabled && !this.connected && !this.connecting) {
          this._tryConnectPipe(0);
        }
      }, 12000);
      if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }
  }

  stop() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        // Clear the presence first so Discord removes it immediately, then close.
        this.socket.write(this._encodeFrame(1, {
          cmd: 'SET_ACTIVITY',
          args: { pid: process.pid, activity: null },
          nonce: crypto.randomBytes(8).toString('hex')
        }));
        this.socket.write(this._encodeFrame(2, {}));
        this.socket.destroy();
      } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    this.connectedUser = null;
  }

  _tryConnectPipe(index) {
    if (index > 9) {
      this.connecting = false;
      return;
    }
    this.connecting = true;
    const pipePath = this._getIpcPath(index);

    let sock;
    try {
      sock = net.createConnection(pipePath);
    } catch (_) {
      this._tryConnectPipe(index + 1);
      return;
    }

    let handshakeDone = false;
    let aborted = false;
    let buffer = Buffer.alloc(0);

    const cleanupAndTryNext = () => {
      try {
        sock.destroy();
      } catch (_) {}
      if (!handshakeDone && !aborted) {
        this._tryConnectPipe(index + 1);
      }
    };

    sock.once('error', () => {
      if (this.socket === sock) {
        this.connected = false;
        this.socket = null;
        this.connectedUser = null;
      }
      cleanupAndTryNext();
    });

    sock.once('connect', () => {
      try {
        sock.write(this._encodeFrame(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
      } catch (_) {
        cleanupAndTryNext();
      }
    });

    sock.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readInt32LE(0);
        const length = buffer.readInt32LE(4);
        if (length < 0 || length > 1024 * 1024) {
          buffer = Buffer.alloc(0);
          try { sock.destroy(); } catch (_) {}
          return;
        }
        if (buffer.length < 8 + length) break;
        const body = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);

        let payload = null;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch (_) {}

        if (opcode === 3) {
          try { sock.write(this._encodeFrame(4, payload || {})); } catch (_) {}
          continue;
        }
        if (opcode === 2) {
          this.lastError = (payload && payload.message) || 'Discord closed the connection';
          aborted = true;
          this.connecting = false;
          try { sock.destroy(); } catch (_) {}
          return;
        }

        if (opcode === 1 && payload) {
          if (!handshakeDone && payload.evt === 'READY') {
            handshakeDone = true;
            this.socket = sock;
            this.connected = true;
            this.connecting = false;
            this.lastError = null;
            if (payload.data && payload.data.user) {
              this.connectedUser = payload.data.user.username || 'User';
            }
            this._sendCurrentActivity();
            continue;
          }
          if (payload.evt === 'ERROR') {
            const msg = String((payload.data && payload.data.message) || 'Unknown Discord error');
            if (!handshakeDone) {
              this.lastError = msg;
              aborted = true;
              this.connecting = false;
              try { sock.destroy(); } catch (_) {}
              return;
            }
            this.lastError = msg;
            if (msg.toLowerCase().includes('asset') && !this.retryWithoutAssets) {
              this.retryWithoutAssets = true;
              this._sendCurrentActivity();
            }
          }
        }
      }
    });

    sock.once('close', () => {
      if (this.socket === sock) {
        this.connected = false;
        this.socket = null;
        this.connectedUser = null;
      }
      this.connecting = false;
    });
  }

  _rebuildEffectiveActivity() {
    const srv = this.hostedServerInfo;
    if (srv && (srv.status === 'online' || srv.status === 'starting')) {
      const loaderLabel = (srv.loader || 'server').charAt(0).toUpperCase() + (srv.loader || 'server').slice(1);
      const pCount = Array.isArray(srv.players) ? srv.players.length : 0;
      const maxP = srv.maxPlayers || 20;
      const statusPart = srv.status === 'starting'
        ? 'Starting Server...'
        : `${pCount}/${maxP} Players Online`;
      const addrPart = srv.publicAddress ? ` • ${srv.publicAddress}` : '';

      const isPlaying = this.baseActivity && String(this.baseActivity.details || '').startsWith('Playing Minecraft');
      this.currentActivity = {
        details: isPlaying
          ? `${this.baseActivity.details} | Hosting: ${srv.name}`
          : `Hosting: ${srv.name} (${loaderLabel} ${srv.version})`,
        state: `${statusPart}${addrPart}`,
        startTimestamp: srv.startedAt ? Math.floor(srv.startedAt / 1000) : this.sessionStartTimestamp
      };
    } else {
      this.currentActivity = { ...this.baseActivity };
    }
  }

  _sendCurrentActivity() {
    const settings = this.settingsManager.getSettings();
    if (!settings.discordRpcEnabled) return;
    if (!this.connected || !this.socket) return;

    this._rebuildEffectiveActivity();

    const activityObj = {
      details: this.currentActivity.details || 'In Launcher Menu',
      state: this.currentActivity.state || settings.discordStatusText || 'CRYOX CLIENT • Windows Edition',
      timestamps: {
        start: this.currentActivity.startTimestamp || this.sessionStartTimestamp
      },
      instance: false
    };

    if (!this.retryWithoutAssets) {
      activityObj.assets = {
        large_image: 'cryox_logo',
        large_text: 'CRYOX CLIENT — Windows Minecraft Launcher',
        small_image: 'minecraft',
        small_text: this.hostedServerInfo ? 'Hosting Cryox Server' : 'Cryox Runtime'
      };
    }

    const payload = {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: activityObj
      },
      nonce: crypto.randomBytes(8).toString('hex')
    };

    try {
      this.socket.write(this._encodeFrame(1, payload));
    } catch (_) {
      this.connected = false;
    }
  }

  setLauncherMenuPresence(activeProfile = null) {
    const settings = this.settingsManager.getSettings();
    this.baseActivity = {
      details: activeProfile
        ? `Ready: ${activeProfile.name} (${activeProfile.version})`
        : 'In Launcher Menu',
      state: settings.discordStatusText || 'CRYOX CLIENT • Windows Edition',
      startTimestamp: this.sessionStartTimestamp
    };
    this._rebuildEffectiveActivity();
    if (settings.discordRpcEnabled) {
      if (!this.connected && !this.connecting) {
        this.start();
      } else {
        this._sendCurrentActivity();
      }
    }
  }

  setPlayingGamePresence(profile, account) {
    const settings = this.settingsManager.getSettings();
    const loaderName = profile.loader
      ? profile.loader.charAt(0).toUpperCase() + profile.loader.slice(1)
      : 'Vanilla';
    this.baseActivity = {
      details: `Playing Minecraft ${profile.version} (${loaderName})`,
      state: `Profile: ${profile.name} • ${account ? account.username : 'Player'}`,
      startTimestamp: Math.floor(Date.now() / 1000)
    };
    this._rebuildEffectiveActivity();
    if (settings.discordRpcEnabled) {
      this._sendCurrentActivity();
    }
  }

  /**
   * Updates Discord Rich Presence when a local X server starts, stops, or changes player count.
   */
  setServerPresence(serverInfo = null) {
    this.hostedServerInfo = serverInfo;
    this._rebuildEffectiveActivity();
    const settings = this.settingsManager.getSettings();
    if (settings.discordRpcEnabled) {
      if (!this.connected && !this.connecting) {
        this.start();
      } else {
        this._sendCurrentActivity();
      }
    }
  }

  getStatus() {
    const settings = this.settingsManager.getSettings();
    const connectedLabel = this.connectedUser
      ? `Connected to Discord as @${this.connectedUser} (Live)`
      : 'Connected to Discord Desktop (Live)';

    return {
      enabled: Boolean(settings.discordRpcEnabled),
      connected: Boolean(this.connected),
      connectedUser: this.connectedUser,
      clientId: DISCORD_CLIENT_ID,
      statusText: !settings.discordRpcEnabled
        ? 'Disabled in Settings'
        : this.connected
        ? connectedLabel
        : this.lastError
        ? `Discord rejected the connection: ${this.lastError}`
        : 'Standby (Open Discord Desktop to broadcast)',
      activity: this.currentActivity
    };
  }
}

module.exports = { DiscordRpcManager };