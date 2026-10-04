//! Minecraft 服务器列表 Ping（Server List Ping 协议）。
//! 走 TCP 发送 Handshake / StatusRequest，读取版本 / MOTD / 在线人数 / 延迟 / 图标。
//! 与 Electron 版 serverping.js 对齐。

use crate::error::CmdResult;
use serde_json::{json, Value};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::Duration;

const PROTOCOL: i32 = 767; // 1.21 协议号
const TIMEOUT_MS: u64 = 7000;

/* ---------- VarInt / 数据包 ---------- */

fn write_varint(mut v: u32, out: &mut Vec<u8>) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

/// 从 buf[off] 读 VarInt，返回 (值, 占用字节)；数据不足或超长返回 None。
fn read_varint(buf: &[u8], off: usize) -> Option<(u32, usize)> {
    let mut result: u32 = 0;
    let mut bytes = 0usize;
    loop {
        let i = off + bytes;
        if i >= buf.len() {
            return None;
        }
        let b = buf[i];
        result |= ((b & 0x7f) as u32) << (7 * bytes);
        bytes += 1;
        if bytes > 5 {
            return None;
        }
        if b & 0x80 == 0 {
            return Some((result, bytes));
        }
    }
}

fn write_string(s: &str, out: &mut Vec<u8>) {
    let b = s.as_bytes();
    write_varint(b.len() as u32, out);
    out.extend_from_slice(b);
}

fn packet(id: i32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    write_varint(id as u32, &mut body);
    body.extend_from_slice(payload);
    let mut full = Vec::new();
    write_varint(body.len() as u32, &mut full);
    full.extend_from_slice(&body);
    full
}

fn handshake_packet(host: &str, port: u16) -> Vec<u8> {
    let mut payload = Vec::new();
    write_varint(PROTOCOL as u32, &mut payload);
    write_string(host, &mut payload);
    payload.push(((port >> 8) & 0xff) as u8);
    payload.push((port & 0xff) as u8);
    write_varint(1, &mut payload); // next state: status
    packet(0, &payload)
}

/* ---------- 文本处理 ---------- */

/// MOTD 可能是字符串或聊天组件，统一压平为纯文本。
fn flatten(desc: &Value) -> String {
    if let Some(s) = desc.as_str() {
        return s.to_string();
    }
    let mut out = desc.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(extra) = desc.get("extra").and_then(Value::as_array) {
        for e in extra {
            out.push_str(&flatten(e));
        }
    }
    out
}

