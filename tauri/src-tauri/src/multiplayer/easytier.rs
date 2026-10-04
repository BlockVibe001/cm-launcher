//! EasyTier 联机：拉起二进制（房主要建虚拟网卡→管理员）、房间名派生网络名/密钥、
//! 轮询节点状态、退房收摊。与 Electron 版 easytier.js 对齐。
//! 按 LGPL-3.0 界面署名，许可证原文在 resources/tools/easytier/LICENSE.txt。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::multiplayer::lan;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

const TOOL_ID: &str = "easytier";

pub const HOST_IP: &str = "10.126.126.1";
const GUEST_IP: &str = "10.126.126.2";
const MC_PORT: u16 = 25565;
/// RPC 只监听本机
const RPC: &str = "127.0.0.1:15888";

pub const SHARED_NODES: &[&str] = &[
    "tcp://public.easytier.cn:11010",
    "tcp://39.108.52.138:11010",
];

/// fold_code 使用的 34 字符集（代码里 %32，实际只用到前 32）
const CHARS: &[char] = &[
    '0','1','2','3','4','5','6','7','8','9',
    'A','B','C','D','E','F','G','H','J','K',
    'L','M','N','P','Q','R','S','T','U','V',
    'W','X','Y','Z',
];

/* ---------------- 运行时状态 ---------------- */

pub struct EtRuntime {
    pub phase: String,       // offline | starting | online
    pub role: String,        // host | guest
    pub code: String,
    pub address: String,
    pub peers: Vec<Value>,
    pub error: String,
    pub elevated: bool,
    pub probes: Vec<Value>,
    pub child: Option<tokio::process::Child>,
    pub stop_flag: String,
    pub watch_gen: u64,
}

impl EtRuntime {
    pub fn new() -> Self {
        EtRuntime {
            phase: "offline".into(),
            role: String::new(),
            code: String::new(),
            address: String::new(),
            peers: Vec::new(),
            error: String::new(),
            elevated: false,
            probes: Vec::new(),
            child: None,
            stop_flag: String::new(),
            watch_gen: 0,
        }
    }

    fn reset(&mut self) {
        self.phase = "offline".into();
        self.role.clear();
        self.code.clear();
        self.address.clear();
        self.peers.clear();
        self.elevated = false;
        self.stop_flag.clear();
        self.child = None;
    }

    fn snapshot(&self) -> Value {
        json!({
            "phase": self.phase,
            "role": self.role,
            "code": self.code,
            "address": self.address,
            "peers": self.peers,
            "error": self.error,
            "elevated": self.elevated,
            "probes": self.probes,
        })
    }
}

/* ---------------- 工具位置 ---------------- */

fn exe_path() -> String {
    lan::resolve_exe(TOOL_ID)
}

fn cli_path() -> String {
    let core = exe_path();
    if core.is_empty() {
        return String::new();
    }
    let cli = std::path::Path::new(&core)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("easytier-cli.exe");
    if cli.exists() {
        cli.to_string_lossy().to_string()
    } else {
        String::new()
    }
}

fn available() -> bool {
    !exe_path().is_empty()
}

/* ---------------- 房间名 → 网络名/密钥 ---------------- */

fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(format!("blockvibe:easytier:{text}"));
    let mut s = String::new();
    for b in h.finalize() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn fold_code(hex: &str) -> String {
    let mut out = String::new();
    for i in 0..3 {
        let seg = &hex[i * 8..i * 8 + 8];
        let n = u32::from_str_radix(seg, 16).unwrap_or(0);
        for j in 0..4 {
            let idx = (n.wrapping_shr(j * 5) % 32) as usize;
            out.push(CHARS[idx]);
        }
    }
    out
}

fn dashed(code: &str) -> String {
    format!("{}-{}-{}", &code[0..4], &code[4..8], &code[8..12])
}

fn as_code(text: &str) -> String {
    let s: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if s.len() == 12 && s.chars().all(|c| CHARS.contains(&c)) {
        s
    } else {
        String::new()
    }
}

fn code_of(input: &str) -> String {
    let raw = input.trim();
    if raw.is_empty() {
        return String::new();
    }
    let hit = as_code(raw);
    if !hit.is_empty() {
        return hit;
    }
    if raw.chars().count() < 2 {
        return String::new();
    }
    let norm: String = regex_spaces(raw);
    fold_code(&digest(&format!("name:{}", norm.to_lowercase())))
}

