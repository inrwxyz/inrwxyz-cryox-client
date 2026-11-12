use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub const LOADERS: &[&str] = &["vanilla", "paper", "purpur", "fabric"];
pub const META_FILE: &str = "inex-server.json";
pub const LOG_LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMeta {
    pub id: String,
    pub name: String,
    pub loader: String,
    pub version: String,
    #[serde(default = "default_loader_version")]
    pub loader_version: String,
    #[serde(default)]
    pub java_major: Option<u32>,
    #[serde(default = "default_server_ram")]
    pub ram_mb: u32,
    #[serde(default = "default_server_port")]
    pub port: u16,
    #[serde(default = "default_true")]
    pub playit: bool,
    #[serde(default = "default_bore_tunnel")]
    pub java_tunnel: String,
    #[serde(default = "default_true")]
    pub eula_accepted: bool,
    #[serde(default = "default_now")]
    pub created_at: u64,
}

fn default_loader_version() -> String {
    "official".to_string()
}
fn default_server_ram() -> u32 {
    2048
}
fn default_server_port() -> u16 {
    25565
}
fn default_true() -> bool {
    true
}
fn default_bore_tunnel() -> String {
    "playit".to_string()
}
fn default_now() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPublicState {
    #[serde(flatten)]
    pub meta: ServerMeta,
    pub max_players: u32,
    pub status: String,
    pub players: Vec<String>,
    pub started_at: Option<u64>,
    pub cpu: f32,
    pub used_ram_mb: u32,
    pub bedrock: BedrockInfo,
    pub logo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockInfo {
    pub installed: bool,
    pub port: u16,
    /// UI reads these two (same shape as x_client): supported = not a Vanilla server, geyser = Geyser jar present
    pub supported: bool,
    pub geyser: bool,
}

pub struct ServerProcess {
    pub id: String,
    pub status: String,
    pub stdin: Option<ChildStdin>,
    pub child: Option<Child>,
    pub logs: Vec<String>,
    pub players: HashSet<String>,
    pub started_at: Option<u64>,
    pub port: u16,
    pub cpu: f32,
    pub used_ram_mb: u32,
}

static SERVER_RUNTIMES: OnceLock<Arc<Mutex<HashMap<String, Arc<Mutex<ServerProcess>>>>>> =
    OnceLock::new();

fn get_server_runtimes() -> &'static Arc<Mutex<HashMap<String, Arc<Mutex<ServerProcess>>>>> {
    SERVER_RUNTIMES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for c in s.bytes() {
        let v = (match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        }) as u32;
        buf = ((buf << 6) | v) & 0xFF_FFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

fn write_logo(dir: &Path, data_url: &str) -> bool {
    let data_url = data_url.trim();
    if !data_url.to_lowercase().starts_with("data:image/png") {
        return false;
    }
    let b64 = match data_url.split_once("base64,") {
        Some((_, b)) => b,
        None => return false,
    };
    if let Some(bytes) = base64_decode(b64) {
        if bytes.len() >= 8 && bytes.len() <= 200 * 1024 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47] {
            let _ = fs::create_dir_all(dir);
            return fs::write(dir.join("server-icon.png"), bytes).is_ok();
        }
    }
    false
}

pub fn tunnel_params(game_data_dir: &str, id: &str) -> (u16, Option<u16>, String) {
    let meta = read_meta(game_data_dir, id);
    let port = meta.as_ref().map(|m| m.port).unwrap_or(25565);
    let tunnel = meta.as_ref().map(|m| m.java_tunnel.clone()).unwrap_or_else(|| "playit".to_string());
    let b = detect_bedrock(game_data_dir, id);
    (port, if b.installed { Some(b.port) } else { None }, tunnel)
}

pub fn get_server_dir(game_data_dir: &str, id: &str) -> PathBuf {
    let safe_id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let safe_id = if safe_id.is_empty() || safe_id == "." || safe_id == ".." || safe_id.contains("..") {
        "_invalid_server".to_string()
    } else {
        safe_id
    };
    Path::new(game_data_dir).join("servers").join(safe_id)
}

pub fn slugify(name: &str) -> String {
    let clean: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.chars().take(32).collect()
    }
}

pub fn read_meta(game_data_dir: &str, id: &str) -> Option<ServerMeta> {
    let meta_path = get_server_dir(game_data_dir, id).join(META_FILE);
    if meta_path.exists() {
        if let Ok(raw) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<ServerMeta>(&raw) {
                return Some(meta);
            }
        }
    }
    None
}

pub fn write_meta(game_data_dir: &str, meta: &ServerMeta) -> Result<(), String> {
    let dir = get_server_dir(game_data_dir, &meta.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(dir.join(META_FILE), json).map_err(|e| e.to_string())
}

pub fn read_logo(game_data_dir: &str, id: &str) -> String {
    let f = get_server_dir(game_data_dir, id).join("server-icon.png");
    if f.is_file() {
        if let Ok(bytes) = fs::read(&f) {
            if bytes.len() <= 200 * 1024 {
                return format!("data:image/png;base64,{}", base64_encode(&bytes));
            }
        }
    }
    String::new()
}

fn geyser_config_path(dir: &Path, loader: &str) -> PathBuf {
    if loader == "fabric" {
        dir.join("config").join("Geyser-Fabric").join("config.yml")
    } else {
        dir.join("plugins").join("Geyser-Spigot").join("config.yml")
    }
}

/// bedrock: / port: <n> from Geyser's config.yml (default 19132)
fn read_geyser_port(cfg: &Path) -> u16 {
    let txt = fs::read_to_string(cfg).unwrap_or_default();
    let mut in_bedrock = false;
    for line in txt.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() || t.trim_start().starts_with('#') {
            continue;
        }
        let indented = t.starts_with(' ') || t.starts_with('\t');
        if !indented {
            in_bedrock = t.trim() == "bedrock:";
            continue;
        }
        if in_bedrock {
            if let Some(v) = t.trim().strip_prefix("port:") {
                if let Ok(p) = v.trim().parse::<u16>() {
                    return p;
                }
            }
        }
    }
    19132
}

pub fn detect_bedrock(game_data_dir: &str, id: &str) -> BedrockInfo {
    let dir = get_server_dir(game_data_dir, id);
    let loader = read_meta(game_data_dir, id).map(|m| m.loader).unwrap_or_default();
    if loader == "vanilla" {
        return BedrockInfo { installed: false, port: 19132, supported: false, geyser: false };
    }
    // Paper/Purpur load Geyser from plugins/, Fabric from mods/
    let folder = dir.join(if loader == "fabric" { "mods" } else { "plugins" });
    let mut installed = false;
    if let Ok(entries) = fs::read_dir(&folder) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains("geyser") && name.ends_with(".jar") {
                installed = true;
                break;
            }
        }
    }
    BedrockInfo {
        installed,
        port: read_geyser_port(&geyser_config_path(&dir, &loader)),
        supported: true,
        geyser: installed,
    }
}

/// Geyser must use offline login when the server is offline-mode (like x_client). true = config was changed.
pub fn apply_geyser_auth(game_data_dir: &str, id: &str) -> bool {
    let dir = get_server_dir(game_data_dir, id);
    let loader = read_meta(game_data_dir, id).map(|m| m.loader).unwrap_or_default();
    if loader == "vanilla" {
        return false;
    }
    if read_properties_values(&dir).get("online-mode").map(|v| v == "true").unwrap_or(false) {
        return false;
    }
    let file = geyser_config_path(&dir, &loader);
    let yml = match fs::read_to_string(&file) {
        Ok(y) => y,
        Err(_) => return false,
    };
    let mut changed = false;
    let mut out: Vec<String> = Vec::new();
    for line in yml.lines() {
        let t = line.trim_start();
        if !changed && t.starts_with("auth-type:") {
            if t["auth-type:".len()..].trim() == "offline" {
                return false;
            }
            let indent = &line[..line.len() - t.len()];
            out.push(format!("{}auth-type: offline", indent));
            changed = true;
        } else {
            out.push(line.to_string());
        }
    }
    if changed {
        let _ = fs::write(&file, out.join("\n") + "\n");
    }
    changed
}

pub fn kill_all_servers() {
    let ids: Vec<String> = {
        let runtimes = get_server_runtimes().lock().unwrap();
        runtimes.keys().cloned().collect()
    };
    for id in ids {
        let _ = kill_server(&id);
    }
}

