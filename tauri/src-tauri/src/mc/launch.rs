//! 游戏启动：与 Electron 版 minecraft/launch.js 对齐。
//! 关键语义：
//! - classpath：规则过滤 + artifact 路径或 maven 坐标路径（Fabric KnotClient 自愈），dedupe；
//! - 加速档 G1 参数顺序：UnlockExperimentalVMOptions 在实验性选项前；
//! - quickPlay 1.20+；
//! - 游戏进程优先级抬到 ABOVE_NORMAL；stdout/stderr 日志 + LAN 端口探测。

use crate::auth::{microsoft, yggdrasil};
use crate::config;
use crate::error::{AppError, CmdResult};
use crate::events::{EV_GAME_EXIT, EV_GAME_LAN_PORT, EV_GAME_STARTED};
use crate::mc::instance;
use crate::mc::java;
use crate::mc::rules::matches_rules_features;
use crate::mc::version;
use crate::net::downloader::{maven_lib_path, prepare_game};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

const CP_SEP: &str = ";";

/// 处理带规则的参数数组（JVM / game 通用，对应 JS filterArgs）
fn filter_args(args: Option<&Value>, features: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(arr) = args.and_then(Value::as_array) else { return out };
    for item in arr {
        if let Some(s) = item.as_str() {
            out.push(s.to_string());
            continue;
        }
        if let Some(rules) = item.get("rules") {
            if matches_rules_features(rules, features) {
                match item.get("value") {
                    Some(Value::Array(v)) => {
                        for x in v {
                            if let Some(s) = x.as_str() {
                                out.push(s.to_string());
                            }
                        }
                    }
                    Some(v) => {
                        if let Some(s) = v.as_str() {
                            out.push(s.to_string());
                        }
                    }
                    None => {}
                }
            }
        }
    }
    out
}

/// quickPlay 仅 1.20+
fn supports_quick_play(version_id: &str) -> bool {
    regex::Regex::new(r"^1\.(\d+)")
        .unwrap()
        .captures(version_id)
        .and_then(|c| c[1].parse::<i64>().ok())
        .map(|minor| minor >= 20)
        .unwrap_or(false)
}

/// 加速档堆上限：物理内存一半，夹在 2G~8G；只在比配置大时生效
fn boosted_max(configured: i64) -> i64 {
    let sys = sysinfo::System::new_all();
    let total_mb = (sys.total_memory() / 1024 / 1024) as i64;
    let auto = ((total_mb as f64 * 0.5).round() as i64).clamp(2048, 8192);
    configured.max(auto)
}

/// 加速档 JVM 参数（Aikar's flags 思路）。
/// UnlockExperimentalVMOptions 必须在 G1NewSizePercent 前面，否则 JVM 直接退出。
fn boost_args() -> Vec<String> {
    vec![
        "-XX:+UseG1GC".into(),
        "-XX:+UnlockExperimentalVMOptions".into(),
        "-XX:+ParallelRefProcEnabled".into(),
        "-XX:MaxGCPauseMillis=200".into(),
        "-XX:+DisableExplicitGC".into(),
        "-XX:G1NewSizePercent=30".into(),
        "-XX:G1MaxNewSizePercent=40".into(),
        "-XX:G1HeapRegionSize=8M".into(),
        "-XX:G1ReservePercent=20".into(),
        "-XX:G1HeapWastePercent=5".into(),
        "-XX:G1MixedGCCountTarget=4".into(),
        "-XX:InitiatingHeapOccupancyPercent=15".into(),
        "-XX:G1MixedGCLiveThresholdPercent=90".into(),
        "-XX:G1RSetUpdatingPauseTimePercent=5".into(),
        "-XX:SurvivorRatio=32".into(),
        "-XX:MaxTenuringThreshold=1".into(),
        "-XX:+PerfDisableSharedMem".into(),
        "-Dusing.aikars.flags=https://mcflags.emc.gs".into(),
    ]
}