fn regex_spaces(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for c in s.trim().chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

struct NetConf {
    name: String,
    secret: String,
    code: String,
}

fn network_of(input: &str) -> Option<NetConf> {
    let code = code_of(input);
    if code.is_empty() {
        return None;
    }
    let name = format!("cm{}", &digest(&format!("net:{code}"))[..16]);
    let secret = digest(&format!("key:{code}"))[..32].to_string();
    Some(NetConf {
        name,
        secret,
        code: dashed(&code),
    })
}

/* ---------------- 节点列表 ---------------- */

fn saved_nodes() -> Vec<String> {
    config::get("easytierNodes")
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn parse_nodes(text: &str) -> Vec<String> {
    text.split(|c: char| matches!(c, '\n' | ',' | ' ' | ';' | '，' | '、'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").unwrap().is_match(s) {
                s.to_string()
            } else {
                format!("tcp://{s}")
            }
        })
        .collect()
}

fn node_list(text: &str) -> Vec<String> {
    let mine = parse_nodes(text);
    let all = if !mine.is_empty() {
        mine
    } else {
        let saved = saved_nodes();
        if !saved.is_empty() {
            saved
        } else {
            SHARED_NODES.iter().map(|s| s.to_string()).collect()
        }
    };
    let mut uniq = Vec::new();
    for u in all {
        if !uniq.contains(&u) {
            uniq.push(u);
        }
    }
    uniq
}

/* ---------------- 节点探测 ---------------- */

struct NodeAddr {
    scheme: String,
    host: String,
    port: u16,
}

fn parse_node(url: &str) -> Option<NodeAddr> {
    use regex::Regex;
    let re = Regex::new(r"(?i)^([a-z][a-z0-9+.-]*)://([^:/]+|\[[^\]]+\])(?::(\d+))?").unwrap();
    let c = re.captures(url.trim())?;
    let scheme = c[1].to_lowercase();
    let host = c[2].trim_start_matches('[').trim_end_matches(']').to_string();
    let port = c
        .get(3)
        .and_then(|m| m.as_str().parse::<u16>().ok())
        .unwrap_or(11010);
    Some(NodeAddr { scheme, host, port })
}

async fn probe_node(url: &str) -> Value {
    let Some(p) = parse_node(url) else {
        return json!({ "url": url, "ok": false, "ms": 0, "note": "地址格式不对" });
    };
    if p.scheme == "udp" {
        return json!({ "url": url, "host": p.host, "port": p.port, "ok": false, "unknown": true, "ms": 0, "note": "UDP 没法预先探测" });
    }
    let start = Instant::now();
    let connect = tokio::time::timeout(
        Duration::from_millis(2000),
        tokio::net::TcpStream::connect((p.host.as_str(), p.port)),
    )
    .await;
    match connect {
        Ok(Ok(_)) => json!({ "url": url, "host": p.host, "port": p.port, "ok": true, "ms": start.elapsed().as_millis() as u64, "note": "" }),
        Ok(Err(e)) => {
            let note = if e.kind() == std::io::ErrorKind::ConnectionRefused {
                "端口没开"
            } else {
                "连不上"
            };
            json!({ "url": url, "host": p.host, "port": p.port, "ok": false, "ms": 0, "note": note })
        }
        Err(_) => json!({ "url": url, "host": p.host, "port": p.port, "ok": false, "ms": 0, "note": "连接超时" }),
    }
}

async fn probe_nodes(list: &[String]) -> Vec<Value> {
    let mut urls = list.to_vec();
    urls.dedup();
    let futs = urls.iter().map(|u| probe_node(u)).collect::<Vec<_>>();
    let mut results = futures_util::future::join_all(futs).await;
    results.sort_by(|a, b| {
        let ao = a.get("ok").and_then(Value::as_bool).unwrap_or(false) as u8;
        let bo = b.get("ok").and_then(Value::as_bool).unwrap_or(false) as u8;
        match bo.cmp(&ao) {
            std::cmp::Ordering::Equal => {
                let am = a.get("ms").and_then(Value::as_u64).unwrap_or(0);
                let bm = b.get("ms").and_then(Value::as_u64).unwrap_or(0);
                am.cmp(&bm)
            }
            o => o,
        }
    });
    results
}

static PROBE_CACHE: LazyLock<Mutex<Option<(Instant, String, Vec<Value>)>>> =
    LazyLock::new(|| Mutex::new(None));

async fn rank_nodes(text: &str) -> Vec<Value> {
    let list = node_list(text);
    let key = list.join(" ");
    {
        let cache = PROBE_CACHE.lock().await;
        if let Some((at, k, p)) = cache.as_ref() {
            if k == &key && at.elapsed().as_secs() < 60 {
                return p.clone();
            }
        }
    }
    let probes = probe_nodes(&list).await;
    *PROBE_CACHE.lock().await = Some((Instant::now(), key, probes.clone()));
    probes
}

fn peer_args_of(list: &[String]) -> Vec<String> {
    list.iter().flat_map(|u| vec!["-p".to_string(), u.clone()]).collect()
}

pub async fn probe(text: &str) -> Value {
    let probes = rank_nodes(text).await;
    let all_down = !probes.is_empty()
        && probes.iter().all(|p| !p.get("ok").and_then(Value::as_bool).unwrap_or(false));
    json!({
        "probes": probes,
        "allDown": all_down,
        "manual": !parse_nodes(text).is_empty(),
    })
}

/* ---------------- 进程拉起 ---------------- */

/// 提权拉起（host），停止标记让提权 PowerShell 守着收子进程。
fn spawn_elevated(et: &mut EtRuntime, args: &[String]) -> CmdResult<()> {
    let core = exe_path();
    let flag = config::user_data_dir().join("easytier-stop.flag");
    let ps1 = config::user_data_dir().join("easytier-host.ps1");
    let _ = std::fs::remove_file(&flag);

    let list = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        &format!(
            "$p = Start-Process -FilePath '{}' -WorkingDirectory '{}' -ArgumentList @({list}) -PassThru -WindowStyle Hidden",
            core.replace('\'', "''"),
            std::path::Path::new(&core).parent().unwrap().to_string_lossy().replace('\'', "''")
        ),
        &format!("$flag = '{}'", flag.to_string_lossy().replace('\'', "''")),
        "while ($p -and -not $p.HasExited) {",
        "  if (Test-Path $flag) { $p.Kill(); break }",
        "  Start-Sleep -Milliseconds 400",
        "}",
        "Remove-Item $flag -Force",
    ]
    .join("\n");
    std::fs::write(&ps1, script)?;

    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let runner = std::path::PathBuf::from(sysroot)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let mut cmd = std::process::Command::new(&runner);
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &format!(
            "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}')",
            runner.to_string_lossy(),
            ps1.to_string_lossy()
        ),
    ]);
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
    let _child = cmd.spawn()?;

    et.elevated = true;
    et.stop_flag = flag.to_string_lossy().to_string();
    Ok(())
}

