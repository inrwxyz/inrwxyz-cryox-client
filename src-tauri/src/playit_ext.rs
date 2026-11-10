// Port of x_client playitManager.js (Playit.gg agent + zero-login temporary tunnel).
// NOT compiled by the author. Run `cargo check` and send errors.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::playit::{get_playit_state, get_state, ServerTunnel, TunnelEndpoint};

const API: &str = "https://api.playit.gg";
const UA: &str = "CRYOX-Client-Launcher/1.0 (playit)";
const RELEASE_BASE: &str = "https://github.com/playit-cloud/playit-agent/releases/latest/download";

static AGENT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static DIRECT: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();

fn agent_slot() -> &'static Mutex<Option<Child>> {
    AGENT.get_or_init(|| Mutex::new(None))
}
fn direct_map() -> &'static Mutex<HashMap<String, Child>> {
    DIRECT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn base_dir(config_dir: &str) -> PathBuf {
    let d = Path::new(config_dir).join("playit");
    let _ = fs::create_dir_all(&d);
    d
}
fn agent_path(config_dir: &str) -> PathBuf {
    base_dir(config_dir).join("playit.exe")
}

pub fn read_key(config_dir: &str) -> Option<String> {
    let txt = fs::read_to_string(Path::new(config_dir).join("playit-account.json")).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    let k = v.get("secretKey")?.as_str()?.trim().to_string();
    if k.len() >= 16 {
        Some(k)
    } else {
        None
    }
}

/// Saves the secret key the same way x_client did: account file (is_linked/read_key), plus playit.toml next to the
/// agent and in %LOCALAPPDATA%\\playit_gg, so the agent finds the key no matter how it looks for it.
pub fn save_key(config_dir: &str, key: &str) {
    let key = key.trim();
    if key.is_empty() {
        return;
    }
    let _ = fs::create_dir_all(config_dir);
    let _ = fs::write(
        Path::new(config_dir).join("playit-account.json"),
        json!({ "secretKey": key }).to_string(),
    );
    let base = base_dir(config_dir);
    let _ = fs::write(base.join("account.json"), json!({ "secretKey": key }).to_string());
    write_agent_toml(config_dir, key);
}

fn agent_toml_dirs(config_dir: &str) -> Vec<PathBuf> {
    let mut v = vec![base_dir(config_dir)];
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        v.push(Path::new(&l).join("playit_gg"));
    }
    v
}

fn write_agent_toml(config_dir: &str, key: &str) {
    for d in agent_toml_dirs(config_dir) {
        let _ = fs::create_dir_all(&d);
        let _ = fs::write(d.join("playit.toml"), format!("secret_key = \"{}\"\n", key));
    }
}

/// Removes every copy of the key (Unlink).
pub fn clear_key_files(config_dir: &str) {
    let _ = fs::remove_file(Path::new(config_dir).join("playit-account.json"));
    let base = base_dir(config_dir);
    let _ = fs::remove_file(base.join("account.json"));
    for d in agent_toml_dirs(config_dir) {
        let _ = fs::remove_file(d.join("playit.toml"));
    }
}

/// Some(true) = Playit accepts the key, Some(false) = key is dead/deleted, None = could not ask (offline).
pub async fn key_check(key: &str) -> Option<bool> {
    match call("/agents/rundata", json!({}), Some(key)).await {
        Ok(v) => Some(v.get("agent_id").is_some()),
        Err(e) => {
            if e.contains("unreachable") || e.contains("bad reply") {
                None
            } else {
                Some(false)
            }
        }
    }
}

