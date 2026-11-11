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
  constructor() { this.signalingState='stable'; this.iceGatheringState = 'complete'; this.localDescription = null; this.remoteDescription = null; this.connectionState='new'; this.iceConnectionState='new'; }
  createDataChannel() { this.channel = new Channel(); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- MockOffer 2 IN IP4 127.0.0.1\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\no=- MockAnswer 2 IN IP4 127.0.0.1\r\n' }; }
  async setLocalDescription(desc) { this.localDescription = desc; this.signalingState=desc.type==='offer'?'have-local-offer':'stable'; if (desc.type === 'offer') channelRegistry.offerer = this; if (desc.type === 'answer') channelRegistry.responder = this; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; this.signalingState=desc.type==='answer'?'stable':'have-remote-offer'; if (desc.type === 'answer') link(); }
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = 'closed'; }
}

const clients = new Set();
const intercepted = [];
function frame(type, bytes) {
  let len=bytes.length, v=[];
  do { let d=len%128;len=Math.floor(len/128);if(len)d|=128;v.push(d); } while(len);
  return Buffer.concat([Buffer.from([type,...v]),Buffer.from(bytes)]);
}
function mqttDecode(bytes) {
  let p=1, mul=1, len=0, d;
  do {d=bytes[p++];len+=(d&127)*mul;mul*=128;}while(d&128);
  return {type:bytes[0]>>4, body:bytes.subarray(p,p+len)};
}
function str(b) { return Buffer.concat([Buffer.from([b.length>>8,b.length&255]),Buffer.from(b)]); }
class MockWebSocket {
  static OPEN = 1;
  constructor(url,protocols) { this.url=url;this.protocols=protocols;this.readyState=0;this.topic='';clients.add(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},2); }
  send(packet) {
    const {type,body}=mqttDecode(Buffer.from(packet));
    if(type===1) return setTimeout(()=>this.onmessage?.({data:Uint8Array.from(frame(0x20,Buffer.from([0,0]))).buffer}),1);
    if(type===8) {
      const length=(body[2]<<8)|body[3];this.topic=body.subarray(4,4+length).toString();
      return setTimeout(()=>this.onmessage?.({data:Uint8Array.from(frame(0x90,Buffer.from([0,1,0]))).buffer}),1);
    }
    if(type===3) {
      const length=(body[0]<<8)|body[1], topic=body.subarray(2,2+length).toString(), data=body.subarray(2+length);
      intercepted.push({topic,payload:data.toString('utf8')});
      const response=frame(0x30,Buffer.concat([str(Buffer.from(topic)),data]));
      for (const peer of clients) if(peer.readyState===1 && peer.topic===topic) setTimeout(()=>peer.onmessage?.({data:Uint8Array.from(response).buffer}),1);
    }
  }
  close(){this.readyState=3;clients.delete(this);this.onclose?.();}
}

