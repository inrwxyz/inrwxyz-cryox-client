//! Port of the parts of x_client's modrinthManager.js that were missing in the Rust version:
//!   * installProject  : vanilla rule, strict version match, safe file names, progress events, atomic write
//!   * installMrpackModpack : .mrpack modpacks (overrides + dependency downloads + profile update)
//!   * Performance Pack : Sodium / Lithium / Krypton / FerriteCore / ImmediatelyFast for Fabric profiles
//!   * retryPerformancePack : quiet retry on launch (every 12h at most)

use crate::modrinth::{get_content_folder, read_content_lock, read_local_mod_ids, read_scan_cache, write_content_lock, write_scan_cache, ContentLockItem, ScanEntry};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const API: &str = "https://api.modrinth.com/v2";
const UA: &str = "Cryox-Client-Launcher/1.0.0 (windows)";
const PERF_FILE: &str = "inex-perfpack.json";
const PERF_RETRY_MS: i64 = 12 * 60 * 60 * 1000;

struct PerfMod {
    slug: &'static str,
    title: &'static str,
    hints: &'static [&'static str],
}

const PERF_MODS: &[PerfMod] = &[
    PerfMod { slug: "sodium", title: "Sodium", hints: &["sodium"] },
    PerfMod { slug: "lithium", title: "Lithium", hints: &["lithium"] },
    PerfMod { slug: "krypton", title: "Krypton", hints: &["krypton"] },
    PerfMod { slug: "ferrite-core", title: "FerriteCore", hints: &["ferritecore", "ferrite-core"] },
    PerfMod { slug: "immediatelyfast", title: "ImmediatelyFast", hints: &["immediatelyfast"] },
];

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn emit_progress(app: &AppHandle, profile_id: &str, project_id: &str, stage: &str, percent: u32, detail: &str) {
    let _ = app.emit(
        "inex-event",
        json!({
            "channel": "event:install-progress",
            "data": {
                "profileId": profile_id,
                "projectId": project_id,
                "stage": stage,
                "percent": percent,
                "detail": detail
            }
        }),
    );
}

/// Last path component, works for both / and \ separators (like path.basename on user-controlled names).
fn base_name(name: &str) -> String {
    name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").trim().to_string()
}

/// validateSafeRelativePath: joins `rel` below `root` and refuses anything that could escape it.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = rel.replace('\\', "/");
    let clean = clean.trim_start_matches('/');
    if clean.is_empty() || clean.contains('\0') {
        return Err("Unsafe empty archive path".to_string());
    }
    let mut out = root.to_path_buf();
    for part in clean.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("Blocked unsafe path traversal attempt: {rel}"));
        }
        out.push(part);
    }
    if out == root {
        return Err(format!("Blocked unsafe path: {rel}"));
    }
    Ok(out)
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create folder: {e}"))?;
    }
    let tmp = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    fs::write(&tmp, bytes).map_err(|e| format!("Failed to save file: {e}"))?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save file: {e}")
    })
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn arr_has(v: &Value, key: &str, needle: &str) -> bool {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|a| a.iter().any(|x| x.as_str() == Some(needle)))
        .unwrap_or(false)
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// GET json. Network problems are prefixed with "OFFLINE:" so callers can tell them from real errors.
async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let res = client
        .get(url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("OFFLINE: could not reach Modrinth ({e})"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| format!("Invalid JSON from Modrinth: {e}"))
}