/// 启动可选项：实例级内存/JVM + 快速进入
pub struct LaunchOpts {
    pub max_memory: Option<i64>,
    pub min_memory: Option<i64>,
    pub jvm_args: Option<String>,
    pub quick_play_world: Option<String>,
    pub quick_play_server: Option<String>,
}

fn build_launch_args(vj: &Value, game_dir: &Path, account: &Value, opts: LaunchOpts) -> Vec<String> {
    let id = vj.get("id").and_then(Value::as_str).unwrap_or("");
    let versions_dir = game_dir.join("versions").join(id);
    let natives_dir = versions_dir.join("natives");
    let libraries_dir = game_dir.join("libraries");
    let assets_dir = game_dir.join("assets");

    // ---- classpath ----
    let mut cp_list: Vec<PathBuf> = Vec::new();
    if let Some(libs) = vj.get("libraries").and_then(Value::as_array) {
        for lib in libs {
            if let Some(rules) = lib.get("rules") {
                if !crate::mc::rules::matches_rules_value(rules) {
                    continue;
                }
            }
            if let Some(art_path) = lib.pointer("/downloads/artifact/path").and_then(Value::as_str) {
                cp_list.push(libraries_dir.join(art_path));
                continue;
            }
            // Fabric/Quilt 式：无 artifact 只有 maven 坐标，按坐标算路径
            let name = lib.get("name").and_then(Value::as_str).unwrap_or("");
            let rel = maven_lib_path(name);
            if !rel.is_empty() {
                cp_list.push(libraries_dir.join(rel));
            }
        }
    }
    // 客户端 jar：优先用 downloads.client.path（继承版指向父版本的 client），否则回退 <id>.jar
    if let Some(client_path) = vj.pointer("/downloads/client/path").and_then(Value::as_str) {
        cp_list.push(game_dir.join(client_path));
    } else {
        cp_list.push(versions_dir.join(format!("{id}.jar")));
    }
    // dedupe（Set 语义）
    let mut seen = std::collections::HashSet::new();
    cp_list.retain(|p| seen.insert(p.clone()));
    let classpath = cp_list.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join(CP_SEP);

    let asset_index_id = vj
        .pointer("/assetIndex/id")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| vj.get("assets").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| "legacy".into());

    // 旧版本资源目录推断（virtual / map_to_resources）
    let mut game_assets = assets_dir.clone();
    if let Ok(idx_bytes) = std::fs::read(assets_dir.join("indexes").join(format!("{asset_index_id}.json"))) {
        if let Ok(idx) = serde_json::from_slice::<Value>(&idx_bytes) {
            if idx.get("map_to_resources").and_then(Value::as_bool) == Some(true) {
                game_assets = game_dir.join("resources");
            } else if idx.get("virtual").and_then(Value::as_bool) == Some(true) {
                game_assets = assets_dir.join("virtual").join(&asset_index_id);
            }
        }
    }

    // ---- 占位符替换表 ----
    let mut repl: HashMap<String, String> = HashMap::new();
    let put = |m: &mut HashMap<String, String>, k: &str, v: String| m.insert(k.into(), v);
    put(&mut repl, "natives_directory", natives_dir.to_string_lossy().to_string());
    put(&mut repl, "launcher_name", "CM-Launcher".into());
    put(&mut repl, "launcher_version", "1.0.0".into());
    put(&mut repl, "classpath", classpath.clone());
    put(&mut repl, "classpath_separator", CP_SEP.into());
    put(&mut repl, "library_directory", libraries_dir.to_string_lossy().to_string());
    put(&mut repl, "auth_player_name", account.get("username").and_then(Value::as_str).unwrap_or("").into());
    put(&mut repl, "version_name", id.into());
    put(&mut repl, "game_directory", game_dir.to_string_lossy().to_string());
    put(&mut repl, "assets_root", assets_dir.to_string_lossy().to_string());
    put(&mut repl, "game_assets", game_assets.to_string_lossy().to_string());
    put(&mut repl, "assets_index_name", asset_index_id);
    put(&mut repl, "auth_uuid", account.get("uuid").and_then(Value::as_str).unwrap_or("").into());
    put(&mut repl, "auth_access_token", account.get("accessToken").and_then(Value::as_str).unwrap_or("").into());
    put(
        &mut repl,
        "user_type",
        if account.get("type").and_then(Value::as_str) == Some("microsoft") { "msa".into() } else { "legacy".into() },
    );
    put(&mut repl, "version_type", vj.get("type").and_then(Value::as_str).unwrap_or("release").into());
    put(&mut repl, "user_properties", "{}".into());
    put(
        &mut repl,
        "auth_session",
        format!("token:{}:{}", account.get("accessToken").and_then(Value::as_str).unwrap_or(""), account.get("uuid").and_then(Value::as_str).unwrap_or("")),
    );
    put(&mut repl, "clientid", String::new());
    put(&mut repl, "client_id", String::new());
    put(&mut repl, "auth_xuid", account.get("xuid").and_then(Value::as_str).unwrap_or("").into());
    put(&mut repl, "resolution_width", config::get("width").as_i64().unwrap_or(854).to_string());
    put(&mut repl, "resolution_height", config::get("height").as_i64().unwrap_or(480).to_string());

    let sub = |s: &str| -> String {
        let re = regex::Regex::new(r"\$\{([a-z_]+)\}").unwrap();
        re.replace_all(s, |caps: &regex::Captures| {
            let key = &caps[1];
            repl.get(key).cloned().unwrap_or_else(|| caps.get(0).unwrap().as_str().to_string())
        })
        .to_string()
    };

    let cfg_min = config::get("minMemory").as_i64().unwrap_or(512);
    let cfg_max = config::get("maxMemory").as_i64().unwrap_or(4096);
    let min_mem = opts.min_memory.unwrap_or(cfg_min);
    let max_mem = opts.max_memory.unwrap_or(cfg_max);
    let extra_jvm = opts.jvm_args.unwrap_or_else(|| config::get("jvmArgs").as_str().unwrap_or("").to_string());
    let boost = config::get("speedBoost").as_bool().unwrap_or(true);

    // ---- JVM 参数 ----
    let mut jvm_args = if let Some(jvm) = vj.pointer("/arguments/jvm") {
        filter_args(Some(jvm), None)
    } else {
        vec!["-Djava.library.path=${natives_directory}".into(), "-cp".into(), "${classpath}".into()]
    };
    jvm_args = jvm_args.iter().map(|s| sub(s)).collect();

    // 用户自定义参数
    let extra: Vec<String> = extra_jvm.split_whitespace().map(String::from).collect();

    // 加速档：用户已选 GC 就不重复加；放在用户参数前面，用户仍可覆盖
    let user_picked_gc = extra.iter().any(|a| regex::Regex::new(r"UseG1GC|UseZGC|UseShenandoahGC").unwrap().is_match(a));
    if boost && !user_picked_gc {
        jvm_args.extend(boost_args());
    }
    jvm_args.extend(extra);

    // ---- 游戏参数 ----
    let mut game_args = if let Some(game) = vj.pointer("/arguments/game") {
        // 始终启用自定义分辨率
        filter_args(Some(game), Some(&json!({"has_custom_resolution": true})))
    } else {
        vj.get("minecraftArguments").and_then(Value::as_str).unwrap_or("").split_whitespace().map(String::from).collect()
    };
    game_args = game_args.iter().map(|s| sub(s)).collect();

    // ---- quickPlay ----
    if supports_quick_play(id) {
        if let Some(w) = opts.quick_play_world {
            game_args.push("--quickPlaySingleplayer".into());
            game_args.push(w);
        } else if let Some(s) = opts.quick_play_server {
            game_args.push("--quickPlayMultiplayer".into());
            game_args.push(s);
        }
    }

    let main_class = vj.get("mainClass").and_then(Value::as_str).unwrap_or("").to_string();
    let mem_args = vec![format!("-Xms{min_mem}M"), format!("-Xmx{}M", if boost { boosted_max(max_mem) } else { max_mem })];

    let mut result = mem_args;
    result.extend(jvm_args);
    result.push(main_class);
    result.extend(game_args);
    result
}

