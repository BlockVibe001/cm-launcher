//! Axolotl 实验室：配方数据包导出 / 投影工坊 / 模组汉化
//! 对齐 Electron 版 src/main/minecraft/recipe.js + schematic.js + translate.js。
//!
//! 投影缓存：main.rs `.manage(lab::LabState::new())` 注册，
//! lab:schematicOpen 写入 → lab:schematicReplace / lab:schematicExport 读取。
//! 汉化进度沿 events::EV_TRANSLATE_PROGRESS 下发（载荷 { stage: String, pct: i64 }）。
//!
//! NBT 方案：fastnbt 2.6 同时负责读（from_bytes）与写（to_bytes），
//! gzip 用 flate2；与 mc/world.rs 同一套手法，无需手写 NBT 编解码。

use crate::ai;
use crate::config;
use crate::error::{AppError, CmdResult};
use crate::events::EV_TRANSLATE_PROGRESS;
use fastnbt::{ByteArray, Value as NbtValue};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const AIR: &str = "minecraft:air";

/// 实验室状态：当前打开的投影（lab:schematicOpen 写入，Replace/Export 读取）
pub struct LabState {
    /// Some({ path, format, size: {x,y,z}, palette: [String], blocks: [u64], name, author })
    /// 或 None（尚未打开）
    pub schematic: Mutex<Option<Value>>,
}

impl LabState {
    pub fn new() -> Self {
        LabState {
            schematic: Mutex::new(None),
        }
    }
}

/* ================= 通用小工具 ================= */

/// NBT 数值节点 → i64（Byte/Short/Int/Long/Float/Double 通吃）
fn nbt_num(v: Option<&NbtValue>) -> i64 {
    v.and_then(|v| v.as_i64()).unwrap_or(0)
}

fn emit_prog(app: &AppHandle, stage: &str, pct: i64) {
    let _ = app.emit(EV_TRANSLATE_PROGRESS, json!({ "stage": stage, "pct": pct }));
}

/// 统计方块：按 count 降序、剔除 air
fn count_blocks(palette: &[String], blocks: &[u64]) -> Vec<Value> {
    let mut counts = vec![0i64; palette.len()];
    for &b in blocks {
        let i = b as usize;
        if i < counts.len() {
            counts[i] += 1;
        }
    }
    let mut out: Vec<Value> = palette
        .iter()
        .enumerate()
        .filter(|(i, name)| *name != AIR && counts[*i] > 0)
        .map(|(i, name)| json!({ "name": name, "count": counts[i] }))
        .collect();
    out.sort_by(|a, b| b["count"].as_i64().cmp(&a["count"].as_i64()));
    out
}

fn push_recent_schematic(path: &str) {
    let mut list: Vec<Value> = config::get("recentSchematics")
        .as_array()
        .cloned()
        .unwrap_or_default();
    list.retain(|v| v.as_str() != Some(path));
    list.insert(0, Value::String(path.to_string()));
    list.truncate(12);
    config::set("recentSchematics", Value::Array(list));
}

/* ================= Sponge varint 读写 ================= */

fn read_varints(data: &[u8], max_count: usize) -> CmdResult<Vec<u64>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let mut value: u64 = 0;
        let mut position: u32 = 0;
        loop {
            if i >= data.len() {
                return Err("varint 长度异常".into());
            }
            let b = data[i];
            i += 1;
            value |= ((b & 0x7f) as u64) << position;
            if (b & 0x80) == 0 {
                break;
            }
            position += 7;
            if position > 35 {
                return Err("varint 长度异常".into());
            }
        }
        out.push(value);
        if out.len() > max_count {
            return Err("方块数量异常".into());
        }
    }
    Ok(out)
}