async fn download_bytes(client: &reqwest::Client, url: &str, sha1: Option<&str>, secs: u64) -> Result<Vec<u8>, String> {
    let res = client
        .get(url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(secs))
        .send()
        .await
        .map_err(|e| format!("OFFLINE: download failed ({e})"))?;
    if !res.status().is_success() {
        return Err(format!("download HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("OFFLINE: failed to read download ({e})"))?.to_vec();
    if let Some(expected) = sha1 {
        let got = sha1_hex(&bytes);
        if !got.eq_ignore_ascii_case(expected) {
            return Err(format!("SHA1 mismatch (expected {expected}, got {got})"));
        }
    }
    Ok(bytes)
}

fn primary_file(version: &Value) -> Option<&Value> {
    let files = version.get("files").and_then(|f| f.as_array())?;
    files
        .iter()
        .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        .or_else(|| files.first())
}

// ---------------------------------------------------------------------------------------------
// Version resolving
// ---------------------------------------------------------------------------------------------

/// getCompatibleVersions: all versions Modrinth lists for this project / Minecraft version / loader (newest first).
async fn get_compatible_versions(
    client: &reqwest::Client,
    project: &str,
    mc_version: &str,
    loader: &str,
    project_type: &str,
) -> Result<Vec<Value>, String> {
    let is_pack = matches!(project_type, "resourcepack" | "shader" | "datapack");
    let mut url = format!("{API}/project/{}/version", enc(project));
    let mut params: Vec<String> = Vec::new();
    if !mc_version.is_empty() {
        params.push(format!("game_versions={}", enc(&format!("[\"{mc_version}\"]"))));
    }
    if !is_pack && !loader.is_empty() && loader != "vanilla" {
        params.push(format!("loaders={}", enc(&format!("[\"{loader}\"]"))));
    }
    if !params.is_empty() {
        url.push('?');
        url.push_str(&params.join("&"));
    }
    let v = fetch_json(client, &url).await.map_err(|e| {
        if e.starts_with("OFFLINE:") {
            format!("Failed to connect to Modrinth: {e}")
        } else {
            format!("Modrinth version lookup failed: {e}")
        }
    })?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

/// Newest build that STRICTLY lists this exact Minecraft version + loader. Never a nearby version.
async fn resolve_strict_version(
    client: &reqwest::Client,
    slug_or_id: &str,
    mc_version: &str,
    loader: &str,
) -> Result<Option<Value>, String> {
    let url = format!(
        "{API}/project/{}/version?game_versions={}&loaders={}",
        enc(slug_or_id),
        enc(&format!("[\"{mc_version}\"]")),
        enc(&format!("[\"{loader}\"]"))
    );
    let v = fetch_json(client, &url).await?;
    let list = match v.as_array() {
        Some(l) => l,
        None => return Ok(None),
    };
    let mut ok: Vec<Value> = list
        .iter()
        .filter(|x| {
            arr_has(x, "game_versions", mc_version)
                && arr_has(x, "loaders", loader)
                && x.get("version_type").and_then(|t| t.as_str()) != Some("alpha")
                && x.get("files")
                    .and_then(|f| f.as_array())
                    .map(|f| f.iter().any(|file| file.get("url").and_then(|u| u.as_str()).is_some()))
                    .unwrap_or(false)
        })
        .cloned()
        .collect();
    if ok.is_empty() {
        return Ok(None);
    }
    ok.sort_by(|a, b| str_of(b, "date_published").cmp(str_of(a, "date_published")));
    let pick = ok
        .iter()
        .find(|x| x.get("version_type").and_then(|t| t.as_str()) == Some("release"))
        .cloned()
        .or_else(|| ok.first().cloned());
    Ok(pick)
}

// ---------------------------------------------------------------------------------------------
// Normal content install (mods, resource packs, shaders, data packs, modpacks)
// ---------------------------------------------------------------------------------------------

pub async fn install_content(
    app: &AppHandle,
    profile_id: &str,
    project_id: &str,
    project_type: &str,
    title: &str,
    author: &str,
    icon_url: &str,
) -> Result<Value, String> {
    let settings = crate::settings::SettingsManager::new().get_settings();
    let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let max_ram = settings.get("maxRamMB").and_then(|v| v.as_u64()).unwrap_or(16384) as u32;

    let state = crate::profiles::list_profiles(&config_dir, &game_data_dir);
    let profile = state
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .or_else(|| state.profiles.iter().find(|p| Some(&p.id) == state.active_profile_id.as_ref()))
        .cloned()
        .ok_or_else(|| "No active profile selected for installation.".to_string())?;

    let project_type = if project_type.is_empty() { "mod" } else { project_type };

    // Vanilla rule: no mods / modpacks on vanilla profiles
    if (project_type == "mod" || project_type == "modpack") && profile.loader == "vanilla" {
        return Err(format!(
            "Profile \"{}\" uses Vanilla Minecraft. Modding and modpacks are not permitted on official Vanilla profiles according to vanilla rules. Please switch this profile to Fabric or Forge to install mods.",
            profile.name
        ));
    }

    emit_progress(
        app,
        &profile.id,
        project_id,
        "Resolving compatible version",
        10,
        &format!("Auto-matching {project_type} for created profile version Minecraft {} ({})...", profile.version, profile.loader),
    );

    let client = reqwest::Client::new();
    let versions = get_compatible_versions(&client, project_id, &profile.version, &profile.loader, project_type).await?;
    if versions.is_empty() {
        let name = if title.is_empty() { project_id } else { title };
        return Err(format!(
            "No compatible release of \"{name}\" found for created Minecraft version {} ({}).",
            profile.version, profile.loader
        ));
    }

    // strictly the profile's Minecraft version, never a newer one
    let is_pack = matches!(project_type, "resourcepack" | "shader" | "datapack");
    let fits = |v: &&Value| {
        arr_has(v, "game_versions", &profile.version)
            && (is_pack || profile.loader == "vanilla" || arr_has(v, "loaders", &profile.loader))
    };
    let vtype = |v: &&Value| v.get("version_type").and_then(|t| t.as_str()).unwrap_or("release").to_string();
    // newest stable release first (a newer beta of one mod can be incompatible with the stable build of another,
    // e.g. Sodium 0.9.3-beta.4 vs Iris 1.11.7); beta only when there is no release; alpha only as the very last resort
    let matched = versions
        .iter()
        .find(|v| fits(v) && vtype(v) == "release")
        .or_else(|| versions.iter().find(|v| fits(v) && vtype(v) == "beta"))
        .or_else(|| versions.iter().find(|v| fits(v)))
        .or_else(|| versions.first())
        .cloned()
        .ok_or_else(|| "No version returned by Modrinth.".to_string())?;

    let file = primary_file(&matched).cloned();
    let (file_url, file_name) = match &file {
        Some(f) if f.get("url").and_then(|u| u.as_str()).is_some() => (
            str_of(f, "url").to_string(),
            base_name(str_of(f, "filename")),
        ),
        _ => {
            return Err(format!(
                "Downloadable file missing on Modrinth for {} version {}",
                if title.is_empty() { project_id } else { title },
                str_of(&matched, "version_number")
            ))
        }
    };
    if file_name.is_empty() {
        return Err("Modrinth returned a file without a name.".to_string());
    }
    let file_obj = file.unwrap_or(Value::Null);

    if project_type == "modpack" || file_name.to_lowercase().ends_with(".mrpack") {
        let nice_title = if title.is_empty() { str_of(&matched, "name") } else { title };
        return install_mrpack(
            app,
            &client,
            &config_dir,
            &game_data_dir,
            max_ram,
            &profile.id,
            &profile.game_dir,
            project_id,
            nice_title,
            author,
            icon_url,
            &matched,
            &file_obj,
        )
        .await;
    }

    let folder = get_content_folder(project_type);
    let target_dir = Path::new(&profile.game_dir).join(folder);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let dest = safe_join(&target_dir, &file_name)?;

    emit_progress(
        app,
        &profile.id,
        project_id,
        "Downloading content",
        45,
        &format!("Downloading {file_name} for Minecraft {}...", profile.version),
    );

    let expected = file_obj.get("hashes").and_then(|h| h.get("sha1")).and_then(|s| s.as_str());
    let bytes = download_bytes(&client, &file_url, expected, 120)
        .await
        .map_err(|e| e.trim_start_matches("OFFLINE: ").to_string())?;
    write_atomic(&dest, &bytes)?;

    let mut lock = read_content_lock(&profile.game_dir);
    lock.items.insert(
        file_name.clone(),
        ContentLockItem {
            project_id: Some(project_id.to_string()),
            version_id: Some(str_of(&matched, "id").to_string()),
            title: Some(if title.is_empty() { file_name.clone() } else { title.to_string() }),
            author: Some(if author.is_empty() { "Modrinth".to_string() } else { author.to_string() }),
            version_number: Some(str_of(&matched, "version_number").to_string()),
            icon_url: Some(icon_url.to_string()),
            project_type: Some(project_type.to_string()),
        },
    );
    write_content_lock(&profile.game_dir, &lock);

    emit_progress(
        app,
        &profile.id,
        project_id,
        "Installed",
        100,
        &format!("Installed {} for Minecraft {} into {}", if title.is_empty() { file_name.as_str() } else { title }, profile.version, profile.name),
    );

    let items = crate::modrinth::list_installed_content(&profile.game_dir, project_type);
    Ok(json!({
        "installed": true,
        "fileName": file_name,
        "profileId": profile.id,
        "projectType": project_type,
        "versionNumber": str_of(&matched, "version_number"),
        "items": items
    }))
}

// ---------------------------------------------------------------------------------------------
// .mrpack modpacks
// ---------------------------------------------------------------------------------------------

/// Sync part (no awaits): reads modrinth.index.json and extracts overrides/ + client-overrides/ safely.
fn extract_mrpack(bytes: Vec<u8>, game_dir: &Path) -> Result<Value, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Invalid .mrpack archive: {e}"))?;

    let index: Value = {
        let mut f = archive
            .by_name("modrinth.index.json")
            .map_err(|_| "Invalid .mrpack archive: modrinth.index.json is missing.".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| format!("Could not read modrinth.index.json: {e}"))?;
        serde_json::from_str(&s).map_err(|e| format!("Invalid modrinth.index.json: {e}"))?
    };

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let rel = if let Some(r) = name.strip_prefix("overrides/") {
            r.to_string()
        } else if let Some(r) = name.strip_prefix("client-overrides/") {
            r.to_string()
        } else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let dest = safe_join(game_dir, &rel)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&dest).map_err(|e| format!("Could not write {rel}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Could not extract {rel}: {e}"))?;
    }
    Ok(index)
}

#[allow(clippy::too_many_arguments)]
async fn install_mrpack(
    app: &AppHandle,
    client: &reqwest::Client,
    config_dir: &str,
    game_data_dir: &str,
    max_ram: u32,
    profile_id: &str,
    game_dir: &str,
    project_id: &str,
    title: &str,
    author: &str,
    icon_url: &str,
    version_obj: &Value,
    file: &Value,
) -> Result<Value, String> {
    let filename = str_of(file, "filename").to_string();
    emit_progress(app, profile_id, project_id, "Downloading Modpack archive", 20, &format!("Downloading {filename}..."));

    let expected = file.get("hashes").and_then(|h| h.get("sha1")).and_then(|s| s.as_str());
    let archive = download_bytes(client, str_of(file, "url"), expected, 300)
        .await
        .map_err(|e| {
            let e = e.trim_start_matches("OFFLINE: ").to_string();
            format!("Failed to download modpack archive: {e}")
        })?;

    emit_progress(app, profile_id, project_id, "Extracting Modpack overrides", 35, "Applying configuration and resource overrides...");
    let root = PathBuf::from(game_dir);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let index = extract_mrpack(archive, &root)?;

    let pack_files: Vec<Value> = index.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let client_files: Vec<&Value> = pack_files
        .iter()
        .filter(|f| f.get("env").and_then(|e| e.get("client")).and_then(|c| c.as_str()) != Some("unsupported"))
        .collect();
    let total = client_files.len();
    let pack_name = index.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).unwrap_or(title).to_string();
    let pack_version = index.get("versionId").and_then(|n| n.as_str()).unwrap_or("").to_string();

    let mut lock = read_content_lock(game_dir);
    let mut completed = 0usize;

    for spec in &client_files {
        let rel = str_of(spec, "path").to_string();
        let dest = safe_join(&root, &rel)?;
        let url = match spec.get("downloads").and_then(|d| d.as_array()).and_then(|d| d.first()).and_then(|u| u.as_str()) {
            Some(u) => u.to_string(),
            None => continue,
        };
        let sha = spec.get("hashes").and_then(|h| h.get("sha1")).and_then(|s| s.as_str());
        let data = download_bytes(client, &url, sha, 180).await.map_err(|e| {
            format!("Failed to download modpack dependency {rel}: {}", e.trim_start_matches("OFFLINE: "))
        })?;
        write_atomic(&dest, &data)?;

        let base = base_name(&rel);
        let ptype = if rel.starts_with("resourcepacks/") {
            "resourcepack"
        } else if rel.starts_with("shaderpacks/") {
            "shader"
        } else {
            "mod"
        };
        lock.items.insert(
            base.clone(),
            ContentLockItem {
                project_id: None,
                version_id: None,
                title: Some(base.clone()),
                author: Some(if title.is_empty() { pack_name.clone() } else { title.to_string() }),
                version_number: Some(pack_version.clone()),
                icon_url: Some(icon_url.to_string()),
                project_type: Some(ptype.to_string()),
            },
        );

        completed += 1;
        let pct = 35 + ((completed as f64 / total.max(1) as f64) * 60.0).round() as u32;
        emit_progress(
            app,
            profile_id,
            project_id,
            "Installing Modpack mods & assets",
            pct,
            &format!("Downloaded ({completed}/{total}): {base}"),
        );
    }
    write_content_lock(game_dir, &lock);

    // profile follows the pack's own dependencies
    let deps = index.get("dependencies").cloned().unwrap_or(json!({}));
    let mut updates = Map::new();
    updates.insert(
        "modpackInfo".to_string(),
        json!({
            "projectId": project_id,
            "name": pack_name,
            "versionId": if pack_version.is_empty() { str_of(version_obj, "version_number").to_string() } else { pack_version.clone() },
            "author": author,
            "iconUrl": icon_url
        }),
    );
    if let Some(mc) = deps.get("minecraft").and_then(|v| v.as_str()) {
        updates.insert("version".to_string(), json!(mc));
    }
    if let Some(fl) = deps.get("fabric-loader").and_then(|v| v.as_str()) {
        updates.insert("loader".to_string(), json!("fabric"));
        updates.insert("loaderVersion".to_string(), json!(fl));
    } else if deps.get("quilt-loader").is_some() {
        // Quilt is not supported: Quilt packs load Fabric mods
        updates.insert("loader".to_string(), json!("fabric"));
        updates.insert("loaderVersion".to_string(), json!("latest"));
    } else if let Some(fg) = deps.get("forge").and_then(|v| v.as_str()) {
        updates.insert("loader".to_string(), json!("forge"));
        updates.insert("loaderVersion".to_string(), json!(fg));
    } else if deps.get("neoforge").is_some() {
        return Err("This modpack needs NeoForge, which CRYOX CLIENT does not support (only Vanilla, Fabric and Forge).".to_string());
    }
    crate::profiles::update_profile(config_dir, game_data_dir, profile_id, Value::Object(updates), max_ram)?;

    emit_progress(
        app,
        profile_id,
        project_id,
        "Modpack installed",
        100,
        &format!("Installed modpack \"{pack_name}\" ({total} files)"),
    );

    Ok(json!({
        "installed": true,
        "isModpack": true,
        "filesInstalled": total,
        "profileId": profile_id,
        "modpackName": pack_name
    }))
}