pub fn public_state(game_data_dir: &str, meta: ServerMeta) -> ServerPublicState {
    let dir = get_server_dir(game_data_dir, &meta.id);
    let props = read_properties_values(&dir);
    let max_players = props
        .get("max-players")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(20);

    let runtimes = get_server_runtimes().lock().unwrap();
    let (status, players, started_at, cpu, used_ram_mb) = if let Some(rt_arc) = runtimes.get(&meta.id) {
        let rt = rt_arc.lock().unwrap();
        (
            rt.status.clone(),
            rt.players.iter().cloned().collect(),
            rt.started_at,
            rt.cpu,
            rt.used_ram_mb,
        )
    } else {
        ("offline".to_string(), Vec::new(), None, 0.0, 0)
    };

    ServerPublicState {
        meta: meta.clone(),
        max_players,
        status,
        players,
        started_at,
        cpu,
        used_ram_mb,
        bedrock: detect_bedrock(game_data_dir, &meta.id),
        logo: read_logo(game_data_dir, &meta.id),
    }
}

pub fn list_servers(game_data_dir: &str) -> Vec<ServerPublicState> {
    let root = Path::new(game_data_dir).join("servers");
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.path().is_dir() {
                let id = entry.file_name().to_string_lossy().to_string();
                if let Some(meta) = read_meta(game_data_dir, &id) {
                    out.push(public_state(game_data_dir, meta));
                }
            }
        }
    }
    out.sort_by(|a, b| a.meta.created_at.cmp(&b.meta.created_at));
    out
}

pub fn get_server(game_data_dir: &str, id: &str) -> Result<ServerPublicState, String> {
    let meta = read_meta(game_data_dir, id).ok_or_else(|| "Server not found".to_string())?;
    Ok(public_state(game_data_dir, meta))
}

pub fn read_properties_values(server_dir: &Path) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let file = server_dir.join("server.properties");
    if file.exists() {
        if let Ok(content) = fs::read_to_string(&file) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some(idx) = trimmed.find('=') {
                    let k = trimmed[..idx].trim().to_string();
                    let v = trimmed[idx + 1..].trim().to_string();
                    values.insert(k, v);
                }
            }
        }
    }
    values
}

pub fn write_properties(server_dir: &Path, updates: &HashMap<String, String>) -> Result<(), String> {
    let sanitized_updates: HashMap<String, String> = updates
        .iter()
        .filter_map(|(k, v)| {
            let clean_k = k.trim();
            if clean_k.is_empty() || clean_k.contains(['\r', '\n', '=', '#']) {
                return None;
            }
            let clean_v = v.replace(['\r', '\n'], " ");
            Some((clean_k.to_string(), clean_v))
        })
        .collect();

    let file = server_dir.join("server.properties");
    // x_client keeps the existing file (comments, order) and only changes / appends the keys that were sent.
    let mut lines: Vec<String> = if file.exists() {
        fs::read_to_string(&file)
            .map_err(|e| e.to_string())?
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect()
    } else {
        Vec::new()
    };

    let mut used: HashSet<String> = HashSet::new();
    for line in lines.iter_mut() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(i) = line.find('=') {
            if i == 0 {
                continue;
            }
            let key = line[..i].trim().to_string();
            if let Some(v) = sanitized_updates.get(&key) {
                *line = format!("{key}={v}");
                used.insert(key);
            }
        }
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let mut pending: Vec<(&String, &String)> = sanitized_updates.iter().filter(|(k, _)| !used.contains(*k)).collect();
    pending.sort_by(|a, b| a.0.cmp(b.0));
    for (k, v) in pending {
        lines.push(format!("{k}={v}"));
    }

    fs::write(file, lines.join("\n") + "\n").map_err(|e| e.to_string())
}

