//! 拖拽智能识别 / 导入（对齐 Electron 版 src/main/minecraft/dnd.js）。
//! 分类识别：扩展名 + zip 内容嗅探；导入：mod/resourcepack/shaderpack/datapack 复制、
//! world 解压（含 level.dat 校验与路径穿越防护）、modpack（.mrpack 走 crate::mrpack::install_mrpack，
//! CurseForge manifest 就地实现）并保存实例（crate::mc::instance::save_instance）。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::mc::instance::save_instance;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/* ---------- 工具 ---------- */

fn copy_dir_recursive(src: &Path, dest: &Path) -> CmdResult<()> {
    fs::create_dir_all(dest)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let s = e.path();
        let d = dest.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

/// 目标目录内取一个不冲突的路径（对齐 JS uniquePath：重名加 (1)(2)）
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if !name.starts_with('.') => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for k in 1..999 {
        let t = dir.join(format!("{stem} ({k}){ext}"));
        if !t.exists() {
            return t;
        }
    }
    dir.join(format!("{name}-x"))
}

fn copy_into(src: &Path, dest_dir: &Path) -> CmdResult<PathBuf> {
    fs::create_dir_all(dest_dir)?;
    let base_name = src.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let target = unique_path(dest_dir, base_name);
    let md = fs::metadata(src).map_err(|_| AppError::Msg("源文件不存在".into()))?;
    if md.is_dir() {
        copy_dir_recursive(src, &target)?;
    } else {
        fs::copy(src, &target)?;
    }
    Ok(target)
}

/// 过滤掉 macOS 元数据等干扰项（对齐 JS usable）
fn usable_name(n: &str) -> bool {
    !n.contains("__MACOSX/") && !n.ends_with(".DS_Store")
}

/* ---------- 分类 ---------- */

fn finish(base: &Value, kind: &str, detail: &str) -> Value {
    let mut v = base.clone();
    v["kind"] = json!(kind);
    v["detail"] = json!(detail);
    v
}

fn has(dir: &Path, rel: &str) -> bool {
    dir.join(rel).exists()
}

fn classify_dir(dir: &Path, base: &Value) -> Value {
    if has(dir, "level.dat") {
        return finish(base, "world", "世界存档文件夹");
    }
    if has(dir, "modrinth.index.json") {
        return finish(base, "modpack", "Modrinth 整合包目录");
    }
    if has(dir, "META-INF/mods.toml") || has(dir, "fabric.mod.json") || has(dir, "quilt.mod.json") {
        return finish(base, "mod", "模组文件夹");
    }
    if has(dir, "pack.mcmeta") && has(dir, "assets") {
        return finish(base, "resourcepack", "资源包文件夹");
    }
    if has(dir, "pack.mcmeta") && has(dir, "data") {
        return finish(base, "datapack", "数据包文件夹");
    }
    if has(dir, "shaders") {
        return finish(base, "shaderpack", "光影包文件夹");
    }
    if has(dir, "mods") && has(dir, "config") {
        return finish(base, "modpack", "疑似整合包（含 mods / config）");
    }
    finish(base, "unknown", "无法识别的文件夹")
}

