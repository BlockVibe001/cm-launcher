// 首页桌面：MC 新闻抓取 + 游玩日历记录
const config = require('../config');

const NEWS_URL = 'https://launchercontent.mojang.com/v2/news.json';
const PATCH_URL = 'https://launchercontent.mojang.com/v2/javaPatchNotes.json';
const IMG_BASE = 'https://launchercontent.mojang.com';
const CACHE_MS = 30 * 60 * 1000;

function absImage(img) {
  if (!img) return '';
  const url = typeof img === 'string' ? img : img.url || '';
  if (!url) return '';
  return /^https?:/i.test(url) ? url : IMG_BASE + url;
}

async function fetchJson(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BlockVibe/2.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(data, kind) {
  const entries = (data && data.entries) || [];
  return entries.map((e, i) => {
    let text = '';
    if (Array.isArray(e.body)) {
      const t = e.body.find((b) => b.type === 'text' && b.text);
      if (t) text = t.text;
    }
    if (!text) text = e.text || e.shortText || e.description || '';
    return {
      id: `${kind}-${i}-${e.version || e.title || ''}`,
      kind,
      title: e.title || e.version || '',
      version: e.version || '',
      type: e.type || '',
      tag: e.tag || (e.category || ''),
      date: e.date || e.releaseDate || '',
      text: String(text).slice(0, 400),
      image: absImage(e.newsPageImage || e.image || e.thumbnail),
      url: e.readMoreLink || e.url || 'https://www.minecraft.net/zh-hans/articles',
    };
  });
}

/** 抓取 MC 新闻 + 版本更新日志（缓存 30 分钟） */
async function fetchNews(force) {
  const cachedAt = config.get('newsCacheAt') || 0;
  const cached = config.get('newsCache');
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const [news, patches] = await Promise.allSettled([fetchJson(NEWS_URL), fetchJson(PATCH_URL)]);
  const items = [];
  const errors = [];
  if (news.status === 'fulfilled') items.push(...normalize(news.value, 'news'));
  else errors.push('新闻：' + news.reason.message);
  if (patches.status === 'fulfilled') items.push(...normalize(patches.value, 'patch'));
  else errors.push('更新日志：' + patches.reason.message);

  if (!items.length) throw new Error('新闻加载失败（' + errors.join('；') + '）');

  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const result = { items: items.slice(0, 30), errors, fetchedAt: Date.now() };
  config.set('newsCache', result);
  config.set('newsCacheAt', Date.now());
  return result;
}

/** 记录一次启动，写入当天日历 */
function recordPlay(instanceId) {
  const log = config.get('playLog') || {};
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const entry = log[key] || { total: 0, instances: {} };
  const instances = config.get('instances') || {};
  const name = (instances[instanceId] && instances[instanceId].name) || instanceId;
  entry.total += 1;
  const prev = entry.instances[instanceId] || { name, count: 0 };
  entry.instances[instanceId] = { name, count: prev.count + 1 };
  log[key] = entry;

  const keys = Object.keys(log).sort();
  while (keys.length > 400) delete log[keys.shift()];
  config.set('playLog', log);
  return log;
}

function playLog() {
  return config.get('playLog') || {};
}

module.exports = { fetchNews, recordPlay, playLog };