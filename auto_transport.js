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
      await hostOffer();
    } else if (signal.type === 'offer' && state.role === 'guest') {
      auto.remoteId = signal.from;
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
    if (typeof WebSocket === 'undefined') throw Error('WebSocket indisponível neste navegador.');
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
    const endpoint = $('p2p-broker-url').value;
    if (!['wss://broker.emqx.io:8084/mqtt', 'wss://broker.connectmq.com:8084/mqtt', 'wss://test.mosquitto.org:8081'].includes(endpoint)) {
      setAutoStatus('Endereço de encontro inválido.'); return;
    }
    let socket;
    try { socket = new WebSocket(endpoint, ['mqtt']); }
    catch (e) { setAutoStatus('Broker inacessível: ' + errorText(e)); return; }
    auto.socket = socket;
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
      } else if (!state.authenticated) setAutoStatus('Broker indisponível. Escolha outro serviço e clique Reconectar.');
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