fn classify_zip(file: &Path, base: &Value) -> Value {
    let f = match fs::File::open(file) {
        Ok(f) => f,
        Err(e) => return finish(base, "unknown", &format!("压缩包解析失败：{e}")),
    };
    let mut archive = match zip::ZipArchive::new(f) {
        Ok(a) => a,
        Err(e) => return finish(base, "unknown", &format!("压缩包解析失败：{e}")),
    };

    let mut names: Vec<String> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        match archive.by_index(i) {
            Ok(e) => names.push(e.name().replace('\\', "/")),
            Err(_) => names.push(String::new()),
        }
    }
    let mut roots: HashSet<&str> = HashSet::new();
    for n in &names {
        if let Some(r) = n.split('/').next() {
            roots.insert(r);
        }
    }

    let re_mrpack = regex::Regex::new(r"(?i)(^|/)modrinth\.index\.json$").unwrap();
    let re_manifest = regex::Regex::new(r"(?i)(^|/)manifest\.json$").unwrap();
    let re_level = regex::Regex::new(r"(^|/)level\.dat$").unwrap();
    let re_pack = regex::Regex::new(r"(^|/)pack\.mcmeta$").unwrap();
    let re_assets = regex::Regex::new(r"(^|/)assets/").unwrap();
    let re_data = regex::Regex::new(r"(^|/)data/").unwrap();
    let re_shaders_dir = regex::Regex::new(r"(^|/)shaders/").unwrap();
    let re_shader_file = regex::Regex::new(r"(?i)(^|/)shaders/[^/]+\.(fsh|vsh|glsl|csh|gsh)$").unwrap();
    let re_fabric = regex::Regex::new(r"(^|/)fabric\.mod\.json$").unwrap();
    let re_modstoml = regex::Regex::new(r"(?i)(^|/)META-INF/mods\.toml$").unwrap();

    if names.iter().any(|n| re_mrpack.is_match(n)) {
        return finish(base, "modpack", "Modrinth 整合包（.mrpack）");
    }

    // CurseForge 整合包：manifest.json 带 minecraft + files
    if let Some(idx) = names.iter().position(|n| re_manifest.is_match(n)) {
        if let Ok(mut e) = archive.by_index(idx) {
            let mut s = String::new();
            if e.read_to_string(&mut s).is_ok() {
                if let Ok(m) = serde_json::from_str::<Value>(&s) {
                    let has_files = m.get("minecraft").is_some()
                        && m.get("files").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
                    if has_files {
                        let n = m["files"].as_array().map(|a| a.len()).unwrap_or(0);
                        return finish(base, "modpack", &format!("CurseForge 整合包（{n} 个文件）"));
                    }
                }
            }
        }
    }

    if names.iter().any(|n| re_level.is_match(n)) {
        return finish(base, "world", "Minecraft 世界存档");
    }

    if names.iter().any(|n| re_pack.is_match(n)) {
        if names.iter().any(|n| re_assets.is_match(n)) {
            return finish(base, "resourcepack", "资源包");
        }
        if names.iter().any(|n| re_data.is_match(n)) {
            return finish(base, "datapack", "数据包");
        }
        if names.iter().any(|n| re_shaders_dir.is_match(n)) || roots.contains("shaders") {
            return finish(base, "shaderpack", "光影包（含 pack.mcmeta）");
        }
        return finish(base, "resourcepack", "资源包（未发现 assets 目录）");
    }

    if names.iter().any(|n| re_shader_file.is_match(n)) || roots.contains("shaders") {
        return finish(base, "shaderpack", "光影包");
    }

    if names.iter().any(|n| re_fabric.is_match(n)) || names.iter().any(|n| re_modstoml.is_match(n)) {
        return finish(base, "mod", "模组（zip 打包）");
    }

    if roots.contains("mods") && roots.contains("config") {
        return finish(base, "modpack", "疑似整合包（含 mods / config）");
    }

    finish(base, "unknown", "压缩包内容无法识别")
}

fn classify(file: &str) -> Value {
    let p = Path::new(file);
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or(file).to_string();
    let ext = match p.extension().and_then(|s| s.to_str()) {
        Some(e) => format!(".{e}"),
        None => String::new(),
    };
    let st = match fs::metadata(file) {
        Ok(s) => s,
        Err(_) => {
            return json!({ "path": file, "name": name, "ext": ext, "kind": "unknown", "detail": "文件不存在", "size": 0, "isDir": false });
        }
    };
    let is_dir = st.is_dir();
    let size = if is_dir { 0 } else { st.len() };
    let base = json!({ "path": file, "name": name, "ext": ext, "kind": "unknown", "detail": "", "size": size, "isDir": is_dir });

    if is_dir {
        return classify_dir(p, &base);
    }
    match ext.as_str() {
        ".schem" | ".schematic" | ".litematic" | ".nbt" => finish(&base, "schematic", "结构 / 投影文件，可在实验室预览"),
        ".jar" => finish(&base, "mod", "JAR 模组"),
        ".mrpack" => finish(&base, "modpack", "Modrinth 整合包"),
        ".zip" => classify_zip(p, &base),
        ".disabled" => finish(&base, "mod", "已禁用的模组文件"),
        _ => base,
    }
}

