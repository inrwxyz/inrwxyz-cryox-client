//! Discord Rich Presence, ported 1:1 in behaviour from x_client's discordRpcManager.js:
//!  - one worker thread owns the Discord IPC pipe (\\.\pipe\discord-ipc-0..9) and keeps it open,
//!  - it reconnects every 12 s while Discord is closed (and right away when something changes),
//!  - presence = launcher menu ("Ready: <profile> (<version>)") / playing ("Playing Minecraft <v> (<Loader>)")
//!    and, while a local server runs, a combined "Hosting: <server>" status with player count + public address,
//!  - the connected Discord user name and Discord's own error message are shown in Settings,
//!  - if Discord rejects an image asset the presence is sent again without images,
//!  - switching Discord off clears the presence immediately.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DISCORD_CLIENT_ID: &str = "1568590021332570122";
pub const DISCORD_LARGE_IMAGE: &str = "cryox_logo";
const DISCORD_SMALL_IMAGE: &str = "minecraft";
const RECONNECT_SECS: u64 = 12;

#[derive(Debug, Clone, Default)]
struct ServerInfo {
    name: String,
    version: String,
    loader: String,
    status: String,
    players: usize,
    max_players: u32,
    public_address: Option<String>,
    started_at_ms: Option<u64>,
}

struct Shared {
    base_details: String,
    base_state: Option<String>,
    base_start: u64,
    server: Option<ServerInfo>,
    connected: bool,
    user: Option<String>,
    last_error: Option<String>,
    retry_without_assets: bool,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    base_details: String::new(),
    base_state: None,
    base_start: 0,
    server: None,
    connected: false,
    user: None,
    last_error: None,
    retry_without_assets: false,
});

enum Msg {
    Refresh,
    SyncServers,
}

static TX: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();
static SESSION_START: OnceLock<u64> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    pub enabled: bool,
    pub connected: bool,
    pub connected_user: Option<String>,
    pub client_id: String,
    pub status_text: String,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn session_start() -> u64 {
    *SESSION_START.get_or_init(now_secs)
}

fn settings() -> Value {
    crate::settings::SettingsManager::new().get_settings()
}

pub fn rpc_enabled() -> bool {
    settings().get("discordRpcEnabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

fn status_text_setting() -> String {
    settings()
        .get("discordStatusText")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "CRYOX CLIENT".to_string())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// public API (never blocks: everything only queues work for the worker thread)
// ---------------------------------------------------------------------------------------------

fn send(msg: Msg) {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Msg>();
        std::thread::spawn(move || worker(rx));
        Mutex::new(tx)
    });
    if let Ok(t) = tx.lock() {
        let _ = t.send(msg);
    }
}

/// Starts the worker (once) and connects when Discord is enabled.
pub fn start() {
    let _ = session_start();
    send(Msg::Refresh);
}

/// "In Launcher Menu" / "Ready: <profile> (<version>)" (setLauncherMenuPresence).
pub fn set_launcher_menu(active_profile: Option<(String, String)>) {
    if let Ok(mut s) = SHARED.lock() {
        s.base_details = match active_profile {
            Some((name, version)) => format!("Ready: {name} ({version})"),
            None => "In Launcher Menu".to_string(),
        };
        s.base_state = None;
        s.base_start = session_start();
    }
    send(Msg::Refresh);
}

/// Same as set_launcher_menu, with the profile that is active right now (read from disk).
pub fn refresh_menu_presence() {
    let st = settings();
    let cfg = st.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let gdd = st.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let state = crate::profiles::list_profiles(&cfg, &gdd);
    let active = state
        .active_profile_id
        .as_ref()
        .and_then(|id| state.profiles.iter().find(|p| &p.id == id))
        .map(|p| (p.name.clone(), p.version.clone()));
    set_launcher_menu(active);
}

