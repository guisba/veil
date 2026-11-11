// Minimal local MQTT-over-WSS broker for QA only: CONNECT, SUBSCRIBE, PUBLISH fan-out, PINGREQ, DISCONNECT.
// It records every published payload so the test can assert that nothing readable crosses the broker.
const https = require('https'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
// Throwaway self-signed certificate (needs the openssl CLI); the browser is launched ignoring certificate errors.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) });
const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
const log = [];
function frames(buf, cb) { for (let i = 0; i < buf.length;) { const h = buf[i++]; let len = 0, mul = 1, d; do { d = buf[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128); cb(h, buf.subarray(i, i + len)); i += len; } }
function frame(type, body) { let len = body.length; const v = []; do { let d = len % 128; len = Math.floor(len / 128); if (len) d |= 128; v.push(d); } while (len); return Buffer.concat([Buffer.from([type, ...v]), body]); }
wss.on('connection', (ws) => {
  ws.topics = new Set();
  ws.on('message', (data) => frames(Buffer.from(data), (h, body) => {
    const type = h >> 4;
    if (type === 1) ws.send(frame(0x20, Buffer.from([0, 0])));
    else if (type === 8) { const n = (body[2] << 8) | body[3]; ws.topics.add(body.subarray(4, 4 + n).toString()); ws.send(frame(0x90, Buffer.from([body[0], body[1], 0]))); }
    else if (type === 3) { const n = (body[0] << 8) | body[1]; const topic = body.subarray(2, 2 + n).toString(); log.push({ topic, payload: body.subarray(2 + n).toString() }); for (const c of wss.clients) if (c.readyState === 1 && c.topics.has(topic)) c.send(frame(0x30, body)); }
    else if (type === 12) ws.send(Buffer.from([0xd0, 0]));
    else if (type === 14) ws.close();
  }));
});
module.exports = { start: (port) => new Promise((r) => server.listen(port, '127.0.0.1', () => r())), stop: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(() => r()); }), log, clients: () => wss.clients.size };