/// Port of x_client's DEFAULT_PROPERTIES (what the Properties tab shows as defaults).
pub fn default_properties_template() -> HashMap<String, String> {
    let pairs: [(&str, &str); 28] = [
        ("server-port", "25565"),
        ("motd", "A CRYOX CLIENT server"),
        ("max-players", "20"),
        ("online-mode", "false"),
        ("white-list", "false"),
        ("enforce-whitelist", "false"),
        ("pvp", "true"),
        ("difficulty", "easy"),
        ("gamemode", "survival"),
        ("force-gamemode", "true"),
        ("view-distance", "10"),
        ("simulation-distance", "10"),
        ("allow-flight", "false"),
        ("allow-nether", "true"),
        ("allow-end", "true"),
        ("spawn-monsters", "true"),
        ("generate-structures", "true"),
        ("hardcore", "false"),
        ("hide-online-players", "false"),
        ("enforce-secure-profile", "false"),
        ("accepts-transfers", "false"),
        ("log-ips", "true"),
        ("sync-chunk-writes", "true"),
        ("enable-status", "true"),
        ("broadcast-console-to-ops", "true"),
        ("spawn-protection", "0"),
        ("player-idle-timeout", "0"),
        ("enable-command-block", "false"),
    ];
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// Defaults used when a NEW server is created (x_client: DEFAULT_PROPERTIES + the chosen port and "<name> · X CLIENT" motd).
pub fn default_properties(name: &str, port: u16) -> HashMap<String, String> {
    let mut map = default_properties_template();
    map.insert("server-port".to_string(), port.to_string());
    map.insert("motd".to_string(), format!("{name} · CRYOX CLIENT"));
    map
}

/// x_client serverManager.stopAll(): ask every running server to stop, wait a little, then kill what is left.
pub async fn stop_all_servers() {
    let ids: Vec<String> = {
        let runtimes = get_server_runtimes().lock().unwrap();
        runtimes.keys().cloned().collect()
    };
    if ids.is_empty() {
        return;
    }
    for id in &ids {
        let _ = stop_server(id);
    }
    for _ in 0..30 {
        let any_alive = {
            let runtimes = get_server_runtimes().lock().unwrap();
            runtimes.values().any(|rt| {
                rt.lock()
                    .map(|r| r.child.is_some() && r.status != "offline")
                    .unwrap_or(false)
            })
        };
        if !any_alive {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    for id in &ids {
        let _ = kill_server(id);
    }
}

fn parse_version_nums(v: &str) -> Vec<u32> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

fn compare_mc_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = parse_version_nums(a);
    let pb = parse_version_nums(b);
    for (na, nb) in pa.iter().zip(pb.iter()) {
        if na != nb {
            return na.cmp(nb);
        }
    }
    pa.len().cmp(&pb.len())
}

pub async fn get_versions_for_loader(loader: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("CryoxClient/1.0.0 (contact@cryox.client)")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    match loader.to_lowercase().as_str() {
        "vanilla" => {
            if let Ok(res) = client
                .get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
                .send()
                .await
            {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    let mut list = Vec::new();
                    if let Some(arr) = json.get("versions").and_then(|v| v.as_array()) {
                        for v in arr {
                            if v.get("type").and_then(|t| t.as_str()) == Some("release") {
                                if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                                    list.push(id.to_string());
                                }
                            }
                        }
                    }
                    if !list.is_empty() {
                        return Ok(list);
                    }
                }
            }
            Ok(vec![
                "1.21.4".into(), "1.21.3".into(), "1.21.1".into(), "1.21".into(),
                "1.20.6".into(), "1.20.4".into(), "1.20.2".into(), "1.20.1".into(),
                "1.19.4".into(), "1.19.2".into(), "1.18.2".into(), "1.17.1".into(),
                "1.16.5".into(), "1.12.2".into(), "1.8.9".into(), "1.7.10".into(),
            ])
        }
        "paper" => {
            // PaperMC v3 Fill API
            if let Ok(res) = client
                .get("https://fill.papermc.io/v3/projects/paper")
                .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
                .send()
                .await
            {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    let mut stable_list = Vec::new();
                    let mut pre_list = Vec::new();
                    if let Some(obj) = json.get("versions").and_then(|v| v.as_object()) {
                        for (_fam, arr) in obj {
                            if let Some(arr) = arr.as_array() {
                                for v in arr {
                                    if let Some(s) = v.as_str() {
                                        if s.contains('-') {
                                            pre_list.push(s.to_string());
                                        } else {
                                            stable_list.push(s.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if !stable_list.is_empty() {
                        stable_list.sort_by(|a, b| compare_mc_versions(b, a));
                        pre_list.sort_by(|a, b| compare_mc_versions(b, a));
                        stable_list.extend(pre_list);
                        return Ok(stable_list);
                    }
                }
            }
            Ok(vec![
                "1.21.4".into(), "1.21.3".into(), "1.21.1".into(), "1.21".into(),
                "1.20.6".into(), "1.20.4".into(), "1.20.2".into(), "1.20.1".into(),
                "1.19.4".into(), "1.19.2".into(), "1.18.2".into(),
            ])
        }
        "purpur" => {
            if let Ok(res) = client
                .get("https://api.purpurmc.org/v2/purpur")
                .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
                .send()
                .await
            {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    let mut list = Vec::new();
                    if let Some(arr) = json.get("versions").and_then(|v| v.as_array()) {
                        for v in arr {
                            if let Some(s) = v.as_str() {
                                list.push(s.to_string());
                            }
                        }
                    }
                    if !list.is_empty() {
                        list.sort_by(|a, b| compare_mc_versions(b, a));
                        return Ok(list);
                    }
                }
            }
            Ok(vec![
                "1.21.4".into(), "1.21.3".into(), "1.21.1".into(), "1.21".into(),
                "1.20.6".into(), "1.20.4".into(), "1.20.2".into(), "1.20.1".into(),
            ])
        }
        "fabric" => {
            if let Ok(res) = client.get("https://meta.fabricmc.net/v2/versions/game").send().await {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    let mut list = Vec::new();
                    if let Some(arr) = json.as_array() {
                        for v in arr {
                            if v.get("stable").and_then(|s| s.as_bool()) == Some(true) {
                                if let Some(ver) = v.get("version").and_then(|s| s.as_str()) {
                                    list.push(ver.to_string());
                                }
                            }
                        }
                    }
                    if !list.is_empty() {
                        return Ok(list);
                    }
                }
            }
            Ok(vec![
                "1.21.4".into(), "1.21.3".into(), "1.21.1".into(), "1.21".into(),
                "1.20.6".into(), "1.20.4".into(), "1.20.2".into(), "1.20.1".into(),
            ])
        }
        _ => Err("Unsupported loader".to_string()),
    }
}

pub async fn create_server(
    game_data_dir: &str,
    payload: &serde_json::Value,
) -> Result<ServerPublicState, String> {
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Give your server a name".to_string())?
        .trim();
    if name.is_empty() {
        return Err("Server name cannot be empty".to_string());
    }

    let loader = payload
        .get("loader")
        .and_then(|v| v.as_str())
        .unwrap_or("paper")
        .to_lowercase();
    let version = payload
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Pick a Minecraft version".to_string())?
        .trim();
    let port = payload
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(25565) as u16;
    let ram_mb = payload
        .get("ramMb")
        .and_then(|v| v.as_u64())
        .unwrap_or(2048) as u32;
    let playit = payload
        .get("playit")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let mut id = slugify(name);
    let root = Path::new(game_data_dir).join("servers");
    if root.join(&id).exists() {
        id = format!("{}-{}", id, &uuid::Uuid::new_v4().to_string()[..4]);
    }
    let server_dir = root.join(&id);
    fs::create_dir_all(&server_dir).map_err(|e| e.to_string())?;

    if loader == "paper" || loader == "purpur" {
        let _ = fs::create_dir_all(server_dir.join("plugins"));
    } else if loader == "fabric" {
        let _ = fs::create_dir_all(server_dir.join("mods"));
    }

    // Resolve jar URL and loader info
    let client = reqwest::Client::builder()
        .user_agent("CryoxClient/1.0.0 (contact@cryox.client)")
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let (jar_url, loader_version) = match loader.as_str() {
        "paper" => {
            // PaperMC v3 Fill API
            let builds_url = format!("https://fill.papermc.io/v3/projects/paper/versions/{version}/builds");
            let res = client
                .get(&builds_url)
                .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
                .send()
                .await
                .map_err(|e| format!("Failed to reach PaperMC API: {e}"))?;
            let json: serde_json::Value = res.json().await.map_err(|e| format!("Failed to parse Paper builds: {e}"))?;
            let builds = json.as_array().ok_or_else(|| format!("No builds returned for Paper version {version}"))?;
            if builds.is_empty() {
                return Err(format!("No builds found for Paper version {version}"));
            }

            // Find highest numeric build id
            let latest_build = builds
                .iter()
                .max_by_key(|b| b.get("id").and_then(|i| i.as_u64()).unwrap_or(0))
                .ok_or_else(|| "No valid build found in Paper response".to_string())?;
            let build_num = latest_build.get("id").and_then(|i| i.as_u64()).unwrap_or(0);

            let dl_url = latest_build
                .get("downloads")
                .and_then(|d| d.get("server:default"))
                .and_then(|s| s.get("url"))
                .and_then(|u| u.as_str())
                .ok_or_else(|| format!("No server download URL for Paper build {build_num}"))?
                .to_string();

            (dl_url, format!("build {build_num}"))
        }
        "purpur" => {
            (
                format!("https://api.purpurmc.org/v2/purpur/{version}/latest/download"),
                "latest".to_string(),
            )
        }
        "fabric" => {
            let loader_meta_url = format!("https://meta.fabricmc.net/v2/versions/loader/{version}");
            let res = client
                .get(&loader_meta_url)
                .send()
                .await
                .map_err(|e| format!("Fabric meta request failed: {e}"))?;
            let list: serde_json::Value = res.json().await.map_err(|e| format!("Failed to parse Fabric loader meta: {e}"))?;
            let loader_ver = list
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|item| item.get("loader"))
                .and_then(|l| l.get("version"))
                .and_then(|v| v.as_str())
                .unwrap_or("0.16.10")
                .to_string();
            let dl_url = format!(
                "https://meta.fabricmc.net/v2/versions/loader/{version}/{loader_ver}/1.0.1/server/jar"
            );
            (dl_url, format!("loader {loader_ver}"))
        }
        _ => {
            let meta_url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
            let res = client.get(meta_url).send().await.map_err(|e| e.to_string())?;
            let manifest: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            let versions = manifest.get("versions").and_then(|v| v.as_array()).ok_or_else(|| "No versions in manifest".to_string())?;
            let target_entry = versions
                .iter()
                .find(|v| v.get("id").and_then(|i| i.as_str()) == Some(version))
                .ok_or_else(|| format!("Minecraft version {version} not found in Mojang manifest"))?;
            let v_meta_url = target_entry.get("url").and_then(|u| u.as_str()).ok_or_else(|| "No version metadata URL".to_string())?;
            let v_res = client.get(v_meta_url).send().await.map_err(|e| e.to_string())?;
            let v_json: serde_json::Value = v_res.json().await.map_err(|e| e.to_string())?;
            let dl_url = v_json
                .get("downloads")
                .and_then(|d| d.get("server"))
                .and_then(|s| s.get("url"))
                .and_then(|u| u.as_str())
                .ok_or_else(|| format!("Vanilla version {version} does not have an official server JAR"))?;
            (dl_url.to_string(), "official".to_string())
        }
    };

    // Download server jar
    let jar_dest = server_dir.join("server.jar");
    let dl = client
        .get(&jar_url)
        .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
        .send()
        .await
        .map_err(|e| format!("Failed to download server JAR: {e}"))?;
    if !dl.status().is_success() {
        return Err(format!("Server JAR download failed with HTTP {}", dl.status()));
    }
    let bytes = dl.bytes().await.map_err(|e| format!("Failed to read server JAR bytes: {e}"))?;
    if bytes.len() < 1024 * 50 {
        return Err(format!("Downloaded server JAR is corrupt or incomplete ({} bytes)", bytes.len()));
    }
    fs::write(&jar_dest, &bytes).map_err(|e| format!("Failed to write server.jar: {e}"))?;

    // Accept EULA
    fs::write(
        server_dir.join("eula.txt"),
        "# Accepted in CRYOX CLIENT\neula=true\n",
    )
    .map_err(|e| e.to_string())?;

    // Initial properties
    let props = default_properties(name, port);
    write_properties(&server_dir, &props)?;
    if let Some(l) = payload.get("logo").and_then(|v| v.as_str()) {
        write_logo(&server_dir, l);
    }

    let meta = ServerMeta {
        id: id.clone(),
        name: name.to_string(),
        loader,
        version: version.to_string(),
        loader_version,
        java_major: None,
        ram_mb,
        port,
        playit,
        java_tunnel: "playit".to_string(),
        eula_accepted: true,
        created_at: default_now(),
    };
    write_meta(game_data_dir, &meta)?;

    Ok(public_state(game_data_dir, meta))
}

pub fn update_server(
    game_data_dir: &str,
    id: &str,
    updates: &serde_json::Value,
) -> Result<ServerPublicState, String> {
    let mut meta = read_meta(game_data_dir, id).ok_or_else(|| "Server not found".to_string())?;
    if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            meta.name = trimmed.to_string();
        }
    }
    if let Some(ram) = updates.get("ramMb").and_then(|v| v.as_u64()) {
        meta.ram_mb = ram.clamp(512, 65536) as u32;
    }
    if let Some(playit) = updates.get("playit").and_then(|v| v.as_bool()) {
        meta.playit = playit;
    }
    if let Some(tunnel) = updates.get("javaTunnel").and_then(|v| v.as_str()) {
        meta.java_tunnel = tunnel.to_string();
    }
    if let Some(logo) = updates.get("logo").and_then(|v| v.as_str()) {
        let dir = get_server_dir(game_data_dir, id);
        if logo.trim().is_empty() {
            let _ = fs::remove_file(dir.join("server-icon.png"));
        } else {
            write_logo(&dir, logo);
        }
    }
    write_meta(game_data_dir, &meta)?;
    Ok(public_state(game_data_dir, meta))
}

pub fn delete_server(game_data_dir: &str, id: &str) -> Result<serde_json::Value, String> {
    let mut runtimes = get_server_runtimes().lock().unwrap();
    if let Some(rt_arc) = runtimes.remove(id) {
        let mut rt = rt_arc.lock().unwrap();
        rt.status = "offline".to_string();
        if let Some(mut stdin) = rt.stdin.take() {
            use std::io::Write;
            let _ = writeln!(stdin, "stop");
        }
        if let Some(mut child) = rt.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    drop(runtimes);

    let dir = get_server_dir(game_data_dir, id);
    if dir.exists() {
        let mut deleted = false;
        for _ in 0..5 {
            if fs::remove_dir_all(&dir).is_ok() {
                deleted = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        if !deleted && dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    Ok(serde_json::json!({ "deleted": true }))
}

pub async fn start_server(
    app: AppHandle,
    game_data_dir: &str,
    _config_dir: &str,
    java_dir: &str,
    id: &str,
) -> Result<ServerPublicState, String> {
    let meta = read_meta(game_data_dir, id).ok_or_else(|| "Server not found".to_string())?;
    let dir = get_server_dir(game_data_dir, id);
    let jar_path = dir.join("server.jar");
    if !jar_path.exists() {
        return Err("server.jar is missing from server directory. Please delete and recreate the server.".to_string());
    }
    if let Ok(m) = jar_path.metadata() {
        if m.len() < 1024 * 50 {
            return Err("server.jar appears to be corrupted or incomplete. Please delete and recreate the server.".to_string());
        }
    }

    // Always ensure EULA is accepted
    let eula_file = dir.join("eula.txt");
    let needs_eula = if eula_file.exists() {
        fs::read_to_string(&eula_file).map(|s| !s.contains("eula=true")).unwrap_or(true)
    } else {
        true
    };
    if needs_eula {
        let _ = fs::write(&eula_file, "# Accepted in CRYOX CLIENT\neula=true\n");
    }

    {
        let runtimes_guard = get_server_runtimes().lock().unwrap();
        if let Some(rt_arc) = runtimes_guard.get(id) {
            let rt = rt_arc.lock().unwrap();
            if rt.status == "online" || rt.status == "starting" {
                return Ok(public_state(game_data_dir, meta));
            }
        }
    }

    // Resolve Java executable
    let req_java = meta
        .java_major
        .unwrap_or_else(|| crate::versions::get_required_java_major(&meta.version));
    let mut java_res = crate::java::resolve_java_for_version(
        &PathBuf::from(java_dir),
        req_java,
        "auto",
    );
    let is_compat = java_res.get("compatible").and_then(|c| c.as_bool()).unwrap_or(false);
    if !is_compat {
        let client = reqwest::Client::new();
        let _ = crate::java::bundle_portable_java(&client, &PathBuf::from(java_dir), req_java).await;
        java_res = crate::java::resolve_java_for_version(
            &PathBuf::from(java_dir),
            req_java,
            "auto",
        );
    }
    let java_bin = java_res
        .get("runtime")
        .and_then(|r| r.get("path"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if Command::new("java").arg("-version").output().is_ok() {
                "java".to_string()
            } else {
                "java".to_string()
            }
        });

    let _ = apply_geyser_auth(game_data_dir, id);

    let mut cmd = Command::new(&java_bin);
    cmd.current_dir(&dir);
    cmd.arg(format!("-Xms{}M", meta.ram_mb.max(512)));
    cmd.arg(format!("-Xmx{}M", meta.ram_mb.max(512)));
    cmd.args(["-jar", "server.jar", "nogui"]);

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn server process with '{java_bin}': {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let srv_proc = Arc::new(Mutex::new(ServerProcess {
        id: id.to_string(),
        status: "starting".to_string(),
        stdin,
        child: Some(child),
        logs: Vec::new(),
        players: HashSet::new(),
        started_at: Some(chrono::Utc::now().timestamp_millis() as u64),
        port: meta.port,
        cpu: 0.0,
        used_ram_mb: 0,
    }));

    {
        let mut map = get_server_runtimes().lock().unwrap();
        map.insert(id.to_string(), Arc::clone(&srv_proc));
    }

    // Emit starting status
    let _ = app.emit(
        "inex-event",
        serde_json::json!({
            "channel": "event:server-status",
            "data": { "id": id, "status": "starting", "players": [] }
        }),
    );
    crate::discord::request_server_sync();

    // Live CPU & RAM Sampler Thread (pure Win32, no external processes)
    let srv_id_stats = id.to_string();
    let app_handle_stats = app.clone();
    let proc_for_stats = Arc::clone(&srv_proc);
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        {
            #[repr(C)]
            #[derive(Default, Copy, Clone)]
            struct FILETIME {
                dw_low_date_time: u32,
                dw_high_date_time: u32,
            }
            impl FILETIME {
                fn to_u64(&self) -> u64 {
                    ((self.dw_high_date_time as u64) << 32) | (self.dw_low_date_time as u64)
                }
            }

            #[repr(C)]
            #[derive(Default)]
            struct PROCESS_MEMORY_COUNTERS {
                cb: u32,
                page_fault_count: u32,
                peak_working_set_size: usize,
                working_set_size: usize,
                quota_peak_paged_pool_usage: usize,
                quota_paged_pool_usage: usize,
                quota_peak_non_paged_pool_usage: usize,
                quota_non_paged_pool_usage: usize,
                pagefile_usage: usize,
                peak_pagefile_usage: usize,
            }

            #[repr(C)]
            #[derive(Default)]
            struct SYSTEM_INFO {
                w_processor_architecture: u16,
                w_reserved: u16,
                dw_page_size: u32,
                lp_minimum_application_address: *mut std::ffi::c_void,
                lp_maximum_application_address: *mut std::ffi::c_void,
                dw_active_processor_mask: usize,
                dw_number_of_processors: u32,
                dw_processor_type: u32,
                dw_allocation_granularity: u32,
                w_processor_level: u16,
                w_processor_revision: u16,
            }

            #[link(name = "kernel32")]
            extern "system" {
                fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut std::ffi::c_void;
                fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
                fn GetProcessTimes(
                    hProcess: *mut std::ffi::c_void,
                    lpCreationTime: *mut FILETIME,
                    lpExitTime: *mut FILETIME,
                    lpKernelTime: *mut FILETIME,
                    lpUserTime: *mut FILETIME,
                ) -> i32;
                fn K32GetProcessMemoryInfo(
                    Process: *mut std::ffi::c_void,
                    ppsmemCounters: *mut PROCESS_MEMORY_COUNTERS,
                    cb: u32,
                ) -> i32;
                fn GetSystemInfo(lpSystemInfo: *mut SYSTEM_INFO);
            }

            let num_cpus = unsafe {
                let mut sys_info = SYSTEM_INFO::default();
                GetSystemInfo(&mut sys_info);
                if sys_info.dw_number_of_processors > 0 { sys_info.dw_number_of_processors as f32 } else { 1.0 }
            };

            const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
            const PROCESS_VM_READ: u32 = 0x0010;

            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) };
            if !handle.is_null() {
                let mut prev_proc_time: Option<u64> = None;
                let mut prev_sample_instant = std::time::Instant::now();

                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1500));

                    // Check if server is still active in runtime
                    {
                        let runtimes = get_server_runtimes().lock().unwrap();
                        if !runtimes.contains_key(&srv_id_stats) {
                            break;
                        }
                    }

                    let mut create_time = FILETIME::default();
                    let mut exit_time = FILETIME::default();
                    let mut kernel_time = FILETIME::default();
                    let mut user_time = FILETIME::default();

                    let times_ok = unsafe {
                        GetProcessTimes(
                            handle,
                            &mut create_time,
                            &mut exit_time,
                            &mut kernel_time,
                            &mut user_time,
                        )
                    };

                    if times_ok == 0 || exit_time.to_u64() > 0 {
                        break;
                    }

                    let proc_time = kernel_time.to_u64() + user_time.to_u64();
                    let now_instant = std::time::Instant::now();
                    let elapsed_secs = now_instant.duration_since(prev_sample_instant).as_secs_f64();

                    let cpu_pct = if let Some(prev) = prev_proc_time {
                        if elapsed_secs > 0.0 && proc_time >= prev {
                            let delta_proc_secs = (proc_time - prev) as f64 / 10_000_000.0;
                            let pct = (delta_proc_secs / elapsed_secs / (num_cpus as f64)) * 100.0;
                            (pct as f32).clamp(0.0, 100.0)
                        } else {
                            0.0
                        }
                    } else {
                        0.0
                    };

                    prev_proc_time = Some(proc_time);
                    prev_sample_instant = now_instant;

                    let mut pmc = PROCESS_MEMORY_COUNTERS::default();
                    pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                    let mem_ok = unsafe { K32GetProcessMemoryInfo(handle, &mut pmc, pmc.cb) };
                    let ram_mb = if mem_ok != 0 {
                        (pmc.working_set_size / (1024 * 1024)) as u32
                    } else {
                        0
                    };

                    let rounded_cpu = (cpu_pct * 10.0).round() / 10.0;

                    // Update runtime state
                    {
                        if let Ok(mut p) = proc_for_stats.lock() {
                            if p.status == "offline" {
                                break;
                            }
                            p.cpu = rounded_cpu;
                            p.used_ram_mb = ram_mb;
                        }
                    }

                    // Emit event to UI
                    let _ = app_handle_stats.emit(
                        "inex-event",
                        serde_json::json!({
                            "channel": "event:server-stats",
                            "data": {
                                "id": &srv_id_stats,
                                "cpu": rounded_cpu,
                                "ramMb": ram_mb,
                                "t": chrono::Utc::now().timestamp_millis()
                            }
                        }),
                    );
                }

                unsafe {
                    let _ = CloseHandle(handle);
                }
            }
        }
    });

    // Reader thread for stdout
    let srv_id = id.to_string();
    let app_handle = app.clone();
    let proc_for_stdout = Arc::clone(&srv_proc);
    let auto_tunnel = meta.playit;
    let tun_params = tunnel_params(game_data_dir, id);
    let gdd_geyser = game_data_dir.to_string();
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    let mut p = proc_for_stdout.lock().unwrap();
                    if p.logs.len() >= LOG_LIMIT {
                        p.logs.remove(0);
                    }
                    p.logs.push(line.clone());

                    // Check for server ready
                    let was_starting = p.status != "online";
                    if was_starting && ((line.contains("Done (") && line.contains("help"))
                        || line.contains("Listening on")
                        || line.contains("Server started")
                        || line.contains("Done in "))
                    {
                        p.status = "online".to_string();
                        let current_players: Vec<String> = p.players.iter().cloned().collect();
                        let _ = app_handle.emit(
                            "inex-event",
                            serde_json::json!({
                                "channel": "event:server-status",
                                "data": { "id": srv_id, "status": "online", "players": current_players }
                            }),
                        );
                        crate::discord::request_server_sync();

                        if auto_tunnel {
                            let app_tun = app_handle.clone();
                            let srv_id_tun = srv_id.clone();
                            let mgr = crate::settings::SettingsManager::new();
                            let settings = mgr.get_settings();
                            let config_dir = settings.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
                            let (srv_port, bedrock_port, java_tunnel) = tun_params.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = crate::playit_ext::share_any(app_tun, config_dir, srv_id_tun, srv_port, bedrock_port, java_tunnel).await;
                            });
                        }
                    }

                    // Check for player joins
                    if line.contains("joined the game") {
                        if let Some(name) = line.split("joined the game").next() {
                            if let Some(user) = name.split(": ").last() {
                                p.players.insert(user.trim().to_string());
                                crate::discord::request_server_sync();
                            }
                        }
                    } else if line.contains("left the game") {
                        if let Some(name) = line.split("left the game").next() {
                            if let Some(user) = name.split(": ").last() {
                                p.players.remove(user.trim());
                                crate::discord::request_server_sync();
                            }
                        }
                    }

                    // Geyser (Bedrock) came up: make sure it logs in offline, tell the UI
                    if let Some(idx) = line.find("Started Geyser on") {
                        let port = line[idx..]
                            .split(|c: char| !c.is_ascii_digit())
                            .find(|x| !x.is_empty())
                            .and_then(|x| x.parse::<u16>().ok())
                            .unwrap_or(19132);
                        let changed = apply_geyser_auth(&gdd_geyser, &srv_id);
                        let _ = app_handle.emit(
                            "inex-event",
                            serde_json::json!({
                                "channel": "event:server-bedrock",
                                "data": { "id": srv_id, "port": port, "needsRestart": changed }
                            }),
                        );
                    }

                    let _ = app_handle.emit(
                        "inex-event",
                        serde_json::json!({
                            "channel": "event:server-log",
                            "data": { "id": srv_id, "line": &line, "text": &line, "stream": "stdout" }
                        }),
                    );
                }
            }

            // Exited
            let mut p = proc_for_stdout.lock().unwrap();
            p.status = "offline".to_string();
            let _ = app_handle.emit(
                "inex-event",
                serde_json::json!({
                    "channel": "event:server-status",
                    "data": { "id": srv_id, "status": "offline", "players": [] }
                }),
            );
            crate::discord::request_server_sync();
            let _ = app_handle.emit(
                "inex-event",
                serde_json::json!({
                    "channel": "event:server-exit",
                    "data": { "id": srv_id, "code": 0 }
                }),
            );
            {
                let mgr = crate::settings::SettingsManager::new();
                let st = mgr.get_settings();
                let cd = st.get("configDir").and_then(|s| s.as_str()).unwrap_or(".").to_string();
                let _ = crate::playit::release_tunnel(app_handle.clone(), &cd, &srv_id);
            }
        });
    }

    if let Some(stderr) = stderr {
        let srv_id_err = id.to_string();
        let app_handle_err = app.clone();
        let proc_err = Arc::clone(&srv_proc);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let mut p = proc_err.lock().unwrap();
                if p.logs.len() >= LOG_LIMIT {
                    p.logs.remove(0);
                }
                p.logs.push(line.clone());
                let _ = app_handle_err.emit(
                    "inex-event",
                    serde_json::json!({
                        "channel": "event:server-log",
                        "data": { "id": srv_id_err, "line": &line, "text": &line, "stream": "stderr" }
                    }),
                );
            }
        });
    }

    Ok(public_state(game_data_dir, meta))
}

