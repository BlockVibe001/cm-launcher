//! 联机助手：局域网地址、公网联机（UPnP / IPv6）、第三方联机工具的收纳与启动。
//! 与 Electron 版 lan.js 对齐。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::net::downloader::extract_zip_blocking;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/* ---------------- 预置工具 ---------------- */

#[allow(dead_code)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub desc: &'static str,
    pub url: &'static str,
    pub mirrors: &'static [&'static str],
    pub exes: &'static [&'static str],
    pub folders: &'static [&'static str],
    pub pkg: &'static str,
    pub file: &'static str,
    pub page: &'static str,
}

pub static PRESETS: LazyLock<Vec<Preset>> = LazyLock::new(|| {
    vec![
        Preset {
            id: "taohua",
            name: "陶瓦联机",
            icon: "🏺",
            desc: "虚拟局域网联机工具，支持房间号直连",
            url: "https://github.com/burningtnt/Terracotta/releases/download/v0.4.2/terracotta-0.4.2-windows-x86_64-pkg.tar.gz",
            mirrors: &["https://gitee.com/burningtnt/Terracotta/releases/download/v0.4.2/terracotta-0.4.2-windows-x86_64-pkg.tar.gz"],
            exes: &["terracotta.exe", "terracotta-0.4.2-windows-x86_64.exe", "陶瓦联机.exe", "taohua联机.exe"],
            folders: &["陶瓦联机", "Terracotta", "Taohua", "TaohuaLan"],
            pkg: "",
            file: "",
            page: "",
        },
        Preset {
            id: "easytier",
            name: "EasyTier",
            icon: "🛰️",
            desc: "去中心化组网，跨网络联机；也可当通用内网穿透",
            url: "https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip",
            mirrors: &[],
            exes: &["easytier-core.exe"],
            folders: &["easytier", "EasyTier"],
            pkg: "",
            file: "",
            page: "",
        },
        Preset {
            id: "redstone",
            name: "红石联机",
            icon: "🔺",
            desc: "国内常用的 MC 内网穿透联机工具",
            url: "https://hongshi.site/api/download/webui?platform=windows&arch=amd64",
            mirrors: &[],
            exes: &["hongshi-windows-amd64.exe", "红石联机.exe", "redstonelan.exe", "RedstoneLan.exe", "红石.exe"],
            folders: &["红石联机", "RedstoneLan", "Redstone"],
            pkg: "exe",
            file: "hongshi-windows-amd64.exe",
            page: "",
        },
        Preset {
            id: "sakura",
            name: "Sakura Frp",
            icon: "🌸",
            desc: "通用内网穿透，可自行映射 25565 端口",
            url: "",
            mirrors: &[],
            exes: &["SakuraFrpLauncher.exe", "SakuraLauncher.exe", "SakuraFrp.exe"],
            folders: &["SakuraFrpLauncher", "SakuraFrp"],
            pkg: "",
            file: "",
            page: "https://www.natfrp.com/tunnel/download",
        },
    ]
});

fn preset_of(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

pub const CUSTOM_ID: &str = "custom";

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

/* ---------------- 本机局域网地址 ---------------- */

/// 本机非内部 IPv4，常见家用网段优先。
pub fn local_ips() -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let networks = sysinfo::Networks::new_with_refreshed_list();
    for (name, n) in &networks {
        for net in n.ip_networks() {
            let std::net::IpAddr::V4(v4) = net.addr else { continue };
            let ip = v4.octets();
            if ip[0] == 127 {
                continue; // loopback
            }
            let address = v4.to_string();
            // prefix → netmask
            let mask = if net.prefix == 0 { 0u32 } else { (!0u32) << (32 - net.prefix.min(32)) };
            let mo = mask.to_be_bytes();
            let netmask = format!("{}.{}.{}.{}", mo[0], mo[1], mo[2], mo[3]);
            out.push(json!({ "name": name, "address": address, "netmask": netmask }));
        }
    }
    let rank = |v: &Value| {
        let a = v.get("address").and_then(Value::as_str).unwrap_or("");
        if a.starts_with("192.168.") {
            0
        } else if a.starts_with("10.") {
            1
        } else if regex_172(a) {
            2
        } else {
            3
        }
    };
    out.sort_by(|a, b| rank(a).cmp(&rank(b)));
    out
}

