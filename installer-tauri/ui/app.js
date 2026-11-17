const $ = (id) => document.getElementById(id);

const state = {
  targetDir: '',
  installing: false,
  finished: false,
  version: '1.0.68',
};

function setStage(name) {
  ['welcome', 'progress', 'done'].forEach((key) => {
    $(`stage-${key}`).classList.toggle('hide', key !== name);
  });
}

function showError(message) {
  const bar = $('error-bar');
  bar.textContent = message;
  bar.classList.remove('hide');
}

function clearError() {
  const bar = $('error-bar');
  bar.classList.add('hide');
  bar.textContent = '';
}

function setProgress(percent, stage) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  $('percent').textContent = String(Math.round(p));
  $('progress-fill').style.width = `${p}%`;
  $('ring').style.setProperty('--p', String(p));
  if (stage) {
    $('progress-stage').textContent = stage;
    $('progress-label').textContent = stage;
  }
  $('step-files').classList.toggle('on', p < 92);
  $('step-files').classList.toggle('done', p >= 92);
  $('step-shortcut').classList.toggle('on', p >= 92 && p < 100);
  $('step-shortcut').classList.toggle('done', p >= 100);
  $('step-finish').classList.toggle('on', p >= 100);
}

function updatePath(value) {
  state.targetDir = value;
  $('path-value').textContent = value;
  $('path-value').title = value;
  $('progress-path').textContent = value;
  $('done-path').textContent = value;
}

async function boot() {
  try {
    const info = await window.installer.info();
    state.version = info.version || state.version;
    $('rail-version').textContent = `v${state.version}`;
    updatePath(info.defaultDir || '');
    if (!info.payloadOk) {
      showError('安装包不完整：缺少 payload.zip，请重新下载安装器。');
      $('btn-install').disabled = true;
    }
  } catch (error) {
    showError('安装器初始化失败：' + (error.message || error));
  }
}

$('btn-pick').addEventListener('click', async () => {
  clearError();
  const picked = await window.installer.pickDir();
  if (picked) updatePath(picked);
});

$('btn-install').addEventListener('click', async () => {
  if (state.installing) return;
  clearError();
  state.installing = true;
  state.finished = false;
  $('btn-install').disabled = true;
  setProgress(0, '正在准备安装文件');
  setStage('progress');

  const result = await window.installer.install({
    targetDir: state.targetDir,
    desktop: $('opt-desktop').checked,
    startMenu: $('opt-startmenu').checked,
  });

  state.installing = false;
  if (!result || !result.ok) {
    setStage('welcome');
    $('btn-install').disabled = false;
    showError((result && result.error) || '安装失败，请重试。');
    return;
  }

  state.finished = true;
  updatePath(result.targetDir || state.targetDir);
  setProgress(100, '安装完成');
  setTimeout(() => setStage('done'), 380);
});

$('btn-launch').addEventListener('click', async () => {
  const result = await window.installer.launch(state.targetDir);
  if (!result.ok) showError(result.error || '启动失败');
  else setTimeout(() => window.installer.close(), 300);
});

$('btn-done-close').addEventListener('click', () => window.installer.close());
$('btn-min').addEventListener('click', () => window.installer.minimize());
$('btn-close').addEventListener('click', () => {
  if (state.installing) return;
  window.installer.close();
});

window.installer.onProgress((value) => {
  if (!value) return;
  setProgress(value.percent, value.stage);
});

boot();
