#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "256"]

mod auth;
mod config;
mod error;
mod events;
mod logger;
mod mc;
mod multiplayer;
mod net;
mod state;

use error::CmdResult;
use serde_json::{json, Map, Value};
use tauri::Manager;

// ================= 配置 =================

#[tauri::command(rename = "config:get")]
fn config_get() -> Value {
    config::get_all()
}

#[tauri::command(rename = "config:set")]
fn config_set(key: String, value: Value) -> CmdResult<()> {
    config::set(&key, value);
    Ok(())
}

#[tauri::command(rename = "config:update")]
fn config_update(obj: Map<String, Value>) -> CmdResult<()> {
    config::update(obj);
    Ok(())
}

// ================= 版本 =================

#[tauri::command(rename = "versions:manifest")]
async fn versions_manifest(force: Option<bool>) -> CmdResult<Value> {
    mc::version::get_manifest(force.unwrap_or(false)).await
}

#[tauri::command(rename = "versions:installed")]
fn versions_installed(game_dir: Option<String>) -> Vec<String> {
    mc::version::list_installed(game_dir.as_deref())
}

#[tauri::command(rename = "versions:download")]
async fn versions_download(
    mc_version: String,
    game_dir: Option<String>,
    app: tauri::AppHandle,
) -> CmdResult<Value> {
    mc::launch::prepare(&mc_version, game_dir.as_deref(), app).await
}

// ================= Java =================

#[tauri::command(rename = "java:list")]
async fn java_list() -> CmdResult<Vec<mc::java::JavaInfo>> {
    mc::java::list_javas().await
}

#[tauri::command(rename = "java:required")]
fn java_required(mc_version: String) -> mc::java::RequiredJava {
    mc::java::required_java(&mc_version)
}

#[tauri::command(rename = "java:match")]
async fn java_match(mc_version: String) -> CmdResult<Value> {
    let list = mc::java::list_javas().await?;
    let picked = mc::java::pick_for(&mc_version, &list);
    Ok(json!({
        "need": mc::java::required_java(&mc_version).major,
        "picked": picked,
        "javas": list,
    }))
}

#[tauri::command(rename = "java:installed")]
fn java_installed() -> Vec<mc::java::InstalledJava> {
    mc::java::list_installed()
}

#[tauri::command(rename = "java:remote")]
async fn java_remote(major: i64) -> CmdResult<mc::java::AdoptiumRelease> {
    // adoptiumRelease 私有，走 list_javas? 直接内联调用同名公开包装
    mc::java::adoptium_release_public(major).await
}

#[tauri::command(rename = "java:home")]
fn java_home() -> String {
    mc::java::java_home().to_string_lossy().to_string()
}

#[tauri::command(rename = "java:download")]
async fn java_download(major: i64, app: tauri::AppHandle) -> CmdResult<mc::java::InstallResult> {
    mc::java::install(major, &app).await
}

#[tauri::command(rename = "java:uninstall")]
fn java_uninstall(major: Option<i64>) -> i64 {
    mc::java::uninstall(major)
}

#[tauri::command(rename = "java:pick")]
async fn java_pick() -> CmdResult<Option<String>> {
    pick_file(Some(vec![json!({"name": "Java 可执行文件", "extensions": ["exe"]})])).await
}

// ================= 实例 =================

#[tauri::command(rename = "instances:list")]
fn instances_list() -> Value {
    mc::instance::list_instances()
}

#[tauri::command(rename = "instances:save")]
fn instances_save(id: String, data: Value) -> Value {
    mc::instance::save_instance(&id, data)
}

#[tauri::command(rename = "instances:delete")]
fn instances_delete(id: String) {
    mc::instance::delete_instance(&id)
}

// ================= 游戏 =================

// ================= ModLoader（Forge / NeoForge / Fabric / Quilt） =================

#[tauri::command(rename = "modloader:forge:versions")]
async fn forge_versions(mc_version: String) -> CmdResult<Value> {
    mc::modloader::forge_versions(&mc_version).await
}

#[tauri::command(rename = "modloader:forge:install")]
async fn forge_install(mc_version: String, fv: String, game_dir: String, java_path: String, app: tauri::AppHandle) -> CmdResult<String> {
    mc::modloader::install_forge(&mc_version, &fv, &game_dir, &java_path, app).await
}

#[tauri::command(rename = "modloader:neoforge:versions")]
async fn neoforge_versions(mc_version: String) -> CmdResult<Value> {
    mc::modloader::neoforge_versions(&mc_version).await
}

#[tauri::command(rename = "modloader:neoforge:install")]
async fn neoforge_install(mc_version: String, nv: String, game_dir: String, java_path: String, app: tauri::AppHandle) -> CmdResult<String> {
    mc::modloader::install_neoforge(&mc_version, &nv, &game_dir, &java_path, app).await
}

#[tauri::command(rename = "modloader:fabric:loaders")]
async fn fabric_loaders() -> CmdResult<Value> {
    mc::modloader::fabric_loaders().await
}

