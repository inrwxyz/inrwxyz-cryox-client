use serde_json::Value;
use sha1::{Digest, Sha1};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called when an installation starts: returns the flag the install loop checks.
pub fn register_cancel(profile_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancel_flags().lock() {
        map.insert(profile_id.to_string(), flag.clone());
    }
    flag
}

pub fn clear_cancel(profile_id: &str) {
    if let Ok(mut map) = cancel_flags().lock() {
        map.remove(profile_id);
    }
}

/// x_client installer.cancelInstallation(): { cancelled: true|false, profileId }
pub fn cancel_installation(profile_id: &str) -> Value {
    let flag = cancel_flags().lock().ok().and_then(|mut map| map.remove(profile_id));
    match flag {
        Some(f) => {
            f.store(true, Ordering::SeqCst);
            serde_json::json!({ "cancelled": true, "profileId": profile_id })
        }
        None => serde_json::json!({ "cancelled": false, "profileId": profile_id }),
    }
}

pub fn compute_file_sha1(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

pub fn is_file_valid(path: &Path, expected_sha1: Option<&str>, expected_size: Option<u64>) -> bool {
    if !path.exists() {
        return false;
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() == 0 {
            return false;
        }
        if let Some(exp_size) = expected_size {
            if exp_size > 0 && meta.len() != exp_size {
                return false;
            }
        }
        if let Some(exp_sha1) = expected_sha1 {
            if !exp_sha1.is_empty() {
                if let Some(actual) = compute_file_sha1(path) {
                    return actual.eq_ignore_ascii_case(exp_sha1);
                }
                return false;
            }
        }
        true
    } else {
        false
    }
}

pub async fn download_file_with_verify(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
) -> Result<bool, String> {
    if is_file_valid(dest, expected_sha1, expected_size) {
        return Ok(false); // already cached and valid
    }

    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let part_path = dest.with_extension("part");
    let res = client
        .get(url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("Download HTTP {} for {}", res.status(), url));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body for {}: {}", url, e))?;

    if let Some(exp_size) = expected_size {
        if exp_size > 0 && bytes.len() as u64 != exp_size {
            return Err(format!(
                "Size mismatch for {}: expected {} bytes, got {}",
                url,
                exp_size,
                bytes.len()
            ));
        }
    }

    if let Some(exp_sha1) = expected_sha1 {
        if !exp_sha1.is_empty() {
            let actual = format!("{:x}", Sha1::digest(&bytes));
            if !actual.eq_ignore_ascii_case(exp_sha1) {
                return Err(format!(
                    "SHA-1 mismatch for {}: expected {}, got {}",
                    url, exp_sha1, actual
                ));
            }
        }
    }

    fs::write(&part_path, &bytes)
        .map_err(|e| format!("Failed to write {}: {}", part_path.display(), e))?;
    fs::rename(&part_path, dest)
        .map_err(|e| format!("Failed to rename to {}: {}", dest.display(), e))?;

    Ok(true)
}

pub fn evaluate_rule(rule: &Value, os_name: &str) -> bool {
    let action = rule.get("action").and_then(|v| v.as_str()).unwrap_or("allow");
    let os_match = if let Some(os) = rule.get("os") {
        if let Some(name) = os.get("name").and_then(|v| v.as_str()) {
            name == os_name
        } else {
            true
        }
    } else {
        true
    };

    if action == "allow" {
        os_match
    } else {
        !os_match
    }
}

pub fn evaluate_rules(rules: Option<&Vec<Value>>, os_name: &str) -> bool {
    let list = match rules {
        Some(r) if !r.is_empty() => r,
        _ => return true,
    };

    let mut allowed = false;
    for rule in list {
        if evaluate_rule(rule, os_name) {
            allowed = rule.get("action").and_then(|v| v.as_str()) == Some("allow");
        }
    }
    allowed
}

pub fn extract_natives(natives_dir: &Path, native_jars: &[PathBuf]) {
    let _ = fs::create_dir_all(natives_dir);
    for jar_path in native_jars {
        if let Ok(file) = File::open(jar_path) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                for i in 0..archive.len() {
                    if let Ok(mut entry) = archive.by_index(i) {
                        let name = entry.name().to_string();
                        if name.ends_with(".dll") && !name.contains('/') && !name.contains('\\') {
                            let out_path = natives_dir.join(&name);
                            if let Ok(mut out_file) = File::create(&out_path) {
                                let _ = std::io::copy(&mut entry, &mut out_file);
                            }
                        }
                    }
                }
            }
        }
    }
}