fn hide(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn emit_state(app: &AppHandle, config_dir: &str) {
    let _ = app.emit(
        "inex-event",
        json!({ "channel": "event:playit-state", "data": get_playit_state(config_dir) }),
    );
}

fn fail(app: &AppHandle, config_dir: &str, server_id: &str, msg: String) -> Result<Value, String> {
    {
        let mut l = get_state().lock().unwrap();
        l.sharing.remove(server_id);
        l.status = "error".to_string();
        l.message = msg.clone();
    }
    emit_state(app, config_dir);
    Err(msg)
}

fn finish(
    app: &AppHandle,
    config_dir: &str,
    server_id: &str,
    java: TunnelEndpoint,
    bedrock: Option<TunnelEndpoint>,
    msg: &str,
) -> Result<Value, String> {
    {
        let mut l = get_state().lock().unwrap();
        l.tunnels.insert(server_id.to_string(), ServerTunnel { java, bedrock });
        l.sharing.insert(server_id.to_string());
        l.status = "running".to_string();
        l.message = msg.to_string();
    }
    emit_state(app, config_dir);
    Ok(get_playit_state(config_dir))
}

fn still_wanted(server_id: &str) -> bool {
    get_state().lock().unwrap().sharing.contains(server_id)
}

// ---------------- Playit API ----------------
async fn call(route: &str, body: Value, key: Option<&str>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(format!("{}{}", API, route))
        .header("User-Agent", UA)
        .json(&body);
    if let Some(k) = key {
        req = req.header("Authorization", format!("Agent-Key {}", k));
    }
    let res = req.send().await.map_err(|e| format!("Playit API unreachable: {e}"))?;
    let v: Value = res.json().await.map_err(|e| format!("Playit API bad reply: {e}"))?;
    if v.get("status").and_then(|s| s.as_str()) == Some("success") {
        return Ok(v.get("data").cloned().unwrap_or(Value::Null));
    }
    let detail = match v.get("data") {
        Some(Value::String(s)) => s.clone(),
        Some(d) => d
            .get("message")
            .or_else(|| d.get("type"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| d.to_string()),
        None => String::new(),
    };
    Err(format!("Playit API error: {}", detail.chars().take(120).collect::<String>()))
}

// ---------------- Agent download / run ----------------
async fn ensure_agent(config_dir: &str) -> Result<(), String> {
    let path = agent_path(config_dir);
    if path.exists() && fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut urls: Vec<String> = Vec::new();
    if let Ok(r) = client
        .get("https://api.github.com/repos/playit-cloud/playit-agent/releases/latest")
        .header("User-Agent", UA)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        if let Ok(j) = r.json::<Value>().await {
            let mut found: Vec<(i32, String)> = Vec::new();
            if let Some(arr) = j.get("assets").and_then(|a| a.as_array()) {
                for a in arr {
                    let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
                    let url = a.get("browser_download_url").and_then(|u| u.as_str()).unwrap_or("");
                    if url.is_empty()
                        || !name.contains("windows")
                        || !name.ends_with(".exe")
                        || name.contains("arm")
                        || name.contains("aarch")
                    {
                        continue;
                    }
                    let mut score = 0;
                    if name.contains("x86_64") || name.contains("amd64") || name.contains("x64") {
                        score += 3;
                    }
                    if name.contains("signed") {
                        score += 2;
                    }
                    found.push((score, url.to_string()));
                }
            }
            found.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, u) in found {
                urls.push(u);
            }
        }
    }
    urls.push(format!("{}/playit-windows-x86_64-signed.exe", RELEASE_BASE));
    urls.push(format!("{}/playit-windows-x86-signed.exe", RELEASE_BASE));

    let mut errors: Vec<String> = Vec::new();
    for url in urls.iter() {
        match client.get(url).header("User-Agent", UA).send().await {
            Ok(res) => {
                if !res.status().is_success() {
                    errors.push(format!("HTTP {}", res.status().as_u16()));
                    continue;
                }
                match res.bytes().await {
                    Ok(b) => {
                        if b.len() < 1_000_000 {
                            errors.push("file too small".to_string());
                            continue;
                        }
                        if b[0] != 0x4d || b[1] != 0x5a {
                            errors.push("not an exe".to_string());
                            continue;
                        }
                        let tmp = path.with_extension("exe.part");
                        fs::write(&tmp, &b).map_err(|e| e.to_string())?;
                        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    Err(e) => errors.push(e.to_string()),
                }
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    let shown: Vec<String> = errors.into_iter().take(3).collect();
    Err(format!("Playit agent download failed ({})", shown.join(", ")))
}

fn pump<R: std::io::Read + Send + 'static>(
    r: R,
    log: PathBuf,
    key: String,
    invalid: Arc<AtomicBool>,
    tail: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(r);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let masked = line.replace(&key, "***");
            if masked.contains("InvalidAgentKey") {
                invalid.store(true, Ordering::SeqCst);
            }
            {
                let mut t = tail.lock().unwrap();
                t.push_str(&masked);
                t.push('\n');
                let n = t.len();
                if n > 600 {
                    let mut c = n - 600;
                    while !t.is_char_boundary(c) {
                        c += 1;
                    }
                    let cut = t[c..].to_string();
                    *t = cut;
                }
            }
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log) {
                let _ = writeln!(f, "{}", masked);
            }
        }
    });
}

