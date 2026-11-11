/* VEIL UI — presentation layer shared by the crypto studio (core.js) and the P2P module (p2p.js).
   Nothing here touches keys, plaintext storage or the network. */
const VeilUI = (() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const once = (el, type, fn) => el.addEventListener(type, fn, { once: true });

  /* ── theme ───────────────────────────────────────── */
  const root = document.documentElement;
  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = theme === 'light' ? '#e8ebf3' : '#14172a';
    $('theme-label').textContent = theme === 'light' ? 'Tema claro' : 'Tema escuro';
    if (persist) { try { localStorage.setItem('veil-theme', theme); } catch { /* storage may be blocked on file:// */ } }
    veil.recolor();
  }

  /* ── toasts ──────────────────────────────────────── */
  function toast(text) {
    const live = $('toast');
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = text; });
    const host = $('toasts');
    while (host.children.length >= 3) host.firstChild.remove();
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    host.append(node);
    const leave = () => { node.classList.add('is-out'); setTimeout(() => node.remove(), 260); };
    setTimeout(leave, 3400);
  }

  /* ── notices (inline alerts) ─────────────────────── */
  function notice(target, message, type = 'error') {
    const el = typeof target === 'string' ? $(target) : target;
    const wasHidden = el.classList.contains('hidden');
    el.textContent = message;
    el.className = 'notice' + (type === 'success' ? ' notice-success' : type === 'info' ? ' notice-info' : '');
    el.classList.add(type === 'error' && !wasHidden ? 'is-shake' : 'is-in');
  }

  /* ── reveal helpers: the “veil” wipe ─────────────── */
  function unveil(el, duration) {
    if (!el || reduced()) return;
    el.classList.remove('unveil', 'reveil');
    void el.offsetWidth;
    if (duration) el.style.setProperty('--veil-dur', duration + 'ms');
    el.classList.add('unveil');
    once(el, 'animationend', () => el.classList.remove('unveil'));
  }
  function reveil(el) {
    return new Promise((resolve) => {
      if (!el || reduced()) { resolve(); return; }
      el.classList.remove('unveil');
      el.classList.add('reveil');
      const done = () => { el.classList.remove('reveil'); resolve(); };
      once(el, 'animationend', done);
      setTimeout(done, 600);
    });
  }
  /* Glyph settle: text resolves left→right out of cipher-like glyphs. Purely cosmetic; the final
     text is set as soon as the effect ends and immediately when motion is reduced. */
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789-_';
  function settleText(el, finalText, opts = {}) {
    const { duration = 620, limit = 320, toProse = false } = opts;
    if (reduced() || !finalText) { el.textContent = finalText; return; }
    const head = Array.from(finalText.slice(0, limit));
    const tail = finalText.slice(head.join('').length);
    const start = performance.now();
    const token = (el._settle = (el._settle || 0) + 1);
    if (toProse) { el.classList.remove('settle'); void el.offsetWidth; el.classList.add('settle'); once(el, 'animationend', () => el.classList.remove('settle')); }
    const frame = (time) => {
      if (el._settle !== token) return;
      const k = Math.min(1, (time - start) / duration);
      const settled = Math.floor(head.length * k);
      let out = head.slice(0, settled).join('');
      for (let i = settled; i < head.length; i++) out += /\s/.test(head[i]) ? head[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = k < 1 ? out + tail : finalText;
      if (k < 1) requestAnimationFrame(frame);
    };
    el.textContent = '';
    requestAnimationFrame(frame);
  }

  /* ── buttons ─────────────────────────────────────── */
  function busy(target, on) {
    const b = typeof target === 'string' ? $(target) : target;
    if (!b) return;
    b.disabled = on;
    b.classList.toggle('is-busy', on);
    b.setAttribute('aria-busy', String(on));
  }
  function confirmLabel(button, text) {
    const label = button.querySelector('.btn-label');
    if (!label || button._labelTimer) return;
    const original = label.textContent;
    label.textContent = text;
    button.classList.add('is-done');
    button._labelTimer = setTimeout(() => { label.textContent = original; button.classList.remove('is-done'); button._labelTimer = null; }, 1500);
  }

  /* ── segmented controls: sliding thumb ───────────── */
  function syncSegment(group) {
    const thumb = group.querySelector(':scope > .seg-thumb');
    if (!thumb) return;
    const active = group.querySelector(':scope > .seg[aria-selected="true"], :scope > .seg[aria-pressed="true"]');
    if (!active || !group.offsetWidth) { thumb.classList.remove('is-ready'); return; }
    group.style.setProperty('--x', active.offsetLeft + 'px');
    group.style.setProperty('--w', active.offsetWidth + 'px');
    if (!thumb.classList.contains('is-ready')) requestAnimationFrame(() => thumb.classList.add('is-ready'));
  }
  function syncAllSegments() { document.querySelectorAll('.segmented, .pane-switch').forEach(syncSegment); syncNavPill(); }
  function wireSegments() {
    const observer = new MutationObserver((records) => {
      const groups = new Set();
      for (const r of records) { const g = r.target.closest('.segmented, .pane-switch'); if (g) groups.add(g); }
      groups.forEach(syncSegment);
    });
    document.querySelectorAll('.segmented, .pane-switch').forEach((group) => {
      observer.observe(group, { attributes: true, subtree: true, attributeFilter: ['aria-selected', 'aria-pressed'] });
      // Arrow keys move between options, as expected of a tab list.
      group.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const items = [...group.querySelectorAll(':scope > .seg')];
        const at = items.indexOf(document.activeElement);
        if (at < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        items[next].focus(); items[next].click();
      });
    });
    if ('ResizeObserver' in window) new ResizeObserver(syncAllSegments).observe(document.body);
    else addEventListener('resize', syncAllSegments);
    if (document.fonts?.ready) document.fonts.ready.then(syncAllSegments);
  }

  /* ── disclosures ─────────────────────────────────── */
  function setDisclosure(head, open) {
    const body = $(head.getAttribute('aria-controls'));
    head.setAttribute('aria-expanded', String(open));
    body.classList.toggle('is-open', open);
    body.inert = !open;
  }
  function wireDisclosures() {
    document.querySelectorAll('[data-disclosure] > .disclosure-head').forEach((head) => {
      setDisclosure(head, false);
      head.addEventListener('click', () => setDisclosure(head, head.getAttribute('aria-expanded') !== 'true'));
    });
  }
  function openDisclosure(bodyId) {
    const head = document.querySelector('.disclosure-head[aria-controls="' + bodyId + '"]');
    if (head) setDisclosure(head, true);
  }

  /* ── navigation ──────────────────────────────────── */
  const VIEWS = { p2p: 'view-p2p', encrypt: 'view-envelope', decrypt: 'view-envelope', once: 'view-once', keys: 'view-keys', tools: 'view-tools', guide: 'view-guide' };
  const ROUTES = { p2p: 'conversa', encrypt: 'proteger', decrypt: 'abrir', once: 'unica', keys: 'chaves', tools: 'verificar', guide: 'guia' };
  const fromRoute = (hash) => Object.keys(ROUTES).find((key) => ROUTES[key] === hash.replace(/^#/, ''));
  let currentView = '';
  const viewListeners = [];
  function syncNavPill() {
    const pill = $('nav-pill'), active = document.querySelector('.nav-item[aria-current="page"]');
    if (!pill || !active) return;
    const nav = $('nav');
    nav.style.setProperty('--y', active.offsetTop + 'px');
    nav.style.setProperty('--x', active.offsetLeft + 'px');
    nav.style.setProperty('--w', active.offsetWidth + 'px');
    if (!pill.classList.contains('is-ready')) requestAnimationFrame(() => pill.classList.add('is-ready'));
  }
  function setEnvelopeMode(mode, animate) {
    const enc = mode === 'encrypt';
    $('env-tab-encrypt').setAttribute('aria-selected', String(enc));
    $('env-tab-decrypt').setAttribute('aria-selected', String(!enc));
    const show = $(enc ? 'pane-encrypt' : 'pane-decrypt'), hide = $(enc ? 'pane-decrypt' : 'pane-encrypt');
    const changed = show.classList.contains('hidden');
    hide.classList.add('hidden');
    show.classList.remove('hidden');
    if (animate && changed && !reduced()) {
      show.style.setProperty('--dir', enc ? -1 : 1);
      show.classList.remove('is-entering'); void show.offsetWidth; show.classList.add('is-entering');
      once(show, 'animationend', () => show.classList.remove('is-entering'));
    }
  }
  function showView(name, opts = {}) {
    if (!VIEWS[name]) name = 'p2p';
    const targetId = VIEWS[name];
    const previous = currentView;
    const sameSection = previous && VIEWS[previous] === targetId;
    if (name === 'encrypt' || name === 'decrypt') { setEnvelopeMode(name, sameSection); if (sameSection && previous !== name) window.scrollTo(0, 0); }
    for (const item of document.querySelectorAll('.nav-item')) {
      const active = VIEWS[item.dataset.view] === targetId;
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    }
    syncNavPill();
    currentView = name;
    if (!sameSection) {
      for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== targetId;
      const view = $(targetId);
      if (!reduced()) {
        view.classList.remove('is-entering'); void view.offsetWidth; view.classList.add('is-entering');
        setTimeout(() => view.classList.remove('is-entering'), 700);
      }
      window.scrollTo(0, 0);
      if (opts.focus !== false && previous) view.querySelector('h1')?.focus({ preventScroll: true });
      syncAllSegments();
    }
    if (opts.route !== false) {
      const hash = '#' + ROUTES[name];
      try { if (location.hash !== hash) history[previous ? 'pushState' : 'replaceState'](null, '', hash); } catch { /* history is unavailable in some embedded viewers */ }
    }
    for (const fn of viewListeners) fn(name, previous);
    veil.visibility();
  }
  function wireNav() {
    document.querySelectorAll('.nav-item').forEach((item, i) => {
      item.style.setProperty('--i', i);
      item.addEventListener('click', () => showView(item.dataset.view === 'encrypt' && (currentView === 'decrypt') ? 'decrypt' : item.dataset.view));
    });
    $('env-tab-encrypt').addEventListener('click', () => showView('encrypt'));
    $('env-tab-decrypt').addEventListener('click', () => showView('decrypt'));
    addEventListener('popstate', () => showView(fromRoute(location.hash) || 'p2p', { route: false }));
  }

  /* ── modal: focus trap, Escape, restore focus ────── */
  const modalState = new WeakMap();
  function openModal(modal, onRequestClose) {
    if (!modal.hidden) return;
    modal.hidden = false;
    modal.classList.remove('is-closing');
    const previous = document.activeElement;
    const keys = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onRequestClose(); return; }
      if (event.key !== 'Tab') return;
      const focusables = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keys);
    modalState.set(modal, { previous, keys });
    requestAnimationFrame(() => modal.querySelector('.btn-primary, button')?.focus());
  }
  function closeModal(modal) {
    const saved = modalState.get(modal);
    if (saved) { document.removeEventListener('keydown', saved.keys); modalState.delete(modal); }
    if (modal.hidden) return;
    const finish = () => { modal.hidden = true; modal.classList.remove('is-closing', 'is-scanning'); };
    if (reduced()) finish(); else { modal.classList.add('is-closing'); setTimeout(finish, 200); }
    if (saved?.previous?.isConnected) saved.previous.focus({ preventScroll: true });
  }

  /* ── network indicator: says what is actually open ─ */
  const NET = {
    idle: ['Sem conexões abertas', 'Nada sai deste dispositivo agora.'],
    broker: ['Broker de encontro aberto', 'Só a negociação cifrada passa por ele.'],
    p2p: ['Canal P2P ativo', 'Broker desconectado. Tráfego direto ou por relay.'],
    failed: ['Conexão interrompida', 'Veja a sala para reconectar.']
  };
  function setNet(kind) {
    const el = $('netstate');
    if (!el || !NET[kind] || el.dataset.net === kind) return;
    el.dataset.net = kind;
    $('netstate-title').textContent = NET[kind][0];
    $('netstate-detail').textContent = NET[kind][1];
  }

  /* ── countdown ring ──────────────────────────────── */
  function setRing(ring, fraction) { if (ring) ring.style.setProperty('--p', Math.max(0, Math.min(1, fraction)).toFixed(4)); }

  /* ── viewport: on-screen keyboard and visual height ─ */
  function wireViewport() {
    const vv = window.visualViewport;
    const update = () => {
      const height = vv ? vv.height : innerHeight;
      root.style.setProperty('--vvh', height + 'px');
      const keyboard = Boolean(vv) && innerWidth <= 860 && (window.screen.height - height > 260 || innerHeight - height > 120) && /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName || '');
      document.body.classList.toggle('kb-open', keyboard);
    };
    if (vv) { vv.addEventListener('resize', update); vv.addEventListener('scroll', update); }
    addEventListener('resize', update);
    addEventListener('orientationchange', () => setTimeout(() => { update(); syncAllSegments(); }, 250));
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => setTimeout(update, 60));
    update();
  }

  /* ── the veil: a drawn gauze over the conversation. Closed until the channel is authenticated,
        gathered to the sides while it is. Canvas 2D, paused whenever it is not on screen. ─── */
  const veil = (() => {
    let canvas, ctx, width = 0, height = 0, dpr = 1, raf = 0, last = 0, time = 0;
    let open = 0, targetOpen = 0, energy = 0, targetEnergy = 0, visible = false, colors = null;
    const triple = (value) => value.split(',').map(Number);
    const readColors = () => {
      const cs = getComputedStyle(root);
      colors = { a: triple(cs.getPropertyValue('--veil-a')), b: triple(cs.getPropertyValue('--veil-b')), c: triple(cs.getPropertyValue('--veil-c')), alpha: parseFloat(cs.getPropertyValue('--veil-alpha')) || 1, light: root.dataset.theme === 'light' };
    };
    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(rect.width)); height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      draw();
    }
    // One sheet of gauze: thin lit ridges, nearly clear troughs, folds of uneven width.
    function layer(folds, speed, strength, shift, tint) {
      const step = 2, gather = open * 0.945, span = 1 - gather; // share of each half still covered by cloth
      const { a, b, c } = colors;
      for (let x = 0; x < width; x += step) {
        const u = x / width;
        const side = u < 0.5 ? u * 2 : (1 - u) * 2;   // 0 at the edges → 1 at the centre
        if (side > span) continue;                    // parted
        const f = side / span;                        // position across the gathered cloth
        const wobble = 1.25 * Math.sin(u * 4.3 + shift + time * 0.09) + 0.5 * Math.sin(u * 11.7 - time * 0.13 + shift * 2);
        const phase = f * folds * (1 + gather * 2.6) * Math.PI + wobble + time * speed + shift;
        const lit = 0.5 + 0.5 * Math.sin(phase);
        const ridge = lit * lit * lit * lit * lit;
        const edge = Math.min(1, (span - side) / 0.06 + 0.2);
        const hue = Math.min(1, Math.max(0, tint + 0.3 * Math.sin(u * 3.1 + time * 0.11 + shift * 1.3)));
        const glint = ridge * ridge * 0.4;
        const r = (a[0] + (b[0] - a[0]) * hue) * (1 - glint) + c[0] * glint;
        const g = (a[1] + (b[1] - a[1]) * hue) * (1 - glint) + c[1] * glint;
        const bl = (a[2] + (b[2] - a[2]) * hue) * (1 - glint) + c[2] * glint;
        const alpha = strength * (0.035 + 0.965 * ridge) * edge * colors.alpha * (1 + energy * 0.25) * (1 - open * 0.35);
        ctx.fillStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (bl | 0) + ',' + alpha.toFixed(3) + ')';
        ctx.fillRect(x, 0, step, height);
      }
    }
    function draw() {
      if (!ctx || !colors) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = colors.light ? 'source-over' : 'lighter';
      layer(13, 0.13 + energy * 0.45, 0.34, 0, 0.12);
      layer(21, -(0.09 + energy * 0.33), 0.26, 1.7, 0.88);
      layer(37, 0.05 + energy * 0.2, 0.13, 4.1, 0.5);
      // Fade towards the hem so the cloth reads as hanging and the composer stays quiet.
      ctx.globalCompositeOperation = 'destination-in';
      const fade = ctx.createLinearGradient(0, 0, 0, height);
      fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(0.55, 'rgba(0,0,0,.78)'); fade.addColorStop(1, 'rgba(0,0,0,.08)');
      ctx.fillStyle = fade; ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
    function tick(now) {
      raf = 0;
      if (!visible) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      time += dt;
      open += (targetOpen - open) * Math.min(1, dt * 3.2);
      energy += (targetEnergy - energy) * Math.min(1, dt * 2);
      if (Math.abs(targetOpen - open) < 0.001) open = targetOpen;
      draw();
      // Drawn aside and settled: the gathered cloth rests, nothing left to animate.
      if (open === targetOpen && targetOpen > 0.5 && Math.abs(targetEnergy - energy) < 0.01) return;
      raf = requestAnimationFrame(tick);
    }
    function run() { if (!raf && visible && !reduced()) { last = 0; raf = requestAnimationFrame(tick); } }
    function visibility() {
      if (!canvas) return;
      const shown = !document.hidden && canvas.offsetParent !== null;
      if (shown === visible) { if (shown && !width) resize(); return; }
      visible = shown;
      if (visible) { resize(); run(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    function set(state) {
      if (typeof state.open === 'number') targetOpen = state.open;
      if (typeof state.energy === 'number') targetEnergy = state.energy;
      if (reduced()) { open = targetOpen; energy = targetEnergy; draw(); } else run();
    }
    function init() {
      canvas = $('veil-canvas');
      if (!canvas || !canvas.getContext) return;
      ctx = canvas.getContext('2d');
      readColors();
      if ('ResizeObserver' in window) new ResizeObserver(() => { resize(); visibility(); }).observe(canvas.parentElement);
      document.addEventListener('visibilitychange', visibility);
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { if (reduced()) { cancelAnimationFrame(raf); raf = 0; draw(); } else run(); });
      visibility();
    }
    return { init, set, visibility, recolor: () => { if (ctx) { readColors(); draw(); } } };
  })();

  /* ── boot ────────────────────────────────────────── */
  function boot() {
    wireNav(); wireSegments(); wireDisclosures(); wireViewport();
    veil.init();
    applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark', false);
    $('theme-toggle').addEventListener('click', () => applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true));
    const app = $('app');
    if (!reduced()) { app.classList.add('is-booting'); setTimeout(() => app.classList.remove('is-booting'), 1500); }
    showView(fromRoute(location.hash) || 'p2p', { focus: false });
  }

  return {
    $, reduced, boot, toast, notice, unveil, reveil, settleText, busy, confirmLabel, showView, openDisclosure,
    openModal, closeModal, setNet, setRing, veil, syncAllSegments,
    onView: (fn) => viewListeners.push(fn), currentView: () => currentView
  };
})();
VeilUI.boot();
