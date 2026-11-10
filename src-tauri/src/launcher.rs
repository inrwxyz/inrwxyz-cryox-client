use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static RUNNING_PROCESSES: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn with_running<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, u32>) -> R,
{
    let mut guard = RUNNING_PROCESSES.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_mut().unwrap())
}

pub fn is_profile_running(profile_id: &str) -> bool {
    with_running(|map| map.contains_key(profile_id))
}

pub fn get_running_profiles() -> Vec<String> {
    with_running(|map| map.keys().cloned().collect())
}

pub fn stop_game(profile_id: &str) -> Result<Value, String> {
    let pid = with_running(|map| map.remove(profile_id));
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            #[link(name = "kernel32")]
            extern "system" {
                fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut std::ffi::c_void;
                fn TerminateProcess(hProcess: *mut std::ffi::c_void, uExitCode: u32) -> i32;
                fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
            }
            const PROCESS_TERMINATE: u32 = 0x0001;
            unsafe {
                let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if !handle.is_null() {
                    let _ = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                }
            }
        }
        Ok(json!({ "stopped": true, "profileId": profile_id }))
    } else {
        Ok(json!({ "stopped": false, "message": "No active game process found for this profile." }))
    }
}

pub fn prefer_high_performance_gpu(_exe_path: &str) {
    // Windows manages GPU preferences automatically via DirectX and WDDM
}

/// Every library file the version needs (whether or not it exists on disk yet).
pub fn library_paths(game_data_dir: &Path, version_meta: &Value) -> Vec<PathBuf> {
    let libraries_dir = game_data_dir.join("libraries");
    let mut entries: Vec<PathBuf> = Vec::new();
    let mut seen_keys = HashSet::new();

    if let Some(libs) = version_meta.get("libraries").and_then(|l| l.as_array()) {
        for lib in libs {
            let rules = lib.get("rules").and_then(|r| r.as_array());
            if !crate::installer::evaluate_rules(rules, "windows") {
                continue;
            }

            let name = lib.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let parts: Vec<&str> = name.split(':').collect();
            if parts.len() >= 4 {
                let classifier = parts[3].to_lowercase();
                if classifier.contains("x86")
                    || classifier.contains("arm64")
                    || classifier.contains("linux")
                    || classifier.contains("osx")
                    || classifier.contains("macos")
                {
                    continue;
                }
            }

            let key = if parts.len() >= 2 {
                format!("{}:{}:{}", parts[0], parts[1], parts.get(3).unwrap_or(&""))
            } else {
                name.to_string()
            };
            if seen_keys.contains(&key) {
                continue;
            }
            seen_keys.insert(key);

            let rel_opt = if let Some(artifact) = lib.get("downloads").and_then(|d| d.get("artifact")) {
                artifact.get("path").and_then(|p| p.as_str()).map(|s| s.to_string())
            } else {
                crate::loaders::maven_coord_to_path(name)
            };
            if let Some(rel) = rel_opt {
                entries.push(libraries_dir.join(rel));
            }
        }
    }
    entries
}

pub fn collect_classpath(game_data_dir: &Path, version_meta: &Value, client_jar: &Path) -> String {
    let mut entries: Vec<String> = library_paths(game_data_dir, version_meta)
        .into_iter()
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    entries.push(client_jar.to_string_lossy().to_string());
    entries.join(";")
}

fn valid_server_addr(s: &str) -> bool {
    let mut parts = s.splitn(2, ':');
    let host = parts.next().unwrap_or("");
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return false;
    }
    match parts.next() {
        None => true,
        Some(p) => !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()),
    }
}

fn is_quick_play_supported(v: &str) -> bool {
    let mut it = v.trim().split('.');
    let major = it.next().and_then(|s| s.parse::<u32>().ok());
    let minor = it.next().and_then(|s| {
        s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().ok()
    });
    match (major, minor) {
        (Some(ma), Some(mi)) => {
            if ma > 1 {
                true
            } else {
                ma == 1 && mi >= 20
            }
        }
        _ => true,
    }
}