pub fn stop_server(id: &str) -> Result<serde_json::Value, String> {
    let runtimes = get_server_runtimes().lock().unwrap();
    if let Some(rt_arc) = runtimes.get(id) {
        let mut rt = rt_arc.lock().unwrap();
        rt.status = "stopping".to_string();
        if let Some(stdin) = rt.stdin.as_mut() {
            let _ = writeln!(stdin, "stop");
            let _ = stdin.flush();
        }
        let rt_clone = Arc::clone(rt_arc);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(15));
            let mut r = rt_clone.lock().unwrap();
            if r.status == "stopping" {
                if let Some(c) = r.child.as_mut() {
                    let _ = c.kill();
                }
            }
        });
        return Ok(serde_json::json!({ "stopping": true }));
    }
    Ok(serde_json::json!({ "stopped": true }))
}

pub fn kill_server(id: &str) -> Result<serde_json::Value, String> {
    let runtimes = get_server_runtimes().lock().unwrap();
    if let Some(rt_arc) = runtimes.get(id) {
        let mut rt = rt_arc.lock().unwrap();
        rt.status = "offline".to_string();
        if let Some(mut child) = rt.child.take() {
            let _ = child.kill();
        }
        return Ok(serde_json::json!({ "killed": true }));
    }
    Ok(serde_json::json!({ "killed": true }))
}

