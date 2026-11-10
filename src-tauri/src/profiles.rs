use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentCounts {
    pub mods: usize,
    pub resourcepacks: usize,
    pub shaderpacks: usize,
    pub datapacks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(alias = "modLoader")]
    pub loader: String,
    #[serde(default = "default_loader_version")]
    pub loader_version: String,
    #[serde(alias = "javaPath", default = "default_java_runtime")]
    pub java_runtime: String,
    #[serde(alias = "memory", rename = "ramMB", default = "default_ram")]
    pub ram_mb: u32,
    #[serde(default)]
    pub game_dir: String,
    #[serde(default)]
    pub installed: bool,
    #[serde(default = "default_timestamp")]
    pub created_at: String,
    #[serde(default)]
    pub last_played: Option<String>,
    #[serde(default)]
    pub modpack_info: Option<serde_json::Value>,
    #[serde(default = "default_true")]
    pub hud_enabled: bool,
    #[serde(default)]
    pub perf_pack_enabled: bool,
    #[serde(default)]
    pub content_counts: Option<ContentCounts>,
}

fn default_loader_version() -> String {
    "latest".to_string()
}
fn default_java_runtime() -> String {
    "auto".to_string()
}
fn default_ram() -> u32 {
    4096
}
fn default_true() -> bool {
    true
}
fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesState {
    pub active_profile_id: Option<String>,
    pub profiles: Vec<Profile>,
}

pub fn get_content_counts(game_dir: &str, loader: &str) -> ContentCounts {
    let p = Path::new(game_dir);
    let count_exts = |sub: &str, exts: &[&str]| -> usize {
        let dir = p.join(sub);
        if let Ok(entries) = fs::read_dir(dir) {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    if let Ok(file_type) = e.file_type() {
                        if file_type.is_file() {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            return exts.iter().any(|ext| name.ends_with(ext));
                        }
                    }
                    false
                })
                .count()
        } else {
            0
        }
    };

    let mods = if loader.eq_ignore_ascii_case("vanilla") {
        0
    } else {
        count_exts("mods", &[".jar", ".jar.disabled"])
    };

    ContentCounts {
        mods,
        resourcepacks: count_exts("resourcepacks", &[".zip"]),
        shaderpacks: count_exts("shaderpacks", &[".zip"]),
        datapacks: count_exts("datapacks", &[".zip"]),
    }
}

pub fn verify_installation_state(profile: &Profile, game_data_dir: &str) -> bool {
    if profile.version.is_empty() {
        return false;
    }
    let version_dir = Path::new(game_data_dir).join("versions").join(&profile.version);
    let client_jar = version_dir.join(format!("{}.jar", profile.version));
    let version_json = version_dir.join(format!("{}.json", profile.version));

    if !client_jar.exists() || !version_json.exists() {
        return false;
    }

    if let Ok(meta) = fs::metadata(&client_jar) {
        if meta.len() < 1024 {
            return false;
        }
    } else {
        return false;
    }

    let loader = profile.loader.to_lowercase();
    if loader != "vanilla" {
        let loader_marker = version_dir.join(format!("loader-{}.json", loader));
        let effective_meta = version_dir.join(format!("effective-{}.json", loader));
        if !loader_marker.exists() || !effective_meta.exists() {
            return false;
        }
        if let Ok(content) = fs::read_to_string(&effective_meta) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let mc = json.get("mainClass").and_then(|v| v.as_str()).unwrap_or("");
                if mc.is_empty() || mc == "net.minecraft.client.main.Main" {
                    return false;
                }
                if loader == "fabric" && !mc.contains("fabricmc") {
                    return false;
                }
                if loader == "forge" && mc.contains("fabricmc") {
                    return false;
                }
            } else {
                return false;
            }
        } else {
            return false;
        }
    }

    true
}

pub fn ensure_profile_directories(game_dir: &str) {
    let p = Path::new(game_dir);
    let subdirs = [
        "",
        "mods",
        "resourcepacks",
        "shaderpacks",
        "datapacks",
        "saves",
        "config",
        "logs",
    ];
    for sub in subdirs {
        let dir = if sub.is_empty() { p.to_path_buf() } else { p.join(sub) };
        let _ = fs::create_dir_all(dir);
    }
}

