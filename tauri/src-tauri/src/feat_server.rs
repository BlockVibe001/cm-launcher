//! feat_server.rs — 内置服务器管理（开服）
//! 命令契约固定（main.rs 已接线）：server:setup / server:start / server:stop /
//! server:status / server:input + 事件 server:console。
//!
//! 流程：选择版本+加载器 → 下载 server.jar（Vanilla / Fabric / Forge）→
//! 生成服务端目录（eula.txt + server.properties）→ 一键启动/停止（std::process
//! 后台进程）→ stdout/stderr 按行 emit `server:console` → stdin 输命令。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::net::downloader::download_file;
use crate::net::mirror::mirror_url;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CONSOLE_EVENT: &str = "server:console";

/// 开服进程注册表：dir → 进程句柄。
/// Tauri 已 `.manage(ServerState::new())`；Send+Sync+'static 由 Mutex 保证。
pub struct ServerState {
    inner: Mutex<HashMap<String, ServerProc>>,
}

struct ServerProc {
    name: String,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

impl ServerState {
    pub fn new() -> Self {
        ServerState {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

// ===================== 小工具 =====================

/// 服务端根目录：userData/servers/<name>
fn servers_root() -> PathBuf {
    let root = config::user_data_dir().join("servers");
    let _ = std::fs::create_dir_all(&root);
    root
}

/// 目录名消毒：只留字母数字 - _，其余转 -
fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "server".to_string()
    } else {
        s
    }
}

/// 写服务端元信息（status 回显 name 用）
fn write_meta(dir: &Path, name: &str, mc_version: &str, loader: &str) {
    let v = json!({ "name": name, "mcVersion": mc_version, "loader": loader });
    if let Ok(s) = serde_json::to_string_pretty(&v) {
        let _ = std::fs::write(dir.join(".fx-server.json"), s);
    }
}

fn read_meta(dir: &Path) -> Value {
    std::fs::read(dir.join(".fx-server.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

/// 同步挑 Java：配置 javaPath → 启动器托管 JRE（按 MC 版本匹配）→ PATH 的 java
fn pick_java_sync(mc_version: &str) -> CmdResult<String> {
    let cfg = config::get("javaPath").as_str().unwrap_or("").to_string();
    if !cfg.is_empty() && std::fs::metadata(&cfg).is_ok() {
        return Ok(cfg);
    }
    let list = crate::mc::java::list_installed(); // 已按 major 降序
    let need = crate::mc::java::required_java(mc_version).major;
    if let Some(exact) = list.iter().find(|j| j.major == need) {
        return Ok(exact.path.clone());
    }
    let mut higher: Vec<&crate::mc::java::InstalledJava> = list.iter().filter(|j| j.major > need).collect();
    higher.sort_by_key(|j| j.major);
    if let Some(h) = higher.first() {
        return Ok(h.path.clone());
    }
    if let Some(top) = list.first() {
        return Ok(top.path.clone());
    }
    Ok("java".to_string())
}

// ===================== pid 存活检测（sysinfo） =====================

fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    sys.process(Pid::from_u32(pid)).is_some()
}

fn kill_pid(pid: u32) {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    if let Some(p) = sys.process(Pid::from_u32(pid)) {
        p.kill();
    }
}

/// 清扫已退出的进程条目
fn reap(map: &mut HashMap<String, ServerProc>) {
    let mut dead: Vec<String> = Vec::new();
    for (dir, proc) in map.iter_mut() {
        if let Some(child) = proc.child.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                dead.push(dir.clone());
            }
        }
    }
    for d in dead {
        map.remove(&d);
    }
}

// ===================== 下载 server.jar =====================

/// Vanilla：bmcl 镜像走直链；官方源走 manifest → 版本 json → downloads.server.url
async fn setup_vanilla(mc: &str, jar: &Path) -> CmdResult<()> {
    let url = if config::get("mirror").as_str() == Some("bmcl") {
        format!("https://bmclapi2.bangbang93.com/version/{mc}/server")
    } else {
        let manifest = crate::mc::version::get_manifest(false).await?;
        let entry = manifest
            .get("versions")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(mc)))
            .ok_or_else(|| AppError::Msg(format!("版本清单中找不到版本：{mc}")))?;
        let detail_url = entry.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        if detail_url.is_empty() {
            return Err(AppError::Msg("版本详情 url 为空".into()));
        }
        let res = HTTP
            .get(mirror_url(&detail_url))
            .send()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?;
        if !res.status().is_success() {
            return Err(AppError::Msg(format!("版本详情获取失败 (HTTP {})", res.status().as_u16())));
        }
        let detail: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
        detail
            .pointer("/downloads/server/url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if url.is_empty() {
        return Err(AppError::Msg("未获取到 server.jar 下载地址".into()));
    }
    let cancel = AtomicUsize::new(0);
    download_file(&url, jar, None, &cancel).await?;
    Ok(())
}

/// Fabric：下载 fabric-installer 并用 CLI 装 server（与 forge 同套路）
async fn setup_fabric(mc: &str, loader_version: &str, jar: &Path) -> CmdResult<()> {
    let dir = jar.parent().ok_or_else(|| AppError::Msg("服务端目录异常".into()))?;
    let lv = if loader_version.is_empty() {
        let list: Value = HTTP
            .get(format!("https://meta.fabricmc.net/v2/versions/loader/{mc}"))
            .send()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?
            .json()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?;
        list.as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.get("loader"))
            .and_then(|l| l.get("version"))
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Msg("未找到可用的 Fabric loader 版本".into()))?
            .to_string()
    } else {
        loader_version.to_string()
    };
    // 取最新 fabric-installer 版本
    let inst_list: Value = HTTP
        .get("https://meta.fabricmc.net/v2/versions/installer")
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let inst_ver = inst_list
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.get("version"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Msg("未找到 Fabric installer 版本".into()))?
        .to_string();
    let installer_url = format!(
        "https://maven.fabricmc.net/net/fabricmc/fabric-installer/{inst_ver}/fabric-installer-{inst_ver}.jar"
    );
    let installer = dir.join("fabric-installer.jar");
    let cancel = AtomicUsize::new(0);
    download_file(&installer_url, &installer, None, &cancel).await?;

    let java = pick_java_sync(mc)?;
    let fut = tokio::process::Command::new(&java)
        .arg("-jar")
        .arg(&installer)
        .arg("server")
        .arg("-mcversion").arg(mc)
        .arg("-loader").arg(&lv)
        .arg("-dir").arg(dir)
        .arg("-downloadMinecraft")
        .current_dir(dir)
        .creation_flags(0x08000000)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(180), fut)
        .await
        .map_err(|_| AppError::Msg("Fabric 安装器超时（180s）".to_string()))??;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail: String = tail.chars().rev().take(800).collect::<String>().chars().rev().collect();
        return Err(AppError::Msg(format!(
            "Fabric 安装器退出码 {:?}\n{}",
            out.status.code(),
            tail
        )));
    }
    let _ = std::fs::remove_file(&installer);

    // installer 的 -downloadMinecraft 已经把 vanilla server 放到 <dir>/server.jar，
    // fabric-server-launch.jar 是引导器，properties 里 serverJar=server.jar。
    // 布局保持 installer 原样，start() 会按 loader 选入口 jar。
    let produced = dir.join("fabric-server-launch.jar");
    if !produced.exists() {
        return Err(AppError::Msg("Fabric 安装完成但未找到 fabric-server-launch.jar".into()));
    }
    // 兜底：若 installer 没把 vanilla 下下来（网络受限），我们显式补一份
    if !dir.join("server.jar").exists() || std::fs::metadata(dir.join("server.jar")).map(|m| m.len()).unwrap_or(0) < 1_000_000 {
        setup_vanilla(mc, &dir.join("server.jar")).await?;
    }
    let _ = std::fs::write(
        dir.join("fabric-server-launcher.properties"),
        "serverJar=server.jar\n",
    );
    Ok(())
}