pub fn send_command(id: &str, cmd: &str) -> Result<serde_json::Value, String> {
    if cmd.contains('\r') || cmd.contains('\n') || cmd.contains('\0') {
        return Err("Multi-line or control characters are not allowed in server commands.".to_string());
    }
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }
    let runtimes = get_server_runtimes().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(rt_arc) = runtimes.get(id) {
        let mut rt = rt_arc.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stdin) = rt.stdin.as_mut() {
            let _ = writeln!(stdin, "{}", trimmed);
            let _ = stdin.flush();
            return Ok(serde_json::json!({ "sent": true }));
        }
    }
    Err("Server is not running".to_string())
}

pub fn get_server_log(id: &str) -> Vec<String> {
    let runtimes = get_server_runtimes().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(rt_arc) = runtimes.get(id) {
        let rt = rt_arc.lock().unwrap_or_else(|e| e.into_inner());
        return rt.logs.clone();
    }
    Vec::new()
}

/// Resolve a relative path inside `base`, blocking `..`, roots, Windows drive prefixes, NUL bytes, and symlink escapes.
pub fn resolve_server_rel_path(base: &Path, rel_path: &str, allow_empty: bool) -> Result<(String, PathBuf), String> {
    if rel_path.contains('\0') {
        return Err("Path traversal forbidden".to_string());
    }
    let raw = rel_path.replace('\\', "/");
    if raw.starts_with('/') || (raw.len() >= 2 && raw.as_bytes()[1] == b':') {
        return Err("Path traversal forbidden".to_string());
    }

    let mut clean_parts: Vec<String> = Vec::new();
    for seg in raw.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err("Path traversal forbidden".to_string()),
            other => {
                if other.contains(':') {
                    return Err("Path traversal forbidden".to_string());
                }
                clean_parts.push(other.to_string());
            }
        }
    }

    if clean_parts.is_empty() && !allow_empty {
        return Err("Missing relative file path.".to_string());
    }

    let clean_rel = clean_parts.join("/");
    let mut target = base.to_path_buf();
    for part in &clean_parts {
        target.push(part);
    }

    if base.exists() {
        let canon_base = fs::canonicalize(base).map_err(|e| e.to_string())?;
        if target.exists() {
            let canon_target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
            if !canon_target.starts_with(&canon_base) {
                return Err("Path traversal forbidden".to_string());
            }
        } else {
            // Check nearest existing ancestor so new subdirectories cannot traverse via symlinks/junctions
            let mut probe = target.parent();
            while let Some(p) = probe {
                if p.exists() {
                    let canon_anc = fs::canonicalize(p).map_err(|e| e.to_string())?;
                    if !canon_anc.starts_with(&canon_base) {
                        return Err("Path traversal forbidden".to_string());
                    }
                    break;
                }
                probe = p.parent();
            }
        }
    }

    Ok((clean_rel, target))
}

