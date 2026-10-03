// 模组汉化：解包 jar → 提取 en_us.json → AI 翻译 → 写回 zh_cn.json → 重新打包
const fs = require('fs');
const os = require('os');
const path = require('path');
const extract = require('extract-zip');
const { createZip, collectDir } = require('../util/zip');

async function extractToTemp(jarPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-jar-'));
  await extract(jarPath, { dir: path.resolve(dir) });
  return dir;
}

/** 扫描 jar 内 assets/<modid>/lang/en_us.json */
function findLangFiles(root) {
  const out = [];
  const assets = path.join(root, 'assets');
  if (!fs.existsSync(assets)) return out;
  for (const modid of fs.readdirSync(assets)) {
    const dir = path.join(assets, modid, 'lang');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^en_us\.json$/i.test(f) || /^en_US\.json$/i.test(f)) {
        out.push({ modid, file: path.join(dir, f) });
      }
    }
  }
  return out;
}

async function callAI(cfg, messages) {
  const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, temperature: 0.2 }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI 接口返回 ${res.status}：${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!content) throw new Error('AI 未返回内容');
  return content;
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

/** 批量翻译一组 key:value */
async function translateBatch(cfg, entries, targetLang) {
  const payload = {};
  for (const [k, v] of entries) payload[k] = v;
  const sys = '你是 Minecraft 模组本地化专家。把给定的 JSON 中每个 value 翻译成简体中文，保持 %s、%d、%1$s 等格式占位符原样不变，保持 key 不变，只输出 JSON，不要解释。';
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `目标语言：${targetLang}\n${JSON.stringify(payload)}` },
  ];
  const out = await callAI(cfg, messages);
  return parseJsonLoose(out);
}

/**
 * 翻译单个 jar
 * @returns {object} { outPath, translated, files }
 */
async function translateJar(jarPath, outPath, cfg, onProgress = () => {}) {
  if (!fs.existsSync(jarPath)) throw new Error('jar 文件不存在');
  if (!cfg || !cfg.apiKey) throw new Error('请先在设置里填写 AI 翻译的 API Key');

  onProgress({ stage: '解包', pct: 5 });
  const dir = await extractToTemp(jarPath);
  try {
    const langFiles = findLangFiles(dir);
    if (!langFiles.length) throw new Error('该 jar 内没有找到 assets/<modid>/lang/en_us.json');

    let translated = 0;
    const done = [];
    for (let fi = 0; fi < langFiles.length; fi++) {
      const lf = langFiles[fi];
      let src;
      try { src = JSON.parse(fs.readFileSync(lf.file, 'utf8')); } catch { continue; }
      const keys = Object.entries(src).filter(([, v]) => typeof v === 'string' && v.trim());
      const result = {};
      const BATCH = 80;
      for (let i = 0; i < keys.length; i += BATCH) {
        const slice = keys.slice(i, i + BATCH);
        const pct = 10 + Math.round(((fi + i / Math.max(keys.length, 1)) / langFiles.length) * 80);
        onProgress({ stage: `翻译 ${lf.modid}（${i + slice.length}/${keys.length}）`, pct });
        let piece;
        try { piece = await translateBatch(cfg, slice, '简体中文'); }
        catch (e) { piece = {}; onProgress({ stage: `翻译失败：${e.message}`, pct }); }
        for (const [k, v] of slice) result[k] = piece[k] || v;
        translated += slice.length;
      }
      const outFile = path.join(path.dirname(lf.file), 'zh_cn.json');
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
      done.push(lf.modid);
    }

    onProgress({ stage: '重新打包', pct: 92 });
    const entries = collectDir(dir);
    createZip(outPath, entries);
    onProgress({ stage: '完成', pct: 100 });
    return { outPath, translated, files: done };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ---------- 通用文本翻译 / 连通性测试 ---------- */

/** 常见服务商预设，方便一键填表 */
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', name: '月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

/** 测试 AI 接口连通性 */
async function testConnection(cfg) {
  if (!cfg || !cfg.baseUrl) throw new Error('请先填写接口地址');
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('接口地址需以 http:// 或 https:// 开头');

  const modelsUrl = `${base}/models`;
  try {
    const res = await fetch(modelsUrl, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const ids = (data && Array.isArray(data.data))
        ? data.data.map((m) => m.id).filter(Boolean).slice(0, 40) : [];
      return { ok: true, endpoint: modelsUrl, models: ids };
    }
    // /models 不可用时退化为一次最小对话
  } catch { /* 继续走对话测试 */ }

  const reply = await callAI({ ...cfg, apiKey: cfg.apiKey || 'none' }, [
    { role: 'user', content: 'ping' },
  ]);
  return { ok: true, endpoint: `${base}/chat/completions`, models: [], reply: String(reply).slice(0, 60) };
}

/** 翻译一段普通文本（自动分段，避免超长） */
async function translateText(cfg, text, targetLang = '简体中文') {
  const src = String(text || '').trim();
  if (!src) throw new Error('请输入要翻译的内容');
  if (!cfg || !cfg.apiKey) throw new Error('请先填写 AI 的 API Key');

  const MAX = 1800;
  const chunks = [];
  for (let i = 0; i < src.length; i += MAX) chunks.push(src.slice(i, i + MAX));

  const out = [];
  for (const chunk of chunks) {
    const messages = [
      { role: 'system', content: `你是专业翻译。把用户输入的文本翻译成${targetLang}，只输出译文，不要解释、不要加引号。` },
      { role: 'user', content: chunk },
    ];
    out.push(await callAI(cfg, messages));
  }
  return { text: out.join('\n'), chunks: chunks.length };
}

module.exports = { translateJar, findLangFiles, translateText, testConnection, PROVIDERS };