pub async fn emit_progress(
    app: &AppHandle,
    profile_id: &str,
    stage: &str,
    percent: u32,
    detail: &str,
) {
    let payload = serde_json::json!({
        "channel": "event:install-progress",
        "data": {
            "profileId": profile_id,
            "stage": stage,
            "percent": percent,
            "detail": detail
        }
    });
    let _ = app.emit("inex-event", payload);
}


// ---------------------------------------------------------------------------------------------
// Forge (port of LoaderManager._downloadAndExtractForgeInstaller + installer "--installClient" step)
// ---------------------------------------------------------------------------------------------

const FORGE_MAVEN_BASE: &str = "https://maven.minecraftforge.net";
const JOPT_SIMPLE_COORD: &str = "net.sf.jopt-simple:jopt-simple:5.0.4";

fn looks_generated(name: &str) -> bool {
    // libraries that the Forge processors build later (client / srg / extra / slim ...) exist on no maven
    let parts: Vec<&str> = name.split(':').collect();
    let hit = |s: &str| ["client", "srg", "extra", "slim", "shim", "mappings", "merged", "universal"].contains(&s);
    parts.iter().skip(2).any(|p| hit(&p.split('@').next().unwrap_or("").to_lowercase()))
}

/// Loader libraries -> download entries, loader libs first, jopt-simple guaranteed (x_client mergeWithVanillaMetadata).
fn merge_forge_meta(vanilla: &Value, forge: &Value, installer_jar: &Path, has_processors: bool) -> Value {
    let mut merged = vanilla.clone();
    if let Some(mc) = forge.get("mainClass") {
        merged["mainClass"] = mc.clone();
    }
    if let Some(a) = forge.get("minecraftArguments") {
        merged["minecraftArguments"] = a.clone();
    }

    let mut libs: Vec<Value> = Vec::new();
    if let Some(list) = forge.get("libraries").and_then(|l| l.as_array()) {
        for lib in list {
            let art = lib.get("downloads").and_then(|d| d.get("artifact"));
            if art.and_then(|a| a.get("url")).and_then(|u| u.as_str()).is_some() {
                libs.push(lib.clone());
                continue;
            }
            let name = lib.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let rel = art
                .and_then(|a| a.get("path"))
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
                .or_else(|| crate::loaders::maven_coord_to_path(&name));
            match rel {
                Some(rel) => {
                    let base = lib.get("url").and_then(|u| u.as_str()).unwrap_or(FORGE_MAVEN_BASE).trim_end_matches('/').to_string();
                    let sha1 = art
                        .and_then(|a| a.get("sha1"))
                        .cloned()
                        .or_else(|| lib.get("sha1").cloned())
                        .unwrap_or(Value::Null);
                    let size = art.and_then(|a| a.get("size")).cloned().or_else(|| lib.get("size").cloned()).unwrap_or(serde_json::json!(0));
                    libs.push(serde_json::json!({
                        "name": name,
                        "downloads": { "artifact": { "path": rel, "url": format!("{}/{}", base, rel), "sha1": sha1, "size": size } }
                    }));
                }
                None => libs.push(serde_json::json!({ "name": name })),
            }
        }
    }
    if let Some(existing) = vanilla.get("libraries").and_then(|l| l.as_array()) {
        libs.extend(existing.iter().cloned());
    }
    // Forge's modlauncher REQUIRES the module "jopt.simple"; newer Mojang manifests no longer ship it
    let has_jopt = libs.iter().any(|l| l.get("name").and_then(|n| n.as_str()).map(|n| n.starts_with("net.sf.jopt-simple:jopt-simple:")).unwrap_or(false));
    if !has_jopt {
        if let Some(rel) = crate::loaders::maven_coord_to_path(JOPT_SIMPLE_COORD) {
            libs.push(serde_json::json!({
                "name": JOPT_SIMPLE_COORD,
                "downloads": { "artifact": { "path": rel, "url": format!("https://repo1.maven.org/maven2/{}", rel), "sha1": Value::Null, "size": 0 } }
            }));
        }
    }
    merged["libraries"] = Value::Array(libs);
    merged["_inexRev"] = serde_json::json!(4);

    if let Some(la) = forge.get("arguments") {
        let mut args = merged.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({ "game": [], "jvm": [] }));
        for key in ["game", "jvm"] {
            if let Some(extra) = la.get(key).and_then(|v| v.as_array()) {
                let mut cur: Vec<Value> = args.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                cur.extend(extra.iter().cloned());
                args[key] = Value::Array(cur);
            }
        }
        merged["arguments"] = args;
    }
    merged["loaderProfile"] = serde_json::json!({
        "id": forge.get("id").cloned().unwrap_or(Value::Null),
        "inheritsFrom": forge.get("inheritsFrom").cloned().or_else(|| vanilla.get("id").cloned()).unwrap_or(Value::Null),
        "_installerJarPath": installer_jar.to_string_lossy(),
        "_hasProcessors": has_processors
    });
    merged
}