/// 在 Forge installServer 产物里找可运行的服务端 jar
fn find_forge_server_jar(dir: &Path) -> Option<PathBuf> {
    let lib = dir.join("libraries").join("net").join("minecraftforge").join("forge");
    let mut found: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&lib) {
        for e in entries.flatten() {
            if let Ok(files) = std::fs::read_dir(e.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    let n = p.file_name()?.to_string_lossy().to_string();
                    if n.ends_with(".jar") && (n.contains("-server") || n.contains("universal")) {
                        found = Some(p);
                    }
                }
            }
        }
    }
    if found.is_some() {
        return found;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let n = p.file_name()?.to_string_lossy().to_string();
            if n.starts_with("minecraft_server") && n.ends_with(".jar") && n != "server.jar" {
                return Some(p);
            }
        }
    }
    None
}

/// Forge：下载 installer.jar → java -jar installer.jar --installServer <dir>（≤180s）
async fn setup_forge(mc: &str, forge_version: &str, dir: &Path, jar: &Path) -> CmdResult<()> {
    let fv = if forge_version.is_empty() {
        let list: Value = HTTP
            .get(mirror_url(&format!("https://bmclapi2.bangbang93.com/forge/minecraft/{mc}")))
            .send()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?
            .json()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?;
        let arr = list
            .as_array()
            .ok_or_else(|| AppError::Msg("Forge 版本列表解析失败".into()))?;
        arr.iter()
            .find(|v| v.get("recommended").and_then(Value::as_bool) == Some(true))
            .or_else(|| arr.first())
            .and_then(|v| v.get("version").and_then(Value::as_str))
            .ok_or_else(|| AppError::Msg(format!("未找到 {mc} 的 Forge 版本")))?
            .to_string()
    } else {
        forge_version.to_string()
    };

    let java = pick_java_sync(mc)?;
    let installer_url = mirror_url(&format!(
        "https://bmclapi2.bangbang93.com/forge/download?mcversion={mc}&version={fv}&category=installer"
    ));
    let installer = dir.join("forge-installer.jar");
    let cancel = AtomicUsize::new(0);
    download_file(&installer_url, &installer, None, &cancel).await?;

    let fut = tokio::process::Command::new(&java)
        .arg("-jar")
        .arg(&installer)
        .arg("--installServer")
        .arg(dir)
        .current_dir(dir)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    let out = tokio::time::timeout(Duration::from_secs(180), fut)
        .await
        .map_err(|_| AppError::Msg("Forge 安装器超时（180s）".to_string()))??;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail: String = tail.chars().rev().take(800).collect::<String>().chars().rev().collect();
        return Err(AppError::Msg(format!(
            "Forge 安装器退出码 {:?}\n{}",
            out.status.code(),
            tail
        )));
    }
    let _ = std::fs::remove_file(&installer);

    // 把 forge 服务端 jar 硬链（同盘）/拷贝成 server.jar，对齐 start 的固定入口
    let found = find_forge_server_jar(dir)
        .ok_or_else(|| AppError::Msg("Forge 安装完成但未找到服务端 jar".into()))?;
    if found != *jar {
        let _ = std::fs::hard_link(&found, jar).or_else(|_| std::fs::copy(&found, jar).map(|_| ()));
    }
    Ok(())
}