fn regex_172(a: &str) -> bool {
    let m: Vec<&str> = a.split('.').collect();
    if m.len() != 4 || m[0] != "172" {
        return false;
    }
    match m[1].parse::<u8>() {
        Ok(n) => (16..=31).contains(&n),
        Err(_) => false,
    }
}

/// 可直连的公网 IPv6（2000::/3）。
pub fn public_ipv6s() -> Vec<Value> {
    let mut out = Vec::new();
    let networks = sysinfo::Networks::new_with_refreshed_list();
    for (name, n) in &networks {
        for net in n.ip_networks() {
            let std::net::IpAddr::V6(v6) = net.addr else { continue };
            let address = v6.to_string();
            // sysinfo 已不带 zone；2000::/3 首字节 0x2x/0x3x
            let first = v6.octets()[0];
            if first & 0xe0 == 0x20 {
                out.push(json!({ "name": name, "address": address }));
            }
        }
    }
    out
}

fn local_ipv4() -> String {
    local_ips()
        .first()
        .and_then(|v| v.get("address").and_then(Value::as_str).map(String::from))
        .unwrap_or_default()
}

/* ---------------- UPnP ---------------- */

const SSDP_ADDR: &str = "239.255.255.250";
const SSDP_PORT: u16 = 1900;
const IGD_ST: &str = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";

#[derive(Clone)]
struct Gateway {
    location: String,
    from: String,
}

/// SSDP 广播找 IGD，返回描述文件 LOCATION。
async fn ssdp_discover(timeout_ms: u64) -> Vec<Gateway> {
    use tokio::net::UdpSocket;
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await else { return Vec::new() };
    let search = |st: String| -> String {
        format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_ADDR}:{SSDP_PORT}\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: {st}\r\n\r\n"
        )
    };
    for st in [IGD_ST, "upnp:rootdevice"] {
        let buf = search(st.to_string());
        let _ = sock.send_to(buf.as_bytes(), (SSDP_ADDR, SSDP_PORT)).await;
    }

    let mut found: Vec<Gateway> = Vec::new();
    let mut buf = [0u8; 2048];
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok((n, from))) = tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await else {
            break;
        };
        let text = String::from_utf8_lossy(&buf[..n]);
        static LOC_RE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)LOCATION:\s*(\S+)").unwrap());
        if let Some(c) = LOC_RE.captures(&text) {
            let loc = c[1].trim().to_string();
            if !found.iter().any(|g| g.location == loc) {
                found.push(Gateway {
                    location: loc,
                    from: from.ip().to_string(),
                });
            }
        }
    }
    found
}

use regex::Regex;

async fn http_get(url: &str, timeout_ms: u64) -> std::result::Result<String, String> {
    let r = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        HTTP.get(url).send(),
    )
    .await
    .map_err(|_| "读取网关描述超时".to_string())?
    .map_err(|e| e.to_string())?;
    r.text().await.map_err(|e| e.to_string())
}

/// 从描述 XML 挑 WAN 连接服务。
fn parse_wan_service(xml: &str, base_url: &str) -> Option<Value> {
    static SVC_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<service>.*?</service>").unwrap());
    static TYPE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<serviceType>(.*?)</serviceType>").unwrap());
    static CTRL_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<controlURL>(.*?)</controlURL>").unwrap());
    for block in SVC_RE.find_iter(xml) {
        let s = block.as_str();
        let stype = TYPE_RE.captures(s).map(|c| c[1].trim().to_string()).unwrap_or_default();
        if !Regex::new(r"(?i)WAN(IP|PPP)Connection").unwrap().is_match(&stype) {
            continue;
        }
        let ctrl = CTRL_RE.captures(s).map(|c| c[1].trim().to_string()).unwrap_or_default();
        if ctrl.is_empty() {
            continue;
        }
        if let Some(full) = join_url(base_url, &ctrl) {
            return Some(json!({ "serviceType": stype, "controlURL": full }));
        }
    }
    None
}