#[allow(clippy::too_many_arguments)]
async fn install_forge(
    app: &AppHandle,
    profile_id: &str,
    mc_version: &str,
    game_data_dir: &Path,
    version_dir: &Path,
    version_meta: &Value,
    client: &reqwest::Client,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let settings = crate::settings::SettingsManager::new().get_settings();
    let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
    let java_dir = PathBuf::from(settings.get("javaDir").and_then(|s| s.as_str()).unwrap_or("."));
    let game_data_str = game_data_dir.to_string_lossy().to_string();
    let (wanted_build, java_pref) = {
        let st = crate::profiles::list_profiles(&config_dir, &game_data_str);
        st.profiles
            .iter()
            .find(|p| p.id == profile_id)
            .map(|p| (p.loader_version.clone(), p.java_runtime.clone()))
            .unwrap_or_else(|| ("latest".to_string(), "auto".to_string()))
    };

    // 1. which Forge build?
    emit_progress(app, profile_id, "Resolving Forge", 60, &format!("Looking for Forge builds for Minecraft {}...", mc_version)).await;
    let mut build = wanted_build.trim().to_string();
    if build.is_empty() || build == "latest" || build.ends_with("-recommended") {
        let list = crate::loaders::get_forge_loader_versions(client, mc_version).await;
        if let Some(first) = list.first() {
            build = first.version.clone();
        }
    }
    if build.is_empty() || build == "latest" {
        return Err(format!("Forge is not available for Minecraft {}. Please select a compatible version or use Vanilla.", mc_version));
    }
    let full = if build.starts_with(&format!("{}-", mc_version)) { build.clone() } else { format!("{}-{}", mc_version, build) };

    // 2. official installer jar (cached)
    let file_name = format!("forge-{}-installer.jar", full);
    let cache_dir = Path::new(&config_dir).join("cache");
    let _ = fs::create_dir_all(&cache_dir);
    let installer_jar = cache_dir.join(&file_name);
    let too_small = fs::metadata(&installer_jar).map(|m| m.len() < 10_000).unwrap_or(true);
    if too_small {
        let _ = fs::remove_file(&installer_jar);
        let url = format!("{}/net/minecraftforge/forge/{}/{}", FORGE_MAVEN_BASE, full, file_name);
        emit_progress(app, profile_id, "Downloading Forge", 62, &format!("Downloading official Forge installer {}...", full)).await;
        download_file_with_verify(client, &url, &installer_jar, None, None)
            .await
            .map_err(|e| format!("Failed to download official Forge installer ({}): {}", url, e))?;
    }

    // 3. unpack maven/ libraries, read version.json + install_profile.json
    let libraries_dir = game_data_dir.join("libraries");
    let mut version_json: Option<Value> = None;
    let mut install_profile: Option<Value> = None;
    {
        let file = File::open(&installer_jar).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Forge installer is not a valid jar: {}", e))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if let Some(rel) = name.strip_prefix("maven/") {
                if rel.is_empty() || rel.contains("..") {
                    continue;
                }
                let dest = libraries_dir.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(mut out) = File::create(&dest) {
                    let _ = std::io::copy(&mut entry, &mut out);
                }
            } else if name == "version.json" || name == "install_profile.json" {
                let mut text = String::new();
                if entry.read_to_string(&mut text).is_ok() {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if name == "version.json" {
                            version_json = Some(v);
                        } else {
                            install_profile = Some(v);
                        }
                    }
                }
            }
        }
    }
    if version_json.is_none() {
        version_json = install_profile.as_ref().and_then(|p| p.get("versionInfo").cloned());
    }
    let mut forge_meta = version_json.ok_or_else(|| "Official forge installer JAR did not contain version.json metadata.".to_string())?;
    let has_processors = install_profile
        .as_ref()
        .and_then(|p| p.get("processors"))
        .and_then(|p| p.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    forge_meta["loader"] = serde_json::json!("forge");
    forge_meta["_inexRev"] = serde_json::json!(4);
    forge_meta["_hasProcessors"] = serde_json::json!(has_processors);
    forge_meta["_installerJarPath"] = serde_json::json!(installer_jar.to_string_lossy());

    // 4. download the loader's own libraries (generated ones are built by the processors)
    let merged = merge_forge_meta(version_meta, &forge_meta, &installer_jar, has_processors);
    let vanilla_names: std::collections::HashSet<String> = version_meta
        .get("libraries")
        .and_then(|l| l.as_array())
        .map(|a| a.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if let Some(libs) = merged.get("libraries").and_then(|l| l.as_array()) {
        let loader_libs: Vec<&Value> = libs
            .iter()
            .filter(|l| !l.get("name").and_then(|n| n.as_str()).map(|n| vanilla_names.contains(n)).unwrap_or(false))
            .collect();
        let total = loader_libs.len().max(1);
        for (idx, lib) in loader_libs.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Installation cancelled by user".to_string());
            }
            let name = lib.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let art = match lib.get("downloads").and_then(|d| d.get("artifact")) {
                Some(a) => a,
                None => continue,
            };
            let path = art.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let url = art.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if path.is_empty() || url.is_empty() {
                continue; // generated later by the installer processors
            }
            let sha1 = art.get("sha1").and_then(|s| s.as_str());
            let size = art.get("size").and_then(|s| s.as_u64());
            let dest = libraries_dir.join(path);
            if let Err(e) = download_file_with_verify(client, url, &dest, sha1, size).await {
                if sha1.is_none() && looks_generated(name) {
                    continue;
                }
                return Err(format!("Could not download Forge library {}: {}", name, e));
            }
            if idx % 5 == 0 {
                let pct = 64 + ((idx as u32 * 12) / total as u32);
                emit_progress(app, profile_id, "Downloading Forge libraries", pct, &format!("Forge libraries ({}/{})", idx + 1, total)).await;
            }
        }
    }

    // 5. client processors (builds the patched client jar): java -jar installer --installClient
    if has_processors {
        let profiles_file = game_data_dir.join("launcher_profiles.json");
        if !profiles_file.exists() {
            let _ = fs::write(&profiles_file, "{\n  \"profiles\": {}\n}");
        }
        let required_java = crate::versions::get_required_java_major_with_meta(mc_version, version_meta);
        let app_for_java = app.clone();
        let pid_java = profile_id.to_string();
        let java = crate::java::ensure_java_for_version(&java_dir, required_java, &java_pref, move |stage, percent, detail| {
            let _ = app_for_java.emit(
                "inex-event",
                serde_json::json!({
                    "channel": "event:install-progress",
                    "data": { "profileId": pid_java, "stage": stage, "percent": 80 + percent / 10, "detail": detail }
                }),
            );
        })
        .await?;
        let java_path = java
            .get("runtime")
            .and_then(|r| r.get("path"))
            .and_then(|p| p.as_str())
            .ok_or_else(|| "FORGE needs Java to build its patched client, but no compatible Java was found.".to_string())?
            .to_string();

        emit_progress(app, profile_id, "Running FORGE Client Processor", 85, "Building patched client libraries for FORGE (this can take 1-3 minutes)...").await;
        let jar_s = installer_jar.to_string_lossy().to_string();
        let gdd = game_data_str.clone();
        let cancel = cancel_flag.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<(bool, i32, String), String> {
            use std::process::{Command, Stdio};
            let mut cmd = Command::new(&java_path);
            cmd.args(["-jar", &jar_s, "--installClient", &gdd]);
            cmd.current_dir(&gdd);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let mut child = cmd.spawn().map_err(|e| format!("Could not start the Forge installer: {}", e))?;
            let tail = Arc::new(Mutex::new(String::new()));
            let mut readers = Vec::new();
            if let Some(mut out) = child.stdout.take() {
                let t = tail.clone();
                readers.push(std::thread::spawn(move || {
                    let mut buf = [0u8; 2048];
                    while let Ok(n) = out.read(&mut buf) {
                        if n == 0 { break; }
                        if let Ok(mut s) = t.lock() {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if s.len() > 4000 { let mut cut = s.len() - 2000; while !s.is_char_boundary(cut) { cut += 1; } *s = s[cut..].to_string(); }
                        }
                    }
                }));
            }
            if let Some(mut err) = child.stderr.take() {
                let t = tail.clone();
                readers.push(std::thread::spawn(move || {
                    let mut buf = [0u8; 2048];
                    while let Ok(n) = err.read(&mut buf) {
                        if n == 0 { break; }
                        if let Ok(mut s) = t.lock() {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if s.len() > 4000 { let mut cut = s.len() - 2000; while !s.is_char_boundary(cut) { cut += 1; } *s = s[cut..].to_string(); }
                        }
                    }
                }));
            }
            let started = std::time::Instant::now();
            let status = loop {
                match child.try_wait() {
                    Ok(Some(st)) => break st,
                    Ok(None) => {
                        if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(5 * 60) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err("The Forge installer was cancelled or timed out.".to_string());
                        }
                        std::thread::sleep(Duration::from_millis(300));
                    }
                    Err(e) => return Err(e.to_string()),
                }
            };
            for r in readers {
                let _ = r.join();
            }
            let text = tail.lock().map(|s| s.clone()).unwrap_or_default();
            let lower = text.to_lowercase();
            let finished = lower.contains("you can delete this installer") || lower.contains("successfully installed client profile");
            let code = status.code().unwrap_or(-1);
            let short: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let short = if short.len() > 600 { let mut cut = short.len() - 600; while !short.is_char_boundary(cut) { cut += 1; } short[cut..].to_string() } else { short };
            Ok((code == 0 || finished, code, short))
        })
        .await
        .map_err(|e| e.to_string())??;
        if !outcome.0 {
            return Err(format!("FORGE installer failed (exit {}). Last output: {}", outcome.1, outcome.2));
        }
    }

    // 6. markers the launcher / profile check look for
    let _ = fs::write(version_dir.join("loader-forge.json"), serde_json::to_string_pretty(&forge_meta).unwrap_or_default());
    fs::write(version_dir.join("effective-forge.json"), serde_json::to_string_pretty(&merged).unwrap_or_default())
        .map_err(|e| format!("Could not write effective-forge.json: {}", e))?;
    Ok(())
}