fn replace_vars(s: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let key = &after[..end];
            match vars.get(key) {
                Some(v) => out.push_str(v),
                None => {
                    out.push_str("${");
                    out.push_str(key);
                    out.push('}');
                }
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn merge_game_args(base: Vec<String>, extra: Vec<String>) -> Vec<String> {
    let mut result = base.clone();
    let mut existing: HashSet<String> = base.iter().filter(|a| a.starts_with("--")).cloned().collect();
    let mut i = 0;
    while i < extra.len() {
        let tok = extra[i].clone();
        i += 1;
        if !tok.starts_with("--") {
            continue;
        }
        let next = extra.get(i).cloned();
        let has_value = next.as_ref().map(|n| !n.starts_with("--")).unwrap_or(false);
        if has_value {
            i += 1;
        }
        if existing.contains(&tok) {
            continue;
        }
        if has_value && next.as_ref().map(|n| n.contains("${")).unwrap_or(false) {
            continue;
        }
        if tok.contains("${") {
            continue;
        }
        existing.insert(tok.clone());
        result.push(tok);
        if has_value {
            if let Some(n) = next {
                result.push(n);
            }
        }
    }
    result
}

fn emit_log(app: &AppHandle, profile_id: &str, level: &str, line: &str) {
    let _ = app.emit(
        "inex-event",
        json!({
            "channel": "event:game-log",
            "data": { "profileId": profile_id, "level": level, "line": line }
        }),
    );
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

pub async fn launch_profile(
    app: AppHandle,
    profile_id: &str,
    join_server: Option<String>,
) -> Result<Value, String> {
    let mgr = crate::settings::SettingsManager::new();
    let settings = mgr.get_settings();
    let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let game_data_dir = PathBuf::from(&game_data_dir_str);
    let java_dir = PathBuf::from(settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or("."));
    let max_ram = settings.get("maxRamMB").and_then(|v| v.as_u64()).unwrap_or(16384) as u32;

    let join_server = join_server.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(addr) = join_server.as_ref() {
        if !valid_server_addr(addr) {
            return Err("Invalid server address.".to_string());
        }
    }

    let p_state = crate::profiles::list_profiles(&config_dir_str, &game_data_dir_str);
    let wanted_id = if profile_id.is_empty() {
        p_state.active_profile_id.clone().unwrap_or_default()
    } else {
        profile_id.to_string()
    };
    let profile = p_state
        .profiles
        .iter()
        .find(|p| p.id == wanted_id)
        .cloned()
        .or_else(|| if profile_id.is_empty() { p_state.profiles.first().cloned() } else { None })
        .ok_or_else(|| "No profile selected. Please create or select a profile first.".to_string())?;
    let pid_str = profile.id.clone();

    if is_profile_running(&pid_str) {
        return Err(format!("\"{}\" is already running.", profile.name));
    }

    // folders that can hold the bundled HUD jar
    let mut extra_roots: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        extra_roots.push(res.join("default-mods"));
        extra_roots.push(res.clone());
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        extra_roots.push(dir.join("default-mods"));
    }

    // 0. HUD mod(s)
    let hud = crate::hud::attach_default_client_mods(
        &config_dir_str,
        &extra_roots,
        &profile.game_dir,
        &profile.loader,
        &profile.version,
        profile.hud_enabled,
        settings.get("activeHudJar").and_then(|v| v.as_str()).unwrap_or(""),
    );
    if !hud.attached.is_empty() {
        emit_log(&app, &pid_str, "info", &format!("[CRYOX HUD] Attached HUD mod(s): {}", hud.attached.join(", ")));
    }
    for (name, reason) in &hud.skipped {
        emit_log(&app, &pid_str, "warn", &format!("[CRYOX HUD] Skipped {}: {}", name, reason));
    }

    // 1. install / verify
    let install = |force: bool| {
        let app = app.clone();
        let profile = profile.clone();
        let game_data_dir = game_data_dir.clone();
        async move {
            let _ = force;
            let cancel = crate::installer::register_cancel(&profile.id);
            let r = crate::installer::install_game_files(
                &app,
                &profile.id,
                &profile.version,
                &profile.loader,
                &game_data_dir,
                cancel,
            )
            .await;
            crate::installer::clear_cancel(&profile.id);
            r
        }
    };
    if !profile.installed {
        emit_log(
            &app,
            &pid_str,
            "info",
            &format!("[CRYOX] Verifying & installing {} runtime for \"{}\"...", profile.loader.to_uppercase(), profile.name),
        );
        install(false).await?;
    }

    // 2. merged version metadata
    let version_dir = game_data_dir.join("versions").join(&profile.version);
    let vanilla_json_path = version_dir.join(format!("{}.json", profile.version));
    let effective_path = version_dir.join(format!("effective-{}.json", profile.loader));
    let load_meta = || -> Option<Value> {
        if profile.loader != "vanilla" {
            let candidate = read_json_file(&effective_path)?;
            let main = candidate.get("mainClass").and_then(|m| m.as_str()).unwrap_or("");
            if crate::loaders::is_valid_loader_main_class(&profile.loader, main) {
                return Some(candidate);
            }
            None
        } else {
            read_json_file(&vanilla_json_path)
        }
    };
    let mut version_meta = load_meta();
    if version_meta.is_none() {
        install(true).await?;
        version_meta = load_meta();
    }
    let version_meta = version_meta.ok_or_else(|| {
        format!(
            "Cannot launch: {} mainClass is invalid or missing for Minecraft {}.",
            profile.loader.to_uppercase(),
            profile.version
        )
    })?;

    // 3. Java (exact version from Mojang metadata, auto-bundled when allowed)
    let required_java = crate::versions::get_required_java_major_with_meta(&profile.version, &version_meta);
    emit_log(&app, &pid_str, "info", &format!("[CRYOX] Verifying Java {} runtime for Minecraft {}...", required_java, profile.version));
    let progress_app = app.clone();
    let progress_id = pid_str.clone();
    let progress_name = profile.name.clone();
    let java_resolution = crate::java::ensure_java_for_version(&java_dir, required_java, &profile.java_runtime, move |stage, percent, detail| {
        let _ = progress_app.emit(
            "inex-event",
            json!({
                "channel": "event:install-progress",
                "data": {
                    "profileId": progress_id,
                    "profileName": progress_name,
                    "stage": stage,
                    "percent": percent,
                    "detail": detail
                }
            }),
        );
    })
    .await?;
    let found = java_resolution.get("found").and_then(|v| v.as_bool()).unwrap_or(false);
    let compatible = java_resolution.get("compatible").and_then(|v| v.as_bool()).unwrap_or(false);
    if !found || !compatible {
        let msg = java_resolution.get("message").and_then(|m| m.as_str()).unwrap_or("No compatible Java runtime found.");
        return Err(format!("{} Click \"Bundle Portable Java\" in Settings or enable Auto-Bundle Java.", msg));
    }
    let java_runtime = java_resolution
        .get("runtime")
        .cloned()
        .ok_or_else(|| format!("No compatible Java {} runtime found for Minecraft {}.", required_java, profile.version))?;
    let java_path_raw = java_runtime
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| format!("Java path missing for Minecraft {}.", profile.version))?
        .to_string();
    let java_major = java_runtime.get("major").and_then(|m| m.as_u64()).unwrap_or(required_java as u64) as u32;
    let java_version_txt = java_runtime.get("version").and_then(|m| m.as_str()).unwrap_or("").to_string();

    let java_path = if java_path_raw.ends_with("java.exe") {
        let w = java_path_raw.replace("java.exe", "javaw.exe");
        if Path::new(&w).exists() { w } else { java_path_raw.clone() }
    } else {
        java_path_raw.clone()
    };

    let _ = fs::create_dir_all(&profile.game_dir);

    // 4. local skin (no network, only the player's own skin)
    let skin_sync = settings.get("enableSkinSync").and_then(|v| v.as_bool()).unwrap_or(true);
    let cosmetics = match crate::accounts::apply_local_cosmetics_to_game_dir(&config_dir_str, &profile.game_dir, skin_sync) {
        Ok(c) => {
            let line = if !skin_sync {
                "[CRYOX SKIN] Skin Sync is OFF - default skins, skin agent not loaded."
            } else if c.skin_file.is_some() {
                "[CRYOX SKIN] Local skin enabled (only you see it, no network)."
            } else {
                "[CRYOX SKIN] No custom skin on this account - skin agent not loaded."
            };
            emit_log(&app, &pid_str, "info", line);
            Some(c)
        }
        Err(e) => {
            emit_log(&app, &pid_str, "warn", &format!("[CRYOX SKIN] Notice: {}", e));
            None
        }
    };

    // 4b. Performance Pack: quietly retry mods that were not released for this Minecraft version yet (12h throttle).
    if profile.perf_pack_enabled {
        let newly = crate::modrinth_ext::retry_performance_pack(&app, &pid_str, &profile.game_dir, &profile.version, &profile.loader).await;
        for slug in newly {
            emit_log(
                &app,
                &pid_str,
                "info",
                &format!("[CRYOX PERF] {} is now available for Minecraft {} and was installed.", slug, profile.version),
            );
        }
    }

    // 5. integrated-GPU light defaults (once per profile, never overrides the player's options).
    //    Part of the Performance Pack: ONLY when the pack was switched on while creating the profile.
    if profile.perf_pack_enabled {
        let perf = crate::perf::apply_low_end_defaults(&profile.game_dir);
        if perf.applied {
            emit_log(
                &app,
                &pid_str,
                "info",
                &format!(
                    "[CRYOX PERF] Integrated GPU detected ({}): light graphics defaults applied ({} setting(s)). You can change them in Options > Video Settings.",
                    perf.gpus.join(", "),
                    perf.added.len()
                ),
            );
        }
    }

    // 6. renew the Microsoft/Minecraft token right before the game starts (no-op for local accounts)
    crate::msauth::ensure_fresh_active_token(&config_dir_str).await?;
    let account = crate::accounts::get_active_account(&config_dir_str);
    let (username, uuid, acc_type, access_token) = match account {
        Some(a) => (
            a.username.clone(),
            a.uuid.clone(),
            a.account_type.clone(),
            a.access_token.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "0".to_string()),
        ),
        None => (
            "Player".to_string(),
            "00000000-0000-0000-0000-000000000000".to_string(),
            "local".to_string(),
            "0".to_string(),
        ),
    };
    let is_ms = acc_type == "microsoft";

    // 7. launch arguments (templates from the version JSON, like x_client)
    let natives_dir = version_dir.join("natives");
    let assets_dir = game_data_dir.join("assets");
    let libraries_dir = game_data_dir.join("libraries");
    let client_jar_path = version_dir.join(format!("{}.jar", profile.version));
    let asset_index_id = version_meta
        .get("assetIndex")
        .and_then(|a| a.get("id"))
        .and_then(|i| i.as_str())
        .unwrap_or(&profile.version)
        .to_string();
    let lib_paths = library_paths(&game_data_dir, &version_meta);
    let missing: Vec<String> = lib_paths.iter().filter(|p| !p.exists()).map(|p| p.to_string_lossy().to_string()).collect();
    let classpath = collect_classpath(&game_data_dir, &version_meta, &client_jar_path);

    let ram_mb = if profile.ram_mb > 0 {
        profile.ram_mb
    } else {
        settings.get("defaultRamMB").and_then(|v| v.as_u64()).unwrap_or(4096) as u32
    };
    let win_w = settings.get("windowWidth").and_then(|v| v.as_u64()).unwrap_or(1280);
    let win_h = settings.get("windowHeight").and_then(|v| v.as_u64()).unwrap_or(720);
    let sep = ";";
    let version_type = format!("CRYOX-{}", profile.loader.to_uppercase());
    let mut vars: HashMap<String, String> = HashMap::new();
    let mut put = |k: &str, v: String| {
        vars.insert(k.to_string(), v);
    };
    put("auth_player_name", username.clone());
    put("version_name", version_meta.get("id").and_then(|v| v.as_str()).unwrap_or(&profile.version).to_string());
    put("game_directory", profile.game_dir.clone());
    put("assets_root", assets_dir.to_string_lossy().to_string());
    put("assets_index_name", asset_index_id.clone());
    put("auth_uuid", uuid.clone());
    put("auth_access_token", access_token.clone());
    put("clientid", "cryox-client".to_string());
    put("auth_xuid", "0".to_string());
    put("user_type", if is_ms { "msa" } else { "legacy" }.to_string());
    put("auth_player_type", if is_ms { "msa" } else { "legacy" }.to_string());
    put("auth_session", access_token.clone());
    put("game_assets", assets_dir.to_string_lossy().to_string());
    put("user_properties", "{}".to_string());
    put("profile_name", profile.name.clone());
    put("version_type", version_type.clone());
    put("resolution_width", win_w.to_string());
    put("resolution_height", win_h.to_string());
    put("natives_directory", natives_dir.to_string_lossy().to_string());
    put("launcher_name", "CRYOX-CLIENT".to_string());
    put("launcher_version", "1.0.0".to_string());
    put("classpath", classpath.clone());
    put("library_directory", libraries_dir.to_string_lossy().to_string());
    put("classpath_separator", sep.to_string());

    // JVM args
    let mut jvm_args: Vec<String> = vec![
        "-XX:+IgnoreUnrecognizedVMOptions".to_string(),
        format!("-Xmx{}M", ram_mb),
        format!("-Xms{}M", ram_mb),
    ];
    if java_major >= 21 {
        jvm_args.push("--enable-native-access=ALL-UNNAMED".to_string());
    }
    if let Some(extra) = settings.get("jvmExtraArgs").and_then(|e| e.as_str()) {
        for flag in extra.split_whitespace() {
            if !jvm_args.iter().any(|a| a == flag) {
                jvm_args.push(flag.to_string());
            }
        }
    }

    // skin agent: only when this account really has a custom skin (and Skin Sync is on)
    if skin_sync {
        if let Some(c) = cosmetics.as_ref() {
            if let Some(skin_file) = c.skin_file.as_ref() {
                let mut agent_candidates: Vec<PathBuf> = Vec::new();
                if let Ok(res) = app.path().resource_dir() {
                    agent_candidates.push(res.join("inex-cosmetics-agent.jar"));
                    agent_candidates.push(res.join("default-mods").join("inex-cosmetics-agent.jar"));
                    agent_candidates.push(res.join("agent").join("inex-cosmetics-agent.jar"));
                }
                if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
                    agent_candidates.push(dir.join("inex-cosmetics-agent.jar"));
                    agent_candidates.push(dir.join("default-mods").join("inex-cosmetics-agent.jar"));
                }
                agent_candidates.push(PathBuf::from(&config_dir_str).join("hud-mods").join("inex-cosmetics-agent.jar"));
                if let Some(agent) = agent_candidates.into_iter().find(|c| c.is_file()) {
                    jvm_args.push(format!("-javaagent:{}", agent.display()));
                    jvm_args.push("-Dinex.skin.online=false".to_string());
                    jvm_args.push(format!("-Dinex.skin.self={}", username.to_lowercase()));
                    jvm_args.push(format!("-Dinex.skin.selfFile={}", skin_file));
                    jvm_args.push(format!("-Dinex.skin.selfModel={}", c.model));
                }
            }
        }
    }

    if let Some(list) = version_meta.get("arguments").and_then(|a| a.get("jvm")).and_then(|j| j.as_array()) {
        let mut i = 0;
        while i < list.len() {
            let entry = &list[i];
            i += 1;
            let s = match entry.as_str() {
                Some(s) => s,
                None => continue,
            };
            if s == "-cp" || s == "-classpath" {
                i += 1;
                continue;
            }
            if s.starts_with("-Djava.library.path=") {
                continue;
            }
            let resolved = replace_vars(s, &vars);
            if !resolved.contains("${") {
                jvm_args.push(resolved);
            }
        }
    }
    jvm_args.push(format!("-Djava.library.path={}", natives_dir.display()));
    jvm_args.push(format!("-Dorg.lwjgl.librarypath={}", natives_dir.display()));
    jvm_args.push("-Dminecraft.launcher.brand=CRYOX-CLIENT".to_string());
    jvm_args.push("-Dminecraft.launcher.version=1.0.0".to_string());
    jvm_args.push("-cp".to_string());
    jvm_args.push(classpath.clone());

    let main_class = version_meta
        .get("mainClass")
        .and_then(|m| m.as_str())
        .unwrap_or("net.minecraft.client.main.Main")
        .to_string();

    // game args
    let mut game_args: Vec<String>;
    if let Some(mc_args) = version_meta.get("minecraftArguments").and_then(|m| m.as_str()) {
        game_args = mc_args.split_whitespace().map(|t| replace_vars(t, &vars)).collect();
    } else {
        game_args = vec![
            "--username".to_string(), username.clone(),
            "--version".to_string(), vars.get("version_name").cloned().unwrap_or_default(),
            "--gameDir".to_string(), profile.game_dir.clone(),
            "--assetsDir".to_string(), assets_dir.to_string_lossy().to_string(),
            "--assetIndex".to_string(), asset_index_id.clone(),
            "--uuid".to_string(), uuid.clone(),
            "--accessToken".to_string(), access_token.clone(),
            "--userType".to_string(), if is_ms { "msa" } else { "legacy" }.to_string(),
            "--versionType".to_string(), version_type.clone(),
        ];
        if let Some(list) = version_meta.get("arguments").and_then(|a| a.get("game")).and_then(|j| j.as_array()) {
            let extra: Vec<String> = list
                .iter()
                .filter_map(|a| a.as_str())
                .map(|a| replace_vars(a, &vars))
                .collect();
            game_args = merge_game_args(game_args, extra);
        }
    }

    if settings.get("fullscreen").and_then(|f| f.as_bool()).unwrap_or(false) {
        game_args.push("--fullscreen".to_string());
    } else {
        game_args.push("--width".to_string());
        game_args.push(win_w.to_string());
        game_args.push("--height".to_string());
        game_args.push(win_h.to_string());
    }

    if let Some(addr) = join_server.as_ref() {
        let mut parts = addr.splitn(2, ':');
        let host = parts.next().unwrap_or("");
        let port = parts.next().unwrap_or("25565");
        if is_quick_play_supported(&profile.version) {
            game_args.push("--quickPlayMultiplayer".to_string());
            game_args.push(format!("{}:{}", host, port));
        } else {
            game_args.push("--server".to_string());
            game_args.push(host.to_string());
            game_args.push("--port".to_string());
            game_args.push(port.to_string());
        }
    }

    // diagnostics
    if !missing.is_empty() {
        emit_log(&app, &pid_str, "warn", &format!("[CRYOX] WARNING: {} library file(s) missing on disk:", missing.len()));
        for m in missing.iter().take(8) {
            emit_log(&app, &pid_str, "warn", &format!("[CRYOX]   missing -> {}", m));
        }
    }
    if profile.loader == "forge" {
        let has_jopt = lib_paths.iter().any(|p| p.to_string_lossy().to_lowercase().contains("jopt-simple"));
        emit_log(
            &app,
            &pid_str,
            if has_jopt { "info" } else { "warn" },
            &format!("[CRYOX] jopt-simple in classpath: {}", if has_jopt { "yes" } else { "NO (Forge will crash)" }),
        );
    }
    emit_log(
        &app,
        &pid_str,
        "info",
        &format!(
            "[CRYOX] Launching Minecraft {} ({}) with Java {} ({} @ {})...",
            profile.version,
            profile.loader.to_uppercase(),
            java_major,
            java_version_txt,
            java_path_raw
        ),
    );
    if let Some(addr) = join_server.as_ref() {
        emit_log(&app, &pid_str, "info", &format!("[CRYOX] Auto-joining server: {}", addr));
    }

    let mut full_cmd = Command::new(&java_path);
    full_cmd.current_dir(&profile.game_dir);
    full_cmd.args(&jvm_args);
    full_cmd.arg(&main_class);
    full_cmd.args(&game_args);
    full_cmd.stdout(Stdio::piped());
    full_cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        full_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = full_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Minecraft ({}): {}", java_path, e))?;

    let _ = crate::profiles::update_profile(
        &config_dir_str,
        &game_data_dir_str,
        &pid_str,
        json!({ "lastPlayed": chrono::Utc::now().to_rfc3339() }),
        max_ram,
    );

    crate::discord::set_playing(&profile.name, &profile.version, &profile.loader, &username);

    let pid = child.id();
    with_running(|map| map.insert(pid_str.clone(), pid));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let app_log = app.clone();
        let id = pid_str.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                emit_log(&app_log, &id, "info", &line);
            }
        });
    }
    if let Some(err) = stderr {
        let app_err = app.clone();
        let id = pid_str.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                emit_log(&app_err, &id, "error", &line);
            }
        });
    }

    let app_exit = app.clone();
    let id_exit = pid_str.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        with_running(|map| map.remove(&id_exit));
        crate::discord::refresh_menu_presence();
        let code = status.map(|s| s.code().unwrap_or(0)).unwrap_or(-1);
        emit_log(
            &app_exit,
            &id_exit,
            if code == 0 { "info" } else { "warn" },
            &format!("[CRYOX] Minecraft process exited with code {}", code),
        );
        // x_client sends { profileId, code }; the UI reads `code` (exitCode kept for compatibility)
        let _ = app_exit.emit(
            "inex-event",
            json!({
                "channel": "event:game-exit",
                "data": { "profileId": id_exit, "code": code, "exitCode": code }
            }),
        );
    });

    Ok(json!({
        "launched": true,
        "pid": pid,
        "profileId": profile.id,
        "profileName": profile.name,
        "joinServer": join_server,
        "java": java_runtime,
        "account": { "username": username, "type": acc_type }
    }))
}