/// 普通身份拉起（guest，--no-tun）。
fn spawn_plain(et: &mut EtRuntime, args: &[String]) -> CmdResult<()> {
    let core = exe_path();
    let mut cmd = tokio::process::Command::new(&core);
    cmd.args(args)
        .current_dir(std::path::Path::new(&core).parent().unwrap_or_else(|| std::path::Path::new(".")))
        .kill_on_drop(false)
        .creation_flags(0x08000000);
    let child = cmd.spawn()?;
    et.child = Some(child);
    Ok(())
}

/* ---------------- CLI 状态查询 ---------------- */

async fn run_cli(args: &[&str], timeout_ms: u64) -> Option<String> {
    let cli = cli_path();
    if cli.is_empty() {
        return None;
    }
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.arg("--rpc-portal").arg(RPC).args(args).creation_flags(0x08000000);
    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output()).await;
    match out {
        Ok(Ok(o)) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        _ => None,
    }
}

async fn node_info() -> Option<Value> {
    let out = run_cli(&["-o", "json", "node"], 4000).await?;
    let j: Value = serde_json::from_str(&out).ok()?;
    if j.get("ipv4_addr").is_some() {
        Some(j)
    } else {
        None
    }
}

async fn peer_list_raw() -> Vec<Value> {
    let Some(out) = run_cli(&["-o", "json", "peer"], 4000).await else { return Vec::new() };
    serde_json::from_str(&out).unwrap_or_default()
}

/* ---------------- Watcher ---------------- */

