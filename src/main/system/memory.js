const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { app } = require('electron');

const MB = 1024 * 1024;

/**
 * 启动器自身所有进程的常驻内存合计（字节）。
 * 用 app.getAppMetrics() 而不是 process.getProcessMemoryInfo()：
 * 前者覆盖主进程 / 渲染进程 / GPU / 工具进程，而且 memory.workingSetSize 的单位是 KB。
 * （早先把 KB 当字节、又除了两次 1024，导致「启动器占用」和「已释放」恒为 0MB。）
 */
function appWorkingSetBytes() {
  try {
    const list = app.getAppMetrics();
    if (Array.isArray(list) && list.length) {
      let kb = 0;
      for (const m of list) kb += (m.memory && m.memory.workingSetSize) || 0;
      if (kb > 0) return kb * 1024;
    }
  } catch { /* 退回单进程读数 */ }
  return process.memoryUsage().rss;
}

/**
 * 获取系统内存信息
 */
function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const processBytes = appWorkingSetBytes();

  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    processBytes,
    totalMB: Math.round(total / MB),
    freeMB: Math.round(free / MB),
    usedMB: Math.round(used / MB),
    processMB: Math.round(processBytes / MB),
    usedPercent: Math.round((used / total) * 100),
  };
}

/**
 * 根据物理内存推荐 Minecraft 最大内存（MB），做法对齐 PCL2：
 *   1. 按物理内存分档给出基准值（档位越大，单档跨度越大）
 *   2. 上限封在物理内存的一半 —— PCL2 反复强调「别超过物理内存一半」，
 *      分多了反而因为 GC 停顿变卡，系统也可能被挤到换页
 *   3. 再按当前可用内存收一道，避免刚开完大型程序就分配爆掉
 *   4. 向下对齐到 256MB
 */
const LADDER = [
  { maxTotalMB: 4096, mem: 1024, band: '≤4GB' },
  { maxTotalMB: 6144, mem: 2048, band: '4~6GB' },
  { maxTotalMB: 8192, mem: 3072, band: '6~8GB' },
  { maxTotalMB: 12288, mem: 4096, band: '8~12GB' },
  { maxTotalMB: 16384, mem: 6144, band: '12~16GB' },
  { maxTotalMB: 24576, mem: 8192, band: '16~24GB' },
  { maxTotalMB: 32768, mem: 12288, band: '24~32GB' },
  { maxTotalMB: 65536, mem: 16384, band: '32~64GB' },
  { maxTotalMB: Infinity, mem: 24576, band: '>64GB' },
];

function recommendMemory() {
  const info = getMemoryInfo();
  const total = info.totalMB;
  const free = info.freeMB;

  const step = LADDER.find((s) => total <= s.maxTotalMB) || LADDER[LADDER.length - 1];
  const base = step.mem;

  // 物理内存一半是硬上限；再按可用内存的 80% 收一道（可用量本身已经把系统占用算进去了）
  const capByHalf = Math.floor(total / 2);
  const capByFree = Math.floor(free * 0.8);
  let recommended = Math.min(base, capByHalf, capByFree);

  // 至少 1GB，且不超过基准值（可用内存极低时不至于推荐得比档位还高）
  recommended = Math.max(1024, Math.round(recommended / 256) * 256);
  recommended = Math.min(recommended, Math.round(base / 256) * 256);

  // 最小内存取推荐值的 1/4，对齐到 128，最低 512
  const minRecommended = Math.max(512, Math.round(recommended / 4 / 128) * 128);

  return {
    recommended,
    minRecommended,
    totalMB: info.totalMB,
    freeMB: info.freeMB,
    totalGB: Math.round((total / 1024) * 10) / 10,
    band: step.band,
    limitMB: Math.min(capByHalf, capByFree),
    isBase: recommended === Math.round(base / 256) * 256,
  };
}

/* ============================================================================
 * 内存清理（1~6 级，对齐其他启动器 / Chunkbase 式启动器的「内存加速」）
 *
 * 关键区别：
 *  - 1~3 级不提权：V8 GC、EmptyWorkingSet（工作集修剪）、清空低优先级待机列表
 *  - 4~6 级弹 UAC 提权：提权后可对全系统进程修剪工作集，并通过
 *    ntdll!NtSetSystemInformation 清空待机列表（Standby List，大头，
 *    通常占 1~4GB）、刷新修改页列表、收缩系统文件缓存
 *
 * 「待机列表」是 Windows 给文件页做的缓存，清掉后 os.freemem() 立刻上涨，
 * 这就是别的启动器能「一下子清很多」的原因。
 * ========================================================================== */

/** 把 PowerShell 脚本交给系统执行：走 -EncodedCommand，绕开层层引号转义 */
function runPowerShell(script, timeout = 20000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()),
    );
  });
}

/** P/Invoke 类型 + 公共 helper（普通 / 提权进程各自编译一次） */
const PS_COMMON = `
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
`;

/** 1~2 级：不提权脚本，输出 SELF n / SYS n */
function buildNormalScript(level, pids) {
  const pidList = pids.join(',');
  return PS_COMMON + `
$pids = @(${pidList})
$pidSet = @{}
foreach ($i in $pids) { $pidSet[[int]$i] = $true }

$self = Trim-Self $pids
$sys = if (${level} -ge 2) { Trim-Others $pidSet } else { 0 }
Write-Output ("SELF " + $self)
Write-Output ("SYS " + $sys)
`;
}