fn write_varints(values: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    for &v0 in values {
        let mut v = v0;
        while (v & !0x7f_u64) != 0 {
            out.push((v & 0x7f) as u8 | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
    out
}

/* ================= Litematica BitArray ================= */

fn bit_width_for(palette_size: usize) -> usize {
    let mut bits = 2usize;
    while (1u64 << bits) < palette_size as u64 {
        bits += 1;
    }
    bits.max(2)
}

/// 从 Litematica long 数组里按 bits 位宽取第 index 个调色板下标
fn litematica_bit_get(arr: &[u64], bits: usize, index: usize) -> u64 {
    if bits >= 64 {
        return arr.get(index).copied().unwrap_or(0);
    }
    let start_offset = index * bits;
    let start_arr = start_offset / 64;
    let end_arr = (index * bits + bits - 1) / 64;
    let start_bit = start_offset % 64;
    let mask = (1u64 << bits) - 1;
    let a = arr.get(start_arr).copied().unwrap_or(0);
    if start_arr == end_arr {
        return (a >> start_bit) & mask;
    }
    let end_offset = 64 - start_bit;
    let c = arr.get(end_arr).copied().unwrap_or(0);
    ((a >> start_bit) | (c << end_offset)) & mask
}

/* ================= MCEdit 数字 ID 表 ================= */

fn legacy_name(id: i32) -> String {
    let nm: &str = match id {
        0 => "minecraft:air",
        1 => "minecraft:stone",
        2 => "minecraft:grass_block",
        3 => "minecraft:dirt",
        4 => "minecraft:cobblestone",
        5 => "minecraft:oak_planks",
        7 => "minecraft:bedrock",
        8 | 9 => "minecraft:water",
        10 | 11 => "minecraft:lava",
        12 => "minecraft:sand",
        13 => "minecraft:gravel",
        14 => "minecraft:gold_ore",
        15 => "minecraft:iron_ore",
        16 => "minecraft:coal_ore",
        17 => "minecraft:oak_log",
        18 => "minecraft:oak_leaves",
        20 => "minecraft:glass",
        24 => "minecraft:sandstone",
        35 => "minecraft:white_wool",
        41 => "minecraft:gold_block",
        42 => "minecraft:iron_block",
        43 | 44 => "minecraft:stone_slab",
        45 => "minecraft:bricks",
        46 => "minecraft:tnt",
        47 => "minecraft:bookshelf",
        48 => "minecraft:mossy_cobblestone",
        49 => "minecraft:obsidian",
        50 => "minecraft:torch",
        52 => "minecraft:spawner",
        53 => "minecraft:oak_stairs",
        54 => "minecraft:chest",
        56 => "minecraft:diamond_ore",
        57 => "minecraft:diamond_block",
        58 => "minecraft:crafting_table",
        61 => "minecraft:furnace",
        64 => "minecraft:oak_door",
        65 => "minecraft:ladder",
        67 => "minecraft:cobblestone_stairs",
        73 => "minecraft:redstone_ore",
        79 => "minecraft:ice",
        80 => "minecraft:snow_block",
        82 => "minecraft:clay",
        85 => "minecraft:oak_fence",
        87 => "minecraft:netherrack",
        88 => "minecraft:soul_sand",
        89 => "minecraft:glowstone",
        98 => "minecraft:stone_bricks",
        102 => "minecraft:glass_pane",
        110 => "minecraft:mycelium",
        121 => "minecraft:end_stone",
        129 => "minecraft:emerald_ore",
        133 => "minecraft:emerald_block",
        152 => "minecraft:redstone_block",
        155 => "minecraft:quartz_block",
        159 => "minecraft:white_terracotta",
        _ => "",
    };
    if nm.is_empty() {
        format!("legacy:{id}")
    } else {
        nm.to_string()
    }
}

/* ================= 结构文件解析 ================= */

struct Parsed {
    format: String,
    size: (i64, i64, i64),
    palette: Vec<String>,
    blocks: Vec<u64>,
    name: String,
    author: String,
}

fn from_litematic(map: &HashMap<String, NbtValue>) -> CmdResult<Parsed> {
    let regions = match map.get("Regions") {
        Some(NbtValue::Compound(r)) => r,
        _ => return Err("litematic 缺少 Regions".into()),
    };
    let meta = match map.get("Metadata") {
        Some(NbtValue::Compound(m)) => Some(m),
        _ => None,
    };

    let mut list: Vec<(i64, i64, i64, i64, i64, i64, &HashMap<String, NbtValue>)> = Vec::new();
    let (mut min_x, mut min_y, mut min_z) = (i64::MAX, i64::MAX, i64::MAX);
    let (mut max_x, mut max_y, mut max_z) = (i64::MIN, i64::MIN, i64::MIN);
    for (_name, rnode) in regions.iter() {
        let r = match rnode {
            NbtValue::Compound(m) => m,
            _ => continue,
        };
        let pos = match r.get("Position") {
            Some(NbtValue::Compound(p)) => Some(p),
            _ => None,
        };
        let size = match r.get("Size") {
            Some(NbtValue::Compound(s)) => Some(s),
            _ => None,
        };
        let (px, py, pz) =
            pos.map(|p| (nbt_num(p.get("x")), nbt_num(p.get("y")), nbt_num(p.get("z"))))
                .unwrap_or((0, 0, 0));
        let (sx0, sy0, sz0) =
            size.map(|s| (nbt_num(s.get("x")), nbt_num(s.get("y")), nbt_num(s.get("z"))))
                .unwrap_or((0, 0, 0));
        let (sx, sy, sz) = (sx0.abs(), sy0.abs(), sz0.abs());
        list.push((px, py, pz, sx, sy, sz, r));
        min_x = min_x.min(px);
        min_y = min_y.min(py);
        min_z = min_z.min(pz);
        max_x = max_x.max(px + sx);
        max_y = max_y.max(py + sy);
        max_z = max_z.max(pz + sz);
    }
    if list.is_empty() {
        return Err("litematic 没有可用区域".into());
    }
    let x = (max_x - min_x).max(1);
    let y = (max_y - min_y).max(1);
    let z = (max_z - min_z).max(1);

    let mut palette: Vec<String> = vec![AIR.to_string()];
    let mut name_to_idx: HashMap<String, usize> = HashMap::new();
    name_to_idx.insert(AIR.to_string(), 0);
    let total = (x * y * z) as usize;
    let mut blocks = vec![0u64; total];

    for (px, py, pz, sx, sy, sz, r) in list.iter() {
        let (px, py, pz, sx, sy, sz) = (*px, *py, *pz, *sx, *sy, *sz);
        let raw_pal = match r.get("BlockStatePalette") {
            Some(NbtValue::List(l)) => l,
            _ => continue,
        };
        let mut region_pal: Vec<String> = Vec::new();
        for p in raw_pal {
            let nm = match p {
                NbtValue::Compound(c) => c
                    .get("Name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(AIR),
                _ => AIR,
            };
            region_pal.push(nm.to_string());
        }
        let states: Vec<u64> = match r.get("BlockStates") {
            Some(NbtValue::LongArray(l)) => l.iter().map(|&v| v as u64).collect(),
            _ => vec![],
        };
        let bits = bit_width_for(region_pal.len().max(2));
        let gmap: Vec<usize> = region_pal
            .iter()
            .map(|nm| {
                if let Some(&i) = name_to_idx.get(nm) {
                    i
                } else {
                    let i = palette.len();
                    palette.push(nm.clone());
                    name_to_idx.insert(nm.clone(), i);
                    i
                }
            })
            .collect();

        for yy in 0..sy {
            for zz in 0..sz {
                for xx in 0..sx {
                    let local = ((yy * sz + zz) * sx + xx) as usize;
                    let pi = litematica_bit_get(&states, bits, local) as usize;
                    let g = gmap.get(pi).copied().unwrap_or(0);
                    if g == 0 {
                        continue;
                    }
                    let gx = px - min_x + xx;
                    let gy = py - min_y + yy;
                    let gz = pz - min_z + zz;
                    let idx = (gy * z + gz) * x + gx;
                    if idx >= 0 {
                        let idx = idx as usize;
                        if idx < blocks.len() {
                            blocks[idx] = g as u64;
                        }
                    }
                }
            }
        }
    }

    let name = meta
        .and_then(|m| m.get("Name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let author = meta
        .and_then(|m| m.get("Author"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Parsed {
        format: "litematic".into(),
        size: (x, y, z),
        palette,
        blocks,
        name,
        author,
    })
}

fn from_sponge(map: &HashMap<String, NbtValue>, is_v3: bool) -> CmdResult<Parsed> {
    let holder = if is_v3 {
        match map.get("Blocks") {
            Some(NbtValue::Compound(h)) => h,
            _ => return Err("schem 缺少 Blocks".into()),
        }
    } else {
        map
    };
    let w = nbt_num(holder.get("Width"));
    let h = nbt_num(holder.get("Height"));
    let l = nbt_num(holder.get("Length"));
    if w == 0 || h == 0 || l == 0 {
        return Err("schem 尺寸缺失".into());
    }
    let pal_node = match holder.get("Palette") {
        Some(NbtValue::Compound(p)) => p,
        _ => return Err("schem 缺少 Palette".into()),
    };
    let mut max_idx: i64 = 0;
    for idx in pal_node.values() {
        max_idx = max_idx.max(idx.as_i64().unwrap_or(0));
    }
    let mut idx_to_name: Vec<String> = vec![AIR.to_string(); (max_idx + 1) as usize];
    for (nm, idx) in pal_node.iter() {
        let i = idx.as_i64().unwrap_or(0) as usize;
        if i < idx_to_name.len() {
            idx_to_name[i] = nm.clone();
        }
    }
    let data_node = if is_v3 {
        holder.get("Data")
    } else {
        holder.get("BlockData")
    };
    let bytes: Vec<u8> = match data_node {
        Some(NbtValue::ByteArray(b)) => b.iter().map(|&x| x as u8).collect(),
        _ => return Err("schem 缺少 BlockData".into()),
    };
    let varints = read_varints(&bytes, (w * h * l) as usize + 8)?;
    let total = (w * h * l) as usize;
    let mut blocks = vec![0u64; total];
    for i in 0..total {
        blocks[i] = varints.get(i).copied().unwrap_or(0);
    }
    Ok(Parsed {
        format: "sponge".into(),
        size: (w, h, l),
        palette: idx_to_name,
        blocks,
        name: String::new(),
        author: String::new(),
    })
}

fn from_mcedit(map: &HashMap<String, NbtValue>) -> CmdResult<Parsed> {
    let w = nbt_num(map.get("Width"));
    let h = nbt_num(map.get("Height"));
    let l = nbt_num(map.get("Length"));
    if w == 0 || h == 0 || l == 0 {
        return Err("schematic 尺寸缺失".into());
    }
    let raw = match map.get("Blocks") {
        Some(NbtValue::ByteArray(b)) => b.clone(),
        _ => return Err("schematic 缺少 Blocks".into()),
    };
    let add = match map.get("AddBlocks") {
        Some(NbtValue::ByteArray(a)) => Some(a.clone()),
        _ => None,
    };
    let raw: &[i8] = &raw;
    let total = (w * h * l) as usize;
    if raw.len() < total {
        return Err("schematic Blocks 长度不足".into());
    }
    let mut palette: Vec<String> = Vec::new();
    let mut name_to_idx: HashMap<String, usize> = HashMap::new();
    let mut blocks = vec![0u64; total];
    for i in 0..total {
        // Node Buffer 按无符号字节读，故 i8 → u8
        let mut id = (raw[i] as u8) as i32;
        if let Some(add) = &add {
            let hi = if i % 2 == 0 {
                add[i / 2] & 0x0f
            } else {
                (add[i / 2] >> 4) & 0x0f
            };
            id += (hi as i32) << 8;
        }
        let nm = legacy_name(id);
        let idx = if let Some(&j) = name_to_idx.get(&nm) {
            j
        } else {
            let j = palette.len();
            palette.push(nm.clone());
            name_to_idx.insert(nm, j);
            j
        };
        blocks[i] = idx as u64;
    }
    Ok(Parsed {
        format: "mcedit".into(),
        size: (w, h, l),
        palette,
        blocks,
        name: String::new(),
        author: String::new(),
    })
}

fn read_schematic(path: &str) -> CmdResult<Parsed> {
    let raw = fs::read(path).map_err(|e| AppError::Msg(format!("无法读取文件：{e}")))?;
    let mut dec = GzDecoder::new(&raw[..]);
    let mut decomp = Vec::new();
    dec.read_to_end(&mut decomp)
        .map_err(|_| AppError::Msg("结构文件解压失败，可能已损坏".into()))?;
    let root: NbtValue = fastnbt::from_bytes(&decomp)
        .map_err(|e| AppError::Msg(format!("NBT 解析失败：{e}")))?;
    let map = match &root {
        NbtValue::Compound(m) => m,
        _ => return Err("NBT 根标签不是 Compound".into()),
    };

    if map.contains_key("Regions") {
        return from_litematic(map);
    }
    if let Some(blocks_node) = map.get("Blocks") {
        match blocks_node {
            NbtValue::ByteArray(_) if map.contains_key("Width") => return from_mcedit(map),
            NbtValue::Compound(_) => return from_sponge(map, true),
            _ => {}
        }
    }
    if map.get("Palette").is_some() && map.get("BlockData").is_some() {
        return from_sponge(map, false);
    }
    Err("无法识别的结构文件格式".into())
}

/* ================= jar 解包 / 重打包 ================= */

fn extract_jar(jar: &Path, dest: &Path) -> CmdResult<()> {
    let file = fs::File::open(jar).map_err(|e| AppError::Msg(format!("jar 打开失败：{e}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::Msg(format!("jar 读取失败：{e}")))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Msg(format!("jar 条目读取失败：{e}")))?;
        let name = entry.name().to_string();
        let out = dest.join(&name);
        // 防 zip slip：确保解压目标仍在临时目录内
        if !out.starts_with(dest) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p)?;
            }
            let mut outf = fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut outf)?;
        }
    }
    Ok(())
}

fn repack_dir(dir: &Path, out: &Path) -> CmdResult<()> {
    let f = fs::File::create(out).map_err(|e| AppError::Msg(format!("无法创建 jar：{e}")))?;
    let mut zip = ZipWriter::new(f);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry.map_err(|e| AppError::Msg(format!("遍历临时目录失败：{e}")))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(dir)
            .map_err(|e| AppError::Msg(e.to_string()))?;
        let name = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(&name, opts)
            .map_err(|e| AppError::Msg(format!("写入 zip 失败：{e}")))?;
        let bytes = fs::read(entry.path())?;
        zip.write_all(&bytes)?;
    }
    zip.finish().map_err(|e| AppError::Msg(format!("zip 收尾失败：{e}")))?;
    Ok(())
}

/* ================= 通道实现 ================= */

/// channel: lab:recipeExport —— 配方数据包导出
#[tauri::command(rename = "lab:recipeExport")]
pub async fn lab_recipe_export(payload: Value) -> CmdResult<Value> {
    let ns_raw = payload
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("cm_craft");
    let namespace: String = ns_raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    let namespace = if namespace.is_empty() {
        "cm_craft".to_string()
    } else {
        namespace
    };
    let pack_format = payload.get("packFormat").and_then(Value::as_i64).unwrap_or(15);
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("CM 启动器配方数据包")
        .to_string();
    let recipes = payload
        .get("recipes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if recipes.is_empty() {
        return Err("至少需要一个配方".into());
    }

    let default_name = format!("{namespace}.zip");
    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("数据包", &["zip"])
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(json!({ "canceled": true }));
    };
    let out_path = handle.path().to_path_buf();

    let mcmeta =
        json!({ "pack": { "pack_format": pack_format, "description": description } }).to_string();

    let f = fs::File::create(&out_path).map_err(|e| AppError::Msg(format!("无法创建文件：{e}")))?;
    let mut zip = ZipWriter::new(f);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("pack.mcmeta", opts)
        .map_err(|e| AppError::Msg(format!("写入 zip 失败：{e}")))?;
    zip.write_all(mcmeta.as_bytes())?;

    let mut used: HashSet<String> = HashSet::new();
    for r in recipes.iter() {
        let id_raw = r.get("id").and_then(Value::as_str).unwrap_or("recipe");
        let base: String = id_raw
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let base = if base.is_empty() {
            "recipe".to_string()
        } else {
            base
        };
        let mut id = base.clone();
        let mut k = 2;
        while used.contains(&id) {
            id = format!("{base}_{k}");
            k += 1;
        }
        used.insert(id.clone());

        let json_text = match r.get("json") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => serde_json::to_string_pretty(v)?,
            None => "{}".to_string(),
        };
        let entry_name = format!("data/{namespace}/recipes/{id}.json");
        zip.start_file(&entry_name, opts)
            .map_err(|e| AppError::Msg(format!("写入 zip 失败：{e}")))?;
        zip.write_all(json_text.as_bytes())?;
    }
    zip.finish().map_err(|e| AppError::Msg(format!("zip 收尾失败：{e}")))?;

    Ok(json!({
        "path": out_path,
        "count": recipes.len(),
        "namespace": namespace,
    }))
}

/// channel: lab:schematicOpen —— 打开投影（presetPath 为空则弹打开对话框）
#[tauri::command(rename = "lab:schematicOpen")]
pub async fn lab_schematic_open(app: AppHandle, preset_path: Option<String>) -> CmdResult<Value> {
    let path = match preset_path {
        Some(p) if !p.is_empty() => p,
        _ => {
            let picked = rfd::AsyncFileDialog::new()
                .add_filter("结构文件", &["litematic", "schematic", "schem", "nbt"])
                .pick_file()
                .await;
            match picked {
                Some(h) => h.path().to_string_lossy().to_string(),
                None => return Ok(json!({ "canceled": true })),
            }
        }
    };

    let path_for_parse = path.clone();
    let parsed = tauri::async_runtime::spawn_blocking(move || read_schematic(&path_for_parse))
        .await
        .map_err(|e| AppError::Msg(format!("解析任务失败：{e}")))??;

    let counts = count_blocks(&parsed.palette, &parsed.blocks);
    let result = json!({
        "path": path,
        "format": parsed.format,
        "size": { "x": parsed.size.0, "y": parsed.size.1, "z": parsed.size.2 },
        "palette": parsed.palette,
        "blocks": parsed.blocks,
        "counts": counts,
        "name": parsed.name,
        "author": parsed.author,
    });

    *app.state::<LabState>().schematic.lock().unwrap() = Some(result.clone());
    push_recent_schematic(&path);
    Ok(result)
}

/// channel: lab:schematicReplace —— 替换方块（from→to），改全局调色板
#[tauri::command(rename = "lab:schematicReplace")]
pub fn lab_schematic_replace(app: AppHandle, from: String, to: String) -> CmdResult<Value> {
    let state = app.state::<LabState>();
    let mut guard = state.schematic.lock().unwrap();
    let sch = guard
        .as_mut()
        .ok_or_else(|| AppError::Msg("尚未打开投影".into()))?;

    // 1) 调色板里定位 to；不存在则追加（单独借用 palette）
    let to_idx = {
        let pal = sch
            .get_mut("palette")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| AppError::Msg("投影状态异常".into()))?;
        match pal.iter().position(|v| v.as_str() == Some(to.as_str())) {
            Some(i) => i,
            None => {
                pal.push(Value::String(to.clone()));
                pal.len() - 1
            }
        }
    };

    // 2) 拍一份调色板名字快照（owned），再独占借用 blocks 做替换
    let pal_snapshot: Vec<String> = sch
        .get("palette")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Msg("投影状态异常".into()))?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();

    let mut changed = 0i64;
    {
        let blocks = sch
            .get_mut("blocks")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| AppError::Msg("投影状态异常".into()))?;
        for b in blocks.iter_mut() {
            let bi = b.as_u64().unwrap_or(0) as usize;
            let cur = pal_snapshot.get(bi).map(|s| s.as_str()).unwrap_or("");
            if cur == from {
                *b = Value::from(to_idx as u64);
                changed += 1;
            }
        }
    }

    // 3) 重算 counts 写回
    let palette: Vec<String> = sch
        .get("palette")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let blocks: Vec<u64> = sch
        .get("blocks")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap_or(0))
        .collect();
    let counts = count_blocks(&palette, &blocks);
    sch["counts"] = Value::Array(counts);

    Ok(json!({
        "changed": changed,
        "counts": sch["counts"].clone(),
        "palette": sch["palette"].clone(),
        "blocks": sch["blocks"].clone(),
    }))
}

