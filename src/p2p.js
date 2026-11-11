/* VEIL P2P — offline UI, opt-in encrypted WSS rendezvous, direct WebRTC or optional TURN.
   Protocol, framing, key handling and signalling are unchanged from VEIL 2.2. Presentation goes
   through the optional VeilUI layer, so this file still runs headless under the Node test mocks. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = new TextEncoder();
  const D = new TextDecoder('utf-8', { fatal: true });
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const CHUNK_BYTES = 8192;
  const MAX_FRAME_CHARS = 32000;
  const MAX_SIGNAL_CHARS = 180000;
  const MAX_TEXT_CHARS = 12000;
  const state = {
    role: '', room: '', secret: null, key: null, token: '', pc: null, channel: null,
    authenticated: false, helloSent: false, helloReceived: false, collecting: false,
    messages: [], seen: new Set(), onceVault: new Map(), onceInbox: new Map(),
    burnTimers: new Map(), incomingFiles: new Map(), fileUrls: new Set(),
    receiving: Promise.resolve(), sendBusy: false, epoch: 0, coverTimer: null, scannerStream: null, scanInterval: null, scanEpoch: 0
  };

  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (p) => parseInt(p, 16));
  const toB64 = (bytes) => {
    let out = ''; const b = new Uint8Array(bytes);
    for (let start = 0; start < b.length; start += 8192) {
      out += String.fromCharCode(...b.subarray(start, start + 8192));
    }
    return btoa(out);
  };
  const fromB64 = (encoded) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const b64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (value) => fromB64(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const sanitize = (name) => String(name || 'arquivo').replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').slice(0, 120) || 'arquivo';
  const now = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const supported = () => Boolean(window.isSecureContext && crypto && crypto.subtle && window.RTCPeerConnection);
  const UI = typeof VeilUI !== 'undefined' ? VeilUI : null;
  const view = { phase: 'idle', unread: 0, rendered: new Map(), started: false };

  function icon(name) {
    if (typeof document.createElementNS !== 'function') return null;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name); svg.append(use);
    return svg;
  }
  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  // Presentation-only connection phase: idle → waiting → negotiating → connected | failed | paused.
  function setPhase(phase) {
    view.phase = phase;
    const grid = $('p2p-grid');
    if (grid && grid.dataset) grid.dataset.phase = phase;
    const tag = $('p2p-channel-tag');
    if (tag && tag.dataset) tag.dataset.state = phase === 'connected' ? 'ready' : phase === 'failed' ? 'failed' : phase === 'idle' || phase === 'paused' ? 'idle' : 'waiting';
    if (tag && UI) tag.textContent = { idle: 'SEM SALA', waiting: 'AGUARDANDO', negotiating: 'NEGOCIANDO', connected: 'P2P · E2EE ATIVO', failed: 'FALHA', paused: 'DESCONECTADO' }[phase];
    const draft = $('p2p-draft');
    if (draft) draft.placeholder = phase === 'connected' ? 'Mensagem' : 'Conecte-se para escrever';
    if (phase !== 'connected') setTrackFromPhase(phase);
    if (UI) {
      const drawn = phase === 'connected' ? 1 : (phase === 'failed' || phase === 'paused') && state.messages.length ? 0.6 : 0;
      UI.veil.set({ open: drawn, energy: phase === 'waiting' || phase === 'negotiating' ? 1 : 0 });
    }
    const banner = $('p2p-banner');
    if (banner && banner.dataset) {
      const show = (phase === 'failed' || phase === 'paused') && Boolean(state.room);
      banner.hidden = !show;
      banner.dataset.kind = phase;
      if (show) $('p2p-banner-text').textContent = phase === 'failed' ? 'Conexão interrompida. A sala continua na memória desta aba.' : 'Canal desconectado. A sala continua na memória desta aba.';
    }
    syncNet();
    if (!state.messages.length) renderMessages();
  }
  function syncNet() {
    if (!UI) return;
    UI.setNet(view.phase === 'connected' ? 'p2p' : view.phase === 'failed' ? 'failed' : auto.socket ? 'broker' : 'idle');
  }
  const TRACK = ['broker', 'peer', 'route', 'auth'];
  function setTrack(step, complete = false) {
    const list = $('p2p-track');
    if (!list || !list.children) return;
    const at = TRACK.indexOf(step);
    view.track = step;
    for (const item of list.children) {
      const i = TRACK.indexOf(item.dataset.step);
      item.className = i < at || (complete && i <= at) ? 'is-done' : i === at ? 'is-active' : '';
    }
  }
  function setTrackFromPhase(phase) {
    if (phase === 'idle' || phase === 'paused') setTrack('', false);
    else if (phase === 'failed') { const list = $('p2p-track'); if (list && list.children) for (const item of list.children) if (item.className === 'is-active') item.className = ''; }
  }
  function composeNote(message, kind = '') {
    const note = $('p2p-compose-note');
    if (!note) return;
    note.textContent = message;
    note.className = 'composer-note' + (kind ? ' is-' + kind : '');
  }
  function defaultComposeNote() {
    const once = $('p2p-once');
    if (once && once.checked) composeNote('Leitura única: o texto fica na memória desta aba até o contato abrir, uma vez.', 'once');
    else composeNote('Enter envia, Shift + Enter quebra a linha. Mantenha os dois dispositivos abertos.');
  }
  function setPane(pane, animate = true) {
    const grid = $('p2p-grid');
    if (!grid || !grid.dataset || grid.dataset.pane === pane) return;
    grid.dataset.pane = pane;
    $('p2p-tab-room').setAttribute('aria-selected', String(pane === 'room'));
    $('p2p-tab-chat').setAttribute('aria-selected', String(pane === 'chat'));
    if (pane === 'chat') clearUnread();
    if (animate && grid.classList && grid.classList.add) { grid.classList.remove('pane-enter'); void grid.offsetWidth; grid.classList.add('pane-enter'); }
    if (UI) UI.veil.visibility();
    if (pane === 'chat') { const root = $('p2p-messages'); root.scrollTop = root.scrollHeight; }
  }
  function chatVisible() {
    const stage = $('p2p-stage');
    return !stage || stage.offsetParent === undefined || stage.offsetParent !== null;
  }
  const baseTitle = typeof document.title === 'string' ? document.title : '';
  function clearUnread() {
    view.unread = 0;
    if (UI && baseTitle) document.title = baseTitle;
    const badge = $('p2p-unread');
    if (badge) badge.hidden = true;
  }
  function noteIncoming() {
    if (chatVisible() && !document.hidden) return;
    view.unread++;
    const badge = $('p2p-unread');
    if (badge) { badge.textContent = String(Math.min(view.unread, 99)); badge.hidden = false; }
    if (UI && baseTitle) document.title = '(' + Math.min(view.unread, 99) + ') ' + baseTitle; // a count only, never content
  }

  function setStatus(message, status = '') {
    $('p2p-state').textContent = message;
    $('p2p-light').className = 'p2p-light ' + status;
    const connected = status === 'ready';
    $('p2p-grid').classList.toggle('is-connected', connected);
    $('p2p-channel-tag').textContent = connected ? 'P2P · E2EE ATIVO' : status === 'failed' ? 'FALHA' : 'AGUARDANDO';
    for (const id of ['p2p-draft', 'p2p-send', 'p2p-once', 'p2p-file']) $(id).disabled = !connected;
    if (connected) setPhase('connected');
    else if (status === 'failed') {
      if (view.phase === 'connected') { setTrack(''); setAutoStatus('Canal encerrado. Use Reconectar para procurar o contato novamente.'); }
      setPhase('failed');
    }
    else if (view.phase === 'connected' || view.phase === 'failed') setPhase(state.room ? 'paused' : 'idle');
    else setPhase(view.phase);
  }
  function info(message, error = false) {
    const messageEl = $('p2p-route-note');
    if (messageEl) {
      messageEl.textContent = message;
      messageEl.className = 'route-note' + (error ? ' is-error' : '');
    }
  }
  function errorText(e) { return e && e.message ? e.message : 'Operação indisponível neste navegador.'; }

  function scrub() {
    stopCover();
    closeQrScanner();
    for (const item of state.onceVault.values()) {
      item.key.fill(0);
      item.cipher.fill(0);
    }
    state.onceVault.clear();
    for (const t of state.burnTimers.values()) clearTimeout(t);
    state.burnTimers.clear();
    for (const uri of state.fileUrls) URL.revokeObjectURL(uri);
    state.fileUrls.clear();
    state.incomingFiles.clear();
    state.onceInbox.clear();
    state.seen.clear();
    state.messages = [];
    if (state.secret) state.secret.fill(0);
    state.secret = null;
    state.key = null;
    state.room = '';
    state.token = '';
  }
  function disconnect(clearRoom = false) {
    state.epoch++;
    stopCover();
    stopAuto();
    const channel = state.channel;
    const pc = state.pc;
    state.channel = null;
    state.pc = null;
    state.authenticated = false;
    state.helloSent = false;
    state.helloReceived = false;
    state.receiving = Promise.resolve();
    try { if (channel) channel.close(); } catch {}
    try { if (pc) pc.close(); } catch {}
    if (clearRoom) {
      scrub();
      hideSecretQr();
      clearUnread();
      $('p2p-session-panel').hidden = true;
      $('p2p-setup').hidden = false;
      setCodeVeiled(true);
      $('p2p-local-signal').value = '';
      $('p2p-remote-signal').value = '';
      $('p2p-code').textContent = '—';
      $('p2p-join-code').value = '';
      renderMessages();
    }
    setStatus('Sem conexão P2P.', '');
    setPhase(state.room ? 'paused' : 'idle');
  }

  function chooseRole(role) {
    disconnect(true);
    state.role = role;
    hideSecretQr();
    setupError('');
    closeQrScanner();
    $('p2p-host').setAttribute('aria-pressed', role === 'host' ? 'true' : 'false');
    $('p2p-guest').setAttribute('aria-pressed', role === 'guest' ? 'true' : 'false');
    $('p2p-host-view').hidden = role !== 'host';
    $('p2p-guest-view').hidden = role !== 'guest';
    $('p2p-create-offer').hidden = role !== 'host';
    $('p2p-host-secret').hidden = role !== 'host';
    $('p2p-instruction').textContent = role === 'host'
      ? '1. Gere a oferta e envie o código. 2. Cole a resposta recebida.'
      : '1. Cole a oferta recebida. 2. Envie a resposta gerada de volta.';
    info(role === 'host' ? 'Crie uma sala e compartilhe o convite.' : 'Cole o convite e conecte automaticamente.');
  }

  function brokerUrl() {
    const selection = $('p2p-broker-url').value;
    const url = selection === 'custom' ? $('p2p-broker-custom-url').value.trim() : selection;
    let parsed;
    try { parsed = new URL(url); } catch { throw Error('Endereço de broker inválido.'); }
    if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || url.length > 230) {
      throw Error('Use somente um endereço WSS/TLS confiável, sem credenciais no URL.');
    }
    return parsed.href;
  }
  function applyBroker(url) {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || url.length > 230) return;
      const select = $('p2p-broker-url');
      const item = [...select.options].find((o) => o.value === parsed.href);
      select.value = item ? item.value : 'custom';
      if (!item) $('p2p-broker-custom-url').value = parsed.href;
      $('p2p-custom-broker').hidden = select.value !== 'custom';
    } catch {}
  }
  function makeToken(room, keyBytes) {
    return 'VEILP2P2.' + b64url(E.encode(JSON.stringify({ v: 2, r: room, k: hex(keyBytes), b: brokerUrl() })));
  }
  function parseToken(input) {
    const match = /^VEILP2P([12])\.([A-Za-z0-9_-]{80,560})$/.exec(input);
    if (!match) throw Error('Convite VEILP2P inválido.');
    let token;
    try { token = JSON.parse(D.decode(unb64url(match[2]))); }
    catch { throw Error('Não foi possível ler o convite.'); }
    if (token.v !== Number(match[1]) || !/^[a-f0-9]{32}$/.test(token.r) || !/^[a-f0-9]{64}$/.test(token.k)) {
      throw Error('Convite com versão ou segredo inválido.');
    }
    if (token.b !== undefined && (typeof token.b !== 'string' || token.b.length > 230 || !token.b.startsWith('wss://'))) throw Error('Broker do convite inválido.');
    return { room: token.r, secret: unhex(token.k), broker: token.b || '' };
  }
  async function installSession(room, secret, broker = '') {
    if (!supported()) throw Error('Requer WebRTC e WebCrypto em contexto seguro (file:// ou HTTPS quando suportado).');
    disconnect(true);
    applyBroker(broker);
    state.room = room;
    state.secret = secret;
    state.token = makeToken(room, secret);
    state.key = await crypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    $('p2p-session-panel').hidden = false;
    $('p2p-setup').hidden = true;
    const digest = await crypto.subtle.digest('SHA-256', E.encode('VEIL-SAS1:' + room + ':' + hex(secret)));
    $('p2p-fingerprint').textContent = hex(new Uint8Array(digest).slice(0, 8)).toUpperCase().match(/.{1,4}/g).join(' ');
    if (state.role === 'host') { $('p2p-code').textContent = state.token; hideSecretQr(); }
    info('Chave preparada localmente. Só a negociação cifrada será enviada ao broker.');
    setStatus('Convite preparado. Procurando o outro dispositivo...', '');
    setPhase('waiting');
    if (UI) { UI.unveil($('p2p-session-panel')); UI.syncAllSegments(); }
    await startAuto();
  }

  function iceServers() {
    const servers = [];
    if ($('p2p-enable-stun').checked) {
      const url = $('p2p-stun-url').value.trim();
      if (!/^stuns?:[a-z0-9][a-z0-9.:-]{3,200}$/i.test(url)) throw Error('Endereço STUN inválido.');
      servers.push({ urls: url });
    }
    if ($('p2p-enable-turn').checked) {
      const url = $('p2p-turn-url').value.trim();
      const username = $('p2p-turn-user').value.trim();
      const credential = $('p2p-turn-pass').value;
      if (!/^turns?:[a-z0-9][a-z0-9.:-]{3,150}(?:\?transport=(?:tcp|udp))?$/i.test(url)) throw Error('Endereço TURN inválido.');
      if (!username || !credential) throw Error('TURN precisa de usuário e senha válidos.');
      servers.push({ urls: url, username, credential });
    }
    if ($('p2p-relay-only').checked && !$('p2p-enable-turn').checked) throw Error('Modo relay-only exige configurar TURN.');
    return servers;
  }
  function createPeer() {
    if (!state.key) throw Error('Crie ou importe uma sala antes de negociar.');
    if (!supported()) throw Error('WebRTC indisponível neste navegador.');
    if (state.pc) throw Error('Já existe um canal. Use Reiniciar canal para começar novamente.');
    const servers = iceServers();
    const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: $('p2p-relay-only').checked ? 'relay' : 'all', bundlePolicy: 'balanced' });
    state.pc = pc;
    pc.oniceconnectionstatechange = () => {
      if (pc !== state.pc) return;
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'disconnected') {
        setStatus('Conexão P2P interrompida (' + s + ').', 'failed');
        info('Conexão falhou. Configure TURN/TLS em redes restritas e clique Reconectar.', true);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc !== state.pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') setStatus('Conexão encerrada.', 'failed');
    };
    pc.ondatachannel = (event) => bindChannel(event.channel);
    return pc;
  }
  function bindChannel(channel) {
    state.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onopen = () => {
      setStatus('Canal direto estabelecido. Validando segredo…', '');
      setTrack('auth');
      sendEncrypted({ t: 'hello', r: state.room, version: 1 }).then(() => {
        state.helloSent = true;
        checkReady();
      }).catch((e) => { setStatus('Falha na autenticação.', 'failed'); info(errorText(e), true); });
    };
    channel.onmessage = (event) => {
      state.receiving = state.receiving.then(() => handlePacket(event.data)).catch((e) => {
        info('Uma mensagem foi recusada: ' + errorText(e), true);
        if (state.authenticated) composeNote('Uma mensagem recebida foi recusada: ' + errorText(e), 'error');
      });
    };
    channel.onclose = () => {
      if (state.channel === channel) setStatus('O outro dispositivo encerrou a conexão.', 'failed');
    };
    channel.onerror = () => {
      if (state.channel === channel) setStatus('Falha no canal de dados.', 'failed');
    };
  }
  function checkReady() {
    if (!state.helloSent || !state.helloReceived || state.authenticated) return;
    state.authenticated = true;
    setStatus('Conectado. Chave compartilhada autenticada por AES-GCM.', 'ready');
    info('WebRTC DTLS ativo. Conteúdo cifrado adicionalmente com AES-256-GCM.');
    appendMessage({ id: hex(random(8)), type: 'system', text: 'Canal P2P autenticado. Nenhuma mensagem é armazenada pelo broker de encontro.', when: now() });
    setTrack('auth', true);
    hideSecretQr();
    defaultComposeNote();
    setPane('chat');
    // Hand the keyboard to the composer when nothing else holds focus (pointer devices only).
    if (UI && UI.currentView() === 'p2p' && !matchMedia('(pointer: coarse)').matches && (document.activeElement === document.body || !document.activeElement || document.activeElement.offsetParent === null)) setTimeout(() => $('p2p-draft').focus({ preventScroll: true }), 60);
    stopAuto();
    scheduleCover();
    setAutoStatus('Canal estabelecido. Broker de encontro desconectado.', true);
    selectedRoute();
  }

  async function awaitCandidates(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('ICE não concluiu em 20 segundos. Verifique a rede.')); }, 20000);
      const onChange = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onChange); };
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
  function packSdp(desc) {
    return 'VEILSDP1.' + b64url(E.encode(JSON.stringify({ v: 1, type: desc.type, sdp: desc.sdp })));
  }
  function parseSdp(code) {
    const clean = code.replace(/\s+/g, '');
    if (!clean.startsWith('VEILSDP1.') || clean.length > MAX_SIGNAL_CHARS) throw Error('Cole um código VEILSDP1 válido.');
    let obj;
    try { obj = JSON.parse(D.decode(unb64url(clean.slice(9)))); }
    catch { throw Error('Código de conexão danificado.'); }
    if (obj.v !== 1 || !['offer', 'answer'].includes(obj.type) || typeof obj.sdp !== 'string' || obj.sdp.length > 110000 || !obj.sdp.startsWith('v=0')) {
      throw Error('Descrição WebRTC inválida.');
    }
    return obj;
  }
  async function createOffer() {
    if (state.role !== 'host') throw Error('Apenas o criador gera a oferta.');
    if (!state.room) throw Error('Crie a sala primeiro.');
    const pc = createPeer();
    const dc = pc.createDataChannel('veil-direct', { ordered: true });
    bindChannel(dc);
    await pc.setLocalDescription(await pc.createOffer());
    setStatus('Coletando endereços para conexão direta…', '');
    await awaitCandidates(pc);
    $('p2p-local-signal').value = packSdp(pc.localDescription);
    info('Oferta pronta. Copie o código de conexão e envie ao convidado. Não inclui o segredo AES.');
  }
  async function applyRemote() {
    if (!state.room) throw Error('Crie ou importe a credencial primeiro.');
    const desc = parseSdp($('p2p-remote-signal').value.trim());
    if (state.role === 'guest') {
      if (desc.type !== 'offer') throw Error('O convidado precisa receber uma OFERTA.');
      const pc = createPeer();
      await pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      setStatus('Coletando endereços para a resposta…', '');
      await awaitCandidates(pc);
      $('p2p-local-signal').value = packSdp(pc.localDescription);
      info('Resposta pronta. Copie-a e envie ao criador da sala.');
    } else if (state.role === 'host') {
      if (!state.pc || !state.pc.localDescription) throw Error('Gere uma oferta primeiro.');
      if (desc.type !== 'answer') throw Error('O criador precisa receber uma RESPOSTA.');
      await state.pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
      info('Resposta aplicada. Aguardando canal direto e verificação criptográfica.');
    } else throw Error('Escolha um papel antes de aplicar o código.');
  }

  async function bufferedSend(serialized) {
    const dc = state.channel;
    if (!dc || dc.readyState !== 'open') throw Error('Canal WebRTC desconectado.');
    if (dc.bufferedAmount >= 220 * 1024) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clean(); reject(Error('Canal congestionado ou desconectado.')); }, 12000);
        const onLow = () => { clean(); resolve(); };
        const onClose = () => { clean(); reject(Error('Canal encerrado.')); };
        const clean = () => { clearTimeout(timer); dc.removeEventListener('bufferedamountlow', onLow); dc.removeEventListener('close', onClose); };
        dc.addEventListener('bufferedamountlow', onLow);
        dc.addEventListener('close', onClose);
        if (dc.bufferedAmount < 220 * 1024) { clean(); resolve(); }
      });
    }
    if (dc.readyState !== 'open') throw Error('Canal fechado durante o envio.');
    dc.send(serialized);
  }
  // Independent authenticated application-layer padding. It hides precise small-message lengths,
  // not traffic destinations, timing, total volume or packet count. It does not impersonate an app.
  function paddedPayload(payload) {
    const original = JSON.stringify(payload);
    const start = E.encode(original);
    if (!$('p2p-padding')?.checked || start.length > 12000) return start;
    const base = { ...payload, __pad: '' };
    const overhead = E.encode(JSON.stringify(base)).length;
    const target = [512, 1024, 2048, 4096, 8192, 12800].find(size => size >= overhead);
    if (!target) return start;
    const extra = target - overhead;
    if (extra) {
      // Cryptographically random bytes are encoded as invariant-size ASCII characters.
      const r = random(Math.ceil(extra * 3 / 4) + 3);
      base.__pad = toB64(r).slice(0, extra);
    }
    return E.encode(JSON.stringify(base));
  }
  function stopCover() {
    if (state.coverTimer) clearTimeout(state.coverTimer);
    state.coverTimer = null;
  }
  function scheduleCover() {
    stopCover();
    if (!state.authenticated || !$('p2p-cover')?.checked) return;
    // Optional low-rate encrypted filler frames. No application impersonation or IP spoofing.
    const delay = 1600 + (new DataView(random(2).buffer).getUint16(0) % 3000);
    state.coverTimer = setTimeout(async () => {
      state.coverTimer = null;
      if (state.authenticated && state.channel?.readyState === 'open' && state.channel.bufferedAmount < 25000 && !state.sendBusy) {
        try { await sendEncrypted({ t: 'cover', d: hex(random(8)) }); } catch {}
      }
      if (state.authenticated) scheduleCover();
    }, delay);
  }

  async function sendEncrypted(payload) {
    if (!state.key || !state.room) throw Error('A chave de sessão não está disponível.');
    const bytes = paddedPayload(payload);
    if (bytes.length > 15500) throw Error('Mensagem excede o limite deste frame.');
    const iv = random(12);
    const id = hex(random(16));
    const aad = E.encode('VEIL-P2P1|' + state.room + '|' + id);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, state.key, bytes);
    const frame = JSON.stringify({ v: 1, r: state.room, id, n: toB64(iv), c: toB64(encrypted) });
    if (frame.length > MAX_FRAME_CHARS) throw Error('Frame excede o limite de transporte.');
    await bufferedSend(frame);
  }
  async function handlePacket(data) {
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) throw Error('Frame P2P recusado por tamanho ou tipo.');
    let frame;
    try { frame = JSON.parse(data); } catch { throw Error('Frame P2P inválido.'); }
    if (frame.v !== 1 || frame.r !== state.room || !/^[a-f0-9]{32}$/.test(frame.id) || typeof frame.n !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(frame.n) || typeof frame.c !== 'string' || frame.c.length > 30000) throw Error('Protocolo inválido.');
    if (state.seen.has(frame.id)) throw Error('Frame repetido.');
    if (state.seen.size > 12000) state.seen.clear();
    const nonce = fromB64(frame.n);
    if (nonce.length !== 12) throw Error('Nonce inválido.');
    const aad = E.encode('VEIL-P2P1|' + state.room + '|' + frame.id);
    let decoded;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, state.key, fromB64(frame.c));
      decoded = JSON.parse(D.decode(plain));
    } catch { throw Error('Falha de autenticação criptográfica. Chaves incompatíveis ou conteúdo adulterado.'); }
    state.seen.add(frame.id);
    if (!decoded || typeof decoded.t !== 'string') throw Error('Payload inválido.');
    if (decoded.t === 'hello') {
      if (decoded.r !== state.room || decoded.version !== 1) throw Error('A outra ponta não tem a mesma sala.');
      state.helloReceived = true;
      checkReady();
      return;
    }
    if (!state.authenticated) throw Error('Mensagem recebida antes da verificação do canal.');
    if (decoded.t === 'cover') return; // Authenticated empty cover frame; no user-visible message.
    await dispatchMessage(decoded);
  }
  function appendMessage(message) {
    state.messages.push(message);
    if (state.messages.length > 250) state.messages.shift();
    if (!message.self && message.type !== 'system') noteIncoming();
    renderMessages();
  }
  function findMessage(id) { return state.messages.find((m) => m.id === id); }
  function hideOnce(id) {
    const timer = state.burnTimers.get(id);
    if (timer) clearTimeout(timer);
    state.burnTimers.delete(id);
    const message = findMessage(id);
    if (!message) return;
    message.text = '';
    message.type = 'burnt';
    renderMessages();
  }
  function burnAllRevealed() {
    for (const id of [...state.burnTimers.keys()]) hideOnce(id);
  }
  async function dispatchMessage(p) {
    if (p.t === 'message') {
      if (typeof p.text !== 'string' || p.text.length > MAX_TEXT_CHARS || !/^[a-f0-9]{32}$/.test(p.id)) return;
      appendMessage({ id: p.id, type: 'text', self: false, text: p.text, when: now() });
    } else if (p.t === 'once-offer') {
      if (!/^[a-f0-9]{32}$/.test(p.id) || state.onceInbox.has(p.id)) return;
      state.onceInbox.set(p.id, { requested: false });
      appendMessage({ id: p.id, type: 'once', self: false, text: '', when: now() });
    } else if (p.t === 'once-request') {
      if (!/^[a-f0-9]{32}$/.test(p.id)) return;
      const envelope = state.onceVault.get(p.id);
      if (!envelope) { await sendEncrypted({ t: 'once-expired', id: p.id }); return; }
      state.onceVault.delete(p.id); // Consume synchronously before first async operation.
      const material = envelope.key;
      try {
        const oneKey = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['decrypt']);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.iv, additionalData: E.encode('VEIL-ONCE|' + state.room + '|' + p.id) }, oneKey, envelope.cipher));
        try { await sendEncrypted({ t: 'once-delivery', id: p.id, text: D.decode(plain) }); }
        finally { plain.fill(0); }
        const status = findMessage(p.id);
        if (status) { status.type = 'burnt'; status.text = ''; renderMessages(); }
      } catch (e) {
        info('A mensagem de leitura única foi consumida, mas a entrega falhou: ' + errorText(e), true);
      } finally { material.fill(0); envelope.cipher.fill(0); }
    } else if (p.t === 'once-delivery') {
      if (!/^[a-f0-9]{32}$/.test(p.id) || typeof p.text !== 'string' || p.text.length > MAX_TEXT_CHARS) return;
      const ticket = state.onceInbox.get(p.id);
      if (!ticket || !ticket.requested || ticket.completed) return;
      ticket.completed = true;
      const message = findMessage(p.id);
      if (!message) return;
      message.type = 'revealed'; message.text = p.text; message.burnAt = Date.now() + 30000;
      renderMessages();
      const timer = setTimeout(() => hideOnce(p.id), 30000);
      state.burnTimers.set(p.id, timer);
    } else if (p.t === 'once-expired') {
      if (!/^[a-f0-9]{32}$/.test(p.id)) return;
      const message = findMessage(p.id);
      if (message) { message.type = 'burnt'; renderMessages(); }
    } else if (p.t === 'file-start') {
      if (!/^[a-f0-9]{32}$/.test(p.id) || state.incomingFiles.has(p.id) || typeof p.name !== 'string' || typeof p.mime !== 'string' || !Number.isSafeInteger(p.size) || p.size < 0 || p.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(p.digest)) return;
      const count = Math.ceil(p.size / CHUNK_BYTES);
      state.incomingFiles.set(p.id, { name: sanitize(p.name), mime: p.mime.slice(0, 100), size: p.size, digest: p.digest, chunks: new Array(count), received: 0 });
      appendMessage({ id: p.id, type: 'file-progress', text: 'Recebendo ' + sanitize(p.name) + '…', when: now(), self: false, progress: 0 });
    } else if (p.t === 'file-chunk') {
      if (!/^[a-f0-9]{32}$/.test(p.id) || typeof p.b !== 'string' || p.b.length > 12000 || !Number.isInteger(p.seq)) return;
      const incoming = state.incomingFiles.get(p.id);
      if (!incoming || p.seq < 0 || p.seq >= incoming.chunks.length || incoming.chunks[p.seq]) return;
      const part = fromB64(p.b);
      if (part.length > CHUNK_BYTES) return;
      incoming.chunks[p.seq] = part;
      incoming.received += part.length;
      const receiving = findMessage(p.id);
      if (receiving) {
        const progress = incoming.size ? incoming.received / incoming.size : 1;
        if (progress - (receiving.progress || 0) >= 0.04 || progress >= 1) { receiving.progress = progress; renderMessages(); }
      }
    } else if (p.t === 'file-end') {
      if (!/^[a-f0-9]{32}$/.test(p.id)) return;
      const incoming = state.incomingFiles.get(p.id);
      if (!incoming) return;
      state.incomingFiles.delete(p.id);
      const chunks = incoming.chunks;
      const message = findMessage(p.id);
      if (!message) return;
      if (chunks.some((c) => !c) || incoming.received !== incoming.size) {
        message.type = 'file-error'; message.text = 'Arquivo incompleto e descartado.'; renderMessages(); return;
      }
      const bytes = new Uint8Array(incoming.size);
      let offset = 0;
      for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      if (digest !== incoming.digest) {
        message.type = 'file-error'; message.text = 'Hash do arquivo não confere. Transferência descartada.';
      } else {
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: incoming.mime || 'application/octet-stream' }));
        state.fileUrls.add(blobUrl);
        message.type = 'file'; message.text = incoming.name + ' · ' + Math.ceil(incoming.size / 1024) + ' KB';
        message.fileUrl = blobUrl; message.fileName = incoming.name;
      }
      bytes.fill(0);
      renderMessages();
    }
  }

  async function requestOnce(id) {
    const ticket = state.onceInbox.get(id);
    if (!ticket || ticket.requested || !state.authenticated) return;
    ticket.requested = true;
    const message = findMessage(id);
    if (message) { message.type = 'once-wait'; renderMessages(); }
    try { await sendEncrypted({ t: 'once-request', id }); }
    catch (e) { if (message) { message.type = 'burnt'; renderMessages(); } info(errorText(e), true); }
  }

  function emptyState() {
    const copy = view.phase === 'connected' ? ['Canal pronto', 'Conexão P2P pronta. Envie a primeira mensagem.']
      : view.phase === 'waiting' || view.phase === 'negotiating' ? (state.role === 'host' ? ['Aguardando o convidado', 'Envie o convite ou mostre o QR Code. A conversa abre quando a chave for confirmada nos dois lados.'] : ['Procurando a sala', 'O convite foi aceito. Aguardando o criador da sala responder.'])
      : view.phase === 'failed' ? ['Conexão interrompida', 'Abra a Sala para reconectar ou revisar a rede.']
      : view.phase === 'paused' ? ['Canal desconectado', 'A sala continua na memória. Reconecte quando quiser.']
      : ['Nenhuma sala aberta', 'Crie uma sala e compartilhe um convite para conectar automaticamente.'];
    const empty = make('div', 'chat-empty');
    empty.append(make('b', '', copy[0]), make('span', '', copy[1]));
    return empty;
  }
  const ONCE_TYPES = ['once', 'revealed', 'burnt', 'once-wait', 'once-sent'];
  function signature(message) {
    return [message.type, message.text || '', Math.round((message.progress || 0) * 25), message.fileUrl ? 1 : 0].join('|');
  }
  function fileRow(text) {
    const row = make('div', 'file-row');
    const glyph = icon('file');
    if (glyph) row.append(glyph);
    row.append(make('span', '', text));
    return row;
  }
  function progressBar(value) {
    const bar = make('div', 'progress');
    const fill = make('i');
    if (fill.style && fill.style.setProperty) fill.style.setProperty('--v', String(value || 0));
    bar.append(fill);
    return bar;
  }
  function buildMessage(entry, message, previousType) {
    const wrap = entry.el;
    const type = message.type;
    wrap.className = 'msg' + (message.self ? ' self' : '') + (type === 'system' ? ' system' : '')
      + (ONCE_TYPES.includes(type) ? ' once ' + (type === 'revealed' ? 'revealed' : type === 'burnt' ? 'burnt' : '') : '')
      + (type.startsWith('file') ? ' ' + (type === 'file-out' ? 'file-progress' : type === 'file-sent' ? 'file' : type) : '')
      + (entry.fresh ? ' is-new' : '') + (entry.grouped ? ' grouped' : '');
    const meta = make('div', 'msg-meta');
    meta.textContent = (type === 'system' ? 'SISTEMA' : message.self ? 'VOCÊ' : 'OUTRO DISPOSITIVO') + ' · ' + message.when;
    const bubble = make('div', 'bubble');
    let text = message.text || '';
    if (type === 'once') text = 'Mensagem de leitura única. O remetente deve continuar conectado. Após pedir abertura, o conteúdo só poderá ser entregue uma vez.';
    if (type === 'once-wait') text = 'Pedido de abertura enviado. Aguardando liberação única do remetente…';
    if (type === 'burnt') text = message.self ? 'Leitura única entregue ao contato. O texto foi apagado desta aba.' : 'Mensagem consumida ou indisponível. Não pode ser reaberta pelo VEIL.';
    if (type === 'file' || type === 'file-sent') bubble.append(fileRow(text));
    else if (type === 'file-progress' || type === 'file-out') bubble.append(fileRow(text), progressBar(message.progress));
    else if (type === 'revealed') {
      const body = make('span', 'once-text', message.text);
      const note = make('span', 'bubble-note');
      const ring = make('span', 'ring ring-sm');
      if (typeof document.createElementNS === 'function') {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 44 44'); svg.setAttribute('aria-hidden', 'true');
        for (const cls of ['', 'ring-arc']) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '22'); c.setAttribute('cy', '22'); c.setAttribute('r', '19'); if (cls) { c.setAttribute('class', cls); c.setAttribute('pathLength', '1'); } svg.append(c); }
        ring.append(svg);
        const left = Math.max(0, (message.burnAt || 0) - Date.now());
        ring.style.setProperty('--p', (left / 30000).toFixed(3));
        const arc = svg.lastChild;
        requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.transitionDuration = left + 'ms'; ring.style.setProperty('--p', '0'); }));
        note.append(ring);
      }
      note.append(make('span', '', 'Este conteúdo será ocultado em até 30 segundos.'));
      bubble.append(body, note);
      if (UI && previousType !== 'revealed') UI.settleText(body, message.text, { toProse: true });
    } else bubble.textContent = text;
    if (type === 'once') {
      const btn = make('button', 'bubble-btn', 'Abrir uma única vez'); btn.type = 'button';
      btn.onclick = () => requestOnce(message.id); bubble.append(btn);
    }
    if (type === 'file' && message.fileUrl) {
      const btn = make('button', 'bubble-btn', 'Baixar arquivo recebido'); btn.type = 'button';
      btn.onclick = () => {
        const a = document.createElement('a'); a.href = message.fileUrl; a.download = message.fileName; a.click();
      };
      bubble.append(btn);
    }
    wrap.replaceChildren(meta, bubble);
    if (UI && previousType && previousType !== type && (type === 'revealed' || type === 'burnt' || type === 'file' || type === 'file-error')) UI.unveil(bubble, type === 'burnt' ? 520 : 680);
  }
  // Keyed rendering: an element lives as long as its message, so state changes animate in place.
  function renderMessages() {
    const root = $('p2p-messages');
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 120;
    if (!state.messages.length) {
      view.rendered.clear();
      root.replaceChildren(emptyState());
      if ($('p2p-jump')) $('p2p-jump').hidden = true;
      return;
    }
    if (!view.rendered.size) root.replaceChildren();
    const alive = new Set();
    let previous = null, added = false, addedOwn = false;
    for (const message of state.messages) {
      alive.add(message.id);
      let entry = view.rendered.get(message.id);
      const fresh = !entry;
      if (fresh) {
        entry = { el: document.createElement('div'), sig: '', type: '', fresh: true, grouped: false };
        view.rendered.set(message.id, entry);
        root.append(entry.el);
        added = true; if (message.self) addedOwn = true;
      }
      const grouped = Boolean(previous && previous.type === 'text' && message.type === 'text' && Boolean(previous.self) === Boolean(message.self) && previous.when === message.when);
      const sig = signature(message) + (grouped ? '|g' : '');
      if (entry.sig !== sig) {
        entry.grouped = grouped;
        buildMessage(entry, message, entry.type);
        entry.sig = sig; entry.type = message.type; entry.fresh = false;
      }
      previous = message;
    }
    for (const [id, entry] of view.rendered) if (!alive.has(id)) { entry.el.remove(); view.rendered.delete(id); }
    const jump = $('p2p-jump');
    if (nearBottom || addedOwn) { root.scrollTop = root.scrollHeight; if (jump) jump.hidden = true; }
    else if (added && jump) jump.hidden = false;
  }

  async function sendOnce(text) {
    const id = hex(random(16));
    const material = random(32);
    const ephemeral = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = random(12);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: E.encode('VEIL-ONCE|' + state.room + '|' + id) }, ephemeral, E.encode(text)));
    state.onceVault.set(id, { key: material, iv, cipher });
    try { await sendEncrypted({ t: 'once-offer', id }); }
    catch (e) { state.onceVault.delete(id); material.fill(0); cipher.fill(0); throw e; }
    appendMessage({ id, type: 'once-sent', text: 'Mensagem de leitura única enviada. Guardada apenas na memória desta aba, enquanto o destinatário não abrir.', self: true, when: now() });
  }
  async function sendText(text) {
    if (text.length > MAX_TEXT_CHARS) throw Error('Mensagem muito longa.');
    const id = hex(random(16));
    await sendEncrypted({ t: 'message', id, text });
    appendMessage({ id, type: 'text', text, self: true, when: now() });
  }
  async function sendFile(file) {
    if (file.size > MAX_FILE_BYTES) throw Error('O arquivo excede 5 MiB.');
    const content = new Uint8Array(await file.arrayBuffer());
    let outgoing = null;
    try {
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', content)));
      const id = hex(random(16));
      const fname = sanitize(file.name);
      await sendEncrypted({ t: 'file-start', id, name: fname, mime: file.type.slice(0, 100), size: file.size, digest });
      outgoing = { id, type: 'file-out', text: 'Enviando ' + fname + '…', self: true, when: now(), progress: 0 };
      appendMessage(outgoing);
      for (let offset = 0, seq = 0; offset < content.length; offset += CHUNK_BYTES, seq++) {
        await sendEncrypted({ t: 'file-chunk', id, seq, b: toB64(content.subarray(offset, offset + CHUNK_BYTES)) });
        const progress = Math.min(1, (offset + CHUNK_BYTES) / content.length);
        if (progress - outgoing.progress >= 0.04) { outgoing.progress = progress; renderMessages(); }
      }
      await sendEncrypted({ t: 'file-end', id });
      outgoing.type = 'file-sent';
      outgoing.text = 'Arquivo enviado: ' + fname + ' · ' + Math.ceil(file.size / 1024) + ' KB';
      renderMessages();
    } catch (e) {
      if (outgoing) { outgoing.type = 'file-error'; outgoing.text = 'Envio interrompido: ' + sanitize(file.name); renderMessages(); }
      throw e;
    } finally { content.fill(0); }
  }

  function syncAttachment() {
    const file = $('p2p-file').files && $('p2p-file').files[0];
    $('p2p-file-label').textContent = file ? sanitize(file.name) + ' · ' + Math.ceil(file.size / 1024) + ' KiB' : 'Até 5 MiB';
    if ($('p2p-attach-chip')) $('p2p-attach-chip').hidden = !file;
    if (file && file.size > MAX_FILE_BYTES) { info('Arquivo de até 5 MiB por envio.', true); composeNote('Arquivo de até 5 MiB por envio.', 'error'); }
    else if (view.started) defaultComposeNote();
  }
  function resizeDraft() {
    const draft = $('p2p-draft');
    if (!draft || !draft.style || typeof draft.scrollHeight !== 'number' || !UI) return;
    draft.style.height = 'auto';
    draft.style.height = Math.min(168, draft.scrollHeight) + 'px';
  }
  async function onSubmit(event) {
    event.preventDefault();
    if (state.sendBusy || !state.authenticated || !state.channel || state.channel.readyState !== 'open') return;
    const text = $('p2p-draft').value.trim();
    const file = $('p2p-file').files && $('p2p-file').files[0];
    if (!text && !file) { info('Digite uma mensagem ou selecione um arquivo.', true); composeNote('Digite uma mensagem ou selecione um arquivo.', 'error'); return; }
    if ($('p2p-once').checked && file) { info('A leitura única desta versão é apenas para texto. Desmarque a opção para enviar arquivos.', true); composeNote('Leitura única vale só para texto. Desative 1× para enviar o arquivo.', 'error'); return; }
    state.sendBusy = true;
    $('p2p-send').disabled = true;
    try {
      if (text) {
        if ($('p2p-once').checked) await sendOnce(text);
        else await sendText(text);
      }
      $('p2p-draft').value = '';
      resizeDraft();
      if (file) await sendFile(file);
      $('p2p-once').checked = false;
      $('p2p-file').value = '';
      syncAttachment();
      defaultComposeNote();
      info('Dados protegidos e entregues pelo canal direto.');
      const send = $('p2p-send');
      if (UI && send.classList && send.classList.add) { send.classList.remove('is-sent'); void send.offsetWidth; send.classList.add('is-sent'); }
    } catch (e) { info('Falha no envio: ' + errorText(e), true); composeNote('Falha no envio: ' + errorText(e), 'error'); }
    finally { state.sendBusy = false; $('p2p-send').disabled = !state.authenticated || view.phase !== 'connected'; }
  }

  function setupError(message) {
    const box = $('p2p-setup-alert');
    if (!box || !UI) return;
    if (!message) { box.classList.add('hidden'); return; }
    UI.notice(box, message, 'error');
  }
  async function safeAction(action, button) {
    if (state.collecting) return;
    state.collecting = true;
    if (UI && button) UI.busy(button, true);
    $('p2p-create-offer').disabled = true;
    $('p2p-apply-signal').disabled = true;
    setupError('');
    try { await action(); }
    catch (e) {
      info(errorText(e), true);
      // Before a room exists this is an input problem, not a connection failure.
      if (!state.room && UI) { setupError(errorText(e)); setStatus('Sem conexão P2P.', ''); }
      else setStatus('Erro de negociação: ' + errorText(e), 'failed');
    }
    finally { state.collecting = false; $('p2p-create-offer').disabled = false; $('p2p-apply-signal').disabled = false; if (UI && button) UI.busy(button, false); }
  }
  async function copyText(text) {
    if (!text) throw Error('Não há nenhum código para copiar.');
    try { if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(text); return; } } catch {}
    const input = document.createElement('textarea'); input.value = text;
    input.style.cssText = 'position:fixed;left:-10000px;top:0'; document.body.append(input); input.select();
    const ok = document.execCommand('copy'); input.remove();
    if (!ok) throw Error('Selecione e copie o texto manualmente.');
  }
  /* VEIL 2.1 — single-invite auto-rendezvous. No app server.
     Public shared MQTT broker receives ONLY application-AEAD-encrypted ICE/SDP.
     User messages/files use existing WebRTC + AES-GCM transport, never MQTT. */
  const auto = {
    active: false, socket: null, socketReady: false, subscribed: false, topic: '',
    selfId: '', remoteId: '', generation: 0, reconnectCount: 0,
    packetSerial: Promise.resolve(), offersBusy: false,
    joinTimer: null, pingTimer: null, retryTimer: null,
    pendingCandidates: [], seenSignals: new Set()
  };
  const MQTT_ENCODER = new TextEncoder();
  function byteConcat(...buffers) {
    const total = buffers.reduce((size, bytes) => size + bytes.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of buffers) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
  function mqttStr(text) {
    const b = MQTT_ENCODER.encode(text);
    if (b.length > 65535) throw Error('String MQTT excede o limite.');
    return byteConcat(new Uint8Array([b.length >>> 8, b.length & 255]), b);
  }
  function mqttVar(value) {
    if (value > 256 * 1024 || value < 0) throw Error('Pacote MQTT excede o limite.');
    const result = [];
    do { let digit = value % 128; value = Math.floor(value / 128); if (value) digit |= 128; result.push(digit); } while (value);
    return new Uint8Array(result);
  }
  function mqttFrame(type, data) { return byteConcat(new Uint8Array([type]), mqttVar(data.length), data); }
  function mqttSend(frame) {
    if (!auto.socket || auto.socket.readyState !== WebSocket.OPEN) throw Error('Serviço de encontro desconectado.');
    auto.socket.send(frame);
  }
  function mqttConnect() {
    const data = byteConcat(mqttStr('MQTT'), new Uint8Array([4, 2, 0, 35]), mqttStr('veil-' + auto.selfId));
    mqttSend(mqttFrame(0x10, data));
  }
  function mqttSubscribe() {
    const data = byteConcat(new Uint8Array([0, 1]), mqttStr(auto.topic), new Uint8Array([0]));
    mqttSend(mqttFrame(0x82, data));
  }
  function mqttPublish(data) {
    if (!auto.subscribed) throw Error('Ainda aguardando o serviço de encontro.');
    mqttSend(mqttFrame(0x30, byteConcat(mqttStr(auto.topic), MQTT_ENCODER.encode(data))));
  }
  function mqttReadPacket(buffer, action) {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length;) {
      const header = bytes[i++];
      let len = 0, mul = 1, digit, used = 0;
      do {
        if (i >= bytes.length || used++ > 3) throw Error('Resposta MQTT inválida.');
        digit = bytes[i++]; len += (digit & 127) * mul; mul *= 128;
      } while (digit & 128);
      if (len > 256 * 1024 || i + len > bytes.length) throw Error('Pacote MQTT incompleto ou grande.');
      action(header >>> 4, bytes.slice(i, i + len));
      i += len;
    }
  }
  function mqttReadUtf8(data, at) {
    if (at + 2 > data.length) throw Error('Tópico MQTT inválido.');
    const len = (data[at] << 8) | data[at + 1];
    if (at + 2 + len > data.length) throw Error('Tópico truncado.');
    return { text: D.decode(data.slice(at + 2, at + 2 + len)), next: at + 2 + len };
  }
  function setAutoStatus(message, ready = false) {
    if ($('p2p-auto-status')) $('p2p-auto-status').textContent = message;
    if ($('p2p-broker-light')) $('p2p-broker-light').className = 'p2p-light ' + (ready ? 'ready' : '');
  }
  function stopAuto() {
    auto.active = false; auto.socketReady = false; auto.subscribed = false;
    auto.generation++;
    if (auto.joinTimer) clearInterval(auto.joinTimer);
    if (auto.pingTimer) clearInterval(auto.pingTimer);
    if (auto.retryTimer) clearTimeout(auto.retryTimer);
    auto.joinTimer = auto.pingTimer = auto.retryTimer = null;
    if (auto.socket) {
      const sock = auto.socket; auto.socket = null;
      try { if (sock.readyState === WebSocket.OPEN) sock.send(new Uint8Array([0xe0, 0])); } catch {}
      try { sock.close(1000, 'Sessão encerrada'); } catch {}
    }
    auto.pendingCandidates.length = 0;
    auto.seenSignals.clear();
    auto.offersBusy = false;
    syncNet();
  }
  async function publishSignal(signal) {
    if (!auto.active || !auto.subscribed || !state.key) return;
    const id = hex(random(12));
    const iv = random(12);
    const data = E.encode(JSON.stringify({ v: 2, id, from: auto.selfId, to: signal.to || '', sent: Date.now(), ...signal }));
    if (data.length > 110000) throw Error('Sinalização muito grande.');
    const aad = E.encode('VEIL-AUTO2|' + state.room);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, state.key, data);
    mqttPublish(JSON.stringify({ v: 2, n: toB64(iv), c: toB64(cipher) }));
  }
  async function onMqttPacket(type, data) {
    if (!auto.active || !state.room) return;
    if (type === 2) {
      if (data.length !== 2 || data[1] !== 0) throw Error('Broker recusou a conexão MQTT.');
      auto.socketReady = true; mqttSubscribe();
    } else if (type === 9) {
      if (data.length < 3 || data[2] === 128) throw Error('Broker recusou a inscrição na sala.');
      auto.subscribed = true;
      setTrack('peer');
      setAutoStatus(state.role === 'host' ? 'Sala disponível. Aguardando contato entrar com o convite.' : 'Convite recebido. Procurando o criador da sala...', true);
      if (auto.joinTimer) clearInterval(auto.joinTimer);
      if (state.role === 'guest') {
        const tick = () => { if (auto.subscribed && !state.authenticated) publishSignal({ type: 'join' }).catch((e) => setAutoStatus('Falha de encontro: ' + errorText(e))); };
        tick(); auto.joinTimer = setInterval(tick, 4500);
      }
    } else if (type === 3) {
      const t = mqttReadUtf8(data, 0);
      if (t.text !== auto.topic || data.length - t.next > 200000) return;
      const text = D.decode(data.subarray(t.next));
      await processSignal(text);
    }
  }
  async function processSignal(str) {
    let frame, signal;
    try {
      if (str.length > 200000) return;
      frame = JSON.parse(str);
      if (frame.v !== 2 || typeof frame.n !== 'string' || typeof frame.c !== 'string') return;
      const iv = fromB64(frame.n);
      if (iv.length !== 12 || frame.c.length > 180000) return;
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: E.encode('VEIL-AUTO2|' + state.room), tagLength: 128 }, state.key, fromB64(frame.c));
      signal = JSON.parse(D.decode(plain));
    } catch { return; } // Encrypted data from another client is never surfaced.
    if (signal.v !== 2 || typeof signal.id !== 'string' || !/^[a-f0-9]{24}$/.test(signal.id)
      || typeof signal.from !== 'string' || !/^[a-f0-9]{24}$/.test(signal.from)
      || signal.from === auto.selfId || typeof signal.sent !== 'number'
      || Math.abs(Date.now() - signal.sent) > 120000 || (signal.to && signal.to !== auto.selfId)) return;
    if (auto.seenSignals.has(signal.id)) return;
    if (auto.seenSignals.size > 1500) auto.seenSignals.clear();
    auto.seenSignals.add(signal.id);
    if (auto.remoteId && signal.from !== auto.remoteId) return; // one-to-one room
    if (signal.type === 'join' && state.role === 'host') {
      auto.remoteId = signal.from;
      if (!state.authenticated && view.phase !== 'negotiating') { setPhase('negotiating'); setTrack('route'); }
      await hostOffer();
    } else if (signal.type === 'offer' && state.role === 'guest') {
      auto.remoteId = signal.from;
      if (!state.authenticated && view.phase !== 'negotiating') { setPhase('negotiating'); setTrack('route'); }
      await guestAnswer(signal);
    } else if (signal.type === 'answer' && state.role === 'host') {
      if (state.pc && state.pc.signalingState === 'have-local-offer' && typeof signal.sdp === 'string' && signal.sdp.startsWith('v=0') && signal.sdp.length < 120000) {
        await state.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        await drainCandidates();
        setAutoStatus('Resposta recebida. Concluindo rota de rede...', true);
      }
    } else if (signal.type === 'candidate' && signal.candidate && typeof signal.candidate.candidate === 'string') {
      if (signal.candidate.candidate.length > 5000) return;
      if (auto.pendingCandidates.length >= 180) auto.pendingCandidates.shift();
      auto.pendingCandidates.push(signal.candidate);
      await drainCandidates();
    }
  }
  async function drainCandidates() {
    const pc = state.pc;
    if (!pc || !pc.remoteDescription) return;
    while (auto.pendingCandidates.length) {
      const cand = auto.pendingCandidates.shift();
      try { await pc.addIceCandidate(cand); } catch (e) { info('Candidato ICE recusado: ' + errorText(e), true); }
    }
  }
  function configureAutoCandidates(pc) {
    pc.onicecandidate = (event) => {
      if (pc !== state.pc || !auto.active || !event.candidate) return;
      publishSignal({ type: 'candidate', to: auto.remoteId, candidate: event.candidate.toJSON() }).catch((e) => setAutoStatus('Não foi possível enviar candidato ICE: ' + errorText(e)));
    };
  }
  async function hostOffer() {
    if (auto.offersBusy || state.authenticated) return;
    auto.offersBusy = true;
    try {
      if (!state.pc) {
        const pc = createPeer();
        configureAutoCandidates(pc);
        bindChannel(pc.createDataChannel('veil-direct', { ordered: true }));
        await pc.setLocalDescription(await pc.createOffer());
      }
      if (state.pc.signalingState === 'have-local-offer') {
        await publishSignal({ type: 'offer', to: auto.remoteId, sdp: state.pc.localDescription.sdp });
        setAutoStatus('Convite aceito. Enviando negociação WebRTC cifrada...', true);
      }
    } catch (e) { setAutoStatus('Falha na oferta: ' + errorText(e)); info(errorText(e), true); }
    finally { auto.offersBusy = false; }
  }
  async function guestAnswer(signal) {
    if (auto.offersBusy || state.authenticated) return;
    if (typeof signal.sdp !== 'string' || !signal.sdp.startsWith('v=0') || signal.sdp.length > 120000) return;
    auto.offersBusy = true;
    try {
      if (!state.pc) {
        const pc = createPeer();
        configureAutoCandidates(pc);
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await drainCandidates();
        await pc.setLocalDescription(await pc.createAnswer());
      }
      if (state.pc.localDescription && state.pc.localDescription.type === 'answer') {
        await publishSignal({ type: 'answer', to: auto.remoteId, sdp: state.pc.localDescription.sdp });
        setAutoStatus('Negociação concluída. Abrindo canal privado...', true);
      }
    } catch (e) { setAutoStatus('Falha na resposta: ' + errorText(e)); info(errorText(e), true); }
    finally { auto.offersBusy = false; }
  }
  async function startAuto() {
    if (!state.key || !state.room) throw Error('Crie ou importe um convite primeiro.');
    if (typeof WebSocket === 'undefined') { setAutoStatus('WebSocket indisponível. Use o modo manual, em Avançado.'); return; }
    stopAuto();
    auto.active = true;
    auto.selfId = hex(random(12));
    auto.remoteId = ''; auto.reconnectCount = 0;
    const topicDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', E.encode('VEIL-AUTO2-TOPIC|' + state.room + '|' + hex(state.secret))));
    auto.topic = 'veil/p2p/v2/' + hex(topicDigest);
    connectBroker(auto.generation);
  }
  function connectBroker(generation) {
    if (!auto.active || generation !== auto.generation) return;
    let endpoint;
    try { endpoint = brokerUrl(); } catch (e) { setAutoStatus(errorText(e)); return; }
    let socket;
    try { socket = new WebSocket(endpoint, ['mqtt']); }
    catch (e) { setAutoStatus('Broker inacessível: ' + errorText(e)); return; }
    auto.socket = socket;
    setTrack('broker');
    if (view.phase !== 'negotiating') setPhase('waiting');
    if (auto.pingTimer) clearInterval(auto.pingTimer);
    auto.pingTimer = null;
    socket.binaryType = 'arraybuffer';
    auto.socketReady = false; auto.subscribed = false;
    setAutoStatus('Abrindo canal TLS para encontro de dispositivos...');
    socket.onopen = () => {
      if (generation !== auto.generation || !auto.active) return;
      try { mqttConnect(); } catch (e) { setAutoStatus('Erro MQTT: ' + errorText(e)); }
    };
    socket.onmessage = (event) => {
      if (generation !== auto.generation || !auto.active) return;
      auto.packetSerial = auto.packetSerial.then(async () => {
        const buf = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        const jobs = [];
        mqttReadPacket(buf, (type, data) => jobs.push({type, data}));
        for (const job of jobs) await onMqttPacket(job.type, job.data);
      }).catch((e) => { setAutoStatus('Erro na sinalização: ' + errorText(e)); });
    };
    socket.onclose = () => {
      if (generation !== auto.generation || !auto.active) return;
      auto.socketReady = false; auto.subscribed = false;
      if (auto.joinTimer) clearInterval(auto.joinTimer);
      auto.joinTimer = null;
      if (!state.authenticated && auto.reconnectCount < 4) {
        auto.reconnectCount++;
        const delay = Math.min(12000, 1200 * auto.reconnectCount * auto.reconnectCount);
        setAutoStatus('Broker desconectado. Nova tentativa automática (' + auto.reconnectCount + '/4)...');
        auto.retryTimer = setTimeout(() => connectBroker(generation), delay);
      } else if (!state.authenticated) {
        setAutoStatus('Broker indisponível. Escolha outro serviço e clique Reconectar.');
        if (auto.socket === socket) auto.socket = null;
        setStatus('Serviço de encontro indisponível.', 'failed');
        if (UI) UI.openDisclosure('p2p-net-body');
      }
    };
    socket.onerror = () => { if (auto.active) setAutoStatus('Falha de rede com broker. Tentando restabelecer...'); };
    auto.pingTimer = setInterval(() => {
      if (auto.socket === socket && auto.socketReady && socket.readyState === WebSocket.OPEN) {
        try { mqttSend(new Uint8Array([0xc0, 0])); } catch {}
      }
    }, 22000);
  }
  async function retryAuto() {
    if (!state.room) { info('Crie uma sala ou entre por convite primeiro.', true); return; }
    disconnect(false);
    await startAuto();
  }
  async function selectedRoute() {
    if (!state.pc || typeof state.pc.getStats !== 'function') return;
    try {
      const stats = await state.pc.getStats();
      let selected;
      for (const entry of stats.values()) if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && (entry.selected || entry.nominated)) { selected = entry; break; }
      if (!selected) return;
      const local = stats.get(selected.localCandidateId);
      const mode = local?.candidateType === 'relay' ? 'via TURN (relay)' : 'direta (STUN/LAN)';
      info('Rota confirmada: ' + mode + '. WebRTC DTLS + AES-256-GCM na aplicação. O tráfego não é invisível à rede.');
    } catch {}
  }

  // QR payload contains the FULL secret. Never send it to a QR/image service.
  function renderSecretQr() {
    if (!state.token || state.role !== 'host') throw Error('Crie uma sala antes de gerar o QR.');
    if (typeof VeilQrGenerator !== 'function') throw Error('Gerador QR local indisponível.');
    const qr = new VeilQrGenerator(0, 1); // error-correction level L
    qr.addData(state.token);
    qr.make();
    const modules = qr.getModuleCount(), quiet = 4, resolution = 5;
    const canvas = $('p2p-qr-canvas');
    canvas.width = canvas.height = (modules + quiet * 2) * resolution;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111b14';
    for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
      if (qr.isDark(y, x)) ctx.fillRect((x + quiet) * resolution, (y + quiet) * resolution, resolution, resolution);
    }
  }
  function setCodeVeiled(veiled) {
    const wrap = $('p2p-code-wrap'), toggle = $('p2p-code-toggle');
    if (!wrap || !wrap.dataset) return;
    wrap.dataset.veiled = String(veiled);
    toggle.setAttribute('aria-pressed', String(!veiled));
    toggle.textContent = veiled ? 'Mostrar texto' : 'Ocultar texto';
  }
  // The QR is only drawn while the panel is open, and wiped from the canvas when it closes.
  function hideSecretQr() {
    const panel = $('p2p-qr-panel');
    if (!panel) return;
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    const button = $('p2p-show-qr');
    if (button) button.setAttribute('aria-expanded', 'false');
    const canvas = $('p2p-qr-canvas');
    if (wasOpen && UI && canvas && canvas.getContext) { canvas.width = canvas.height = 1; }
  }
  function openSecretQr() {
    const panel = $('p2p-qr-panel');
    if (!panel.hidden) { hideSecretQr(); return; }
    renderSecretQr(); panel.hidden = false;
    $('p2p-show-qr').setAttribute('aria-expanded', 'true');
    if (UI) { UI.unveil(panel, 760); if (panel.scrollIntoView) panel.scrollIntoView({ behavior: UI.reduced() ? 'auto' : 'smooth', block: 'nearest' }); }
  }
  function setScanStatus(value) { if ($('p2p-scan-status')) $('p2p-scan-status').textContent = value; }
  function openScanModal() {
    const modal = $('p2p-scan-modal');
    if (UI) UI.openModal(modal, closeQrScanner); else modal.hidden = false;
  }
  function closeQrScanner() {
    state.scanEpoch++;
    if (state.scanInterval) clearInterval(state.scanInterval);
    state.scanInterval = null;
    if (state.scannerStream) { for (const track of state.scannerStream.getTracks()) track.stop(); }
    state.scannerStream = null;
    const video = $('p2p-scan-video');
    if (video) { if (typeof video.pause === 'function') video.pause(); video.srcObject = null; }
    const modal = $('p2p-scan-modal');
    if (modal) { if (UI) UI.closeModal(modal); else modal.hidden = true; }
  }
  async function findQr(text) {
    let token = String(text || '').trim();
    // Accept the secret token, or the complete URL with an encoded token fragment.
    if (token.includes('#veil-invite=')) token = decodeURIComponent(token.split('#veil-invite=').pop());
    const parsed = parseToken(token); // Validate before starting or replacing any connection.
    closeQrScanner();
    chooseRole('guest');
    $('p2p-join-code').value = token;
    await installSession(parsed.room, parsed.secret, parsed.broker);
  }
  async function qrDetector() {
    if (!('BarcodeDetector' in window)) throw Error('Leitor QR nativo indisponível. Use outro navegador compatível ou copie o convite.');
    const formats = await BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) throw Error('Este navegador não oferece leitura de QR Code.');
    return new BarcodeDetector({ formats: ['qr_code'] });
  }
  async function startQrScanner() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('A câmera requer navegador com permissões e contexto seguro (HTTPS ou file:// compatível).');
    const detector = await qrDetector();
    closeQrScanner();
    await new Promise((resolve) => setTimeout(resolve, UI && !UI.reduced() ? 220 : 0)); // let the closing transition finish
    openScanModal();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    state.scannerStream = stream;
    const video = $('p2p-scan-video'); video.srcObject = stream; await video.play();
    if ($('p2p-scan-modal').classList.add) $('p2p-scan-modal').classList.add('is-scanning');
    setScanStatus('Aponte a câmera para o QR Code VEIL, sem enviá-lo a terceiros.');
    let scanning = false;
    const scanEpoch = state.scanEpoch;
    state.scanInterval = setInterval(async () => {
      if (scanning || video.readyState < 2) return;
      scanning = true;
      try {
        const codes = await detector.detect(video);
        const code = codes.find(item => /^VEILP2P[12]\./.test(item.rawValue || ''));
        if (code && scanEpoch === state.scanEpoch) await findQr(code.rawValue);
      } catch (e) { if (/convite|inválido|Versão/i.test(errorText(e))) setScanStatus(errorText(e)); }
      finally { scanning = false; }
    }, 240);
  }
  async function scanQrImage(file) {
    if (!file || file.size > 8 * 1024 * 1024 || !file.type.startsWith('image/')) throw Error('Selecione uma imagem de QR com até 8 MiB.');
    const detector = await qrDetector();
    const epoch = state.scanEpoch;
    let bitmap = null;
    let url = null;
    try {
      if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(file);
      else {
        url = URL.createObjectURL(file);
        bitmap = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(Error('Não foi possível abrir a imagem.'));
          image.src = url;
        });
      }
      const codes = await detector.detect(bitmap);
      const code = codes.find(item => /^VEILP2P[12]\./.test(item.rawValue || ''));
      if (!code) throw Error('Nenhum convite VEIL encontrado na imagem.');
      if (epoch === state.scanEpoch) await findQr(code.rawValue);
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      if (url) URL.revokeObjectURL(url);
    }
  }

  function ready() {
    $('p2p-host').onclick = () => chooseRole('host');
    $('p2p-guest').onclick = () => chooseRole('guest');
    $('p2p-generate').onclick = () => safeAction(async () => installSession(hex(random(16)), random(32)), $('p2p-generate'));
    $('p2p-join').onclick = () => safeAction(async () => {
      const token = $('p2p-join-code').value.trim();
      const parsed = parseToken(token);
      await installSession(parsed.room, parsed.secret, parsed.broker);
    }, $('p2p-join'));
    $('p2p-enable-stun').onchange = () => { $('p2p-stun-block').hidden = !$('p2p-enable-stun').checked; };
    $('p2p-enable-turn').onchange = () => { $('p2p-turn-block').hidden = !$('p2p-enable-turn').checked; if (!$('p2p-enable-turn').checked) $('p2p-relay-only').checked = false; };
    $('p2p-auto-retry').onclick = () => safeAction(retryAuto, $('p2p-auto-retry'));
    $('p2p-banner-retry').onclick = () => safeAction(retryAuto, $('p2p-banner-retry'));
    const onBrokerChanged = () => {
      $('p2p-custom-broker').hidden = $('p2p-broker-url').value !== 'custom';
      try {
        if (state.role === 'host' && state.room && state.secret) { state.token = makeToken(state.room, state.secret); $('p2p-code').textContent = state.token; hideSecretQr(); }
        if (auto.active && state.room) safeAction(retryAuto);
      } catch(e) { setAutoStatus(errorText(e)); }
    };
    $('p2p-broker-url').onchange = onBrokerChanged;
    $('p2p-broker-custom-url').onchange = onBrokerChanged;
    $('p2p-create-offer').onclick = () => safeAction(async () => { if (auto.active) { disconnect(false); setAutoStatus('Modo manual selecionado.'); } await createOffer(); });
    $('p2p-apply-signal').onclick = () => safeAction(async () => { if (auto.active) { disconnect(false); setAutoStatus('Modo manual selecionado.'); } await applyRemote(); });
    $('p2p-reset').onclick = () => {
      disconnect(false);
      setAutoStatus('Canal encerrado. Clique Reconectar para reiniciar a negociação automática.');
      $('p2p-local-signal').value = '';
      $('p2p-remote-signal').value = '';
      info('Canal reiniciado. A credencial da sala foi mantida apenas em memória.');
    };
    $('p2p-show-qr').onclick = () => safeAction(openSecretQr);
    $('p2p-hide-qr').onclick = hideSecretQr;
    $('p2p-code-toggle').onclick = () => setCodeVeiled($('p2p-code-wrap').dataset.veiled === 'false');
    $('p2p-leave').onclick = () => { chooseRole(state.role || 'host'); info('Você saiu da sala. A chave foi apagada da memória desta aba.'); if (UI) UI.toast('Você saiu da sala.'); };
    $('p2p-tab-room').onclick = () => setPane('room');
    $('p2p-tab-chat').onclick = () => setPane('chat');
    $('p2p-jump').onclick = () => { const root = $('p2p-messages'); root.scrollTop = root.scrollHeight; $('p2p-jump').hidden = true; };
    $('p2p-messages').onscroll = () => { const root = $('p2p-messages'); if (root.scrollHeight - root.scrollTop - root.clientHeight < 60 && $('p2p-jump')) $('p2p-jump').hidden = true; };
    $('p2p-file-clear').onclick = () => { $('p2p-file').value = ''; syncAttachment(); };
    $('p2p-once').onchange = defaultComposeNote;
    $('p2p-draft').oninput = resizeDraft;
    $('p2p-save-qr').onclick = () => safeAction(async () => { const link = document.createElement('a'); link.download = 'VEIL_convite_SECRETO.png'; link.href = $('p2p-qr-canvas').toDataURL('image/png'); link.click(); });
    $('p2p-scan-open').onclick = () => {
      openScanModal();
      setScanStatus('BarcodeDetector' in window ? 'Ative a câmera ou selecione uma imagem. Nenhuma imagem é enviada.' : 'Este navegador não tem leitor de QR nativo. Use a câmera do sistema e cole o convite no campo da sala.');
    };
    $('p2p-scan-start').onclick = () => safeAction(async () => { try { await startQrScanner(); } catch (e) { setScanStatus(errorText(e)); throw e; } });
    $('p2p-scan-close').onclick = closeQrScanner;
    $('p2p-scan-image').onchange = () => safeAction(async () => { try { await scanQrImage($('p2p-scan-image').files?.[0]); } catch (e) { setScanStatus(errorText(e)); throw e; } finally { $('p2p-scan-image').value = ''; } });
    $('p2p-scan-modal').onclick = (e) => { if (e.target === $('p2p-scan-modal')) closeQrScanner(); };
    $('p2p-padding').onchange = () => info($('p2p-padding').checked ? 'Preenchimento de comprimento ativado para novos frames.' : 'Preenchimento desativado. Tamanhos originais podem ser inferidos.');
    $('p2p-cover').onchange = scheduleCover;
    $('p2p-privacy-preset').onclick = () => { $('p2p-enable-turn').checked = true; $('p2p-turn-block').hidden = false; $('p2p-relay-only').checked = true; $('p2p-enable-stun').checked = false; $('p2p-stun-block').hidden = true; info('Modo relay-only ativo. Configure um TURN/TLS confiável com usuário e senha e reconecte. Sem TURN válido, nenhuma rota direta será usada.'); };
    $('p2p-copy-secret').onclick = () => copyText(state.token).then(() => { info('Credencial copiada. Trate como senha.'); if (UI) { UI.confirmLabel($('p2p-copy-secret'), 'Copiado'); UI.toast('Convite copiado. Trate como uma senha.'); } }).catch((e) => info(errorText(e), true));
    $('p2p-copy-signal').onclick = () => copyText($('p2p-local-signal').value).then(() => { info('Código de negociação copiado.'); if (UI) UI.confirmLabel($('p2p-copy-signal'), 'Copiado'); }).catch((e) => info(errorText(e), true));
    $('p2p-compose').onsubmit = onSubmit;
    $('p2p-draft').onkeydown = (event) => {
      // On touch keyboards Enter makes a new line; the send button is always within reach.
      const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touch) { event.preventDefault(); $('p2p-compose').requestSubmit(); }
    };
    $('p2p-file').onchange = syncAttachment;
    wireDrop();
    document.addEventListener('visibilitychange', () => { if (document.hidden) { burnAllRevealed(); closeQrScanner(); hideSecretQr(); } else if (chatVisible()) clearUnread(); });
    if (UI) UI.onView((name) => { if (name === 'p2p' && chatVisible()) clearUnread(); });
    window.addEventListener('pagehide', () => { burnAllRevealed(); disconnect(true); });
    chooseRole('host');
    view.started = true;
    if (!supported()) setStatus('WebRTC ou WebCrypto indisponível aqui. Veja o Guia.', 'failed');
  }
  // Drag a file onto the conversation to attach it (same input, same limits).
  function wireDrop() {
    const chat = $('p2p-chat');
    if (!chat || !chat.classList || !chat.classList.add || !UI) return;
    let depth = 0;
    const hasFile = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    chat.addEventListener('dragenter', (event) => { if (!hasFile(event) || $('p2p-file').disabled) return; event.preventDefault(); depth++; chat.classList.add('is-dragging'); });
    chat.addEventListener('dragover', (event) => { if (hasFile(event) && !$('p2p-file').disabled) event.preventDefault(); });
    chat.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) chat.classList.remove('is-dragging'); });
    chat.addEventListener('drop', (event) => {
      depth = 0; chat.classList.remove('is-dragging');
      if (!hasFile(event) || $('p2p-file').disabled) return;
      event.preventDefault();
      try { $('p2p-file').files = event.dataTransfer.files; syncAttachment(); } catch { composeNote('Não foi possível anexar pelo arrasto. Use o botão de anexo.', 'error'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
  // Expose only non-secret diagnostics for automated QA. No keys or payloads.
  Object.defineProperty(window, 'VEIL_P2P_DIAGNOSTICS', {
    value: Object.freeze({ status: () => ({ connected: state.authenticated, role: state.role, state: state.pc?.connectionState || 'none', messages: state.messages.length }) }),
    configurable: false
  });
})();
