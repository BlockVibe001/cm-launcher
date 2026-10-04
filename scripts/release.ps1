# CM Minecraft Launcher 一键发布脚本
# 流程：读版本号（可顺带升级）→ release 打包 → 生成 SHA256 → 创建/更新 GitHub Release
#
# 用法（PowerShell）：
#   scripts/release.ps1                      按 tauri.conf.json 当前版本发布
#   scripts/release.ps1 -Version 1.0.1       先把版本号改成 1.0.1 再发布
#   scripts/release.ps1 -NotesFile notes.md  使用自定义更新说明
param(
    [string]$Version = "",
    [string]$NotesFile = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot/.."
$tauriDir = Join-Path $root "tauri"
$confPath = Join-Path $tauriDir "src-tauri\tauri.conf.json"
$pkgPath = Join-Path $tauriDir "package.json"
$cargoPath = Join-Path $tauriDir "src-tauri\Cargo.toml"

function Fail($m) { Write-Host "[release] $m" -ForegroundColor Red; exit 1 }

$ghCmd = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $ghCmd) {
    foreach ($c in @("$env:ProgramFiles\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")) {
        if (Test-Path $c) { $ghCmd = $c; break }
    }
}
if (-not $ghCmd) { Fail "未找到 gh CLI（winget install GitHub.cli），并先执行 gh auth login" }
Set-Alias gh $ghCmd

# ---- 1) 版本号（可选升级，两处保持一致）----
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "版本号格式应为 x.y.z" }
    Write-Host "[release] 升级版本号 → $Version" -ForegroundColor Cyan
    foreach ($f in @($confPath, $pkgPath)) {
        $t = [System.IO.File]::ReadAllText($f)
        $t2 = [regex]::Replace($t, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}")
        [System.IO.File]::WriteAllText($f, $t2, (New-Object System.Text.UTF8Encoding($false)))
    }
    # Cargo.toml：只改 [package] 段第一处 version（CARGO_PKG_VERSION 是 update:version 的数据源）
    $lines = [System.IO.File]::ReadAllLines($cargoPath)
    $inPackage = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\[(.+)\]') { $inPackage = ($Matches[1] -eq 'package'); continue }
        if ($inPackage -and $lines[$i] -match '^(version\s*=\s*")[^"]+(")') {
            $lines[$i] = $lines[$i] -replace '^(version\s*=\s*")[^"]+(")', "`${1}$Version`${2}"
            break
        }
    }
    [System.IO.File]::WriteAllLines($cargoPath, $lines)
    & git -C $root commit -am "chore(release): v$Version"
    if ($LASTEXITCODE -ne 0) { Fail "版本号提交失败" }
    & git -C $root push
    if ($LASTEXITCODE -ne 0) { Fail "推送失败" }
}

$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$ver = $conf.version
$tag = "v$ver"
Write-Host "[release] 当前发布版本：$tag" -ForegroundColor Cyan

# ---- 2) release 打包 ----
Push-Location $tauriDir
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "打包失败" }
} finally { Pop-Location }

# ---- 3) 定位安装包 ----
$nsisDir = Join-Path $tauriDir "src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem $nsisDir -Filter "*_x64-setup.exe" |
    Where-Object { $_.Name -match [regex]::Escape($ver) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Fail "未找到版本 $ver 的安装包" }
Write-Host "[release] 安装包：$($setup.FullName)" -ForegroundColor Green

# ---- 4) SHA256 + 更新清单 ----
$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLower()
$sumPath = Join-Path $env:TEMP "$($setup.Name).sha256.txt"
"$hash  $($setup.Name)" | Set-Content -NoNewline -Encoding ascii $sumPath
Write-Host "[release] SHA256：$hash" -ForegroundColor DarkGray

# update.json：启动器自更新清单（地址永远指向 latest 下载路由，装完新版不用改）
# GitHub 会把资源名中的空格规范成点号，URL 必须用点号版名字，否则 404
$setupName = $setup.Name
$assetName = $setupName -replace ' ', '.'
$setupUrl = "https://github.com/BlockVibe001/cm-launcher/releases/download/$tag/$assetName"
$manifest = @{
    version     = $ver
    notes       = "CM Minecraft Launcher $tag"
    publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    installer   = $setupUrl
    sha256      = $hash
    page        = "https://github.com/BlockVibe001/cm-launcher/releases/latest"
} | ConvertTo-Json
$manifestPath = Join-Path $env:TEMP "update.json"
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[release] 更新清单：$manifestPath" -ForegroundColor DarkGray

# ---- 5) 创建 / 更新 GitHub Release ----
if ($NotesFile) {
    gh release create $tag $setup.FullName $sumPath $manifestPath --title $tag --notes-file $NotesFile 2>$null
} else {
    $notes = @"
CM Minecraft Launcher $tag

安装
- 下载 CM.Minecraft.Launcher_${ver}_x64-setup.exe 双击安装（免管理员，仅当前用户）。
- 需要 Windows 10 1809 及以上；系统无 WebView2 时安装程序会自动引导安装。

校验
- 安装包 SHA256 见随附 .sha256.txt：$hash

更新
- 已安装旧版的用户：启动器 设置 → 软件更新 → 检查更新，会自动下载并静默安装本版。
- 更新地址：https://github.com/BlockVibe001/cm-launcher/releases/latest/download/update.json
"@
    gh release create $tag $setup.FullName $sumPath $manifestPath --title $tag --notes $notes 2>$null
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[release] Release 已存在，改为上传覆盖最新产物…" -ForegroundColor Yellow
    gh release upload $tag $setup.FullName $sumPath $manifestPath --clobber
    if ($LASTEXITCODE -ne 0) { Fail "上传 Release 失败" }
}

Write-Host "[release] 发布完成 ✅  https://github.com/$((gh repo view --json nameWithOwner -q .nameWithOwner))/releases/tag/$tag" -ForegroundColor Green