fn start_watch(app: AppHandle, et: &mut EtRuntime) {
    et.watch_gen += 1;
    let gen = et.watch_gen;
    let want_ip = if et.role == "host" { GUEST_IP } else { HOST_IP };

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let info = node_info().await;
            let raw_peers = peer_list_raw().await;

            let mp = app.state::<super::MpState>();
            let mut et = mp.et.lock().await;
            if et.watch_gen != gen || et.phase == "offline" {
                break;
            }
            let Some(info) = info else { continue };
            let own = info.get("ipv4_addr").and_then(Value::as_str).unwrap_or("").split('/').next().unwrap_or("").to_string();

            let mut peers = Vec::new();
            for p in raw_peers {
                let ipv4_full = p.get("ipv4").and_then(Value::as_str).unwrap_or("").to_string();
                let ipv4 = ipv4_full.split('/').next().unwrap_or("").to_string();
                if ipv4.is_empty() || ipv4 == own {
                    continue;
                }
                let cost = p.get("cost").cloned().unwrap_or(Value::Null);
                peers.push(json!({
                    "hostname": p.get("hostname").cloned().unwrap_or_else(|| json!("未知设备")),
                    "ipv4": ipv4,
                    "cost": cost,
                    "lat": p.get("lat_ms").cloned().unwrap_or(Value::Null),
                    "loss": p.get("loss_rate").cloned().unwrap_or(Value::Null),
                    "tunnel": p.get("tunnel_proto").cloned().unwrap_or(Value::Null),
                    "direct": regex::Regex::new(r"(?i)p2p|direct|local").unwrap()
                        .is_match(&cost.as_str().unwrap_or("")),
                }));
            }
            et.peers = peers;
            let ready = et.peers.iter().any(|p| p.get("ipv4").and_then(Value::as_str) == Some(want_ip));
            let next = if ready { "online" } else { "starting" };
            if next != et.phase {
                et.phase = next.to_string();
                crate::logger::info(if ready {
                    format!("EasyTier {}：对面已进网", if et.role == "host" { "建房" } else { "加入" })
                } else {
                    format!("EasyTier {}：等待对面进网", if et.role == "host" { "建房" } else { "加入" })
                });
            }
            let _ = app.emit(crate::events::EV_EASYTIER_STATE, et.snapshot());
        }
    });
}

