/* 星云 AI 的朗读（TTS）
 * 主通道：云端音色（默认走 Microsoft Edge 免费神经音色，6 个中文发音人 + 4 个全球多语言发音人）；
 * 中英混读会固定同一个多语言发音人，不会一句中文一个声、一句英文一个声。
 * 备用：Windows 本地语音（慧慧 / 康康），在线失败时可出声。
 */
(function () {
  'use strict';

  // 只保留真实可用的通道：
  // ① 10 个免费云端神经音色（6 个中文音色 + 4 个全球多语言音色，都是真实不同发音人）
  // ② 本地离线神经模型  ③ Windows 系统语音
  // 不再列出未接火山引擎却写着“豆包”的假音色。
  const VOICES = [
    { key: 'auto', label: '自动 · 全球多语言（推荐）', mode: 'cloud', voiceId: 'ava', lan: 'mul', rate: 1 },
    { key: 'nova', label: '温柔女声 · Nova（免费云端）', mode: 'cloud', voiceId: 'nova', lan: 'zh', rate: 1 },
    { key: 'shimmer', label: '清亮女声 · Shimmer（免费云端）', mode: 'cloud', voiceId: 'shimmer', lan: 'zh', rate: 1 },
    { key: 'onyx', label: '磁性男声 · Onyx（免费云端）', mode: 'cloud', voiceId: 'onyx', lan: 'zh', rate: 1 },
    { key: 'echo', label: '沉稳男声 · Echo（免费云端）', mode: 'cloud', voiceId: 'echo', lan: 'zh', rate: 1 },
    { key: 'alloy', label: '清朗少年 · Alloy（免费云端）', mode: 'cloud', voiceId: 'alloy', lan: 'zh', rate: 1 },
    { key: 'fable', label: '播报男声 · Fable（免费云端）', mode: 'cloud', voiceId: 'fable', lan: 'zh', rate: 1 },
    // 免费云端多语言神经音色：一个人读完中英日韩，不再一句中文声、一句英文声。
    { key: 'ava', label: '全球女声 · Ava（免费云端 · 多语言）', mode: 'cloud', voiceId: 'ava', lan: 'mul', rate: 1 },
    { key: 'emma', label: '全球女声 · Emma（免费云端 · 多语言）', mode: 'cloud', voiceId: 'emma', lan: 'mul', rate: 1 },
    { key: 'andrew', label: '全球男声 · Andrew（免费云端 · 多语言）', mode: 'cloud', voiceId: 'andrew', lan: 'mul', rate: 1 },
    { key: 'brian', label: '全球男声 · Brian（免费云端 · 多语言）', mode: 'cloud', voiceId: 'brian', lan: 'mul', rate: 1 },
    { key: 'seraphina', label: '全球女声 · Seraphina（免费云端 · 多语言）', mode: 'cloud', voiceId: 'seraphina', lan: 'mul', rate: 1 },
    { key: 'vivienne', label: '全球女声 · Vivienne（免费云端 · 多语言）', mode: 'cloud', voiceId: 'vivienne', lan: 'mul', rate: 1 },
    { key: 'florian', label: '全球男声 · Florian（免费云端 · 多语言）', mode: 'cloud', voiceId: 'florian', lan: 'mul', rate: 1 },
    { key: 'remy', label: '全球男声 · Remy（免费云端 · 多语言）', mode: 'cloud', voiceId: 'remy', lan: 'mul', rate: 1 },
    { key: 'neural', label: '本地女声 · 神经语音（离线）', mode: 'neural', lan: 'zh' },
    { key: 'huihui', label: '系统女声 · 慧慧（离线）', mode: 'local', lan: 'zh', match: /Huihui|Yaoyao/i, pitch: 1.06, rate: 0.95 },
    { key: 'kangkang', label: '系统男声 · 康康（离线）', mode: 'local', lan: 'zh', match: /Kangkang/i, pitch: 0.92, rate: 0.95 },
    { key: 'zira', label: '系统英文女声 · Zira（离线）', mode: 'local', lan: 'en', match: /Zira|Samantha|English/i, pitch: 1.02, rate: 0.95 },
  ];

  // 首次使用离线神经语音要下模型，把进度冒到界面上，别让人以为卡死
  let statusBound = false;
  function bindStatus() {
    if (statusBound || !api.onTtsLocalStatus) return;
    statusBound = true;
    api.onTtsLocalStatus((s) => {
      if (!s) return;
      if (s.stage === 'download') {
        if (typeof toast === 'function') toast(`正在准备离线语音模型 ${s.pct || 0}%`, true);
      } else if (s.stage === 'ready' && typeof toast === 'function') {
        toast('离线语音已就绪');
      }
    });
  }

  let current = null;
  let cancelled = false;
  let warmPromise = null;
  let cloudWarm = null;

  /** 云端音色：提前建好 Edge WebSocket，第一条回复不用再等握手 */
  function warmupCloud() {
    if (typeof api === 'undefined' || !api.aiTtsWarmup) return Promise.resolve({ ok: false });
    if (!cloudWarm) cloudWarm = api.aiTtsWarmup().catch(() => ({ ok: false }));
    return cloudWarm;
  }

  /** 打开 AI 面板时预热一次离线模型；之后同一个 worker 复用，不重复加载 */
  function warmup() {
    if (typeof api === 'undefined' || !api.aiTtsWarmup) return Promise.resolve({ ok: false });
    if (warmPromise) return warmPromise;
    warmPromise = api.aiTtsWarmup().catch(() => ({ ok: false }));
    return warmPromise;
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime || 'audio/mpeg' });
  }

  function stop() {
    cancelled = true;
    if (live) streamStop();
    if (current) {
      try { current.pause(); } catch (e) { /* ignore */ }
      try { URL.revokeObjectURL(current.__url || ''); } catch (e) {}
      current = null;
    }
    if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
  }

  function cleanText(text) {
    let s = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_#>`~|]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // 云端 TTS 遇到中文句子里的空格会停顿/卡顿：
    // 去掉中文之间、中文与标点/英文之间的空格，但保留纯英文单词之间的正常空格。
    s = s
      .replace(/ +(?=[\u3400-\u9fff])/g, '')
      .replace(/([\u3400-\u9fff]) +/g, '$1')
      .replace(/ +([，。！？、；：,.!?;:])/g, '$1')
      .replace(/([，。！？、；：,.!?;:]) +/g, '$1')
      .replace(/ +([）】》」』”’])/g, '$1')
      .replace(/([（【《「『“‘]) +/g, '$1');
    return s.trim();
  }

  function detectLang(text) {
    const s = String(text || '');
    const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (latin > 0 && cjk > 0) return 'mixed';
    return latin > 0 && cjk === 0 ? 'en' : 'zh';
  }

  /**
   * 一段回答里只要同时出现中文和英文，就整段固定用同一个多语言发音人。
   * 按性别挑：女声选 Ava，男声选 Andrew，避免中英混读时每句换人。
   */
  function resolveVoiceForText(base, text) {
    if (!base || base.mode !== 'cloud') return base;
    if (base.lan === 'mul' || ['ava', 'emma', 'andrew', 'brian', 'seraphina', 'vivienne', 'florian', 'remy'].includes(base.voiceId)) return base;
    if (detectLang(text) !== 'mixed') return base;
    // 每个中文音色在混读时对应一个固定、同性别且不同的多语言音色，不再全部挤到 Ava。
    const mixedByKey = {
      nova: 'ava', shimmer: 'emma', alloy: 'vivienne',
      onyx: 'andrew', echo: 'brian', fable: 'florian',
    };
    return VOICES.find((v) => v.key === (mixedByKey[base.key] || (['onyx', 'echo', 'fable'].includes(base.key) ? 'andrew' : 'ava'))) || base;
  }

  function splitParts(text, max) {
    const parts = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('。', max);
      if (cut < max / 3) cut = rest.lastIndexOf('！', max);
      if (cut < max / 3) cut = rest.lastIndexOf('？', max);
      if (cut < max / 3) cut = rest.lastIndexOf('，', max);
      if (cut < max / 3) cut = rest.lastIndexOf('.', max);
      if (cut < max / 3) cut = rest.lastIndexOf('!', max);
      if (cut < max / 3) cut = rest.lastIndexOf('?', max);
      if (cut < max / 3) cut = rest.lastIndexOf(',', max);
      if (cut < max / 3) cut = rest.lastIndexOf(' ', max);
      if (cut < max / 3) cut = max;
      parts.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) parts.push(rest);
    return parts;
  }

  function speakLocal(text, voice, lang) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const want = lang === 'en' ? /en/i : /zh/i;
      const hit = voices.find((v) => voice.match && voice.match.test(v.name) && want.test(v.lang)) || voices.find((v) => want.test(v.lang));
      if (hit) utter.voice = hit;
      utter.lang = lang === 'en' ? 'en-US' : 'zh-CN';
      utter.rate = voice.rate || 1;
      utter.pitch = voice.pitch || 1;
      current = { pause: () => speechSynthesis.cancel(), __url: '' };
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      speechSynthesis.speak(utter);
    });
  }

  // ---------- 流式朗读队列：AI 一边吐字，一边按句合成/播放 ----------
  // 只在这里维护“还没播的句子”，不依赖整段回答结束；切换音色或停止会整队作废。
  let live = null;

  function takeSentences(buf) {
    const out = [];
    let cut = 0;
    const re = /([。！？!?…]+[”"’']?|[.](?=\s)|\n+)/g;
    let m;
    while ((m = re.exec(buf)) !== null) {
      const end = m.index + m[0].length;
      const seg = buf.slice(cut, end).trim();
      if (seg) out.push(seg);
      cut = end;
    }
    return { list: out, rest: buf.slice(cut) };
  }

  async function speakChunk(text, voice, token) {
    if (token.cancelled) return;
    const clean = cleanText(text);
    if (!clean) return;
    if (voice.mode === 'local') {
      await speakLocal(clean.slice(0, 800), voice, voice.lan || 'zh');
      return;
    }
    const detected = detectLang(clean);
    const partLang = detected === 'en' ? 'en' : 'zh';
    let blob = null;
    if (voice.mode === 'cloud' && api.aiTtsSpeech) {
      try {
        const r = await api.aiTtsSpeech(clean, { voiceId: voice.voiceId, speed: voice.rate || 1 });
        if (r && r.b64) blob = b64ToBlob(r.b64, r.mime || 'audio/mpeg');
      } catch (e) { blob = null; }
    }
    if (!blob && voice.mode === 'neural' && partLang === 'zh' && api.aiTtsLocal) {
      try {
        const r = await api.aiTtsLocal(clean, { speed: 1 });
        if (r && r.b64) blob = b64ToBlob(r.b64, r.mime || 'audio/wav');
      } catch (e) { blob = null; }
    }
    if (token.cancelled) return;
    if (!blob) {
      // 免费云端失败时才退到本机系统语音；不再走“所有音色都同一个”的百度兜底。
      const fallbackVoice = VOICES.find((v) => v.key === (partLang === 'en' ? 'zira' : 'huihui'));
      await speakLocal(clean, fallbackVoice, partLang);
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.__url = url;
    audio.playbackRate = voice.rate || 1;
    current = audio;
    await new Promise((resolve) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      const p = audio.play();
      if (p && p.catch) p.catch(() => resolve());
    });
    if (current === audio) current = null;
  }

  async function pumpLive() {
    if (!live || live.playing) return;
    live.playing = true;
    while (live && live.queue.length && !live.token.cancelled) {
      const part = live.queue.shift();
      try { await speakChunk(part, live.voice, live.token); } catch (e) { /* 单句失败不阻塞后续 */ }
      if (typeof live.onProgress === 'function') { try { live.onProgress(); } catch (e) {} }
    }
    if (live) live.playing = false;
  }

  /** AI 流式输出时调用：push 累计全文，内部只取新增的完整句子 */
  function streamPush(fullText, voiceKey, onProgress) {
    if (cancelled || !live || live.voiceKey !== voiceKey) {
      if (live) streamStop();
      const baseVoice = VOICES.find((v) => v.key === voiceKey) || VOICES[0];
      live = { voiceKey, baseVoice, voice: baseVoice, queue: [], buf: '', seen: 0, playing: false, token: { cancelled: false }, onProgress };
      cancelled = false;
    }
    if (!live) return;
    live.onProgress = onProgress || live.onProgress;
    const text = String(fullText || '');
    // 整段回答出现中英混合后，后续句子全部固定用同一个多语言发音人。
    live.voice = resolveVoiceForText(live.baseVoice, text);
    // 只处理新增部分，避免同一句被重复合成
    if (text.length < live.seen) live.seen = 0;
    const delta = text.slice(live.seen);
    live.seen = text.length;
    live.buf += delta;
    const r = takeSentences(live.buf);
    if (r.list.length) {
      live.queue.push(...r.list);
      live.buf = r.rest;
      pumpLive();
    }
  }

  function streamEnd() {
    if (!live) return;
    const rest = live.buf.trim();
    live.buf = '';
    if (rest) live.queue.push(rest);
    pumpLive();
  }

  function streamStop() {
    if (!live) return;
    live.token.cancelled = true;
    live.queue = [];
    live.buf = '';
    if (current) {
      try { current.pause(); } catch (e) {}
      try { URL.revokeObjectURL(current.__url || ''); } catch (e) {}
      current = null;
    }
    live = null;
  }

  /** 朗读一段文字；onDone 在播完/失败后调用 */
  async function speak(text, voiceKey, onDone) {    stop();
    cancelled = false;
    const baseVoice = VOICES.find((v) => v.key === voiceKey) || VOICES[0];
    const clean = cleanText(text);
    if (!clean) { if (onDone) onDone(); return; }
    const voice = resolveVoiceForText(baseVoice, clean);

    if (voice.mode === 'local') {
      await speakLocal(clean.slice(0, 800), voice, voice.lan || 'zh');
      if (onDone) onDone();
      return;
    }

    if (voice.mode === 'neural') bindStatus();

    const parts = splitParts(clean, voice.mode === 'neural' ? 260 : 220);
    for (const part of parts) {
      if (cancelled) break;
      const detected = detectLang(part);
      const partLang = detected === 'en' ? 'en' : 'zh';
      let blob = null;
      // 统一 TTS 服务：6 个免费云端神经音色，或用户自己配置的 OpenAI / Azure。
      if (voice.mode === 'cloud' && api.aiTtsSpeech) {
        try {
          const r = await api.aiTtsSpeech(part, { voiceId: voice.voiceId, speed: voice.rate || 1 });
          if (r && r.b64) blob = b64ToBlob(r.b64, r.mime || 'audio/mpeg');
        } catch (e) { blob = null; }
      }
      // 离线神经语音：不联网、不要 key；中文模型不拿来读英文
      if (voice.mode === 'neural' && partLang === 'zh' && api.aiTtsLocal) {
        try {
          const r = await api.aiTtsLocal(part, { speed: 1 });
          if (r && r.b64) blob = b64ToBlob(r.b64, r.mime || 'audio/wav');
        } catch (e) { blob = null; }
      }

      if (!blob) {
        // 在线失败 → 退回本机系统语音；不再退回“所有音色同一个”的百度音。
        const fallbackVoice = VOICES.find((v) => v.key === (partLang === 'en' ? 'zira' : 'huihui'));
        await speakLocal(part, fallbackVoice, partLang);
        continue;
      }
      if (cancelled) break;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.__url = url;
      audio.playbackRate = voice.rate || 1;
      current = audio;
      await new Promise((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        const p = audio.play();
        if (p && p.catch) p.catch(() => resolve());
      });
    }
    current = null;
    if (onDone) onDone();
  }

  /** 试听某个声音 */
  function preview(voiceKey) {
    const v = VOICES.find((x) => x.key === voiceKey) || VOICES[0];
    const text = v.lan === 'en'
      ? 'Hello, I am Xingyun. I will be your companion in the launcher.'
      : v.lan === 'mul'
        ? '你好呀，我是星云。Hello, I am Xingyun. 以后中英混读也不会换人啦。'
        : '你好呀，我是星云，以后就由我来陪你说话啦。';
    return speak(text, v.key);
  }

  window.XingyunVoice = {
    speak, stop, preview, warmup, warmupCloud, VOICES,
    stream: { push: streamPush, end: streamEnd, stop: streamStop },
  };
})();
