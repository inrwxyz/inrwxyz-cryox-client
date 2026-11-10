use serde_json::{json, Value};
use std::time::Duration;

pub const MS_CLIENT_ID: &str = "00000000402b5328";
pub const MS_REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";
pub const MS_AUTHORIZE_URL: &str = "https://login.live.com/oauth20_authorize.srf";
pub const MS_TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
pub const MS_SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";

pub fn get_microsoft_login_url() -> String {
    let state = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&prompt=select_account&state={}",
        MS_AUTHORIZE_URL,
        MS_CLIENT_ID,
        urlencoding_encode(MS_REDIRECT_URI),
        urlencoding_encode(MS_SCOPE),
        state
    )
}

pub async fn complete_microsoft_login(
    redirect_url: &str,
    config_dir: &str,
) -> Result<Value, String> {
    let parsed = redirect_url
        .parse::<tauri::Url>()
        .map_err(|e| format!("Invalid redirect URL: {e}"))?;

    let mut code = None;
    for (k, v) in parsed.query_pairs() {
        if k == "code" {
            code = Some(v.to_string());
            break;
        } else if k == "error" {
            if v == "access_denied" {
                return Err("Microsoft login cancelled.".to_string());
            }
            return Err(format!("Microsoft sign-in error: {v}"));
        }
    }

    let auth_code = code.ok_or_else(|| "Missing authorization code in redirect URL".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Exchange code for MS OAuth token
    let body_params = format!(
        "client_id={}&grant_type=authorization_code&code={}&redirect_uri={}&scope={}",
        urlencoding_encode(MS_CLIENT_ID),
        urlencoding_encode(&auth_code),
        urlencoding_encode(MS_REDIRECT_URI),
        urlencoding_encode(MS_SCOPE),
    );
    let token_res = client
        .post(MS_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body_params)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Microsoft OAuth service: {e}"))?;

    if !token_res.status().is_success() {
        return Err(format!(
            "Microsoft sign-in token request returned HTTP {}",
            token_res.status()
        ));
    }

    let token_data: Value = token_res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from Microsoft token response: {e}"))?;

    let ms_access_token = token_data
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Microsoft did not return an access token".to_string())?;

    let refresh_token = token_data
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let expires_in = token_data
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(86400);

    // 2. Xbox Live authentication
    let xbl_res = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": ms_access_token
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| format!("Xbox Live connection failed: {e}"))?;

    if !xbl_res.status().is_success() {
        return Err(format!(
            "Xbox Live authentication returned HTTP {}",
            xbl_res.status()
        ));
    }

    let xbl_data: Value = xbl_res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from Xbox Live: {e}"))?;

    let xbl_token = xbl_data
        .get("Token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing Xbox Live Token".to_string())?;

    let user_hash = xbl_data
        .get("DisplayClaims")
        .and_then(|c| c.get("xui"))
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|f| f.get("uhs"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| "Missing Xbox Live user hash".to_string())?;

    // 3. XSTS authorization
    let xsts_res = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbl_token]
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| format!("XSTS connection failed: {e}"))?;

    if !xsts_res.status().is_success() {
        let err_body: Value = xsts_res.json().await.unwrap_or(json!({}));
        let xerr = err_body.get("XErr").and_then(|x| x.as_u64()).unwrap_or(0);
        return Err(match xerr {
            2148916227 => "This Xbox account is banned from Xbox services.".to_string(),
            2148916233 => "This Microsoft account has no Xbox profile. Sign in once at minecraft.net or xbox.com.".to_string(),
            2148916238 => "This is a child account. An adult must add it to a Microsoft Family.".to_string(),
            _ => format!("Xbox XSTS sign-in failed (code: {xerr})"),
        });
    }

    let xsts_data: Value = xsts_res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from XSTS: {e}"))?;

    let xsts_token = xsts_data
        .get("Token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing XSTS Token".to_string())?;

    // 4. Minecraft Services login
    let identity_token = format!("XBL3.0 x={};{}", user_hash, xsts_token);
    let mc_res = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&json!({ "identityToken": identity_token }))
        .send()
        .await
        .map_err(|e| format!("Minecraft authentication service connection failed: {e}"))?;

    if !mc_res.status().is_success() {
        return Err(format!(
            "Minecraft Services authentication returned HTTP {}",
            mc_res.status()
        ));
    }

    let mc_data: Value = mc_res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from Minecraft Services: {e}"))?;

    let mc_access_token = mc_data
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Minecraft Services did not return an access token".to_string())?;

    // 5. Fetch Minecraft Profile
    let prof_res = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(mc_access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Minecraft profile: {e}"))?;

    if !prof_res.status().is_success() {
        return Err("This Microsoft account does not own Minecraft Java Edition.".to_string());
    }

    let prof_data: Value = prof_res
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from Minecraft profile: {e}"))?;

    let username = prof_data
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| "Missing Minecraft username".to_string())?;
    let raw_uuid = prof_data
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| "Missing Minecraft UUID".to_string())?;

    // Format UUID with hyphens if needed
    let uuid_str = if raw_uuid.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &raw_uuid[0..8],
            &raw_uuid[8..12],
            &raw_uuid[12..16],
            &raw_uuid[16..20],
            &raw_uuid[20..32]
        )
    } else {
        raw_uuid.to_string()
    };

    let skin_url = prof_data
        .get("skins")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.iter().find(|sk| sk.get("state").and_then(|st| st.as_str()) == Some("ACTIVE")))
        .and_then(|sk| sk.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();

    let now_ms = chrono::Utc::now().timestamp_millis();
    let account_id = format!("ms-{}", raw_uuid);

    let ms_account = crate::accounts::Account {
        id: account_id.clone(),
        username: username.to_string(),
        uuid: uuid_str,
        account_type: "microsoft".to_string(),
        authenticated_online: true,
        added_at: chrono::Utc::now().to_rfc3339(),
        active_skin_slot: "slot-1".to_string(),
        skin_slots: crate::accounts::default_skin_slots(),
        access_token: Some(mc_access_token.to_string()),
        ms_refresh_token: Some(refresh_token),
        expires_at: Some(now_ms + (expires_in as i64 * 1000)),
        skin_url: if skin_url.is_empty() { None } else { Some(skin_url) },
        last_used: Some(chrono::Utc::now().to_rfc3339()),
    };

    // Save account in accounts.json
    let mut state = crate::accounts::load_accounts_state(config_dir);
    // Remove if already exists
    state.accounts.retain(|a| a.id != account_id);
    state.accounts.insert(0, ms_account);
    state.active_account_id = Some(account_id);
    crate::accounts::save_accounts_state(config_dir, &state);

    Ok(json!(crate::accounts::list_accounts(config_dir)))
}

