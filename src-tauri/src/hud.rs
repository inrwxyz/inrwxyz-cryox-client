use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudJarInfo {
    pub file_name: String,
    pub kind: Option<String>,
    pub mc_range: Option<serde_json::Value>,
    pub supported: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudUploadResult {
    pub canceled: bool,
    pub file_name: Option<String>,
    pub compatible: bool,
}

const AGENT_JAR_NAMES: &[&str] = &[
    "inex-cosmetics-agent.jar",
    "inex-cosmetics-agent-v2.jar",
    "inex-hud-agent.jar",
];

pub fn inspect_hud_jar(jar_path: &Path) -> (Option<String>, Option<serde_json::Value>, String) {
    let file = match File::open(jar_path) {
        Ok(f) => f,
        Err(e) => return (None, None, e.to_string()),
    };

    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => return (None, None, e.to_string()),
    };

    // 1. Fabric mod
    if let Ok(mut fabric_entry) = archive.by_name("fabric.mod.json") {
        let mut content = String::new();
        if fabric_entry.read_to_string(&mut content).is_ok() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let dep = v.get("depends").and_then(|d| d.get("minecraft")).cloned();
                return ("fabric".to_string().into(), dep, String::new());
            }
        }
    }

    // 2. Quilt mod
    if let Ok(mut quilt_entry) = archive.by_name("quilt.mod.json") {
        let mut content = String::new();
        if quilt_entry.read_to_string(&mut content).is_ok() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let dep = v.get("depends").and_then(|d| d.get("minecraft")).cloned();
                return ("quilt".to_string().into(), dep, String::new());
            }
        }
    }

    // 3. Forge mod
    if let Ok(mut forge_entry) = archive.by_name("META-INF/mods.toml") {
        let mut content = String::new();
        if forge_entry.read_to_string(&mut content).is_ok() {
            // Find versionRange
            let mut range_val = None;
            for line in content.lines() {
                if line.contains("versionRange") {
                    if let Some(pos) = line.find('=') {
                        let r = line[pos + 1..].trim().trim_matches('"').trim_matches('\'');
                        range_val = Some(serde_json::Value::String(r.to_string()));
                        break;
                    }
                }
            }
            return ("forge".to_string().into(), range_val, String::new());
        }
    }

    (
        None,
        None,
        "No fabric.mod.json / mods.toml inside (not a recognized mod jar)".to_string(),
    )
}

fn check_compat(
    kind: Option<&str>,
    mc_range: Option<&serde_json::Value>,
    loader: Option<&str>,
    mc_version: Option<&str>,
) -> (bool, String) {
    let k = match kind {
        Some(k) => k,
        None => return (false, "Not a mod jar".to_string()),
    };

    if let Some(ldr) = loader {
        if ldr == "vanilla" {
            return (false, "Profile is running Vanilla Minecraft".to_string());
        }
        if k == "fabric" && ldr != "fabric" && ldr != "quilt" {
            return (
                false,
                format!("Built for Fabric, profile uses {ldr}"),
            );
        }
        if k == "forge" && ldr != "forge" && ldr != "neoforge" {
            return (
                false,
                format!("Built for Forge, profile uses {ldr}"),
            );
        }
    }

    if let (Some(range), Some(ver)) = (mc_range, mc_version) {
        if let Some(r_str) = range.as_str() {
            if r_str != "*" && !r_str.is_empty() && !r_str.contains(ver) {
                // If it doesn't mention the version directly and it's not a wildcard, flag warning
                return (
                    true,
                    format!("Tested for {r_str}"),
                );
            }
        }
    }

    (true, String::new())
}

pub fn list_hud_jars(
    config_dir: &str,
    profile_loader: Option<&str>,
    profile_version: Option<&str>,
) -> Vec<HudJarInfo> {
    let hud_mods_dir = Path::new(config_dir).join("hud-mods");
    let _ = fs::create_dir_all(&hud_mods_dir);

    let mut out = Vec::new();
    let entries = match fs::read_dir(&hud_mods_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        if !lower.ends_with(".jar") {
            continue;
        }
        if AGENT_JAR_NAMES.iter().any(|&a| a == lower) {
            continue;
        }

        let (kind, mc_range, reason) = inspect_hud_jar(&path);
        let (supported, compat_reason) = check_compat(
            kind.as_deref(),
            mc_range.as_ref(),
            profile_loader,
            profile_version,
        );

        let final_reason = if !reason.is_empty() {
            reason
        } else {
            compat_reason
        };

        out.push(HudJarInfo {
            file_name,
            kind,
            mc_range,
            supported,
            reason: final_reason,
        });
    }

    out
}

