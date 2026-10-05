//! 种子地图（Axolotl 实验室 · 种子地图页）：调用随包分发的 seedmap.exe（cubiomes + mapcli）。
//! 移植自 Electron 版 seedmap.js / seedmap-engine.js，命令与返回结构完全对齐前端。
//!
//! 引擎协议（见 mapcli.c）：
//!   tile       → "OK\n" + w*h 个 RGB（行优先）
//!   structs    → 每行 "<类型> <x> <z>"，以 END 结束
//!   stronghold → 每行 "<x> <z>"，END
//!   spawn      → "<x> <z>"
//!   slime      → 每行 "<cx> <cz>"，END
//!   biome      → 单个数字 id

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// 引擎路径：发布版取安装资源区 tools/seedmap/seedmap.exe（复用 lan::bundled_root 的定位逻辑）
fn exe_path() -> Result<PathBuf, AppError> {
    let p = crate::multiplayer::lan::bundled_root().join("seedmap").join("seedmap.exe");
    if !p.exists() {
        return Err(AppError::Msg("种子地图引擎缺失，请检查安装完整性".into()));
    }
    Ok(p)
}

/// 跑一条引擎命令，取回完整 stdout（二进制安全），20s 超时。
async fn run(args: &[String]) -> Result<Vec<u8>, AppError> {
    let exe = exe_path()?;
    let mut cmd = Command::new(&exe);
    cmd.args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW，对齐 JS windowsHide
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = timeout(Duration::from_millis(20_000), cmd.output())
        .await
        .map_err(|_| AppError::Msg("种子地图引擎响应超时".into()))?
        .map_err(|e| AppError::Msg(format!("种子地图引擎启动失败：{e}")))?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Msg(if msg.is_empty() {
            format!("引擎退出码 {}", output.status.code().unwrap_or(-1))
        } else {
            msg
        }));
    }
    Ok(output.stdout)
}

/// "OK\n" 前缀校验后返回裸数据（仅 tile 有此前缀）。
fn expect_ok(buf: &[u8]) -> Result<&[u8], AppError> {
    if buf.len() < 3 || buf[0] != b'O' || buf[1] != b'K' || buf[2] != b'\n' {
        return Err(AppError::Msg("引擎返回格式异常".into()));
    }
    Ok(&buf[3..])
}

/// 解析 "<type> <x> <z>" 或 "<x> <z>" 行，END 结束。
fn parse_point_lines(buf: &[u8]) -> Vec<Value> {
    let mut out = Vec::new();
    for line in String::from_utf8_lossy(buf).lines() {
        let t = line.trim();
        if t.is_empty() || t == "END" {
            break;
        }
        let parts: Vec<&str> = t.split_whitespace().collect();
        if parts.len() >= 3 {
            if let (Ok(ty), Ok(x), Ok(z)) =
                (parts[0].parse::<i64>(), parts[1].parse::<i64>(), parts[2].parse::<i64>())
            {
                out.push(json!({ "type": ty, "x": x, "z": z }));
            }
        } else if parts.len() == 2 {
            if let (Ok(x), Ok(z)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
                out.push(json!({ "x": x, "z": z }));
            }
        }
    }
    out
}

fn str_field<'a>(v: &'a Value, key: &str, default: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn i64_field(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(default)
}

/// 校验 seed 非空并返回原值。
fn check_seed(seed: &str) -> Result<&str, AppError> {
    if seed.trim().is_empty() {
        return Err("请先填写种子".into());
    }
    Ok(seed)
}

// ================= 瓦片（生物群系地图，条带并行） =================

async fn tile(payload: &Value) -> CmdResult<Value> {
    let version = str_field(payload, "version", "1.20").to_string();
    let dim = i64_field(payload, "dim", 0);
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let scale = i64_field(payload, "scale", 4);
    if ![4, 16, 64, 256].contains(&scale) {
        return Err("不支持的缩放级别".into());
    }
    let x = i64_field(payload, "x", 0);
    let z = i64_field(payload, "z", 0);
    let w = i64_field(payload, "w", 128);
    let h = i64_field(payload, "h", 128);
    if w <= 0 || h <= 0 || w > 4096 || h > 4096 {
        return Err("瓦片尺寸非法".into());
    }

    let px_count = (w * h * 3) as usize;
    // 大瓦片横向切成最多 4 条并行（对齐 JS：>40000 像素才分条，TCC 产物单线程较慢）
    let workers = if px_count > 40_000 * 3 { 4usize } else { 1usize };
    let workers = workers.min(h as usize);

    if workers <= 1 {
        let args = vec![
            "tile".to_string(),
            version, dim.to_string(), seed, scale.to_string(),
            x.to_string(), z.to_string(), w.to_string(), h.to_string(),
        ];
        let buf = run(&args).await?;
        let px = expect_ok(&buf)?;
        if px.len() != px_count {
            return Err("瓦片像素长度异常".into());
        }
        return Ok(json!({ "pixels": px.to_vec(), "w": w, "h": h, "scale": scale }));
    }

    let band_h = h / workers as i64;
    let mut handles = Vec::with_capacity(workers);
    for k in 0..workers {
        let bh = if k == workers - 1 { h - band_h * k as i64 } else { band_h };
        let bz = z + band_h * k as i64 * scale;
        let args = vec![
            "tile".to_string(),
            version.clone(), dim.to_string(), seed.clone(), scale.to_string(),
            x.to_string(), bz.to_string(), w.to_string(), bh.to_string(),
        ];
        handles.push(tokio::spawn(async move { run(&args).await }));
    }
    let mut pixels = Vec::with_capacity(px_count);
    for (k, hd) in handles.into_iter().enumerate() {
        let bh = if k == workers - 1 { h - band_h * k as i64 } else { band_h };
        let buf = hd
            .await
            .map_err(|e| AppError::Msg(format!("引擎条带任务失败：{e}")))??;
        let px = expect_ok(&buf)?;
        if px.len() != (w * bh * 3) as usize {
            return Err("瓦片分条像素长度异常".into());
        }
        pixels.extend_from_slice(px);
    }
    Ok(json!({ "pixels": pixels, "w": w, "h": h, "scale": scale }))
}