// ---------------------------------------------------------------------------------------------
// Performance Pack (Fabric only)
// ---------------------------------------------------------------------------------------------

struct PerfErr {
    unavailable: bool,
    msg: String,
}

fn read_perf_state(game_dir: &str) -> Option<Value> {
    fs::read_to_string(Path::new(game_dir).join(PERF_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

fn write_perf_state(game_dir: &str, state: &Value) {
    let _ = fs::create_dir_all(game_dir);
    if let Ok(s) = serde_json::to_string_pretty(state) {
        let _ = fs::write(Path::new(game_dir).join(PERF_FILE), s);
    }
}

fn is_mod_present(game_dir: &str, project_id: Option<&str>, hints: &[&str]) -> bool {
    let dir = Path::new(game_dir).join("mods");
    let files: Vec<String> = fs::read_dir(&dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect::<Vec<String>>())
        .unwrap_or_default();
    if let Some(pid) = project_id {
        let lock = read_content_lock(game_dir);
        for (name, meta) in lock.items.iter() {
            if meta.project_id.as_deref() == Some(pid) {
                let l = name.to_lowercase();
                if files.contains(&l) || files.contains(&format!("{l}.disabled")) {
                    return true;
                }
            }
        }
    }
    files.iter().any(|f| hints.iter().any(|h| f.contains(h)))
}

async fn download_mod_file(client: &reqwest::Client, game_dir: &str, mc: &str, version: &Value, title: &str) -> Result<String, String> {
    let file = primary_file(version).ok_or_else(|| "no jar file".to_string())?;
    let url = file.get("url").and_then(|u| u.as_str()).ok_or_else(|| "no jar file".to_string())?;
    let name = base_name(str_of(file, "filename"));
    if !name.to_lowercase().ends_with(".jar") {
        return Err("no jar file".to_string());
    }
    let sha1 = file
        .get("hashes")
        .and_then(|h| h.get("sha1"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "no hash from Modrinth, refusing to install".to_string())?;

    let mods_dir = Path::new(game_dir).join("mods");
    let dest = safe_join(&mods_dir, &name)?;
    let bytes = download_bytes(client, url, Some(sha1), 120).await?;
    write_atomic(&dest, &bytes)?;

    let mut lock = read_content_lock(game_dir);
    lock.items.insert(
        name.clone(),
        ContentLockItem {
            project_id: version.get("project_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            version_id: version.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            title: Some(title.to_string()),
            author: Some("Modrinth".to_string()),
            version_number: version.get("version_number").and_then(|v| v.as_str()).map(|s| s.to_string()),
            icon_url: Some(String::new()),
            project_type: Some("mod".to_string()),
        },
    );
    let _ = mc; // kept for parity with the JS signature (lock stores mcVersion there)
    write_content_lock(game_dir, &lock);
    Ok(name)
}

/// One mod plus its REQUIRED dependencies.
async fn install_perf_mod(client: &reqwest::Client, game_dir: &str, mc: &str, m: &PerfMod) -> Result<String, PerfErr> {
    let version = resolve_strict_version(client, m.slug, mc, "fabric")
        .await
        .map_err(|e| PerfErr { unavailable: false, msg: e })?
        .ok_or_else(|| PerfErr { unavailable: true, msg: format!("not available for Minecraft {mc} yet") })?;

    let mut seen: HashSet<String> = HashSet::new();
    if let Some(deps) = version.get("dependencies").and_then(|d| d.as_array()) {
        for d in deps {
            if d.get("dependency_type").and_then(|x| x.as_str()) != Some("required") {
                continue;
            }
            let pid = match d.get("project_id").and_then(|x| x.as_str()) {
                Some(p) if !p.is_empty() => p.to_string(),
                _ => continue,
            };
            if !seen.insert(pid.clone()) {
                continue;
            }
            if is_mod_present(game_dir, Some(&pid), &[]) {
                continue;
            }
            let dep_version = resolve_strict_version(client, &pid, mc, "fabric")
                .await
                .map_err(|e| PerfErr { unavailable: false, msg: e })?
                .ok_or_else(|| PerfErr {
                    unavailable: true,
                    msg: format!("needs a library that is not available for Minecraft {mc} yet"),
                })?;
            let dep_pid = str_of(&dep_version, "project_id").to_string();
            if !is_mod_present(game_dir, Some(&dep_pid), &[]) {
                let dep_title = {
                    let n = str_of(&dep_version, "name");
                    if n.is_empty() { pid.clone() } else { n.to_string() }
                };
                download_mod_file(client, game_dir, mc, &dep_version, &dep_title)
                    .await
                    .map_err(|e| PerfErr { unavailable: false, msg: e })?;
            }
        }
    }
    download_mod_file(client, game_dir, mc, &version, m.title)
        .await
        .map_err(|e| PerfErr { unavailable: false, msg: e })
}

/// Installs the Performance Pack into a Fabric profile. Never fails for "normal" problems (offline, mod not
/// released yet) and never touches mods the player already has. `only` restricts the run (retries).
pub async fn install_performance_pack(
    app: &AppHandle,
    profile_id: &str,
    game_dir: &str,
    mc: &str,
    loader: &str,
    only: Option<Vec<String>>,
) -> Value {
    if loader != "fabric" {
        return json!({ "skipped": "not-fabric", "results": {} });
    }
    let prev = read_perf_state(game_dir);
    let mut results: Map<String, Value> = prev
        .as_ref()
        .and_then(|p| p.get("results"))
        .and_then(|r| r.as_object())
        .cloned()
        .unwrap_or_default();

    let list: Vec<&PerfMod> = PERF_MODS
        .iter()
        .filter(|m| only.as_ref().map(|o| o.iter().any(|s| s.as_str() == m.slug)).unwrap_or(true))
        .collect();
    let total = list.len().max(1);
    let client = reqwest::Client::new();
    let mut done = 0usize;

    for (idx, m) in list.iter().enumerate() {
        let pct = ((done as f64 / total as f64) * 95.0).round() as u32;
        emit_progress(app, profile_id, "", "Performance Pack", pct, &format!("Checking {} for Minecraft {mc}...", m.title));
        let at = chrono::Utc::now().to_rfc3339();

        if is_mod_present(game_dir, None, m.hints) {
            results.insert(m.slug.to_string(), json!({ "status": "present", "at": at }));
        } else {
            match install_perf_mod(&client, game_dir, mc, m).await {
                Ok(file) => {
                    results.insert(m.slug.to_string(), json!({ "status": "installed", "file": file, "at": at }));
                }
                Err(e) => {
                    let offline = !e.unavailable && e.msg.starts_with("OFFLINE:");
                    let reason = if offline { "offline".to_string() } else { e.msg.clone() };
                    results.insert(
                        m.slug.to_string(),
                        json!({ "status": if e.unavailable { "unavailable" } else { "error" }, "reason": reason, "at": at }),
                    );
                    if offline {
                        // no point asking the other mods when there is no connection
                        for rest in list.iter().skip(idx + 1) {
                            if !results.contains_key(rest.slug) {
                                results.insert(rest.slug.to_string(), json!({ "status": "error", "reason": "offline", "at": at }));
                            }
                        }
                        break;
                    }
                }
            }
        }
        done += 1;
    }

    let installed = results
        .values()
        .filter(|r| r.get("status").and_then(|s| s.as_str()) == Some("installed"))
        .count();
    let state = json!({
        "enabled": true,
        "mcVersion": mc,
        "lastTriedAt": chrono::Utc::now().timestamp_millis(),
        "results": Value::Object(results.clone())
    });
    write_perf_state(game_dir, &state);
    emit_progress(app, profile_id, "", "Installed", 100, &format!("Performance Pack: {installed} mod(s) installed"));
    json!({ "results": Value::Object(results), "installed": installed })
}

/// Called on launch: quietly retries ONLY mods that were "unavailable"/"error" before (never ones the user removed).
/// Returns the slugs that were installed this time (so the launcher can log them).
pub async fn retry_performance_pack(app: &AppHandle, profile_id: &str, game_dir: &str, mc: &str, loader: &str) -> Vec<String> {
    if loader != "fabric" {
        return Vec::new();
    }
    let state = match read_perf_state(game_dir) {
        Some(s) => s,
        None => return Vec::new(),
    };
    if state.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
        return Vec::new();
    }
    if let Some(saved_mc) = state.get("mcVersion").and_then(|v| v.as_str()) {
        if !saved_mc.is_empty() && saved_mc != mc {
            return Vec::new();
        }
    }
    let pending: Vec<String> = state
        .get("results")
        .and_then(|r| r.as_object())
        .map(|o| {
            o.iter()
                .filter(|(_, r)| matches!(r.get("status").and_then(|s| s.as_str()), Some("unavailable") | Some("error")))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    if pending.is_empty() {
        return Vec::new();
    }
    if let Some(last) = state.get("lastTriedAt").and_then(|v| v.as_i64()) {
        if chrono::Utc::now().timestamp_millis() - last < PERF_RETRY_MS {
            return Vec::new();
        }
    }
    let out = install_performance_pack(app, profile_id, game_dir, mc, loader, Some(pending.clone())).await;
    let mut newly = Vec::new();
    if let Some(res) = out.get("results").and_then(|r| r.as_object()) {
        for slug in pending {
            if res.get(&slug).and_then(|r| r.get("status")).and_then(|s| s.as_str()) == Some("installed") {
                newly.push(slug);
            }
        }
    }
    newly
}

// ---------------------------------------------------------------------------------------------
// Installed content: icons + "new version available" (works for files installed in any way, via SHA1 lookup)
// ---------------------------------------------------------------------------------------------

pub fn find_profile(profile_id: &str) -> Result<crate::profiles::Profile, String> {
    let settings = crate::settings::SettingsManager::new().get_settings();
    let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let game_data_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let state = crate::profiles::list_profiles(&config_dir, &game_data_dir);
    state
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .or_else(|| state.profiles.iter().find(|p| Some(&p.id) == state.active_profile_id.as_ref()))
        .cloned()
        .ok_or_else(|| format!("Profile not found: {profile_id}"))
}

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<Value, String> {
    let res = client
        .post(url)
        .header("User-Agent", UA)
        .json(body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("OFFLINE: could not reach Modrinth ({e})"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| format!("Invalid JSON from Modrinth: {e}"))
}

/// (sha1, file name on disk, file name without ".disabled") for every file of a content folder.
fn hash_folder(dir: &Path) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            if let Ok(meta) = p.metadata() {
                if meta.len() > 200 * 1024 * 1024 {
                    continue;
                }
            }
            let name = e.file_name().to_string_lossy().to_string();
            let base = name.strip_suffix(".disabled").unwrap_or(&name).to_string();
            if let Some(sha1) = crate::installer::compute_file_sha1(&p) {
                out.push((sha1, name, base));
            }
        }
    }
    out
}

/// Looks every file up on Modrinth by SHA1 and writes project id / version / title / icon of the ones it knows into the content lock.
/// Returns the raw answer (sha1 -> version object).
async fn identify_into_lock(
    client: &reqwest::Client,
    profile: &crate::profiles::Profile,
    project_type: &str,
    hashed: &[(String, String, String)],
) -> Result<Value, String> {
    let hashes: Vec<String> = hashed.iter().map(|h| h.0.clone()).collect();
    let ident = post_json(client, &format!("{API}/version_files"), &json!({ "hashes": hashes, "algorithm": "sha1" })).await?;

    let mut lock = read_content_lock(&profile.game_dir);
    let mut need_projects: Vec<String> = Vec::new();
    for (hash, _file, base) in hashed.iter() {
        let ver = match ident.get(hash) {
            Some(v) => v,
            None => continue,
        };
        let pid = str_of(ver, "project_id").to_string();
        if pid.is_empty() {
            continue;
        }
        let entry = lock.items.entry(base.clone()).or_insert(ContentLockItem {
            project_id: None,
            version_id: None,
            title: None,
            author: None,
            version_number: None,
            icon_url: None,
            project_type: Some(project_type.to_string()),
        });
        entry.project_id = Some(pid.clone());
        entry.version_id = Some(str_of(ver, "id").to_string());
        entry.version_number = Some(str_of(ver, "version_number").to_string());
        let no_icon = entry.icon_url.as_deref().map(|s| s.is_empty()).unwrap_or(true);
        let no_title = entry.title.as_deref().map(|t| t.is_empty() || t == base.as_str()).unwrap_or(true);
        if (no_icon || no_title) && !need_projects.contains(&pid) {
            need_projects.push(pid);
        }
    }

    // project titles + icons
    let mut meta: HashMap<String, (String, String)> = HashMap::new();
    for chunk in need_projects.chunks(50) {
        let ids = serde_json::to_string(chunk).unwrap_or_else(|_| "[]".to_string());
        if let Ok(v) = fetch_json(client, &format!("{API}/projects?ids={}", enc(&ids))).await {
            if let Some(arr) = v.as_array() {
                for p in arr {
                    meta.insert(str_of(p, "id").to_string(), (str_of(p, "title").to_string(), str_of(p, "icon_url").to_string()));
                }
            }
        }
    }
    for (hash, _file, base) in hashed.iter() {
        let pid = match ident.get(hash) {
            Some(v) => str_of(v, "project_id").to_string(),
            None => continue,
        };
        if let (Some((title, icon)), Some(entry)) = (meta.get(&pid), lock.items.get_mut(base)) {
            if !icon.is_empty() && entry.icon_url.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                entry.icon_url = Some(icon.clone());
            }
            if !title.is_empty() && entry.title.as_deref().map(|t| t.is_empty() || t == base.as_str()).unwrap_or(true) {
                entry.title = Some(title.clone());
            }
        }
    }
    write_content_lock(&profile.game_dir, &lock);
    Ok(ident)
}

static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Makes sure every file in the profile's content folder is known. A file that is new or changed (size / mtime) is looked up on
/// Modrinth by SHA1 and its mod id is read from the jar, so mods that were copied in by hand are recognised as "installed" too.
/// Every file is looked at only once; nothing happens when nothing changed. Never fails: offline just means "try again next time".
pub async fn sync_installed_content(profile: &crate::profiles::Profile, project_type: &str) {
    let project_type = if project_type.is_empty() { "mod" } else { project_type };
    let _guard = SYNC_LOCK.lock().await;
    let folder = get_content_folder(project_type);
    let is_mod = project_type.eq_ignore_ascii_case("mod");
    let game_dir = profile.game_dir.clone();

    let gd = game_dir.clone();
    let scan = tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&gd).join(folder);
        let prefix = format!("{folder}/");
        let lock = read_content_lock(&gd);
        let mut cache = read_scan_cache(&gd);
        let mut seen: HashSet<String> = HashSet::new();
        let mut hashed: Vec<(String, String, String)> = Vec::new();
        let mut pending: Vec<String> = Vec::new();

        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let meta = match e.metadata() {
                    Ok(m) if m.is_file() => m,
                    _ => continue,
                };
                let name = e.file_name().to_string_lossy().to_string();
                let base = if name.to_lowercase().ends_with(".disabled") {
                    name[..name.len() - ".disabled".len()].to_string()
                } else {
                    name.clone()
                };
                let lower = base.to_lowercase();
                let valid = if folder == "mods" { lower.ends_with(".jar") } else { lower.ends_with(".zip") };
                if !valid {
                    continue;
                }

                let size = meta.len();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let key = format!("{prefix}{base}");
                seen.insert(key.clone());

                let fresh = cache.get(&key).map(|c| c.size == size && c.mtime == mtime).unwrap_or(false);
                let mut entry = if fresh {
                    cache.get(&key).cloned().unwrap_or_default()
                } else {
                    ScanEntry { size, mtime, ids: Vec::new(), checked: false }
                };
                if !fresh && is_mod {
                    entry.ids = read_local_mod_ids(&p);
                }

                // installed through the launcher and already fully described in the lock: nothing to look up
                let known = lock
                    .items
                    .get(&base)
                    .map(|m| {
                        m.project_id.as_deref().map_or(false, |s| !s.is_empty())
                            && m.title.as_deref().map_or(false, |t| !t.is_empty() && t != base.as_str())
                    })
                    .unwrap_or(false);
                if known {
                    entry.checked = true;
                } else if !entry.checked && size <= 200 * 1024 * 1024 {
                    if let Some(sha1) = crate::installer::compute_file_sha1(&p) {
                        hashed.push((sha1, name.clone(), base.clone()));
                        pending.push(key.clone());
                    }
                }
                cache.insert(key, entry);
            }
        }
        // forget files that are gone, so deleting and re-adding the same file is detected again
        cache.retain(|k, _| !k.starts_with(&prefix) || seen.contains(k));
        (hashed, pending, cache)
    })
    .await;

    let (hashed, pending, mut cache) = match scan {
        Ok(v) => v,
        Err(_) => return,
    };

    if !hashed.is_empty() {
        let client = reqwest::Client::new();
        if identify_into_lock(&client, profile, project_type, &hashed).await.is_ok() {
            for k in pending {
                if let Some(c) = cache.get_mut(&k) {
                    c.checked = true;
                }
            }
        }
    }
    let _ = tauri::async_runtime::spawn_blocking(move || write_scan_cache(&game_dir, &cache)).await;
}

