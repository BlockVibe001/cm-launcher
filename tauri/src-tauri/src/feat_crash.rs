//! feat_crash.rs — 崩溃日志自动归因
//! 命令契约已由集成层固定并接入 main.rs，**禁止改名/改通道**；函数体可自由实现。
//!
//! 功能：读取 game_dir/crash-reports/*.txt 与 game_dir/logs/latest.log，
//! 按优先级识别 内存不足 / Java 版本不匹配 / 缺少前置依赖 / 模组崩溃 / 未知，
//! 输出中文 summary + suggestions + 关键片段 detail。

use crate::error::CmdResult;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 文件读取上限：512KB（与 mc/content.rs read_log_file 对齐）。
const READ_CAP: usize = 512 * 1024;

/* ---------- 基础工具 ---------- */

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 在 game_dir 白名单内读取文本文件（超限取尾部，与 content.rs 语义一致）。
/// rel 为空时读 logs/latest.log。
fn read_target(game_dir: &str, rel: &str) -> Result<String, String> {
    let game_abs = Path::new(game_dir)
        .canonicalize()
        .map_err(|e| format!("游戏目录不可用：{e}"))?;
    let rel_path = if rel.trim().is_empty() {
        PathBuf::from("logs").join("latest.log")
    } else {
        PathBuf::from(rel)
    };
    let full = game_abs.join(&rel_path);
    if let Ok(fa) = fs::canonicalize(&full) {
        if !fa.starts_with(&game_abs) {
            return Err("非法路径".into());
        }
        let mut buf = Vec::new();
        fs::File::open(&fa)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&buf).to_string();
        return Ok(truncate_tail(text, READ_CAP));
    }
    // 目标文件尚不存在：让上层给空态，不在这里报错
    Err("日志文件不存在".into())
}

fn truncate_tail(text: String, max: usize) -> String {
    if text.len() > max {
        let start = text.len() - max;
        format!("…（仅显示最后 {}KB）\n{}", max / 1024, &text[start..])
    } else {
        text
    }
}

/* ---------- crash:list ---------- */

/// channel: crash:list
/// 列出崩溃报告与最新日志概览：{ items: [ { name, rel, kind, size, mtime } ] }
#[tauri::command(rename = "crash:list")]
pub fn crash_list(game_dir: String) -> CmdResult<Value> {
    let game_path = Path::new(&game_dir);
    let mut items: Vec<Value> = Vec::new();

    // crash-reports/*.txt
    let cr = game_path.join("crash-reports");
    if let Ok(entries) = fs::read_dir(&cr) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".txt") {
                continue;
            }
            let full = entry.path();
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !md.is_file() {
                continue;
            }
            items.push(json!({
                "name": name,
                "rel": format!("crash-reports/{name}"),
                "kind": "crash",
                "size": md.len(),
                "mtime": mtime_ms(&full),
            }));
        }
    }

    // logs/latest.log
    let latest = game_path.join("logs").join("latest.log");
    if let Ok(md) = fs::metadata(&latest) {
        if md.is_file() {
            items.push(json!({
                "name": "latest.log",
                "rel": "logs/latest.log",
                "kind": "log",
                "size": md.len(),
                "mtime": mtime_ms(&latest),
            }));
        }
    }

    // 新的在前，便于前端直接取「最新崩溃」
    items.sort_by(|a, b| {
        let ma = a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let mb = b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        mb.cmp(&ma)
    });

    Ok(json!({ "items": items }))
}

/* ---------- 归因分析 ---------- */

/// 从栈帧行提取可疑 mod id：
/// 形如 `at com.example.mymod.CrashyMod.hurt(CrashyMod.java:42)`，
/// 排除 vanilla / 加载器 / 常用库包名后，取 mod 约定包段（含 mods/ 则其后一段，
/// 否则类名前最后一个小写包段），命中停用词则再向上取一段。
fn extract_mod_token(text: &str) -> Option<String> {
    const EXCLUDE: &[&str] = &[
        "java.",
        "javax.",
        "jdk.",
        "sun.",
        "com.sun.",
        "net.minecraft.",
        "net.fabricmc.loader",
        "net.fabricmc.api",
        "net.fabricmc.fabric",
        "net.fabricmc.mapping",
        "net.fabricmc.accesswidener",
        "net.minecraftforge.",
        "net.neoforged.",
        "cpw.mods.",
        "org.spongepowered.asm",
        "org.objectweb.asm",
        "com.google.",
        "com.mojang.",
        "io.netty.",
        "org.lwjgl.",
        "org.apache.",
        "org.slf4j",
        "org.jetbrains",
        "kotlin.",
        "kotlinx.",
        "net.digitalingot.",
        "net.sf.",
        "it.unimi.dsi",
        "org.sqlite.",
        "com.jcraft.",
    ];

    // 1) 显式声明优先：Forge「Failed to load mod X」/ Fabric「Mod 'X' (x)」
    for line in text.lines() {
        let l = line.to_lowercase();
        if let Some(idx) = l.find("failed to load mod") {
            let tail = &line[idx + "failed to load mod".len()..];
            if let Some(tok) = take_mod_token(tail) {
                return Some(tok);
            }
        }
        if l.contains("mod '") && l.contains(")") {
            if let Some(start) = line.find('(') {
                let inner: String = line[start + 1..]
                    .chars()
                    .take_while(|c| *c != ')')
                    .collect();
                let inner = inner.trim();
                if is_mod_token(inner) {
                    return Some(inner.to_string());
                }
            }
        }
    }

    // 2) 栈帧扫描：找第一个不属于白名单库的包
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with("at ") {
            continue;
        }
        // at <class>.<method>(<file>:line)
        let sig = t.trim_start_matches("at ").split('(').next().unwrap_or("");
        let sig_lower = sig.to_lowercase();
        if EXCLUDE.iter().any(|p| sig_lower.starts_with(p)) {
            continue;
        }
        let mut parts: Vec<&str> = sig.split('.').collect();
        if parts.len() < 3 {
            continue;
        }
        // 最后一段是方法名（小写开头），倒数第二段是类名（大写开头）
        let _method = parts.pop();
        let class = parts.pop().unwrap_or("");
        if !class.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
            continue;
        }
        // 若包段里有 mods/，取它后一段
        if let Some(pos) = parts.iter().position(|s| *s == "mods") {
            if pos + 1 < parts.len() && is_mod_token(parts[pos + 1]) {
                return Some(parts[pos + 1].to_string());
            }
        }
        // 否则从尾部向上取第一个非停用词段
        for seg in parts.iter().rev() {
            if is_mod_token(seg) {
                return Some(seg.to_string());
            }
        }
    }
    None
}

