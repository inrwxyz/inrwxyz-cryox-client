use md5::{Digest as Md5Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinSlot {
    pub id: String,
    pub name: String,
    pub model: String,
    pub preset: String,
    #[serde(default)]
    pub cape_preset: Option<String>,
    #[serde(default)]
    pub custom_skin_data_url: Option<String>,
    #[serde(default)]
    pub active: bool,
}

pub fn default_skin_slots() -> Vec<SkinSlot> {
    vec![
        SkinSlot {
            id: "slot-1".to_string(),
            name: "Slot 1 — Crimson Phantom".to_string(),
            model: "slim".to_string(),
            preset: "crimson-phantom".to_string(),
            cape_preset: Some("inex-crest".to_string()),
            custom_skin_data_url: None,
            active: true,
        },
        SkinSlot {
            id: "slot-2".to_string(),
            name: "Slot 2 — Obsidian Knight".to_string(),
            model: "slim".to_string(),
            preset: "obsidian-knight".to_string(),
            cape_preset: Some("inex-crest".to_string()),
            custom_skin_data_url: None,
            active: false,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
    pub uuid: String,
    #[serde(rename = "type")]
    pub account_type: String,
    #[serde(default)]
    pub authenticated_online: bool,
    #[serde(default = "default_timestamp")]
    pub added_at: String,
    #[serde(default = "default_slot_1")]
    pub active_skin_slot: String,
    #[serde(default = "default_skin_slots")]
    pub skin_slots: Vec<SkinSlot>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub ms_refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub skin_url: Option<String>,
    #[serde(default)]
    pub last_used: Option<String>,
}

fn default_slot_1() -> String {
    "slot-1".to_string()
}
fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountListItem {
    pub id: String,
    pub username: String,
    pub uuid: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub authenticated_online: bool,
    pub added_at: String,
    pub active_skin_slot: String,
    pub has_custom_skin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsResponse {
    pub active_account_id: Option<String>,
    pub accounts: Vec<AccountListItem>,
    pub skin_slots: Vec<SkinSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsState {
    pub active_account_id: Option<String>,
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub skin_slots: Option<Vec<SkinSlot>>,
}

pub fn generate_offline_uuid(username: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{}", username).as_bytes());
    let mut hash = hasher.finalize();
    hash[6] = (hash[6] & 0x0f) | 0x30; // Version 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // IETF variant
    let hex = format!("{:032x}", hash);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub fn load_accounts_state(config_dir: &str) -> AccountsState {
    let file = Path::new(config_dir).join("accounts.json");
    if file.exists() {
        if let Ok(raw) = fs::read_to_string(&file) {
            if let Ok(mut state) = serde_json::from_str::<AccountsState>(&raw) {
                let default_slots = default_skin_slots();
                // Microsoft tokens are stored encrypted (Windows DPAPI). Old plain-text tokens still load and are
                // re-saved encrypted right below.
                let mut needs_migrate = false;
                for acc in &mut state.accounts {
                    if let Some(t) = acc.access_token.take() {
                        needs_migrate |= !t.is_empty() && !crate::dpapi::is_sealed(&t);
                        acc.access_token = crate::dpapi::open(&t).filter(|v| !v.is_empty());
                    }
                    if let Some(t) = acc.ms_refresh_token.take() {
                        needs_migrate |= !t.is_empty() && !crate::dpapi::is_sealed(&t);
                        acc.ms_refresh_token = crate::dpapi::open(&t).filter(|v| !v.is_empty());
                    }
                }
                if needs_migrate {
                    save_accounts_state(config_dir, &state);
                }
                for acc in &mut state.accounts {
                    if acc.skin_slots.is_empty() {
                        acc.skin_slots = default_slots.clone();
                    }
                    if acc.active_skin_slot.is_empty() {
                        acc.active_skin_slot = acc
                            .skin_slots
                            .first()
                            .map(|s| s.id.clone())
                            .unwrap_or_else(|| "slot-1".to_string());
                    }
                }
                return state;
            }
        }
    }

    let initial = AccountsState {
        active_account_id: None,
        accounts: Vec::new(),
        skin_slots: Some(default_skin_slots()),
    };
    save_accounts_state(config_dir, &initial);
    initial
}

pub fn save_accounts_state(config_dir: &str, state: &AccountsState) {
    let file = Path::new(config_dir).join("accounts.json");
    let _ = fs::create_dir_all(config_dir);
    let tmp = format!("{}.tmp", file.to_string_lossy());
    // never write Microsoft tokens as plain text
    let mut sealed = state.clone();
    for acc in &mut sealed.accounts {
        acc.access_token = acc.access_token.as_deref().filter(|t| !t.is_empty()).map(crate::dpapi::seal);
        acc.ms_refresh_token = acc.ms_refresh_token.as_deref().filter(|t| !t.is_empty()).map(crate::dpapi::seal);
    }
    if let Ok(json) = serde_json::to_string_pretty(&sealed) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
}

pub fn list_accounts(config_dir: &str) -> AccountsResponse {
    let state = load_accounts_state(config_dir);
    let active_acc = state
        .accounts
        .iter()
        .find(|a| Some(&a.id) == state.active_account_id.as_ref())
        .or_else(|| state.accounts.first());

    let skin_slots = active_acc
        .map(|a| a.skin_slots.clone())
        .unwrap_or_else(default_skin_slots);

    let accounts = state
        .accounts
        .iter()
        .map(|acc| {
            let has_custom = acc
                .skin_slots
                .iter()
                .any(|s| s.custom_skin_data_url.is_some());
            AccountListItem {
                id: acc.id.clone(),
                username: acc.username.clone(),
                uuid: acc.uuid.clone(),
                account_type: acc.account_type.clone(),
                authenticated_online: acc.authenticated_online,
                added_at: acc.added_at.clone(),
                active_skin_slot: if acc.active_skin_slot.is_empty() {
                    acc.skin_slots
                        .first()
                        .map(|s| s.id.clone())
                        .unwrap_or_else(|| "slot-1".to_string())
                } else {
                    acc.active_skin_slot.clone()
                },
                has_custom_skin: has_custom,
            }
        })
        .collect();

    AccountsResponse {
        active_account_id: state.active_account_id,
        accounts,
        skin_slots,
    }
}

pub fn set_active_account(config_dir: &str, id: &str) -> Result<AccountsResponse, String> {
    let mut state = load_accounts_state(config_dir);
    if !state.accounts.iter().any(|a| a.id == id) {
        return Err(format!("Account not found: {}", id));
    }
    state.active_account_id = Some(id.to_string());
    save_accounts_state(config_dir, &state);
    Ok(list_accounts(config_dir))
}

pub fn add_local_account(config_dir: &str, username: &str) -> Result<AccountsResponse, String> {
    let name = username.trim();
    if name.is_empty() {
        return Err("Username cannot be empty.".to_string());
    }
    if name.len() < 3 || name.len() > 16 {
        return Err("Username must be 3-16 characters.".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(
            "Username must contain only letters, numbers, and underscores.".to_string(),
        );
    }

    let sha1_hex = format!("{:x}", Sha1::digest(name.to_lowercase().as_bytes()));
    let id = format!("local-{}", &sha1_hex[..12.min(sha1_hex.len())]);

    let mut state = load_accounts_state(config_dir);
    if let Some(existing) = state.accounts.iter().find(|a| a.id == id) {
        state.active_account_id = Some(existing.id.clone());
        save_accounts_state(config_dir, &state);
        return Ok(list_accounts(config_dir));
    }

    let uuid = generate_offline_uuid(name);
    let new_acc = Account {
        id: id.clone(),
        username: name.to_string(),
        uuid,
        account_type: "local".to_string(),
        authenticated_online: false,
        added_at: chrono::Utc::now().to_rfc3339(),
        active_skin_slot: "slot-1".to_string(),
        skin_slots: default_skin_slots(),
        access_token: None,
        ms_refresh_token: None,
        expires_at: None,
        skin_url: None,
        last_used: None,
    };

    state.accounts.insert(0, new_acc);
    state.active_account_id = Some(id);
    save_accounts_state(config_dir, &state);

    Ok(list_accounts(config_dir))
}

pub fn remove_account(config_dir: &str, id: &str) -> Result<AccountsResponse, String> {
    let mut state = load_accounts_state(config_dir);
    let idx = state
        .accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| format!("Account not found: {}", id))?;

    state.accounts.remove(idx);
    if state.active_account_id.as_deref() == Some(id) {
        state.active_account_id = state.accounts.first().map(|a| a.id.clone());
    }
    save_accounts_state(config_dir, &state);
    Ok(list_accounts(config_dir))
}

pub fn add_skin_slot(config_dir: &str, name: Option<&str>) -> Result<AccountsResponse, String> {
    let mut state = load_accounts_state(config_dir);
    let active_id = state
        .active_account_id
        .clone()
        .or_else(|| state.accounts.first().map(|a| a.id.clone()))
        .ok_or_else(|| "No active account found.".to_string())?;

    let acc = state
        .accounts
        .iter_mut()
        .find(|a| a.id == active_id)
        .ok_or_else(|| "Active account not found.".to_string())?;

    if acc.skin_slots.len() >= 5 {
        return Err("Maximum 5 skin slots per account.".to_string());
    }

    let slot_num = acc.skin_slots.len() + 1;
    let presets = [
        "crimson-phantom",
        "obsidian-knight",
        "ash-valkyrie",
        "blood-monarch",
    ];
    let new_slot = SkinSlot {
        id: format!("slot-{}", chrono::Utc::now().timestamp_millis()),
        name: name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Slot {}", slot_num)),
        model: "slim".to_string(),
        preset: presets[(slot_num - 1) % presets.len()].to_string(),
        cape_preset: Some("inex-crest".to_string()),
        custom_skin_data_url: None,
        active: false,
    };

    acc.skin_slots.push(new_slot);
    save_accounts_state(config_dir, &state);
    Ok(list_accounts(config_dir))
}

pub fn update_skin_slot(
    config_dir: &str,
    slot_id: &str,
    patch: serde_json::Value,
) -> Result<AccountsResponse, String> {
    let mut state = load_accounts_state(config_dir);
    let active_id = state
        .active_account_id
        .clone()
        .or_else(|| state.accounts.first().map(|a| a.id.clone()))
        .ok_or_else(|| "No active account found.".to_string())?;

    let acc = state
        .accounts
        .iter_mut()
        .find(|a| a.id == active_id)
        .ok_or_else(|| "Active account not found.".to_string())?;

    let slot = acc
        .skin_slots
        .iter_mut()
        .find(|s| s.id == slot_id)
        .ok_or_else(|| format!("Skin slot not found: {}", slot_id))?;

    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            slot.name = trimmed.to_string();
        }
    }

    if let Some(model) = patch.get("model").and_then(|v| v.as_str()) {
        if model == "classic" || model == "slim" {
            slot.model = model.to_string();
        }
    }

    if let Some(preset) = patch.get("preset").and_then(|v| v.as_str()) {
        slot.preset = preset.to_string();
    }

    if let Some(cape) = patch.get("capePreset").and_then(|v| v.as_str()) {
        slot.cape_preset = Some(cape.to_string());
    }

    if let Some(skin_url) = patch.get("customSkinDataUrl") {
        if let Some(url_str) = skin_url.as_str() {
            if !url_str.starts_with("data:image/png;base64,") {
                return Err("Skin texture must be a valid PNG image.".to_string());
            }
            slot.custom_skin_data_url = Some(url_str.to_string());
        } else if skin_url.is_null() {
            slot.custom_skin_data_url = None;
        }
    }

    if let Some(active) = patch.get("active").and_then(|v| v.as_bool()) {
        if active {
            for s in &mut acc.skin_slots {
                s.active = s.id == slot_id;
            }
            acc.active_skin_slot = slot_id.to_string();
        }
    }

    save_accounts_state(config_dir, &state);
    Ok(list_accounts(config_dir))
}

pub fn delete_skin_slot(config_dir: &str, slot_id: &str) -> Result<AccountsResponse, String> {
    let mut state = load_accounts_state(config_dir);
    let active_id = state
        .active_account_id
        .clone()
        .or_else(|| state.accounts.first().map(|a| a.id.clone()))
        .ok_or_else(|| "No active account found.".to_string())?;

    let acc = state
        .accounts
        .iter_mut()
        .find(|a| a.id == active_id)
        .ok_or_else(|| "Active account not found.".to_string())?;

    if acc.skin_slots.len() <= 1 {
        return Err("Cannot delete the only skin slot.".to_string());
    }

    let idx = acc
        .skin_slots
        .iter()
        .position(|s| s.id == slot_id)
        .ok_or_else(|| format!("Skin slot not found: {}", slot_id))?;

    let was_active = acc.skin_slots[idx].active;
    acc.skin_slots.remove(idx);

    if was_active && !acc.skin_slots.is_empty() {
        acc.skin_slots[0].active = true;
        acc.active_skin_slot = acc.skin_slots[0].id.clone();
    }

    save_accounts_state(config_dir, &state);
    Ok(list_accounts(config_dir))
}

// ---------------------------------------------------------------------------------------------
// active account + local-only skin (port of getActiveAccount / applyLocalCosmeticsToGameDir)
// ---------------------------------------------------------------------------------------------

pub fn get_active_account(config_dir: &str) -> Option<Account> {
    let state = load_accounts_state(config_dir);
    let id = state.active_account_id.clone();
    state
        .accounts
        .iter()
        .find(|a| Some(&a.id) == id.as_ref())
        .cloned()
        .or_else(|| state.accounts.first().cloned())
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buf = ((buf << 6) | v as u32) & 0x00FF_FFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// The active account's custom skin (PNG bytes + model), or None when it uses a preset/default skin.
fn active_custom_skin(config_dir: &str) -> Option<(Vec<u8>, String)> {
    let acc = get_active_account(config_dir)?;
    let slot = acc
        .skin_slots
        .iter()
        .find(|s| s.id == acc.active_skin_slot)
        .or_else(|| acc.skin_slots.iter().find(|s| s.active))
        .or_else(|| acc.skin_slots.first())?;
    let data = slot.custom_skin_data_url.as_ref()?;
    if !data.starts_with("data:image/png;base64,") {
        return None;
    }
    let buf = base64_decode(data.split(',').nth(1)?)?;
    if buf.len() < 8 || buf.len() > 1024 * 1024 || buf[0..4] != [0x89, 0x50, 0x4e, 0x47] {
        return None;
    }
    let model = if slot.model.to_lowercase() == "classic" { "classic" } else { "slim" };
    Some((buf, model.to_string()))
}

pub struct Cosmetics {
    pub skin_file: Option<String>,
    pub model: String,
}

fn remove_nameplate_pack_from_options(game_dir: &Path) {
    let options_path = game_dir.join("options.txt");
    let raw = match fs::read_to_string(&options_path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let ids = [
        "file/INEX-Nameplate",
        "INEX-Nameplate",
        "file/INEX-Local-Cosmetics",
        "INEX-Local-Cosmetics",
    ];
    let mut changed = false;
    let mut lines: Vec<String> = Vec::new();
    for raw_line in raw.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        let mut replaced: Option<String> = None;
        if let Some(sep) = line.find(':') {
            let key = &line[..sep];
            if key == "resourcePacks" || key == "incompatibleResourcePacks" {
                if let Ok(Value::Array(packs)) = serde_json::from_str::<Value>(&line[sep + 1..]) {
                    let filtered: Vec<Value> = packs
                        .iter()
                        .filter(|p| !p.as_str().map(|s| ids.contains(&s)).unwrap_or(false))
                        .cloned()
                        .collect();
                    if filtered.len() != packs.len() {
                        changed = true;
                        replaced = Some(format!("{}:{}", key, Value::Array(filtered)));
                    }
                }
            }
        }
        lines.push(replaced.unwrap_or_else(|| line.to_string()));
    }
    if changed {
        let _ = fs::write(&options_path, lines.join("\n"));
    }
}

/// Local-only skin: writes the player's own skin to <gameDir>/inex-self-skin.png (nobody else sees it).
pub fn apply_local_cosmetics_to_game_dir(
    config_dir: &str,
    game_dir: &str,
    enable_skin_sync: bool,
) -> Result<Cosmetics, String> {
    let mut result = Cosmetics { skin_file: None, model: "slim".to_string() };
    if game_dir.is_empty() {
        return Ok(result);
    }
    fs::create_dir_all(game_dir).map_err(|e| e.to_string())?;
    let gd = Path::new(game_dir);

    let _ = fs::remove_dir_all(gd.join("resourcepacks").join("INEX-Local-Cosmetics"));
    let _ = fs::remove_dir_all(gd.join("resourcepacks").join("INEX-Nameplate"));
    for f in ["inex-cosmetics-override.jar", "inex-cosmetics-state.json", "inex-cosmetics-settings.txt"] {
        let _ = fs::remove_file(gd.join(f));
    }
    remove_nameplate_pack_from_options(gd);

    let skin_file = gd.join("inex-self-skin.png");
    let skin = if enable_skin_sync { active_custom_skin(config_dir) } else { None };
    match skin {
        None => {
            let _ = fs::remove_file(&skin_file);
            Ok(result)
        }
        Some((png, model)) => {
            let tmp = gd.join("inex-self-skin.png.tmp");
            fs::write(&tmp, png).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &skin_file).map_err(|e| e.to_string())?;
            result.skin_file = Some(skin_file.to_string_lossy().to_string());
            result.model = model;
            Ok(result)
        }
    }
}