// ===================== 命令 =====================

/// channel: server:setup
/// opts: { mcVersion, loader: "vanilla"|"forge"|"fabric", loaderVersion?, name? }
/// 返回 { ok, error?, dir, serverJar, name }
#[tauri::command(rename = "server:setup")]
pub async fn server_setup(opts: Value, app: tauri::AppHandle) -> CmdResult<Value> {
    let _ = app;
    let mc = opts.get("mcVersion").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let loader = opts
        .get("loader")
        .and_then(Value::as_str)
        .unwrap_or("vanilla")
        .to_lowercase();
    if mc.is_empty() {
        return Ok(json!({ "ok": false, "error": "缺少 MC 版本号（mcVersion）" }));
    }
    if !["vanilla", "fabric", "forge"].contains(&loader.as_str()) {
        return Ok(json!({ "ok": false, "error": format!("未知加载器：{loader}（仅支持 vanilla/fabric/forge）") }));
    }
    let loader_version = opts.get("loaderVersion").and_then(Value::as_str).unwrap_or("").to_string();
    let name_in = opts.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let dir_name = if name_in.is_empty() { format!("{mc}-{loader}") } else { name_in.clone() };
    let display_name = if name_in.is_empty() { format!("{mc} · {loader}") } else { name_in };

    let dir = servers_root().join(sanitize(&dir_name));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Ok(json!({ "ok": false, "error": format!("创建服务端目录失败：{e}") }));
    }
    let jar = dir.join("server.jar");

    let result = match loader.as_str() {
        "vanilla" => setup_vanilla(&mc, &jar).await,
        "fabric" => setup_fabric(&mc, &loader_version, &jar).await,
        "forge" => setup_forge(&mc, &loader_version, &dir, &jar).await,
        _ => return Ok(json!({ "ok": false, "error": format!("未知加载器：{loader}") })),
    };
    if let Err(e) = result {
        return Ok(json!({ "ok": false, "error": e.to_string(), "dir": dir.to_string_lossy() }));
    }

    // eula 同意 + 基础 server.properties
    let _ = std::fs::write(dir.join("eula.txt"), "eula=true\n");
    let _ = std::fs::write(
        dir.join("server.properties"),
        "server-port=25565\nonline-mode=false\nmotd=CM Launcher Server\n",
    );
    write_meta(&dir, &display_name, &mc, &loader);

    Ok(json!({
        "ok": true,
        "dir": dir.to_string_lossy(),
        "serverJar": jar.to_string_lossy(),
        "name": display_name,
    }))
}