/// "Playing Minecraft <version> (<Loader>)" (setPlayingGamePresence).
pub fn set_playing(profile_name: &str, version: &str, loader: &str, username: &str) {
    let loader_name = if loader.trim().is_empty() { "Vanilla".to_string() } else { capitalize(loader) };
    if let Ok(mut s) = SHARED.lock() {
        s.base_details = format!("Playing Minecraft {version} ({loader_name})");
        s.base_state = Some(format!("Profile: {profile_name} • {username}"));
        s.base_start = now_secs();
    }
    send(Msg::Refresh);
}

/// Re-reads the local servers (status / players / public address) and updates the combined hosting presence.
pub fn request_server_sync() {
    send(Msg::SyncServers);
}

/// Applies the Discord on/off switch from Settings right away (Node: applyDiscordSetting).
pub fn apply_enabled_change() {
    if rpc_enabled() {
        start();
        refresh_menu_presence();
        request_server_sync();
    } else {
        send(Msg::Refresh); // the worker sees "disabled", clears the presence and closes the pipe
    }
}

pub fn get_status() -> DiscordStatus {
    let enabled = rpc_enabled();
    let (connected, user, err) = match SHARED.lock() {
        Ok(s) => (s.connected, s.user.clone(), s.last_error.clone()),
        Err(_) => (false, None, None),
    };
    let status_text = if !enabled {
        "Disabled in Settings".to_string()
    } else if connected {
        match &user {
            Some(u) => format!("Connected to Discord as @{u} (Live)"),
            None => "Connected to Discord Desktop (Live)".to_string(),
        }
    } else if let Some(e) = err {
        format!("Discord rejected the connection: {e}")
    } else {
        "Standby (Open Discord Desktop to broadcast)".to_string()
    };
    DiscordStatus {
        enabled,
        connected,
        connected_user: user,
        client_id: DISCORD_CLIENT_ID.to_string(),
        status_text,
    }
}

// ---------------------------------------------------------------------------------------------
// activity building (= _rebuildEffectiveActivity + _sendCurrentActivity)
// ---------------------------------------------------------------------------------------------

fn build_activity() -> Value {
    let default_state = status_text_setting();
    let s = match SHARED.lock() {
        Ok(s) => s,
        Err(_) => return Value::Null,
    };

    let hosting = s
        .server
        .as_ref()
        .filter(|srv| srv.status == "online" || srv.status == "starting");

    let (details, state, start) = if let Some(srv) = hosting {
        let loader = capitalize(if srv.loader.is_empty() { "server" } else { srv.loader.as_str() });
        let max = if srv.max_players == 0 { 20 } else { srv.max_players };
        let status_part = if srv.status == "starting" {
            "Starting Server...".to_string()
        } else {
            format!("{}/{} Players Online", srv.players, max)
        };
        let addr_part = srv.public_address.as_ref().map(|a| format!(" • {a}")).unwrap_or_default();
        let is_playing = s.base_details.starts_with("Playing Minecraft");
        let details = if is_playing {
            format!("{} | Hosting: {}", s.base_details, srv.name)
        } else {
            format!("Hosting: {} ({} {})", srv.name, loader, srv.version)
        };
        let start = srv.started_at_ms.map(|ms| ms / 1000).unwrap_or_else(session_start);
        (details, format!("{status_part}{addr_part}"), start)
    } else {
        let details = if s.base_details.is_empty() { "In Launcher Menu".to_string() } else { s.base_details.clone() };
        let state = s.base_state.clone().unwrap_or_else(|| default_state.clone());
        let start = if s.base_start == 0 { session_start() } else { s.base_start };
        (details, state, start)
    };

    let mut activity = json!({
        "details": details,
        "state": if state.is_empty() { default_state } else { state },
        "timestamps": { "start": start },
        "instance": false
    });
    if !s.retry_without_assets {
        activity["assets"] = json!({
            "large_image": DISCORD_LARGE_IMAGE,
            "large_text": "CRYOX CLIENT — Windows Minecraft Launcher",
            "small_image": DISCORD_SMALL_IMAGE,
            "small_text": if hosting.is_some() { "Hosting CRYOX Server" } else { "CRYOX Runtime" }
        });
    }
    activity
}