#[tauri::command(rename = "modloader:fabric:install")]
async fn fabric_install(mc_version: String, lv: String, game_dir: String, app: tauri::AppHandle) -> CmdResult<String> {
    mc::modloader::install_fabric(&mc_version, &lv, &game_dir, app).await
}

#[tauri::command(rename = "modloader:quilt:loaders")]
async fn quilt_loaders() -> CmdResult<Value> {
    mc::modloader::quilt_loaders().await
}

#[tauri::command(rename = "modloader:quilt:install")]
async fn quilt_install(mc_version: String, lv: String, game_dir: String, app: tauri::AppHandle) -> CmdResult<String> {
    mc::modloader::install_quilt(&mc_version, &lv, &game_dir, app).await
}

// ================= 游戏 =================

#[tauri::command(rename = "game:launch")]
async fn game_launch(instance_id: String, extra: Option<Value>, app: tauri::AppHandle) -> CmdResult<bool> {
    mc::launch::launch(&instance_id, extra, app).await
}

#[tauri::command(rename = "game:cancel")]
fn game_cancel(app: tauri::AppHandle) {
    let state = app.state::<state::AppState>();
    state.download_cancel.store(1, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command(rename = "game:running")]
fn game_running(app: tauri::AppHandle) -> bool {
    app.state::<state::AppState>().game_running.load(std::sync::atomic::Ordering::SeqCst)
}

// ================= 对话框（rfd） =================

fn rfd_filters(filters: Option<Vec<Value>>) -> Vec<(String, Vec<String>)> {
    filters
        .unwrap_or_default()
        .iter()
        .map(|f| {
            let name = f.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let exts: Vec<String> = f
                .get("extensions")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            (name, exts)
        })
        .collect()
}

#[tauri::command(rename = "dialog:dir")]
async fn dialog_dir() -> CmdResult<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择目录")
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command(rename = "dialog:file")]
async fn pick_file(filters: Option<Vec<Value>>) -> CmdResult<Option<String>> {
    let mut d = rfd::AsyncFileDialog::new();
    for (name, exts) in rfd_filters(filters) {
        d = d.add_filter(&name, &exts);
    }
    Ok(d.pick_file().await.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command(rename = "dialog:files")]
async fn dialog_files(filters: Option<Vec<Value>>) -> CmdResult<Vec<String>> {
    let mut d = rfd::AsyncFileDialog::new();
    for (name, exts) in rfd_filters(filters) {
        d = d.add_filter(&name, &exts);
    }
    Ok(d.pick_files()
        .await
        .map(|handles| handles.iter().map(|h| h.path().to_string_lossy().to_string()).collect())
        .unwrap_or_default())
}

// ================= 运行日志 =================

#[tauri::command(rename = "log:history")]
fn log_history() -> Vec<logger::LogEntry> {
    logger::history()
}

// ================= 多人 / 联机 =================

// ---- 服务器 Ping ----

#[tauri::command(rename = "server:ping")]
async fn server_ping(address: String) -> Value {
    multiplayer::serverping::ping(&address).await
}

#[tauri::command(rename = "server:pingAll")]
async fn server_ping_all(addresses: Vec<String>) -> CmdResult<Vec<Value>> {
    multiplayer::serverping::ping_all(&addresses).await
}

// ---- 联机助手：IP / UPnP / 工具收纳 ----

#[tauri::command(rename = "lan:detect")]
fn lan_detect() -> Value {
    multiplayer::lan::detect()
}

#[tauri::command(rename = "lan:ips")]
fn lan_ips() -> Vec<Value> {
    multiplayer::lan::local_ips()
}

#[tauri::command(rename = "lan:setPath")]
fn lan_set_path(id: String, p: String, name: Option<String>) -> Value {
    multiplayer::lan::set_path(&id, &p, name.as_deref())
}

#[tauri::command(rename = "lan:launch")]
fn lan_launch(id: String) -> CmdResult<Value> {
    multiplayer::lan::launch(&id)
}

#[tauri::command(rename = "lan:install")]
fn lan_install(id: String, file: String) -> CmdResult<Value> {
    multiplayer::lan::install(&id, &file)
}

#[tauri::command(rename = "lan:fetch")]
async fn lan_fetch(id: String) -> CmdResult<Value> {
    multiplayer::lan::fetch_tool(&id).await
}

#[tauri::command(rename = "lan:toolsDir")]
fn lan_tools_dir() -> String {
    multiplayer::lan::tools_root().to_string_lossy().to_string()
}

#[tauri::command(rename = "lan:upnp")]
async fn lan_upnp(port: u16) -> Value {
    multiplayer::lan::upnp_map(port).await.unwrap_or(Value::Null)
}

#[tauri::command(rename = "lan:upnpClose")]
async fn lan_upnp_close(port: u16) -> bool {
    multiplayer::lan::upnp_unmap(port).await
}

#[tauri::command(rename = "lan:publicEndpoints")]
async fn lan_public_endpoints(port: u16) -> Value {
    multiplayer::lan::public_endpoints(port).await
}

// ---- 陶瓦 Terracotta ----

#[tauri::command(rename = "scaffold:info")]
fn scaffold_info(app: tauri::AppHandle) -> Value {
    let st = app.state::<multiplayer::MpState>();
    multiplayer::terracotta::info(&st)
}

#[tauri::command(rename = "scaffold:state")]
async fn scaffold_state(app: tauri::AppHandle) -> Value {
    let st = app.state::<multiplayer::MpState>();
    multiplayer::terracotta::state(&st).await
}

#[tauri::command(rename = "scaffold:codeOf")]
fn scaffold_code_of(name: String) -> String {
    multiplayer::terracotta::code_of(&name)
}

#[tauri::command(rename = "scaffold:host")]
async fn scaffold_host(app: tauri::AppHandle, opts: Value) -> CmdResult<Value> {
    let name = opts.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let player = opts.get("player").and_then(Value::as_str).unwrap_or("").to_string();
    multiplayer::terracotta::host(app, name, player).await
}

#[tauri::command(rename = "scaffold:join")]
async fn scaffold_join(app: tauri::AppHandle, opts: Value) -> CmdResult<Value> {
    let room = opts.get("room").and_then(Value::as_str).unwrap_or("").to_string();
    let player = opts.get("player").and_then(Value::as_str).unwrap_or("").to_string();
    multiplayer::terracotta::join(app, room, player).await
}

#[tauri::command(rename = "scaffold:leave")]
async fn scaffold_leave(app: tauri::AppHandle) -> bool {
    multiplayer::terracotta::leave(app).await
}

// ---- EasyTier ----

#[tauri::command(rename = "easytier:info")]
async fn easytier_info(app: tauri::AppHandle) -> Value {
    multiplayer::easytier::info_full(app).await
}

#[tauri::command(rename = "easytier:state")]
async fn easytier_state(app: tauri::AppHandle) -> Value {
    multiplayer::easytier::state(app).await
}

#[tauri::command(rename = "easytier:codeOf")]
fn easytier_code_of(name: String) -> String {
    multiplayer::easytier::code(&name)
}

#[tauri::command(rename = "easytier:nodes")]
fn easytier_nodes_cmd(list: Vec<String>) -> Value {
    multiplayer::easytier::set_nodes(list)
}

#[tauri::command(rename = "easytier:probe")]
async fn easytier_probe(text: Option<String>) -> Value {
    multiplayer::easytier::probe(text.as_deref().unwrap_or("")).await
}

#[tauri::command(rename = "easytier:host")]
async fn easytier_host(app: tauri::AppHandle, opts: Value) -> CmdResult<Value> {
    let room = opts.get("room").and_then(Value::as_str).unwrap_or("").to_string();
    let nodes = opts.get("nodes").and_then(Value::as_str).unwrap_or("").to_string();
    multiplayer::easytier::host(app, room, nodes).await
}

#[tauri::command(rename = "easytier:join")]
async fn easytier_join(app: tauri::AppHandle, opts: Value) -> CmdResult<Value> {
    let room = opts.get("room").and_then(Value::as_str).unwrap_or("").to_string();
    let nodes = opts.get("nodes").and_then(Value::as_str).unwrap_or("").to_string();
    multiplayer::easytier::join(app, room, nodes).await
}

#[tauri::command(rename = "easytier:leave")]
async fn easytier_leave(app: tauri::AppHandle) -> bool {
    multiplayer::easytier::leave(app).await
}

fn main() {
    // 冒烟 CDP：CM_CDP_PORT 时给 WebView2 开远程调试端口
    if let Ok(port) = std::env::var("CM_CDP_PORT") {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={port}"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(state::AppState::new())
        .manage(multiplayer::MpState::new())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                multiplayer::lan::set_resource_root(dir);
            }
            logger::set_app_handle(app.handle().clone());
            logger::info("CM Launcher (Tauri) 已启动");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_get,
            config_set,
            config_update,
            versions_manifest,
            versions_installed,
            versions_download,
            java_list,
            java_required,
            java_match,
            java_installed,
            java_remote,
            java_home,
            java_download,
            java_uninstall,
            java_pick,
            instances_list,
            instances_save,
            instances_delete,
            forge_versions,
            forge_install,
            neoforge_versions,
            neoforge_install,
            fabric_loaders,
            fabric_install,
            quilt_loaders,
            quilt_install,
            game_launch,
            game_cancel,
            game_running,
            dialog_dir,
            pick_file,
            dialog_files,
            log_history,
            server_ping,
            server_ping_all,
            lan_detect,
            lan_ips,
            lan_set_path,
            lan_launch,
            lan_install,
            lan_fetch,
            lan_tools_dir,
            lan_upnp,
            lan_upnp_close,
            lan_public_endpoints,
            scaffold_info,
            scaffold_state,
            scaffold_code_of,
            scaffold_host,
            scaffold_join,
            scaffold_leave,
            easytier_info,
            easytier_state,
            easytier_code_of,
            easytier_nodes_cmd,
            easytier_probe,
            easytier_host,
            easytier_join,
            easytier_leave,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
