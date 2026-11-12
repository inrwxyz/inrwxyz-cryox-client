//! CRYOX CLIENT — Tauri shell.
//!
//! The launcher's original backend (main.js + src/main/*) is Node code. It runs unchanged in a Node
//! "sidecar" process (`inex-node.exe sidecar/index.js`); this shell
//!   * shows the window (WebView2) with the existing HTML/CSS/JS UI,
//!   * forwards `window.inexAPI.*` calls from the UI to the sidecar (command `inex_invoke`),
//!   * forwards sidecar events (`event:*`) to the UI (Tauri event `inex-event`),
//!   * performs native things the sidecar asks for (dialogs, open URL/folder, quit).
//!
//! Protocol (newline-delimited JSON over the sidecar's stdin/stdout) is documented in sidecar/electron-shim.js.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub mod accounts;
pub mod code_access;
pub mod discord;
pub mod dpapi;
pub mod hud;
pub mod installer;
pub mod java;
pub mod launcher;
pub mod loaders;
pub mod content_watch;
pub mod modrinth;
pub mod modrinth_ext;
pub mod msauth;
pub mod perf;
pub mod playit;
pub mod playit_ext;
pub mod profiles;
pub mod servers;
pub mod settings;
pub mod system;
pub mod versions;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use tauri::{WebviewUrl, WebviewWindowBuilder}; // [ms-login-fix]

type Reply = Result<Value, String>;

struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    /// set once the app is shutting down (window closed / quit requested)
    closing: AtomicBool,
}

fn shared_http_client() -> &'static reqwest::Client {
    static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Cryox-Client-Launcher/1.0.0")
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub async fn restart_server_by_id(
    app: AppHandle,
    id: &str,
    settings: &Value,
) -> Result<Value, String> {
    let _ = servers::stop_server(id);
    for _ in 0..120 {
        match servers::runtime_status(id).as_deref() {
            None | Some("offline") => break,
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
    let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
    let java_dir = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".");
    servers::start_server(app, game_data_dir, config_dir, java_dir, id)
        .await
        .map(|s| json!(s))
}

fn emit_access_state(app: &AppHandle) {
    let _ = app.emit("inex-event", json!({
        "channel": "event:access-state",
        "data": code_access::get_status()
    }));
}

impl Sidecar {
    fn new() -> Self {
        Sidecar {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closing: AtomicBool::new(false),
        }
    }

    fn write(&self, msg: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "Backend lock poisoned".to_string())?;
        let stdin = guard.as_mut().ok_or_else(|| "The backend is not running.".to_string())?;
        let mut line = msg.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Could not talk to the backend: {e}"))
    }

    fn kill(&self) {
        // closing stdin makes the sidecar exit by itself; kill is the safety net
        if let Ok(mut s) = self.stdin.lock() {
            s.take();
        }
        if let Ok(mut c) = self.child.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            c.take();
        }
    }

    fn fail_all_pending(&self, reason: &str) {
        if let Ok(mut p) = self.pending.lock() {
            for (_, tx) in p.drain() {
                let _ = tx.send(Err(reason.to_string()));
            }
        }
    }
}

