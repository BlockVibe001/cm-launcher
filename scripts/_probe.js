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
        const c = await window.api.configGetAll();
        return JSON.stringify({
          keys: Object.keys(c),
          instType: Array.isArray(c.instances) ? 'array' : typeof c.instances,
          instJson: JSON.stringify(c.instances),
          accountJson: JSON.stringify(c.account),
          selected: c.selectedInstance
        });
      })()`;
      const r = await req('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      console.log('exception?', !!r.result.exceptionDetails);
      console.log(r.result.result && r.result.result.value);
      if (r.result.exceptionDetails) console.log(JSON.stringify(r.result.exceptionDetails, null, 1));
      ws.close();
      process.exit(0);
    };
  });
});