/** 3~6 级：提权脚本，JSON 结果写到 resultFile（UTF16LE，Node 按 utf16le 读）
 *  三级：全进程工作集 + 清空低优先级待机列表
 *  四级：升级为清空全部待机列表（大头，1~4GB）
 *  五级：+ 修改页写回 + 收缩系统文件缓存
 *  六级：整套操作连做两轮 */
function buildElevatedScript(level, pids, resultFile) {
  const pidList = pids.join(',');
  return PS_COMMON + `
$ErrorActionPreference = 'Continue'
$resultFile = '${resultFile}'
$rounds = if (${level} -ge 6) { 2 } else { 1 }

# 启动器自身的 pid（由主进程传入；注意不能用 PowerShell 自动变量 $PID）
$launcherPids = @(${pidList})
$launcherSet = @{}
foreach ($i in $launcherPids) { $launcherSet[[int]$i] = $true }

$doLowStandby = ${level} -ge 3
$doStandbyAll = ${level} -ge 4
$doModified = ${level} -ge 5
$doFileCache = ${level} -ge 5

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
`;
}

/**
 * 弹 UAC 提权运行脚本并等待结束。
 * 外层（不提权）PowerShell 用 Start-Process -Verb RunAs -Wait 拉起提权进程；
 * 用户在 UAC 点否 → Start-Process 抛异常 → 输出 CANCELLED。
 */
function runElevated(script, timeoutMs) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const outer =
      "try { "
      + "$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden "
      + "-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + encoded + "'); "
      + "Write-Output ('EXIT ' + $p.ExitCode) "
      + "} catch { Write-Output 'CANCELLED' }";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer],
      { windowsHide: true, timeout: timeoutMs || 120000 },
      (err, stdout) => {
        if (err) return resolve({ launchError: true });
        const text = String(stdout || '');
        if (text.indexOf('CANCELLED') >= 0) return resolve({ cancelled: true });
        const m = /EXIT (-?\d+)/.exec(text);
        resolve({ exitCode: m ? parseInt(m[1], 10) : null });
      },
    );
  });
}

/** 'NA' / 数字字符串 → number | null */
function parseStatus(v) {
  if (v === undefined || v === null || v === 'NA') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 清理内存。
 * @param {number} level 1~6；默认 2（标准）
 * 返回口径：freedMB 按启动器自身进程前后差；systemFreedMB 按系统可用内存前后差。
 */
async function cleanMemory(level) {
  let lv = parseInt(level, 10);
  if (!Number.isFinite(lv)) lv = 2;
  lv = Math.max(1, Math.min(6, lv));

  const sysBefore = os.freemem();
  const beforeBytes = appWorkingSetBytes();
  const pids = (() => {
    try { return app.getAppMetrics().map((m) => m.pid); } catch { return [process.pid]; }
  })();
  const actions = [];

  if (typeof global.gc === 'function') {
    global.gc();
    actions.push('gc');
  }

  let selfTrimmed = 0;
  let sysTrimmed = 0;
  let lowStandbyStatus = null;
  let standbyStatus = null;
  let modifiedStatus = null;
  let fileCacheStatus = null;
  let rounds = 0;
  let cancelled = false;

  if (process.platform === 'win32') {
    if (lv <= 2) {
      const out = await runPowerShell(buildNormalScript(lv, pids), 40000);
      const selfM = /SELF (-?\d+)/.exec(out);
      const sysM = /SYS (-?\d+)/.exec(out);
      if (selfM) selfTrimmed = parseInt(selfM[1], 10) || 0;
      if (sysM) sysTrimmed = parseInt(sysM[1], 10) || 0;
      if (selfTrimmed > 0 || sysTrimmed > 0) actions.push('workingset');
    } else {
      const resultFile = path.join(os.tmpdir(), `cm-memclean-${process.pid}-${Date.now()}.json`);
      const r = await runElevated(buildElevatedScript(lv, pids, resultFile), 120000);
      cancelled = !!r.cancelled;
      if (!cancelled) {
        try {
          const j = JSON.parse(fs.readFileSync(resultFile, 'utf16le'));
          sysTrimmed = parseInt(j.trimmed, 10) || 0;
          lowStandbyStatus = parseStatus(j.lowStandby);
          standbyStatus = parseStatus(j.standby);
          modifiedStatus = parseStatus(j.modified);
          fileCacheStatus = parseStatus(j.filecache);
          rounds = parseInt(j.rounds, 10) || 1;
        } catch { /* 结果文件缺失：释放量仍可按前后差兜底 */ }
        try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
        if (sysTrimmed > 0) actions.push('workingset');
        if (lowStandbyStatus === 0 || standbyStatus === 0) actions.push('standby');
        if (modifiedStatus === 0) actions.push('modified');
        if (fileCacheStatus === 0) actions.push('filecache');
      }
    }
  }

  // 给系统一点时间把换出 / purge 的页记到账上，再读一次
  await new Promise((r) => setTimeout(r, 700));

  const afterBytes = appWorkingSetBytes();
  const sysAfter = os.freemem();

  return {
    level: lv,
    elevated: lv >= 3,
    cancelled,
    freedMB: Math.max(0, Math.round((beforeBytes - afterBytes) / MB)),
    systemFreedMB: Math.max(0, Math.round((sysAfter - sysBefore) / MB)),
    appBeforeMB: Math.round(beforeBytes / MB),
    appAfterMB: Math.round(afterBytes / MB),
    selfTrimmed,
    sysTrimmed,
    lowStandbyStatus,
    standbyStatus,
    modifiedStatus,
    fileCacheStatus,
    rounds,
    actions,
  };
}

module.exports = { getMemoryInfo, recommendMemory, cleanMemory, LADDER };
