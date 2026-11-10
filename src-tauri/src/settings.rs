use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const VALID_CLOSE_BEHAVIORS: [&str; 3] = ["keep-open", "minimize", "close"];

// ---- tiny helpers that mimic JavaScript's Boolean() / Number() / String.trim() used by x_client ----

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn as_f64(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        _ => None,
    }
}

fn str_nonempty(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn resolve_path(s: &str) -> String {
    let p = PathBuf::from(s);
    if p.is_absolute() {
        p.to_string_lossy().to_string()
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(p).to_string_lossy().to_string()
    } else {
        s.to_string()
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// x_client: max(16384, min(65536, total system RAM in MB)).  (It used to be a hard-coded 16384.)
pub fn detect_max_ram_mb() -> u64 {
    let total = crate::system::get_system_memory()
        .get("totalMb")
        .and_then(|v| v.as_u64())
        .unwrap_or(16384);
    total.clamp(16384, 65536)
}

pub struct SettingsManager {
    config_dir: PathBuf,
    settings_file: PathBuf,
}

impl SettingsManager {
    pub fn new() -> Self {
        let app_data = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        let config_dir = app_data.join("CryoxClient");
        let _ = fs::create_dir_all(&config_dir);
        let settings_file = config_dir.join("settings.json");
        Self {
            config_dir,
            settings_file,
        }
    }

    pub fn defaults(&self) -> Value {
        let app_data = std::env::var("APPDATA").unwrap_or_default();
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let game_data_dir = Path::new(&app_data).join(".cryoxclient");
        let install_dir = Path::new(&local_app_data).join("CryoxClient");
        let java_dir = self.config_dir.join("runtimes");

        json!({
            "fullscreen": false,
            "windowWidth": 1280,
            "windowHeight": 720,
            "defaultRamMB": 4096,
            "maxRamMB": detect_max_ram_mb(),
            "concurrentDownloads": 8,
            "closeBehavior": "keep-open",
            "autoJavaProvision": true,
            "showSnapshots": false,
            "enableSkinSync": true,
            "discordRpcEnabled": true,
            "discordClientId": "1568590021332570122",
            "discordStatusText": "CRYOX CLIENT",
            "glassIntensity": 24,
            "customLogoDataUrl": "",
            "uiTheme": "default",
            "wallpaper": "",
            "matrixShape": "round",
            "matrixHlStyle": "solid",
            "matrixHlColor": "#ffffff",
            "gameDataDir": game_data_dir.to_string_lossy(),
            "installDir": install_dir.to_string_lossy(),
            "configDir": self.config_dir.to_string_lossy(),
            "javaDir": java_dir.to_string_lossy(),
            "customJavaPath": "",
            "defaultJavaRuntime": "auto",
            "activeHudJar": "",
            "hudConfig": {
                "showNametagLogo": true
            },
            "jvmExtraArgs": "-XX:+IgnoreUnrecognizedVMOptions -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M"
        })
    }

    /// Port of SettingsManager._validate() from x_client: every value is clamped / normalised.
    fn validate(&self, input: &Value) -> Value {
        let defs = self.defaults();
        let mut m: Map<String, Value> = defs.as_object().cloned().unwrap_or_default();
        if let Some(obj) = input.as_object() {
            for (k, v) in obj {
                m.insert(k.clone(), v.clone());
            }
        }
        let mv = Value::Object(m.clone());
        let g = |k: &str| mv.get(k);
        let mut out = m.clone();

        out.insert("fullscreen".into(), json!(truthy(g("fullscreen"))));

        let w = as_f64(g("windowWidth"))
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(640.0, 7680.0) as u64)
            .unwrap_or(1280);
        out.insert("windowWidth".into(), json!(w));

        let h = as_f64(g("windowHeight"))
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(480.0, 4320.0) as u64)
            .unwrap_or(720);
        out.insert("windowHeight".into(), json!(h));

        let max_ram = detect_max_ram_mb();
        out.insert("maxRamMB".into(), json!(max_ram));

        let ram = as_f64(g("defaultRamMB"))
            .filter(|f| f.is_finite())
            .map(|f| ((f / 256.0).round() * 256.0).clamp(1024.0, max_ram as f64) as u64)
            .unwrap_or(4096);
        out.insert("defaultRamMB".into(), json!(ram));

        let conc = as_f64(g("concurrentDownloads"))
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(1.0, 32.0) as u64)
            .unwrap_or(8);
        out.insert("concurrentDownloads".into(), json!(conc));

        let cb = g("closeBehavior").and_then(|v| v.as_str()).unwrap_or("");
        let cb = if VALID_CLOSE_BEHAVIORS.contains(&cb) { cb } else { "keep-open" };
        out.insert("closeBehavior".into(), json!(cb));

        out.insert("autoJavaProvision".into(), json!(truthy(g("autoJavaProvision"))));
        out.insert("showSnapshots".into(), json!(truthy(g("showSnapshots"))));
        out.insert("enableSkinSync".into(), json!(truthy(g("enableSkinSync"))));
        out.insert("discordRpcEnabled".into(), json!(truthy(g("discordRpcEnabled"))));

        // the Discord application id is fixed by the launcher, not by the user
        if let Some(id) = defs.get("discordClientId") {
            out.insert("discordClientId".into(), id.clone());
        }
        let status_text = str_nonempty(g("discordStatusText")).unwrap_or_else(|| {
            defs.get("discordStatusText")
                .and_then(|v| v.as_str())
                .unwrap_or("CRYOX CLIENT")
                .to_string()
        });
        out.insert("discordStatusText".into(), json!(status_text));

        let glass = as_f64(g("glassIntensity"))
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(8.0, 40.0) as u64)
            .unwrap_or(24);
        out.insert("glassIntensity".into(), json!(glass));

        let logo = g("customLogoDataUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        out.insert("customLogoDataUrl".into(), json!(logo));

        let theme = if g("uiTheme").and_then(|v| v.as_str()) == Some("nothing") { "nothing" } else { "default" };
        out.insert("uiTheme".into(), json!(theme));
        let shape = if g("matrixShape").and_then(|v| v.as_str()) == Some("default") { "default" } else { "round" };
        out.insert("matrixShape".into(), json!(shape));
        let hl_style = if g("matrixHlStyle").and_then(|v| v.as_str()) == Some("glass") { "glass" } else { "solid" };
        out.insert("matrixHlStyle".into(), json!(hl_style));
        let hl_color = match g("matrixHlColor").and_then(|v| v.as_str()) {
            Some(c) if is_hex_color(c) => c.to_lowercase(),
            _ => "#ffffff".to_string(),
        };
        out.insert("matrixHlColor".into(), json!(hl_color));

        // one wallpaper for Play + Server screens; older versions had two keys -> migrate and drop them
        let wallpaper = if let Some(w) = g("wallpaper").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            w.to_string()
        } else if let Some(w) = g("wallpaperHome").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            w.to_string()
        } else {
            g("wallpaperServer").and_then(|v| v.as_str()).unwrap_or("").to_string()
        };
        out.insert("wallpaper".into(), json!(wallpaper));
        out.remove("wallpaperHome");
        out.remove("wallpaperServer");

        for key in ["gameDataDir", "installDir", "configDir", "javaDir"] {
            if let Some(p) = str_nonempty(g(key)) {
                out.insert(key.into(), json!(resolve_path(&p)));
            }
        }

        let cjp = g("customJavaPath").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        out.insert("customJavaPath".into(), json!(cjp));
        let djr = str_nonempty(g("defaultJavaRuntime")).unwrap_or_else(|| "auto".to_string());
        out.insert("defaultJavaRuntime".into(), json!(djr));
        let jvm = match g("jvmExtraArgs").and_then(|v| v.as_str()) {
            Some(s) => s.trim().to_string(),
            None => defs.get("jvmExtraArgs").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        };
        out.insert("jvmExtraArgs".into(), json!(jvm));

        let active_hud = g("activeHudJar").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        out.insert("activeHudJar".into(), json!(active_hud));

        let show_logo = g("hudConfig")
            .and_then(|v| v.as_object())
            .and_then(|o| o.get("showNametagLogo"))
            .map(|v| !matches!(v, Value::Bool(false)))
            .unwrap_or(true);
        out.insert("hudConfig".into(), json!({ "showNametagLogo": show_logo }));

        Value::Object(out)
    }

    /// Port of SettingsManager._ensureDirectories().
    fn ensure_directories(&self, s: &Value) {
        let get = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let game = get("gameDataDir");
        let mut dirs: Vec<PathBuf> = vec![
            self.config_dir.clone(),
            PathBuf::from(&game),
            PathBuf::from(get("installDir")),
            PathBuf::from(get("javaDir")),
        ];
        if !game.is_empty() {
            let g = PathBuf::from(&game);
            dirs.push(g.join("versions"));
            dirs.push(g.join("libraries"));
            dirs.push(g.join("assets").join("indexes"));
            dirs.push(g.join("assets").join("objects"));
            dirs.push(g.join("profiles"));
        }
        dirs.push(self.config_dir.join("cache"));
        dirs.push(self.config_dir.join("skins"));
        dirs.push(self.config_dir.join("hud-mods"));
        for d in dirs {
            if !d.as_os_str().is_empty() {
                let _ = fs::create_dir_all(d);
            }
        }
    }

    pub fn get_settings(&self) -> Value {
        if self.settings_file.exists() {
            if let Ok(content) = fs::read_to_string(&self.settings_file) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                    let mut validated = self.validate(&parsed);
                    let gd = validated.get("gameDataDir").and_then(|v| v.as_str()).unwrap_or("")
                        .trim_end_matches(|c| c == '\\' || c == '/').to_lowercase();
                    if gd.ends_with(".fastclient") || gd.ends_with(".xclient") || gd.ends_with(".inexclient") {
                        let app_data = std::env::var("APPDATA").unwrap_or_default();
                        let fixed = Path::new(&app_data).join(".cryoxclient");
                        let _ = fs::create_dir_all(&fixed);
                        if let Some(o) = validated.as_object_mut() {
                            o.insert("gameDataDir".into(), json!(fixed.to_string_lossy()));
                        }
                    }
                    if validated != parsed {
                        self.ensure_directories(&validated);
                        let _ = self.save(&validated);
                    }
                    return validated;
                }
            }
        }
        let initial = self.validate(&self.defaults());
        self.ensure_directories(&initial);
        let _ = self.save(&initial);
        initial
    }

    pub fn update_settings(&self, partial: &Value) -> Value {
        let current = self.get_settings();
        let mut merged = current.as_object().cloned().unwrap_or_default();
        if let Some(part_obj) = partial.as_object() {
            for (k, v) in part_obj {
                merged.insert(k.clone(), v.clone());
            }
        }
        let validated = self.validate(&Value::Object(merged));
        self.ensure_directories(&validated);
        let _ = self.save(&validated);
        validated
    }

    pub fn reset_settings(&self) -> Value {
        let defs = self.validate(&self.defaults());
        self.ensure_directories(&defs);
        let _ = self.save(&defs);
        defs
    }

    fn save(&self, val: &Value) -> Result<(), std::io::Error> {
        let _ = fs::create_dir_all(&self.config_dir);
        let s = serde_json::to_string_pretty(val).unwrap_or_default();
        let tmp = self.settings_file.with_extension("json.tmp");
        fs::write(&tmp, s)?;
        fs::rename(&tmp, &self.settings_file)
    }
}
