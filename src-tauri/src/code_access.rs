use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};

const CODE_LEN: usize = 8;
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS: u64 = 15 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct PendingCode {
    pub code: String,
    pub server_id: String,
    pub exp: u64,
}

#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub id: String,
    pub server_id: String,
    pub since: u64,
    pub sid: String,
    pub opened: bool,
}

pub struct CodeAccessState {
    pub pending: Option<PendingCode>,
    pub session: Option<ActiveSession>,
}

static CODE_ACCESS: OnceLock<Arc<Mutex<CodeAccessState>>> = OnceLock::new();

fn get_state() -> &'static Arc<Mutex<CodeAccessState>> {
    CODE_ACCESS.get_or_init(|| {
        Arc::new(Mutex::new(CodeAccessState {
            pending: None,
            session: None,
        }))
    })
}

fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

fn new_code() -> String {
    let mut s = String::with_capacity(CODE_LEN);
    for _ in 0..CODE_LEN {
        let idx = (rand_u32() % (ALPHABET.len() as u32)) as usize;
        s.push(ALPHABET[idx] as char);
    }
    s
}

fn rand_u32() -> u32 {
    let uuid_val = uuid::Uuid::new_v4();
    let bytes = uuid_val.as_bytes();
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

pub fn get_status() -> Value {
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().timestamp_millis() as u64;
    if lock.pending.as_ref().map(|p| p.exp <= now).unwrap_or(false) {
        lock.pending = None;
    }
    get_status_from_locked(&lock)
}

pub fn current_session_code() -> Option<String> {
    get_state().lock().unwrap_or_else(|e| e.into_inner()).session.as_ref().map(|s| s.id.clone())
}

pub fn create_code(server_id: &str, server_exists: bool) -> Result<Value, String> {
    if !server_exists {
        return Err("Server not found".to_string());
    }

    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().timestamp_millis() as u64;
    if lock.pending.as_ref().map(|p| p.exp <= now).unwrap_or(false) {
        lock.pending = None;
    }
    if lock.session.is_some() {
        return Err("Someone is connected right now. Disconnect them first.".to_string());
    }
    if lock.pending.is_some() {
        return Ok(get_status_from_locked(&lock));
    }

    let code = new_code();
    let exp = now + CODE_TTL_MS;
    lock.pending = Some(PendingCode {
        code: code.clone(),
        server_id: server_id.to_string(),
        exp,
    });

    Ok(get_status_from_locked(&lock))
}

pub fn cancel_code() -> Value {
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    lock.pending = None;
    get_status_from_locked(&lock)
}

pub fn disconnect() -> Value {
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    lock.session = None;
    lock.pending = None;
    get_status_from_locked(&lock)
}

pub fn claim(code: &str, sid: &str) -> Result<Value, String> {
    let norm = normalize(code);
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    let p = match lock.pending.take() {
        Some(p) if p.code == norm && p.exp > now => p,
        Some(p) if p.code == norm => return Err("This code has expired.".to_string()),
        Some(other) => {
            lock.pending = Some(other);
            return Err("This code is not active.".to_string());
        }
        None => return Err("This code is not active.".to_string()),
    };

    lock.session = Some(ActiveSession {
        id: norm,
        server_id: p.server_id,
        since: now,
        sid: sid.to_string(),
        opened: false,
    });

    Ok(json!({ "ok": true }))
}

pub fn host_opened(code: &str) -> Value {
    let norm = normalize(code);
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut s) = lock.session {
        if s.id == norm {
            s.opened = true;
            return json!({ "ok": true });
        }
    }
    json!({ "ok": false })
}

pub fn host_closed(code: &str) -> Value {
    let norm = normalize(code);
    let mut lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref s) = lock.session {
        if s.id == norm {
            lock.session = None;
        }
    }
    json!({ "ok": true })
}

/// Authorize a P2P RPC call against the active host session and server scope.
pub fn authorize_p2p(code: &str, method: &str, args: &[Value]) -> Result<String, String> {
    let norm = normalize(code);
    let lock = get_state().lock().unwrap_or_else(|e| e.into_inner());
    let s = lock
        .session
        .as_ref()
        .filter(|s| s.id == norm)
        .ok_or_else(|| "This editor session is not active.".to_string())?;

    if method != "listServers" {
        if let Some(requested_id) = args.first().and_then(|v| v.as_str()).filter(|id| !id.is_empty()) {
            if requested_id != s.server_id {
                return Err("Access denied for this server.".to_string());
            }
        }
    }
    Ok(s.server_id.clone())
}