/// UI -> backend. Mirrors ipcRenderer.invoke(channel, ...args).
#[tauri::command]
async fn inex_invoke(
    app: AppHandle,
    state: tauri::State<'_, Arc<Sidecar>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    // Native Rust fast-paths
    match channel.as_str() {
        "get-bootstrap-state" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let java_dir_str = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".");

            let profiles_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
            let accounts_state = accounts::list_accounts(config_dir_str);
            let java_runtimes = java::detect_installed_runtimes(&PathBuf::from(java_dir_str));
            let show_snaps = settings.get("showSnapshots").and_then(|b| b.as_bool()).unwrap_or(false);
            let versions_data = versions::list_versions(&PathBuf::from(config_dir_str), show_snaps, false).await;
            let discord_status = discord::get_status();

            return Ok(json!({
                "settings": settings,
                "profilesState": profiles_state,
                "accountsState": accounts_state,
                "javaRuntimes": java_runtimes,
                "versionsData": versions_data,
                "runningProfileIds": launcher::get_running_profiles(),
                "discordStatus": discord_status
            }));
        }
        "servers:memory" => {
            return Ok(system::get_system_memory());
        }
        "settings:get" => {
            let mgr = settings::SettingsManager::new();
            return Ok(mgr.get_settings());
        }
        "settings:update" => {
            if let Some(partial) = args.first() {
                let mgr = settings::SettingsManager::new();
                let before = discord::rpc_enabled();
                let res = mgr.update_settings(partial);
                if before != discord::rpc_enabled() {
                    discord::apply_enabled_change(); // Discord on/off switch applies right away
                }
                let _ = state.write(&json!({ "t": "invoke", "id": 0, "channel": "settings:update", "args": args }));
                return Ok(res);
            }
        }
        "settings:reset" => {
            let mgr = settings::SettingsManager::new();
            let res = mgr.reset_settings();
            let _ = state.write(&json!({ "t": "invoke", "id": 0, "channel": "settings:reset", "args": args }));
            return Ok(res);
        }
        "versions:list" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let config_dir = PathBuf::from(config_dir_str);
            let opts = args.first();
            let include_snapshots = opts.and_then(|a| a.get("includeSnapshots")).and_then(|b| b.as_bool()).unwrap_or(false)
                || settings.get("showSnapshots").and_then(|b| b.as_bool()).unwrap_or(false);
            let force_refresh = opts.and_then(|a| a.get("forceRefresh")).and_then(|b| b.as_bool()).unwrap_or(false);
            return Ok(versions::list_versions(&config_dir, include_snapshots, force_refresh).await);
        }
        "loaders:supported" => {
            let mc_version = args.first().and_then(|v| v.as_str()).unwrap_or("1.21.4");
            let supported = loaders::get_supported_loaders(shared_http_client(), mc_version).await;
            return Ok(json!(supported));
        }
        "profiles:list" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(json!(profiles::list_profiles(config_dir_str, game_data_dir_str)));
        }
        "profiles:create" => {
            if let Some(payload) = args.first().cloned() {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let max_ram = settings.get("maxRamMB").and_then(|v| v.as_u64()).unwrap_or(16384) as u32;
                let def_ram = settings.get("defaultRamMB").and_then(|v| v.as_u64()).unwrap_or(4096) as u32;
                let created = profiles::create_profile(config_dir_str, game_data_dir_str, payload, max_ram, def_ram)?;
                // Performance Pack installs in the background so creating a profile stays instant.
                let pp = created.get("profile").cloned().unwrap_or(Value::Null);
                if pp.get("perfPackEnabled").and_then(|b| b.as_bool()).unwrap_or(false) {
                    let pid = pp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let gdir = pp.get("gameDir").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let mcv = pp.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let ldr = pp.get("loader").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let app_bg = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = modrinth_ext::install_performance_pack(&app_bg, &pid, &gdir, &mcv, &ldr, None).await;
                    });
                }
                return Ok(created);
            }
        }
        "profiles:update" => {
            if let (Some(id_val), Some(updates)) = (args.get(0), args.get(1)) {
                if let Some(id) = id_val.as_str() {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                    let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    let max_ram = settings.get("maxRamMB").and_then(|v| v.as_u64()).unwrap_or(16384) as u32;
                    return profiles::update_profile(config_dir_str, game_data_dir_str, id, updates.clone(), max_ram);
                }
            }
        }
        "profiles:delete" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return profiles::delete_profile(config_dir_str, game_data_dir_str, id).map(|s| json!(s));
            }
        }
        "profiles:setActive" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let res = profiles::set_active_profile(config_dir_str, game_data_dir_str, id).map(|s| json!(s));
                discord::refresh_menu_presence();
                return res;
            }
        }
        "profiles:openFolder" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let p_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
                if let Some(p) = p_state.profiles.iter().find(|p| p.id == id) {
                    profiles::open_profile_folder(&p.game_dir)?;
                    return Ok(json!({ "success": true }));
                }
            }
        }
        "accounts:list" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(json!(accounts::list_accounts(config_dir_str)));
        }
        "accounts:setActive" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                return accounts::set_active_account(config_dir_str, id).map(|res| json!(res));
            }
        }
        "accounts:addLocal" => {
            if let Some(name) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                return accounts::add_local_account(config_dir_str, name).map(|res| json!(res));
            }
        }
        "accounts:remove" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                return accounts::remove_account(config_dir_str, id).map(|res| json!(res));
            }
        }
        "skins:addSlot" => {
            let name = args.first().and_then(|v| v.as_str());
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return accounts::add_skin_slot(config_dir_str, name).map(|res| json!(res));
        }
        "skins:updateSlot" => {
            if let (Some(slot_id_val), Some(patch)) = (args.get(0), args.get(1)) {
                if let Some(slot_id) = slot_id_val.as_str() {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return accounts::update_skin_slot(config_dir_str, slot_id, patch.clone()).map(|res| json!(res));
                }
            }
        }
        "skins:deleteSlot" => {
            if let Some(slot_id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                return accounts::delete_skin_slot(config_dir_str, slot_id).map(|res| json!(res));
            }
        }
        "content:search" => {
            let client = shared_http_client().clone();
            let empty = json!({});
            let opts = args.first().unwrap_or(&empty);
            let pid = opts.get("profileId").and_then(|v| v.as_str()).unwrap_or("");
            let ptype = opts.get("projectType").and_then(|v| v.as_str()).unwrap_or("mod");
            // the search and the "what is already in this profile" scan run side by side
            return Ok(match modrinth_ext::find_profile(pid) {
                Ok(profile) => {
                    // like x_client: results are ALWAYS locked to the profile's Minecraft version (+ loader for mods / modpacks)
                    let mod_like = ptype == "mod" || ptype == "modpack";
                    if mod_like && profile.loader == "vanilla" {
                        return Ok(json!({
                            "hits": [], "totalHits": 0, "offset": 0,
                            "limit": opts.get("limit").cloned().unwrap_or(json!(20)),
                            "vanillaLocked": true,
                            "message": "Vanilla profiles cannot install mods or modpacks as per official vanilla rules.",
                            "profileFilter": { "version": profile.version, "loader": "vanilla" }
                        }));
                    }
                    let mut locked = opts.clone();
                    let empty_field = |o: &Value, k: &str| o.get(k).and_then(|v| v.as_str()).map(|t| t.trim().is_empty()).unwrap_or(true);
                    if empty_field(&locked, "version") {
                        locked["version"] = json!(profile.version);
                    }
                    if mod_like && empty_field(&locked, "loader") {
                        locked["loader"] = json!(profile.loader);
                    }
                    let (mut res, _) = tokio::join!(
                        modrinth::search_projects(&client, &locked),
                        modrinth_ext::sync_installed_content(&profile, ptype)
                    );
                    res["profileFilter"] = json!({ "version": profile.version, "loader": profile.loader });
                    modrinth::mark_installed(&mut res, &profile.game_dir, ptype);
                    res
                }
                Err(_) => modrinth::search_projects(&client, opts).await,
            });
        }
        "content:syncInstalled" => {
            let pid = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let ptype = args.get(1).and_then(|v| v.as_str()).unwrap_or("mod");
            let profile = modrinth_ext::find_profile(pid)?;
            modrinth_ext::sync_installed_content(&profile, ptype).await;
            let (project_ids, local_ids) = modrinth::installed_sets(&profile.game_dir, ptype);
            return Ok(json!({
                "items": modrinth::list_installed_content(&profile.game_dir, ptype),
                "projectIds": project_ids,
                "localIds": local_ids
            }));
        }
        "content:watch" => {
            let pid = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let profile = modrinth_ext::find_profile(pid)?;
            content_watch::watch_profile(app.clone(), profile.id.clone(), profile.game_dir.clone())?;
            return Ok(json!({ "watching": true }));
        }
        "content:listInstalled" => {
            let profile_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let p_type = args.get(1).and_then(|v| v.as_str()).unwrap_or("mod");
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let p_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
            if let Some(p) = p_state.profiles.iter().find(|p| p.id == profile_id) {
                return Ok(json!(modrinth::list_installed_content(&p.game_dir, p_type)));
            }
            return Ok(json!([]));
        }
        "content:toggle" => {
            if let Some(opts) = args.first() {
                let profile_id = opts.get("profileId").and_then(|v| v.as_str()).unwrap_or("");
                let file_name = opts.get("fileName").and_then(|v| v.as_str()).unwrap_or("");
                let p_type = opts.get("projectType").and_then(|v| v.as_str()).unwrap_or("mod");
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let p_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
                if let Some(p) = p_state.profiles.iter().find(|p| p.id == profile_id) {
                    return modrinth::toggle_installed_content(&p.game_dir, file_name, p_type);
                }
            }
        }
        "content:remove" => {
            if let Some(opts) = args.first() {
                let profile_id = opts.get("profileId").and_then(|v| v.as_str()).unwrap_or("");
                let file_name = opts.get("fileName").and_then(|v| v.as_str()).unwrap_or("");
                let p_type = opts.get("projectType").and_then(|v| v.as_str()).unwrap_or("mod");
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let p_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
                if let Some(p) = p_state.profiles.iter().find(|p| p.id == profile_id) {
                    return modrinth::remove_installed_content(&p.game_dir, file_name, p_type);
                }
            }
        }
        "clipboard:writeText" => {
            let text = args.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            write_clipboard_text(&text)?;
            return Ok(Value::Null);
        }
        "shell:openExternal" => {
            let clean = args.first().and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let lower = clean.to_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") {
                app.opener()
                    .open_url(clean.as_str(), None::<&str>)
                    .map_err(|e| e.to_string())?;
                return Ok(json!({ "opened": true }));
            }
            return Err("Invalid external URL.".to_string());
        }
        "discord:status" => {
            return Ok(json!(discord::get_status()));
        }
        "shell:openDir" => {
            if let Some(key) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let install_dir = settings.get("installDir").and_then(|s| s.as_str()).unwrap_or(".");
                let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let java_dir = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".");

                let hud_mods = PathBuf::from(config_dir).join("hud-mods").to_string_lossy().to_string();
                let target = match key {
                    "gameDataDir" => game_data_dir,
                    "installDir" => install_dir,
                    "configDir" => config_dir,
                    "javaDir" => java_dir,
                    "hudModsDir" => &hud_mods,
                    _ => game_data_dir,
                };
                let _ = std::fs::create_dir_all(target);
                let _ = Command::new("explorer").arg(target).spawn();
                return Ok(json!({ "opened": true }));
            }
        }
        "profile:launch" => {
            let profile_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let join_server = args.get(1).and_then(|v| {
                if let Some(s) = v.as_str() {
                    Some(s.to_string())
                } else if let Some(obj) = v.as_object() {
                    obj.get("joinServer").and_then(|s| s.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            });
            return launcher::launch_profile(app, profile_id, join_server).await;
        }
        "profile:stop" => {
            let profile_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            return launcher::stop_game(profile_id);
        }
        "hud:listJars" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let profile_id = args.first().and_then(|v| v.as_str());
            let p_state = profiles::list_profiles(config_dir_str, game_data_dir_str);
            let active = if let Some(id) = profile_id {
                p_state.profiles.into_iter().find(|p| p.id == id)
            } else {
                p_state.profiles.into_iter().next()
            };
            let (loader, ver) = match active {
                Some(ref p) => (Some(p.loader.as_str()), Some(p.version.as_str())),
                None => (None, None),
            };
            return Ok(json!({ "jars": hud::list_hud_jars(config_dir_str, loader, ver) }));
        }
        "hud:uploadJar" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let src: Option<PathBuf> = if let Some(s) = args.first().and_then(|v| v.as_str()) {
                Some(PathBuf::from(s))
            } else {
                app.dialog()
                    .file()
                    .set_title("Select HUD Mod Jar")
                    .add_filter("Minecraft Mod JAR", &["jar"])
                    .blocking_pick_file()
                    .and_then(|fp| fp.into_path().ok())
                    .map(clean_path)
            };
            return match src {
                Some(path) => {
                    let res = hud::copy_hud_jar(config_dir_str, &path)?;
                    Ok(json!(res))
                }
                None => Ok(json!({ "canceled": true })),
            };
        }
        "content:checkUpdates" => {
            let pid = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let pt = args.get(1).and_then(|v| v.as_str()).unwrap_or("mod");
            return modrinth_ext::check_content_updates(pid, pt).await;
        }
        "content:update" => {
            let empty = json!({});
            let opts = args.first().unwrap_or(&empty);
            let get = |k: &str| opts.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            return modrinth_ext::update_content(&app, &get("profileId"), &get("projectType"), &get("fileName"), &get("versionId")).await;
        }
        "content:install" => {
            let empty = json!({});
            let opts = args.first().unwrap_or(&empty);
            let pick = |k: &str| opts.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let profile_id = pick("profileId");
            let project_id = pick("projectId");
            if project_id.is_empty() {
                return Err("Missing project id for installation.".to_string());
            }
            let ptype = {
                let t = pick("projectType");
                if t.is_empty() { "mod".to_string() } else { t }
            };
            return modrinth_ext::install_content(
                &app,
                &profile_id,
                &project_id,
                &ptype,
                &pick("title"),
                &pick("author"),
                &pick("iconUrl"),
            )
            .await;
        }
        "servers:list" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(json!(servers::list_servers(game_data_dir)));
        }
        "servers:get" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::get_server(game_data_dir, id).map(|s| json!(s));
            }
        }
        "servers:versions" => {
            let loader = args.first().and_then(|v| v.as_str()).unwrap_or("vanilla");
            return servers::get_versions_for_loader(loader).await.map(|v| json!(v));
        }
        "servers:create" => {
            if let Some(payload) = args.first() {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::create_server(game_data_dir, payload).await.map(|s| json!(s));
            }
        }
        "servers:update" => {
            if let (Some(id_val), Some(updates)) = (args.get(0), args.get(1)) {
                if let Some(id) = id_val.as_str() {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::update_server(game_data_dir, id, updates).map(|s| json!(s));
                }
            }
        }
        "servers:delete" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::delete_server(game_data_dir, id);
            }
        }
        "servers:openFolder" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let dir = servers::get_server_dir(game_data_dir, id);
                let _ = std::process::Command::new("explorer").arg(dir).spawn();
                return Ok(json!({ "opened": true }));
            }
        }
        "servers:start" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
                let java_dir = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::start_server(app, game_data_dir, config_dir, java_dir, id).await.map(|s| json!(s));
            }
        }
        "servers:stop" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                return servers::stop_server(id);
            }
        }
        "servers:kill" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                return servers::kill_server(id);
            }
        }
        "servers:command" => {
            if let (Some(id_val), Some(cmd_val)) = (args.get(0), args.get(1)) {
                if let (Some(id), Some(cmd)) = (id_val.as_str(), cmd_val.as_str()) {
                    return servers::send_command(id, cmd);
                }
            }
        }
        "servers:log" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                return Ok(json!(servers::get_server_log(id)));
            }
        }
        "servers:properties:read" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                let dir = servers::get_server_dir(game_data_dir, id);
                let values = servers::read_properties_values(&dir);
                let defaults = servers::default_properties_template();
                return Ok(json!({ "values": values, "defaults": defaults }));
            }
        }
        "servers:properties:write" => {
            if let (Some(id_val), Some(updates_val)) = (args.get(0), args.get(1)) {
                if let Some(id) = id_val.as_str() {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    let dir = servers::get_server_dir(game_data_dir, id);
                    if let Ok(updates) = serde_json::from_value::<HashMap<String, String>>(updates_val.clone()) {
                        servers::write_properties(&dir, &updates)?;
                        return Ok(json!({ "written": true }));
                    }
                }
            }
        }
        "servers:files:list" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::list_server_files(game_data_dir, id, rel);
            }
        }
        "servers:files:read" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::read_server_file(game_data_dir, id, rel);
            }
        }
        "servers:files:write" => {
            if let (Some(id_val), Some(rel_val), Some(content_val)) = (args.get(0), args.get(1), args.get(2)) {
                if let (Some(id), Some(rel), Some(content)) = (id_val.as_str(), rel_val.as_str(), content_val.as_str()) {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::write_server_file(game_data_dir, id, rel, content);
                }
            }
        }
        "accounts:microsoftUrl" => {
            return Ok(json!(msauth::get_microsoft_login_url()));
        }
        "accounts:microsoftLogin" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let auth_url = msauth::get_microsoft_login_url();
            let res = ms_login_window(&app, &json!({
                "url": auth_url,
                "redirectPrefix": msauth::MS_REDIRECT_URI
            }))?;
            let redirect_url = res.get("url").and_then(|u| u.as_str()).ok_or_else(|| "Microsoft sign-in was cancelled.".to_string())?;
            return msauth::complete_microsoft_login(redirect_url, config_dir_str).await;
        }
        "access:status" => {
            return Ok(code_access::get_status());
        }
        "access:create" => {
            let srv_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let exists = servers::get_server(game_data_dir, srv_id).is_ok();
            let was_waiting = code_access::get_status().get("phase").and_then(|p| p.as_str()) == Some("waiting");
            let res = code_access::create_code(srv_id, exists)?;
            if !was_waiting {
                if let Some(code) = res.get("code").and_then(|c| c.as_str()) {
                    let _ = app.emit("inex-event", json!({
                        "channel": "event:p2p-expect",
                        "data": { "code": code, "exp": res.get("exp").cloned().unwrap_or(Value::Null) }
                    }));
                }
            }
            emit_access_state(&app);
            return Ok(res);
        }
        "access:cancel" => {
            let before = code_access::get_status();
            let res = code_access::cancel_code();
            if let Some(code) = before.get("code").and_then(|c| c.as_str()) {
                let _ = app.emit("inex-event", json!({ "channel": "event:p2p-kick", "data": { "code": code } }));
            }
            emit_access_state(&app);
            return Ok(res);
        }
        "access:disconnect" => {
            let sc = code_access::current_session_code();
            let res = code_access::disconnect();
            if let Some(code) = sc {
                let _ = app.emit("inex-event", json!({ "channel": "event:p2p-kick", "data": { "code": code } }));
            }
            emit_access_state(&app);
            return Ok(res);
        }
        "p2p:claim" => {
            let code = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let sid = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let r = code_access::claim(code, sid);
            emit_access_state(&app);
            return r;
        }
        "p2p:hostOpened" => {
            let code = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let r = code_access::host_opened(code);
            emit_access_state(&app);
            return Ok(r);
        }
        "p2p:hostClosed" => {
            let code = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let r = code_access::host_closed(code);
            emit_access_state(&app);
            return Ok(r);
        }
        "p2p:exec" => {
            let code = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let method = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let exec_args = args.get(2).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            return code_access::p2p_exec(&app, code, method, &exec_args, &settings).await;
        }
        "playit:state" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(playit::get_playit_state(config_dir));
        }
        "playit:share" => {
            let srv_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let (port, bedrock_port, tunnel) = servers::tunnel_params(game_data_dir, srv_id);
            return playit_ext::share_any(app.clone(), config_dir.to_string(), srv_id.to_string(), port, bedrock_port, tunnel).await;
        }
        "playit:release" => {
            let srv_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(playit::release_tunnel(app.clone(), config_dir, srv_id));
        }
        "playit:link" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return playit::link_account(app.clone(), config_dir.to_string()).await;
        }
        "playit:cancelLink" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(playit::cancel_link(app.clone(), config_dir));
        }
        "playit:unlink" => {
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            return Ok(playit::unlink(app.clone(), config_dir));
        }
        "playit:manage" => {
            let _ = app.opener().open_url("https://playit.gg/account", None::<&str>);
            return Ok(json!({ "opened": true }));
        }
        "java:status" => {
            let required = args.first().and_then(|v| v.as_u64()).unwrap_or(21) as u32;
            let profile_setting = args.get(1).and_then(|v| v.as_str()).unwrap_or("auto").to_string();
            let settings = settings::SettingsManager::new().get_settings();
            let java_dir = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
            return tauri::async_runtime::spawn_blocking(move || {
                java::describe_java_status(std::path::Path::new(&java_dir), required, &profile_setting)
            })
            .await
            .map_err(|e| e.to_string());
        }
        "java:bundle" => {
            let major = args.first().and_then(|v| v.as_u64()).unwrap_or(21) as u32;
            let mgr = settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let java_dir = settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or(".");
            let client = shared_http_client();
            let app_for_progress = app.clone();
            let progress = move |stage: &str, percent: u32, detail: &str| {
                let _ = app_for_progress.emit(
                    "inex-event",
                    json!({
                        "channel": "event:install-progress",
                        "data": { "stage": stage, "percent": percent, "detail": detail }
                    }),
                );
            };
            let rt = java::bundle_portable_java_with_progress(client, std::path::Path::new(java_dir), major, &progress).await?;
            let runtimes = java::detect_installed_runtimes(std::path::Path::new(java_dir));
            return Ok(json!({ "runtimes": runtimes, "runtime": rt }));
        }
        "installation:cancel" => {
            let profile_id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            return Ok(installer::cancel_installation(profile_id));
        }
        "window:minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            return Ok(Value::Null);
        }
        "window:maximize" => {
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(is_max) = w.is_maximized() {
                    if is_max {
                        let _ = w.unmaximize();
                    } else {
                        let _ = w.maximize();
                    }
                } else {
                    let _ = w.maximize();
                }
            }
            return Ok(Value::Null);
        }
        "window:close" => {
            graceful_shutdown(app.clone()).await;
            return Ok(Value::Null);
        }
        "dialog:selectDirectory" => {
            let default_dir = args.first().and_then(Value::as_str).map(|s| s.to_string());
            let app_c = app.clone();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                let mut b = app_c.dialog().file();
                if let Some(d) = default_dir {
                    let p = PathBuf::from(d);
                    if p.is_dir() {
                        b = b.set_directory(p);
                    }
                }
                b.blocking_pick_folder()
            })
            .await
            .map_err(|e| e.to_string())?;
            match picked {
                Some(fp) => {
                    if let Ok(p) = fp.into_path() {
                        let picked = clean_path(p).to_string_lossy().to_string();
                        // x_client contract: { canceled, path }  (renderer reads `res.path`); filePaths kept for compatibility
                        return Ok(json!({ "canceled": false, "path": picked, "filePaths": [picked] }));
                    }
                    return Ok(json!({ "canceled": true, "path": Value::Null, "filePaths": [] }));
                }
                None => return Ok(json!({ "canceled": true, "path": Value::Null, "filePaths": [] })),
            }
        }
        "servers:restart" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                return restart_server_by_id(app.clone(), id, &settings).await;
            }
        }
        "servers:stats" => {
            let id = args.first().and_then(|v| v.as_str()).unwrap_or("");
            return Ok(json!(servers::get_server_stats(id)));
        }
        "servers:players:list" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return Ok(servers::get_player_lists(game_data_dir, id));
            }
        }
        "servers:players:action" => {
            if let (Some(id_val), Some(act_val), Some(name_val)) = (args.get(0), args.get(1), args.get(2)) {
                if let (Some(id), Some(act), Some(name)) = (id_val.as_str(), act_val.as_str(), name_val.as_str()) {
                    let reason = args.get(3).and_then(|v| v.as_str());
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::player_action(game_data_dir, id, act, name, reason);
                }
            }
        }
        "servers:addons:list" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return Ok(json!(servers::list_server_addons(game_data_dir, id)));
            }
        }
        "servers:addons:search" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let empty = json!({});
                let opts = args.get(1).unwrap_or(&empty);
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return Ok(servers::search_server_addons(shared_http_client(), game_data_dir, id, opts).await);
            }
        }
        "servers:addons:install" => {
            if let (Some(id_val), Some(opts)) = (args.get(0), args.get(1)) {
                if let Some(id) = id_val.as_str() {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::install_server_addon(shared_http_client(), game_data_dir, id, opts).await;
                }
            }
        }
        "servers:addons:toggle" => {
            if let (Some(id_val), Some(file_val)) = (args.get(0), args.get(1)) {
                if let (Some(id), Some(file)) = (id_val.as_str(), file_val.as_str()) {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::toggle_server_addon(game_data_dir, id, file);
                }
            }
        }
        "servers:addons:remove" => {
            if let (Some(id_val), Some(file_val)) = (args.get(0), args.get(1)) {
                if let (Some(id), Some(file)) = (id_val.as_str(), file_val.as_str()) {
                    let mgr = settings::SettingsManager::new();
                    let settings = mgr.get_settings();
                    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                    return servers::remove_server_addon(game_data_dir, id, file);
                }
            }
        }
        "servers:network" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return Ok(servers::get_server_network(game_data_dir, id));
            }
        }
        "servers:bedrock:install" => {
            if let Some(id) = args.first().and_then(|v| v.as_str()) {
                let mgr = settings::SettingsManager::new();
                let settings = mgr.get_settings();
                let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
                return servers::install_bedrock_support(shared_http_client(), game_data_dir, id).await;
            }
        }
        _ => {}
    }

    if state.stdin.lock().map(|g| g.is_none()).unwrap_or(true) {
        eprintln!("[CRYOX Native] Request not handled (bad arguments or item not found): {}", channel);
        // x_client returned nothing for "open folder" style calls and threw for everything else.
        if matches!(channel.as_str(), "profiles:openFolder" | "servers:openFolder" | "shell:openDir") {
            return Ok(Value::Null);
        }
        return Err(format!("Invalid request or item not found ({channel})."));
    }

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel::<Reply>();
    state
        .pending
        .lock()
        .map_err(|_| "Backend lock poisoned".to_string())?
        .insert(id, tx);

    let msg = json!({ "t": "invoke", "id": id, "channel": channel, "args": args });
    if let Err(e) = state.write(&msg) {
        if let Ok(mut p) = state.pending.lock() {
            p.remove(&id);
        }
        return Err(e);
    }
    match rx.await {
        Ok(reply) => reply,
        Err(_) => Err("The backend stopped unexpectedly.".to_string()),
    }
}

