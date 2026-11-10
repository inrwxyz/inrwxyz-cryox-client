use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderVersionItem {
    pub version: String,
    pub stable: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderSupport {
    pub supported: bool,
    pub versions: Vec<LoaderVersionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupportedLoaders {
    pub vanilla: LoaderSupport,
    pub fabric: LoaderSupport,
    pub forge: LoaderSupport,
    pub neoforge: LoaderSupport,
    pub quilt: LoaderSupport,
}

pub async fn get_fabric_loader_versions(
    client: &reqwest::Client,
    mc_version: &str,
) -> Vec<LoaderVersionItem> {
    let url = format!(
        "https://meta.fabricmc.net/v2/versions/loader/{}",
        mc_version
    );
    if let Ok(res) = client
        .get(&url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(arr) = json.as_array() {
                    let mut list = Vec::new();
                    for (idx, item) in arr.iter().take(15).enumerate() {
                        if let Some(loader) = item.get("loader") {
                            let ver = loader
                                .get("version")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let stable = loader
                                .get("stable")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if !ver.is_empty() {
                                list.push(LoaderVersionItem {
                                    version: ver.to_string(),
                                    stable,
                                    label: if idx == 0 {
                                        format!("{} (latest)", ver)
                                    } else {
                                        ver.to_string()
                                    },
                                });
                            }
                        }
                    }
                    return list;
                }
            }
        }
    }
    Vec::new()
}

pub async fn get_forge_loader_versions(
    client: &reqwest::Client,
    mc_version: &str,
) -> Vec<LoaderVersionItem> {
    let url = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
    if let Ok(res) = client
        .get(url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(promos) = json.get("promos").and_then(|p| p.as_object()) {
                    let mut list = Vec::new();
                    let rec_key = format!("{}-recommended", mc_version);
                    let lat_key = format!("{}-latest", mc_version);

                    if let Some(rec) = promos.get(&rec_key).and_then(|v| v.as_str()) {
                        list.push(LoaderVersionItem {
                            version: rec.to_string(),
                            stable: true,
                            label: format!("{} (recommended)", rec),
                        });
                    }
                    if let Some(lat) = promos.get(&lat_key).and_then(|v| v.as_str()) {
                        if !list.iter().any(|i| i.version == lat) {
                            list.push(LoaderVersionItem {
                                version: lat.to_string(),
                                stable: false,
                                label: format!("{} (latest)", lat),
                            });
                        }
                    }
                    return list;
                }
            }
        }
    }
    Vec::new()
}

pub async fn get_quilt_loader_versions(
    client: &reqwest::Client,
    mc_version: &str,
) -> Vec<LoaderVersionItem> {
    let url = format!(
        "https://meta.quiltmc.org/v3/versions/loader/{}",
        mc_version
    );
    if let Ok(res) = client
        .get(&url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(arr) = json.as_array() {
                    let mut list = Vec::new();
                    for (idx, item) in arr.iter().take(15).enumerate() {
                        if let Some(loader) = item.get("loader") {
                            let ver = loader
                                .get("version")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !ver.is_empty() {
                                list.push(LoaderVersionItem {
                                    version: ver.to_string(),
                                    stable: true,
                                    label: if idx == 0 {
                                        format!("{} (latest)", ver)
                                    } else {
                                        ver.to_string()
                                    },
                                });
                            }
                        }
                    }
                    return list;
                }
            }
        }
    }
    Vec::new()
}

pub async fn get_supported_loaders(client: &reqwest::Client, mc_version: &str) -> SupportedLoaders {
    let ver = mc_version.trim();

    let (fabric_res, forge_res, quilt_res) = tokio::join!(
        get_fabric_loader_versions(client, ver),
        get_forge_loader_versions(client, ver),
        get_quilt_loader_versions(client, ver),
    );

    let fabric_supported = !fabric_res.is_empty();
    let forge_supported = !forge_res.is_empty();
    let quilt_supported = !quilt_res.is_empty();

    SupportedLoaders {
        vanilla: LoaderSupport {
            supported: true,
            versions: vec![LoaderVersionItem {
                version: "official".to_string(),
                stable: true,
                label: "Official Mojang Release".to_string(),
            }],
        },
        fabric: LoaderSupport {
            supported: fabric_supported,
            versions: if fabric_supported {
                fabric_res
            } else {
                vec![LoaderVersionItem {
                    version: "none".to_string(),
                    stable: false,
                    label: format!("Not Available for {}", ver),
                }]
            },
        },
        forge: LoaderSupport {
            supported: forge_supported,
            versions: if forge_supported {
                forge_res
            } else {
                vec![LoaderVersionItem {
                    version: "none".to_string(),
                    stable: false,
                    label: format!("Not Available for {}", ver),
                }]
            },
        },
        neoforge: LoaderSupport {
            supported: false,
            versions: vec![LoaderVersionItem {
                version: "none".to_string(),
                stable: false,
                label: format!("Not Available for {}", ver),
            }],
        },
        quilt: LoaderSupport {
            supported: quilt_supported,
            versions: if quilt_supported {
                quilt_res
            } else {
                vec![LoaderVersionItem {
                    version: "none".to_string(),
                    stable: false,
                    label: format!("Not Available for {}", ver),
                }]
            },
        },
    }
}