/// 从游戏输出行探测「已对局域网开放」端口
fn detect_lan_port(line: &str) -> Option<i64> {
    let patterns = [
        r"(?i)Local game hosted on port (\d{2,5})",
        r"(?i)Started serving on (?:[0-9a-fA-F:.]+:)?(\d{2,5})",
        r"(?i)Started on port (\d{2,5})",
        r"(?i)Opening (?:LAN|to LAN) on port (\d{2,5})",
        r"(?i)Listening on .*:(\d{2,5})",
    ];
    for p in patterns {
        if let Some(c) = regex::Regex::new(p).unwrap().captures(line) {
            return c.get(1).and_then(|m| m.as_str().parse().ok());
        }
    }
    None
}

/// 完整启动流程
pub async fn launch(instance_id: &str, extra: Option<Value>, app: AppHandle) -> CmdResult<bool> {
    // 运行中拒绝重复启动
    let already = {
        let state = app.state::<crate::state::AppState>();
        state.game_running.load(Ordering::SeqCst)
    };
    if already {
        return Err(AppError::Msg("游戏已经在运行中".into()));
    }

    let instance = instance::get_instance(instance_id)
        .or_else(|| instance::get_instance(&config::get("selectedInstance").as_str().unwrap_or("")))
        .ok_or_else(|| AppError::Msg("实例不存在".into()))?;
    let inst_version = instance.get("versionId").and_then(Value::as_str).unwrap_or("");
    if inst_version.is_empty() {
        return Err(AppError::Msg("该实例未选择游戏版本".into()));
    }

    let account = config::get("account");
    if account.is_null() {
        return Err(AppError::Msg("请先登录账号".into()));
    }

    let game_dir_raw = instance.get("gameDir").and_then(Value::as_str).unwrap_or("");
    let game_dir = if !game_dir_raw.is_empty() {
        PathBuf::from(game_dir_raw)
    } else {
        PathBuf::from(config::get("gameDir").as_str().unwrap_or(""))
    };
    tokio::fs::create_dir_all(&game_dir).await?;

    crate::logger::info(&format!(
        "启动实例「{}」，版本：{inst_version}",
        instance.get("name").and_then(Value::as_str).unwrap_or(""),
    ));
    let vj = version::resolve_version_detail(inst_version, &game_dir).await?;

    // 下载/校验全部游戏文件（取消标志走全局状态，game:cancel 直接置位）
    let cancel = {
        let st = app.state::<crate::state::AppState>();
        st.download_cancel.store(0, Ordering::SeqCst);
        st.download_cancel.clone()
    };
    prepare_game(&vj, &game_dir, &app, cancel).await?;

    // 令牌刷新
    let mut acc = account;
    if microsoft::is_microsoft(&acc) {
        crate::logger::info("检查正版登录令牌…");
        acc = microsoft::refresh(acc).await?;
        config::set_account(acc.clone());
    } else if acc.get("type").and_then(Value::as_str) == Some("yggdrasil") {
        crate::logger::info("检查皮肤站登录令牌…");
        acc = yggdrasil::refresh(acc).await;
        config::set_account(acc.clone());
    }

    // 确定 Java：实例级 → 全局 → 自动匹配
    let mut java_path = instance.get("javaPath").and_then(Value::as_str).unwrap_or("").to_string();
    if java_path.is_empty() {
        java_path = config::get("javaPath").as_str().unwrap_or("").to_string();
    }
    if java_path.is_empty() {
        let javas = java::list_javas().await?;
        if javas.is_empty() {
            return Err(AppError::Msg(
                "未找到 Java，请在设置中一键下载或手动指定 java.exe（1.20.5+ 需 Java 21，1.17+ 需 Java 17，旧版需 Java 8）".into(),
            ));
        }
        let picked = java::pick_for(&vj.get("id").and_then(Value::as_str).unwrap_or(""), &javas)
            .or_else(|| javas.first().cloned());
        java_path = picked.as_ref().map(|j| j.path.clone()).unwrap_or_default();
        crate::logger::info(&format!("自动匹配 Java：{}", picked.map(|j| j.major).unwrap_or(0)));
    }
    crate::logger::info(&format!("Java：{java_path}"));

    let memory_val = instance.get("memory");
    let get_mem = |k: &str| memory_val.and_then(|m| m.get(k)).and_then(Value::as_i64);
    let qp_world = extra.as_ref().and_then(|e| e.get("quickPlayWorld")).and_then(Value::as_str).map(String::from);
    let qp_server = extra
        .as_ref()
        .and_then(|e| e.get("quickPlayServer"))
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| instance.get("server").and_then(Value::as_str).map(String::from));

    let args = build_launch_args(
        &vj,
        &game_dir,
        &acc,
        LaunchOpts {
            max_memory: get_mem("max"),
            min_memory: get_mem("min"),
            jvm_args: instance.get("jvmArgs").and_then(Value::as_str).map(String::from),
            quick_play_world: qp_world,
            quick_play_server: qp_server,
        },
    );
    crate::logger::info(&format!("启动游戏：{}，玩家 {}", inst_version, acc.get("username").and_then(Value::as_str).unwrap_or("")));

    let mut cmd = tokio::process::Command::new(&java_path);
    cmd.args(&args)
        .current_dir(&game_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // CREATE_NO_WINDOW：避免任何控制台黑窗闪烁，管道不受影响（tokio 在 Windows 上有同名方法）
    cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn()?;

    // 加速档：优先级抬到 ABOVE_NORMAL
    if config::get("speedBoost").as_bool().unwrap_or(true) {
        if let Some(raw) = child.raw_handle() {
            let handle = raw as windows_sys::Win32::Foundation::HANDLE;
            unsafe {
                windows_sys::Win32::System::Threading::SetPriorityClass(handle, 0x00008000);
            }
        }
    }

    // 标记运行
    app.state::<crate::state::AppState>().game_running.store(true, Ordering::SeqCst);

    // 输出读取 + 监督：任务拥有 child
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(out) = stdout {
            let app2 = app_out.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() { continue; }
                    crate::logger::info(line.trim());
                    if let Some(port) = detect_lan_port(&line) {
                        let _ = app2.emit(EV_GAME_LAN_PORT, json!({"port": port}));
                    }
                }
            });
        }
        if let Some(err) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        crate::logger::warn(line.trim());
                    }
                }
            });
        }
        let status = child.wait().await;
        let code = status.ok().and_then(|s| s.code()).map(|c| i64::from(c)).unwrap_or(-1);
        crate::logger::info(&format!("游戏已退出（退出码 {code}）"));
        app_out.state::<crate::state::AppState>().game_running.store(false, Ordering::SeqCst);
        let _ = app_out.emit(EV_GAME_EXIT, code);
    });

    let _ = app.emit(EV_GAME_STARTED, ());
    Ok(true)
}

/// 只下载/校验版本文件，不启动（首页「下载版本」：成功才建实例）
pub async fn prepare(mc_version: &str, game_dir: Option<&str>, app: AppHandle) -> CmdResult<Value> {
    let dir = PathBuf::from(match game_dir {
        Some(s) => s.to_string(),
        None => config::get("gameDir").as_str().unwrap_or("").to_string(),
    });
    tokio::fs::create_dir_all(&dir).await?;
    let vj = version::resolve_version_detail(mc_version, &dir).await?;
    let cancel = {
        let st = app.state::<crate::state::AppState>();
        st.download_cancel.store(0, Ordering::SeqCst);
        st.download_cancel.clone()
    };
    prepare_game(&vj, &dir, &app, cancel).await?;
    Ok(json!({"id": vj.get("id")}))
}