// ---------------------------------------------------------------------------------------------
// sidecar process
// ---------------------------------------------------------------------------------------------

/// Puts text on the Windows clipboard (x_client: electron clipboard.writeText). Uses `clip.exe` via stdin, UTF-16 safe.
fn write_clipboard_text(text: &str) -> Result<(), String> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t",
    ]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not access the clipboard: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("Could not write to the clipboard: {e}"))?;
    }
    let _ = child.wait();
    Ok(())
}

/// Windows' `\\?\` verbatim prefix confuses Node and Java; strip it.
fn clean_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// Folder that contains main.js + sidecar/ + src/main/ (the Node backend).
#[allow(dead_code)]
fn locate_backend(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // `tauri dev`: run the backend straight from the repo, no copy needed
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("backend"));
    }
    for c in candidates {
        if c.join("main.js").is_file() && c.join("sidecar").join("index.js").is_file() {
            return Ok(clean_path(c));
        }
    }
    Err("Backend files (main.js / sidecar) were not found next to the launcher.".to_string())
}

/// The bundled Node runtime (installed next to the launcher as inex-node.exe); falls back to `node` from PATH in dev.
fn locate_node() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["inex-node.exe", "inex-node"] {
                let p = dir.join(name);
                if p.is_file() {
                    return p;
                }
            }
        }
    }
    PathBuf::from("node")
}