fn is_editable_file(name: &str, size: u64) -> bool {
    if size > 1024 * 1024 {
        return false;
    }
    if name.eq_ignore_ascii_case("eula.txt") {
        return true;
    }
    let lower = name.to_lowercase();
    const EDITABLE_EXTS: &[&str] = &[
        ".yml", ".yaml", ".json", ".properties", ".toml", ".txt", ".conf", ".cfg", ".ini", ".log", ".mcmeta"
    ];
    EDITABLE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

pub fn list_server_files(
    game_data_dir: &str,
    id: &str,
    rel_path: &str,
) -> Result<serde_json::Value, String> {
    let base = get_server_dir(game_data_dir, id);
    let (clean_rel, target) = resolve_server_rel_path(&base, rel_path, true)?;

    if !target.exists() || !target.is_dir() {
        return Ok(serde_json::json!({
            "relDir": clean_rel,
            "entries": []
        }));
    }

    let mut entries = Vec::new();
    if let Ok(dir_entries) = fs::read_dir(&target) {
        for entry in dir_entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "inex-server.json"
                || name == "inex-server-addons.json"
                || name == "inex-allow-flight.flag"
                || name == "INEX-FlightHelper.jar"
                || name.ends_with(".part")
            {
                continue;
            }

            let path = entry.path();
            let is_dir = path.is_dir();
            let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
            let entry_rel = if clean_rel.is_empty() {
                name.clone()
            } else {
                format!("{clean_rel}/{name}")
            };
            let editable = !is_dir && is_editable_file(&name, size);

            entries.push(serde_json::json!({
                "name": name,
                "relPath": entry_rel,
                "isDirectory": is_dir,
                "size": size,
                "editable": editable
            }));
        }
    }

    entries.sort_by(|a, b| {
        let dir_a = a.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false);
        let dir_b = b.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false);
        if dir_a != dir_b {
            return dir_b.cmp(&dir_a);
        }
        let name_a = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let name_b = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        name_a.cmp(name_b)
    });

    Ok(serde_json::json!({
        "relDir": clean_rel,
        "entries": entries
    }))
}

pub fn read_server_file(
    game_data_dir: &str,
    id: &str,
    rel_path: &str,
) -> Result<serde_json::Value, String> {
    let base = get_server_dir(game_data_dir, id);
    let (clean_rel, target) = resolve_server_rel_path(&base, rel_path, false)?;

    if !target.exists() || target.is_dir() {
        return Err("File not found.".to_string());
    }

    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 {
        return Err("File is too large to edit in the launcher (>1 MB).".to_string());
    }

    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    let file_name = target
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| clean_rel.clone());

    Ok(serde_json::json!({
        "relPath": clean_rel,
        "name": file_name,
        "content": content
    }))
}

pub fn write_server_file(
    game_data_dir: &str,
    id: &str,
    rel_path: &str,
    content: &str,
) -> Result<serde_json::Value, String> {
    let base = get_server_dir(game_data_dir, id);
    let (clean_rel, target) = resolve_server_rel_path(&base, rel_path, false)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, content).map_err(|e| e.to_string())?;

    let is_running = {
        let runtimes = get_server_runtimes().lock().unwrap_or_else(|e| e.into_inner());
        runtimes.contains_key(id)
    };

    Ok(serde_json::json!({
        "saved": true,
        "relPath": clean_rel,
        "restartNeeded": is_running
    }))
}

pub fn get_server_stats(id: &str) -> Vec<serde_json::Value> {
    let runtimes = get_server_runtimes().lock().unwrap();
    if let Some(rt_arc) = runtimes.get(id) {
        let rt = rt_arc.lock().unwrap();
        return vec![serde_json::json!({
            "t": chrono::Utc::now().timestamp_millis(),
            "cpu": rt.cpu,
            "ramMb": rt.used_ram_mb
        })];
    }
    Vec::new()
}

pub fn get_player_lists(game_data_dir: &str, id: &str) -> serde_json::Value {
    let dir = get_server_dir(game_data_dir, id);
    let meta = read_meta(game_data_dir, id);
    let (is_running, mut online_arr) = {
        let runtimes = get_server_runtimes().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rt_arc) = runtimes.get(id) {
            let rt = rt_arc.lock().unwrap_or_else(|e| e.into_inner());
            let list: Vec<String> = rt.players.iter().cloned().collect();
            (true, list)
        } else {
            (false, Vec::new())
        }
    };
    online_arr.sort();

    let read_json = |filename: &str| -> serde_json::Value {
        let path = dir.join(filename);
        if let Ok(content) = fs::read_to_string(&path) {
            serde_json::from_str(&content).unwrap_or(serde_json::json!([]))
        } else {
            serde_json::json!([])
        }
    };

    let ops = read_json("ops.json");
    let banned = read_json("banned-players.json");
    let white = read_json("whitelist.json");
    let cache = read_json("usercache.json");
    let props = read_properties_values(&dir);
    let whitelist_enabled = props.get("white-list").map(|s| s == "true").unwrap_or(false);

    let ops_arr = ops.as_array().cloned().unwrap_or_default().into_iter().filter_map(|o| {
        o.get("name").and_then(|n| n.as_str()).map(|name| serde_json::json!({
            "name": name,
            "level": o.get("level").and_then(|l| l.as_u64()).unwrap_or(4)
        }))
    }).collect::<Vec<_>>();

    let banned_arr = banned.as_array().cloned().unwrap_or_default().into_iter().filter_map(|b| {
        b.get("name").and_then(|n| n.as_str()).map(|name| serde_json::json!({
            "name": name,
            "reason": b.get("reason").and_then(|r| r.as_str()).unwrap_or("Banned by operator")
        }))
    }).collect::<Vec<_>>();

    let white_arr = white.as_array().cloned().unwrap_or_default().into_iter().filter_map(|w| {
        w.get("name").and_then(|n| n.as_str()).map(|name| serde_json::json!({
            "name": name
        }))
    }).collect::<Vec<_>>();

    let recent_arr = cache.as_array().cloned().unwrap_or_default().into_iter().filter_map(|c| {
        c.get("name").and_then(|n| n.as_str()).map(|name| serde_json::Value::String(name.to_string()))
    }).take(30).collect::<Vec<_>>();

    serde_json::json!({
        "running": is_running,
        "status": if is_running { "online" } else { "offline" },
        "online": online_arr,
        "ops": ops_arr,
        "banned": banned_arr,
        "whitelist": white_arr,
        "recent": recent_arr,
        "whitelistEnabled": whitelist_enabled,
        "loader": meta.map(|m| m.loader).unwrap_or_else(|| "vanilla".to_string())
    })
}