fn urlencoding_encode(s: &str) -> String {
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

// ---------------------------------------------------------------------------------------------
// token renewal (port of AccountManager.ensureFreshActiveToken)
// ---------------------------------------------------------------------------------------------

const MS_REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
const MS_RELOGIN_MESSAGE: &str =
    "Your Microsoft sign-in has expired. Log out of this account and log in with Microsoft again.";

/// Xbox Live -> XSTS -> Minecraft Services. Returns (minecraft access token, seconds until it expires).
async fn authenticate_minecraft(client: &reqwest::Client, ms_access_token: &str) -> Result<(String, i64), String> {
    let xbl: Value = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": ms_access_token },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|_| "Could not reach Xbox Live. Check your internet connection and try again.".to_string())?
        .error_for_status()
        .map_err(|e| format!("Xbox Live authentication failed ({e})."))?
        .json()
        .await
        .map_err(|_| "Xbox Live returned an unexpected response.".to_string())?;
    let xbl_token = xbl.get("Token").and_then(|v| v.as_str()).ok_or("Xbox Live returned an unexpected response.")?;
    let uhs = xbl
        .get("DisplayClaims")
        .and_then(|c| c.get("xui"))
        .and_then(|x| x.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("uhs"))
        .and_then(|u| u.as_str())
        .ok_or("Xbox Live returned an unexpected response.")?;

    let xsts_res = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|_| "Could not reach Xbox Live. Check your internet connection and try again.".to_string())?;
    if !xsts_res.status().is_success() {
        let body: Value = xsts_res.json().await.unwrap_or(json!({}));
        let xerr = body.get("XErr").and_then(|x| x.as_u64()).unwrap_or(0);
        return Err(match xerr {
            2148916227 => "This Xbox account is banned from Xbox services, so it cannot be used to sign in.".to_string(),
            2148916233 => "This Microsoft account has no Xbox profile yet. Sign in once at minecraft.net (or xbox.com) to create it, then try again.".to_string(),
            2148916235 => "Xbox Live is not available in the country or region of this Microsoft account.".to_string(),
            2148916236 | 2148916237 => "This Microsoft account needs adult verification on the Xbox website before it can sign in.".to_string(),
            2148916238 => "This is a child account. An adult must add it to a Microsoft Family before it can sign in.".to_string(),
            0 => "Xbox sign-in failed.".to_string(),
            n => format!("Xbox sign-in failed (XSTS error {n})."),
        });
    }
    let xsts: Value = xsts_res.json().await.map_err(|_| "Xbox Live returned an unexpected response.".to_string())?;
    let xsts_token = xsts.get("Token").and_then(|v| v.as_str()).ok_or("Xbox Live returned an unexpected response.")?;

    let mc_res = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .header("Accept", "application/json")
        .json(&json!({ "identityToken": format!("XBL3.0 x={};{}", uhs, xsts_token) }))
        .send()
        .await
        .map_err(|_| "Could not reach Minecraft Services. Check your internet connection and try again.".to_string())?;
    if !mc_res.status().is_success() {
        return Err(format!("Minecraft Services authentication failed (HTTP {}).", mc_res.status().as_u16()));
    }
    let mc: Value = mc_res.json().await.map_err(|_| "Minecraft Services returned an unexpected response.".to_string())?;
    let token = mc
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Minecraft Services returned an unexpected response.")?
        .to_string();
    let expires_in = mc.get("expires_in").and_then(|v| v.as_i64()).filter(|n| *n > 0).unwrap_or(86400);
    Ok((token, expires_in))
}