fn start_backend(_app: AppHandle, _sc: Arc<Sidecar>) -> Result<(), String> {
    // CRYOX CLIENT is 100% native Rust. Node sidecar is no longer required.
    Ok(())
}

#[allow(dead_code)]
fn start_backend_legacy(app: AppHandle, sc: Arc<Sidecar>) -> Result<(), String> {
    let backend = locate_backend(&app)?;
    let node = locate_node();

    let mut cmd = Command::new(&node);
    cmd.arg(backend.join("sidecar").join("index.js"))
        .current_dir(&backend)
        .env("INEX_PACKAGED", if cfg!(debug_assertions) { "0" } else { "1" })
        .env("INEX_VERSION", app.package_info().version.to_string())
        .env("INEX_RESOURCES", &backend)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the backend ({}): {e}", node.display()))?;
    let stdin = child.stdin.take().ok_or("backend stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("backend stdout unavailable")?;
    let stderr = child.stderr.take();

    *sc.stdin.lock().map_err(|_| "lock poisoned")? = Some(stdin);
    *sc.child.lock().map_err(|_| "lock poisoned")? = Some(child);

    // backend diagnostics -> <app log dir>/sidecar.log
    if let Some(mut err) = stderr {
        let log_path = app.path().app_log_dir().ok().map(|d| d.join("sidecar.log"));
        std::thread::spawn(move || {
            if let Some(path) = log_path {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Ok(mut f) = std::fs::File::create(&path) {
                    let _ = std::io::copy(&mut err, &mut f);
                    return;
                }
            }
            let _ = std::io::copy(&mut err, &mut std::io::sink());
        });
    }

    start_reader(app, sc, stdout);
    Ok(())
}

fn start_reader(app: AppHandle, sc: Arc<Sidecar>, stdout: ChildStdout) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match msg.get("t").and_then(Value::as_str) {
                Some("res") => {
                    let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                    let tx = sc.pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(tx) = tx {
                        let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        let reply = if ok {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(msg
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown backend error")
                                .to_string())
                        };
                        let _ = tx.send(reply);
                    }
                }
                Some("event") => {
                    let payload = json!({
                        "channel": msg.get("channel").cloned().unwrap_or(Value::Null),
                        "data": msg.get("data").cloned().unwrap_or(Value::Null),
                    });
                    let _ = app.emit("inex-event", payload);
                }
                Some("host") => {
                    // dialogs block, so every host call gets its own thread
                    let app = app.clone();
                    let sc = sc.clone();
                    std::thread::spawn(move || handle_host(app, sc, msg));
                }
                _ => {}
            }
        }
        // stdout closed => backend is gone
        sc.fail_all_pending("The backend stopped unexpectedly.");
    });
}