/// 后台读线程：按行读 stdout/stderr → emit server:console
fn spawn_reader(app: AppHandle, dir: String, r: impl ReadSend) {
    std::thread::spawn(move || {
        let br = BufReader::new(r);
        for line in br.lines() {
            match line {
                Ok(l) => {
                    let _ = app.emit(CONSOLE_EVENT, json!({ "dir": dir, "line": l }));
                }
                Err(_) => break,
            }
        }
    });
}

trait ReadSend: std::io::Read + Send + 'static {}
impl<T: std::io::Read + Send + 'static> ReadSend for T {}

/// channel: server:start
/// memory 可选 { min?, max? }（单位 MB）。返回 { ok, error?, dir, pid }
#[tauri::command(rename = "server:start")]
pub fn server_start(dir: String, memory: Option<Value>, app: tauri::AppHandle) -> CmdResult<Value> {
    let state = app.state::<ServerState>();
    {
        let mut map = state.inner.lock().unwrap();
        reap(&mut map);
        if map.contains_key(&dir) {
            return Ok(json!({ "ok": false, "error": "该服务端已在运行", "dir": dir }));
        }
    }

    let dirp = PathBuf::from(&dir);
    let meta = read_meta(&dirp);
    let loader = meta.get("loader").and_then(Value::as_str).unwrap_or("vanilla").to_string();
    // fabric 的入口是 fabric-server-launch.jar（引导器），server.jar 是被它引用的 vanilla
    let entry = if loader == "fabric" && dirp.join("fabric-server-launch.jar").exists() {
        dirp.join("fabric-server-launch.jar")
    } else {
        dirp.join("server.jar")
    };
    if !entry.exists() {
        return Ok(json!({ "ok": false, "error": "server.jar 不存在，请先创建服务端", "dir": dir }));
    }

    let mc_guess = meta
        .get("mcVersion")
        .and_then(Value::as_str)
        .unwrap_or("1.20.1")
        .to_string();
    let java = pick_java_sync(&mc_guess)?;
    let max = memory
        .as_ref()
        .and_then(|m| m.get("max"))
        .and_then(Value::as_u64)
        .unwrap_or(2048);
    let min = memory.as_ref().and_then(|m| m.get("min")).and_then(Value::as_u64);

    let mut cmd = Command::new(&java);
    cmd.arg(format!("-Xmx{max}M"));
    if let Some(min) = min {
        cmd.arg(format!("-Xms{min}M"));
    }
    cmd.arg("-jar")
        .arg(&entry)
        .arg("nogui")
        .current_dir(&dirp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Msg(format!("启动 Java 失败（{java}）：{e}")))?;
    let pid = child.id();
    let _ = std::fs::write(dirp.join("server.pid"), pid.to_string());

    let stdin = child.stdin.take();
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(app.clone(), dir.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(app.clone(), dir.clone(), stderr);
    }

    let name = read_meta(&dirp)
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("server")
        .to_string();
    state
        .inner
        .lock()
        .unwrap()
        .insert(dir.clone(), ServerProc { name, child: Some(child), stdin });

    Ok(json!({ "ok": true, "dir": dir, "pid": pid }))
}

