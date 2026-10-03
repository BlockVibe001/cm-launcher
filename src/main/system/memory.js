const os = require('os');
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

/**
 * 收回工作集：把进程里「已不活跃」的物理页换出去，物理内存立刻可见地降下来。
 * 自己的进程一定能收（不需要管理员）；其他进程需要权限，收不动的跳过。
 */
function buildTrimScript(pids) {
  const mine = pids.map((p) => String(p)).join(',');
  return `
$sig = '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProc);'
$api = Add-Type -MemberDefinition $sig -Name Psapi -Namespace CM -PassThru
$mine = @(${mine})
$selfOk = 0
foreach ($id in $mine) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) { try { if ($api::EmptyWorkingSet($p.Handle)) { $selfOk++ } } catch {} }
}
$sysOk = 0
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  if ($mine -notcontains $_.Id) {
    try { if ($api::EmptyWorkingSet($_.Handle)) { $sysOk++ } } catch {}
  }
}
Write-Output ("{0} {1}" -f $selfOk, $sysOk)
`;
}

/**
 * 清理内存：
 *  1. 触发 V8 垃圾回收（需要 --expose-gc，没开就跳过）
 *  2. 收回启动器自身所有进程的工作集（必成，是「已释放」的主要来源）
 *  3. 尽力收回全系统进程的工作集（需要管理员；收不动就静默跳过）
 * 释放量按「启动器自身进程合计」的前后差计算 —— 这个数字是真实可测的。
 */
async function cleanMemory() {
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
  if (process.platform === 'win32') {
    const out = await runPowerShell(buildTrimScript(pids));
    const parts = out.split(/\s+/);
    selfTrimmed = parseInt(parts[0], 10) || 0;
    sysTrimmed = parseInt(parts[1], 10) || 0;
    if (selfTrimmed > 0) actions.push('workingset');
    if (sysTrimmed > 0) actions.push('system');
  }

  // 给系统一点时间把换出的页记到账上，再读一次
  await new Promise((r) => setTimeout(r, 700));

  const afterBytes = appWorkingSetBytes();
  const sysAfter = os.freemem();
  const freedMB = Math.max(0, Math.round((beforeBytes - afterBytes) / MB));

  return {
    freedMB,
    appBeforeMB: Math.round(beforeBytes / MB),
    appAfterMB: Math.round(afterBytes / MB),
    systemFreedMB: Math.round((sysAfter - sysBefore) / MB),
    selfTrimmed,
    sysTrimmed,
    elevated: sysTrimmed > 0,
    actions,
  };
}

module.exports = { getMemoryInfo, recommendMemory, cleanMemory, LADDER };