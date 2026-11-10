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
    let mut lock = get_state().lock().unwrap();
    let now = chrono::Utc::now().timestamp_millis() as u64;
    if lock.pending.as_ref().map(|p| p.exp <= now).unwrap_or(false) {
        lock.pending = None;
    }
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

pub fn current_session_code() -> Option<String> {
    get_state().lock().unwrap().session.as_ref().map(|s| s.id.clone())
}

pub fn create_code(server_id: &str, server_exists: bool) -> Result<Value, String> {
    if !server_exists {
        return Err("Server not found".to_string());
    }

    let mut lock = get_state().lock().unwrap();
    if lock.session.is_some() {
        return Err("Someone is connected right now. Disconnect them first.".to_string());
    }
    if lock.pending.is_some() {
        return Ok(get_status_from_locked(&lock));
    }

    let code = new_code();
    let exp = chrono::Utc::now().timestamp_millis() as u64 + CODE_TTL_MS;
    lock.pending = Some(PendingCode {
        code: code.clone(),
        server_id: server_id.to_string(),
        exp,
    });

    Ok(get_status_from_locked(&lock))
}

pub fn cancel_code() -> Value {
    let mut lock = get_state().lock().unwrap();
    lock.pending = None;
    get_status_from_locked(&lock)
}

pub fn disconnect() -> Value {
    let mut lock = get_state().lock().unwrap();
    lock.session = None;
    lock.pending = None;
    get_status_from_locked(&lock)
}

pub fn claim(code: &str, sid: &str) -> Result<Value, String> {
    let norm = normalize(code);
    let mut lock = get_state().lock().unwrap();
    let p = match lock.pending.take() {
        Some(p) if p.code == norm => p,
        _ => return Err("This code is not active.".to_string()),
    };

    lock.session = Some(ActiveSession {
        id: norm,
        server_id: p.server_id,
        since: chrono::Utc::now().timestamp_millis() as u64,
        sid: sid.to_string(),
        opened: false,
    });

    Ok(json!({ "ok": true }))
}

pub fn host_opened(code: &str) -> Value {
    let norm = normalize(code);
    let mut lock = get_state().lock().unwrap();
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
    let mut lock = get_state().lock().unwrap();
    if let Some(ref s) = lock.session {
        if s.id == norm {
            lock.session = None;
        }
    }
    json!({ "ok": true })
}

pub fn p2p_exec(
    code: &str,
    method: &str,
    args: &[Value],
    game_data_dir: &str,
) -> Result<Value, String> {
    let norm = normalize(code);
    let lock = get_state().lock().unwrap();
    let s = lock
        .session
        .as_ref()
        .filter(|s| s.id == norm)
        .ok_or_else(|| "This editor session is not active.".to_string())?;

    let srv_id = &s.server_id;

    // Disallow dangerous actions over P2P remote connection
    match method {
        "listServers" => {
            let list = crate::servers::list_servers(game_data_dir);
            let filtered: Vec<_> = list.into_iter().filter(|srv| &srv.meta.id == srv_id).collect();
            Ok(json!(filtered))
        }
        "getServer" => crate::servers::get_server(game_data_dir, srv_id).map(|s| json!(s)),
        "getServerLog" => Ok(json!(crate::servers::get_server_log(srv_id))),
        "getServerProperties" => {
            let dir = crate::servers::get_server_dir(game_data_dir, srv_id);
            let values = crate::servers::read_properties_values(&dir);
            let defaults = crate::servers::default_properties_template();
            Ok(json!({ "values": values, "defaults": defaults }))
        }
        "sendServerCommand" => {
            if let Some(cmd) = args.get(1).and_then(|v| v.as_str()) {
                crate::servers::send_command(srv_id, cmd)
            } else {
                Err("Missing command".to_string())
            }
        }
        "stopServer" => crate::servers::stop_server(srv_id),
        "listServerFiles" => {
            let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            crate::servers::list_server_files(game_data_dir, srv_id, rel)
        }
        "readServerFile" => {
            let rel = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            crate::servers::read_server_file(game_data_dir, srv_id, rel)
        }
        "writeServerFile" => {
            if let (Some(rel), Some(content)) = (args.get(1).and_then(|v| v.as_str()), args.get(2).and_then(|v| v.as_str())) {
                crate::servers::write_server_file(game_data_dir, srv_id, rel, content)
            } else {
                Err("Missing file path or content".to_string())
            }
        }
        _ => Err(format!("Method {} is not permitted over remote P2P", method)),
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