pub async fn install_game_files(
    app: &AppHandle,
    profile_id: &str,
    mc_version: &str,
    loader: &str,
    game_data_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .user_agent("Cryox-Client-Launcher/1.0.0")
        .build()
        .map_err(|e| e.to_string())?;

    let version_dir = game_data_dir.join("versions").join(mc_version);
    let libraries_dir = game_data_dir.join("libraries");
    let assets_dir = game_data_dir.join("assets");
    let natives_dir = version_dir.join("natives");
    let _ = fs::create_dir_all(&version_dir);

    // 1. Version JSON
    emit_progress(app, profile_id, "Resolving metadata", 5, &format!("Checking metadata for Minecraft {}...", mc_version)).await;
    let version_json_path = version_dir.join(format!("{}.json", mc_version));
    
    if !version_json_path.exists() {
        let manifest_url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
        let manifest_res = client.get(manifest_url).send().await.map_err(|e| e.to_string())?;
        let manifest_json = manifest_res.json::<Value>().await.map_err(|e| e.to_string())?;
        
        let mut target_url = None;
        if let Some(versions) = manifest_json.get("versions").and_then(|v| v.as_array()) {
            for v in versions {
                if v.get("id").and_then(|id| id.as_str()) == Some(mc_version) {
                    target_url = v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string());
                    break;
                }
            }
        }

        let meta_url = target_url.ok_or_else(|| format!("Version {} not found in Mojang manifest", mc_version))?;
        download_file_with_verify(&client, &meta_url, &version_json_path, None, None).await?;
    }

    let version_json_str = fs::read_to_string(&version_json_path).map_err(|e| e.to_string())?;
    let version_meta: Value = serde_json::from_str(&version_json_str).map_err(|e| e.to_string())?;

    // 2. Client JAR
    emit_progress(app, profile_id, "Downloading client JAR", 15, "Downloading official Minecraft client jar...").await;
    let client_jar_path = version_dir.join(format!("{}.jar", mc_version));
    if let Some(client_download) = version_meta.get("downloads").and_then(|d| d.get("client")) {
        let url = client_download.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let sha1 = client_download.get("sha1").and_then(|s| s.as_str());
        let size = client_download.get("size").and_then(|s| s.as_u64());
        if !url.is_empty() {
            download_file_with_verify(&client, url, &client_jar_path, sha1, size).await?;
        }
    }

    // 3. Libraries
    emit_progress(app, profile_id, "Verifying libraries", 30, "Checking required Minecraft libraries...").await;
    let mut native_jars = Vec::new();
    if let Some(libs) = version_meta.get("libraries").and_then(|l| l.as_array()) {
        let total = libs.len();
        for (idx, lib) in libs.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Installation cancelled by user".to_string());
            }

            let rules = lib.get("rules").and_then(|r| r.as_array());
            if !evaluate_rules(rules, "windows") {
                continue;
            }

            if let Some(downloads) = lib.get("downloads") {
                if let Some(artifact) = downloads.get("artifact") {
                    let path = artifact.get("path").and_then(|p| p.as_str()).unwrap_or("");
                    let url = artifact.get("url").and_then(|u| u.as_str()).unwrap_or("");
                    let sha1 = artifact.get("sha1").and_then(|s| s.as_str());
                    let size = artifact.get("size").and_then(|s| s.as_u64());

                    if !path.is_empty() && !url.is_empty() {
                        let dest = libraries_dir.join(path);
                        let _ = download_file_with_verify(&client, url, &dest, sha1, size).await;
                    }
                }

                if let Some(classifiers) = downloads.get("classifiers") {
                    if let Some(natives_win) = classifiers.get("natives-windows").or_else(|| classifiers.get("natives-windows-64")) {
                        let path = natives_win.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        let url = natives_win.get("url").and_then(|u| u.as_str()).unwrap_or("");
                        let sha1 = natives_win.get("sha1").and_then(|s| s.as_str());
                        let size = natives_win.get("size").and_then(|s| s.as_u64());

                        if !path.is_empty() && !url.is_empty() {
                            let dest = libraries_dir.join(path);
                            if download_file_with_verify(&client, url, &dest, sha1, size).await.is_ok() {
                                native_jars.push(dest);
                            }
                        }
                    }
                }
            }

            if idx % 5 == 0 {
                let pct = 30 + ((idx as u32 * 35) / total.max(1) as u32);
                emit_progress(app, profile_id, "Downloading libraries", pct, &format!("Checked {}/{} libraries", idx + 1, total)).await;
            }
        }
    }

    // Fabric Loader resolution & library download
    if loader == "fabric" {
        emit_progress(app, profile_id, "Resolving Fabric loader", 65, "Fetching Fabric loader profile...").await;
        let loader_ver = {
            let mgr = crate::settings::SettingsManager::new();
            let settings = mgr.get_settings();
            let cfg_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
            let g_dir = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
            let p_state = crate::profiles::list_profiles(cfg_dir, g_dir);
            p_state.profiles.iter().find(|p| p.id == profile_id).map(|p| p.loader_version.clone()).unwrap_or_default()
        };
        let fabric_profile = crate::loaders::resolve_fabric_profile(&client, mc_version, &loader_ver).await;
        if let Some(fab_libs) = fabric_profile.get("libraries").and_then(|l| l.as_array()) {
            for fl in fab_libs {
                let name = fl.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let base_url = fl.get("url").and_then(|u| u.as_str()).unwrap_or("https://maven.fabricmc.net/");
                if let Some(rel) = crate::loaders::maven_coord_to_path(name) {
                    let dest = libraries_dir.join(&rel);
                    let url = format!("{}{}", base_url, rel);
                    let _ = download_file_with_verify(&client, &url, &dest, None, None).await;
                }
            }
        }

        // Write effective-fabric.json
        let mut merged = version_meta.clone();
        if let Some(main) = fabric_profile.get("mainClass") {
            merged["mainClass"] = main.clone();
        }
        if let Some(fab_libs) = fabric_profile.get("libraries").and_then(|l| l.as_array()) {
            let mut all: Vec<Value> = fab_libs.clone();
            if let Some(existing) = merged.get("libraries").and_then(|l| l.as_array()) {
                all.extend(existing.iter().cloned());
            }
            merged["libraries"] = Value::Array(all);
        }
        if let Some(mc_args) = fabric_profile.get("minecraftArguments") {
            merged["minecraftArguments"] = mc_args.clone();
        }
        merged["_inexRev"] = serde_json::json!(4);
        let eff_path = version_dir.join("effective-fabric.json");
        let _ = fs::write(&eff_path, serde_json::to_string_pretty(&merged).unwrap_or_default());
        let marker_path = version_dir.join("loader-fabric.json");
        let _ = fs::write(&marker_path, serde_json::to_string_pretty(&fabric_profile).unwrap_or_default());
    }

    // Extract natives
    extract_natives(&natives_dir, &native_jars);

    // 4. Asset Index & Assets
    if let Some(asset_index) = version_meta.get("assetIndex") {
        let index_id = asset_index.get("id").and_then(|i| i.as_str()).unwrap_or(mc_version);
        let index_url = asset_index.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let index_sha1 = asset_index.get("sha1").and_then(|s| s.as_str());
        let index_dest = assets_dir.join("indexes").join(format!("{}.json", index_id));

        if !index_url.is_empty() {
            emit_progress(app, profile_id, "Downloading asset index", 70, &format!("Fetching asset index {}...", index_id)).await;
            let _ = download_file_with_verify(&client, index_url, &index_dest, index_sha1, None).await;

            if index_dest.exists() {
                if let Ok(index_content) = fs::read_to_string(&index_dest) {
                    if let Ok(index_json) = serde_json::from_str::<Value>(&index_content) {
                        if let Some(objects) = index_json.get("objects").and_then(|o| o.as_object()) {
                            let total_objects = objects.len();
                            emit_progress(app, profile_id, "Verifying game assets", 75, &format!("Verifying {} assets...", total_objects)).await;
                            
                            let conc = {
                                let st = crate::settings::SettingsManager::new().get_settings();
                                st.get("concurrentDownloads").and_then(|v| v.as_u64()).unwrap_or(8).clamp(1, 32) as usize
                            };
                            let sem = Arc::new(tokio::sync::Semaphore::new(conc));
                            let mut set: tokio::task::JoinSet<Result<bool, String>> = tokio::task::JoinSet::new();
                            for (_obj_name, obj_val) in objects {
                                let hash = obj_val.get("hash").and_then(|h| h.as_str()).unwrap_or("").to_string();
                                let size = obj_val.get("size").and_then(|s| s.as_u64());
                                if hash.len() < 2 {
                                    continue;
                                }
                                let sub = hash[..2].to_string();
                                let obj_path = assets_dir.join("objects").join(&sub).join(&hash);
                                let obj_url = format!("https://resources.download.minecraft.net/{}/{}", sub, hash);
                                let client_c = client.clone();
                                let sem_c = sem.clone();
                                set.spawn(async move {
                                    let _permit = sem_c.acquire_owned().await.map_err(|e| e.to_string())?;
                                    // one retry: asset hosts occasionally drop a connection
                                    match download_file_with_verify(&client_c, &obj_url, &obj_path, Some(hash.as_str()), size).await {
                                        Ok(v) => Ok(v),
                                        Err(_) => download_file_with_verify(&client_c, &obj_url, &obj_path, Some(hash.as_str()), size).await,
                                    }
                                });
                            }

                            let mut done: usize = 0;
                            let mut failed: usize = 0;
                            while let Some(joined) = set.join_next().await {
                                if cancel_flag.load(Ordering::SeqCst) {
                                    set.abort_all();
                                    return Err("Installation cancelled by user".to_string());
                                }
                                done += 1;
                                if !matches!(joined, Ok(Ok(_))) {
                                    failed += 1;
                                }
                                if done % 100 == 0 {
                                    let pct = 75 + ((done as u32 * 20) / total_objects.max(1) as u32);
                                    emit_progress(app, profile_id, "Downloading assets", pct, &format!("{}/{} assets checked", done, total_objects)).await;
                                }
                            }
                            if failed > 0 {
                                emit_progress(app, profile_id, "Downloading assets", 95, &format!("{} asset(s) could not be downloaded; the game may miss some sounds/textures.", failed)).await;
                            }
                        }
                    }
                }
            }
        }
    }

    if loader == "forge" {
        install_forge(app, profile_id, mc_version, game_data_dir, &version_dir, &version_meta, &client, &cancel_flag).await?;
    }

    // Mark profile installed in profiles.json
    let mgr = crate::settings::SettingsManager::new();
    let settings = mgr.get_settings();
    let config_dir_str = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".");
    let game_data_dir_str = settings.get("gameDataDir").and_then(|s| s.as_str()).unwrap_or(".");
    let _ = crate::profiles::update_profile(
        config_dir_str,
        game_data_dir_str,
        profile_id,
        serde_json::json!({ "installed": true }),
        settings.get("maxRamMB").and_then(|v| v.as_u64()).unwrap_or(16384) as u32,
    );

    emit_progress(app, profile_id, "Installation complete", 100, "Minecraft runtime verified and ready to play!").await;
    Ok(version_json_path)
}