// ================= 结构 / 要塞 / 出生点 / 史莱姆 / 群系 =================

async fn structures(payload: &Value) -> CmdResult<Vec<Value>> {
    let version = str_field(payload, "version", "1.20").to_string();
    let dim = i64_field(payload, "dim", 0);
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let bx0 = i64_field(payload, "bx0", 0);
    let bz0 = i64_field(payload, "bz0", 0);
    let bx1 = i64_field(payload, "bx1", 0);
    let bz1 = i64_field(payload, "bz1", 0);
    let args = vec![
        "structs".to_string(),
        version, dim.to_string(), seed,
        bx0.to_string(), bz0.to_string(), bx1.to_string(), bz1.to_string(),
    ];
    let buf = run(&args).await?;
    Ok(parse_point_lines(&buf))
}

async fn strongholds(payload: &Value) -> CmdResult<Vec<Value>> {
    let version = str_field(payload, "version", "1.20").to_string();
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let args = vec!["stronghold".to_string(), version, seed];
    let buf = run(&args).await?;
    Ok(parse_point_lines(&buf))
}

async fn spawn_point(payload: &Value) -> CmdResult<Value> {
    let version = str_field(payload, "version", "1.20").to_string();
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let args = vec!["spawn".to_string(), version, seed];
    let buf = run(&args).await?;
    let t = String::from_utf8_lossy(&buf);
    let mut it = t.split_whitespace();
    let x = it.next().and_then(|v| v.parse::<i64>().ok()).ok_or_else(|| AppError::Msg("出生点解析失败".into()))?;
    let z = it.next().and_then(|v| v.parse::<i64>().ok()).ok_or_else(|| AppError::Msg("出生点解析失败".into()))?;
    Ok(json!({ "x": x, "z": z }))
}

async fn slime(payload: &Value) -> CmdResult<Vec<Value>> {
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let cx0 = i64_field(payload, "cx0", 0);
    let cz0 = i64_field(payload, "cz0", 0);
    let cx1 = i64_field(payload, "cx1", 0);
    let cz1 = i64_field(payload, "cz1", 0);
    let args = vec![
        "slime".to_string(),
        seed,
        cx0.to_string(), cz0.to_string(), cx1.to_string(), cz1.to_string(),
    ];
    let buf = run(&args).await?;
    Ok(parse_point_lines(&buf))
}

async fn biome(payload: &Value) -> CmdResult<i64> {
    let version = str_field(payload, "version", "1.20").to_string();
    let dim = i64_field(payload, "dim", 0);
    let seed = check_seed(str_field(payload, "seed", ""))?.to_string();
    let x = i64_field(payload, "x", 0);
    let z = i64_field(payload, "z", 0);
    let args = vec![
        "biome".to_string(),
        version, dim.to_string(), seed, x.to_string(), z.to_string(),
    ];
    let buf = run(&args).await?;
    String::from_utf8_lossy(&buf)
        .trim()
        .parse::<i64>()
        .map_err(|_| AppError::Msg("群系查询解析失败".into()))
}

// ================= 纯算法（不依赖引擎） =================

/// Java Random（48 位 LCG）：next(bits)
fn java_next(s: &mut u64, bits: u32) -> u64 {
    *s = (s.wrapping_mul(0x5deece66d) + 0xb) & 0xffff_ffff_ffff;
    *s >> (48 - bits)
}

/// Java Random.nextInt(bound)：2 的幂走移位，否则拒绝采样（32 位 int 溢出语义）。
fn java_next_int(s: &mut u64, bound: i64) -> i64 {
    if bound <= 0 {
        return 0;
    }
    if bound & -bound == bound {
        return ((bound as u64).wrapping_mul(java_next(s, 31)) >> 31) as i64;
    }
    loop {
        let bits = java_next(s, 31) as i64;
        let val = bits % bound;
        // Java 里 int 运算会 32 位回绕，这里用 i64 算完截断成 i32 判符号
        let t = (bits - val + (bound - 1)) as i32;
        if t < 0 {
            continue;
        }
        return val;
    }
}

