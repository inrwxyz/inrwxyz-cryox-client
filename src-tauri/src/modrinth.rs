use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentLockItem {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub version_number: Option<String>,
    pub icon_url: Option<String>,
    pub project_type: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContentLock {
    #[serde(default)]
    pub items: HashMap<String, ContentLockItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledItem {
    pub file_name: String,
    pub name: String,
    pub title: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub size_bytes: u64,
    pub enabled: bool,
    pub icon_url: Option<String>,
}

pub fn get_content_folder(project_type: &str) -> &'static str {
    match project_type.to_lowercase().as_str() {
        "mod" => "mods",
        "shader" => "shaderpacks",
        "resourcepack" => "resourcepacks",
        "datapack" => "datapacks",
        _ => "mods",
    }
}

pub fn read_content_lock(game_dir: &str) -> ContentLock {
    let p = Path::new(game_dir).join("inex-content-lock.json");
    if p.exists() {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(lock) = serde_json::from_str::<ContentLock>(&raw) {
                return lock;
            }
        }
    }
    ContentLock::default()
}

pub fn write_content_lock(game_dir: &str, lock: &ContentLock) {
    let p = Path::new(game_dir).join("inex-content-lock.json");
    if let Ok(json) = serde_json::to_string_pretty(lock) {
        let _ = fs::write(p, json);
    }
}

pub fn list_installed_content(game_dir: &str, project_type: &str) -> Vec<InstalledItem> {
    let folder = get_content_folder(project_type);
    let dir = Path::new(game_dir).join(folder);
    let _ = fs::create_dir_all(&dir);

    let lock = read_content_lock(game_dir);
    let mut items = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let meta = match entry.metadata() {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };

            let raw_name = entry.file_name().to_string_lossy().to_string();
            let lower = raw_name.to_lowercase();
            let is_disabled = lower.ends_with(".disabled");
            let base_name = if is_disabled {
                &raw_name[..raw_name.len() - ".disabled".len()]
            } else {
                &raw_name
            };

            // Only recognize relevant files for this content type
            let valid = match folder {
                "mods" => lower.ends_with(".jar") || lower.ends_with(".jar.disabled"),
                _ => lower.ends_with(".zip") || lower.ends_with(".zip.disabled"),
            };
            if !valid {
                continue;
            }

            let lock_meta = lock.items.get(base_name);
            let title = lock_meta
                .and_then(|m| m.title.clone())
                .unwrap_or_else(|| base_name.to_string());
            let author = lock_meta.and_then(|m| m.author.clone());
            let version = lock_meta.and_then(|m| m.version_number.clone());
            let project_id = lock_meta.and_then(|m| m.project_id.clone());
            let version_id = lock_meta.and_then(|m| m.version_id.clone());
            let icon_url = lock_meta.and_then(|m| m.icon_url.clone());

            items.push(InstalledItem {
                file_name: raw_name.clone(),
                name: title.clone(),
                title,
                version,
                author,
                project_id,
                version_id,
                size_bytes: meta.len(),
                enabled: !is_disabled,
                icon_url,
            });
        }
    }

    items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    items
}

// ---------------------------------------------------------------------------------------------
// "Is it installed?" detection: works for files installed through the launcher AND for files that were
// copied into the folder by hand / came from anywhere else (recognised by SHA1 on Modrinth, or by the
// mod id inside the jar). Results are cached per file (size + mtime), so nothing is re-read twice.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanEntry {
    pub size: u64,
    pub mtime: u64,
    /// mod ids found inside the jar (fabric.mod.json / quilt.mod.json / mods.toml), normalised
    #[serde(default)]
    pub ids: Vec<String>,
    /// true once Modrinth was asked about this exact file
    #[serde(default)]
    pub checked: bool,
}

pub fn read_scan_cache(game_dir: &str) -> HashMap<String, ScanEntry> {
    let p = Path::new(game_dir).join("inex-content-scan.json");
    fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<String, ScanEntry>>(&raw).ok())
        .unwrap_or_default()
}

pub fn write_scan_cache(game_dir: &str, cache: &HashMap<String, ScanEntry>) {
    let p = Path::new(game_dir).join("inex-content-scan.json");
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = fs::write(p, json);
    }
}

pub fn norm_id(s: &str) -> String {
    s.trim().to_lowercase().replace('_', "-")
}

fn zip_text(zip: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    (&mut f).take(1_048_576).read_to_string(&mut s).ok()?;
    Some(s.trim_start_matches('\u{feff}').to_string())
}