/// syncServerDiscordPresence: the first online / starting local server (with its public tunnel address), or none.
fn refresh_server_info() {
    let st = settings();
    let gdd = st.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let servers = crate::servers::list_servers(&gdd);
    let active = servers.into_iter().find(|s| s.status == "online" || s.status == "starting");

    let info = active.map(|srv| {
        let address = crate::playit::get_state()
            .lock()
            .ok()
            .and_then(|p| p.tunnels.get(&srv.meta.id).map(|t| t.java.display.clone()))
            .filter(|d| !d.is_empty());
        ServerInfo {
            name: srv.meta.name.clone(),
            version: srv.meta.version.clone(),
            loader: srv.meta.loader.clone(),
            status: srv.status.clone(),
            players: srv.players.len(),
            max_players: srv.max_players,
            public_address: address,
            started_at_ms: srv.started_at,
        }
    });
    if let Ok(mut s) = SHARED.lock() {
        s.server = info;
    }
}

fn hosting_active() -> bool {
    SHARED.lock().map(|s| s.server.is_some()).unwrap_or(false)
}

// ---------------------------------------------------------------------------------------------
// worker + IPC
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "windows")]
type Pipe = std::fs::File;
#[cfg(not(target_os = "windows"))]
type Pipe = std::fs::File; // never constructed: Discord IPC is only implemented for Windows

fn worker(rx: Receiver<Msg>) {
    let mut pipe: Option<Pipe> = None;
    loop {
        match rx.recv_timeout(Duration::from_secs(RECONNECT_SECS)) {
            Ok(Msg::SyncServers) => refresh_server_info(),
            Ok(Msg::Refresh) => {}
            Err(RecvTimeoutError::Timeout) => {
                // while hosting, the tunnel address / player list can change without an event: look again
                if hosting_active() {
                    refresh_server_info();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // coalesce a burst of messages into one update
        let mut resync = false;
        while let Ok(m) = rx.try_recv() {
            if matches!(m, Msg::SyncServers) {
                resync = true;
            }
        }
        if resync {
            refresh_server_info();
        }

        if !rpc_enabled() {
            if let Some(mut p) = pipe.take() {
                clear_and_close(&mut p); // Discord removes the presence at once
            }
            set_connected(false, None);
            continue;
        }

        if pipe.is_none() {
            pipe = connect();
        }
        if pipe.is_some() {
            let ok = push_activity(pipe.as_mut().unwrap());
            if !ok {
                // Discord closed / restarted: reconnect right away (and every 12 s while it stays closed)
                set_connected(false, None);
                pipe = connect();
                if let Some(p) = pipe.as_mut() {
                    let _ = push_activity(p);
                }
            }
        }
    }
}

fn set_connected(connected: bool, user: Option<String>) {
    if let Ok(mut s) = SHARED.lock() {
        s.connected = connected;
        s.user = if connected { user } else { None };
    }
}

fn set_error(msg: Option<String>) {
    if let Ok(mut s) = SHARED.lock() {
        s.last_error = msg;
    }
}

#[cfg(target_os = "windows")]
fn write_frame(pipe: &mut Pipe, op: i32, payload: &Value) -> std::io::Result<()> {
    use std::io::Write;
    let body = payload.to_string().into_bytes();
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as i32).to_le_bytes());
    buf.extend_from_slice(&body);
    pipe.write_all(&buf)?;
    pipe.flush()
}

#[cfg(target_os = "windows")]
fn read_frame(pipe: &mut Pipe) -> std::io::Result<(i32, Value)> {
    use std::io::Read;
    let mut hdr = [0u8; 8];
    pipe.read_exact(&mut hdr)?;
    let op = i32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
    let len = i32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
    if !(0..=(1 << 20)).contains(&len) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad frame length"));
    }
    let mut body = vec![0u8; len as usize];
    pipe.read_exact(&mut body)?;
    let v = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    Ok((op, v))
}

