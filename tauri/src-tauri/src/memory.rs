//! 系统内存：信息 / 推荐 / 清理。移植自 Electron 版 system/memory.js。

use crate::error::CmdResult;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::process::Stdio;
use std::time::Duration;
use sysinfo::{MemoryRefreshKind, Pid, RefreshKind, System};
use tokio::process::Command;
use tokio::time::{sleep, timeout};

const MB: u64 = 1024 * 1024;
/// CREATE_NO_WINDOW，对齐 JS execFile 的 windowsHide。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 系统物理内存（总字节, 可用字节）。available_memory 对齐 JS 的 os.freemem()。
fn system_memory() -> (u64, u64) {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()),
    );
    sys.refresh_memory();
    (sys.total_memory(), sys.available_memory())
}

/// 启动器自身进程树（当前进程 + 全部后代，含 WebView2 子进程链）的工作集合计与 pid 列表。
/// 对应 JS 的 appWorkingSetBytes() + app.getAppMetrics() 取 pid。
fn launcher_processes() -> (u64, Vec<u32>) {
    let sys = System::new_all();
    let cur = match sysinfo::get_current_pid() {
        Ok(p) => p,
        Err(_) => return (0, Vec::new()),
    };
    let procs = sys.processes();
    let mut seen: HashSet<Pid> = HashSet::from([cur]);
    let mut stack = vec![cur];
    while let Some(p) = stack.pop() {
        for (pid, pr) in procs {
            if pr.parent() == Some(p) && seen.insert(*pid) {
                stack.push(*pid);
            }
        }
    }
    let mut bytes = 0u64;
    let mut pids = Vec::with_capacity(seen.len());
    for pid in seen {
        if let Some(pr) = procs.get(&pid) {
            bytes = bytes.saturating_add(pr.memory());
            pids.push(pid.as_u32());
        }
    }
    pids.sort_unstable();
    (bytes, pids)
}

/// channel: memory:info（无参）—— 系统与启动器自身的内存占用。
#[tauri::command(rename = "memory:info")]
pub async fn memory_info() -> CmdResult<Value> {
    let (total, free) = system_memory();
    let used = total.saturating_sub(free);
    let (proc_bytes, _) = launcher_processes();
    let mb = |v: u64| (v as f64 / MB as f64).round() as u64;
    let pct = if total > 0 {
        (used as f64 / total as f64 * 100.0).round() as u64
    } else {
        0
    };
    Ok(json!({
        "totalBytes": total,
        "freeBytes": free,
        "usedBytes": used,
        "processBytes": proc_bytes,
        "totalMB": mb(total),
        "freeMB": mb(free),
        "usedMB": mb(used),
        "processMB": mb(proc_bytes),
        "usedPercent": pct,
    }))
}

/// 分档表：物理内存越大，单档跨度越大（与 JS LADDER 一致，末档为上限无穷）。
const LADDER: &[(u64, i64, &str)] = &[
    (4096, 1024, "≤4GB"),
    (6144, 2048, "4~6GB"),
    (8192, 3072, "6~8GB"),
    (12288, 4096, "8~12GB"),
    (16384, 6144, "12~16GB"),
    (24576, 8192, "16~24GB"),
    (32768, 12288, "24~32GB"),
    (65536, 16384, "32~64GB"),
    (u64::MAX, 24576, ">64GB"),
];

/// channel: memory:recommend（无参）—— 推荐 Minecraft 最大内存（MB），口径对齐 PCL2：
/// 分档基准 → 物理一半硬上限 → 可用 80% 收紧 → 256MB 对齐。
#[tauri::command(rename = "memory:recommend")]
pub async fn memory_recommend() -> CmdResult<Value> {
    let (total_b, free_b) = system_memory();
    let total = (total_b as f64 / MB as f64).round() as i64;
    let free = (free_b as f64 / MB as f64).round() as i64;

    let step = LADDER
        .iter()
        .find(|s| total <= s.0 as i64)
        .unwrap_or(&LADDER[LADDER.len() - 1]);
    let base = step.1;

    let cap_half = total / 2;
    let cap_free = (free as f64 * 0.8).floor() as i64;
    let align256 = |v: i64| (v as f64 / 256.0).round() as i64 * 256;
    let recommended = align256(base.min(cap_half).min(cap_free))
        .max(1024)
        .min(align256(base));
    let min_recommended = ((recommended as f64 / 4.0 / 128.0).round() as i64 * 128).max(512);

    Ok(json!({
        "recommended": recommended,
        "minRecommended": min_recommended,
        "totalMB": total,
        "freeMB": free,
        "totalGB": (total as f64 / 1024.0 * 10.0).round() / 10.0,
        "band": step.2,
        "limitMB": cap_half.min(cap_free),
        "isBase": recommended == align256(base),
    }))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64（带填充）。仅为 PowerShell -EncodedCommand 服务，避免引入 base64 crate。
fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((*c.get(1).unwrap_or(&0) as u32) << 8)
            | (*c.get(2).unwrap_or(&0) as u32);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// -EncodedCommand 要求脚本的 UTF-16LE 字节再做 base64。
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64_encode(&bytes)
}