/// 1) identifies every file on Modrinth by its SHA1 and fills missing title / icon / project id / version in the lock,
/// 2) asks Modrinth for the newest release for this profile's Minecraft version + loader.
/// Returns { items, updates: [{ fileName, baseFileName, projectId, currentVersion, newVersionId, newVersionNumber, newFileName }] }.
pub async fn check_content_updates(profile_id: &str, project_type: &str) -> Result<Value, String> {
    let profile = find_profile(profile_id)?;
    let project_type = if project_type.is_empty() { "mod" } else { project_type };
    let dir = Path::new(&profile.game_dir).join(get_content_folder(project_type));
    let dir_for_thread = dir.clone();
    let hashed = tauri::async_runtime::spawn_blocking(move || hash_folder(&dir_for_thread))
        .await
        .map_err(|e| e.to_string())?;

    if hashed.is_empty() {
        return Ok(json!({ "items": crate::modrinth::list_installed_content(&profile.game_dir, project_type), "updates": [], "checked": 0 }));
    }

    let client = reqwest::Client::new();
    let hashes: Vec<String> = hashed.iter().map(|h| h.0.clone()).collect();
    let ident = identify_into_lock(&client, &profile, project_type, &hashed).await?;

    // newest compatible release for every file
    let is_pack = matches!(project_type, "resourcepack" | "shader" | "datapack");
    let mut body = json!({ "hashes": hashes, "algorithm": "sha1", "game_versions": [profile.version.clone()] });
    if !is_pack && profile.loader != "vanilla" {
        body["loaders"] = json!([profile.loader.clone()]);
    }
    let latest = post_json(&client, &format!("{API}/version_files/update"), &body).await.ok();

    let mut updates: Vec<Value> = Vec::new();
    if let Some(l) = latest.as_ref().and_then(|v| v.as_object()) {
        for (hash, file_name, base) in hashed.iter() {
            let nv = match l.get(hash) {
                Some(v) => v,
                None => continue,
            };
            if nv.get("version_type").and_then(|t| t.as_str()) == Some("alpha") {
                continue;
            }
            // already the newest build?
            let same = nv
                .get("files")
                .and_then(|f| f.as_array())
                .map(|f| {
                    f.iter().any(|x| {
                        x.get("hashes")
                            .and_then(|h| h.get("sha1"))
                            .and_then(|s| s.as_str())
                            .map(|s| s.eq_ignore_ascii_case(hash))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if same {
                continue;
            }
            let cur = ident.get(hash);
            let cur_id = cur.map(|v| str_of(v, "id")).unwrap_or("");
            if !cur_id.is_empty() && cur_id == str_of(nv, "id") {
                continue;
            }
            let cur_date = cur.map(|v| str_of(v, "date_published")).unwrap_or("");
            if !cur_date.is_empty() && str_of(nv, "date_published") <= cur_date {
                continue;
            }
            let new_file = primary_file(nv).map(|f| base_name(str_of(f, "filename"))).unwrap_or_default();
            updates.push(json!({
                "fileName": file_name,
                "baseFileName": base,
                "projectId": str_of(nv, "project_id"),
                "currentVersion": cur.map(|v| str_of(v, "version_number")).unwrap_or(""),
                "newVersionId": str_of(nv, "id"),
                "newVersionNumber": str_of(nv, "version_number"),
                "newFileName": new_file
            }));
        }
    }

    Ok(json!({
        "items": crate::modrinth::list_installed_content(&profile.game_dir, project_type),
        "updates": updates,
        "checked": hashed.len()
    }))
}

/// Replaces one installed file with a newer release (keeps it disabled if it was disabled).
pub async fn update_content(
    app: &AppHandle,
    profile_id: &str,
    project_type: &str,
    file_name: &str,
    version_id: &str,
) -> Result<Value, String> {
    let profile = find_profile(profile_id)?;
    let project_type = if project_type.is_empty() { "mod" } else { project_type };
    if version_id.is_empty() || file_name.is_empty() {
        return Err("Missing file or version for the update.".to_string());
    }
    let client = reqwest::Client::new();
    let ver = fetch_json(&client, &format!("{API}/version/{}", enc(version_id)))
        .await
        .map_err(|e| format!("Could not load the new version: {}", e.trim_start_matches("OFFLINE: ")))?;
    if !arr_has(&ver, "game_versions", &profile.version) {
        return Err(format!("That release does not list Minecraft {}.", profile.version));
    }
    let file = primary_file(&ver).cloned().ok_or_else(|| "The new version has no downloadable file.".to_string())?;
    let url = str_of(&file, "url").to_string();
    let new_name = base_name(str_of(&file, "filename"));
    if url.is_empty() || new_name.is_empty() {
        return Err("The new version has no downloadable file.".to_string());
    }

    let dir = Path::new(&profile.game_dir).join(get_content_folder(project_type));
    let old_path = safe_join(&dir, &base_name(file_name))?;
    let was_disabled = file_name.ends_with(".disabled");
    let old_base = file_name.strip_suffix(".disabled").unwrap_or(file_name).to_string();

    emit_progress(app, &profile.id, str_of(&ver, "project_id"), "Updating", 30, &format!("Downloading {new_name}..."));
    let expected = file.get("hashes").and_then(|h| h.get("sha1")).and_then(|s| s.as_str());
    let bytes = download_bytes(&client, &url, expected, 180)
        .await
        .map_err(|e| e.trim_start_matches("OFFLINE: ").to_string())?;

    let dest_name = if was_disabled { format!("{new_name}.disabled") } else { new_name.clone() };
    let dest = safe_join(&dir, &dest_name)?;
    write_atomic(&dest, &bytes)?;
    if old_path != dest && old_path.exists() {
        let _ = fs::remove_file(&old_path);
    }

    let mut lock = read_content_lock(&profile.game_dir);
    let old_meta = lock.items.remove(&old_base);
    let (title, author, icon) = match &old_meta {
        Some(m) => (m.title.clone(), m.author.clone(), m.icon_url.clone()),
        None => (None, None, None),
    };
    lock.items.insert(
        new_name.clone(),
        ContentLockItem {
            project_id: Some(str_of(&ver, "project_id").to_string()),
            version_id: Some(version_id.to_string()),
            title: title.or_else(|| Some(new_name.clone())),
            author: author.or_else(|| Some("Modrinth".to_string())),
            version_number: Some(str_of(&ver, "version_number").to_string()),
            icon_url: icon,
            project_type: Some(project_type.to_string()),
        },
    );
    write_content_lock(&profile.game_dir, &lock);
    emit_progress(app, &profile.id, str_of(&ver, "project_id"), "Updated", 100, &format!("Updated to {}", str_of(&ver, "version_number")));

    Ok(json!({
        "updated": true,
        "fileName": dest_name,
        "items": crate::modrinth::list_installed_content(&profile.game_dir, project_type)
    }))
}
