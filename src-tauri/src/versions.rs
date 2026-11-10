use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub const MOJANG_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

pub fn fallback_versions() -> Value {
    json!([
        { "id": "1.21.4", "type": "release", "releaseTime": "2024-12-03T10:12:57+00:00", "url": "https://piston-meta.mojang.com/v1/packages/a3bc74f63222b233c5d4c55b52809822d0b443e0/1.21.4.json", "javaVersion": 21 },
        { "id": "1.21.3", "type": "release", "releaseTime": "2024-10-23T13:18:09+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.21.3.json", "javaVersion": 21 },
        { "id": "1.21.1", "type": "release", "releaseTime": "2024-08-08T12:24:45+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.21.1.json", "javaVersion": 21 },
        { "id": "1.21", "type": "release", "releaseTime": "2024-06-13T08:32:38+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.21.json", "javaVersion": 21 },
        { "id": "1.20.6", "type": "release", "releaseTime": "2024-04-29T12:14:20+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.20.6.json", "javaVersion": 21 },
        { "id": "1.20.4", "type": "release", "releaseTime": "2023-12-07T12:56:20+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.20.4.json", "javaVersion": 17 },
        { "id": "1.20.2", "type": "release", "releaseTime": "2023-09-21T09:35:30+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.20.2.json", "javaVersion": 17 },
        { "id": "1.20.1", "type": "release", "releaseTime": "2023-06-12T13:25:11+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.20.1.json", "javaVersion": 17 },
        { "id": "1.19.4", "type": "release", "releaseTime": "2023-03-14T12:56:18+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.19.4.json", "javaVersion": 17 },
        { "id": "1.19.2", "type": "release", "releaseTime": "2022-08-05T11:57:05+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.19.2.json", "javaVersion": 17 },
        { "id": "1.18.2", "type": "release", "releaseTime": "2022-02-28T10:48:16+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.18.2.json", "javaVersion": 17 },
        { "id": "1.17.1", "type": "release", "releaseTime": "2021-07-06T12:04:40+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.17.1.json", "javaVersion": 16 },
        { "id": "1.16.5", "type": "release", "releaseTime": "2021-01-15T16:05:32+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.16.5.json", "javaVersion": 8 },
        { "id": "1.12.2", "type": "release", "releaseTime": "2017-09-18T08:39:46+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.12.2.json", "javaVersion": 8 },
        { "id": "1.8.9", "type": "release", "releaseTime": "2015-12-09T09:24:39+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.8.9.json", "javaVersion": 8 },
        { "id": "1.7.10", "type": "release", "releaseTime": "2014-05-14T17:29:23+00:00", "url": "https://piston-meta.mojang.com/v1/packages/1.7.10.json", "javaVersion": 8 }
    ])
}

pub fn get_required_java_major(mc_version: &str) -> u32 {
    let v = mc_version.trim();
    if v.starts_with('a')
        || v.starts_with('b')
        || v.starts_with('c')
        || v.starts_with("rd-")
        || v.starts_with("inf-")
    {
        return 8;
    }

    let parts: Vec<u32> = v
        .split('.')
        .filter_map(|s| s.parse::<u32>().ok())
        .collect();

    if let Some(&first) = parts.first() {
        if first == 1 {
            let minor = parts.get(1).copied().unwrap_or(0);
            let patch = parts.get(2).copied().unwrap_or(0);
            if minor >= 21 || (minor == 20 && patch >= 5) {
                return 21;
            }
            if minor >= 18 {
                return 17;
            }
            if minor == 17 {
                return 16;
            }
            return 8;
        }
        if first >= 26 || v.starts_with("26w") || v.starts_with("27w") || v.starts_with("28w") {
            return 25;
        }
    }

    21
}

pub async fn get_version_manifest(config_dir: &Path, force_refresh: bool) -> Value {
    let cache_path = config_dir.join("cache").join("version_manifest_v2.json");

    if !force_refresh && cache_path.exists() {
        if let Ok(meta) = fs::metadata(&cache_path) {
            if let Ok(mtime) = meta.modified() {
                if let Ok(age) = SystemTime::now().duration_since(mtime) {
                    if age < Duration::from_secs(6 * 3600) {
                        if let Ok(content) = fs::read_to_string(&cache_path) {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                                if parsed.get("versions").and_then(|v| v.as_array()).is_some() {
                                    return parsed;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Cryox-Client-Launcher/1.0.0")
        .build();

    if let Ok(client) = client {
        if let Ok(res) = client.get(MOJANG_MANIFEST_URL).send().await {
            if res.status().is_success() {
                if let Ok(data) = res.json::<Value>().await {
                    if data.get("versions").and_then(|v| v.as_array()).is_some() {
                        let _ = fs::create_dir_all(cache_path.parent().unwrap_or(config_dir));
                        if let Ok(formatted) = serde_json::to_string_pretty(&data) {
                            let _ = fs::write(&cache_path, formatted);
                        }
                        return data;
                    }
                }
            }
        }
    }

    // Try offline cache fallback
    if cache_path.exists() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(mut parsed) = serde_json::from_str::<Value>(&content) {
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("offlineCache".to_string(), json!(true));
                    return parsed;
                }
            }
        }
    }

    // Hardcoded fallback
    let fallbacks = fallback_versions();
    json!({
        "latest": {
            "release": "1.21.4",
            "snapshot": "1.21.4"
        },
        "versions": fallbacks,
        "offlineFallback": true
    })
}

pub async fn list_versions(
    config_dir: &Path,
    include_snapshots: bool,
    force_refresh: bool,
) -> Value {
    let manifest = get_version_manifest(config_dir, force_refresh).await;
    let versions = manifest.get("versions").and_then(|v| v.as_array());

    let mut filtered = Vec::new();
    if let Some(versions) = versions {
        for v in versions {
            let v_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let allow = v_type == "release"
                || (include_snapshots && v_type == "snapshot")
                || v_type == "old_beta"
                || v_type == "old_alpha";

            if allow {
                let id = v.get("id").and_then(|s| s.as_str()).unwrap_or("");
                filtered.push(json!({
                    "id": id,
                    "type": v_type,
                    "releaseTime": v.get("releaseTime"),
                    "url": v.get("url"),
                    "sha1": v.get("sha1"),
                    "requiredJava": get_required_java_major(id)
                }));
            }
        }
    }

    let first_release = filtered
        .iter()
        .find(|v| v.get("type").and_then(|t| t.as_str()) == Some("release"))
        .and_then(|v| v.get("id"));

    json!({
        "latest": manifest.get("latest").cloned().unwrap_or_else(|| json!({ "release": first_release })),
        "offline": manifest.get("offlineFallback").is_some() || manifest.get("offlineCache").is_some(),
        "versions": filtered
    })
}

/// x_client getRequiredJavaMajor(mcVersion, versionMeta): Mojang's own `javaVersion.majorVersion` wins.
pub fn get_required_java_major_with_meta(mc_version: &str, meta: &Value) -> u32 {
    if let Some(m) = meta
        .get("javaVersion")
        .and_then(|j| j.get("majorVersion"))
        .and_then(|m| m.as_u64())
    {
        if m > 0 {
            return m as u32;
        }
    }
    get_required_java_major(mc_version)
}