fn nonce() -> String {
    format!("{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}

/// Tries discord-ipc-0..9, does the handshake and waits for READY (the Discord user comes with it).
#[cfg(target_os = "windows")]
fn connect() -> Option<Pipe> {
    use std::fs::OpenOptions;
    for i in 0..10 {
        let name = format!(r"\\.\pipe\discord-ipc-{}", i);
        let mut pipe = match OpenOptions::new().read(true).write(true).open(&name) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let hs = json!({ "v": 1, "client_id": DISCORD_CLIENT_ID });
        if write_frame(&mut pipe, 0, &hs).is_err() {
            continue;
        }
        loop {
            match read_frame(&mut pipe) {
                Ok((3, payload)) => {
                    let _ = write_frame(&mut pipe, 4, &payload);
                }
                Ok((2, payload)) => {
                    let msg = payload.get("message").and_then(|m| m.as_str()).unwrap_or("Discord closed the connection");
                    set_error(Some(msg.to_string()));
                    break;
                }
                Ok((1, payload)) => {
                    if payload.get("evt").and_then(|e| e.as_str()) == Some("READY") {
                        let user = payload
                            .get("data")
                            .and_then(|d| d.get("user"))
                            .and_then(|u| u.get("username"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("User")
                            .to_string();
                        set_connected(true, Some(user));
                        set_error(None);
                        return Some(pipe);
                    }
                    if payload.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                        let msg = payload
                            .get("data")
                            .and_then(|d| d.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown Discord error");
                        set_error(Some(msg.to_string()));
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }
    None
}

/// Sends the current activity. Returns false when the pipe is dead.
#[cfg(target_os = "windows")]
fn push_activity(pipe: &mut Pipe) -> bool {
    for _round in 0..2 {
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": build_activity() },
            "nonce": nonce()
        });
        if write_frame(pipe, 1, &payload).is_err() {
            return false;
        }
        // Discord answers every command: read it (also keeps the pipe buffer empty)
        let mut resend = false;
        loop {
            match read_frame(pipe) {
                Ok((3, p)) => {
                    let _ = write_frame(pipe, 4, &p);
                }
                Ok((2, p)) => {
                    let msg = p.get("message").and_then(|m| m.as_str()).unwrap_or("Discord closed the connection");
                    set_error(Some(msg.to_string()));
                    return false;
                }
                Ok((_, p)) => {
                    if p.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                        let msg = p
                            .get("data")
                            .and_then(|d| d.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown Discord error")
                            .to_string();
                        set_error(Some(msg.clone()));
                        // an image asset Discord does not know: send the presence again without images
                        if msg.to_lowercase().contains("asset") {
                            if let Ok(mut s) = SHARED.lock() {
                                if !s.retry_without_assets {
                                    s.retry_without_assets = true;
                                    resend = true;
                                }
                            }
                        }
                    } else {
                        set_error(None);
                    }
                    break;
                }
                Err(_) => return false,
            }
        }
        if !resend {
            return true;
        }
    }
    true
}

#[cfg(target_os = "windows")]
fn clear_and_close(pipe: &mut Pipe) {
    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": Value::Null },
        "nonce": nonce()
    });
    let _ = write_frame(pipe, 1, &payload);
    let _ = write_frame(pipe, 2, &json!({}));
}

#[cfg(not(target_os = "windows"))]
fn connect() -> Option<Pipe> {
    None
}
#[cfg(not(target_os = "windows"))]
fn push_activity(_pipe: &mut Pipe) -> bool {
    true
}
#[cfg(not(target_os = "windows"))]
fn clear_and_close(_pipe: &mut Pipe) {}