/// channel: server:stop
/// 先 stdin "stop" 优雅退出（≤20s），超时强杀；pid 文件兜底。返回 { ok, error? }
#[tauri::command(rename = "server:stop")]
pub fn server_stop(dir: String, app: tauri::AppHandle) -> CmdResult<Value> {
    let state = app.state::<ServerState>();
    let taken = state.inner.lock().unwrap().remove(&dir);

    if let Some(mut proc) = taken {
        if let Some(mut stdin) = proc.stdin.take() {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }
        if let Some(mut child) = proc.child.take() {
            for _ in 0..100 {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                    Err(_) => break,
                }
            }
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let _ = std::fs::remove_file(Path::new(&dir).join("server.pid"));
        return Ok(json!({ "ok": true, "dir": dir }));
    }

    // 状态表没有 → pid 文件兜底
    let pid_file = Path::new(&dir).join("server.pid");
    if let Ok(text) = std::fs::read_to_string(&pid_file) {
        if let Ok(pid) = text.trim().parse::<u32>() {
            if pid_alive(pid) {
                kill_pid(pid);
            }
        }
    }
    let _ = std::fs::remove_file(&pid_file);
    Ok(json!({ "ok": true, "dir": dir }))
}

/// channel: server:status
/// 返回 { servers: [ { dir, name, running, pid? } ] }
#[tauri::command(rename = "server:status")]
pub fn server_status(app: tauri::AppHandle) -> CmdResult<Value> {
    let state = app.state::<ServerState>();
    let mut out: Vec<Value> = Vec::new();
    {
        let mut map = state.inner.lock().unwrap();
        reap(&mut map);
        for (dir, proc) in map.iter() {
            let pid = proc.child.as_ref().map(|c| c.id());
            out.push(json!({ "dir": dir, "name": proc.name, "running": true, "pid": pid }));
        }
    }
    // 扫描 servers/* 兜底（含已退出的历史服务端）
    let root = servers_root();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let dirstr = p.to_string_lossy().to_string();
            if out.iter().any(|v| v.get("dir").and_then(Value::as_str) == Some(dirstr.as_str())) {
                continue;
            }
            let meta = read_meta(&p);
            let name = meta
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&e.file_name().to_string_lossy())
                .to_string();
            let mut running = false;
            let mut pid_out: Option<u32> = None;
            if let Ok(text) = std::fs::read_to_string(p.join("server.pid")) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    if pid_alive(pid) {
                        running = true;
                        pid_out = Some(pid);
                    }
                }
            }
            out.push(json!({ "dir": dirstr, "name": name, "running": running, "pid": pid_out }));
        }
    }
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .cmp(&b.get("name").and_then(Value::as_str))
    });
    Ok(json!({ "servers": out }))
}

/// channel: server:input
/// 向 dir 对应服务端 stdin 写入一行命令。
#[tauri::command(rename = "server:input")]
pub fn server_input(dir: String, line: String, app: tauri::AppHandle) -> CmdResult<()> {
    let state = app.state::<ServerState>();
    let mut map = state.inner.lock().unwrap();
    let proc = map.get_mut(&dir).ok_or_else(|| AppError::Msg("服务端不在运行".to_string()))?;
    let stdin = proc.stdin.as_mut().ok_or_else(|| AppError::Msg("服务端 stdin 不可用".to_string()))?;
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}
