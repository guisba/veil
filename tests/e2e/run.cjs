// End-to-end check of the built index.html in real Chromium: two isolated browser contexts
// (a desktop host and a touch-sized guest) open the file from disk, meet through a local WSS
// MQTT broker and talk over a real WebRTC DataChannel. Public brokers, STUN and TURN are not used.
//   npm install   (in this folder)   →   node run.cjs
// Env: THEME=dark|light · FAST=1 skips the 30 s burn wait · VEIL_E2E_SHOTS=dir saves screenshots.
const { chromium } = require('playwright');
const broker = require('./broker.cjs');
const jsQR = require('jsqr');
const crypto = require('crypto');
const fs = require('fs');
const assert = require('assert/strict');
const path = require('path'), os = require('os');
const PORT = Number(process.env.VEIL_E2E_PORT || 8899);
const URL_ = 'file://' + path.resolve(__dirname, '..', '..', 'index.html') + '#conversa';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-e2e-files-'));
const shots = process.env.VEIL_E2E_SHOTS ? path.resolve(process.env.VEIL_E2E_SHOTS) + path.sep : null;
const results = [];
const pass = (name) => { results.push('PASS ' + name); console.log('PASS', name); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: shots + name }); };
(async () => {
  await broker.start(PORT);
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  async function open(label, viewport, extra = {}) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true, colorScheme: process.env.THEME || 'light', ...extra });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(label + ' console: ' + m.text()); });
    await page.goto(URL_); await page.waitForTimeout(1600);
    return page;
  }
  const host = await open('host', { width: 1440, height: 900 });
  const guest = await open('guest', { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  const connected = (p) => p.evaluate(() => window.VEIL_P2P_DIAGNOSTICS.status().connected);

  // host: private broker, then create room
  await host.click('.disclosure-head[aria-controls="p2p-net-body"]');
  await host.selectOption('#p2p-broker-url', 'custom');
  await host.fill('#p2p-broker-custom-url', `wss://localhost:${PORT}/mqtt`);
  await host.locator('#p2p-broker-custom-url').blur();
  await host.click('.disclosure-head[aria-controls="p2p-net-body"]');
  await host.click('#p2p-generate');
  await host.waitForSelector('#p2p-session-panel:not([hidden])');
  await host.waitForFunction(() => document.querySelector('#p2p-auto-status').textContent.includes('Sala disponível'), null, { timeout: 8000 });
  const token = await host.textContent('#p2p-code');
  assert.match(token, /^VEILP2P2\./);
  pass('host creates room; broker subscribed over real WSS');
  await host.waitForTimeout(700);
  await shot(host, 'e2e-1-host-waiting.png');

  // QR: render, decode pixels with an independent decoder
  await host.click('#p2p-show-qr'); await host.waitForTimeout(900);
  const qr = await host.evaluate(() => { const c = document.getElementById('p2p-qr-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  const decoded = jsQR(Uint8ClampedArray.from(qr.data), qr.w, qr.h);
  assert.equal(decoded && decoded.data, token);
  pass('QR canvas decodes (jsQR) to the exact invite');
  await shot(host, 'e2e-2-host-qr.png');
  await host.click('#p2p-hide-qr');
  assert.equal(await host.evaluate(() => document.getElementById('p2p-qr-canvas').width), 1);
  pass('QR wiped from canvas when hidden');

  // guest joins with the pasted invite
  await guest.click('#p2p-guest');
  await guest.fill('#p2p-join-code', token);
  await shot(guest, 'e2e-3-guest-join.png');
  await guest.click('#p2p-join');
  await host.waitForFunction(() => window.VEIL_P2P_DIAGNOSTICS.status().connected, null, { timeout: 20000 });
  await guest.waitForFunction(() => window.VEIL_P2P_DIAGNOSTICS.status().connected, null, { timeout: 20000 });
  pass('real WebRTC DataChannel established and authenticated on both sides');
  assert.equal(await host.textContent('#p2p-fingerprint'), await guest.textContent('#p2p-fingerprint'));
  pass('verification codes match');
  await host.waitForTimeout(600);
  assert.equal(broker.clients(), 0);
  pass('broker sockets closed after authentication');
  for (const m of broker.log) { assert(!m.payload.includes('v=0')); assert(!m.payload.includes(token)); assert(!/candidate:/.test(m.payload)); }
  pass(`broker saw ${broker.log.length} publishes, none with plaintext SDP/ICE/invite`);
  assert.equal(await guest.evaluate(() => document.getElementById('p2p-grid').dataset.pane), 'chat');
  pass('mobile guest auto-switched to the conversation pane');
  assert.equal(await host.evaluate(() => document.getElementById('netstate').dataset.net), 'p2p');

  // text both ways
  await host.fill('#p2p-draft', 'Olá do host — acentuação e emoji 🔐');
  await host.press('#p2p-draft', 'Enter');
  await guest.waitForFunction(() => document.getElementById('p2p-messages').textContent.includes('Olá do host — acentuação e emoji 🔐'));
  await guest.fill('#p2p-draft', 'Resposta do convidado');
  await guest.click('#p2p-send');
  await host.waitForFunction(() => document.getElementById('p2p-messages').textContent.includes('Resposta do convidado'));
  pass('text messages delivered both ways (Enter on desktop, button on touch)');

  // one-time
  await host.click('.once-toggle');
  await host.fill('#p2p-draft', 'SEGREDO-UMA-VEZ-42');
  await host.press('#p2p-draft', 'Enter');
  await guest.waitForSelector('text=Abrir uma única vez');
  assert(!(await guest.textContent('#p2p-messages')).includes('SEGREDO-UMA-VEZ-42'));
  await shot(guest, 'e2e-4-guest-once.png');
  await guest.click('text=Abrir uma única vez');
  await guest.waitForFunction(() => document.getElementById('p2p-messages').textContent.includes('SEGREDO-UMA-VEZ-42'));
  await guest.waitForTimeout(900);
  await shot(guest, 'e2e-5-guest-revealed.png');
  await host.waitForFunction(() => document.getElementById('p2p-messages').textContent.includes('Leitura única entregue'));
  pass('one-time message: offered, requested, delivered once, sender copy consumed');
  const revealedAt = Date.now();

  // file transfer with digest check + download
  const payload = crypto.randomBytes(700 * 1024);
  fs.writeFileSync(path.join(tmp, 'payload.bin'), payload);
  await host.setInputFiles('#p2p-file', path.join(tmp, 'payload.bin'));
  assert.equal(await host.isVisible('#p2p-attach-chip'), true);
  await host.click('#p2p-send');
  await guest.waitForSelector('text=Baixar arquivo recebido', { timeout: 30000 });
  const [download] = await Promise.all([guest.waitForEvent('download'), guest.click('text=Baixar arquivo recebido')]);
  const got = fs.readFileSync(await download.path());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'));
  pass('700 KiB file transferred in encrypted chunks; downloaded bytes match SHA-256');
  await host.waitForTimeout(500);
  await shot(host, 'e2e-6-host-chat.png');
  await shot(guest, 'e2e-7-guest-chat.png');

  // oversize file is refused
  fs.writeFileSync(path.join(tmp, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await host.setInputFiles('#p2p-file', path.join(tmp, 'big.bin'));
  await host.click('#p2p-send');
  await host.waitForFunction(() => document.getElementById('p2p-compose-note').textContent.includes('5 MiB'));
  await host.click('#p2p-file-clear');
  pass('oversize attachment refused with a visible error; chip removable');

  // burn after 30 s
  if (process.env.FAST) { console.log('(skipping 30 s burn wait)'); } else { await guest.waitForTimeout(Math.max(0, 31500 - (Date.now() - revealedAt)));
  assert(!(await guest.textContent('#p2p-messages')).includes('SEGREDO-UMA-VEZ-42'));
  pass('revealed one-time text removed from the DOM after 30 s'); }

  // disconnect handling
  await guest.click('#p2p-tab-room');
  await guest.waitForTimeout(400);
  await shot(guest, 'e2e-8-guest-room.png');
  await guest.click('#p2p-leave');
  await host.waitForFunction(() => document.getElementById('p2p-grid').dataset.phase === 'failed', null, { timeout: 15000 });
  assert.equal(await host.isDisabled('#p2p-draft'), true);
  pass('peer leaving → host shows failed state and locks the composer');
  await host.waitForTimeout(900);
  await shot(host, 'e2e-9-host-disconnected.png');
  assert.equal(await guest.evaluate(() => document.getElementById('p2p-grid').dataset.phase), 'idle');
  assert.equal(await guest.textContent('#p2p-code'), '—');

  // reconnect the same room: guest rejoins, host presses Reconectar
  await host.click('#p2p-auto-retry');
  await guest.click('#p2p-guest'); await guest.fill('#p2p-join-code', token); await guest.click('#p2p-join');
  await host.waitForFunction(() => window.VEIL_P2P_DIAGNOSTICS.status().connected && document.getElementById('p2p-grid').dataset.phase === 'connected', null, { timeout: 20000 });
  pass('recovery: Reconectar + rejoin restores an authenticated channel');

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close(); await broker.stop();
  console.log(results.length + ' checks passed');
})().catch(async (e) => { console.error('FAIL', e); process.exit(1); });
