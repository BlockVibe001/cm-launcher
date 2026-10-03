const fs = require('fs');
const path = require('path');

function listMods(gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .filter((d) => /\.(jar|disabled|zip)$/i.test(d.name))
    .map((d) => {
      const full = path.join(modsDir, d.name);
      const stat = fs.statSync(full);
      const disabled = /\.disabled$/i.test(d.name);
      return {
        name: d.name,
        disabled,
        size: stat.size,
        path: full,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function setModEnabled(gameDir, fileName, enabled) {
  const modsDir = path.join(gameDir, 'mods');
  const current = path.join(modsDir, fileName);
  if (!fs.existsSync(current)) throw new Error('Mod 文件不存在');

  let target;
  if (enabled) {
    // 启用：去掉 .disabled 后缀
    target = path.join(modsDir, fileName.replace(/\.disabled$/i, ''));
  } else {
    // 禁用：加 .disabled 后缀（避免重复）
    target = /\.disabled$/i.test(fileName) ? current : path.join(modsDir, `${fileName}.disabled`);
  }
  if (current !== target) fs.renameSync(current, target);
}

function deleteMod(gameDir, fileName) {
  const file = path.join(gameDir, 'mods', fileName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { listMods, setModEnabled, deleteMod };
