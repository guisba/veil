'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const { webcrypto }=require('node:crypto');
const {TextEncoder,TextDecoder}=require('node:util');
const p=fs.readFileSync(__dirname+'/../p2p.js','utf8');
const segment=p.slice(p.indexOf('  function paddedPayload(payload) {'), p.indexOf('  function stopCover() {'));
assert(segment.includes('function paddedPayload'));
function make(checked) {
 const context={TextEncoder,TextDecoder, crypto:webcrypto, $:()=>({checked}),
   random:n=>webcrypto.getRandomValues(new Uint8Array(n)),
   toB64:data=>Buffer.from(data).toString('base64')};
 context.E=new TextEncoder();
 vm.createContext(context);
 vm.runInContext(segment+'; globalThis.pad=paddedPayload;',context);
 return context.pad;
}
for (const len of [1,70,150,290,650,1500,3700,7000]) {
 const data={t:'message',text:'m'.repeat(len), id:'a'.repeat(32)};
 const result=make(true)(data);
 const decoded=JSON.parse(Buffer.from(result).toString('utf8'));
 assert.equal(decoded.text,data.text);
 assert.equal(decoded.t,'message');
 assert([512,1024,2048,4096,8192,12800].includes(result.length), `unbucketed size ${result.length}`);
 console.log('PASS padded authenticated payload bucket',len,'→',result.length);
}
const original=make(false)({t:'message',text:'abc'});
assert.equal(Buffer.from(original).toString('utf8'),'{"t":"message","text":"abc"}');
console.log('PASS disable padding retains original byte encoding');
const qr=fs.readFileSync(__dirname+'/../qr_vendor.js','utf8');
const qcontext={};vm.createContext(qcontext);
vm.runInContext(qr+'; globalThis.Qr=VeilQrGenerator;',qcontext);
const Q=qcontext.Qr;
const result=new Q(0,1);result.addData('VEILP2P2.'+'A'.repeat(195));result.make();
assert(result.getModuleCount()>=21 && result.getModuleCount()<=177);
assert(result.isDark(0,0));
console.log('PASS offline QR encoder modules');
const main=fs.readFileSync(__dirname+'/../index.html','utf8');
assert(main.includes('const VeilQrGenerator'));
assert(main.includes('id="p2p-scan-open"'));
assert(main.includes('id="p2p-qr-canvas"'));
assert(main.includes('id="p2p-relay-only"'));
assert(!/<script[^>]+src\s*=/.test(main));
console.log('PASS single-file app packages QR and privacy controls without remote scripts');