/// channel: lab:schematicExport —— 导出 Sponge .schem（保存对话框）
#[tauri::command(rename = "lab:schematicExport")]
pub async fn lab_schematic_export(app: AppHandle) -> CmdResult<Value> {
    let sch = app.state::<LabState>().schematic.lock().unwrap().clone();
    let Some(sch) = sch else {
        return Err("尚未打开投影".into());
    };

    let src_path = sch.get("path").and_then(Value::as_str).unwrap_or("schematic");
    let stem = Path::new(src_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("schematic");
    let default_name = format!("{stem}-edited.schem");

    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Sponge 结构文件", &["schem"])
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(json!({ "canceled": true }));
    };
    let out_path = handle.path().to_path_buf();

    let palette: Vec<String> = sch
        .get("palette")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.as_str().unwrap_or(AIR).to_string())
        .collect();
    let blocks: Vec<u64> = sch
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.as_u64().unwrap_or(0))
        .collect();
    let size = sch.get("size").cloned().unwrap_or(json!({}));
    let w = size.get("x").and_then(Value::as_i64).unwrap_or(0);
    let h = size.get("y").and_then(Value::as_i64).unwrap_or(0);
    let l = size.get("z").and_then(Value::as_i64).unwrap_or(0);

    let out_for_nbt = out_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let mut pal_comp: HashMap<String, NbtValue> = HashMap::new();
        for (i, name) in palette.iter().enumerate() {
            pal_comp.insert(name.clone(), NbtValue::Int(i as i32));
        }
        let data_bytes = write_varints(&blocks);
        let data_i8: Vec<i8> = data_bytes.iter().map(|&b| b as i8).collect();
        let mut root: HashMap<String, NbtValue> = HashMap::new();
        root.insert("Version".into(), NbtValue::Int(2));
        root.insert("DataVersion".into(), NbtValue::Int(3465));
        root.insert("Width".into(), NbtValue::Short(w as i16));
        root.insert("Height".into(), NbtValue::Short(h as i16));
        root.insert("Length".into(), NbtValue::Short(l as i16));
        root.insert("PaletteMax".into(), NbtValue::Int(palette.len() as i32));
        root.insert("Palette".into(), NbtValue::Compound(pal_comp));
        root.insert("BlockData".into(), NbtValue::ByteArray(ByteArray::new(data_i8)));

        let nbt_bytes = fastnbt::to_bytes(&NbtValue::Compound(root))
            .map_err(|e| AppError::Msg(format!("NBT 序列化失败：{e}")))?;
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&nbt_bytes)
            .map_err(|e| AppError::Msg(format!("gzip 压缩失败：{e}")))?;
        let gz = enc
            .finish()
            .map_err(|e| AppError::Msg(format!("gzip 收尾失败：{e}")))?;
        fs::write(&out_for_nbt, gz).map_err(|e| AppError::Msg(format!("写入失败：{e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Msg(format!("导出任务失败：{e}")))??;

    Ok(json!({ "path": out_path }))
}

/// channel: lab:translateJar —— 选择 jar → AI 汉化 → 另存新 jar
#[tauri::command(rename = "lab:translateJar")]
pub async fn lab_translate_jar(app: AppHandle) -> CmdResult<Value> {
    let cfg = config::get("ai");
    let api_key = cfg.get("apiKey").and_then(Value::as_str).unwrap_or("");
    if api_key.is_empty() {
        return Err("请先在设置里填写 AI 翻译的 API Key".into());
    }

    let picked = rfd::AsyncFileDialog::new()
        .add_filter("Java 模组包", &["jar"])
        .pick_file()
        .await;
    let Some(jar_handle) = picked else {
        return Ok(json!({ "canceled": true }));
    };
    let jar_path: PathBuf = jar_handle.path().to_path_buf();
    let stem = jar_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("mod")
        .to_string();

    let save_handle = rfd::AsyncFileDialog::new()
        .set_file_name(format!("{stem}-zh_cn.jar"))
        .add_filter("Java 模组包", &["jar"])
        .save_file()
        .await;
    let Some(save_handle) = save_handle else {
        return Ok(json!({ "canceled": true }));
    };
    let out_path: PathBuf = save_handle.path().to_path_buf();

    emit_prog(&app, "解包", 5);

    // 临时目录
    let tmp_dir = std::env::temp_dir().join(format!("cm-jar-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&tmp_dir).map_err(|e| AppError::Msg(format!("创建临时目录失败：{e}")))?;

    let tmp_for_extract = tmp_dir.clone();
    let tmp_for_find = tmp_dir.clone();
    tauri::async_runtime::spawn_blocking(move || extract_jar(&jar_path, &tmp_for_extract))
        .await
        .map_err(|e| AppError::Msg(format!("解包任务失败：{e}")))??;

    // 扫描 assets/<modid>/lang/en_us.json（大小写不敏感）
    let mut lang_files: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(assets) = fs::read_dir(tmp_for_find.join("assets")) {
        for e in assets.flatten() {
            let modid = e.file_name().to_string_lossy().to_string();
            let langdir = e.path().join("lang");
            let Ok(files) = fs::read_dir(&langdir) else { continue };
            for f in files.flatten() {
                let nm = f.file_name().to_string_lossy().to_lowercase();
                if nm == "en_us.json" {
                    lang_files.push((modid.clone(), f.path()));
                }
            }
        }
    }
    if lang_files.is_empty() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("该 jar 内没有找到 assets/<modid>/lang/en_us.json".into());
    }

    let mut translated: i64 = 0;
    let mut done: Vec<String> = Vec::new();
    let total_files = lang_files.len();

    for (fi, (modid, lf)) in lang_files.iter().enumerate() {
        let src_bytes = match fs::read(lf) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let src: Value = match serde_json::from_slice(&src_bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(src_obj) = src.as_object() else { continue };

        let keys: Vec<(String, String)> = src_obj
            .iter()
            .filter_map(|(k, v)| match v {
                Value::String(s) if !s.trim().is_empty() => Some((k.clone(), s.clone())),
                _ => None,
            })
            .collect();
        let keys_len = keys.len();

        let mut result = serde_json::Map::new();
        let batch = 80usize;
        let mut i = 0usize;
        while i < keys.len() {
            let end = (i + batch).min(keys.len());
            let slice: Vec<(String, String)> = keys[i..end].to_vec();
            let pct = 10.0
                + (((fi as f64 + i as f64 / keys_len.max(1) as f64) / total_files as f64) * 80.0);
            let pct = pct.round() as i64;
            emit_prog(
                &app,
                &format!("翻译 {modid}（{end}/{keys_len}）"),
                pct,
            );

            let piece = match ai::translate_batch(&cfg, &slice, "简体中文").await {
                Ok(v) => v,
                Err(e) => {
                    emit_prog(&app, &format!("翻译失败：{e}"), pct);
                    json!({})
                }
            };
            for (k, v) in &slice {
                let t = piece.get(k).and_then(Value::as_str);
                result.insert(k.clone(), Value::String(t.unwrap_or(v).to_string()));
            }
            translated += slice.len() as i64;
            i = end;
        }

        let out_file = lf.parent().unwrap_or(Path::new(".")).join("zh_cn.json");
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(result)) {
            let _ = fs::write(out_file, text);
        }
        done.push(modid.clone());
    }

    emit_prog(&app, "重新打包", 92);
    let tmp_for_pack = tmp_dir.clone();
    let out_for_pack = out_path.clone();
    let pack_res = tauri::async_runtime::spawn_blocking(move || repack_dir(&tmp_for_pack, &out_for_pack))
        .await
        .map_err(|e| AppError::Msg(format!("打包任务失败：{e}")))?;
    let _ = fs::remove_dir_all(&tmp_dir);
    pack_res?;

    emit_prog(&app, "完成", 100);
    Ok(json!({
        "outPath": out_path,
        "translated": translated,
        "files": done,
    }))
}