async fn wait_ready() -> bool {
    let start = Instant::now();
    while start.elapsed().as_millis() < 30000 {
        if node_info().await.is_some() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    false
}

/* ---------------- 对外命令接口 ---------------- */

fn info_base() -> Value {
    json!({
        "available": available(),
        "exe": exe_path(),
        "running": false,
        "hostIp": HOST_IP,
        "mcPort": MC_PORT,
        "nodes": saved_nodes(),
        "defaults": SHARED_NODES,
    })
}

/// info 但带 running（async 可读 et）。
pub async fn info_full(app: AppHandle) -> Value {
    let mut v = info_base();
    let mp = app.state::<super::MpState>();
    let et = mp.et.lock().await;
    if let Some(o) = v.as_object_mut() {
        o.insert("running".into(), json!(et.phase != "offline"));
    }
    v
}

pub async fn state(app: AppHandle) -> Value {
    let mp = app.state::<super::MpState>();
    let et = mp.et.lock().await;
    et.snapshot()
}

pub fn code(name: &str) -> String {
    network_of(name).map(|n| n.code).unwrap_or_default()
}

pub fn set_nodes(list: Vec<String>) -> Value {
    let joined = list.join(" ");
    let parsed = parse_nodes(&joined);
    config::set("easytierNodes", json!(parsed));
    json!(parsed)
}

pub async fn host(app: AppHandle, room: String, nodes_text: String) -> CmdResult<Value> {
    let Some(net) = network_of(&room) else {
        return Err(AppError::Msg("请先填一个房间名（至少 2 个字）".into()));
    };
    if !available() {
        return Err(AppError::Msg("没有找到内置的 EasyTier 文件".into()));
    }

    let mp = app.state::<super::MpState>();
    let mut et = mp.et.lock().await;
    // leave 收摊（watch_gen 由后续 start_watch 递增）
    if et.elevated && !et.stop_flag.is_empty() {
        let _ = std::fs::write(&et.stop_flag, "stop");
    } else if let Some(mut c) = et.child.take() {
        let _ = c.kill().await;
    }
    et.reset();

    et.role = "host".into();
    et.code = net.code.clone();
    et.address = format!("{HOST_IP}:{MC_PORT}");
    et.phase = "starting".into();
    let _ = app.emit(crate::events::EV_EASYTIER_STATE, et.snapshot());

    // 排节点（释放锁期间做网络探测——这里简化为持锁等待）
    let ranked = {
        let list = node_list(&nodes_text);
        probe_nodes(&list).await
    };
    et.probes = ranked.clone();
    let urls: Vec<String> = ranked.iter().map(|p| p.get("url").and_then(Value::as_str).unwrap_or("").to_string()).collect();
    let mut args = vec![
        "--network-name".to_string(), net.name,
        "--network-secret".to_string(), net.secret,
        "--hostname".to_string(), "cm-host".into(),
        "-i".to_string(), HOST_IP.into(),
        "--rpc-portal".to_string(), RPC.into(),
    ];
    args.extend(peer_args_of(&urls));
    crate::logger::info(&format!("EasyTier 建房：{}", net.code));
    spawn_elevated(&mut et, &args)?;
    drop(et);

    if !wait_ready().await {
        let mut et = mp.et.lock().await;
        et.phase = "offline".into();
        let snap = et.snapshot();
        drop(et);
        let _ = app.emit(crate::events::EV_EASYTIER_STATE, snap);
        return Err(AppError::Msg("EasyTier 没有在预期时间内启动（如果刚才取消了管理员授权，请再点一次）".into()));
    }
    {
        let mut et = mp.et.lock().await;
        et.phase = "starting".into();
        start_watch(app.clone(), &mut et);
        let snap = et.snapshot();
        drop(et);
        let _ = app.emit(crate::events::EV_EASYTIER_STATE, snap);
    }
    Ok(json!({ "code": net.code, "address": format!("{HOST_IP}:{MC_PORT}") }))
}

pub async fn join(app: AppHandle, room_in: String, nodes_text: String) -> CmdResult<Value> {
    let Some(net) = network_of(&room_in) else {
        return Err(AppError::Msg("请填写房间号或房间名".into()));
    };
    if !available() {
        return Err(AppError::Msg("没有找到内置的 EasyTier 文件".into()));
    }

    let mp = app.state::<super::MpState>();
    let mut et = mp.et.lock().await;
    if et.elevated && !et.stop_flag.is_empty() {
        let _ = std::fs::write(&et.stop_flag, "stop");
    } else if let Some(mut c) = et.child.take() {
        let _ = c.kill().await;
    }
    et.reset();

    et.role = "guest".into();
    et.code = net.code.clone();
    et.address = format!("127.0.0.1:{MC_PORT}");
    et.phase = "starting".into();
    let _ = app.emit(crate::events::EV_EASYTIER_STATE, et.snapshot());

    let ranked = {
        let list = node_list(&nodes_text);
        probe_nodes(&list).await
    };
    et.probes = ranked.clone();
    let urls: Vec<String> = ranked.iter().map(|p| p.get("url").and_then(Value::as_str).unwrap_or("").to_string()).collect();
    let mut args = vec![
        "--network-name".to_string(), net.name,
        "--network-secret".to_string(), net.secret,
        "--hostname".to_string(), "cm-guest".into(),
        "-i".to_string(), GUEST_IP.into(),
        "--no-tun".to_string(),
        "--port-forward".to_string(), format!("tcp://127.0.0.1:{MC_PORT}/{HOST_IP}:{MC_PORT}"),
        "--rpc-portal".to_string(), RPC.into(),
    ];
    args.extend(peer_args_of(&urls));
    crate::logger::info(&format!("EasyTier 加入：{}", net.code));
    spawn_plain(&mut et, &args)?;
    drop(et);

    if !wait_ready().await {
        let mut et = mp.et.lock().await;
        et.phase = "offline".into();
        let snap = et.snapshot();
        drop(et);
        let _ = app.emit(crate::events::EV_EASYTIER_STATE, snap);
        return Err(AppError::Msg("EasyTier 没有在预期时间内启动".into()));
    }
    {
        let mut et = mp.et.lock().await;
        et.phase = "starting".into();
        start_watch(app.clone(), &mut et);
        let snap = et.snapshot();
        drop(et);
        let _ = app.emit(crate::events::EV_EASYTIER_STATE, snap);
    }
    Ok(json!({ "code": net.code, "address": format!("127.0.0.1:{MC_PORT}") }))
}

pub async fn leave(app: AppHandle) -> bool {
    let mp = app.state::<super::MpState>();
    let mut et = mp.et.lock().await;
    et.watch_gen += 1; // 让 watcher 退出
    let was_elevated = et.elevated;
    let flag = et.stop_flag.clone();
    let mut child = et.child.take();

    if was_elevated && !flag.is_empty() {
        let _ = std::fs::write(&flag, "stop");
    } else if let Some(c) = child.as_mut() {
        let _ = c.kill().await;
    }
    et.reset();
    drop(et);

    // 等 RPC 口松手
    for _ in 0..12 {
        if node_info().await.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = std::fs::remove_file(flag);
    true
}

#[allow(dead_code)]
pub async fn shutdown(app: AppHandle) -> bool {
    leave(app).await
}