fn powershell() -> Command {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
    ])
    .creation_flags(CREATE_NO_WINDOW)
    .kill_on_drop(true)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    cmd
}

/// 不提权执行脚本，返回 trim 后的 stdout（启动失败 / 超时 / 非零退出 → 空串，对齐 JS runPowerShell）。
async fn run_powershell(script: &str, timeout_ms: u64) -> String {
    let child = powershell()
        .args(["-EncodedCommand", &encode_command(script)])
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    match timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// 弹 UAC 提权运行脚本并等待结束，返回是否被用户取消。
/// 外层（不提权）PowerShell 用 Start-Process -Verb RunAs -Wait 拉起提权进程；
/// UAC 点否 → Start-Process 抛异常 → 输出 CANCELLED（对齐 JS runElevated）。
async fn run_elevated(script: &str, timeout_ms: u64) -> bool {
    let outer = format!(
        "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}'); Write-Output ('EXIT ' + $p.ExitCode) }} catch {{ Write-Output 'CANCELLED' }}",
        encode_command(script)
    );
    let child = match powershell().args(["-Command", &outer]).spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    match timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).contains("CANCELLED"),
        _ => false,
    }
}

/// P/Invoke 类型 + 公共 helper（普通 / 提权进程各自编译一次）。
const PS_COMMON: &str = r#"
$ErrorActionPreference = 'Stop'
$cs = @'
using System;
using System.Runtime.InteropServices;
namespace CMm {
  public class Api {
    [DllImport("ntdll.dll")]
    public static extern int NtSetSystemInformation(int infoClass, IntPtr info, int length);
    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(IntPtr hProc);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr h, int access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValue(string host, string name, out long luid);
    [DllImport("advapi32.dll")]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TP newState,
        int len, IntPtr prev, IntPtr retLen);
    [StructLayout(LayoutKind.Sequential)]
    struct TP { public int Count; public long Luid; public int Attr; }
    public static bool EnablePrivilege(string name) {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), 0x0028, out token)) return false;
      long luid;
      if (!LookupPrivilegeValue(null, name, out luid)) return false;
      TP tp;
      tp.Count = 1; tp.Luid = luid; tp.Attr = 2;
      return AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    }
  }
}
'@
if (-not ('CMm.Api' -as [type])) { Add-Type -TypeDefinition $cs }

# SystemMemoryListInformation = 80；命令：1 EmptyWorkingSets / 2 FlushModified /
# 3 PurgeStandby / 4 PurgeLowPriorityStandby
function Invoke-MemList($command) {
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
  [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 0, [int]$command)
  [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 4, 0)
  $status = [CMm.Api]::NtSetSystemInformation(80, $ptr, 8)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  return $status
}

# 修剪指定 pid（自身进程，必成）
function Trim-Self($pids) {
  $n = 0
  foreach ($id in $pids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { try { if ([CMm.Api]::EmptyWorkingSet($p.Handle)) { $n++ } } catch {} }
  }
  return $n
}

# 修剪除自身外的全部进程（需要相应权限，收不动静默跳过）
function Trim-Others($pidSet) {
  $n = 0
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    if (-not $pidSet.ContainsKey($p.Id)) {
      try { if ([CMm.Api]::EmptyWorkingSet($p.Handle)) { $n++ } } catch {}
    }
  }
  return $n
}