// ---------------------------------------------------------------------------------------------
// native things the backend asks for (Electron's dialog / shell / app / BrowserWindow)
// ---------------------------------------------------------------------------------------------

fn handle_host(app: AppHandle, sc: Arc<Sidecar>, msg: Value) {
    let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let args: Vec<Value> = msg
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let reply = match host_call(&app, &sc, &method, &args) {
        Ok(v) => json!({ "t": "hostres", "id": id, "ok": true, "result": v }),
        Err(e) => json!({ "t": "hostres", "id": id, "ok": false, "error": e }),
    };
    let _ = sc.write(&reply);
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

fn host_call(app: &AppHandle, sc: &Arc<Sidecar>, method: &str, args: &[Value]) -> Reply {
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    match method {
        "quit" => {
            sc.closing.store(true, Ordering::SeqCst);
            app.exit(0);
            Ok(Value::Null)
        }
        "window.minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            Ok(Value::Null)
        }
        "window.maximize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.maximize();
            }
            Ok(Value::Null)
        }
        "window.unmaximize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unmaximize();
            }
            Ok(Value::Null)
        }
        "shell.openExternal" => {
            let url = a0.as_str().ok_or_else(|| "Invalid URL.".to_string())?;
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("Invalid external URL.".to_string());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "shell.openPath" => {
            let path = a0.as_str().ok_or_else(|| "Invalid path.".to_string())?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "dialog.open" => {
            let mut b = app.dialog().file();
            if let Some(t) = a0.get("title").and_then(Value::as_str) {
                b = b.set_title(t);
            }
            if let Some(d) = a0.get("defaultPath").and_then(Value::as_str) {
                let p = PathBuf::from(d);
                if p.is_dir() {
                    b = b.set_directory(p);
                } else if let Some(parent) = p.parent() {
                    if parent.is_dir() {
                        b = b.set_directory(parent.to_path_buf());
                    }
                }
            }
            if let Some(filters) = a0.get("filters").and_then(Value::as_array) {
                for f in filters {
                    let name = f.get("name").and_then(Value::as_str).unwrap_or("Files");
                    let exts = str_list(f.get("extensions"));
                    let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
                    b = b.add_filter(name, &refs);
                }
            }
            let want_dir = str_list(a0.get("properties")).iter().any(|p| p == "openDirectory");
            let picked = if want_dir { b.blocking_pick_folder() } else { b.blocking_pick_file() };
            match picked {
                Some(fp) => {
                    let path = fp.into_path().map_err(|e| e.to_string())?;
                    Ok(json!({ "canceled": false, "filePaths": [clean_path(path).to_string_lossy()] }))
                }
                None => Ok(json!({ "canceled": true, "filePaths": [] })),
            }
        }
        "dialog.message" => {
            let message = a0.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            let title = a0.get("title").and_then(Value::as_str).unwrap_or("CRYOX CLIENT").to_string();
            let buttons = str_list(a0.get("buttons"));
            let mut d = app.dialog().message(message).title(title);
            if buttons.len() >= 2 {
                d = d.buttons(MessageDialogButtons::OkCancelCustom(
                    buttons[0].clone(),
                    buttons[1].clone(),
                ));
            }
            let first = d.blocking_show();
            Ok(json!({ "response": if first { 0 } else { 1 } }))
        }
        "webview.msLogin" => ms_login_window(app, &a0), // [ms-login-fix]
        other => Err(format!("Unsupported host call: {other}")),
    }
}