pub fn player_action(
    game_data_dir: &str,
    id: &str,
    action: &str,
    name: &str,
    reason: Option<&str>,
) -> Result<serde_json::Value, String> {
    let dir = get_server_dir(game_data_dir, id);
    let runtimes = get_server_runtimes().lock().unwrap();
    let is_running = runtimes.contains_key(id);
    drop(runtimes);

    if action == "whitelist-on" || action == "whitelist-off" {
        let enable = action == "whitelist-on";
        let mut updates = HashMap::new();
        updates.insert("white-list".to_string(), if enable { "true".to_string() } else { "false".to_string() });
        let _ = write_properties(&dir, &updates);
        if is_running {
            let _ = send_command(id, if enable { "whitelist on" } else { "whitelist off" });
        }
        return Ok(serde_json::json!({ "ok": true, "whitelistEnabled": enable }));
    }

    if action == "refresh-list" {
        if is_running {
            let _ = send_command(id, "list");
        }
        return Ok(serde_json::json!({ "ok": true }));
    }

    let who = name.trim();
    if who.is_empty() || who.chars().any(|c| c.is_control()) || who.contains(['\r', '\n']) {
        return Err("Invalid player username.".to_string());
    }
    let why = reason.unwrap_or("").replace(['\r', '\n'], " ");
    let why = why.trim();

    if is_running {
        let cmd = match action {
            "kick" => format!("kick {}{}", who, if why.is_empty() { "".to_string() } else { format!(" {}", why) }),
            "ban" => format!("ban {}{}", who, if why.is_empty() { "".to_string() } else { format!(" {}", why) }),
            "pardon" => format!("pardon {}", who),
            "op" => format!("op {}", who),
            "deop" => format!("deop {}", who),
            "whitelist-add" => format!("whitelist add {}", who),
            "whitelist-remove" => format!("whitelist remove {}", who),
            _ => return Err("Unknown player action.".to_string()),
        };
        send_command(id, &cmd)?;
        return Ok(serde_json::json!({ "sent": true, "offlineUpdated": false }));
    }

    // Offline editing
    let edit_json = |filename: &str, mutate: &dyn Fn(&mut Vec<serde_json::Value>)| {
        let path = dir.join(filename);
        let mut list: Vec<serde_json::Value> = if let Ok(c) = fs::read_to_string(&path) {
            serde_json::from_str(&c).unwrap_or_default()
        } else {
            Vec::new()
        };
        mutate(&mut list);
        if let Ok(ser) = serde_json::to_string_pretty(&list) {
            let _ = fs::write(path, ser);
        }
    };

    let offline_uuid = crate::accounts::generate_offline_uuid(who);

    match action {
        "op" => {
            edit_json("ops.json", &|list| {
                if !list.iter().any(|x| x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false)) {
                    list.push(serde_json::json!({
                        "uuid": offline_uuid,
                        "name": who,
                        "level": 4,
                        "bypassesPlayerLimit": false
                    }));
                }
            });
        }
        "deop" => {
            edit_json("ops.json", &|list| {
                list.retain(|x| !x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false));
            });
        }
        "ban" => {
            edit_json("banned-players.json", &|list| {
                if !list.iter().any(|x| x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false)) {
                    list.push(serde_json::json!({
                        "uuid": offline_uuid,
                        "name": who,
                        "created": chrono::Utc::now().to_rfc3339(),
                        "source": "Console",
                        "expires": "forever",
                        "reason": if why.is_empty() { "Banned by operator" } else { why }
                    }));
                }
            });
        }
        "pardon" => {
            edit_json("banned-players.json", &|list| {
                list.retain(|x| !x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false));
            });
        }
        "whitelist-add" => {
            edit_json("whitelist.json", &|list| {
                if !list.iter().any(|x| x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false)) {
                    list.push(serde_json::json!({
                        "uuid": offline_uuid,
                        "name": who
                    }));
                }
            });
        }
        "whitelist-remove" => {
            edit_json("whitelist.json", &|list| {
                list.retain(|x| !x.get("name").and_then(|n| n.as_str()).map(|s| s.eq_ignore_ascii_case(who)).unwrap_or(false));
            });
        }
        _ => return Err("Unknown action.".to_string()),
    }

    Ok(serde_json::json!({ "sent": false, "offlineUpdated": true }))
}

fn server_addon_folder(game_data_dir: &str, id: &str) -> PathBuf {
    let meta = read_meta(game_data_dir, id);
    let sub = if meta.as_ref().map(|m| m.loader.as_str()) == Some("fabric") {
        "mods"
    } else {
        "plugins"
    };
    get_server_dir(game_data_dir, id).join(sub)
}

pub fn list_server_addons(game_data_dir: &str, id: &str) -> Vec<serde_json::Value> {
    let meta = read_meta(game_data_dir, id);
    if meta.as_ref().map(|m| m.loader.as_str()) == Some("vanilla") {
        return Vec::new();
    }
    let folder = server_addon_folder(game_data_dir, id);
    let _ = fs::create_dir_all(&folder);

    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&folder) {
        for entry in entries.filter_map(|e| e.ok()) {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_jar = file_name.ends_with(".jar") || file_name.ends_with(".jar.disabled");
            if !is_jar {
                continue;
            }
            let disabled = file_name.ends_with(".disabled");
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let display_name = if disabled {
                file_name.trim_end_matches(".disabled").to_string()
            } else {
                file_name.clone()
            };
            out.push(serde_json::json!({
                "fileName": file_name,
                "name": display_name,
                "disabled": disabled,
                "size": size,
                "projectId": null,
                "title": null,
                "iconUrl": null
            }));
        }
    }
    out
}

fn url_encode(s: &str) -> String {
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

pub async fn search_server_addons(
    client: &reqwest::Client,
    game_data_dir: &str,
    id: &str,
    opts: &serde_json::Value,
) -> serde_json::Value {
    let meta = read_meta(game_data_dir, id);
    let (loader, version) = match meta {
        Some(m) => (m.loader, m.version),
        None => ("vanilla".to_string(), "1.21.4".to_string()),
    };
    if loader == "vanilla" {
        return serde_json::json!({
            "hits": [],
            "totalHits": 0,
            "vanillaLocked": true,
            "version": version,
            "loader": loader
        });
    }

    let query = opts.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let offset = opts.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
    let limit = opts.get("limit").and_then(|v| v.as_u64()).unwrap_or(15);
    let project_type = if loader == "fabric" { "mod" } else { "plugin" };

    let mut facets = vec![
        format!("[\"project_type:{}\"]", project_type),
        format!("[\"versions:{}\"]", version),
    ];
    if loader == "fabric" {
        facets.push("[\"categories:fabric\"]".to_string());
    } else {
        facets.push("[\"categories:paper\",\"categories:spigot\",\"categories:purpur\",\"categories:bukkit\"]".to_string());
    }
    let facets_json = format!("[{}]", facets.join(","));

    let url = format!(
        "https://api.modrinth.com/v2/search?query={}&facets={}&limit={}&offset={}&index=downloads",
        url_encode(query),
        url_encode(&facets_json),
        limit,
        offset
    );

    let res = client
        .get(&url)
        .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
        .send()
        .await;

    if let Ok(resp) = res {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            let hits = json.get("hits").and_then(|h| h.as_array()).cloned().unwrap_or_default();
            let total = json.get("total_hits").and_then(|t| t.as_u64()).unwrap_or(0);
            let mapped_hits = hits.into_iter().map(|h| {
                serde_json::json!({
                    "projectId": h.get("project_id"),
                    "slug": h.get("slug"),
                    "title": h.get("title"),
                    "description": h.get("description"),
                    "author": h.get("author"),
                    "iconUrl": h.get("icon_url"),
                    "downloads": h.get("downloads"),
                    "installed": false
                })
            }).collect::<Vec<_>>();
            return serde_json::json!({
                "hits": mapped_hits,
                "totalHits": total,
                "version": version,
                "loader": loader
            });
        }
    }

    serde_json::json!({
        "hits": [],
        "totalHits": 0,
        "version": version,
        "loader": loader
    })
}

pub async fn install_server_addon(
    client: &reqwest::Client,
    game_data_dir: &str,
    id: &str,
    opts: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let meta = read_meta(game_data_dir, id).ok_or_else(|| "Server not found".to_string())?;
    if meta.loader == "vanilla" {
        return Err("Vanilla servers cannot install plugins or mods.".to_string());
    }
    let project_id = opts.get("projectId").and_then(|v| v.as_str()).ok_or_else(|| "Missing projectId".to_string())?;
    let folder = server_addon_folder(game_data_dir, id);
    let _ = fs::create_dir_all(&folder);

    // Fetch version from Modrinth
    let versions_url = format!("https://api.modrinth.com/v2/project/{}/version", project_id);
    let vers_res = client
        .get(&versions_url)
        .header("User-Agent", "CryoxClient/1.0.0 (contact@cryox.client)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let vers: Vec<serde_json::Value> = vers_res.json().await.map_err(|e| e.to_string())?;
    let matched = vers.iter().find(|v| {
        let gv = v.get("game_versions").and_then(|a| a.as_array());
        let ld = v.get("loaders").and_then(|a| a.as_array());
        let matches_game = gv.map(|arr| arr.iter().any(|g| g.as_str() == Some(&meta.version))).unwrap_or(true);
        let matches_loader = ld.map(|arr| arr.iter().any(|l| l.as_str().map(|s| s.eq_ignore_ascii_case(&meta.loader) || (meta.loader != "fabric" && (s == "paper" || s == "spigot" || s == "bukkit"))).unwrap_or(false))).unwrap_or(true);
        matches_game && matches_loader
    }).or_else(|| vers.first()).cloned().ok_or_else(|| "No compatible version found on Modrinth".to_string())?;

    let files_arr = matched
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or_else(|| "No files found in version".to_string())?;
    let file_obj = files_arr
        .iter()
        .find(|f| f.get("primary").and_then(|b| b.as_bool()) == Some(true))
        .or_else(|| files_arr.first())
        .ok_or_else(|| "No files found in version".to_string())?;
    let download_url = file_obj.get("url").and_then(|u| u.as_str()).ok_or_else(|| "Missing file url".to_string())?;
    let raw_filename = file_obj.get("filename").and_then(|f| f.as_str()).unwrap_or("addon.jar");
    let clean_filename = Path::new(raw_filename)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .ok_or_else(|| "Invalid addon file name".to_string())?;
    let expected_sha1 = file_obj
        .get("hashes")
        .and_then(|h| h.get("sha1"))
        .and_then(|s| s.as_str());

    let dest = folder.join(&clean_filename);
    let bytes = client.get(download_url).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    if let Some(exp) = expected_sha1.filter(|s| !s.is_empty()) {
        use sha1::{Digest, Sha1};
        let actual = format!("{:x}", Sha1::digest(&bytes));
        if !actual.eq_ignore_ascii_case(exp) {
            return Err(format!("Addon checksum mismatch (expected {exp}, got {actual})"));
        }
    }
    fs::write(dest, bytes).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "success": true,
        "items": list_server_addons(game_data_dir, id)
    }))
}