/* ---------- 解压世界存档（对齐 dnd.extractWorld） ---------- */

/// 过滤掉 .. / 绝对路径，安全拼出相对组件
fn safe_components(rel: &str) -> Vec<String> {
    let norm = rel.replace('\\', "/");
    let norm = norm.strip_prefix('/').unwrap_or(&norm).to_string();
    let mut comps: Vec<String> = Vec::new();
    for seg in norm.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                comps.pop();
            }
            s => comps.push(s.to_string()),
        }
    }
    comps
}

fn extract_world(zip_path: &Path, saves_dir: &Path) -> CmdResult<Value> {
    let file = fs::File::open(zip_path).map_err(|e| AppError::Msg(format!("打开压缩包失败：{e}")))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Msg(e.to_string()))?;

    // usable 条目（文件、非 macOS 元数据）
    let mut entries: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let e = archive.by_index(i).map_err(|e| AppError::Msg(e.to_string()))?;
        let raw = e.name().replace('\\', "/");
        if e.is_dir() || raw.ends_with('/') {
            continue;
        }
        if !usable_name(&raw) {
            continue;
        }
        entries.push((i, raw));
    }
    if entries.is_empty() {
        return Err(AppError::Msg("压缩包内没有文件".into()));
    }

    let mut roots: HashSet<&str> = HashSet::new();
    for (_, n) in &entries {
        if let Some(r) = n.split('/').next() {
            roots.insert(r);
        }
    }
    let single = roots.len() == 1 && entries.iter().all(|(_, n)| n.contains('/'));
    let root_name = if single { roots.iter().next().copied().unwrap_or("") } else { "" };
    let prefix = if root_name.is_empty() {
        String::new()
    } else {
        format!("{root_name}/")
    };
    let folder = if root_name.is_empty() {
        zip_path.file_stem().and_then(|s| s.to_str()).unwrap_or("world").to_string()
    } else {
        root_name.to_string()
    };

    fs::create_dir_all(saves_dir)?;
    let target = unique_path(saves_dir, &folder);
    fs::create_dir_all(&target)?;
    let base = target.clone();

    let mut count = 0usize;
    for (idx, name) in &entries {
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            name.strip_prefix(&prefix).unwrap_or(name).to_string()
        };
        if rel.is_empty() {
            continue;
        }
        let comps = safe_components(&rel);
        if comps.is_empty() {
            continue;
        }
        let mut dest = base.clone();
        for c in &comps {
            dest = dest.join(c);
        }
        let mut e = archive.by_index(*idx).map_err(|e| AppError::Msg(e.to_string()))?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&dest)?;
        std::io::copy(&mut e, &mut out)?;
        count += 1;
    }

    if !base.join("level.dat").exists() {
        let _ = fs::remove_dir_all(&base);
        return Err(AppError::Msg("压缩包内未找到 level.dat，可能不是世界存档".into()));
    }
    Ok(json!({
        "path": base.to_string_lossy(),
        "name": base.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
        "files": count,
    }))
}

/* ---------- CurseForge 整合包 ---------- */

fn next_instance_dir(game_root: &str, safe_name: &str) -> PathBuf {
    let inst_root = Path::new(game_root).join("instances");
    let mut dir = inst_root.join(safe_name);
    let mut n = 1;
    while dir.exists() {
        n += 1;
        dir = inst_root.join(format!("{safe_name}-{n}"));
    }
    dir
}

fn loader_from_curse_id(id: &str) -> (String, String) {
    let mut it = id.splitn(2, '-');
    let l = it.next().unwrap_or("");
    let v = it.next().unwrap_or("");
    match l {
        "forge" => ("forge".to_string(), v.to_string()),
        "neoforge" => ("neoforge".to_string(), v.to_string()),
        "fabric" => ("fabric".to_string(), v.to_string()),
        "quilt" => ("quilt".to_string(), v.to_string()),
        _ => ("vanilla".to_string(), String::new()),
    }
}