// ---------------------------------------------------------------------------------------------

// [ms-login-fix] Microsoft sign-in window. Opens `url` in a small separate window with a throw-away browser
// profile, waits until the page tries to go to `redirectPrefix` (the sign-in result), stops that navigation and
// returns the address. Returns { canceled: true } when the window is closed or after 10 minutes.
fn ms_login_window(app: &AppHandle, args: &Value) -> Reply {
    use std::sync::mpsc;

    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing sign-in address.".to_string())?
        .to_string();
    let prefix = args
        .get("redirectPrefix")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing redirect address.".to_string())?
        .to_string();
    if !url.starts_with("https://") || !prefix.starts_with("https://") {
        return Err("Invalid sign-in address.".to_string());
    }
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    if let Some(w) = app.get_webview_window("mslogin") {
        let _ = w.set_focus();
        return Err("A Microsoft sign-in window is already open.".to_string());
    }

    // fresh browser profile for every sign-in, so no cookies of an earlier account are left behind
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("mslogin-webview");
    let _ = std::fs::remove_dir_all(&data_dir);

    let (tx, rx) = mpsc::channel::<Option<String>>();
    let tx_nav = Mutex::new(tx.clone());
    let tx_close = Mutex::new(tx);
    let prefix_nav = prefix.clone();

    let win = WebviewWindowBuilder::new(app, "mslogin", WebviewUrl::External(parsed))
        .title("Microsoft sign-in")
        .inner_size(520.0, 720.0)
        .center()
        .data_directory(data_dir.clone())
        .on_navigation(move |u| {
            if u.as_str().starts_with(prefix_nav.as_str()) {
                if let Ok(t) = tx_nav.lock() {
                    let _ = t.send(Some(u.to_string()));
                }
                false
            } else {
                true
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            if let Ok(t) = tx_close.lock() {
                let _ = t.send(None);
            }
        }
    });

    let outcome = rx.recv_timeout(Duration::from_secs(600));
    let _ = win.close();
    let _ = std::fs::remove_dir_all(&data_dir); // best effort; it is cleared again before the next sign-in

    match outcome {
        Ok(Some(u)) => Ok(json!({ "canceled": false, "url": u })),
        _ => Ok(json!({ "canceled": true })),
    }
}