fn is_mod_token(s: &str) -> bool {
    if s.len() < 3 || s.len() > 40 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn take_mod_token(s: &str) -> Option<String> {
    let tok: String = s
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    let tok = tok.trim_matches('.');
    if is_mod_token(tok.rsplit('.').next().unwrap_or(tok)) {
        Some(tok.rsplit('.').next().unwrap_or(tok).to_string())
    } else {
        None
    }
}

/// 截取关键 10~20 行原文：定位首个 exception/caused by/error 行起取 ~18 行。
fn pick_detail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| {
            let l = l.to_lowercase();
            l.contains("exception") || l.contains("caused by") || l.contains("error")
        })
        .unwrap_or(0);
    let end = (start + 18).min(lines.len());
    lines[start..end].join("\n")
}

/* ---------- crash:analyze ---------- */

/// channel: crash:analyze
/// rel 为空时分析 logs/latest.log；否则分析对应崩溃报告。
/// 返回 { ok, kind, modName?, summary, suggestions: [String], detail }
#[tauri::command(rename = "crash:analyze")]
pub fn crash_analyze(game_dir: String, rel: String) -> CmdResult<Value> {
    let text = match read_target(&game_dir, &rel) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => {
            return Ok(json!({
                "ok": false,
                "kind": "none",
                "summary": "未找到可分析的日志文件",
                "suggestions": [],
                "detail": "",
            }));
        }
    };

    let lower = text.to_lowercase();
    let detail = pick_detail(&text);

    // 优先级判定：memory > java > dependency > mod > unknown
    let (kind, mod_name, summary, suggestions): (&str, Option<String>, String, Vec<String>) =
        if lower.contains("outofmemoryerror")
            || lower.contains("there is not enough space")
            || lower.contains("java heap space")
        {
            (
                "memory",
                None,
                "游戏内存不足（Java 堆溢出），JVM 内存耗尽导致崩溃。".into(),
                vec![
                    "调大游戏最大内存：建议把 -Xmx 设到 4G 以上（启动器「实例设置」里可改）".into(),
                    "关闭浏览器、直播、解压等后台占内存程序后再启动".into(),
                    "若模组很多，可精简整合包或分配更多物理内存".into(),
                ],
            )
        } else if lower.contains("unsupportedclassversionerror")
            || lower.contains("class file version")
            || lower.contains("requires java")
            || lower.contains("unsupported major.minor version")
        {
            (
                "java",
                None,
                "Java 版本与游戏/模组要求不匹配。".into(),
                vec![
                    "按提示安装对应 Java 版本（启动器「Java」页可自动下载）".into(),
                    "提示：MC 1.17 及以上需要 Java 17，1.16.5 及以下用 Java 8".into(),
                    "在实例设置里确认已指定正确的 Java 路径".into(),
                ],
            )
        } else if lower.contains("noclassdeffounderror")
            || lower.contains("nofielderror")
            || lower.contains("nosuchmethoderror")
            || lower.contains("could not find required mod")
            || lower.contains("unmet dependency")
            || lower.contains("missing mod")
            || lower.contains("requires mod")
        {
            (
                "dependency",
                None,
                "缺少模组前置依赖，或依赖版本与游戏/加载器不一致。".into(),
                vec![
                    "按日志提示补齐缺失的前置依赖模组（如 Fabric API、Kotlin 等）".into(),
                    "确认所有模组版本与游戏版本、模组加载器一致".into(),
                    "检查最近是否误删或禁用了某个被依赖的模组".into(),
                ],
            )
        } else {
            match extract_mod_token(&text) {
                Some(m) => {
                    let sugs = vec![
                        format!("尝试更新或回滚模组「{m}」到稳定版本"),
                        format!("临时移除模组「{m}」逐一测试，确认是否为它导致"),
                        format!("检查「{m}」与其他模组之间是否存在冲突"),
                    ];
                    (
                        "mod",
                        Some(m.clone()),
                        format!("检测到模组「{m}」相关的崩溃，问题很可能由该模组引起。"),
                        sugs,
                    )
                }
                None => (
                    "unknown",
                    None,
                    "未能自动识别崩溃原因，日志里没有匹配到常见崩溃模式。".into(),
                    vec![
                        "展开下方完整日志，定位首个 Exception 附近的行".into(),
                        "逐个禁用最近安装的模组，二分排查可疑项".into(),
                        "带上完整崩溃报告到社区（MC 百科 / Modrinth / 贴吧）求助".into(),
                    ],
                ),
            }
        };

    let mut out = json!({
        "ok": true,
        "kind": kind,
        "summary": summary,
        "suggestions": suggestions,
        "detail": detail,
    });
    if let Some(m) = mod_name {
        out["modName"] = json!(m);
    }
    Ok(out)
}
