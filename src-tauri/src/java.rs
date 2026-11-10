use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaInfo {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub arch: String,
}

pub fn probe_java_binary(path_str: &str) -> Option<JavaInfo> {
    let p = Path::new(path_str);
    if path_str != "java" && path_str != "java.exe" && !p.exists() {
        return None;
    }

    for flag in &["-version", "--version"] {
        let mut cmd = Command::new(path_str);
        cmd.arg(flag);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Ok(output) = cmd.output() {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            );
            if let Some(info) = parse_java_version_output(&combined) {
                return Some(JavaInfo {
                    path: path_str.to_string(),
                    version: info.0,
                    major: info.1,
                    arch: if info.2 { "x64".into() } else { "x86".into() },
                });
            }
        }
    }
    None
}

fn parse_java_version_output(text: &str) -> Option<(String, u32, bool)> {
    let is_64 = text.contains("64-Bit")
        || text.contains("x86_64")
        || text.contains("amd64")
        || text.contains("aarch64");

    for line in text.lines() {
        if let Some(pos) = line.find("version \"") {
            let rest = &line[pos + 9..];
            if let Some(end) = rest.find('"') {
                let ver = rest[..end].to_string();
                let parts: Vec<&str> = ver.split(|c| c == '.' || c == '_' || c == '-' || c == '+').collect();
                if let Some(first) = parts.first() {
                    let mut major = first.parse::<u32>().unwrap_or(0);
                    if major == 1 && parts.len() > 1 {
                        major = parts[1].parse::<u32>().unwrap_or(8);
                    }
                    if major > 0 {
                        return Some((ver, major, is_64));
                    }
                }
            }
        } else if line.contains("openjdk ") || line.contains("java ") {
            let words: Vec<&str> = line.split_whitespace().collect();
            for w in words {
                let parts: Vec<&str> = w.split(|c| c == '.' || c == '_' || c == '-' || c == '+').collect();
                if let Some(first) = parts.first() {
                    if let Ok(m) = first.parse::<u32>() {
                        if m >= 7 && m <= 50 {
                            return Some((w.to_string(), m, is_64));
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn detect_installed_runtimes(config_dir: &Path) -> Value {
    let mut candidates: HashSet<String> = HashSet::new();

    // 0. Custom Java path chosen in Settings (folder or java.exe)
    {
        let settings = crate::settings::SettingsManager::new().get_settings();
        let custom = settings
            .get("customJavaPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !custom.is_empty() {
            if custom.to_lowercase().ends_with("java.exe") {
                candidates.insert(custom.clone());
            } else {
                candidates.insert(Path::new(&custom).join("bin").join("java.exe").to_string_lossy().to_string());
                candidates.insert(Path::new(&custom).join("java.exe").to_string_lossy().to_string());
            }
        }
    }

    // 1. Config runtimes dir and config dir itself
    scan_dir_for_java(config_dir, 4, &mut candidates);
    let rt_dir = config_dir.join("runtimes");
    scan_dir_for_java(&rt_dir, 4, &mut candidates);

    // 2. JAVA_HOME
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        let p = Path::new(&jh).join("bin").join("java.exe");
        if p.exists() {
            candidates.insert(p.to_string_lossy().to_string());
        }
    }

    // 3. where.exe java
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut where_cmd = Command::new("where.exe");
        where_cmd.arg("java");
        where_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        if let Ok(out) = where_cmd.output() {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                let t = line.trim();
                if !t.is_empty() && Path::new(t).exists() {
                    candidates.insert(t.to_string());
                }
            }
        }

        // Oracle common javapath
        candidates.insert("C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe".into());
        candidates.insert("C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\javapath\\java.exe".into());

        // Windows registry: finds Java installed on any drive (D:\\, E:\\ ...), like x_client _queryWindowsRegistryJavaPaths
        {
            let reg_keys = [
                "HKLM\\SOFTWARE\\JavaSoft\\JDK",
                "HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment",
                "HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit",
                "HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE",
                "HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK",
                "HKLM\\SOFTWARE\\AdoptOpenJDK\\JRE",
                "HKLM\\SOFTWARE\\AdoptOpenJDK\\JDK",
                "HKLM\\SOFTWARE\\Microsoft\\JDK",
                "HKLM\\SOFTWARE\\Azul Systems\\Zulu",
                "HKLM\\SOFTWARE\\BellSoft\\Liberica",
            ];
            for key in reg_keys {
                let mut reg_cmd = Command::new("reg");
                reg_cmd.args(["query", key, "/s", "/v", "JavaHome"]);
                reg_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                if let Ok(out) = reg_cmd.output() {
                    let text = String::from_utf8_lossy(&out.stdout).to_string();
                    for line in text.lines() {
                        let t = line.trim();
                        if !t.starts_with("JavaHome") {
                            continue;
                        }
                        if let Some(idx) = t.find("REG_SZ") {
                            let home = t[idx + "REG_SZ".len()..].trim();
                            if !home.is_empty() {
                                let exe = Path::new(home).join("bin").join("java.exe");
                                if exe.exists() {
                                    candidates.insert(exe.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Standard Program Files vendor locations
        let pf_list = [
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string()),
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string()),
        ];
        let vendors = [
            "Java",
            "Eclipse Adoptium",
            "AdoptOpenJDK",
            "Microsoft",
            "BellSoft",
            "Zulu",
            "Amazon Corretto",
            "SapMachine",
            "GraalVM",
        ];
        for pf in &pf_list {
            let base = Path::new(pf);
            scan_dir_for_java(base, 2, &mut candidates);
            for v in &vendors {
                scan_dir_for_java(&base.join(v), 3, &mut candidates);
            }
        }

        // Other common Minecraft launcher runtimes
        if let Ok(appdata) = std::env::var("APPDATA") {
            let app_path = Path::new(&appdata);
            scan_dir_for_java(&app_path.join(".minecraft").join("runtime"), 5, &mut candidates);
            scan_dir_for_java(&app_path.join("FastClient").join("runtimes"), 5, &mut candidates);
            scan_dir_for_java(&app_path.join("CryoxClient").join("runtimes"), 5, &mut candidates);
            scan_dir_for_java(&app_path.join("XClient").join("runtimes"), 5, &mut candidates);
            scan_dir_for_java(&app_path.join("INEXClient").join("runtimes"), 5, &mut candidates);
        }
    }

    candidates.insert("java".into());

    let mut seen_major_path: HashMap<(u32, String), Value> = HashMap::new();
    for c in candidates {
        if let Some(info) = probe_java_binary(&c) {
            let key = (info.major, info.path.to_lowercase());
            seen_major_path.insert(key, json!({
                "path": info.path,
                "version": info.version,
                "major": info.major,
                "arch": info.arch,
                "is64Bit": info.arch == "x64"
            }));
        }
    }

    let mut list: Vec<Value> = seen_major_path.into_values().collect();
    list.sort_by(|a, b| {
        let ma = a.get("major").and_then(|m| m.as_u64()).unwrap_or(0);
        let mb = b.get("major").and_then(|m| m.as_u64()).unwrap_or(0);
        mb.cmp(&ma)
    });

    json!(list)
}

fn scan_dir_for_java(dir: &Path, depth: u32, candidates: &mut HashSet<String>) {
    if depth == 0 || !dir.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let bin_java = p.join("bin").join("java.exe");
                if bin_java.exists() {
                    candidates.insert(bin_java.to_string_lossy().to_string());
                } else {
                    scan_dir_for_java(&p, depth - 1, candidates);
                }
            } else if p.file_name().and_then(|f| f.to_str()).map(|s| s.eq_ignore_ascii_case("java.exe")).unwrap_or(false) {
                candidates.insert(p.to_string_lossy().to_string());
            }
        }
    }
}

pub fn resolve_java_for_version(
    config_dir: &Path,
    required_major: u32,
    preferred_setting: &str,
) -> Value {
    let installed = detect_installed_runtimes(config_dir);
    let runtimes: Vec<Value> = installed.as_array().cloned().unwrap_or_default();
    let req = if required_major == 0 { 21 } else { required_major };

    // A profile left on "auto" follows the Java chosen in Settings -> Java runtime (if any).
    let mut preferred = preferred_setting.trim().to_string();
    if preferred.is_empty() || preferred == "auto" {
        let settings = crate::settings::SettingsManager::new().get_settings();
        if let Some(chosen) = settings.get("defaultJavaRuntime").and_then(|v| v.as_str()) {
            if !chosen.is_empty() && chosen != "auto" {
                preferred = chosen.to_string();
            }
        }
    }

    if !preferred.is_empty() && preferred != "auto" {
        if let Some(custom) = probe_java_binary(&preferred) {
            let compatible = custom.major >= req;
            return json!({
                "found": true,
                "exactMatch": custom.major == req,
                "compatible": compatible,
                "runtime": {
                    "path": custom.path,
                    "version": custom.version,
                    "major": custom.major,
                    "arch": custom.arch
                },
                "requiredMajor": req,
                "installed": runtimes,
                "message": if compatible {
                    format!("Using selected Java {} ({})", custom.major, custom.version)
                } else {
                    format!("Selected Java {} is older than required Java {}.", custom.major, req)
                }
            });
        }
    }

    // 1. Prefer an exact major match (Java 21 for 1.21.x even if Java 25 is installed too)
    if let Some(exact) = runtimes
        .iter()
        .find(|r| r.get("major").and_then(|m| m.as_u64()) == Some(req as u64))
    {
        return json!({
            "found": true,
            "exactMatch": true,
            "compatible": true,
            "runtime": exact,
            "requiredMajor": req,
            "installed": runtimes,
            "message": format!("Resolved exact match Java {}", req)
        });
    }

    // 2. Otherwise the closest newer runtime (smallest major >= req)
    let mut newer: Vec<&Value> = runtimes
        .iter()
        .filter(|r| r.get("major").and_then(|m| m.as_u64()).unwrap_or(0) >= req as u64)
        .collect();
    newer.sort_by_key(|r| r.get("major").and_then(|m| m.as_u64()).unwrap_or(0));
    if let Some(closest) = newer.first() {
        return json!({
            "found": true,
            "exactMatch": false,
            "compatible": true,
            "runtime": closest,
            "requiredMajor": req,
            "installed": runtimes,
            "message": format!("Resolved compatible Java for requirement Java {}", req)
        });
    }

    let message = if runtimes.is_empty() {
        format!("No system Java detected; CRYOX CLIENT will automatically bundle Portable Java {}.", req)
    } else {
        let list: Vec<String> = runtimes
            .iter()
            .map(|r| format!("Java {}", r.get("major").and_then(|m| m.as_u64()).unwrap_or(0)))
            .collect();
        format!("Installed Java ({}) is older than required Java {}.", list.join(", "), req)
    };
    json!({
        "found": false,
        "exactMatch": false,
        "compatible": false,
        "runtime": Value::Null,
        "requiredMajor": req,
        "installed": runtimes,
        "message": message
    })
}

/// Where a Java comes from: "bundled" (downloaded by CRYOX CLIENT into the runtimes folder), "custom" (path chosen in Settings) or "system".
fn java_source(path: &str, java_dir: &Path) -> &'static str {
    let norm = |s: &str| s.replace('/', "\\").to_lowercase();
    let p = norm(path);
    let root = norm(&java_dir.to_string_lossy());
    if !root.is_empty() && root != "." && p.starts_with(&root) {
        return "bundled";
    }
    "system"
}

/// Read-only answer to "which Java will this profile use?" (nothing is downloaded here).
/// { requiredMajor, found, compatible, runtime, source, reason, autoProvision, message, runtimes: [... + source] }
pub fn describe_java_status(java_dir: &Path, required_major: u32, profile_setting: &str) -> Value {
    let res = resolve_java_for_version(java_dir, required_major, profile_setting);
    let settings = crate::settings::SettingsManager::new().get_settings();
    let default_setting = settings.get("defaultJavaRuntime").and_then(|v| v.as_str()).unwrap_or("auto").to_string();
    let auto_provision = settings.get("autoJavaProvision").and_then(|v| v.as_bool()).unwrap_or(true);

    let profile_setting = profile_setting.trim();
    let reason = if !profile_setting.is_empty() && profile_setting != "auto" {
        "profile"
    } else if !default_setting.is_empty() && default_setting != "auto" {
        "settings"
    } else {
        "auto"
    };

    let runtime = res.get("runtime").cloned().unwrap_or(Value::Null);
    let source = runtime
        .get("path")
        .and_then(|p| p.as_str())
        .map(|p| java_source(p, java_dir))
        .unwrap_or("none");

    let runtimes: Vec<Value> = res
        .get("installed")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut r| {
            let src = r.get("path").and_then(|p| p.as_str()).map(|p| java_source(p, java_dir)).unwrap_or("system");
            r["source"] = json!(src);
            r
        })
        .collect();

    json!({
        "requiredMajor": res.get("requiredMajor").cloned().unwrap_or(json!(required_major)),
        "found": res.get("found").cloned().unwrap_or(json!(false)),
        "compatible": res.get("compatible").cloned().unwrap_or(json!(false)),
        "runtime": runtime,
        "source": source,
        "reason": reason,
        "autoProvision": auto_provision,
        "message": res.get("message").cloned().unwrap_or(json!("")),
        "runtimes": runtimes
    })
}

/// Port of JavaManager.ensureJavaForVersion: use what is installed, otherwise bundle Portable Java
/// (only when Settings -> Auto-bundle Java is on). `on_progress(stage, percent, detail)` feeds the UI progress bar.
pub async fn ensure_java_for_version<F>(
    java_dir: &Path,
    required_major: u32,
    preferred_setting: &str,
    on_progress: F,
) -> Result<Value, String>
where
    F: Fn(&str, u32, &str),
{
    let initial = resolve_java_for_version(java_dir, required_major, preferred_setting);
    let ok = initial.get("found").and_then(|v| v.as_bool()).unwrap_or(false)
        && initial.get("compatible").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        return Ok(initial);
    }

    let settings = crate::settings::SettingsManager::new().get_settings();
    let auto = settings
        .get("autoJavaProvision")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !auto {
        let msg = initial
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("No compatible Java runtime found.")
            .to_string();
        return Err(format!(
            "{} Click \"Bundle Portable Java\" in Settings or enable Auto-Bundle Java.",
            msg
        ));
    }

    let client = reqwest::Client::builder()
        .user_agent("Cryox-Client-Launcher/1.0.0")
        .build()
        .map_err(|e| e.to_string())?;
    let bundled = bundle_portable_java_with_progress(&client, java_dir, required_major, &on_progress).await?;
    let major = bundled.get("major").and_then(|m| m.as_u64()).unwrap_or(required_major as u64);
    let version = bundled.get("version").and_then(|m| m.as_str()).unwrap_or("").to_string();
    Ok(json!({
        "found": true,
        "exactMatch": major == required_major as u64,
        "compatible": true,
        "runtime": bundled,
        "requiredMajor": required_major,
        "installed": detect_installed_runtimes(java_dir),
        "message": format!("Bundled & resolved Portable Java {} ({})", major, version)
    }))
}

fn java_info_json(info: &JavaInfo) -> Value {
    json!({
        "path": info.path,
        "version": info.version,
        "major": info.major,
        "arch": info.arch,
        "is64Bit": info.arch == "x64"
    })
}

pub async fn bundle_portable_java(
    client: &reqwest::Client,
    java_dir: &Path,
    target_major: u32,
) -> Result<Value, String> {
    bundle_portable_java_with_progress(client, java_dir, target_major, &|_s: &str, _p: u32, _d: &str| {}).await
}

/// Port of JavaManager.bundlePortableJavaRuntime: Adoptium JRE (falls back to JDK, then Java 21 JRE),
/// extracted into <javaDir>/java-<major>, with progress for the UI.
pub async fn bundle_portable_java_with_progress<F>(
    client: &reqwest::Client,
    java_dir: &Path,
    target_major: u32,
    on_progress: &F,
) -> Result<Value, String>
where
    F: Fn(&str, u32, &str),
{
    let major = if [8, 17, 21, 25].contains(&target_major) { target_major } else { 21 };
    let dest_folder = java_dir.join(format!("java-{major}"));
    let stage = format!("Bundling Portable Java {major}");

    // already bundled?
    let mut existing: HashSet<String> = HashSet::new();
    scan_dir_for_java(&dest_folder, 4, &mut existing);
    for c in existing {
        if let Some(info) = probe_java_binary(&c) {
            if info.major >= major {
                return Ok(java_info_json(&info));
            }
        }
    }

    std::fs::create_dir_all(&dest_folder).map_err(|e| e.to_string())?;

    let urls = [
        format!("https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jre/hotspot/normal/eclipse"),
        format!("https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jdk/hotspot/normal/eclipse"),
        "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse".to_string(),
    ];

    on_progress(
        &stage,
        10,
        &format!("Downloading official Portable Java {major} (windows-x64) into CRYOX CLIENT..."),
    );

    let mut zip_bytes: Vec<u8> = Vec::new();
    let mut last_error = String::from("no download URL worked");
    for url in urls.iter() {
        let mut res = match client
            .get(url)
            .header("User-Agent", "Cryox-Client-Launcher/1.0.0 (windows)")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("{e} from {url}");
                continue;
            }
        };
        if !res.status().is_success() {
            last_error = format!("HTTP {} from {}", res.status(), url);
            continue;
        }
        let total = res.content_length().unwrap_or(50 * 1024 * 1024).max(1);
        let mut buf: Vec<u8> = Vec::new();
        let mut failed = false;
        loop {
            match res.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    let pct = (10 + ((buf.len() as u64 * 75) / total)).min(85) as u32;
                    on_progress(
                        &stage,
                        pct,
                        &format!("Downloading Portable Java {major} ({:.1} MB)...", buf.len() as f64 / (1024.0 * 1024.0)),
                    );
                }
                Ok(None) => break,
                Err(e) => {
                    last_error = format!("{e} from {url}");
                    failed = true;
                    break;
                }
            }
        }
        if !failed && buf.len() > 100_000 {
            zip_bytes = buf;
            break;
        }
    }
    if zip_bytes.is_empty() {
        return Err(format!("Failed to download Portable Java {major}: {last_error}"));
    }

    on_progress(&stage, 88, &format!("Extracting Portable Java {major}..."));
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        let rel_path = match name.find('/') {
            Some(idx) => name[idx + 1..].to_string(),
            None => name.clone(),
        };
        if rel_path.is_empty() || rel_path.contains("..") {
            continue;
        }

        let outpath = dest_folder.join(&rel_path);
        if file.is_dir() {
            let _ = std::fs::create_dir_all(&outpath);
        } else {
            if let Some(p) = outpath.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    let mut found: HashSet<String> = HashSet::new();
    scan_dir_for_java(&dest_folder, 4, &mut found);
    for c in found {
        if let Some(info) = probe_java_binary(&c) {
            on_progress(&stage, 100, &format!("Portable Java {} ready.", info.major));
            return Ok(java_info_json(&info));
        }
    }
    Err(format!("Extracted Portable Java {major}, but java executable could not be verified."))
}
