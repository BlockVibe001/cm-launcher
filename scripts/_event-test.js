/* 验证 Tauri event listen 链路（capabilities 是否放行）：
 * 同一页面内 listen + emit 自收自发；同时确认 onLog 订阅不报错。*/
const http = require('http');
http.get('http://localhost:9224/json', (r) => {
  let d = '';
  r.on('data', (c) => (d += c));
  r.on('end', () => {
    const t = JSON.parse(d).find((t) => t.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 1;
    const p = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && p.has(m.id)) {
        p.get(m.id)(m);
        p.delete(m.id);
      }
    };
    const req = (method, params = {}) =>
      new Promise((res) => {
        const i = id++;
        p.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    ws.onopen = async () => {
      await req('Runtime.enable');
      const expr = `(async () => {
        const out = {};
        try {
          const { listen, emit } = window.__TAURI__.event;
          const result = await new Promise(async (resolve) => {
            const un = await listen('__gate_ping', (e) => resolve('got:' + e.payload));
            await emit('__gate_ping', 42);
            setTimeout(() => resolve('timeout'), 2500);
          });
          out.loopback = result;
        } catch (e) { out.loopback = 'ERROR: ' + e.message; }
        // 真实订阅 onLog：返回值/异常都记录
        try {
          window.api.onLog(() => {});
          out.onLog = 'subscribed';
        } catch (e) { out.onLog = 'ERROR: ' + e.message; }
        return JSON.stringify(out);
      })()`;
      const r = await req('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      console.log('exception?', !!r.result.exceptionDetails);
      console.log(r.result.result && r.result.result.value);
      if (r.result.exceptionDetails) console.log(JSON.stringify(r.result.exceptionDetails));
      ws.close();
      process.exit(0);
    };
  });
});