pub fn toggle_server_addon(
    game_data_dir: &str,
    id: &str,
    file_name: &str,
) -> Result<serde_json::Value, String> {
    let folder = server_addon_folder(game_data_dir, id);
    let clean_name = Path::new(file_name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .ok_or_else(|| "Invalid file name".to_string())?;
    let cur = folder.join(&clean_name);
    if !cur.exists() {
        return Err("Addon file not found.".to_string());
    }
    let is_disabled = clean_name.ends_with(".disabled");
    let next_name = if is_disabled {
        clean_name.trim_end_matches(".disabled").to_string()
    } else {
        format!("{}.disabled", clean_name)
    };
    let next_path = folder.join(next_name);
    fs::rename(cur, next_path).map_err(|e| e.to_string())?;

    let runtimes = get_server_runtimes().lock().unwrap_or_else(|e| e.into_inner());
    let is_running = runtimes.contains_key(id);
    Ok(serde_json::json!({
        "items": list_server_addons(game_data_dir, id),
        "restartNeeded": is_running
    }))
}

pub fn remove_server_addon(
    game_data_dir: &str,
    id: &str,
    file_name: &str,
) -> Result<serde_json::Value, String> {
    let folder = server_addon_folder(game_data_dir, id);
    let clean = Path::new(file_name).file_name().ok_or_else(|| "Invalid file name".to_string())?;
    let cur = folder.join(clean);
    if cur.exists() {
        let _ = fs::remove_file(cur);
    }
    let runtimes = get_server_runtimes().lock().unwrap();
    let is_running = runtimes.contains_key(id);
    Ok(serde_json::json!({
        "items": list_server_addons(game_data_dir, id),
        "restartNeeded": is_running
    }))
}

pub fn get_server_network(game_data_dir: &str, id: &str) -> serde_json::Value {
    let meta = read_meta(game_data_dir, id);
    let runtimes = get_server_runtimes().lock().unwrap();
    let port = meta.as_ref().map(|m| m.port).unwrap_or(25565);
    let is_running = runtimes.contains_key(id);
    let java_tunnel = meta.as_ref().map(|m| m.java_tunnel.clone()).unwrap_or_else(|| "bore".to_string());
    let playit_enabled = meta.as_ref().map(|m| m.playit).unwrap_or(true);
    let bedrock = detect_bedrock(game_data_dir, id);
    let config_rel: Option<&str> = {
        let loader = meta.as_ref().map(|m| m.loader.clone()).unwrap_or_default();
        let cfg = geyser_config_path(&get_server_dir(game_data_dir, id), &loader);
        if cfg.is_file() {
            Some(if loader == "fabric" { "config/Geyser-Fabric/config.yml" } else { "plugins/Geyser-Spigot/config.yml" })
        } else {
            None
        }
    };

    serde_json::json!({
        "port": port,
        "playit": playit_enabled,
        "javaTunnel": java_tunnel,
        "tunnelStatus": if is_running { "online" } else { "offline" },
        "bedrock": {
            "supported": bedrock.supported,
            "geyser": bedrock.installed,
            "port": if bedrock.installed { Some(bedrock.port) } else { None },
            "running": is_running && bedrock.installed,
            "configRelPath": config_rel
        }
    })
}

pub async fn install_bedrock_support(
    client: &reqwest::Client,
    game_data_dir: &str,
    id: &str,
) -> Result<serde_json::Value, String> {
    let meta = read_meta(game_data_dir, id).ok_or_else(|| "Server not found".to_string())?;
    if meta.loader == "vanilla" {
        return Err("Vanilla servers cannot load Bedrock support. Create a Paper, Purpur, or Fabric server.".to_string());
    }
    if detect_bedrock(game_data_dir, id).installed {
        return Ok(serde_json::json!({ "installed": true, "already": true }));
    }
    let fabric = meta.loader == "fabric";
    let platform = if fabric { "fabric" } else { "spigot" };
    let dir = get_server_dir(game_data_dir, id);
    let folder = dir.join(if fabric { "mods" } else { "plugins" });
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;

    let url = format!(
        "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/{}",
        platform
    );
    let res = client
        .get(&url)
        .header("User-Agent", "CryoxClient/1.0.0")
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("Could not download GeyserMC: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GeyserMC download failed with HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Could not read GeyserMC download: {e}"))?;
    if bytes.len() < 100 * 1024 || bytes[0] != b'P' || bytes[1] != b'K' {
        return Err("GeyserMC download is not a valid jar file.".to_string());
    }
    let file_name = if fabric { "Geyser-Fabric.jar" } else { "Geyser-Spigot.jar" };
    let dest = folder.join(file_name);
    let tmp = folder.join(format!("{}.part", file_name));
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;

    // First config for offline servers (so Bedrock players can join without a Java account)
    let cfg = geyser_config_path(&dir, &meta.loader);
    let online = read_properties_values(&dir).get("online-mode").map(|v| v == "true").unwrap_or(false);
    if !cfg.exists() && !online {
        if let Some(parent) = cfg.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let name = meta.name.replace('"', "'");
        let yml = format!(
            "# Generated by CRYOX CLIENT for Bedrock + Java Crossplay\nbedrock:\n  address: 0.0.0.0\n  port: 19132\n  clone-remote-port: false\n  motd1: \"{name}\"\n  motd2: \"CRYOX Bedrock Server\"\n  server-name: \"{name}\"\nremote:\n  address: auto\n  port: {port}\n  auth-type: offline\n",
            name = name,
            port = meta.port
        );
        let _ = fs::write(&cfg, yml);
    }

    let restart_needed = get_server_runtimes().lock().unwrap().contains_key(id);
    Ok(serde_json::json!({ "installed": true, "restartNeeded": restart_needed }))
}

/// Current runtime status of a server ("starting" | "online" | "stopping" | "offline"), None if it has no live runtime.
pub fn runtime_status(id: &str) -> Option<String> {
    let runtimes = get_server_runtimes().lock().ok()?;
    let rt_arc = runtimes.get(id)?;
    let rt = rt_arc.lock().ok()?;
    Some(rt.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_server_path_traversal_variants() {
        let root = std::env::temp_dir().join("cryox_srv_path_test");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::create_dir_all(&root);
        assert!(resolve_server_rel_path(&root, "../../Users/victim/.ssh/id_rsa", false).is_err());
        assert!(resolve_server_rel_path(&root, "..\\secret.txt", false).is_err());
        assert!(resolve_server_rel_path(&root, "C:\\Windows\\win.ini", false).is_err());
        assert!(resolve_server_rel_path(&root, "/etc/passwd", false).is_err());
        assert!(resolve_server_rel_path(&root, "config/../secrets.yml", false).is_err());
        assert!(resolve_server_rel_path(&root, "", false).is_err());
        assert!(resolve_server_rel_path(&root, "", true).is_ok());
        let (rel, path) = resolve_server_rel_path(&root, "config/paper.yml", false).unwrap();
        assert_eq!(rel, "config/paper.yml");
        assert!(path.starts_with(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_multiline_command_and_sanitizes_properties() {
        assert!(send_command("nonexistent", "say hi\nop attacker").is_err());
        assert!(send_command("nonexistent", "   ").is_err());
        let dir = std::env::temp_dir().join("cryox_props_test");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let mut updates = HashMap::new();
        updates.insert("motd".to_string(), "Hello\nop attacker".to_string());
        updates.insert("bad\nkey".to_string(), "value".to_string());
        write_properties(&dir, &updates).unwrap();
        let raw = fs::read_to_string(dir.join("server.properties")).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines, vec!["motd=Hello op attacker"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