/** 安装 CurseForge 整合包：解压 overrides（模组本体需 API Key，无法自动下载） */
fn install_curse_modpack(zip_path: &Path, game_root: &str) -> CmdResult<Value> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Msg(e.to_string()))?;
    let re_manifest = regex::Regex::new(r"(?i)(^|/)manifest\.json$").unwrap();

    let mut manifest_idx: Option<usize> = None;
    for i in 0..archive.len() {
        let e = archive.by_index(i).map_err(|e| AppError::Msg(e.to_string()))?;
        if re_manifest.is_match(&e.name().replace('\\', "/")) {
            manifest_idx = Some(i);
            break;
        }
    }
    let idx = manifest_idx.ok_or_else(|| AppError::Msg("整合包缺少 manifest.json".into()))?;
    let manifest: Value = {
        let mut e = archive.by_index(idx).map_err(|e| AppError::Msg(e.to_string()))?;
        let mut s = String::new();
        e.read_to_string(&mut s).map_err(|e| AppError::Msg(e.to_string()))?;
        serde_json::from_str(&s)?
    };

    let mc = manifest.get("minecraft").cloned().unwrap_or_else(|| json!({}));
    let raw_name = manifest
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| zip_path.file_stem().and_then(|s| s.to_str()).unwrap_or("modpack"));
    let safe = crate::mrpack::sanitize_name(raw_name);
    let game_dir = next_instance_dir(game_root, &safe);
    fs::create_dir_all(&game_dir)?;
    let gbase = game_dir.clone();

    let re_ov = regex::Regex::new(r"^(?:overrides|client-overrides)/(.+)$").unwrap();
    let mut overrides = 0usize;
    for i in 0..archive.len() {
        let mut e = archive.by_index(i).map_err(|e| AppError::Msg(e.to_string()))?;
        if e.is_dir() {
            continue;
        }
        let raw = e.name().replace('\\', "/");
        if !usable_name(&raw) {
            continue;
        }
        let cap = match re_ov.captures(&raw) {
            Some(c) => c,
            None => continue,
        };
        let rel = cap.get(1).unwrap().as_str();
        if rel.is_empty() {
            continue;
        }
        let comps = safe_components(rel);
        if comps.is_empty() {
            continue;
        }
        let mut dest = gbase.clone();
        for c in &comps {
            dest = dest.join(c);
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&dest)?;
        std::io::copy(&mut e, &mut out)?;
        overrides += 1;
    }

    let ml = mc
        .get("modLoaders")
        .and_then(|m| m.as_array())
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (mod_loader, loader_version) = loader_from_curse_id(ml.get("id").and_then(Value::as_str).unwrap_or(""));

    Ok(json!({
        "gameDir": game_dir.to_string_lossy(),
        "name": safe,
        "versionId": mc.get("version").and_then(Value::as_str).unwrap_or(""),
        "modLoader": mod_loader,
        "loaderVersion": loader_version,
        "overrides": overrides,
        "pending": manifest.get("files").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
    }))
}

/* ---------- 导入 ---------- */

const CATEGORY_DIR: &[(&str, &str)] = &[
    ("mod", "mods"),
    ("resourcepack", "resourcepacks"),
    ("shaderpack", "shaderpacks"),
    ("datapack", "datapacks"),
];

fn category_dir(kind: &str) -> &'static str {
    CATEGORY_DIR
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, v)| *v)
        .unwrap_or("downloads")
}