async fn start_agent(config_dir: &str, key: &str) -> Result<(), String> {
    {
        let mut slot = agent_slot().lock().unwrap();
        if let Some(c) = slot.as_mut() {
            if let Ok(None) = c.try_wait() {
                return Ok(());
            }
        }
        *slot = None;
    }
    let base = base_dir(config_dir);
    let log = base.join("agent.log");
    let _ = fs::write(&log, "");
    write_agent_toml(config_dir, key);
    let mut last = String::new();

    let attempts: Vec<Vec<&str>> = vec![vec!["--stdout"], vec![]];
    for args in attempts {
        let mut cmd = Command::new(agent_path(config_dir));
        cmd.args(&args)
            .current_dir(&base)
            .env("SECRET_KEY", key)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last = e.to_string();
                continue;
            }
        };
        let invalid = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(String::new()));
        if let Some(out) = child.stdout.take() {
            pump(out, log.clone(), key.to_string(), invalid.clone(), tail.clone());
        }
        if let Some(err) = child.stderr.take() {
            pump(err, log.clone(), key.to_string(), invalid.clone(), tail.clone());
        }
        tokio::time::sleep(Duration::from_millis(3500)).await;
        if invalid.load(Ordering::SeqCst) {
            let _ = child.kill();
            return Err("Playit agent key is invalid or deleted. Please re-link account.".to_string());
        }
        match child.try_wait() {
            Ok(None) => {
                *agent_slot().lock().unwrap() = Some(child);
                return Ok(());
            }
            _ => {
                last = tail.lock().unwrap().clone();
            }
        }
    }
    let extra = if last.is_empty() {
        String::new()
    } else {
        format!(": {}", last.replace('\n', " ").chars().take(140).collect::<String>())
    };
    Err(format!("Playit agent could not start{}", extra))
}