# 收缩系统文件缓存：SystemFileCacheInformation = 21，x64 结构 48 字节，
# CurrentSize / PeakSize 填 -1 表示尽可能缩小（需 SeProfileSingleProcessPrivilege）
function Shrink-FileCache {
  if (-not [Environment]::Is64BitProcess) { return -1001 }
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  for ($i = 0; $i -lt 48; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($ptr, $i, 0) }
  [Runtime.InteropServices.Marshal]::WriteIntPtr($ptr, 0, [IntPtr][int64]-1)
  [Runtime.InteropServices.Marshal]::WriteIntPtr($ptr, 8, [IntPtr][int64]-1)
  $status = [CMm.Api]::NtSetSystemInformation(21, $ptr, 48)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  return $status
}
"#;

fn pid_list(pids: &[u32]) -> String {
    pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

/// 1~2 级：不提权脚本，输出 SELF n / SYS n。
fn build_normal_script(level: i64, pids: &[u32]) -> String {
    let list = pid_list(pids);
    format!(
        r#"{PS_COMMON}
$pids = @({list})
$pidSet = @{{}}
foreach ($i in $pids) {{ $pidSet[[int]$i] = $true }}

$self = Trim-Self $pids
$sys = if ({level} -ge 2) {{ Trim-Others $pidSet }} else {{ 0 }}
Write-Output ("SELF " + $self)
Write-Output ("SYS " + $sys)
"#
    )
}

/// 3~6 级：提权脚本，JSON 结果写到结果文件（PowerShell Encoding Unicode = UTF-16LE 带 BOM）。
/// 三级：全进程工作集 + 清空低优先级待机列表；四级：清空全部待机列表（大头，1~4GB）；
/// 五级：+ 修改页写回 + 收缩系统文件缓存；六级：整套操作连做两轮。
fn build_elevated_script(level: i64, pids: &[u32], result_file: &str) -> String {
    let body = r#"
$ErrorActionPreference = 'Continue'
$resultFile = '__RESULT_FILE__'
$rounds = if (__LEVEL__ -ge 6) { 2 } else { 1 }

# 启动器自身的 pid（由主进程传入；注意不能用 PowerShell 自动变量 $PID）
$launcherPids = @(__PID_LIST__)
$launcherSet = @{}
foreach ($i in $launcherPids) { $launcherSet[[int]$i] = $true }

$doLowStandby = __LEVEL__ -ge 3
$doStandbyAll = __LEVEL__ -ge 4
$doModified = __LEVEL__ -ge 5
$doFileCache = __LEVEL__ -ge 5

$trimmed = 0
$lowStandby = 'NA'
$standby = 'NA'
$modified = 'NA'
$filecache = 'NA'

# 收缩文件缓存前先启用特权（elevated 管理员进程里特权默认是禁用的）
if ($doFileCache) { [CMm.Api]::EnablePrivilege('SeProfileSingleProcessPrivilege') | Out-Null }

function Invoke-StandbyRound {
  $script:trimmed += Trim-Self $launcherPids
  $script:trimmed += Trim-Others $launcherSet
  Start-Sleep -Milliseconds 150
  if ($script:doLowStandby) { $script:lowStandby = Invoke-MemList 4 }
  if ($script:doStandbyAll) { $script:standby = Invoke-MemList 3 }
  if ($script:doModified) {
    $script:modified = Invoke-MemList 2
    Start-Sleep -Milliseconds 200
    $script:filecache = Shrink-FileCache
  }
  Start-Sleep -Milliseconds 150
  # 上面操作又把部分页推进待机列表，再收一轮工作集并清空
  $script:trimmed += Trim-Others $launcherSet
  if ($script:doStandbyAll) { $script:standby = Invoke-MemList 3 }
  elseif ($script:doLowStandby) { $script:lowStandby = Invoke-MemList 4 }
}

for ($r = 0; $r -lt $rounds; $r++) { Invoke-StandbyRound }

$obj = [ordered]@{
  trimmed = [int]$trimmed
  lowStandby = $lowStandby
  standby = $standby
  modified = $modified
  filecache = $filecache
  rounds = [int]$rounds
}
$obj | ConvertTo-Json -Compress | Set-Content -Path $resultFile -Encoding Unicode
"#;
    let body = body
        .replace("__RESULT_FILE__", result_file)
        .replace("__PID_LIST__", &pid_list(pids))
        .replace("__LEVEL__", &level.to_string());
    format!("{PS_COMMON}{body}")
}

/// 'NA' / 缺失 → None；数字或数字字符串 → Some（对齐 JS parseStatus）。
fn parse_status(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) if s != "NA" => s.parse().ok(),
        _ => None,
    }
}