/// 模拟 new URL(ctrl, base)。
fn join_url(base: &str, ctrl: &str) -> Option<String> {
    if ctrl.starts_with("http://") || ctrl.starts_with("https://") {
        return Some(ctrl.to_string());
    }
    // 提取 scheme://host
    let m = Regex::new(r"^(https?://[^/]+)").unwrap();
    let Some(c) = m.captures(base) else { return None };
    let origin = c[1].to_string();
    if ctrl.starts_with('/') {
        Some(format!("{origin}{ctrl}"))
    } else {
        // base 所在目录
        let dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or(&origin);
        Some(format!("{dir}/{ctrl}"))
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 发一条 UPnP SOAP 指令。
async fn soap(
    control_url: &str,
    service_type: &str,
    action: &str,
    body: &str,
    timeout_ms: u64,
) -> std::result::Result<String, String> {
    let payload = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\
         <u:{action} xmlns:u=\"{service_type}\">{body}</u:{action}></s:Body></s:Envelope>"
    );
    let r = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        HTTP
            .post(control_url)
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", format!("\"{service_type}#{action}\""))
            .header("Connection", "close")
            .body(payload)
            .send(),
    )
    .await
    .map_err(|_| "UPnP 请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    let status = r.status();
    let text = r.text().await.map_err(|e| e.to_string())?;
    if status.as_u16() >= 400 {
        return Err(format!("UPnP 返回 HTTP {}", status.as_u16()));
    }
    Ok(text)
}

/// 申请端口映射，成功返回入口信息；失败返回 None（不抛）。
pub async fn upnp_map(port: u16) -> Option<Value> {
    let internal = local_ipv4();
    let desc = "BlockVibeLauncher";
    if port == 0 || internal.is_empty() {
        return None;
    }
    let gateways = ssdp_discover(1500).await;
    for gw in gateways {
        let Ok(xml) = http_get(&gw.location, 2500).await else { continue };
        let Some(svc) = parse_wan_service(&xml, &gw.location) else { continue };
        let control = svc.get("controlURL").and_then(Value::as_str).unwrap_or("");
        let stype = svc.get("serviceType").and_then(Value::as_str).unwrap_or("");
        let add_body = format!(
            "<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort>\
             <NewProtocol>TCP</NewProtocol><NewInternalPort>{port}</NewInternalPort>\
             <NewInternalClient>{}</NewInternalClient><NewEnabled>1</NewEnabled>\
             <NewPortMappingDescription>{}</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>",
            esc(&internal),
            esc(desc)
        );
        if soap(control, stype, "AddPortMapping", &add_body, 3500).await.is_err() {
            continue;
        }
        let mut ip = String::new();
        let get_body = "<NewRemoteHost></NewRemoteHost>";
        if let Ok(r) = soap(control, stype, "GetExternalIPAddress", get_body, 3500).await {
            static IP_RE: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"(?is)<NewExternalIPAddress>(.*?)</NewExternalIPAddress>").unwrap());
            if let Some(c) = IP_RE.captures(&r) {
                ip = c[1].trim().to_string();
            }
        }
        crate::logger::info(&format!("UPnP 端口映射成功：{internal}:{port} → {}", if ip.is_empty() { "公网 IP 未知" } else { &ip }));
        return Some(json!({ "port": port, "ip": ip, "gateway": gw.from, "internal": internal, "desc": desc }));
    }
    crate::logger::info("UPnP 端口映射失败：没有找到支持 UPnP 的网关");
    None
}

/// 撤销映射。
pub async fn upnp_unmap(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let gateways = ssdp_discover(1200).await;
    for gw in gateways {
        let Ok(xml) = http_get(&gw.location, 2500).await else { continue };
        let Some(svc) = parse_wan_service(&xml, &gw.location) else { continue };
        let control = svc.get("controlURL").and_then(Value::as_str).unwrap_or("");
        let stype = svc.get("serviceType").and_then(Value::as_str).unwrap_or("");
        let body = format!(
            "<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort><NewProtocol>TCP</NewProtocol>"
        );
        if soap(control, stype, "DeletePortMapping", &body, 3500).await.is_ok() {
            return true;
        }
    }
    false
}

/// 汇总端口上可用的公网入口。
pub async fn public_endpoints(port: u16) -> Value {
    let ipv6 = public_ipv6s();
    let ipv6addrs: Vec<String> =
        ipv6.iter().filter_map(|v| v.get("address").and_then(Value::as_str).map(String::from)).collect();
    let ipv4 = if ipv6addrs.is_empty() { upnp_map(port).await } else { None };
    json!({ "port": port, "ipv6": ipv6addrs, "ipv4": ipv4 })
}

/* ---------------- 游戏日志开房端口 ---------------- */