/// Mod ids declared inside a mod jar (empty for anything that is not a readable mod jar).
pub fn read_local_mod_ids(path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut zip = match zip::ZipArchive::new(file) {
        Ok(z) => z,
        Err(_) => return out,
    };

    if let Some(txt) = zip_text(&mut zip, "fabric.mod.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                out.push(norm_id(id));
            }
            if let Some(arr) = v.get("provides").and_then(|x| x.as_array()) {
                for x in arr {
                    if let Some(id) = x.as_str() {
                        out.push(norm_id(id));
                    }
                }
            }
        }
    }
    if let Some(txt) = zip_text(&mut zip, "quilt.mod.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(q) = v.get("quilt_loader") {
                if let Some(id) = q.get("id").and_then(|x| x.as_str()) {
                    out.push(norm_id(id));
                }
                if let Some(arr) = q.get("provides").and_then(|x| x.as_array()) {
                    for x in arr {
                        let id = x.as_str().or_else(|| x.get("id").and_then(|i| i.as_str()));
                        if let Some(id) = id {
                            out.push(norm_id(id));
                        }
                    }
                }
            }
        }
    }
    for toml_name in ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"] {
        if let Some(txt) = zip_text(&mut zip, toml_name) {
            for line in txt.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("modId") {
                    if let Some(val) = rest.trim_start().strip_prefix('=') {
                        let id = val.trim().trim_matches(|c: char| c == '"' || c == '\'');
                        if !id.is_empty() {
                            out.push(norm_id(id));
                        }
                    }
                }
            }
        }
    }

    out.retain(|id| !id.is_empty() && !matches!(id.as_str(), "minecraft" | "java" | "fabricloader" | "fabric-loader" | "forge" | "neoforge"));
    out.sort();
    out.dedup();
    out
}

/// (Modrinth project ids, local mod ids) of everything that is currently in the profile's content folder.
/// Only reads small JSON files, never touches the jars themselves.
pub fn installed_sets(game_dir: &str, project_type: &str) -> (HashSet<String>, HashSet<String>) {
    let folder = get_content_folder(project_type);
    let dir = Path::new(game_dir).join(folder);
    let exists = |file: &str| dir.join(file).exists() || dir.join(format!("{file}.disabled")).exists();

    let mut project_ids: HashSet<String> = HashSet::new();
    let lock = read_content_lock(game_dir);
    for (file, meta) in lock.items.iter() {
        if let Some(pid) = meta.project_id.as_ref() {
            if !pid.is_empty() && exists(file) {
                project_ids.insert(pid.clone());
            }
        }
    }

    let mut local_ids: HashSet<String> = HashSet::new();
    if project_type.eq_ignore_ascii_case("mod") {
        let prefix = format!("{folder}/");
        for (key, entry) in read_scan_cache(game_dir).iter() {
            if let Some(base) = key.strip_prefix(&prefix) {
                if exists(base) {
                    for id in &entry.ids {
                        local_ids.insert(id.clone());
                    }
                }
            }
        }
    }
    (project_ids, local_ids)
}

/// Sets "installed" on every search hit.
pub fn mark_installed(res: &mut serde_json::Value, game_dir: &str, project_type: &str) {
    let (project_ids, local_ids) = installed_sets(game_dir, project_type);
    let is_mod = project_type.eq_ignore_ascii_case("mod");
    if let Some(hits) = res.get_mut("hits").and_then(|h| h.as_array_mut()) {
        for hit in hits.iter_mut() {
            let pid = hit.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let slug = norm_id(hit.get("slug").and_then(|v| v.as_str()).unwrap_or(""));
            let installed = (!pid.is_empty() && project_ids.contains(pid)) || (is_mod && !slug.is_empty() && local_ids.contains(&slug));
            hit["installed"] = serde_json::Value::Bool(installed);
        }
    }
}

pub fn toggle_installed_content(
    game_dir: &str,
    file_name: &str,
    project_type: &str,
) -> Result<serde_json::Value, String> {
    let folder = get_content_folder(project_type);
    let dir = Path::new(game_dir).join(folder);
    let clean_file = Path::new(file_name)
        .file_name()
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string_lossy()
        .to_string();

    let cur_path = dir.join(&clean_file);
    if !cur_path.exists() {
        return Err(format!("File not found: {}", clean_file));
    }

    let is_disabled = clean_file.ends_with(".disabled");
    let target_name = if is_disabled {
        clean_file[..clean_file.len() - ".disabled".len()].to_string()
    } else {
        format!("{}.disabled", clean_file)
    };

    let target_path = dir.join(&target_name);
    fs::rename(&cur_path, &target_path).map_err(|e| format!("Failed to rename file: {}", e))?;

    let items = list_installed_content(game_dir, project_type);
    Ok(serde_json::json!({
        "toggled": true,
        "enabled": is_disabled, // toggled from disabled -> enabled
        "items": items
    }))
}