#[allow(clippy::too_many_arguments)]
async fn import_one(
    app: &AppHandle,
    it: &Value,
    kind: &str,
    label: &str,
    game_dir: &str,
    game_root: &str,
    world_dir: Option<&str>,
    idx: usize,
) -> Value {
    let path = it.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let is_dir = it.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    let ext = it.get("ext").and_then(Value::as_str).unwrap_or("").to_string();
    let detail = it.get("detail").and_then(Value::as_str).unwrap_or("").to_string();
    let p = Path::new(&path);

    let result = async {
        match kind {
            "schematic" => Ok(json!({
                "name": label, "kind": kind, "ok": true,
                "action": "schematic", "path": path,
                "message": "已交给 Axolotl 实验室预览",
            })),
            "unknown" => Ok(json!({
                "name": label, "kind": kind, "ok": false,
                "message": "无法识别类型，可手动选择分类后重试",
            })),
            "world" => {
                let saves_dir = Path::new(game_dir).join("saves");
                fs::create_dir_all(&saves_dir)?;
                let dir: PathBuf;
                let mut files = 0usize;
                if is_dir {
                    let target = unique_path(&saves_dir, p.file_name().and_then(|s| s.to_str()).unwrap_or("world"));
                    copy_dir_recursive(p, &target)?;
                    dir = target;
                } else {
                    let r = extract_world(p, &saves_dir)?;
                    dir = PathBuf::from(r["path"].as_str().unwrap_or(""));
                    files = r["files"].as_u64().unwrap_or(0) as usize;
                }
                if !dir.join("level.dat").exists() {
                    return Err(AppError::Msg("未找到 level.dat，可能不是有效的世界存档".into()));
                }
                let bn = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let msg = if files > 0 {
                    format!("已放入 saves/{bn}（{files} 个文件）")
                } else {
                    format!("已放入 saves/{bn}")
                };
                Ok(json!({ "name": label, "kind": kind, "ok": true, "message": msg }))
            }
            "modpack" => {
                let eff_ext = if ext.is_empty() {
                    p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default()
                } else {
                    ext.clone()
                };
                let is_mrpack = eff_ext == ".mrpack"
                    || (eff_ext == ".zip" && detail.to_lowercase().contains("modrinth.index.json"));
                if is_mrpack {
                    let info = crate::mrpack::install_mrpack(&json!({ "localPath": path }), game_root, app).await?;
                    let ts = now_ms();
                    let instance_id = format!("mp-{ts}-{idx}");
                    save_instance(&instance_id, json!({
                        "name": info["name"], "versionId": info["versionId"], "gameDir": info["gameDir"],
                        "modLoader": info["modLoader"], "loaderVersion": info["loaderVersion"], "icon": "🗃️",
                    }));
                    Ok(json!({
                        "name": label, "kind": kind, "ok": true,
                        "message": format!("已安装为新实例「{}」", info["name"].as_str().unwrap_or("")),
                        "instanceId": instance_id,
                    }))
                } else {
                    let info = install_curse_modpack(p, game_root)?;
                    let ts = now_ms();
                    let instance_id = format!("cf-{ts}-{idx}");
                    save_instance(&instance_id, json!({
                        "name": info["name"], "versionId": info["versionId"], "gameDir": info["gameDir"],
                        "modLoader": info["modLoader"], "loaderVersion": info["loaderVersion"], "icon": "🗃️",
                    }));
                    let overrides = info["overrides"].as_u64().unwrap_or(0);
                    let pending = info["pending"].as_u64().unwrap_or(0);
                    Ok(json!({
                        "name": label, "kind": kind, "ok": true,
                        "message": format!(
                            "已创建实例「{}」，导入 {} 个配置文件；{} 个模组需 CurseForge API Key 才能自动下载",
                            info["name"].as_str().unwrap_or(""), overrides, pending
                        ),
                        "instanceId": instance_id,
                    }))
                }
            }
            _ => {
                let dest_dir = if kind == "datapack" {
                    let wd = world_dir.ok_or_else(|| AppError::Msg("数据包需要先选择目标世界".into()))?;
                    Path::new(wd).join("datapacks")
                } else {
                    Path::new(game_dir).join(category_dir(kind))
                };
                let target = copy_into(p, &dest_dir)?;
                let sub = category_dir(kind);
                let bn = target.file_name().and_then(|s| s.to_str()).unwrap_or("");
                Ok(json!({ "name": label, "kind": kind, "ok": true, "message": format!("已放入 {sub}/{bn}") }))
            }
        }
    }
    .await;

    match result {
        Ok(v) => v,
        Err(e) => {
            crate::logger::warn(&format!("导入「{label}」失败：{e}"));
            json!({ "name": label, "kind": kind, "ok": false, "message": e.to_string() })
        }
    }
}