#[allow(dead_code)]
pub fn detect_lan_port(line: &str) -> u16 {
    let pats = [
        r"(?i)Local game hosted on port (\d{2,5})",
        r"(?i)Started serving on (?:[0-9a-fA-F:.]+:)?(\d{2,5})",
        r"(?i)Started on port (\d{2,5})",
        r"(?i)Opening (?:LAN|to LAN) on port (\d{2,5})",
        r"(?i)Listening on .*:(\d{2,5})",
    ];
    for p in pats {
        if let Some(c) = Regex::new(p).unwrap().captures(line) {
            if let Ok(n) = c[1].parse::<u16>() {
                if n >= 1024 {
                    return n;
                }
            }
        }
    }
    0
}

/* ---------------- 工具目录定位 ---------------- */

pub fn tools_root() -> PathBuf {
    config::user_data_dir().join("tools")
}

fn tool_dir(id: &str) -> PathBuf {
    let d = tools_root().join(id);
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 内置工具目录：dev 为仓库 resources/tools。
pub fn bundled_root() -> PathBuf {
    // 发布版：安装目录资源区内的 resources/tools（由 setup 注入 resource_dir）
    if let Some(root) = RESOURCE_ROOT.get() {
        let installed = root.join("resources").join("tools");
        if installed.exists() {
            return installed;
        }
    }
    // dev 回退：CARGO_MANIFEST_DIR = .../tauri/src-tauri，源码树里的 resources/tools
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("resources")
        .join("tools")
}

/// 发布版资源根目录（app.path().resource_dir()），由 main.rs setup 注入。
static RESOURCE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_resource_root(p: PathBuf) {
    let _ = RESOURCE_ROOT.set(p);
}

fn lower_eq(name: &str, target: &str) -> bool {
    name.eq_ignore_ascii_case(target)
}

/// 目录里按名字找 exe（受限深度），再退回任意 exe/bat/cmd。
fn locate_in_dir(dir: &Path, exes: &[&str], depth: usize) -> String {
    if !dir.is_dir() {
        return String::new();
    }
    // 直接名字匹配
    if let Some(p) = walk_find(dir, exes, depth) {
        return p;
    }
    first_exe(dir, depth)
}

fn walk_find(root: &Path, exes: &[&str], depth: usize) -> Option<String> {
    let entries = walkdir::WalkDir::new(root).max_depth(depth + 1).into_iter().flatten();
    for e in entries {
        if e.file_type().is_file() {
            let fname = e.file_name().to_string_lossy();
            if exes.iter().any(|t| lower_eq(&fname, t)) {
                return Some(e.path().to_string_lossy().to_string());
            }
        }
    }
    None
}

fn first_exe(root: &Path, depth: usize) -> String {
    let entries = walkdir::WalkDir::new(root).max_depth(depth + 1).into_iter().flatten();
    for e in entries {
        if e.file_type().is_file() {
            let fname = e.file_name().to_string_lossy();
            let lower = fname.to_lowercase();
            if lower.ends_with(".exe") || lower.ends_with(".bat") || lower.ends_with(".cmd") {
                return e.path().to_string_lossy().to_string();
            }
        }
    }
    String::new()
}

fn managed_exe(id: &str) -> String {
    let dir = tools_root().join(id);
    if !dir.is_dir() {
        return String::new();
    }
    let exes: Vec<&str> = preset_of(id).map(|p| p.exes.to_vec()).unwrap_or_default();
    locate_in_dir(&dir, &exes, 3)
}

fn bundled_exe(id: &str) -> String {
    let dir = bundled_root().join(id);
    if !dir.is_dir() {
        return String::new();
    }
    let exes: Vec<&str> = preset_of(id).map(|p| p.exes.to_vec()).unwrap_or_default();
    locate_in_dir(&dir, &exes, 2)
}

fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let push_env = |key: &str, sub: Option<&str>, roots: &mut Vec<PathBuf>| {
        if let Ok(v) = std::env::var(key) {
            let p = match sub {
                Some(s) => PathBuf::from(v).join(s),
                None => PathBuf::from(v),
            };
            if p.is_dir() && !roots.contains(&p) {
                roots.push(p);
            }
        }
    };
    push_env("APPDATA", None, &mut roots);
    push_env("TEMP", None, &mut roots);
    push_env("USERPROFILE", Some("Desktop"), &mut roots);
    push_env("USERPROFILE", Some("Documents"), &mut roots);
    push_env("USERPROFILE", Some("Downloads"), &mut roots);
    push_env("LOCALAPPDATA", Some("Programs"), &mut roots);
    push_env("ProgramFiles", None, &mut roots);
    push_env("ProgramFiles(x86)", None, &mut roots);
    roots
}

