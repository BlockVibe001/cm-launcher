// Minecraft 服务器列表 Ping（Server List Ping 协议）
// 用 net 直接走 TCP，读取版本 / MOTD / 在线人数 / 延迟 / 图标
const net = require('net');
const dns = require('dns').promises;

const PROTOCOL = 767;      // 1.21 协议号
const TIMEOUT = 7000;

/* ---------- VarInt / 数据包 ---------- */

function writeVarInt(v) {
  const bytes = [];
  let val = v >>> 0;
  do {
    let b = val & 0x7f;
    val >>>= 7;
    if (val !== 0) b |= 0x80;
    bytes.push(b);
  } while (val !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, off) {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  let b = 0;
  do {
    if (off + bytes >= buf.length) return null;
    b = buf[off + bytes];
    result |= (b & 0x7f) << shift;
    shift += 7;
    bytes++;
    if (bytes > 5) return null;
  } while (b & 0x80);
  return { value: result >>> 0, bytes };
}

function writeString(s) {
  const buf = Buffer.from(String(s), 'utf8');
  return Buffer.concat([writeVarInt(buf.length), buf]);
}

function packet(id, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function handshakePacket(host, port) {
  return packet(0, Buffer.concat([
    writeVarInt(PROTOCOL),
    writeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),
  ]));
}

const STATUS_REQUEST = packet(0);
const PING_PACKET = packet(1, Buffer.alloc(8));

/* ---------- 文本处理 ---------- */

/** MOTD 可能是字符串或聊天组件，统一压平为纯文本 */
function flatten(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return desc;
  let out = desc.text || '';
  if (Array.isArray(desc.extra)) out += desc.extra.map(flatten).join('');
  return out;
}

function stripColors(s) {
  return String(s || '').replace(/§[0-9a-fk-orx]/gi, '').trim();
}

/* ---------- 地址解析 ---------- */

async function resolveAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) throw new Error('服务器地址为空');
  const m = raw.match(/^(.+):(\d+)$/);
  let host = m ? m[1] : raw;
  let port = m ? Number(m[2]) : 25565;

  // 无端口时尝试 SRV 记录（如 play.example.com）
  if (!m) {
    try {
      const recs = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (recs && recs.length) {
        recs.sort((a, b) => a.priority - b.priority);
        host = recs[0].name;
        port = recs[0].port;
      }
    } catch { /* 无 SRV 记录，按默认端口 */ }
  }
  return { host, port };
}

/* ---------- Ping ---------- */

function pingOnce(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let chunks = [];
    let done = false;

    const sock = new net.Socket();
    const finish = (payload) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(payload);
    };

    sock.setTimeout(TIMEOUT);
    sock.on('timeout', () => finish({ online: false, error: '连接超时' }));
    sock.on('error', (e) => finish({ online: false, error: e.code === 'ECONNREFUSED' ? '连接被拒绝' : (e.code || e.message) }));

    sock.on('connect', () => {
      sock.write(handshakePacket(host, port));
      sock.write(STATUS_REQUEST);
    });

    sock.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const lenV = readVarInt(buf, 0);
      if (!lenV) return;
      if (buf.length < lenV.bytes + lenV.value) return;

      const idV = readVarInt(buf, lenV.bytes);
      if (!idV) return;
      const bodyOff = lenV.bytes + idV.bytes;

      if (idV.value === 0) {
        const strLen = readVarInt(buf, bodyOff);
        if (!strLen) return;
        const start = bodyOff + strLen.bytes;
        const json = buf.slice(start, start + strLen.value).toString('utf8');
        let data = null;
        try { data = JSON.parse(json); } catch { /* 非法响应 */ }

        if (!data) return finish({ online: false, error: '响应格式异常' });

        // 补发 ping 包（部分服务端需要）
        sock.write(PING_PACKET);

        const players = data.players || {};
        finish({
          online: true,
          host,
          port,
          latency: Date.now() - started,
          version: (data.version && data.version.name) || '',
          protocol: (data.version && data.version.protocol) || 0,
          motd: stripColors(flatten(data.description)),
          players: {
            online: players.online || 0,
            max: players.max || 0,
            sample: (players.sample || []).slice(0, 12).map((p) => p.name),
          },
          favicon: data.favicon || '',
        });
      }
    });

    sock.connect(port, host);
  });
}

/** 查询一个服务器（自动解析 SRV） */
async function ping(address) {
  try {
    const { host, port } = await resolveAddress(address);
    const res = await pingOnce(host, port);
    return { address: String(address || '').trim(), ...res };
  } catch (e) {
    return { address: String(address || '').trim(), online: false, error: e.message };
  }
}

/** 并发查询多个服务器 */
async function pingAll(addresses) {
  return Promise.all((addresses || []).map((a) => ping(a)));
}

module.exports = { ping, pingAll, resolveAddress };