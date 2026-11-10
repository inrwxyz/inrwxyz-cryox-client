use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEndpoint {
    pub host: String,
    pub port: u16,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTunnel {
    pub java: TunnelEndpoint,
    pub bedrock: Option<TunnelEndpoint>,
}

pub struct PlayitState {
    pub status: String,
    pub message: String,
    pub claim_url: String,
    pub tunnels: HashMap<String, ServerTunnel>,
    pub sharing: HashSet<String>,
}

static LINK_TOKEN: AtomicU64 = AtomicU64::new(0);
static PLAYIT: OnceLock<Arc<Mutex<PlayitState>>> = OnceLock::new();
static BORE_ABORTS: OnceLock<Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>> = OnceLock::new();

pub(crate) fn get_state() -> &'static Arc<Mutex<PlayitState>> {
    PLAYIT.get_or_init(|| {
        Arc::new(Mutex::new(PlayitState {
            status: "off".to_string(),
            message: String::new(),
            claim_url: String::new(),
            tunnels: HashMap::new(),
            sharing: HashSet::new(),
        }))
    })
}

fn get_aborts() -> &'static Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> {
    BORE_ABORTS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub fn is_linked(config_dir: &str) -> bool {
    let key_file = Path::new(config_dir).join("playit-account.json");
    if key_file.exists() {
        if let Ok(content) = fs::read_to_string(&key_file) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                if let Some(key) = v.get("secretKey").and_then(|k| k.as_str()) {
                    return key.len() >= 16;
                }
            }
        }
    }
    false
}

pub fn get_playit_state(config_dir: &str) -> Value {
    let lock = get_state().lock().unwrap();
    let linked = is_linked(config_dir);
    let sharing: Vec<_> = lock.sharing.iter().cloned().collect();

    json!({
        "status": lock.status,
        "message": lock.message,
        "claimUrl": lock.claim_url,
        "tunnels": lock.tunnels,
        "linked": linked,
        "sharing": sharing
    })
}

fn ports_file(config_dir: &str) -> std::path::PathBuf {
    Path::new(config_dir).join("bore_ports.json")
}

fn read_remembered_port(config_dir: &str, server_id: &str) -> u16 {
    let f = ports_file(config_dir);
    if f.exists() {
        if let Ok(txt) = fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if let Some(p) = v.get(server_id).and_then(|p| p.as_u64()) {
                    return p as u16;
                }
            }
        }
    }
    0
}

fn save_remembered_port(config_dir: &str, server_id: &str, port: u16) {
    let f = ports_file(config_dir);
    let mut map: HashMap<String, u16> = HashMap::new();
    if f.exists() {
        if let Ok(txt) = fs::read_to_string(&f) {
            if let Ok(m) = serde_json::from_str::<HashMap<String, u16>>(&txt) {
                map = m;
            }
        }
    }
    map.insert(server_id.to_string(), port);
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(&f, json);
    }
}

async fn bore_open_control(wanted_port: u16) -> Result<(tokio::net::TcpStream, u16), String> {
    use tokio::time::{timeout, Duration};

    let mut control = timeout(Duration::from_secs(10), tokio::net::TcpStream::connect("bore.pub:7835"))
        .await
        .map_err(|_| "bore.pub did not answer in time. Check your internet.".to_string())?
        .map_err(|e| format!("Could not reach bore.pub: {e}"))?;
    let _ = control.set_nodelay(true);

    let mut hello = serde_json::to_vec(&json!({ "Hello": wanted_port })).unwrap();
    hello.push(0);
    control.write_all(&hello).await
        .map_err(|e| format!("bore.pub handshake failed: {e}"))?;

    let read_hello = async {
        let mut buf: Vec<u8> = Vec::new();
        let mut b = [0u8; 1];
        loop {
            match control.read(&mut b).await {
                Ok(0) => return Err("bore.pub closed the connection.".to_string()),
                Ok(_) => {
                    if b[0] == 0 {
                        if let Ok(v) = serde_json::from_slice::<Value>(&buf) {
                            if let Some(p) = v.get("Hello").and_then(|h| h.as_u64()) {
                                return Ok(p as u16);
                            }
                            if let Some(err) = v.get("Error").and_then(|e| e.as_str()) {
                                return Err(format!("bore.pub error: {err}"));
                            }
                            if v.get("Challenge").is_some() {
                                return Err("bore.pub asked for a secret (not supported).".to_string());
                            }
                        }
                        buf.clear();
                    } else {
                        buf.push(b[0]);
                    }
                }
                Err(e) => return Err(format!("Read error from bore.pub: {e}")),
            }
        }
    };

    let port = timeout(Duration::from_secs(10), read_hello)
        .await
        .map_err(|_| "bore.pub did not answer in time.".to_string())??;
    Ok((control, port))
}