/// Closes the launcher and can never hang: the window disappears at once, running servers are force-killed
/// (like the old Node version), tunnels are stopped, and the process is force-exited after 5 s whatever happens.
/// Used by the close button AND by Alt+F4 / taskbar close.
async fn graceful_shutdown(app: AppHandle) {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(5));
        std::process::exit(0);
    });
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    servers::kill_all_servers();
    playit_ext::stop_all();
    app.exit(0);
}

pub fn run() {
    let sidecar = Arc::new(Sidecar::new());
    let for_setup = sidecar.clone();
    let for_exit = sidecar.clone();

    tauri::Builder::default()
        // Must be the FIRST plugin: a second launch exits right away and just brings the running window to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar)
        .invoke_handler(tauri::generate_handler![inex_invoke])
        .setup(move |app| {
            // All features are natively implemented in 100% Rust.
            // Attempt to launch sidecar if present, but do not block or show error if absent.
            let _ = start_backend(app.handle().clone(), for_setup.clone());
            // Discord "In Menus" presence from the first second (before, it only appeared after launching a game)
            discord::start();
            discord::refresh_menu_presence();
            discord::request_server_sync();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                {
                    let sc = app.state::<Arc<Sidecar>>();
                    if sc.closing.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let _ = sc.write(&json!({ "t": "window-all-closed" }));
                }
                tauri::async_runtime::spawn(graceful_shutdown(app));
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building CRYOX CLIENT")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                for_exit.kill();
            }
        });
}