fn strip_colors(s: &str) -> String {
    // §（U+00A7）+ 一个格式字符（0-9 a-f k-o r x）
    let mut out = String::new();
    let mut skip_next = false;
    for c in s.chars() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if c == '\u{00a7}' {
            skip_next = true;
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/* ---------- 地址解析 ---------- */

/// 解析 host:port；无端口时尝试 SRV 记录。
async fn resolve_address(address: &str) -> std::result::Result<(String, u16), String> {
    let raw = address.trim();
    if raw.is_empty() {
        return Err("服务器地址为空".into());
    }
    let m = regex_like_split(raw);
    let (mut host, mut port, had_port) = match m {
        Some((h, p)) => (h, p, true),
        None => (raw.to_string(), 25565, false),
    };

    if !had_port {
        if let Some((h, p)) = resolve_srv(&host).await {
            host = h;
            port = p;
        }
    }
    Ok((host, port))
}

/// 匹配末尾的 :port（IPv4/主机名形式；不处理裸 IPv6）。
fn regex_like_split(raw: &str) -> Option<(String, u16)> {
    let idx = raw.rfind(':')?;
    let maybe_port = &raw[idx + 1..];
    if !maybe_port.chars().all(|c| c.is_ascii_digit()) || maybe_port.is_empty() {
        return None;
    }
    let p: u32 = maybe_port.parse().ok()?;
    if p > 65535 {
        return None;
    }
    Some((raw[..idx].to_string(), p as u16))
}

async fn resolve_srv(host: &str) -> Option<(String, u16)> {
    use hickory_resolver::config::ResolverConfig;
    use hickory_resolver::name_server::TokioConnectionProvider;
    use hickory_resolver::TokioResolver;
    let builder = match TokioResolver::builder_tokio() {
        Ok(b) => b,
        Err(_) => TokioResolver::builder_with_config(
            ResolverConfig::google(),
            TokioConnectionProvider::default(),
        ),
    };
    let resolver = builder.build();
    let lookup = resolver
        .srv_lookup(format!("_minecraft._tcp.{host}"))
        .await
        .ok()?;
    let mut recs: Vec<_> = lookup.iter().collect();
    if recs.is_empty() {
        return None;
    }
    // 对齐 JS：按 priority 升序，取第一个
    recs.sort_by_key(|s| s.priority());
    let s = recs[0];
    Some((s.target().to_string().trim_end_matches('.').to_string(), s.port()))
}

/* ---------- Ping ---------- */

async fn ping_once(host: &str, port: u16) -> Value {
    let started = Instant::now();
    let res = tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), async {
        let mut sock = TcpStream::connect((host, port)).await.map_err(|e| {
            let note = if e.kind() == std::io::ErrorKind::ConnectionRefused {
                "连接被拒绝".to_string()
            } else {
                e.to_string()
            };
            note
        })?;
        sock.write_all(&handshake_packet(host, port)).await.map_err(|e| e.to_string())?;
        sock.write_all(&packet(0, &[])).await.map_err(|e| e.to_string())?;

        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("连接关闭".to_string());
            }
            all.extend_from_slice(&buf[..n]);

            let Some((len, len_bytes)) = read_varint(&all, 0) else { continue };
            if (all.len() as u32) < len_bytes as u32 + len {
                continue;
            }
            let Some((pid, id_bytes)) = read_varint(&all, len_bytes) else { continue };
            let body_off = len_bytes + id_bytes;
            if pid != 0 {
                continue;
            }
            let Some((str_len, sl_bytes)) = read_varint(&all, body_off) else { continue };
            let start = body_off + sl_bytes;
            let end = start + str_len as usize;
            if all.len() < end {
                return Err("响应不完整".to_string());
            }
            let json_str = String::from_utf8_lossy(&all[start..end]).to_string();
            let data: Value = serde_json::from_str(&json_str).map_err(|_| "响应格式异常".to_string())?;

            // 补发 ping 包（部分服务端需要）
            let _ = sock.write_all(&packet(1, &[0u8; 8])).await;
            return Ok(data);
        }
    })
    .await;

    match res {
        Ok(Ok(data)) => {
            let players = data.get("players").cloned().unwrap_or_else(|| json!({}));
            let sample = players
                .get("sample")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .take(12)
                        .map(|p| p.get("name").cloned().unwrap_or(Value::Null))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "online": true,
                "host": host,
                "port": port,
                "latency": started.elapsed().as_millis() as u64,
                "version": data.pointer("/version/name").cloned().unwrap_or(Value::String(String::new())),
                "protocol": data.pointer("/version/protocol").cloned().unwrap_or(json!(0)),
                "motd": strip_colors(&flatten(&data.get("description").cloned().unwrap_or(Value::Null))),
                "players": {
                    "online": players.get("online").cloned().unwrap_or(json!(0)),
                    "max": players.get("max").cloned().unwrap_or(json!(0)),
                    "sample": sample,
                },
                "favicon": data.get("favicon").cloned().unwrap_or(Value::String(String::new())),
            })
        }
        Ok(Err(note)) => json!({ "online": false, "error": note }),
        Err(_) => json!({ "online": false, "error": format!("请求超时（{TIMEOUT_MS}ms）") }),
    }
}

/// 查询一个服务器（自动解析 SRV），永不抛错。
pub async fn ping(address: &str) -> Value {
    let addr = address.trim();
    match resolve_address(addr).await {
        Ok((host, port)) => {
            let mut v = ping_once(&host, port).await;
            if let Some(obj) = v.as_object_mut() {
                let mut m = serde_json::Map::new();
                m.insert("address".into(), json!(addr));
                for (k, val) in obj.iter() {
                    m.insert(k.clone(), val.clone());
                }
                v = Value::Object(m);
            }
            v
        }
        Err(e) => json!({ "address": addr, "online": false, "error": e }),
    }
}

/// 并发查询多个服务器。
pub async fn ping_all(addresses: &[String]) -> CmdResult<Vec<Value>> {
    let futs = addresses.iter().map(|a| ping(a)).collect::<Vec<_>>();
    Ok(futures_util::future::join_all(futs).await)
}
