// =========================================================================
// CRYOX CLIENT - Horizon (Rust Native Engine) Integration
//
// Based on & integrates with Project Horizon (https://github.com/horizon-rust/horizon)
// Original Horizon Engine is licensed under LGPL-3.0 / GPL-3.0 by the Horizon Team.
//
// [Cryox Client Modifications & Additions]:
//   - Added Offline / Local Account Support & Session Handoff
//   - Centralized Minecraft 26.3 shared resources mapping (--resources)
//   - Isolated Profile & Instance directory isolation (gameDir management)
//   - Zero-console background process spawning (CREATE_NO_WINDOW suppression)
//   - Dynamic WGPU graphics backend selection (DirectX 12 / Vulkan / OpenGL)
//   - Native Discord Rich Presence hooks
// =========================================================================

use serde_json::{json, Value};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

pub fn get_rust_engine_dir(game_data_dir: &str) -> PathBuf {
    PathBuf::from(game_data_dir).join("rust_engine")
}

pub fn get_versions_dir(game_data_dir: &str) -> PathBuf {
    get_rust_engine_dir(game_data_dir).join("versions")
}

pub fn get_instances_dir(game_data_dir: &str) -> PathBuf {
    get_rust_engine_dir(game_data_dir).join("instances")
}

pub fn get_shared_resources_dir(game_data_dir: &str) -> PathBuf {
    get_rust_engine_dir(game_data_dir).join("shared_resources").join("26.3")
}