pub fn remove_installed_content(
    game_dir: &str,
    file_name: &str,
    project_type: &str,
) -> Result<serde_json::Value, String> {
    let folder = get_content_folder(project_type);
    let dir = Path::new(game_dir).join(folder);
    let clean_file = Path::new(file_name)
        .file_name()
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string_lossy()
        .to_string();

    let cur_path = dir.join(&clean_file);
    if cur_path.exists() {
        let _ = fs::remove_file(cur_path);
    }

    let base_name = if clean_file.ends_with(".disabled") {
        clean_file[..clean_file.len() - ".disabled".len()].to_string()
    } else {
        clean_file
    };

    let mut lock = read_content_lock(game_dir);
    lock.items.remove(&base_name);
    write_content_lock(game_dir, &lock);

    let items = list_installed_content(game_dir, project_type);
    Ok(serde_json::json!({
        "removed": true,
        "fileName": file_name,
        "items": items
    }))
}

pub async fn search_projects(
    client: &reqwest::Client,
    opts: &serde_json::Value,
) -> serde_json::Value {
    let query = opts
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let project_type = opts
        .get("projectType")
        .and_then(|v| v.as_str())
        .unwrap_or("mod");
    let limit = opts.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 50);
    let offset = opts.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
    // the UI sends "sortIndex" (x_client name); "index" is accepted too
    let index = opts
        .get("sortIndex")
        .or_else(|| opts.get("index"))
        .and_then(|v| v.as_str())
        .filter(|v| matches!(*v, "relevance" | "downloads" | "follows" | "newest" | "updated"))
        .unwrap_or("relevance");

    let mut facets = vec![format!("[\"project_type:{}\"]", project_type)];

    if let Some(loader) = opts.get("loader").and_then(|v| v.as_str()) {
        let l = loader.trim().to_lowercase();
        if !l.is_empty() && l != "vanilla" {
            facets.push(format!("[\"categories:{}\"]", l));
        }
    }

    if let Some(version) = opts.get("version").and_then(|v| v.as_str()) {
        let ver = version.trim();
        if !ver.is_empty() {
            facets.push(format!("[\"versions:{}\"]", ver));
        }
    }

    let facets_param = format!("[{}]", facets.join(","));

    let url = format!(
        "https://api.modrinth.com/v2/search?query={}&facets={}&index={}&offset={}&limit={}",
        urlencoding_encode(query),
        urlencoding_encode(&facets_param),
        index,
        offset,
        limit
    );

    if let Ok(res) = client
        .get(&url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0 (windows)")
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                let empty_vec = Vec::new();
                let hits = json.get("hits").and_then(|h| h.as_array()).unwrap_or(&empty_vec);
                let total = json.get("total_hits").and_then(|t| t.as_u64()).unwrap_or(hits.len() as u64);

                let mapped_hits: Vec<serde_json::Value> = hits
                    .iter()
                    .map(|h| {
                        let icon = h.get("icon_url").and_then(|i| i.as_str()).unwrap_or("");
                        serde_json::json!({
                            "projectId": h.get("project_id").and_then(|p| p.as_str()).unwrap_or(""),
                            "slug": h.get("slug").and_then(|s| s.as_str()).unwrap_or(""),
                            "title": h.get("title").and_then(|t| t.as_str()).unwrap_or(""),
                            "author": h.get("author").and_then(|a| a.as_str()).unwrap_or("Modrinth Creator"),
                            "description": h.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                            "downloads": h.get("downloads").and_then(|d| d.as_u64()).unwrap_or(0),
                            "follows": h.get("follows").and_then(|f| f.as_u64()).unwrap_or(0),
                            "iconUrl": icon,
                            "projectType": h.get("project_type").and_then(|pt| pt.as_str()).unwrap_or(project_type),
                            "categories": h.get("categories").cloned().unwrap_or(serde_json::json!([])),
                            "versions": h.get("versions").cloned().unwrap_or(serde_json::json!([])),
                            "installed": false
                        })
                    })
                    .collect();

                return serde_json::json!({
                    "hits": mapped_hits,
                    "totalHits": total,
                    "offset": offset,
                    "limit": limit
                });
            }
        }
    }

    // Offline fallback catalog
    serde_json::json!({
        "hits": [
            {
                "projectId": "AANobbMI",
                "slug": "sodium",
                "title": "Sodium",
                "author": "jellysquid3",
                "description": "Modern rendering optimization engine for Minecraft. Greatly improves FPS and eliminates stutters.",
                "downloads": 52000000,
                "follows": 180000,
                "projectType": "mod",
                "categories": ["fabric", "quilt", "optimization"],
                "versions": ["1.21.4", "1.21.1", "1.20.4", "1.20.1"],
                "iconUrl": "https://cdn.modrinth.com/data/AANobbMI/icon.png",
                "installed": false
            },
            {
                "projectId": "YL57xq9U",
                "slug": "iris",
                "title": "Iris Shaders",
                "author": "coderbot",
                "description": "Modern shaders mod compatible with OptiFine packs and built to run on Sodium.",
                "downloads": 38000000,
                "follows": 130000,
                "projectType": "mod",
                "categories": ["fabric", "quilt", "shaders"],
                "versions": ["1.21.4", "1.21.1", "1.20.4", "1.20.1"],
                "iconUrl": "https://cdn.modrinth.com/data/YL57xq9U/icon.png",
                "installed": false
            }
        ],
        "offset": offset,
        "limit": limit,
        "totalHits": 2
    })
}