pub fn copy_hud_jar(config_dir: &str, src_file: &Path) -> Result<HudUploadResult, String> {
    let hud_mods_dir = Path::new(config_dir).join("hud-mods");
    fs::create_dir_all(&hud_mods_dir).map_err(|e| e.to_string())?;

    let file_name = src_file
        .file_name()
        .ok_or_else(|| "Invalid source file name".to_string())?
        .to_string_lossy()
        .to_string();

    let dest = hud_mods_dir.join(&file_name);
    fs::copy(src_file, &dest).map_err(|e| e.to_string())?;

    let (kind, _, _) = inspect_hud_jar(&dest);
    Ok(HudUploadResult {
        canceled: false,
        file_name: Some(file_name),
        compatible: kind.is_some(),
    })
}

// ---------------------------------------------------------------------------------------------
// port of ProfileManager.attachDefaultClientMods / _collectHudJarFiles
// ---------------------------------------------------------------------------------------------

pub struct HudAttachResult {
    pub attached: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

fn collect_hud_jar_files(
    config_dir: &str,
    extra_roots: &[std::path::PathBuf],
    mc_version: &str,
) -> Vec<(String, std::path::PathBuf)> {
    let cfg = Path::new(config_dir);
    let mut roots: Vec<std::path::PathBuf> = vec![cfg.join("hud-mods"), cfg.join("default-mods")];
    for r in extra_roots {
        if !roots.contains(r) {
            roots.push(r.clone());
        }
    }
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for r in &roots {
        dirs.push(r.clone());
        if !mc_version.is_empty() {
            dirs.push(r.join(mc_version));
        }
    }
    let mut files: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in dirs {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !lower.ends_with(".jar") || AGENT_JAR_NAMES.iter().any(|&a| a == lower) {
                continue;
            }
            let full = entry.path();
            if !full.is_file() {
                continue;
            }
            let key = format!("{}:{}", dir.display(), name);
            if seen.insert(key) {
                files.push((name, full));
            }
        }
    }
    files
}

/// Copies the compatible HUD jar(s) into <gameDir>/mods and removes ones that are no longer wanted.
pub fn attach_default_client_mods(
    config_dir: &str,
    extra_roots: &[std::path::PathBuf],
    game_dir: &str,
    loader: &str,
    mc_version: &str,
    hud_enabled: bool,
    active_hud_jar: &str,
) -> HudAttachResult {
    let mut result = HudAttachResult { attached: Vec::new(), skipped: Vec::new() };
    if game_dir.is_empty() {
        return result;
    }
    let mods_dir = Path::new(game_dir).join("mods");
    let cfg_dir = Path::new(game_dir).join("config");
    if fs::create_dir_all(&mods_dir).is_err() || fs::create_dir_all(&cfg_dir).is_err() {
        return result;
    }
    let track_file = Path::new(game_dir).join("inex-hud-attached.json");

    for legacy in AGENT_JAR_NAMES {
        let _ = fs::remove_file(mods_dir.join(legacy));
    }
    let hud_config_path = cfg_dir.join("inex-hud.json");
    let _ = fs::remove_file(&hud_config_path);

    let tracked: Vec<String> = fs::read_to_string(&track_file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("files").and_then(|f| f.as_array()).cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let enabled = loader != "vanilla" && hud_enabled;
    let chosen = active_hud_jar.trim();
    let default_roots: Vec<std::path::PathBuf> = {
        let mut r = vec![Path::new(config_dir).join("default-mods")];
        r.extend(extra_roots.iter().cloned());
        r
    };

    if enabled && chosen != "__none__" {
        for (file_name, full) in collect_hud_jar_files(config_dir, extra_roots, mc_version) {
            if !chosen.is_empty() && file_name != chosen {
                continue;
            }
            let (kind, range, reason) = inspect_hud_jar(&full);
            let (ok, compat_reason) = check_compat(kind.as_deref(), range.as_ref(), Some(loader), Some(mc_version));
            let source_is_default = default_roots.iter().any(|r| full.starts_with(r)) || file_name.contains("inex-client-hud");
            if !ok && !source_is_default {
                let why = if !reason.is_empty() { reason } else { compat_reason };
                result.skipped.push((file_name, why));
                continue;
            }
            let dest = mods_dir.join(&file_name);
            let src_size = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
            let needs_copy = match fs::metadata(&dest) {
                Ok(m) => m.len() != src_size,
                Err(_) => true,
            };
            if needs_copy {
                if let Err(e) = fs::copy(&full, &dest) {
                    result.skipped.push((file_name, e.to_string()));
                    continue;
                }
            }
            if !result.attached.contains(&file_name) {
                result.attached.push(file_name);
            }
        }
    }

    for old in tracked {
        if result.attached.contains(&old) {
            continue;
        }
        let _ = fs::remove_file(mods_dir.join(&old));
    }

    let _ = fs::write(
        &track_file,
        serde_json::to_string_pretty(&serde_json::json!({ "files": result.attached })).unwrap_or_default(),
    );
    if !result.attached.is_empty() || loader != "vanilla" {
        let active = result
            .attached
            .first()
            .cloned()
            .unwrap_or_else(|| chosen.to_string());
        let _ = fs::write(
            &hud_config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "showNametagLogo": true,
                "activeHudJar": active,
                "attachedFiles": result.attached
            }))
            .unwrap_or_default(),
        );
    }
    result
}