/// channel: dnd:inspect —— 识别拖入路径
/// 入参 paths: Vec<String>
/// 返回 [{ path, name, ext, kind, detail, size, isDir }]
/// kind ∈ mod/resourcepack/shaderpack/datapack/world/modpack/schematic/unknown
#[tauri::command(rename = "dnd:inspect")]
pub fn dnd_inspect(paths: Vec<String>) -> Value {
    Value::Array(paths.iter().filter(|p| !p.is_empty()).map(|p| classify(p)).collect())
}

/// channel: dnd:import —— 执行导入
/// 入参 items: [{ path, name, kind, ext, detail, isDir }]、opts: { gameDir, gameRoot?, worldDir?, instanceId? }
/// 返回 { results: [{ name, kind, ok, action?, path?, message, instanceId? }], ok, failed, newInstances: [{id,name}] }
/// modpack 安装进度沿 events::EV_MODLOADER_PROGRESS 下发（载荷 { pct, label }）
#[tauri::command(rename = "dnd:import")]
pub async fn dnd_import(app: AppHandle, items: Value, opts: Value) -> CmdResult<Value> {
    let cfg_game_dir = config::get("gameDir").as_str().unwrap_or("").to_string();
    let game_dir = opts
        .get("gameDir")
        .and_then(Value::as_str)
        .unwrap_or(&cfg_game_dir)
        .to_string();
    let game_root = opts
        .get("gameRoot")
        .and_then(Value::as_str)
        .unwrap_or(&game_dir)
        .to_string();
    let world_dir = opts.get("worldDir").and_then(Value::as_str).map(String::from);

    let mut results: Vec<Value> = Vec::new();
    let items_arr = items.as_array().cloned().unwrap_or_default();
    for it in &items_arr {
        let kind = it.get("kind").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let label = it
            .get("name")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| {
                it.get("path")
                    .and_then(Value::as_str)
                    .map(|pp| Path::new(pp).file_name().and_then(|s| s.to_str()).unwrap_or(pp).to_string())
                    .unwrap_or_default()
            });
        let r = import_one(&app, it, &kind, &label, &game_dir, &game_root, world_dir.as_deref(), results.len()).await;
        results.push(r);
    }

    let ok = results.iter().filter(|r| r.get("ok").and_then(Value::as_bool) == Some(true)).count();
    let failed = results.len() - ok;
    let new_instances: Vec<Value> = results
        .iter()
        .filter(|r| r.get("instanceId").is_some())
        .map(|r| json!({ "id": r["instanceId"], "name": r["name"] }))
        .collect();

    Ok(json!({
        "results": results,
        "ok": ok,
        "failed": failed,
        "newInstances": new_instances,
    }))
}

/// channel: world:installUrl —— 世界 zip 直链下载并解压进 saves
/// 入参 url: String、gameDir: Option<String>（缺省用 config gameDir）
/// 返回 { path, name, files }（对齐 dnd.extractWorld 返回值）
#[tauri::command(rename = "world:installUrl")]
pub async fn world_install_url(url: String, game_dir: Option<String>) -> CmdResult<Value> {
    let u = url.trim().to_string();
    let low = u.to_ascii_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) {
        return Err(AppError::Msg("请填写 http/https 的世界 zip 直链".into()));
    }
    let dir = match game_dir {
        Some(d) if !d.is_empty() => d,
        _ => config::get("gameDir").as_str().unwrap_or("").to_string(),
    };
    let ts = now_ms();
    let tmp = std::env::temp_dir().join(format!("cm-world-url-{ts}.zip"));

    let resp = crate::net::HTTP
        .get(crate::net::mirror::mirror_url(&u))
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!("下载失败 HTTP {}", resp.status().as_u16())));
    }
    let body = resp.bytes().await.map_err(|e| AppError::Msg(e.to_string()))?;
    tokio::fs::write(&tmp, &body).await?;

    let saves = Path::new(&dir).join("saves");
    let r = extract_world(&tmp, &saves);
    let _ = fs::remove_file(&tmp);
    r
}