fn detect_one(preset: &Preset, roots: &[PathBuf]) -> String {
    for root in roots {
        for folder in preset.folders {
            let dir = root.join(folder);
            if !is_dir(&dir) {
                continue;
            }
            let p = walk_find(&dir, preset.exes, 2);
            if let Some(p) = p {
                return p;
            }
        }
    }
    for root in roots {
        if let Some(p) = walk_find(root, preset.exes, 2) {
            return p;
        }
    }
    String::new()
}

/// 统一 exe 解析：手动指定 → 托管 → 内置 → 本机已装。
pub fn resolve_exe(id: &str) -> String {
    let lan_tools = config::get("lanTools");
    let saved_path = lan_tools.get(id).and_then(|v| v.get("path")).and_then(Value::as_str).unwrap_or("");
    if !saved_path.is_empty() && exists(saved_path) {
        return saved_path.to_string();
    }
    if id == CUSTOM_ID {
        return String::new();
    }
    let Some(preset) = preset_of(id) else { return String::new() };
    let managed = managed_exe(id);
    if !managed.is_empty() {
        return managed;
    }
    let bundled = bundled_exe(id);
    if !bundled.is_empty() {
        return bundled;
    }
    detect_one(preset, &search_roots())
}

/* ---------------- 安装 / 下载收纳 ---------------- */

/// 把安装包（zip / tar.gz / exe）解压收纳进托管目录，自动定位 exe。
pub fn install(id: &str, file: &str) -> CmdResult<Value> {
    if !exists(file) {
        return Err(AppError::Msg("安装包不存在".into()));
    }
    let dir = tool_dir(id);
    let preset = preset_of(id);
    let keep = preset.map(|p| p.file).filter(|s| !s.is_empty()).unwrap_or(
        Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or("package"),
    );

    let lower = file.to_lowercase();
    if lower.ends_with(".zip") {
        extract_zip_blocking(Path::new(file), &dir, |_, _| {})?;
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        untar_gz(file, &dir)?;
    } else {
        let dest = dir.join(keep);
        if dest != PathBuf::from(file) {
            std::fs::copy(file, &dest)?;
        }
    }
    let exe = managed_exe(id);
    if !exe.is_empty() {
        set_path(id, &exe, None);
    }
    crate::logger::info(if exe.is_empty() {
        format!("联机工具已收纳但未找到可执行文件：{id}")
    } else {
        format!("联机工具已收纳：{id} → {exe}")
    });
    Ok(json!({ "dir": dir.to_string_lossy(), "exe": exe }))
}