function spawn() {
  const elements = new Map();
  const get = (id) => { if (!elements.has(id)) { const el=new MockElement(id); if(id==='p2p-broker-url') el.options=[{value:'wss://broker.emqx.io:8084/mqtt'},{value:'wss://broker.connectmq.com:8084/mqtt'},{value:'wss://test.mosquitto.org:8081'},{value:'custom'}]; elements.set(id,el); } return elements.get(id); };
  const document = {
    readyState: 'complete', hidden: false, getElementById: get,
    createElement: (tag) => new MockElement(tag), createTextNode: (s) => ({ textContent: s }),
    addEventListener() {}, body: new MockElement('body')
  };
  const window = { isSecureContext: true, RTCPeerConnection: MockRTC, WebSocket: MockWebSocket, crypto: webcrypto, addEventListener() {}, setTimeout, clearTimeout };
  const context = { window, document, crypto: webcrypto, TextEncoder, TextDecoder,
    RTCPeerConnection: MockRTC, WebSocket: MockWebSocket, isSecureContext: true, setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: {}, URL: Object.assign(URL, {createObjectURL: ()=>'blob:test',revokeObjectURL: () => {}}), Blob, console };
  vm.createContext(context);
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
  const host=spawn(),guest=spawn();
  await host.get('p2p-generate').onclick();
  const token=host.get('p2p-code').textContent;
  assert.match(token,/^VEILP2P2\./);
  guest.get('p2p-guest').onclick();
  guest.get('p2p-join-code').value=token;
  await guest.get('p2p-join').onclick();
  assert.equal(host.get('p2p-fingerprint').textContent,guest.get('p2p-fingerprint').textContent);
  console.log('PASS single shared invitation, fingerprint match');
  await waitUntil(()=>host.window.VEIL_P2P_DIAGNOSTICS.status().connected && guest.window.VEIL_P2P_DIAGNOSTICS.status().connected,'auto WebRTC encrypted handshake',5500);
  console.log('PASS auto pairing through fake WSS MQTT broker without manual SDP');
  assert.equal(host.get('p2p-local-signal').value,'');
  assert.equal(guest.get('p2p-local-signal').value,'');
  assert.ok(intercepted.length>=3,'MQTT packets transmitted');
  for(const packet of intercepted){
    assert.ok(!packet.payload.includes('v=0'),'SDP is encrypted, not in plaintext');
    assert.ok(!packet.payload.includes(token),'room credential not on broker');
    assert.ok(!packet.payload.includes('127.0.0.1'),'raw ICE/SDP IP not visible to broker');
  }
  console.log('PASS signaling contains encrypted SDP/ICE, no raw secret or remote IP');
  host.get('p2p-draft').value='Confidencial auto rendezvous';
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(()=>allText(guest.get('p2p-messages')).includes('Confidencial auto rendezvous'),'automatic message delivery');
  assert.ok(!intercepted.some(p=>p.payload.includes('Confidencial auto rendezvous')));
  console.log('PASS E2EE transport never sends chat content via broker');
  guest.get('p2p-draft').value='Resposta privada';
  await guest.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(()=>allText(host.get('p2p-messages')).includes('Resposta privada'),'reply');
  host.get('p2p-once').checked=true;
  host.get('p2p-draft').value='Mensagem de leitura única auto';
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(()=>Boolean(findChildWithText(guest.get('p2p-messages'),'Abrir uma única vez')),'one time ticket');
  await findChildWithText(guest.get('p2p-messages'),'Abrir uma única vez').onclick();
  await waitUntil(()=>allText(guest.get('p2p-messages')).includes('Mensagem de leitura única auto'),'one time release');
  console.log('PASS one-time release after automatic negotiation');
  const file=Buffer.from('test-file-v21');
  host.get('p2p-file').files=[{name:'auto.txt',type:'text/plain',size:file.length,arrayBuffer:async()=>file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength)}];
  await host.get('p2p-compose').onsubmit({preventDefault(){}});
  await waitUntil(()=>Boolean(findChildWithText(guest.get('p2p-messages'),'Baixar arquivo recebido')),'file transfer');
  console.log('PASS encrypted file transmission and digest');
  assert.equal([...clients].length,0,'WebSocket disconnected once P2P channel is authenticated');
  console.log('PASS rendezvous broker disconnected after P2P authentication');
  // A custom broker address accompanies the sole invite; the guest uses it automatically.
  host.get('p2p-host').onclick(); guest.get('p2p-guest').onclick();
  host.get('p2p-broker-url').value='custom';
  host.get('p2p-broker-custom-url').value='wss://private.example.net:443/mqtt';
  await host.get('p2p-generate').onclick();
  const customToken=host.get('p2p-code').textContent;
  const inviteData=JSON.parse(Buffer.from(customToken.split('.')[1],'base64url').toString());
  assert.equal(inviteData.b,'wss://private.example.net/mqtt');
  guest.get('p2p-join-code').value=customToken;
  await guest.get('p2p-join').onclick();
  assert.equal(guest.get('p2p-broker-url').value,'custom');
  assert.equal(guest.get('p2p-broker-custom-url').value,inviteData.b);
  await waitUntil(()=>host.window.VEIL_P2P_DIAGNOSTICS.status().connected && guest.window.VEIL_P2P_DIAGNOSTICS.status().connected,'custom-broker meeting',5500);
  console.log('PASS custom WSS broker encoded in one invite and auto-used by guest');
  process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