pub async fn share_tunnel(
    app: AppHandle,
    config_dir: String,
    server_id: String,
    port: u16,
    bedrock_port: Option<u16>,
) -> Result<Value, String> {
    release_tunnel(app.clone(), &config_dir, &server_id);

    {
        let mut lock = get_state().lock().unwrap();
        lock.sharing.insert(server_id.clone());
        lock.status = "starting".to_string();
        lock.message = "Connecting to bore.pub...".to_string();
    }
    let _ = app.emit("inex-event", json!({
        "channel": "event:playit-state",
        "data": get_playit_state(&config_dir)
    }));

    let wanted_port = read_remembered_port(&config_dir, &server_id);
    let opened = if wanted_port != 0 {
        match bore_open_control(wanted_port).await {
            Ok(o) => Ok(o),
            Err(_) => bore_open_control(0).await,
        }
    } else {
        bore_open_control(0).await
    };
    let (mut control, pub_port) = match opened {
        Ok(o) => o,
        Err(e) => {
            {
                let mut lock = get_state().lock().unwrap();
                lock.sharing.remove(&server_id);
                lock.status = "off".to_string();
                lock.message = e.clone();
            }
            let _ = app.emit("inex-event", json!({
                "channel": "event:playit-state",
                "data": get_playit_state(&config_dir)
            }));
            return Err(e);
        }
    };
    save_remembered_port(&config_dir, &server_id, pub_port);

    let tunnel = ServerTunnel {
        java: TunnelEndpoint {
            host: "bore.pub".to_string(),
            port: pub_port,
            display: format!("bore.pub:{}", pub_port),
        },
        bedrock: bedrock_port.map(|bp| TunnelEndpoint {
            host: "bore.pub".to_string(),
            port: bp,
            display: format!("bore.pub:{}", bp),
        }),
    };

    {
        let mut lock = get_state().lock().unwrap();
        lock.tunnels.insert(server_id.clone(), tunnel);
        lock.status = "running".to_string();
        lock.message = String::new();
    }

    let _ = app.emit("inex-event", json!({
        "channel": "event:playit-state",
        "data": get_playit_state(&config_dir)
    }));

    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut aborts = get_aborts().lock().unwrap();
        aborts.insert(server_id.clone(), tx);
    }

    let app_stream = app.clone();
    let config_dir_stream = config_dir.clone();
    let srv_id_stream = server_id.clone();
    let local_port = port;

    tokio::spawn(async move {
        let mut frame_buf = Vec::new();
        let mut single = [0u8; 1];

        loop {
            tokio::select! {
                _ = &mut rx => {
                    break;
                }
                res = control.read(&mut single) => {
                    match res {
                        Ok(0) => break,
                        Ok(_) => {
                            if single[0] == 0 {
                                if let Ok(msg) = serde_json::from_slice::<Value>(&frame_buf) {
                                    if let Some(conn_id) = msg.get("Connection").and_then(|c| c.as_str()) {
                                        let conn_str = conn_id.to_string();
                                        tokio::spawn(async move {
                                            if let Ok(mut remote) = tokio::net::TcpStream::connect("bore.pub:7835").await {
                                                let _ = remote.set_nodelay(true);
                                                let accept = json!({ "Accept": conn_str });
                                                let mut accept_bytes = serde_json::to_vec(&accept).unwrap();
                                                accept_bytes.push(0);
                                                if remote.write_all(&accept_bytes).await.is_ok() {
                                                    if let Ok(mut local) = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", local_port)).await {
                                                        let _ = local.set_nodelay(true);
                                                        let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                                                    }
                                                }
                                            }
                                        });
                                    }
                                }
                                frame_buf.clear();
                            } else {
                                frame_buf.push(single[0]);
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        {
            let mut lock = get_state().lock().unwrap();
            lock.tunnels.remove(&srv_id_stream);
            lock.sharing.remove(&srv_id_stream);
            if lock.sharing.is_empty() {
                lock.status = "off".to_string();
                lock.message = String::new();
            }
        }
        let _ = app_stream.emit("inex-event", json!({
            "channel": "event:playit-state",
            "data": get_playit_state(&config_dir_stream)
        }));
    });

    Ok(json!(get_playit_state(&config_dir)))
}

pub fn release_tunnel(app: AppHandle, config_dir: &str, server_id: &str) -> Value {
    {
        let mut aborts = get_aborts().lock().unwrap();
        if let Some(tx) = aborts.remove(server_id) {
            let _ = tx.send(());
        }
    }
    crate::playit_ext::stop_direct(server_id);
    {
        let mut lock = get_state().lock().unwrap();
        lock.sharing.remove(server_id);
        lock.tunnels.remove(server_id);
        if lock.sharing.is_empty() {
            crate::playit_ext::stop_agent();
            lock.status = "off".to_string();
            lock.message = String::new();
        }
    }
    let state = get_playit_state(config_dir);
    let _ = app.emit("inex-event", json!({
        "channel": "event:playit-state",
        "data": &state
    }));
    state
}

fn emit_playit(app: &AppHandle, config_dir: &str) {
    // NOTE: never call this while holding the state lock (get_playit_state locks it again).
    let state = get_playit_state(config_dir);
    let _ = app.emit("inex-event", json!({
        "channel": "event:playit-state",
        "data": state
    }));
}

fn set_link_status(app: &AppHandle, config_dir: &str, status: &str, message: &str) {
    {
        let mut lock = get_state().lock().unwrap();
        lock.status = status.to_string();
        lock.message = message.to_string();
        lock.claim_url = String::new();
    }
    emit_playit(app, config_dir);
}

/// The Playit API wraps every answer as { "status": "success", "data": ... }.
fn claim_data_string(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => match v.get("data") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => text.to_string(),
        },
        Err(_) => text.to_string(),
    }
}

pub async fn link_account(app: AppHandle, config_dir: String) -> Result<Value, String> {
    // Already linked with a key Playit still accepts: just make sure the agent is running.
    if let Some(key) = crate::playit_ext::read_key(&config_dir) {
        match crate::playit_ext::key_check(&key).await {
            Some(true) => {
                crate::playit_ext::after_link(&app, &config_dir, &key).await;
                return Ok(json!({ "ok": true, "already": true }));
            }
            Some(false) => {
                // dead / deleted key: clean it up so a fresh claim can be made
                unlink(app.clone(), &config_dir);
            }
            None => {} // offline: the claim request below reports the problem
        }
    }

    let token = LINK_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let code: String = uuid::Uuid::new_v4().simple().to_string().chars().take(10).collect();
    let claim_url = format!("https://playit.gg/claim/{}", code);
    let setup_body = json!({
        "code": &code,
        "agent_type": "self-managed",
        "version": "cryox-launcher"
    });

    let client = reqwest::Client::builder()
        .user_agent("CRYOX-Client-Launcher/1.0 (playit)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let setup_ok = match client.post("https://api.playit.gg/claim/setup").json(&setup_body).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };
    if !setup_ok {
        let msg = "Could not start Playit link. Check your internet and try again.";
        set_link_status(&app, &config_dir, "error", msg);
        return Err(msg.to_string());
    }

    {
        let mut lock = get_state().lock().unwrap();
        lock.status = "linking".to_string();
        lock.message = "Log in to Playit in the browser and approve.".to_string();
        lock.claim_url = claim_url.clone();
    }
    emit_playit(&app, &config_dir);

    let _ = app.opener().open_url(&claim_url, None::<&str>);

    let app_poll = app.clone();
    let config_dir_poll = config_dir.clone();

    tokio::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);

        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;

            // cancelled / replaced by a newer link attempt / unlinked
            if LINK_TOKEN.load(Ordering::SeqCst) != token {
                return;
            }

            let text = match client
                .post("https://api.playit.gg/claim/setup")
                .json(&setup_body)
                .send()
                .await
            {
                Ok(res) => res.text().await.unwrap_or_default(),
                Err(_) => continue,
            };
            let st = claim_data_string(&text);

            if st.contains("UserRejected") {
                set_link_status(&app_poll, &config_dir_poll, "error", "Playit link was rejected.");
                return;
            }
            if st.to_lowercase().contains("limit") {
                set_link_status(
                    &app_poll,
                    &config_dir_poll,
                    "error",
                    "Your Playit account reached its agent limit. Open playit.gg > Manage Agent, delete old agents, then link again.",
                );
                return;
            }
            if st.contains("UserAccepted") {
                // claim/exchange answers { "status":"success", "data": { "secret_key": "..." } }
                let mut key: Option<String> = None;
                for _ in 0..6 {
                    if let Ok(ex_res) = client
                        .post("https://api.playit.gg/claim/exchange")
                        .json(&json!({ "code": &code }))
                        .send()
                        .await
                    {
                        if let Ok(ex_val) = ex_res.json::<Value>().await {
                            let data = ex_val.get("data").unwrap_or(&ex_val);
                            if let Some(k) = data
                                .get("secret_key")
                                .or_else(|| data.get("secretKey"))
                                .and_then(|v| v.as_str())
                            {
                                let k = k.trim();
                                if k.len() >= 16 {
                                    key = Some(k.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                match key {
                    Some(k) => {
                        crate::playit_ext::save_key(&config_dir_poll, &k);
                        crate::playit_ext::after_link(&app_poll, &config_dir_poll, &k).await;
                    }
                    None => set_link_status(
                        &app_poll,
                        &config_dir_poll,
                        "error",
                        "Playit approved, but key exchange failed. Try again.",
                    ),
                }
                return;
            }
        }

        if LINK_TOKEN.load(Ordering::SeqCst) == token {
            set_link_status(
                &app_poll,
                &config_dir_poll,
                "error",
                "Playit link timed out. If the Playit page said \"Agent limit reached\", delete old agents at playit.gg > Manage Agent, then try again.",
            );
        }
    });

    Ok(json!({ "ok": true, "claimUrl": claim_url }))
}

pub fn cancel_link(app: AppHandle, config_dir: &str) -> Value {
    LINK_TOKEN.fetch_add(1, Ordering::SeqCst); // stops the poll loop
    {
        let mut lock = get_state().lock().unwrap();
        lock.status = "off".to_string();
        lock.message = String::new();
        lock.claim_url = String::new();
    } // lock released BEFORE get_playit_state locks it again (the old code deadlocked here)
    emit_playit(&app, config_dir);
    json!({ "cancelled": true })
}

pub fn unlink(app: AppHandle, config_dir: &str) -> Value {
    LINK_TOKEN.fetch_add(1, Ordering::SeqCst);
    crate::playit_ext::stop_all();
    crate::playit_ext::clear_key_files(config_dir);

    {
        let mut lock = get_state().lock().unwrap();
        lock.status = "off".to_string();
        lock.message = String::new();
        lock.claim_url = String::new();
        lock.tunnels.clear();
        lock.sharing.clear();
    }
    emit_playit(&app, config_dir);
    json!({ "unlinked": true })
}
