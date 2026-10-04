//! 陶瓦联机（Terracotta）内置客户端。
//! 拉起官方二进制 → 读出本机端口 → 用官方 HTTP 接口开 / 进 / 退房。
//! 与 Electron 版 terracotta.js 对齐。按 AGPL 例外条款②界面署名。

use super::MpState;
use crate::config;
use crate::error::{AppError, CmdResult};
use crate::multiplayer::lan;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TOOL_ID: &str = "taohua";

/// 34 进制字符集（故意去掉易看错的 I、O）
const CHARS: &[char] = &[
    '0','1','2','3','4','5','6','7','8','9',
    'A','B','C','D','E','F','G','H','J','K',
    'L','M','N','P','Q','R','S','T','U','V',
    'W','X','Y','Z',
];

fn code_mod() -> u128 {
    34u128.pow(16)
}

/// exception.type 编号 → 说法
fn exception_note(t: i64) -> String {
    match t {
        0 => "找不到房主，可能房间号不对或房主已经退出".into(),
        1 => "连接被房主中断了".into(),
        2 => "本机虚拟网卡启动失败，请检查防火墙 / 杀毒软件".into(),
        3 => "房主的虚拟网卡挂了，请让房主重新建房".into(),
        4 => "房间里没检测到 Minecraft 的局域网端口，请让房主确认已经「对局域网开放」".into(),
        5 => "两边版本不一致或协议被改动，请把启动器都升到最新版".into(),
        _ => "联机失败".into(),
    }
}

/* ---------------- 房间号 ---------------- */

/// 官方 from_value：低位在前，每 4 位插连字符。
fn format_code(mut v: u128) -> String {
    let mut code = String::from("U/");
    for i in 0..16 {
        if i == 4 || i == 8 || i == 12 {
            code.push('-');
        }
        code.push(CHARS[(v % 34) as usize]);
        v /= 34;
    }
    code
}

/// 房间名 → 官方房间号（确定性折算）。
fn room_code_from_name(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(format!("blockvibe:{}", name.trim().to_uppercase()));
    let digest = h.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    let seed = u128::from_be_bytes(bytes) % code_mod();
    let seed = seed - (seed % 7);
    format_code(seed)
}

/// 输入可能是房间名或 U/xxxx 房间号，统一为官方房间号。
fn normalize_room(input: &str) -> String {
    use regex::Regex;
    let s = input.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.to_uppercase().contains("U/") {
        let up = s.to_uppercase();
        let re = Regex::new(r"U/[0-9A-Z-]{16,19}").unwrap();
        if let Some(m) = re.find(&up) {
            return m.as_str().to_string();
        }
        return String::new();
    }
    room_code_from_name(s)
}

/* ---------------- 进程与端口 ---------------- */

fn exe_path() -> String {
    lan::resolve_exe(TOOL_ID)
}

fn available() -> bool {
    !exe_path().is_empty()
}

fn port_file() -> std::path::PathBuf {
    config::user_data_dir().join("terracotta-port.json")
}