fn untar_gz(file: &str, dir: &Path) -> CmdResult<()> {
    use flate2::read::GzDecoder;
    let f = std::fs::File::open(file)?;
    let dec = GzDecoder::new(f);
    let mut ar = tar::Archive::new(dec);
    // tar crate 默认防 .. 与绝对路径
    ar.unpack(dir).map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

/// 配置了 url 的预置工具：启动器自己下载并收纳。
pub async fn fetch_tool(id: &str) -> CmdResult<Value> {
    let Some(preset) = preset_of(id) else {
        return Err(AppError::Msg("未知的联机工具".into()));
    };
    let already = managed_exe(id);
    if !already.is_empty() {
        return Ok(json!({ "dir": Path::new(&already).parent().map(|p| p.to_string_lossy()).unwrap_or_default(), "exe": already }));
    }
    let mut urls: Vec<&str> = vec![preset.url];
    urls.extend(preset.mirrors.iter().copied());
    urls.retain(|u| !u.is_empty());
    if urls.is_empty() {
        return Err(AppError::Msg(format!("{} 没有配置下载地址，请改用「装进启动器」", preset.name)));
    }

    let dir = tool_dir(id);
    let first_url = urls[0];
    let kind = if !preset.pkg.is_empty() {
        preset.pkg
    } else if first_url.contains(".zip") {
        "zip"
    } else if first_url.contains(".tar.gz") || first_url.contains(".tgz") {
        "targz"
    } else {
        "exe"
    };
    let name = match kind {
        "zip" => "package.zip",
        "targz" => "package.tar.gz",
        _ => {
            if preset.file.is_empty() {
                "package.exe"
            } else {
                preset.file
            }
        }
    };
    let pkg = dir.join(name);

    let mut last_err = String::from("所有下载源都不可用");
    for u in urls {
        let r = HTTP.get(u).header("User-Agent", "BlockVibeLauncher/1.0.0").send().await;
        match r {
            Ok(res) if res.status().is_success() => {
                let bytes = res.bytes().await.map_err(|e| AppError::Msg(e.to_string()))?;
                tokio::fs::write(&pkg, &bytes).await?;
                break;
            }
            Ok(res) => {
                last_err = format!("HTTP {}", res.status());
                crate::logger::info(&format!("下载 {} 失败，换下一个源：{u}", preset.name));
            }
            Err(e) => {
                last_err = e.to_string();
                crate::logger::info(&format!("下载 {} 失败，换下一个源：{u}（{e}）", preset.name));
            }
        }
    }
    if !pkg.exists() {
        return Err(AppError::Msg(format!("下载失败：{last_err}")));
    }
    install(id, &pkg.to_string_lossy())
}

/* ---------------- 探测 / 配置 / 启动 ---------------- */

pub fn detect() -> Value {
    let lan_tools = config::get("lanTools");
    let roots = search_roots();
    let mut tools = Vec::new();
    for p in PRESETS.iter() {
        let manual = lan_tools.get(p.id).and_then(|v| v.get("path")).and_then(Value::as_str).unwrap_or("");
        let manual = if !manual.is_empty() && exists(manual) { manual } else { "" };
        let managed = managed_exe(p.id);
        let bundled = bundled_exe(p.id);
        let has_managed = !managed.is_empty();
        let has_bundled = !bundled.is_empty();
        let path0 = if !manual.is_empty() {
            manual.to_string()
        } else if has_managed {
            managed
        } else if has_bundled {
            bundled
        } else {
            detect_one(p, &roots)
        };
        tools.push(json!({
            "id": p.id,
            "name": p.name,
            "icon": p.icon,
            "desc": p.desc,
            "path": path0,
            "found": !path0.is_empty(),
            "manual": !manual.is_empty(),
            "managed": has_managed,
            "bundled": has_bundled,
            "auto": !p.url.is_empty(),
            "page": p.page,
            "custom": false,
        }));
    }

    let custom_path = lan_tools.get(CUSTOM_ID).and_then(|v| v.get("path")).and_then(Value::as_str).unwrap_or("");
    let custom_name = lan_tools.get(CUSTOM_ID).and_then(|v| v.get("name")).and_then(Value::as_str).unwrap_or("自定义工具");
    tools.push(json!({
        "id": CUSTOM_ID,
        "name": custom_name,
        "icon": "🧩",
        "desc": "添加任意可执行文件（其他联机工具 / 自己写的脚本）",
        "path": custom_path,
        "found": !custom_path.is_empty() && exists(custom_path),
        "manual": !custom_path.is_empty(),
        "custom": true,
    }));

    json!({ "tools": tools, "ips": local_ips(), "ipv6": public_ipv6s() })
}

pub fn set_path(id: &str, p: &str, name: Option<&str>) -> Value {
    let mut all = config::get("lanTools");
    let obj = all.as_object_mut();
    match obj {
        Some(map) => {
            if p.is_empty() {
                map.remove(id);
            } else {
                let nm = name
                    .map(String::from)
                    .or_else(|| map.get(id).and_then(|v| v.get("name")).and_then(Value::as_str).map(String::from))
                    .unwrap_or_default();
                map.insert(id.to_string(), json!({ "path": p, "name": nm }));
            }
        }
        None => {
            all = json!({});
        }
    }
    config::set("lanTools", all.clone());
    crate::logger::info(if p.is_empty() { format!("清除联机工具 {id}") } else { format!("登记联机工具 {id}：{p}") });
    all
}

pub fn launch(id: &str) -> CmdResult<Value> {
    let exe = resolve_exe(id);
    if exe.is_empty() {
        return Err(AppError::Msg("未找到该工具的可执行文件，请先手动指定".into()));
    }
    if !exists(&exe) {
        return Err(AppError::Msg("可执行文件不存在，请重新指定".into()));
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(Path::new(&exe).parent().unwrap_or_else(|| Path::new(".")));
    let child = cmd.spawn()?;
    crate::logger::info(&format!("启动联机工具：{exe}"));
    Ok(json!({ "path": exe, "pid": child.id() }))
}
