//! Native (OS-level) watcher for the content folders of the profile that is open in the UI.
//! No polling: the thread sleeps until Windows reports a change in mods / resourcepacks / shaderpacks / datapacks,
//! waits until the burst of events is over (a big jar that is still being copied) and tells the UI once.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::path::Path;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static WATCHER: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();

/// Starts watching `game_dir` for `profile_id`. Replaces (and thereby stops) the previous watcher.
pub fn watch_profile(app: AppHandle, profile_id: String, game_dir: String) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<()>();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                // reads of a file (Access) must not count, our own hashing would retrigger itself
                if matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)) {
                    let _ = tx.send(());
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Could not start the folder watcher: {e}"))?;

    for folder in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
        let dir = Path::new(&game_dir).join(folder);
        let _ = std::fs::create_dir_all(&dir);
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }

    std::thread::spawn(move || {
        // blocks until the OS reports something; ends by itself when the watcher is dropped (sender gone)
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
            let _ = app.emit(
                "inex-event",
                json!({ "channel": "event:content-changed", "data": { "profileId": profile_id } }),
            );
        }
    });

    let slot = WATCHER.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}
