// 配方生成器：把合成 / 熔炼配方导出为数据包（datapack）
const { createZip } = require('../util/zip');

/**
 * 生成数据包 ZIP
 * @param {string} outPath 输出 .zip 路径
 * @param {object} opt { namespace, packFormat, description, recipes: [{ id, json }] }
 */
function buildDatapack(outPath, opt) {
  const namespace = String(opt.namespace || 'cm_craft').replace(/[^a-zA-Z0-9_]/g, '_') || 'cm_craft';
  const packFormat = Number(opt.packFormat) || 15;
  const description = opt.description || 'CM 启动器配方数据包';
  const recipes = opt.recipes || [];
  if (!recipes.length) throw new Error('至少需要一个配方');

  const entries = [{
    name: 'pack.mcmeta',
    data: Buffer.from(JSON.stringify({ pack: { pack_format: packFormat, description } }, null, 2)),
  }];

  const used = new Set();
  for (const r of recipes) {
    const base = String(r.id || 'recipe').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'recipe';
    let id = base;
    let k = 2;
    while (used.has(id)) id = `${base}_${k++}`;
    used.add(id);
    const json = typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2);
    entries.push({ name: `data/${namespace}/recipes/${id}.json`, data: Buffer.from(json) });
  }

  createZip(outPath, entries);
  return { path: outPath, count: recipes.length, namespace };
}

module.exports = { buildDatapack };