/// Renews the active Microsoft account's Minecraft token when it has <= 5 minutes left (no-op for local accounts).
pub async fn ensure_fresh_active_token(config_dir: &str) -> Result<(), String> {
    let acc = match crate::accounts::get_active_account(config_dir) {
        Some(a) if a.account_type == "microsoft" => a,
        _ => return Ok(()),
    };
    let has_token = acc.access_token.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
    let refresh = acc.ms_refresh_token.clone().filter(|r| !r.is_empty());
    if !has_token && refresh.is_none() {
        return Err(MS_RELOGIN_MESSAGE.to_string());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let exp = acc.expires_at.unwrap_or(0);
    if has_token && exp - now > MS_REFRESH_MARGIN_MS {
        return Ok(());
    }
    let refresh = refresh.ok_or_else(|| MS_RELOGIN_MESSAGE.to_string())?;
    let still_valid = has_token && exp - now > 0;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let body = format!(
        "client_id={}&grant_type=refresh_token&refresh_token={}&redirect_uri={}&scope={}",
        urlencoding_encode(MS_CLIENT_ID),
        urlencoding_encode(&refresh),
        urlencoding_encode(MS_REDIRECT_URI),
        urlencoding_encode(MS_SCOPE),
    );
    let res = match client
        .post(MS_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            if still_valid {
                return Ok(());
            }
            return Err("Could not reach Microsoft sign-in. Check your internet connection and try again.".to_string());
        }
    };
    let status = res.status();
    if !status.is_success() {
        if status.as_u16() == 400 || status.as_u16() == 401 {
            return Err(MS_RELOGIN_MESSAGE.to_string());
        }
        if still_valid {
            return Ok(());
        }
        return Err(format!("Microsoft is temporarily unavailable (HTTP {}).", status.as_u16()));
    }
    let data: Value = res.json().await.map_err(|_| "Microsoft returned an unexpected response.".to_string())?;
    let ms_access = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Microsoft returned an unexpected response.")?
        .to_string();

    // Microsoft hands out a new refresh token every time: keep it right away, before the Xbox steps.
    if let Some(new_refresh) = data.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        let mut state = crate::accounts::load_accounts_state(config_dir);
        if let Some(a) = state.accounts.iter_mut().find(|a| a.id == acc.id) {
            a.ms_refresh_token = Some(new_refresh.to_string());
        }
        crate::accounts::save_accounts_state(config_dir, &state);
    }

    let (mc_token, expires_in) = match authenticate_minecraft(&client, &ms_access).await {
        Ok(v) => v,
        Err(e) => {
            if still_valid {
                return Ok(());
            }
            return Err(e);
        }
    };
    let mut state = crate::accounts::load_accounts_state(config_dir);
    if let Some(a) = state.accounts.iter_mut().find(|a| a.id == acc.id) {
        a.access_token = Some(mc_token);
        a.expires_at = Some(chrono::Utc::now().timestamp_millis() + expires_in * 1000);
    }
    crate::accounts::save_accounts_state(config_dir, &state);
    Ok(())
}