pub async fn install_project(
    client: &reqwest::Client,
    game_dir: &str,
    project_id: &str,
    project_type: &str,
    title: &str,
    author: &str,
    icon_url: &str,
    mc_version: &str,
    loader: &str,
) -> Result<serde_json::Value, String> {
    let is_pack = project_type == "resourcepack" || project_type == "shader" || project_type == "datapack";
    let encoded_id = urlencoding_encode(project_id);

    // Query versions for this project
    let mut url = format!("https://api.modrinth.com/v2/project/{encoded_id}/version");
    let mut params = Vec::new();
    if !mc_version.is_empty() {
        params.push(format!("game_versions=[\"{mc_version}\"]"));
    }
    if !is_pack && !loader.is_empty() && loader != "vanilla" {
        params.push(format!("loaders=[\"{loader}\"]"));
    }
    if !params.is_empty() {
        url.push('?');
        url.push_str(&params.join("&"));
    }

    let res = client
        .get(&url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0 (windows)")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Modrinth: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Modrinth version lookup returned HTTP {}", res.status()));
    }

    let versions: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from Modrinth: {e}"))?;

    let version_list = versions
        .as_array()
        .ok_or_else(|| "No version list returned".to_string())?;

    if version_list.is_empty() {
        return Err(format!("No compatible version found for Minecraft {mc_version} ({loader})"));
    }

    let matched_ver = version_list.first().unwrap();
    let version_id = matched_ver.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let version_number = matched_ver.get("version_number").and_then(|v| v.as_str()).unwrap_or("");

    let files = matched_ver
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or_else(|| "No files found for this version".to_string())?;

    let primary_file = files
        .iter()
        .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        .unwrap_or_else(|| files.first().unwrap());

    let download_url = primary_file
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| "Missing file URL".to_string())?;
    let filename = primary_file
        .get("filename")
        .and_then(|f| f.as_str())
        .ok_or_else(|| "Missing filename".to_string())?;
    let expected_sha1 = primary_file
        .get("hashes")
        .and_then(|h| h.get("sha1"))
        .and_then(|s| s.as_str());

    let folder = get_content_folder(project_type);
    let target_dir = Path::new(game_dir).join(folder);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let dest_path = target_dir.join(filename);

    // Download content
    let dl_res = client
        .get(download_url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0 (windows)")
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !dl_res.status().is_success() {
        return Err(format!("Download failed with HTTP {}", dl_res.status()));
    }

    let bytes = dl_res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response bytes: {e}"))?;

    // Verify SHA1
    if let Some(sha) = expected_sha1 {
        let mut hasher = Sha1::new();
        hasher.update(&bytes);
        let hash = format!("{:x}", hasher.finalize());
        if !hash.eq_ignore_ascii_case(sha) {
            return Err(format!("SHA-1 mismatch: expected {sha}, got {hash}"));
        }
    }

    fs::write(&dest_path, &bytes).map_err(|e| format!("Failed to save file: {e}"))?;

    // Record in content lock
    let mut lock = read_content_lock(game_dir);
    lock.items.insert(
        filename.to_string(),
        ContentLockItem {
            project_id: Some(project_id.to_string()),
            version_id: Some(version_id.to_string()),
            title: Some(if title.is_empty() { filename.to_string() } else { title.to_string() }),
            author: Some(if author.is_empty() { "Modrinth".to_string() } else { author.to_string() }),
            version_number: Some(version_number.to_string()),
            icon_url: Some(icon_url.to_string()),
            project_type: Some(project_type.to_string()),
        },
    );
    write_content_lock(game_dir, &lock);

    let items = list_installed_content(game_dir, project_type);
    Ok(serde_json::json!({
        "installed": true,
        "fileName": filename,
        "items": items
    }))
}

fn urlencoding_encode(s: &str) -> String {
    let mut res = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            res.push(b as char);
        } else {
            res.push_str(&format!("%{:02X}", b));
        }
    }
    res
}