/// 判断区块是否为史莱姆区块（Minecraft 官方公式）。
fn is_slime_chunk(world_seed: i64, x: i64, z: i64) -> bool {
    let mixed = (world_seed as i64)
        .wrapping_add(x.wrapping_mul(x).wrapping_mul(4987142))
        .wrapping_add(x.wrapping_mul(5947611))
        .wrapping_add(z.wrapping_mul(z).wrapping_mul(4392871))
        .wrapping_add(z.wrapping_mul(389711));
    let seed = mixed ^ 987234911;
    let mut s = (seed as u64 ^ 0x5deece66d) & 0xffff_ffff_ffff;
    java_next_int(&mut s, 10) == 0
}

/// 区块范围内的史莱姆区块分布 [[cx, cz], ...]
fn slime_chunks(world_seed: i64, cx0: i64, cz0: i64, w: i64, h: i64) -> Vec<Value> {
    let mut out = Vec::new();
    for dz in 0..h {
        for dx in 0..w {
            let cx = cx0 + dx;
            let cz = cz0 + dz;
            if is_slime_chunk(world_seed, cx, cz) {
                out.push(json!([cx, cz]));
            }
        }
    }
    out
}

/// 从存档 level.dat 读取世界种子（gzip + NBT）。
fn seed_from_save(save_dir: &str) -> CmdResult<String> {
    let file = Path::new(save_dir).join("level.dat");
    let bytes = std::fs::read(&file).map_err(|_| AppError::Msg("找不到 level.dat".into()))?;
    let mut gz = flate2::read::GzDecoder::new(&bytes[..]);
    let mut buf = Vec::new();
    gz.read_to_end(&mut buf)
        .map_err(|_| AppError::Msg("level.dat 解压失败".into()))?;
    let value = fastnbt::from_bytes::<fastnbt::Value>(&buf)
        .map_err(|_| AppError::Msg("level.dat 结构异常".into()))?;
    if let fastnbt::Value::Compound(root) = &value {
        if let Some(fastnbt::Value::Compound(data)) = root.get("Data") {
            if let Some(fastnbt::Value::Long(seed)) = data.get("RandomSeed") {
                return Ok(seed.to_string());
            }
        }
    }
    Ok("0".to_string())
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Chunk Base 查询链接（群系 / 结构 / 村庄 / 神殿）。
fn chunkbase_url(seed: &str, version: &str) -> String {
    let v = if version.trim().is_empty() { "1.20" } else { version };
    format!(
        "https://www.chunkbase.com/apps/seed-map#seed={}&platform=java_{}",
        url_encode(seed.trim()),
        url_encode(v)
    )
}

// ================= 命令层 =================

/// channel: lab:slime（纯算法，快查史莱姆区块）
#[tauri::command(rename = "lab:slime")]
pub fn lab_slime(seed: String, cx0: i64, cz0: i64, w: i64, h: i64) -> CmdResult<Value> {
    let s = seed.trim().parse::<i64>().map_err(|_| AppError::Msg("种子无效".into()))?;
    Ok(json!(slime_chunks(s, cx0, cz0, w, h)))
}

/// channel: lab:seedFromSave
#[tauri::command(rename = "lab:seedFromSave")]
pub fn lab_seed_from_save(save_dir: String) -> CmdResult<String> {
    seed_from_save(&save_dir)
}

/// channel: lab:chunkbase
#[tauri::command(rename = "lab:chunkbase")]
pub fn lab_chunkbase(seed: String, version: String) -> String {
    chunkbase_url(&seed, &version)
}

/// channel: lab:seedTile
#[tauri::command(rename = "lab:seedTile")]
pub async fn lab_seed_tile(payload: Value) -> CmdResult<Value> {
    tile(&payload).await
}

/// channel: lab:seedStructs
#[tauri::command(rename = "lab:seedStructs")]
pub async fn lab_seed_structs(payload: Value) -> CmdResult<Vec<Value>> {
    structures(&payload).await
}

/// channel: lab:seedStrongholds
#[tauri::command(rename = "lab:seedStrongholds")]
pub async fn lab_seed_strongholds(payload: Value) -> CmdResult<Vec<Value>> {
    strongholds(&payload).await
}

/// channel: lab:seedSpawn
#[tauri::command(rename = "lab:seedSpawn")]
pub async fn lab_seed_spawn(payload: Value) -> CmdResult<Value> {
    spawn_point(&payload).await
}

/// channel: lab:seedSlime
#[tauri::command(rename = "lab:seedSlime")]
pub async fn lab_seed_slime(payload: Value) -> CmdResult<Vec<Value>> {
    slime(&payload).await
}

/// channel: lab:seedBiome
#[tauri::command(rename = "lab:seedBiome")]
pub async fn lab_seed_biome(payload: Value) -> CmdResult<i64> {
    biome(&payload).await
}