pub fn load_profiles(config_dir: &str, game_data_dir: &str) -> ProfilesState {
    let file = Path::new(config_dir).join("profiles.json");
    if file.exists() {
        if let Ok(raw) = fs::read_to_string(&file) {
            if let Ok(mut state) = serde_json::from_str::<ProfilesState>(&raw) {
                for p in &mut state.profiles {
                    let low = p.game_dir.to_lowercase().replace('/', "\\");
                    if p.game_dir.is_empty()
                        || low.contains("\\.fastclient\\")
                        || low.contains("\\.xclient\\")
                        || low.contains("\\.inexclient\\")
                        || low.ends_with("\\.fastclient")
                        || low.ends_with("\\.xclient")
                        || low.ends_with("\\.inexclient")
                    {
                        p.game_dir = Path::new(game_data_dir)
                            .join("profiles")
                            .join(&p.id)
                            .to_string_lossy()
                            .to_string();
                    }
                    ensure_profile_directories(&p.game_dir);
                    p.installed = verify_installation_state(p, game_data_dir);
                    p.content_counts = Some(get_content_counts(&p.game_dir, &p.loader));
                }
                let active_valid = state
                    .active_profile_id
                    .as_ref()
                    .map(|id| state.profiles.iter().any(|p| &p.id == id))
                    .unwrap_or(false);
                if !active_valid {
                    state.active_profile_id = state.profiles.first().map(|p| p.id.clone());
                }
                return state;
            }
        }
    }

    let empty = ProfilesState {
        active_profile_id: None,
        profiles: Vec::new(),
    };
    save_profiles(config_dir, &empty);
    empty
}

pub fn save_profiles(config_dir: &str, state: &ProfilesState) {
    let file = Path::new(config_dir).join("profiles.json");
    let _ = fs::create_dir_all(config_dir);
    let tmp = format!("{}.tmp", file.to_string_lossy());
    if let Ok(json) = serde_json::to_string_pretty(state) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
}

pub fn list_profiles(config_dir: &str, game_data_dir: &str) -> ProfilesState {
    load_profiles(config_dir, game_data_dir)
}

pub fn set_active_profile(
    config_dir: &str,
    game_data_dir: &str,
    profile_id: &str,
) -> Result<ProfilesState, String> {
    let mut state = load_profiles(config_dir, game_data_dir);
    if !state.profiles.iter().any(|p| p.id == profile_id) {
        return Err(format!("Profile not found: {}", profile_id));
    }
    state.active_profile_id = Some(profile_id.to_string());
    save_profiles(config_dir, &state);
    Ok(state)
}

