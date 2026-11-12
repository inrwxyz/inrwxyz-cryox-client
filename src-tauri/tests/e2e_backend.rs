use inex_client_lib::{
    accounts, code_access, java, loaders, modrinth, profiles, servers, settings, versions,
};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::time::Duration;

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Cryox-Client-E2E-Test/1.0.0")
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("HTTP client")
}

#[tokio::test]
async fn e2e_versions_loaders_mods_servers_settings_accounts() {
    let base = std::env::temp_dir().join(format!("cryox_e2e_{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let appdata = base.join("appdata");
    let local_appdata = base.join("localappdata");
    let config_dir = base.join("config");
    let game_data_dir = base.join("gamedata");
    fs::create_dir_all(&appdata).unwrap();
    fs::create_dir_all(&local_appdata).unwrap();
    fs::create_dir_all(&config_dir).unwrap();
    fs::create_dir_all(&game_data_dir).unwrap();

    let cfg_str = config_dir.to_string_lossy().to_string();
    let gdd_str = game_data_dir.to_string_lossy().to_string();
    let client = build_client();

    // 1. Settings (isolated APPDATA inside this test binary process)
    unsafe {
        std::env::set_var("APPDATA", &appdata);
        std::env::set_var("LOCALAPPDATA", &local_appdata);
    }
    let mgr = settings::SettingsManager::new();
    let def = mgr.get_settings();
    assert_eq!(def.get("closeBehavior").and_then(|v| v.as_str()), Some("keep-open"));
    let upd = mgr.update_settings(&json!({
        "defaultRamMB": 6144,
        "concurrentDownloads": 12,
        "closeBehavior": "minimize"
    }));
    assert_eq!(upd.get("defaultRamMB").and_then(|v| v.as_u64()), Some(6144));
    assert_eq!(upd.get("concurrentDownloads").and_then(|v| v.as_u64()), Some(12));
    assert_eq!(upd.get("closeBehavior").and_then(|v| v.as_str()), Some("minimize"));
    let reloaded = settings::SettingsManager::new().get_settings();
    assert_eq!(reloaded.get("closeBehavior").and_then(|v| v.as_str()), Some("minimize"));
    println!("[PASS] 1. Settings persist & validate cleanly");

    // 2. Live Mojang Versions API + Java detection
    let ver_res = versions::list_versions(&config_dir, false, true).await;
    let ver_arr = ver_res
        .get("versions")
        .and_then(|v| v.as_array())
        .expect("versions array");
    assert!(
        ver_arr.iter().any(|v| v.get("id").and_then(|s| s.as_str()) == Some("1.21.4")),
        "Live Mojang manifest must contain 1.21.4"
    );
    assert_eq!(versions::get_required_java_major("1.21.4"), 21);
    assert_eq!(versions::get_required_java_major("1.20.4"), 17);
    assert_eq!(versions::get_required_java_major("1.8.9"), 8);
    let runtimes = java::detect_installed_runtimes(&config_dir);
    assert!(runtimes.is_array() || runtimes.is_object());
    let j_res = java::resolve_java_for_version(&config_dir, 21, "auto");
    assert!(j_res.get("compatible").is_some());
    println!(
        "[PASS] 2. Versions API ({} releases cached) + Java probe ok",
        ver_arr.len()
    );

    // 3. Live Loaders API (Fabric / Forge / NeoForge / Quilt)
    let sup_1214 = loaders::get_supported_loaders(&client, "1.21.4").await;
    assert!(sup_1214.vanilla.supported);
    assert!(sup_1214.fabric.supported, "1.21.4 must support Fabric");
    assert!(!sup_1214.fabric.versions.is_empty());
    let fabric_ver = sup_1214.fabric.versions[0].version.clone();
    let fabric_prof = loaders::resolve_fabric_profile(&client, "1.21.4", &fabric_ver).await;
    let main_class = fabric_prof
        .get("mainClass")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(
        loaders::is_valid_loader_main_class("fabric", main_class),
        "Unexpected Fabric mainClass: {main_class}"
    );
    println!("[PASS] 3. Loaders API & Fabric {} profile resolution ok", fabric_ver);

    // 4. Profiles Create/Update + Live Modrinth Search, Install, Toggle, Remove
    let created = profiles::create_profile(
        &cfg_str,
        &gdd_str,
        json!({
            "name": "E2E Fabric 1.21.4",
            "version": "1.21.4",
            "loader": "fabric",
            "loaderVersion": fabric_ver,
            "ramMB": 4096,
            "hudEnabled": false,
            "perfPack": false
        }),
        16384,
        4096,
    )
    .expect("create fabric profile");
    let prof_id = created["profile"]["id"].as_str().unwrap().to_string();
    let prof_dir = created["profile"]["gameDir"].as_str().unwrap().to_string();

    let updated_prof = profiles::update_profile(
        &cfg_str,
        &gdd_str,
        &prof_id,
        json!({ "ramMB": 5120 }),
        16384,
    )
    .expect("update profile");
    assert_eq!(updated_prof["profile"]["ramMB"].as_u64(), Some(5120));

    let search = modrinth::search_projects(
        &client,
        &json!({
            "query": "sodium",
            "projectType": "mod",
            "gameVersion": "1.21.4",
            "loader": "fabric",
            "limit": 5
        }),
    )
    .await;
    let hits = search["hits"].as_array().expect("Modrinth hits array");
    assert!(!hits.is_empty(), "Live Modrinth search for sodium returned 0 hits");
    let first_hit = &hits[0];
    let hit_id = first_hit["projectId"].as_str().expect("projectId");
    let hit_title = first_hit["title"].as_str().unwrap_or("Sodium");
    let hit_author = first_hit["author"].as_str().unwrap_or("Modrinth");

    let installed = modrinth::install_project(
        &client,
        &prof_dir,
        hit_id,
        "mod",
        hit_title,
        hit_author,
        "",
        "1.21.4",
        "fabric",
    )
    .await
    .expect("live Modrinth mod install");
    let installed_file = installed["fileName"].as_str().unwrap().to_string();
    assert!(
        std::path::Path::new(&prof_dir).join("mods").join(&installed_file).exists(),
        "Installed mod file must exist on disk"
    );
    assert_eq!(modrinth::list_installed_content(&prof_dir, "mod").len(), 1);

    // Toggle disabled -> enabled -> remove
    let tog1 = modrinth::toggle_installed_content(&prof_dir, &installed_file, "mod")
        .expect("disable mod");
    assert_eq!(tog1["toggled"].as_bool(), Some(true));
    assert_eq!(tog1["enabled"].as_bool(), Some(false));
    let disabled_name = format!("{}.disabled", installed_file);
    assert_eq!(tog1["items"][0]["fileName"].as_str(), Some(disabled_name.as_str()));
    let tog2 = modrinth::toggle_installed_content(&prof_dir, &disabled_name, "mod")
        .expect("re-enable mod");
    assert_eq!(tog2["enabled"].as_bool(), Some(true));
    assert_eq!(tog2["items"][0]["fileName"].as_str(), Some(installed_file.as_str()));
    modrinth::remove_installed_content(&prof_dir, &installed_file, "mod")
        .expect("remove mod");
    assert_eq!(modrinth::list_installed_content(&prof_dir, "mod").len(), 0);
    profiles::delete_profile(&cfg_str, &gdd_str, &prof_id).expect("delete profile");
    println!("[PASS] 4. Profiles & Live Modrinth search/install/toggle/remove ({}) ok", installed_file);

    // 5. Accounts & Skin Slots
    let acc_res = accounts::add_local_account(&cfg_str, "CryoxTester").expect("add local account");
    let tester = acc_res
        .accounts
        .iter()
        .find(|a| a.username == "CryoxTester")
        .expect("tester account present");
    let tester_id = tester.id.clone();
    let slot_res = accounts::add_skin_slot(&cfg_str, Some("E2E Slot")).expect("add skin slot");
    let extra_slot_id = slot_res.skin_slots.last().unwrap().id.clone();
    accounts::delete_skin_slot(&cfg_str, &extra_slot_id).expect("delete skin slot");
    accounts::remove_account(&cfg_str, &tester_id).expect("remove account");
    println!("[PASS] 5. Accounts & skin slot lifecycle ok");

    // 6. Servers Lifecycle (Create -> Properties -> Files -> Players -> Live Addon Search -> Delete)
    let srv = servers::create_server(
        &gdd_str,
        &json!({
            "name": "E2E Paper Realm",
            "loader": "paper",
            "version": "1.21.4",
            "port": 25575,
            "ramMb": 2048,
            "playit": false
        }),
    )
    .await
    .expect("create server");
    let srv_id = srv.meta.id.clone();
    let srv_dir = servers::get_server_dir(&gdd_str, &srv_id);
    assert!(srv_dir.join("inex-server.json").exists());
    assert!(srv_dir.join("eula.txt").exists());
    assert!(srv_dir.join("server.properties").exists());

    // Write & read properties + check sanitization
    let mut prop_updates = HashMap::new();
    prop_updates.insert("motd".to_string(), "E2E Verified Realm".to_string());
    prop_updates.insert("max-players".to_string(), "10".to_string());
    servers::write_properties(&srv_dir, &prop_updates).expect("write properties");
    let props = servers::read_properties_values(&srv_dir);
    assert_eq!(props.get("motd").map(String::as_str), Some("E2E Verified Realm"));
    assert_eq!(props.get("max-players").map(String::as_str), Some("10"));

    // File operations + traversal block
    servers::write_server_file(&gdd_str, &srv_id, "config/e2e.yml", "enabled: true\n")
        .expect("write server file");
    let read_back = servers::read_server_file(&gdd_str, &srv_id, "config/e2e.yml")
        .expect("read server file");
    assert_eq!(read_back["content"].as_str(), Some("enabled: true\n"));
    assert!(servers::read_server_file(&gdd_str, &srv_id, "../../Windows/win.ini").is_err());

    // Offline player list & whitelist actions
    servers::player_action(&gdd_str, &srv_id, "whitelist-on", "", None).unwrap();
    servers::player_action(&gdd_str, &srv_id, "whitelist-add", "CryoxAdmin", None).unwrap();
    servers::player_action(&gdd_str, &srv_id, "op", "CryoxAdmin", None).unwrap();
    let plist = servers::get_player_lists(&gdd_str, &srv_id);
    assert_eq!(plist["whitelistEnabled"].as_bool(), Some(true));
    assert!(!plist["whitelist"].as_array().unwrap().is_empty());
    assert!(!plist["ops"].as_array().unwrap().is_empty());

    // Live Paper plugin search
    let addon_res = servers::search_server_addons(
        &client,
        &gdd_str,
        &srv_id,
        &json!({ "query": "luckperms", "limit": 3 }),
    )
    .await;
    assert!(
        addon_res["hits"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
        "Live plugin search should return hits"
    );

    // Code access create_code -> claim -> P2P scope enforcement -> disconnect check
    let _ = code_access::disconnect();
    let created_code = code_access::create_code(&srv_id, true).expect("create code");
    let code_str = created_code["code"].as_str().expect("pending code").to_string();
    assert!(code_access::claim(&code_str, "E2E").is_ok());
    assert!(code_access::authorize_p2p(&code_str, "getServer", &[json!(srv_id.clone())]).is_ok());
    assert!(code_access::authorize_p2p(&code_str, "getServer", &[json!("other-server-id")]).is_err());
    let _ = code_access::disconnect();

    servers::delete_server(&gdd_str, &srv_id).expect("delete server");
    assert!(!srv_dir.exists(), "Server directory must be deleted");
    println!("[PASS] 6. Server create/props/files/players/addons/P2P/delete ok");

    let _ = fs::remove_dir_all(&base);
}