pub fn maven_coord_to_path(coord: &str) -> Option<String> {
    let raw = coord.trim();
    if raw.is_empty() {
        return None;
    }
    let (coord_part, ext_override) = match raw.split_once('@') {
        Some((c, e)) => (c, e),
        None => (raw, "jar"),
    };
    let parts: Vec<&str> = coord_part.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = parts.get(3);

    let file_name = if let Some(cls) = classifier {
        format!("{}-{}-{}.{}", artifact, version, cls, ext_override)
    } else {
        format!("{}-{}.{}", artifact, version, ext_override)
    };
    Some(format!("{}/{}/{}/{}", group, artifact, version, file_name))
}

pub async fn resolve_fabric_profile(
    client: &reqwest::Client,
    mc_version: &str,
    loader_version: &str,
) -> serde_json::Value {
    let mut resolved_loader = loader_version.to_string();

    if resolved_loader.is_empty() || resolved_loader == "latest" || resolved_loader == "official" {
        let meta_url = format!("https://meta.fabricmc.net/v2/versions/loader/{}", mc_version);
        if let Ok(res) = client
            .get(&meta_url)
            .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(arr) = res.json::<Vec<serde_json::Value>>().await {
                    if let Some(first) = arr.first() {
                        if let Some(v) = first.get("loader").and_then(|l| l.get("version")).and_then(|s| s.as_str()) {
                            resolved_loader = v.to_string();
                        }
                    }
                }
            }
        }
    }

    if resolved_loader.is_empty() || resolved_loader == "latest" || resolved_loader == "official" {
        resolved_loader = "0.19.5".to_string();
    }

    let url = format!(
        "https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json",
        mc_version, resolved_loader
    );

    if let Ok(res) = client
        .get(&url)
        .header("User-Agent", "Cryox-Client-Launcher/1.0.0")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                return json;
            }
        }
    }

    serde_json::json!({
        "id": format!("fabric-loader-{}-{}", resolved_loader, mc_version),
        "inheritsFrom": mc_version,
        "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
        "libraries": [
            { "name": format!("net.fabricmc:fabric-loader:{}", resolved_loader), "url": "https://maven.fabricmc.net/" },
            { "name": format!("net.fabricmc:intermediary:{}", mc_version), "url": "https://maven.fabricmc.net/" },
            { "name": "net.fabricmc:sponge-mixin:0.17.5+mixin.0.8.7", "url": "https://maven.fabricmc.net/" },
            { "name": "org.ow2.asm:asm:9.10.1", "url": "https://maven.fabricmc.net/" },
            { "name": "org.ow2.asm:asm-analysis:9.10.1", "url": "https://maven.fabricmc.net/" },
            { "name": "org.ow2.asm:asm-commons:9.10.1", "url": "https://maven.fabricmc.net/" },
            { "name": "org.ow2.asm:asm-tree:9.10.1", "url": "https://maven.fabricmc.net/" },
            { "name": "org.ow2.asm:asm-util:9.10.1", "url": "https://maven.fabricmc.net/" }
        ]
    })
}

/// Port of LoaderManager.isValidLoaderMainClass.
pub fn is_valid_loader_main_class(loader: &str, main_class: &str) -> bool {
    let l = if loader.is_empty() { "vanilla".to_string() } else { loader.to_lowercase() };
    let mc = main_class;
    if mc.is_empty() {
        return false;
    }
    match l.as_str() {
        "vanilla" => mc == "net.minecraft.client.main.Main",
        "fabric" => mc.contains("fabricmc"),
        "forge" => {
            mc == "cpw.mods.bootstraplauncher.BootstrapLauncher"
                || (!mc.contains("fabricmc") && mc != "net.minecraft.client.main.Main")
        }
        "neoforge" => mc.contains("neoforged") || mc.contains("knot"),
        "quilt" => mc.contains("quiltmc") || mc.contains("knot"),
        _ => true,
    }
}
