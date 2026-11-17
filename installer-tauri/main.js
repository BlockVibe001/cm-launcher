const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

let win = null;
let installing = false;

const APP_NAME = '星云启动器';
const APP_EXE = '星云启动器.exe';

function defaultInstallDir() {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  const candidates = [
    'E:\\Nebula-Launcher-Tauri',
    path.join(local, 'Programs', 'Nebula Launcher Tauri'),
    path.join(process.env.ProgramFiles || '', 'Nebula Launcher Tauri'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(path.join(candidate, APP_EXE))) return candidate;
    } catch {}
  }
  return path.join(local, 'Programs', 'Nebula Launcher Tauri');
}

function payloadPath() {
  return path.join(process.resourcesPath, 'payload.zip');
}

function manifestPath() {
  return path.join(process.resourcesPath, 'payload-manifest.json');
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    return { files: 0, bytes: 0 };
  }
}

function sendProgress(percent, stage) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('installer:progress', { percent: Math.max(0, Math.min(100, Math.round(percent))), stage });
  }
}

function isLauncherRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${APP_EXE}`], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) resolve(false);
      else resolve(String(stdout || '').includes(APP_EXE));
    });
  });
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve((stdout || '').trim());
    });
  });
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function createShortcuts(targetDir, options) {
  const exe = path.join(targetDir, APP_EXE);
  if (options.desktop) {
    await runPowerShell(
      `$ws = New-Object -ComObject WScript.Shell; ` +
      `$s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\${APP_NAME}.lnk'); ` +
      `$s.TargetPath = ${psQuote(exe)}; $s.WorkingDirectory = ${psQuote(targetDir)}; ` +
      `$s.IconLocation = ${psQuote(exe)}; $s.Description = '星云启动器'; $s.Save()`
    );
  }
  if (options.startMenu) {
    const startDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    await runPowerShell(
      `$ws = New-Object -ComObject WScript.Shell; ` +
      `$s = $ws.CreateShortcut(${psQuote(path.join(startDir, `${APP_NAME}.lnk`))}); ` +
      `$s.TargetPath = ${psQuote(exe)}; $s.WorkingDirectory = ${psQuote(targetDir)}; ` +
      `$s.IconLocation = ${psQuote(exe)}; $s.Description = '星云启动器'; $s.Save()`
    );
  }
}

function extractPayload(targetDir, onLine) {
  return new Promise((resolve, reject) => {
    const zip = payloadPath();
    if (!fs.existsSync(zip)) {
      reject(new Error('安装包文件缺失，请重新下载安装器。'));
      return;
    }
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const child = spawn(tar, ['-xvf', zip, '-C', targetDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let lines = 0;
    let err = '';
    child.stdout.on('data', (chunk) => {
      const count = (chunk.toString('utf8').match(/\n/g) || []).length;
      if (count > 0) {
        lines += count;
        onLine(lines);
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(lines);
      else reject(new Error(err.trim() || `解压失败（tar ${code}）`));
    });
  });
}

ipcMain.handle('installer:info', () => ({
  version: app.getVersion(),
  defaultDir: defaultInstallDir(),
  payloadOk: fs.existsSync(payloadPath()),
}));

ipcMain.handle('installer:pick-dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择星云启动器的安装位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('installer:install', async (event, payload) => {
  if (installing) return { ok: false, error: '安装正在进行' };
  installing = true;
  try {
    const targetDir = String(payload.targetDir || '').trim();
    if (!path.isAbsolute(targetDir)) throw new Error('安装路径无效');
    if (/^[a-zA-Z]:\\?$/.test(targetDir)) throw new Error('不能直接安装到磁盘根目录');
    if (await isLauncherRunning()) throw new Error('星云启动器正在运行，请先退出启动器再安装。');
    fs.mkdirSync(targetDir, { recursive: true });

    const manifest = readManifest();
    const total = Math.max(1, Number(manifest.files) || 1);
    sendProgress(3, '正在准备安装文件');
    await new Promise((r) => setTimeout(r, 350));

    let lastPercent = 4;
    await extractPayload(targetDir, (lines) => {
      const p = 5 + Math.min(86, (lines / total) * 86);
      if (p - lastPercent >= 1) {
        lastPercent = p;
        sendProgress(p, '正在写入程序文件');
      }
    });

    sendProgress(93, '正在创建快捷方式');
    await createShortcuts(targetDir, {
      desktop: payload.desktop !== false,
      startMenu: payload.startMenu !== false,
    });

    fs.writeFileSync(path.join(targetDir, 'install-info.json'), JSON.stringify({
      version: app.getVersion(),
      installedAt: new Date().toISOString(),
      installer: 'nebula-custom-installer',
    }, null, 2), 'utf8');

    sendProgress(100, '安装完成');
    installing = false;
    return { ok: true, targetDir };
  } catch (error) {
    installing = false;
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('installer:launch', async (event, targetDir) => {
  const exe = path.join(targetDir, APP_EXE);
  if (!fs.existsSync(exe)) return { ok: false, error: '没有找到星云启动器主程序' };
  const err = await shell.openPath(exe);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.on('installer:minimize', () => { if (win) win.minimize(); });
ipcMain.on('installer:close', () => {
  if (win) win.close();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 1120,
    minHeight: 720,
    maxWidth: 1120,
    maxHeight: 720,
    frame: false,
    transparent: false,
    resizable: false,
    show: false,
    backgroundColor: '#070b16',
    title: '星云启动器 安装',
    icon: path.join(process.resourcesPath, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
    win.moveTop();
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.cm.blockvibe.installer');
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