/// Locates pre-prepared Minecraft 26.3 resources for Horizon.
pub fn find_prepared_resources(game_data_dir: &str, version_dir: &Path) -> Option<PathBuf> {
    // 1. Check version's own .local folder
    let v_res = version_dir.join(".local").join("horizon-client").join("26.3");
    if v_res.join("horizon-resources.json").is_file() {
        return Some(v_res);
    }

    // 2. Check central shared_resources folder in rust_engine
    let shared = get_shared_resources_dir(game_data_dir);
    if shared.join("horizon-resources.json").is_file() {
        return Some(shared);
    }

    // 3. Check any other installed version under rust_engine/versions
    let versions_dir = get_versions_dir(game_data_dir);
    if let Ok(entries) = fs::read_dir(&versions_dir) {
        for e in entries.flatten() {
            let candidate = e.path().join(".local").join("horizon-client").join("26.3");
            if candidate.join("horizon-resources.json").is_file() {
                return Some(candidate);
            }
        }
    }

    // 4. Check official horizon-launcher folder in AppData/Roaming if present
    if let Ok(appdata) = std::env::var("APPDATA") {
        let hl_versions = PathBuf::from(appdata).join("horizon-launcher").join("versions");
        if let Ok(entries) = fs::read_dir(&hl_versions) {
            for e in entries.flatten() {
                let candidate = e.path().join(".local").join("horizon-client").join("26.3");
                if candidate.join("horizon-resources.json").is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

pub fn normalize_build_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return "v0.2.97".to_string();
    }
    match trimmed {
        "horizon-26.3" => "v0.2.97".to_string(),
        "horizon-nightly" => "nightly".to_string(),
        other => other.to_string(),
    }
}

pub fn find_horizon_client_exe(version_dir: &Path) -> Option<PathBuf> {
    if !version_dir.is_dir() {
        return None;
    }
    // 1. Direct check in version directory
    let candidates = ["horizon-client.exe", "horizon.exe"];
    for name in &candidates {
        let p = version_dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // 2. Check inside unpacked subfolder (e.g. horizon-windows-x64/)
    if let Ok(entries) = fs::read_dir(version_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                for name in &candidates {
                    let sub = p.join(name);
                    if sub.is_file() {
                        return Some(sub);
                    }
                }
            }
        }
    }
    None
}

pub fn is_version_installed(versions_dir: &Path, tag: &str) -> bool {
    let norm = normalize_build_id(tag);
    find_horizon_client_exe(&versions_dir.join(&norm)).is_some()
        || find_horizon_client_exe(&versions_dir.join(tag)).is_some()
}

/// Lists available Horizon releases with local installation status.
pub async fn list_versions(_config_dir: &str, game_data_dir: &str) -> Result<Value, String> {
    let versions_dir = get_versions_dir(game_data_dir);
    let cache_dir = get_rust_engine_dir(game_data_dir).join("cache");
    let _ = fs::create_dir_all(&versions_dir);
    let _ = fs::create_dir_all(&cache_dir);

    let releases_cache_file = cache_dir.join("releases.json");
    let mut fetched_json: Option<Value> = None;

    // Check if cache file is fresh (< 15 mins old)
    let is_cache_fresh = releases_cache_file
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|mod_time| {
            SystemTime::now()
                .duration_since(mod_time)
                .unwrap_or(Duration::from_secs(9999))
                .as_secs()
                < 900
        })
        .unwrap_or(false);

    if is_cache_fresh {
        if let Ok(data) = fs::read_to_string(&releases_cache_file) {
            fetched_json = serde_json::from_str(&data).ok();
        }
    }

    if fetched_json.is_none() {
        let client = reqwest::Client::builder()
            .user_agent("Cryox-Client/1.0.1 (Rust)")
            .timeout(Duration::from_secs(5))
            .build();
        if let Ok(client) = client {
            if let Ok(resp) = client
                .get("https://api.github.com/repos/horizon-rust/horizon/releases?per_page=30")
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(val) = resp.json::<Value>().await {
                        let _ = fs::write(&releases_cache_file, val.to_string());
                        fetched_json = Some(val);
                    }
                }
            }
        }
    }

    // Fallback: try reading stale cache if network failed
    if fetched_json.is_none() && releases_cache_file.exists() {
        if let Ok(data) = fs::read_to_string(&releases_cache_file) {
            fetched_json = serde_json::from_str(&data).ok();
        }
    }

    let mut versions: Vec<Value> = Vec::new();

    if let Some(Value::Array(items)) = fetched_json {
        for item in items {
            let tag = item
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tag.is_empty() || tag.starts_with("launcher") {
                continue;
            }
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&tag)
                .to_string();

            let mut win_asset_url: Option<String> = None;
            let mut win_asset_size: Option<u64> = None;
            if let Some(Value::Array(assets)) = item.get("assets") {
                for a in assets {
                    let aname = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if aname.contains("windows")
                        && aname.contains("x64")
                        && aname.ends_with(".zip")
                    {
                        win_asset_url = a
                            .get("browser_download_url")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        win_asset_size = a.get("size").and_then(|v| v.as_u64());
                        break;
                    }
                }
            }

            if win_asset_url.is_none() {
                continue;
            }

            let is_nightly = tag.to_lowercase().contains("nightly");
            let channel = if is_nightly { "Nightly" } else { "Stable" };
            let desc = if is_nightly {
                "Latest experimental build from Horizon main".to_string()
            } else {
                "Pure Rust wgpu renderer, 100% Java-free Minecraft parity".to_string()
            };

            let installed = is_version_installed(&versions_dir, &tag);

            versions.push(json!({
                "id": tag,
                "name": name,
                "channel": channel,
                "desc": desc,
                "installed": installed,
                "downloadUrl": win_asset_url,
                "size": win_asset_size
            }));
        }
    }

    // Offline / fallback catalog if GitHub API was unreachable or empty
    if versions.is_empty() {
        let v_stable = "v0.2.97";
        let v_nightly = "nightly";
        versions.push(json!({
            "id": v_stable,
            "name": "Horizon 0.2.97 (Stable)",
            "channel": "Stable",
            "desc": "Stable Horizon build. Pure Rust wgpu renderer, vanilla parity.",
            "installed": is_version_installed(&versions_dir, v_stable),
            "downloadUrl": "https://github.com/horizon-rust/horizon/releases/download/v0.2.97/horizon-windows-x64.zip",
            "size": 31775574
        }));
        versions.push(json!({
            "id": v_nightly,
            "name": "Horizon Nightly",
            "channel": "Nightly",
            "desc": "Latest experimental build. Newest features and performance patches.",
            "installed": is_version_installed(&versions_dir, v_nightly),
            "downloadUrl": "https://github.com/horizon-rust/horizon/releases/download/nightly/horizon-windows-x64.zip",
            "size": 59252227
        }));
    }

    Ok(json!(versions))
}