pub async fn p2p_exec(
    app: &tauri::AppHandle,
    code: &str,
    method: &str,
    args: &[Value],
    settings: &Value,
) -> Result<Value, String> {
    let srv_id = authorize_p2p(code, method, args)?;
    let game_data_dir = settings.get("gameDataDir").and_then(|v| v.as_str()).unwrap_or(".");
    let config_dir = settings.get("configDir").and_then(|v| v.as_str()).unwrap_or(".");
    let java_dir = settings.get("javaDir").and_then(|v| v.as_str()).unwrap_or(".");

    // Parity with cohostPolicy.js: all 19 safe co-host operations allowed; create/delete/kill/tunnels/browse remain blocked.
    match method {
        "listServers" => {
            let list = crate::servers::list_servers(game_data_dir);
            let filtered: Vec<_> = list.into_iter().filter(|srv| srv.meta.id == srv_id).collect();
            Ok(json!(filtered))
        }
        "getServer" => crate::servers::get_server(game_data_dir, &srv_id).map(|s| json!(s)),
        "getServerLog" => Ok(json!(crate::servers::get_server_log(&srv_id))),
        "getServerStats" => Ok(json!(crate::servers::get_server_stats(&srv_id))),
        "getServerPlayers" => Ok(crate::servers::get_player_lists(game_data_dir, &srv_id)),
        "getServerProperties" => {
            let dir = crate::servers::get_server_dir(game_data_dir, &srv_id);
            let values = crate::servers::read_properties_values(&dir);
            let defaults = crate::servers::default_properties_template();
            Ok(json!({ "values": values, "defaults": defaults }))
        }
        "setServerProperties" => {
            let updates_val = args.get(1).ok_or_else(|| "Missing properties updates".to_string())?;
            let updates: std::collections::HashMap<String, String> =
                serde_json::from_value(updates_val.clone()).map_err(|e| format!("Invalid properties payload: {e}"))?;
            let dir = crate::servers::get_server_dir(game_data_dir, &srv_id);
            crate::servers::write_properties(&dir, &updates)?;
            Ok(json!({ "written": true }))
        }
        "getServerNetwork" => Ok(crate::servers::get_server_network(game_data_dir, &srv_id)),
        "startServer" => crate::servers::start_server(app.clone(), game_data_dir, config_dir, java_dir, &srv_id)
            .await
            .map(|s| json!(s)),
        "stopServer" => crate::servers::stop_server(&srv_id),
        "restartServer" => crate::restart_server_by_id(app.clone(), &srv_id, settings).await,
        "sendServerCommand" => {
            if let Some(cmd) = args.get(1).and_then(|v| v.as_str()) {
                crate::servers::send_command(&srv_id, cmd)
            } else {
                Err("Missing command".to_string())
            }
        }
        "serverPlayerAction" => {
            let act = args.get(1).and_then(|v| v.as_str()).ok_or_else(|| "Missing player action".to_string())?;
            let name = args.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let reason = args.get(3).and_then(|v| v.as_str());
            crate::servers::player_action(game_data_dir, &srv_id, act, name, reason)
        }
        "listServerAddons" => Ok(json!(crate::servers::list_server_addons(game_data_dir, &srv_id))),
        "toggleServerAddon" => {
            let file = args.get(1).and_then(|v| v.as_str()).ok_or_else(|| "Missing addon file name".to_string())?;
            crate::servers::toggle_server_addon(game_data_dir, &srv_id, file)
        }
        "removeServerAddon" => {
            let file = args.get(1).and_then(|v| v.as_str()).ok_or_else(|| "Missing addon file name".to_string())?;
            crate::servers::remove_server_addon(game_data_dir, &srv_id, file)
        }
        "listServerFiles" => {
            let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            crate::servers::list_server_files(game_data_dir, &srv_id, rel)
        }
        "readServerFile" => {
            let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            crate::servers::read_server_file(game_data_dir, &srv_id, rel)
        }
        "writeServerFile" => {
            if let (Some(rel), Some(content)) = (args.get(1).and_then(|v| v.as_str()), args.get(2).and_then(|v| v.as_str())) {
                crate::servers::write_server_file(game_data_dir, &srv_id, rel, content)
            } else {
                Err("Missing file path or content".to_string())
            }
        }
        _ => Err(format!("Method {} is not permitted over remote P2P", method)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // Keep state tests sequential because CODE_ACCESS is a process-wide static.
    static TEST_GUARD: StdMutex<()> = StdMutex::new(());

    #[test]
    fn code_access_claim_expiry_and_scope_checks() {
        let _g = TEST_GUARD.lock().unwrap();
        let _ = disconnect();

        let created = create_code("srv-1", true).expect("create code");
        let code = created["code"].as_str().unwrap().to_string();

        // Force-expire pending code and confirm claim rejects it.
        {
            let mut st = get_state().lock().unwrap();
            st.pending.as_mut().unwrap().exp = 1;
        }
        assert!(claim(&code, "sid-1").is_err());

        // Re-create and claim validly
        let created2 = create_code("srv-1", true).expect("create code 2");
        let code2 = created2["code"].as_str().unwrap().to_string();
        assert!(claim(&code2, "sid-2").is_ok());

        // Matching server or omitted arg passes; mismatched server id is rejected
        assert_eq!(authorize_p2p(&code2, "getServerPlayers", &[json!("srv-1")]).unwrap(), "srv-1");
        assert!(authorize_p2p(&code2, "getServerPlayers", &[json!("srv-other")]).is_err());
        assert_eq!(authorize_p2p(&code2, "listServers", &[json!("srv-other")]).unwrap(), "srv-1");

        let _ = disconnect();
    }
}

fn get_status_from_locked(lock: &CodeAccessState) -> Value {
    let phase = if lock.session.is_some() {
        "connected"
    } else if lock.pending.is_some() {
        "waiting"
    } else {
        "idle"
    };

    let (code, server_id, exp) = if let Some(ref p) = lock.pending {
        (Some(p.code.clone()), Some(p.server_id.clone()), Some(p.exp))
    } else {
        (None, None, None)
    };

    let since = lock.session.as_ref().map(|s| s.since);

    json!({
        "configured": true,
        "phase": phase,
        "code": code,
        "serverId": server_id,
        "exp": exp,
        "since": since
    })
}