pub fn stop_agent() {
    let taken = agent_slot().lock().unwrap().take();
    if let Some(mut c) = taken {
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ---------------- Tunnels via the agent ----------------
fn find_tunnel(data: &Value, ttype: &str, local_port: u16) -> Option<Value> {
    let arr = data.get("tunnels").and_then(|t| t.as_array())?;
    let has_domain = |t: &Value| -> bool {
        t.get("custom_domain").and_then(|d| d.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
            || t.get("assigned_domain").and_then(|d| d.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
    };
    let active: Vec<&Value> = arr
        .iter()
        .filter(|t| {
            t.get("tunnel_type").and_then(|x| x.as_str()) == Some(ttype)
                && !t.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false)
                && has_domain(t)
        })
        .collect();
    for t in active.iter() {
        if t.get("local_port").and_then(|p| p.as_u64()) == Some(local_port as u64) {
            return Some((*t).clone());
        }
    }
    active.first().map(|t| (*t).clone())
}

async fn ensure_tunnel(key: &str, run: &Value, kind: &str, local_port: u16) -> Result<Value, String> {
    let (ttype, proto) = if kind == "java" {
        ("minecraft-java", "tcp")
    } else {
        ("minecraft-bedrock", "udp")
    };
    if let Some(t) = find_tunnel(run, ttype, local_port) {
        return Ok(t);
    }
    let pending = run
        .get("pending")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().any(|t| t.get("tunnel_type").and_then(|x| x.as_str()) == Some(ttype)))
        .unwrap_or(false);
    if !pending {
        let agent_id = run.get("agent_id").cloned().unwrap_or(Value::Null);
        let mut payload = json!({
            "name": format!("CRYOX {}{}", kind, local_port),
            "tunnel_type": ttype,
            "port_type": proto,
            "port_count": 1,
            "origin": { "type": "agent", "data": { "agent_id": agent_id, "local_ip": "127.0.0.1", "local_port": local_port } },
            "enabled": true,
            "alloc": { "type": "region", "details": { "region": "global" } },
            "firewall_id": null
        });
        if let Err(e) = call("/tunnels/create", payload.clone(), Some(key)).await {
            let low = e.to_lowercase();
            if low.contains("body") || low.contains("validation") || low.contains("alloc") {
                payload["alloc"] = Value::Null;
                call("/tunnels/create", payload, Some(key)).await?;
            } else {
                return Err(e);
            }
        }
    }
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let data = call("/agents/rundata", json!({}), Some(key)).await?;
        if let Some(t) = find_tunnel(&data, ttype, local_port) {
            return Ok(t);
        }
    }
    Err("Playit tunnel timeout".to_string())
}

fn address_of(t: &Value, kind: &str) -> Option<TunnelEndpoint> {
    let custom = t.get("custom_domain").and_then(|d| d.as_str()).filter(|s| !s.is_empty());
    let host = match custom {
        Some(h) => h.to_string(),
        None => t.get("assigned_domain").and_then(|d| d.as_str())?.to_string(),
    };
    let port = t.get("port").and_then(|p| p.get("from")).and_then(|f| f.as_u64()).unwrap_or(0) as u16;
    let host_only = kind == "java" && host.to_lowercase().ends_with(".joinmc.link");
    let display = if host_only { host.clone() } else { format!("{}:{}", host, port) };
    Some(TunnelEndpoint { host, port, display })
}

async fn linked_share(
    config_dir: &str,
    key: &str,
    port: u16,
    bedrock_port: Option<u16>,
) -> Result<(TunnelEndpoint, Option<TunnelEndpoint>), String> {
    ensure_agent(config_dir).await?;
    start_agent(config_dir, key).await?;
    let run = call("/agents/rundata", json!({}), Some(key)).await?;
    if run.get("agent_id").is_none() {
        return Err("Playit agent not found for this key".to_string());
    }
    let java_t = ensure_tunnel(key, &run, "java", port).await?;
    let java = address_of(&java_t, "java").ok_or_else(|| "Playit returned no address".to_string())?;
    let mut bedrock: Option<TunnelEndpoint> = None;
    if let Some(bp) = bedrock_port {
        if let Ok(fresh) = call("/agents/rundata", json!({}), Some(key)).await {
            if let Ok(t) = ensure_tunnel(key, &fresh, "bedrock", bp).await {
                bedrock = address_of(&t, "bedrock");
            }
        }
    }
    Ok((java, bedrock))
}

// ---------------- Zero-login temporary tunnel (Pinggy, then Serveo) ----------------
fn ensure_ssh_key(config_dir: &str) -> Option<PathBuf> {
    let key = base_dir(config_dir).join("cryox_tunnel_ed25519");
    if key.exists() {
        return Some(key);
    }
    let p = r"C:\Windows\System32\OpenSSH\ssh-keygen.exe";
    let bin = if Path::new(p).exists() { p.to_string() } else { "ssh-keygen".to_string() };
    let mut cmd = Command::new(bin);
    cmd.args(["-t", "ed25519", "-f"])
        .arg(&key)
        .args(["-N", "", "-q"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide(&mut cmd);
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    if ok && key.exists() {
        Some(key)
    } else {
        None
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn token_to_hostport(t: &str) -> Option<(String, u16)> {
    let t = t.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != ':' && c != '/');
    let t = t.strip_prefix("tcp://").unwrap_or(t);
    let (h, p) = t.rsplit_once(':')?;
    let p = p.trim_end_matches('/').parse::<u16>().ok()?;
    if h.is_empty() {
        None
    } else {
        Some((h.to_string(), p))
    }
}

fn parse_endpoint(clean: &str, provider: &str) -> Option<(String, u16)> {
    if provider == "pinggy" {
        for tok in clean.split_whitespace() {
            if tok.contains(".pinggy.link:") {
                if let Some(hp) = token_to_hostport(tok) {
                    return Some(hp);
                }
            }
        }
        None
    } else {
        let phrase = "Forwarding TCP connections from ";
        let idx = clean.find(phrase)?;
        let rest = &clean[idx + phrase.len()..];
        token_to_hostport(rest.split_whitespace().next()?)
    }
}

fn try_ssh_blocking(config_dir: &str, server_id: &str, port: u16, provider: &str) -> Option<(String, u16)> {
    let key = ensure_ssh_key(config_dir);
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let sshbin = {
        let p = r"C:\Windows\System32\OpenSSH\ssh.exe";
        if Path::new(p).exists() { p.to_string() } else { "ssh".to_string() }
    };
    let mut args: Vec<String> = Vec::new();
    if let Some(k) = &key {
        args.push("-i".to_string());
        args.push(k.to_string_lossy().to_string());
    }
    if provider == "pinggy" {
        for a in ["-p", "443"] {
            args.push(a.to_string());
        }
    }
    for a in ["-o", "StrictHostKeyChecking=no"] {
        args.push(a.to_string());
    }
    args.push("-o".to_string());
    args.push(format!("UserKnownHostsFile={}", null));
    for a in ["-o", "ServerAliveInterval=25", "-o", "ConnectTimeout=10", "-T"] {
        args.push(a.to_string());
    }
    args.push(format!("-R0:127.0.0.1:{}", port));
    args.push(if provider == "pinggy" { "tcp@a.pinggy.io".to_string() } else { "serveo.net".to_string() });

    let mut cmd = Command::new(sshbin);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(o) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut r = o;
            let mut buf = [0u8; 1024];
            loop {
                match std::io::Read::read(&mut r, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                    }
                }
            }
        });
    }
    if let Some(e) = child.stderr.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut r = e;
            let mut buf = [0u8; 1024];
            loop {
                match std::io::Read::read(&mut r, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                    }
                }
            }
        });
    }
    drop(tx);

    let start = Instant::now();
    let mut acc = String::new();
    loop {
        let left = match Duration::from_secs(12).checked_sub(start.elapsed()) {
            Some(l) => l,
            None => break,
        };
        match rx.recv_timeout(left) {
            Ok(s) => {
                acc.push_str(&s);
                let clean = strip_ansi(&acc);
                if let Some(hp) = parse_endpoint(&clean, provider) {
                    direct_map().lock().unwrap().insert(server_id.to_string(), child);
                    return Some(hp);
                }
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

pub fn stop_direct(server_id: &str) {
    let taken = direct_map().lock().unwrap().remove(server_id);
    if let Some(mut c) = taken {
        let _ = c.kill();
        let _ = c.wait();
    }
}

async fn start_direct(config_dir: &str, server_id: &str, port: u16) -> Option<TunnelEndpoint> {
    stop_direct(server_id);
    for provider in ["pinggy", "serveo"] {
        let cd = config_dir.to_string();
        let sid = server_id.to_string();
        let res = tauri::async_runtime::spawn_blocking(move || try_ssh_blocking(&cd, &sid, port, provider))
            .await
            .ok()
            .flatten();
        if let Some((host, p)) = res {
            let display = format!("{}:{}", host, p);
            return Some(TunnelEndpoint { host, port: p, display });
        }
    }
    None
}

fn watch_direct(app: AppHandle, config_dir: String, server_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let mut m = direct_map().lock().unwrap();
        let exited = match m.get_mut(&server_id) {
            None => break,
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
        };
        if exited {
            m.remove(&server_id);
            drop(m);
            {
                let mut l = get_state().lock().unwrap();
                l.tunnels.remove(&server_id);
                l.status = "error".to_string();
                l.message = "Public tunnel disconnected. Click Refresh Tunnel to reconnect.".to_string();
            }
            emit_state(&app, &config_dir);
            break;
        }
    });
}

// ---------------- Public API used by lib.rs / servers.rs / playit.rs ----------------
pub async fn share_any(
    app: AppHandle,
    config_dir: String,
    server_id: String,
    port: u16,
    bedrock_port: Option<u16>,
    java_tunnel: String,
) -> Result<Value, String> {
    if java_tunnel == "bore" {
        return crate::playit::share_tunnel(app, config_dir, server_id, port, None).await;
    }

    crate::playit::release_tunnel(app.clone(), &config_dir, &server_id);
    let key = read_key(&config_dir);
    {
        let mut l = get_state().lock().unwrap();
        l.sharing.insert(server_id.clone());
        l.status = "starting".to_string();
        let msg = if key.is_some() {
            "Connecting to playit.gg..."
        } else {
            "Auto-generating public server IP & tunnel..."
        };
        l.message = msg.to_string();
    }
    emit_state(&app, &config_dir);

    if let Some(key) = key {
        return match linked_share(&config_dir, &key, port, bedrock_port).await {
            Ok((java, bedrock)) => {
                if !still_wanted(&server_id) {
                    return Err("Cancelled".to_string());
                }
                finish(&app, &config_dir, &server_id, java, bedrock, "")
            }
            Err(e) => {
                let low = e.to_lowercase();
                if low.contains("invalid") || low.contains("expired") || low.contains("auth") {
                    crate::playit::unlink(app.clone(), &config_dir);
                }
                fail(
                    &app,
                    &config_dir,
                    &server_id,
                    format!(
                        "Could not connect to Playit.gg ({}). If your Playit account says \"Agent limit reached\", delete old agents at playit.gg > Manage Agent, then try again.",
                        e
                    ),
                )
            }
        };
    }

    match start_direct(&config_dir, &server_id, port).await {
        Some(java) => {
            if !still_wanted(&server_id) {
                stop_direct(&server_id);
                return Err("Cancelled".to_string());
            }
            watch_direct(app.clone(), config_dir.clone(), server_id.clone());
            finish(&app, &config_dir, &server_id, java, None, "Temporary address (changes on restart).")
        }
        None => fail(
            &app,
            &config_dir,
            &server_id,
            "Could not reach public tunnel server. Check your internet connection and click Refresh Tunnel.".to_string(),
        ),
    }
}

/// Called right after the Playit claim is accepted: the agent must run so playit.gg stops showing "Waiting for agent".
pub async fn after_link(app: &AppHandle, config_dir: &str, key: &str) {
    {
        let mut l = get_state().lock().unwrap();
        l.status = "linking".to_string();
        l.message = "Starting Playit agent...".to_string();
        l.claim_url = String::new();
    }
    emit_state(app, config_dir);
    let r: Result<(), String> = async {
        ensure_agent(config_dir).await?;
        start_agent(config_dir, key).await?;
        Ok(())
    }
    .await;
    {
        let mut l = get_state().lock().unwrap();
        match r {
            Ok(()) => {
                l.status = "off".to_string();
                l.message = String::new();
            }
            Err(e) => {
                l.status = "error".to_string();
                l.message = format!("Playit linked, but the agent could not start: {}", e);
            }
        }
        l.claim_url = String::new();
    }
    emit_state(app, config_dir);
}

pub fn stop_all() {
    let ids: Vec<String> = direct_map().lock().unwrap().keys().cloned().collect();
    for id in ids {
        stop_direct(&id);
    }
    stop_agent();
}