/// channel: memory:clean（level 1~6，默认 2）—— 清理内存。
/// freedMB 按启动器自身进程前后差；systemFreedMB 按系统可用内存前后差。
#[tauri::command(rename = "memory:clean")]
pub async fn memory_clean(level: Option<Value>) -> CmdResult<Value> {
    let lv = match level.as_ref() {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
    .unwrap_or(2)
    .clamp(1, 6);

    let (_, free_before) = system_memory();
    let (before_bytes, pids) = launcher_processes();
    let mut actions: Vec<&str> = Vec::new();
    // JS 里此处是 global.gc()，Rust 无对应物，跳过且不推进 actions。

    let mut self_trimmed = 0i64;
    let mut sys_trimmed = 0i64;
    let mut low_standby = None;
    let mut standby = None;
    let mut modified = None;
    let mut filecache = None;
    let mut rounds = 0i64;
    let mut cancelled = false;

    if lv <= 2 {
        let out = run_powershell(&build_normal_script(lv, &pids), 40_000).await;
        let re_self = Regex::new(r"SELF (-?\d+)").expect("静态正则必然合法");
        let re_sys = Regex::new(r"SYS (-?\d+)").expect("静态正则必然合法");
        if let Some(m) = re_self.captures(&out).and_then(|c| c.get(1)) {
            self_trimmed = m.as_str().parse().unwrap_or(0);
        }
        if let Some(m) = re_sys.captures(&out).and_then(|c| c.get(1)) {
            sys_trimmed = m.as_str().parse().unwrap_or(0);
        }
        if self_trimmed > 0 || sys_trimmed > 0 {
            actions.push("workingset");
        }
    } else {
        let result_file = std::env::temp_dir().join(format!(
            "cm-memclean-{}-{}.json",
            std::process::id(),
            chrono::Local::now().timestamp_millis()
        ));
        let script = build_elevated_script(lv, &pids, &result_file.to_string_lossy());
        cancelled = run_elevated(&script, 120_000).await;
        if !cancelled {
            if let Ok(bytes) = tokio::fs::read(&result_file).await {
                // PowerShell Encoding Unicode = UTF-16LE 带 BOM，解码后去掉 BOM 再解析
                let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
                if let Ok(j) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
                    sys_trimmed = j.get("trimmed").and_then(Value::as_i64).unwrap_or(0);
                    low_standby = parse_status(j.get("lowStandby"));
                    standby = parse_status(j.get("standby"));
                    modified = parse_status(j.get("modified"));
                    filecache = parse_status(j.get("filecache"));
                    rounds = j.get("rounds").and_then(Value::as_i64).unwrap_or(1);
                }
                // 结果文件缺失：释放量仍可按前后差兜底
            }
            let _ = tokio::fs::remove_file(&result_file).await;
            if sys_trimmed > 0 {
                actions.push("workingset");
            }
            if low_standby == Some(0) || standby == Some(0) {
                actions.push("standby");
            }
            if modified == Some(0) {
                actions.push("modified");
            }
            if filecache == Some(0) {
                actions.push("filecache");
            }
        }
    }

    // 给系统一点时间把换出 / purge 的页记到账上，再读一次
    sleep(Duration::from_millis(700)).await;

    let (after_bytes, _) = launcher_processes();
    let (_, free_after) = system_memory();

    let mb = |v: i64| (v as f64 / MB as f64).round() as i64;
    Ok(json!({
        "level": lv,
        "elevated": lv >= 3,
        "cancelled": cancelled,
        "freedMB": mb(before_bytes as i64 - after_bytes as i64).max(0),
        "systemFreedMB": mb(free_after as i64 - free_before as i64).max(0),
        "appBeforeMB": mb(before_bytes as i64),
        "appAfterMB": mb(after_bytes as i64),
        "selfTrimmed": self_trimmed,
        "sysTrimmed": sys_trimmed,
        "lowStandbyStatus": low_standby,
        "standbyStatus": standby,
        "modifiedStatus": modified,
        "fileCacheStatus": filecache,
        "rounds": rounds,
        "actions": actions,
    }))
}
