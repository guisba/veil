'use strict';
// Self-contained Node test: simulates signaling/DataChannel; actual WebRTC on real devices still needs QA.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { TextEncoder, TextDecoder } = require('node:util');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'p2p.js'), 'utf8');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class MockElement {
  constructor(id = '') {
    this.id = id; this.children = []; this.value = ''; this.textContent = ''; this.checked = false;
    this.disabled = false; this.hidden = false; this.files = []; this.scrollTop = 0;
    this.scrollHeight = 500; this.clientHeight = 300; this.attributes = {};
    this.className = ''; this.classList = { toggle: (cl, enabled) => { if (enabled) this.className += ' ' + cl; } };
    this.style = {};
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(event, cb) { this['on' + event] = cb; }
  removeEventListener() {}
  select() {}
  remove() {}
  getContext() { return { fillRect() {}, set fillStyle(value) {} }; }
  click() { if (this.onclick) return this.onclick(); }
}
const channelRegistry = { offerer: null, responder: null };
class Channel {
  constructor() { this.readyState = 'connecting'; this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 64*1024; this.listeners = new Map(); }
  addEventListener(event, cb) { const a = this.listeners.get(event) || []; this.listeners.set(event, [...a, cb]); }
  removeEventListener(event, cb) { this.listeners.set(event, (this.listeners.get(event) || []).filter((x) => x !== cb)); }
  emit(event) { for (const cb of this.listeners.get(event) || []) cb(); if (this['on' + event]) this['on' + event](); }
  send(data) { if (this.readyState !== 'open') throw Error('Closed mock channel'); setTimeout(() => { if (this.peer.onmessage) this.peer.onmessage({ data }); }, 0); }
  close() { this.readyState = 'closed'; this.emit('close'); }
}
function link() {
  if (!channelRegistry.offerer || !channelRegistry.responder) throw Error('mock peers missing');
  const offerer = channelRegistry.offerer;
  const answerer = channelRegistry.responder;
  const first = offerer.channel;
  const second = new Channel();
  first.peer = second; second.peer = first;
  answerer.ondatachannel({ channel: second });
  first.readyState = 'open'; second.readyState = 'open';
  offerer.connectionState = answerer.connectionState = 'connected';
  offerer.iceConnectionState = answerer.iceConnectionState = 'connected';
  setTimeout(() => { first.emit('open'); second.emit('open'); }, 5);
}
class MockRTC {
  constructor() { this.iceGatheringState = 'complete'; this.localDescription = null; this.remoteDescription = null; this.connectionState='new'; this.iceConnectionState='new'; }
  createDataChannel() { this.channel = new Channel(); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- MockOffer 2 IN IP4 127.0.0.1\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\no=- MockAnswer 2 IN IP4 127.0.0.1\r\n' }; }
  async setLocalDescription(desc) { this.localDescription = desc; if (desc.type === 'offer') channelRegistry.offerer = this; if (desc.type === 'answer') channelRegistry.responder = this; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; if (desc.type === 'answer') link(); }
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = 'closed'; }
}
function spawn() {
  const elements = new Map();
  const get = (id) => { if (!elements.has(id)) elements.set(id, new MockElement(id)); return elements.get(id); };
  const document = {
    readyState: 'complete', hidden: false, getElementById: get,
    createElement: (tag) => new MockElement(tag), createTextNode: (s) => ({ textContent: s }),
    addEventListener() {}, body: new MockElement('body')
  };
  const window = { isSecureContext: true, RTCPeerConnection: MockRTC, crypto: webcrypto, addEventListener() {}, setTimeout, clearTimeout };
  const context = { window, document, crypto: webcrypto, TextEncoder, TextDecoder,
    RTCPeerConnection: MockRTC, isSecureContext: true, setTimeout, clearTimeout,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: {}, URL: Object.assign(URL, {createObjectURL: ()=>'blob:test',revokeObjectURL: () => {}}), Blob, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'qr_vendor.js'),'utf8'), context, { filename: 'qr_vendor.js' });
  vm.runInContext(source, context, { filename: 'p2p.js' });
  get('p2p-broker-url').value='wss://broker.emqx.io:8084/mqtt';
  return { get, window, elements, context };
}
function allText(root) {
  let output = '';
  const walk = (el) => { if (!el) return; output += ' ' + (el.textContent || ''); for (const child of el.children || []) walk(child); };
  walk(root); return output;
}
function findChildWithText(root, text) {
  if (!root) return null;
  if (root.textContent === text) return root;
  for (const child of root.children || []) { const found = findChildWithText(child, text); if (found) return found; }
  return null;
}
async function waitUntil(test, message, ms = 2500) {
  for (let i = 0; i < ms / 25; i++) { if (test()) return; await delay(25); }
  throw Error('Timed out: ' + message);
}
(async () => {
  const host = spawn(), guest = spawn();
  await host.get('p2p-generate').onclick();
  const invitation = host.get('p2p-code').textContent;
  assert.match(invitation, /^VEILP2P2\./);
  await host.get('p2p-show-qr').onclick();
  assert.equal(host.get('p2p-qr-panel').hidden, false);
  assert(host.get('p2p-qr-canvas').width > 150);
  host.get('p2p-hide-qr').onclick();
  assert.equal(host.get('p2p-qr-panel').hidden, true);
  console.log('PASS room QR invite generated locally by live UI code');
  guest.get('p2p-guest').onclick();
  guest.get('p2p-join-code').value = invitation;
  await guest.get('p2p-join').onclick();
  assert.equal(host.get('p2p-fingerprint').textContent, guest.get('p2p-fingerprint').textContent);
  console.log('PASS shared secret import and matching fingerprint');
  await host.get('p2p-create-offer').onclick();
  const offer = host.get('p2p-local-signal').value;
  assert.match(offer, /^VEILSDP1\./);
  assert.doesNotMatch(offer, /VEILP2P1/);
  guest.get('p2p-remote-signal').value = offer;
  await guest.get('p2p-apply-signal').onclick();
  const answer = guest.get('p2p-local-signal').value;
  host.get('p2p-remote-signal').value = answer;
  await host.get('p2p-apply-signal').onclick();
  await waitUntil(() => host.window.VEIL_P2P_DIAGNOSTICS.status().connected && guest.window.VEIL_P2P_DIAGNOSTICS.status().connected, 'authenticated channel');
  console.log('PASS encrypted hello handshake and simulated channel link');
  host.get('p2p-draft').value = 'Olá! Crypto ✓';
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(() => allText(guest.get('p2p-messages')).includes('Olá! Crypto ✓'), 'host text delivery');
  guest.get('p2p-draft').value = 'Mensagem B';
  await guest.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(() => allText(host.get('p2p-messages')).includes('Mensagem B'), 'guest text delivery');
  console.log('PASS bidirectional AES-GCM text messages');
  host.get('p2p-once').checked = true;
  host.get('p2p-draft').value = 'ONE-TIME secret!';
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(() => Boolean(findChildWithText(guest.get('p2p-messages'), 'Abrir uma única vez')), 'one-time offer');
  await findChildWithText(guest.get('p2p-messages'), 'Abrir uma única vez').onclick();
  await waitUntil(() => allText(guest.get('p2p-messages')).includes('ONE-TIME secret!'), 'once delivery');
  assert.equal(Boolean(findChildWithText(guest.get('p2p-messages'), 'Abrir uma única vez')), false);
  guest.window.VEIL_P2P_DIAGNOSTICS.status();
  console.log('PASS one-time release and consumed state');
  const buf = Buffer.from('anexo Binario!\x00\x01\xff','binary');
  host.get('p2p-file').files = [{ name: 'test.bin', type: 'application/octet-stream', size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }];
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(() => Boolean(findChildWithText(guest.get('p2p-messages'), 'Baixar arquivo recebido')), 'encrypted file transmission');
  console.log('PASS encrypted file chunks and digest validation');
  const room = JSON.parse(Buffer.from(invitation.split('.')[1], 'base64url').toString('utf8')).r;
  const before = guest.window.VEIL_P2P_DIAGNOSTICS.status().messages;
  channelRegistry.offerer.channel.send(JSON.stringify({v:1,r:room,id:'f'.repeat(32),n:'AAAAAAAAAAAAAAAA',c:'AAAAAAAAAAAAAAAAAAAAAAAA'}));
  await waitUntil(() => guest.get('p2p-route-note').textContent.includes('Falha de autenticação criptográfica'), 'forged ciphertext rejection');
  assert.equal(before, guest.window.VEIL_P2P_DIAGNOSTICS.status().messages);
  console.log('PASS unauthenticated/tampered ciphertext rejected');
  console.log('TOTAL: 6 protocol checks PASS (simulated RTC, real Node WebCrypto AES-GCM)');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
