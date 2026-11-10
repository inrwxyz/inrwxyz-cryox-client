//! Low-end / integrated-GPU friendly Minecraft defaults (port of perfDefaults.js).
//! Runs once per profile (marker file), only when ALL graphics adapters are integrated,
//! and only ADDS options that are missing from options.txt.

use std::fs;
use std::path::Path;
use std::process::Command;

const MARKER: &str = "inex-lowend-defaults.json";

const LOW_END_OPTIONS: [(&str, &str); 11] = [
    ("renderDistance", "6"),
    ("simulationDistance", "6"),
    ("graphicsMode", "0"),
    ("fancyGraphics", "false"),
    ("particles", "2"),
    ("entityShadows", "false"),
    ("ao", "false"),
    ("biomeBlendRadius", "0"),
    ("mipmapLevels", "0"),
    ("cloudStatus", "\"off\""),
    ("entityDistanceScaling", "0.75"),
];

pub struct PerfResult {
    pub applied: bool,
    pub gpus: Vec<String>,
    pub added: Vec<String>,
}

fn detect_gpu_names() -> Vec<String> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_VideoController).Name",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn is_discrete(name: &str) -> bool {
    let n = name.to_lowercase();
    ["nvidia", "geforce", "quadro", "rtx", "gtx", "radeon rx", "radeon pro", "arc ", "firepro", "titan"]
        .iter()
        .any(|k| n.contains(k))
        || n.ends_with(" arc")
}

fn is_fake_adapter(name: &str) -> bool {
    let n = name.to_lowercase();
    ["microsoft basic", "remote", "virtual", "parsec", "displaylink", "meta virtual"]
        .iter()
        .any(|k| n.contains(k))
}

fn is_integrated_only(names: &[String]) -> bool {
    let real: Vec<&String> = names.iter().filter(|n| !is_fake_adapter(n)).collect();
    !real.is_empty() && !real.iter().any(|n| is_discrete(n))
}

pub fn apply_low_end_defaults(game_dir: &str) -> PerfResult {
    let mut result = PerfResult { applied: false, gpus: Vec::new(), added: Vec::new() };
    if game_dir.is_empty() {
        return result;
    }
    let marker = Path::new(game_dir).join(MARKER);
    if marker.exists() {
        return result;
    }
    let _ = fs::create_dir_all(game_dir);
    let gpus = detect_gpu_names();
    let integrated = is_integrated_only(&gpus);
    result.gpus = gpus.clone();

    if integrated {
        let options_path = Path::new(game_dir).join("options.txt");
        let text = fs::read_to_string(&options_path).unwrap_or_default();
        let have: std::collections::HashSet<String> = text
            .lines()
            .map(|l| l.split(':').next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let mut lines: Vec<String> = Vec::new();
        for (k, v) in LOW_END_OPTIONS.iter() {
            if !have.contains(*k) {
                lines.push(format!("{k}:{v}"));
                result.added.push(k.to_string());
            }
        }
        if !lines.is_empty() {
            let base = if text.trim().is_empty() {
                String::new()
            } else {
                format!("{}\n", text.trim_end())
            };
            let _ = fs::write(&options_path, format!("{}{}\n", base, lines.join("\n")));
        }
        result.applied = true;
    }

    let _ = fs::write(
        &marker,
        serde_json::to_string_pretty(&serde_json::json!({
            "at": chrono::Utc::now().to_rfc3339(),
            "gpus": gpus,
            "integrated": integrated,
            "added": result.added
        }))
        .unwrap_or_default(),
    );
    result
}