/// Downloads and installs a Horizon build asset into `rust_engine/versions/<tag>`.
pub async fn install_version(
    _app: AppHandle,
    game_data_dir: &str,
    payload: &Value,
) -> Result<Value, String> {
    let raw_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if raw_id.is_empty() {
        return Err("Missing Horizon version ID to install".to_string());
    }
    let tag = normalize_build_id(raw_id);

    let versions_dir = get_versions_dir(game_data_dir);
    let target_dir = versions_dir.join(&tag);
    let cache_dir = get_rust_engine_dir(game_data_dir).join("cache");
    let _ = fs::create_dir_all(&cache_dir);
    let _ = fs::create_dir_all(&versions_dir);

    // If already installed and not forced, return immediately
    let force_reinstall = payload
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !force_reinstall {
        if let Some(exe) = find_horizon_client_exe(&target_dir) {
            return Ok(json!({
                "success": true,
                "installed": true,
                "id": tag,
                "exePath": exe.to_string_lossy()
            }));
        }
    }

    let download_url = payload
        .get("downloadUrl")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "https://github.com/horizon-rust/horizon/releases/download/{}/horizon-windows-x64.zip",
                tag
            )
        });

    let client = reqwest::Client::builder()
        .user_agent("Cryox-Client/1.0.1 (Rust)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download connection failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Download failed with HTTP status {}",
            resp.status()
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read archive bytes: {}", e))?;

    if bytes.len() < 1000 {
        return Err("Downloaded archive is invalid or incomplete".to_string());
    }

    let reader = Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Failed to read zip: {}", e))?;

    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = file.name().to_string();
        if raw_name.ends_with('/') || raw_name.ends_with('\\') {
            continue;
        }
        let clean_path = if let Some(s) = raw_name.strip_prefix("horizon-windows-x64/") {
            s
        } else if let Some(s) = raw_name.strip_prefix("horizon-windows-x64\\") {
            s
        } else {
            &raw_name
        };

        let out_path = target_dir.join(clean_path);
        if let Some(parent) = out_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut outfile = fs::File::create(&out_path)
            .map_err(|e| format!("Could not create {}: {}", out_path.display(), e))?;
        std::io::copy(&mut file, &mut outfile)
            .map_err(|e| format!("Failed to extract file: {}", e))?;
    }

    let exe = find_horizon_client_exe(&target_dir)
        .ok_or_else(|| "Installation completed but horizon-client.exe was not found.".to_string())?;

    Ok(json!({
        "success": true,
        "installed": true,
        "id": tag,
        "exePath": exe.to_string_lossy()
    }))
}