fn slugify(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

pub fn create_profile(
    config_dir: &str,
    game_data_dir: &str,
    payload: serde_json::Value,
    max_ram_mb: u32,
    default_ram_mb: u32,
) -> Result<serde_json::Value, String> {
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err("Profile name cannot be empty.".to_string());
    }

    let version = payload
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if version.is_empty() {
        return Err("Minecraft version is required.".to_string());
    }

    let loader = payload
        .get("loader")
        .and_then(|v| v.as_str())
        .unwrap_or("vanilla")
        .to_lowercase();
    let supported_loaders = ["vanilla", "fabric", "forge"];
    if !supported_loaders.contains(&loader.as_str()) {
        return Err(format!("Unsupported mod loader: {}", loader));
    }

    let raw_ram = payload
        .get("ramMB")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(default_ram_mb);
    let rounded = ((raw_ram as f64 / 256.0).round() as u32) * 256;
    let ram_mb = rounded.clamp(1024, max_ram_mb.max(1024));

    let rand_suffix = &uuid::Uuid::new_v4().to_string()[..6];
    let id = format!("{}-{}", slugify(name), rand_suffix);

    let game_dir = if let Some(custom_dir) = payload.get("gameDir").and_then(|v| v.as_str()) {
        let trimmed = custom_dir.trim();
        if !trimmed.is_empty() {
            let pb = Path::new(trimmed);
            if pb.is_absolute() {
                trimmed.to_string()
            } else {
                std::env::current_dir()
                    .map(|c| c.join(pb).to_string_lossy().to_string())
                    .unwrap_or_else(|_| trimmed.to_string())
            }
        } else {
            Path::new(game_data_dir)
                .join("profiles")
                .join(&id)
                .to_string_lossy()
                .to_string()
        }
    } else {
        Path::new(game_data_dir)
            .join("profiles")
            .join(&id)
            .to_string_lossy()
            .to_string()
    };

    ensure_profile_directories(&game_dir);

    let loader_version = if loader == "vanilla" {
        "official".to_string()
    } else {
        payload
            .get("loaderVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("latest")
            .trim()
            .to_string()
    };

    let java_runtime = payload
        .get("javaRuntime")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .trim()
        .to_string();

    let modpack_info = if loader == "vanilla" {
        None
    } else {
        payload.get("modpackInfo").cloned()
    };

    let hud_enabled = loader != "vanilla"
        && payload
            .get("hudEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

    let perf_pack_enabled = loader == "fabric"
        && payload
            .get("perfPack")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
        && modpack_info.is_none();

    let mut profile = Profile {
        id: id.clone(),
        name: name.to_string(),
        version: version.to_string(),
        loader: loader.clone(),
        loader_version,
        java_runtime,
        ram_mb,
        game_dir: game_dir.clone(),
        installed: false,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_played: None,
        modpack_info,
        hud_enabled,
        perf_pack_enabled,
        content_counts: Some(get_content_counts(&game_dir, &loader)),
    };

    profile.installed = verify_installation_state(&profile, game_data_dir);

    let mut state = load_profiles(config_dir, game_data_dir);
    state.profiles.insert(0, profile.clone());
    state.active_profile_id = Some(id);
    save_profiles(config_dir, &state);

    Ok(serde_json::json!({
        "profile": profile,
        "state": state
    }))
}

pub fn update_profile(
    config_dir: &str,
    game_data_dir: &str,
    id: &str,
    updates: serde_json::Value,
    max_ram_mb: u32,
) -> Result<serde_json::Value, String> {
    let mut state = load_profiles(config_dir, game_data_dir);
    let idx = state
        .profiles
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("Profile not found: {}", id))?;

    let current = &mut state.profiles[idx];

    if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Profile name cannot be empty.".to_string());
        }
        current.name = trimmed.to_string();
    }

    if let Some(version) = updates.get("version").and_then(|v| v.as_str()) {
        let trimmed = version.trim();
        if !trimmed.is_empty() {
            current.version = trimmed.to_string();
        }
    }

    if let Some(loader_val) = updates.get("loader").and_then(|v| v.as_str()) {
        let l = loader_val.to_lowercase();
        let supported = ["vanilla", "fabric", "forge"];
        if !supported.contains(&l.as_str()) {
            return Err(format!("Unsupported loader: {}", l));
        }
        current.loader = l.clone();
        if l == "vanilla" {
            current.modpack_info = None;
            current.hud_enabled = false;
        }
    }

    if let Some(lv) = updates.get("loaderVersion").and_then(|v| v.as_str()) {
        current.loader_version = if lv.trim().is_empty() {
            "latest".to_string()
        } else {
            lv.trim().to_string()
        };
    }

    if let Some(jr) = updates.get("javaRuntime").and_then(|v| v.as_str()) {
        current.java_runtime = if jr.trim().is_empty() {
            "auto".to_string()
        } else {
            jr.trim().to_string()
        };
    }

    if let Some(he) = updates.get("hudEnabled").and_then(|v| v.as_bool()) {
        current.hud_enabled = current.loader != "vanilla" && he;
    }

    if let Some(ram) = updates.get("ramMB").and_then(|v| v.as_u64()) {
        let rounded = ((ram as f64 / 256.0).round() as u32) * 256;
        current.ram_mb = rounded.clamp(1024, max_ram_mb.max(1024));
    }

    if let Some(last_played) = updates.get("lastPlayed") {
        current.last_played = last_played.as_str().map(|s| s.to_string());
    }

    if let Some(modpack) = updates.get("modpackInfo") {
        current.modpack_info = if current.loader == "vanilla" {
            None
        } else {
            Some(modpack.clone())
        };
    }

    ensure_profile_directories(&current.game_dir);
    current.installed = verify_installation_state(current, game_data_dir);
    current.content_counts = Some(get_content_counts(&current.game_dir, &current.loader));

    let updated_profile = current.clone();
    save_profiles(config_dir, &state);

    Ok(serde_json::json!({
        "profile": updated_profile,
        "state": state
    }))
}

pub fn delete_profile(
    config_dir: &str,
    game_data_dir: &str,
    id: &str,
) -> Result<ProfilesState, String> {
    let mut state = load_profiles(config_dir, game_data_dir);
    let idx = state
        .profiles
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("Profile not found: {}", id))?;

    state.profiles.remove(idx);
    if state.active_profile_id.as_deref() == Some(id) {
        state.active_profile_id = state.profiles.first().map(|p| p.id.clone());
    }
    save_profiles(config_dir, &state);
    Ok(state)
}

pub fn open_profile_folder(game_dir: &str) -> Result<(), String> {
    if !Path::new(game_dir).exists() {
        let _ = fs::create_dir_all(game_dir);
    }
    std::process::Command::new("explorer")
        .arg(game_dir)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}