/// 轮询端口文件直到出现 port（--hmcl 约定）。
async fn wait_port_file(file: &std::path::Path, timeout_ms: u64) -> u16 {
    let start = std::time::Instant::now();
    loop {
        if let Ok(s) = tokio::fs::read_to_string(file).await {
            if let Ok(j) = serde_json::from_str::<Value>(&s) {
                if let Some(p) = j.get("port").and_then(Value::as_u64) {
                    if p > 0 {
                        return p as u16;
                    }
                }
            }
        }
        if start.elapsed().as_millis() as u64 > timeout_ms {
            return 0;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn api_get(port: u16, route: &str, timeout_ms: u64) -> std::result::Result<(u16, String), String> {
    let r = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        HTTP.get(format!("http://127.0.0.1:{port}{route}")).send(),
    )
    .await
    .map_err(|_| "陶瓦联机响应超时".to_string())?
    .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

/// 端口上是否还活着一个可用陶瓦。
async fn alive(port: u16) -> bool {
    match api_get(port, "/state", 1500).await {
        Ok((200, text)) => text.contains("\"state\""),
        _ => false,
    }
}

/// 确保陶瓦在跑，返回端口。
async fn ensure_started(state: &MpState) -> CmdResult<u16> {
    {
        let port = *state.tc_port.lock().unwrap();
        if port != 0 && alive(port).await {
            return Ok(port);
        }
    }
    let exe = exe_path();
    if exe.is_empty() {
        return Err(AppError::Msg("没有找到陶瓦联机的可执行文件".into()));
    }
    let file = port_file();
    let _ = tokio::fs::remove_file(&file).await;

    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--hmcl").arg(&file)
        .current_dir(std::path::Path::new(&exe).parent().unwrap_or_else(|| std::path::Path::new(".")))
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    // spawn 后 drop：陶瓦本体由它自己派生，不随启动器结束
    let _child = cmd.spawn()?;

    let port = wait_port_file(&file, 20000).await;
    if port == 0 {
        return Err(AppError::Msg("陶瓦联机没有在预期时间内启动".into()));
    }
    *state.tc_port.lock().unwrap() = port;
    crate::logger::info(&format!("陶瓦联机已就绪，本机端口 {port}"));
    Ok(port)
}

/* ---------------- 房间状态 ---------------- */

async fn get_state(state: &MpState) -> Value {
    let port = *state.tc_port.lock().unwrap();
    if port == 0 {
        return json!({ "state": "offline" });
    }
    match api_get(port, "/state", 3000).await {
        Ok((_, text)) => serde_json::from_str(&text).unwrap_or_else(|_| json!({ "state": "offline" })),
        Err(_) => json!({ "state": "offline" }),
    }
}

/// 轮询 /state 直到进入目标状态，变化时推给界面。
async fn wait_for(
    app: &AppHandle,
    state: &MpState,
    want: &[&str],
    timeout_ms: u64,
) -> CmdResult<Value> {
    let mine = state.tc_epoch.load(Ordering::SeqCst);
    let start = std::time::Instant::now();
    let mut last_index: Option<Value> = None;
    let mut last_state = String::new();

    while (start.elapsed().as_millis() as u64) < timeout_ms {
        if state.tc_epoch.load(Ordering::SeqCst) != mine {
            return Err(AppError::Msg("已取消".into()));
        }
        let s = get_state(state).await;
        let cur_state = s.get("state").and_then(Value::as_str).unwrap_or("offline");
        if cur_state != "offline" {
            let index = s.get("index").cloned();
            let changed = last_state != cur_state || last_index != index;
            if changed {
                last_state = cur_state.to_string();
                last_index = index;
                let _ = app.emit(crate::events::EV_SCAFFOLD_STATE, &s);
            }
            if want.contains(&cur_state) {
                return Ok(s);
            }
            if cur_state == "exception" {
                let t = s.get("type").and_then(Value::as_i64).unwrap_or(-1);
                return Err(AppError::Msg(exception_note(t)));
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    Err(AppError::Msg("联机超时了，请再试一次".into()))
}

fn build_query(room: &str, player: &str) -> String {
    let mut parts = vec![format!("room={}", url_encode(room))];
    if !player.is_empty() {
        parts.push(format!("player={}", url_encode(player)));
    }
    format!("?{}", parts.join("&"))
}

/// 极简百分号编码（满足 room/player）。
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b;
        if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/* ---------------- 对外命令接口 ---------------- */

pub fn info(state: &MpState) -> Value {
    json!({
        "available": available(),
        "exe": exe_path(),
        "running": *state.tc_port.lock().unwrap() != 0,
    })
}

pub async fn state(state: &MpState) -> Value {
    get_state(state).await
}

pub fn code_of(name: &str) -> String {
    normalize_room(name)
}

pub async fn host(app: AppHandle, name: String, player: String) -> CmdResult<Value> {
    let state = app.state::<MpState>();
    let code = normalize_room(&name);
    if code.is_empty() {
        return Err(AppError::Msg("请先填一个房间名".into()));
    }
    let port = ensure_started(&state).await?;
    state.tc_epoch.fetch_add(1, Ordering::SeqCst);

    let _ = api_get(port, "/state/ide", 2000).await;
    let (status, _) = api_get(port, &format!("/state/scanning{}", build_query(&code, &player)), 8000)
        .await
        .map_err(|e| AppError::Msg(e))?;
    if status != 200 {
        return Err(AppError::Msg("陶瓦联机拒绝了建房请求".into()));
    }
    crate::logger::info(&format!("陶瓦联机开始建房：{code}"));

    let s = wait_for(&app, &state, &["host-ok"], 5 * 60 * 1000).await?;
    let room = s.get("room").and_then(Value::as_str).map(String::from).unwrap_or_else(|| code.clone());
    let profiles = s.get("profiles").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({ "code": room, "profiles": profiles }))
}

pub async fn join(app: AppHandle, room_in: String, player: String) -> CmdResult<Value> {
    let state = app.state::<MpState>();
    let code = normalize_room(&room_in);
    if code.is_empty() {
        return Err(AppError::Msg("请填写房间号或房间名".into()));
    }
    let port = ensure_started(&state).await?;
    state.tc_epoch.fetch_add(1, Ordering::SeqCst);

    let _ = api_get(port, "/state/ide", 2000).await;
    let (status, _) = api_get(port, &format!("/state/guesting{}", build_query(&code, &player)), 8000)
        .await
        .map_err(|e| AppError::Msg(e))?;
    if status != 200 {
        return Err(AppError::Msg("房间号格式不对，请检查后重填".into()));
    }
    crate::logger::info(&format!("陶瓦联机开始进房：{code}"));

    let s = wait_for(&app, &state, &["guest-ok"], 6 * 60 * 1000).await?;
    let url = s.get("url").and_then(Value::as_str).map(String::from).unwrap_or_default();
    let room = s.get("room").and_then(Value::as_str).map(String::from).unwrap_or_else(|| code.clone());
    let profiles = s.get("profiles").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({ "url": url, "code": room, "profiles": profiles }))
}

pub async fn leave(app: AppHandle) -> bool {
    let state = app.state::<MpState>();
    state.tc_epoch.fetch_add(1, Ordering::SeqCst);
    let port = *state.tc_port.lock().unwrap();
    if port == 0 {
        return false;
    }
    matches!(api_get(port, "/state/ide", 3000).await, Ok((200, _)))
}