/// Launches a Horizon native Minecraft instance.
pub async fn launch_profile(
    app: AppHandle,
    config_dir: &str,
    game_data_dir: &str,
    payload: &Value,
) -> Result<Value, String> {
    let mut build_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let profile_obj = payload.get("profile").and_then(|v| v.as_object());
    let profile_name = profile_obj
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Horizon Profile")
        .to_string();
    let profile_id = profile_obj
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();

    if build_id.is_empty() {
        if let Some(b) = profile_obj
            .and_then(|p| p.get("build"))
            .and_then(|v| v.as_str())
        {
            build_id = b.to_string();
        }
    }
    let tag = normalize_build_id(&build_id);

    let versions_dir = get_versions_dir(game_data_dir);
    let version_dir = versions_dir.join(&tag);
    let mut exe_path = find_horizon_client_exe(&version_dir);

    // If not installed yet, auto-install now
    if exe_path.is_none() {
        let _ = install_version(app.clone(), game_data_dir, &json!({ "id": tag })).await?;
        exe_path = find_horizon_client_exe(&version_dir);
    }

    let exe = exe_path.ok_or_else(|| {
        format!(
            "Horizon build '{}' could not be found. Please install it in the Rust versions tab.",
            tag
        )
    })?;

    // Determine instance directory
    let settings_obj = payload.get("settings").and_then(|v| v.as_object());
    let custom_dir = settings_obj
        .and_then(|s| s.get("gameDir"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let instance_dir = match custom_dir {
        Some(cd) => PathBuf::from(cd),
        None => get_instances_dir(game_data_dir).join(&profile_id),
    };
    let _ = fs::create_dir_all(&instance_dir);

    // Sync resource packs if requested
    let sync_packs = settings_obj
        .and_then(|s| s.get("syncPacks"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if sync_packs {
        let main_rp_dir = PathBuf::from(game_data_dir).join("resourcepacks");
        let inst_rp_dir = instance_dir.join("resourcepacks");
        if main_rp_dir.is_dir() && !inst_rp_dir.exists() {
            // Junction link on Windows prevents duplicating large resource packs
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("cmd")
                    .creation_flags(0x0800_0000)
                    .args([
                        "/C",
                        "mklink",
                        "/J",
                        &inst_rp_dir.to_string_lossy(),
                        &main_rp_dir.to_string_lossy(),
                    ])
                    .output();
            }
        }
    }

    // Locate prepared Minecraft 26.3 resources (horizon-resources.json)
    let res_dir_opt = find_prepared_resources(game_data_dir, &version_dir);

    // Ensure instance local folder also has access to resources via junction
    if let Some(ref res_path) = res_dir_opt {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let inst_local_res = instance_dir.join(".local").join("horizon-client").join("26.3");
            if !inst_local_res.join("horizon-resources.json").is_file() {
                let _ = fs::remove_dir_all(&inst_local_res);
                if let Some(parent) = inst_local_res.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = Command::new("cmd")
                    .creation_flags(0x0800_0000)
                    .args([
                        "/C",
                        "mklink",
                        "/J",
                        &inst_local_res.to_string_lossy(),
                        &res_path.to_string_lossy(),
                    ])
                    .output();
            }
        }
    }

    // [Cryox Modification]: Enforce active account requirement & local/Microsoft session handoff
    let active_acc = crate::accounts::get_active_account(config_dir)
        .ok_or_else(|| "No account found. Please create or link an account in the Accounts tab before launching.".to_string())?;

    // Clean up any residual skin overrides in Horizon instance to ensure maximum native performance & instant world load
    let _ = fs::remove_file(instance_dir.join("inex-self-skin.png"));
    let _ = fs::remove_dir_all(instance_dir.join("skins"));

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&instance_dir);

    // Pass --resources flag if prepared resources folder is available
    if let Some(ref res_path) = res_dir_opt {
        cmd.arg("--resources").arg(res_path);
    }

    // Suppress console window on Windows (Zero-CMD)
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let player_username = active_acc.username.clone();

    if active_acc.account_type.to_lowercase() == "microsoft" && active_acc.authenticated_online {
        let sessions_dir = instance_dir.join("sessions");
        let _ = fs::create_dir_all(&sessions_dir);
        let session_path = sessions_dir.join("session.json");
        let session_json = json!({
            "name": active_acc.username,
            "uuid": active_acc.uuid,
            "access_token": active_acc.access_token.as_deref().unwrap_or(""),
            "user_type": "msa",
            "xuid": ""
        });
        let _ = fs::write(&session_path, session_json.to_string());
        cmd.arg("--session-file").arg(&session_path);
    } else {
        // [Cryox Modification]: Offline / Local Account Support & Session Handoff
        cmd.arg("--name").arg(&active_acc.username);
    }

    // Graphics backend setting (auto / vulkan / dx12)
    let backend_choice = settings_obj
        .and_then(|s| s.get("backend"))
        .and_then(|v| v.as_str())
        .unwrap_or("auto");

    match backend_choice {
        "vulkan" => {
            cmd.env("WGPU_BACKEND", "vulkan");
        }
        "dx12" => {
            cmd.env("WGPU_BACKEND", "dx12");
        }
        _ => {}
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Horizon ({}): {}", exe.display(), e))?;
    let pid = child.id();

    let pid_str = profile_id.clone();
    crate::launcher::register_running_profile(pid_str.clone(), pid);
    crate::discord::set_playing(&profile_name, &tag, "Horizon (Rust)", &player_username);

    let app_exit = app.clone();
    let id_exit = pid_str.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        crate::launcher::unregister_running_profile(&id_exit);
        crate::discord::refresh_menu_presence();
        let code = status.map(|s| s.code().unwrap_or(0)).unwrap_or(0);
        let _ = app_exit.emit(
            "inex-event",
            json!({
                "channel": "event:game-exit",
                "data": {
                    "profileId": id_exit,
                    "code": code,
                    "exitCode": code
                }
            }),
        );
    });

    Ok(json!({
        "success": true,
        "pid": pid,
        "profileId": profile_id,
        "buildId": tag
    }))
}
