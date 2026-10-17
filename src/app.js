/* ChipWreck UI — lobby, waiting room and table. Game rules live in engine.js; sync in transport.js.
 * Rendering: each screen mounts a skeleton once, then named regions are patched only when their HTML
 * changes, so CSS animations (riffle, logo bob) keep running and inputs keep focus. */
(function () {
  'use strict';
  const E = window.ChipEngine;
  const T = window.ChipTransport;
  const $app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-NZ');
  const UP = (s) => String(s || '').toUpperCase();

  // ---------------- design constants ----------------
  const CHIPS = [
    { v: 5, label: '$5', base: '#B8432F', stripe: '#E3C35A' },
    { v: 10, label: '$10', base: '#2F5D73', stripe: '#E3E7D8' },
    { v: 25, label: '$25', base: '#E3C35A', stripe: '#141a17' },
    { v: 100, label: '$100', base: '#141a17', stripe: '#E3C35A' },
  ];
  const byV = (v) => CHIPS.find((c) => c.v === v);
  const AVATAR = ['#141a17', '#B8432F', '#2F5D73', '#839E9F', '#3B7955'];
  const ROOM_COLORS = ['#E3C35A', '#B8432F', '#2F5D73', '#839E9F', '#3B7955'];
  const STREET = { preflop: 'PREFLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER', showdown: 'SHOWDOWN' };
  const STACK_OPTS = [500, 1000, 2000];
  const BLIND_OPTS = [[5, 10], [10, 20], [25, 50]];
  const PIXEL = "font-family:var(--pixel);font-weight:400;letter-spacing:.03em;text-shadow:var(--fringe)";
  // chip geometry per size (top face height, side band, stripe widths, inner inset, ring, stack offset, shadow offset)
  const SIZE = {
    pot:   { w: 76,  face: 32, ry: 16, sideH: 28, a: 10, b: 16, inset: '14% 12%', ring: 1.5, dk: .05, off: 11, sh: 10, label: 'font-size:13px;font-weight:900' },
    tray:  { w: 104, face: 44, ry: 22, sideH: 38, a: 13, b: 22, inset: '13% 12%', ring: 2,   dk: .06, off: 16, sh: 20, label: PIXEL + ';font-size:20px' },
    zone:  { w: 170, face: 68, ry: 34, sideH: 54, a: 20, b: 33, inset: '13% 11%', ring: 2,   dk: .06, off: 20, sh: 20, label: PIXEL + ';font-size:20px' },
    rif:   { w: 44,  face: 18, ry: 9,  sideH: 17, a: 6,  b: 10, inset: '18% 14%', ring: 0,   dk: .05 },
    lobby: { w: 60,  face: 26, ry: 13, sideH: 23, a: 8,  b: 13, inset: '16% 12%', ring: 0,   dk: .05, off: 9, sh: 8 },
  };
  function greedy(amount) {
    const r = []; let rem = amount;
    for (const d of [100, 25, 10, 5]) while (rem >= d) { r.push(d); rem -= d; }
    return r;
  }

  // ---------------- components (HTML builders) ----------------
  function chipHTML(c, P, top, label, extraStyle) {
    const hw = P.w / 2;
    return `<div class="ch" style="left:0;top:${top}px;width:${P.w}px;height:${P.ry + P.sideH}px;${extraStyle || ''}">` +
      `<div class="ch-side" style="top:${P.ry}px;width:${P.w}px;height:${P.sideH}px;border-radius:0 0 ${hw}px ${hw}px / 0 0 ${P.ry}px ${P.ry}px;background:linear-gradient(90deg,rgba(0,0,0,${P.dk}),rgba(0,0,0,.4)),repeating-linear-gradient(90deg,${c.base} 0 ${P.a}px,${c.stripe} ${P.a}px ${P.b}px)"></div>` +
      `<div class="ch-face" style="width:${P.w}px;height:${P.face}px;background:repeating-conic-gradient(${c.base} 0deg 20deg,${c.stripe} 20deg 30deg)">` +
      `<div class="ch-in" style="inset:${P.inset};background:${c.base};${P.ring ? `border:${P.ring}px solid ${c.stripe};` : ''}color:${c.stripe};${P.label || ''}">${label || ''}</div></div></div>`;
  }
  // ChipStack3D: n chips of one colour, value shown on the top chip only
  function stack3D(c, n, P, opts) {
    opts = opts || {};
    const h = P.ry + P.sideH + P.off * (n - 1);
    let out = `<div style="position:relative;width:${P.w}px;height:${h}px;flex:none">`;
    out += `<div class="ch-shadow" style="left:${P.sh}px;top:${P.sh}px;width:${P.w}px;height:${opts.shadowH || h}px;border-radius:${P.w / 2}px / ${P.ry}px"></div>`;
    for (let i = 0; i < n; i++) out += chipHTML(c, P, (n - 1 - i) * P.off, opts.noLabel || i !== n - 1 ? '' : (opts.labelFn ? opts.labelFn(c) : c.label));
    return out + '</div>';
  }
  function riffleHTML(left, top) {
    let kids = `<div class="abs" style="left:6px;top:74px;width:100px;height:20px;border-radius:50%;background:#2A4B40"></div>`;
    const one = (c, key, x, y, z, dx, dy, delay) =>
      `<div class="abs rif" style="left:${x}px;top:${y}px;width:44px;height:26px;z-index:${z};--dx:${dx}px;--dy:${dy}px;animation:cwRiffle 2.6s cubic-bezier(.6,0,.3,1) ${delay}s infinite">${chipHTML(c, SIZE.rif, 0, '')}</div>`;
    const red = { base: '#B8432F', stripe: '#E3C35A' }, blk = { base: '#141a17', stripe: '#E3C35A' };
    for (let i = 0; i < 5; i++) {
      kids += one(red, 'l' + i, 0, 64 - i * 7, 2 * i, 25, -i * 7, i * .05);
      kids += one(blk, 'r' + i, 50, 64 - i * 7, 2 * i + 1, -25, -(i + 1) * 7, i * .05 + .02);
    }
    return `<div class="abs" style="left:${left}px;top:${top}px;width:110px;height:100px">${kids}</div>`;
  }
  // DealerScene (head cropped by the frame); 'lobby' variant has red bow tie and brass studs
  function dealerSVG(variant) {
    const L = variant === 'lobby';
    const vest = L ? '#0c100e' : '#141a17', bow = L ? '#B8432F' : '#141a17', stud = L ? '#E3C35A' : '#141a17';
    return `<svg class="abs" width="800" height="420" viewBox="0 0 800 420" style="left:0;top:0" aria-hidden="true"><g transform="translate(80 0) scale(0.8)">
      <rect x="380" y="0" width="40" height="56" fill="#CEC181"/>
      <path d="M380 26 Q400 38 420 26 L420 44 L380 44Z" fill="#b5a967"/>
      <path d="M300 92 Q262 110 258 180 Q258 214 290 230 L334 230 L334 204 L302 194 Q298 160 314 120Z" fill="#E3E7D8"/>
      <path d="M500 92 Q538 110 542 180 Q542 214 510 230 L466 230 L466 204 L498 194 Q502 160 486 120Z" fill="#E3E7D8"/>
      ${L ? '' : '<path d="M270 168 Q272 204 296 222 L284 224 Q264 206 264 172Z" fill="#d0d5c2"/><path d="M530 168 Q528 204 504 222 L516 224 Q536 206 536 172Z" fill="#d0d5c2"/>'}
      <path d="M292 240 L294 118 Q300 66 352 54 L380 46 L420 46 L448 54 Q500 66 506 118 L508 240Z" fill="#E3E7D8"/>
      <path d="M338 62 L384 54 L400 172 L416 54 L462 62 Q476 150 480 240 L320 240 Q324 150 338 62Z" fill="${vest}"/>
      <path d="M384 46 L400 70 L388 86 L370 54Z" fill="#d0d5c2"/>
      <path d="M416 46 L400 70 L412 86 L430 54Z" fill="#d0d5c2"/>
      <path d="M376 56 L398 65 L376 76Z M424 56 L402 65 L424 76Z" fill="${bow}"/>
      <rect x="393" y="60" width="14" height="10" rx="3" fill="${bow}"/>
      <circle cx="400" cy="100" r="3.5" fill="${stud}"/><circle cx="400" cy="124" r="3.5" fill="${stud}"/><circle cx="400" cy="148" r="3.5" fill="${stud}"/>
    </g></svg>`;
  }
  const handsSVG = `<svg class="abs" width="800" height="420" viewBox="0 0 800 420" style="left:0;top:0" aria-hidden="true"><g transform="translate(80 0) scale(0.8)">
      <path d="M314 214 Q334 206 352 214 Q360 222 352 230 Q334 236 316 230 Q308 222 314 214Z" fill="#CEC181"/>
      <path d="M486 214 Q466 206 448 214 Q440 222 448 230 Q466 236 484 230 Q492 222 486 214Z" fill="#CEC181"/></g></svg>`;
  const tableHTML = `<div class="abs" style="left:-160px;top:170px;width:1120px;height:460px;border-radius:50%;background:#2A4B40"></div>
    <div class="abs" style="left:-142px;top:188px;width:1084px;height:424px;border-radius:50%;background:radial-gradient(ellipse at 50% 25%,#4a8a63 0%,#3B7955 45%,#336a4b 100%)"></div>
    <div class="abs" style="left:-90px;top:226px;width:980px;height:360px;border-radius:50%;border:2px solid rgba(227,195,90,.4);box-sizing:border-box"></div>`;
  const avatarHTML = (color, dealer, glyph) => `<div class="avwrap"><div class="av" style="background:${color}${glyph ? ';--glyph:' + glyph : ''}"></div>${dealer ? '<div class="dbadge">D</div>' : ''}</div>`;

  // ---------------- state ----------------
  let net = null, netReady = null, backend = null, S = null;
  let online = new Set();
  const ui = {
    view: 'lobby', tab: 'join', code: '', name: T.store.get('chipstack:name') || '', stack: 1000, blinds: 0,
    err: '', busy: false, homeNote: '', addName: '',
    staged: [], stageKey: '', confirmFold: false, actFor: false,
    picks: [], pickKey: '', split: false, sheet: null, sheetPlayer: null, confirmRemove: false,
  };
  let lastPot = null, lastPotHand = null;

  // ---------------- boot ----------------
  function boot() {
    const hash = (location.hash || '').replace('#', '').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(hash)) ui.code = hash;
    netReady = (async () => {
      if (window.claude && typeof window.claude.use === 'function') {
        const db = await window.claude.use('db');
        if (db) {
          const [user, room] = await Promise.all([window.claude.use('user'), window.claude.use('room')]);
          return new T.ClaudeBackend(db, user, room).init();
        }
      }
      return new T.PeerBackend().init();
    })();
    netReady.then((b) => { net = b; render(); }).catch((e) => { ui.homeNote = e.message; render(); });
    render();
  }

  // ---------------- helpers ----------------
  const meId = () => (backend ? backend.me.id : null);
  const isLocal = () => !!backend && backend.kind === 'local';
  const amHost = () => !!S && (isLocal() || S.hostId === meId());
  const P = (id) => S.players.find((p) => p.id === id);
  const nameOf = (id) => (P(id) || { name: '?' }).name;
  const isMobile = () => window.innerWidth < 700;
  const potTotal = () => E.potTotal(S.hand);
  const eligibleCount = () => S.players.filter((p) => p.stack > 0 && !p.sittingOut).length;

  function actorId() {
    const h = S && S.hand;
    if (!h || !h.toAct || h.street === 'showdown') return null;
    if (isLocal()) return h.toAct;
    if (h.toAct === meId()) return h.toAct;
    if (amHost() && ui.actFor) return h.toAct;
    return null;
  }
  // whose card sits in the "me" slot: you, or on one phone whoever is acting
  function viewerId() {
    if (isLocal()) return (S.hand && S.hand.toAct) || S.buttonId || (S.players[0] && S.players[0].id);
    return actorId() || meId();
  }

  let toastTimer;
  function toast(msg, bad) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle('bad', !!bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 3600 : 2200);
  }

  async function send(action) {
    if (ui.busy) return false;
    ui.busy = true;
    try { await backend.submit(action); return true; }
    catch (e) { toast(e.message, true); return false; }
    finally { ui.busy = false; render(); }
  }

  let wakeLock = null;
  function keepAwake() {
    if (wakeLock || !navigator.wakeLock || !S) return;
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
  }
  document.addEventListener('pointerdown', keepAwake, { passive: true });
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* ignore */ } };

  // ---------------- joining / creating ----------------
  let unsub = null;
  function attach(b) {
    if (unsub) unsub();
    backend = b;
    let lastTurn = null;
    const u1 = b.onState((s) => {
      S = s;
      if (ui.view === 'auto') ui.view = s.handNo > 0 || s.hand ? 'table' : 'room';
      else if (ui.view === 'room' && s.hand) ui.view = 'table';
      const turn = s.hand && s.hand.toAct;
      if (turn && turn !== lastTurn && turn === meId() && !isLocal()) buzz([60, 40, 60]);
      lastTurn = turn;
      trackPot();
      render();
    });
    const u2 = b.onOnline ? b.onOnline((set) => { online = set; render(); }) : () => {};
    unsub = () => { u1(); u2(); };
  }
  function trackPot() {
    const h = S.hand;
    if (!h || h.street === 'showdown') { lastPot = null; return; }
    const pot = E.potTotal(h);
    if (lastPot != null && lastPotHand === h.no && pot > lastPot) popAt('potPops', '+' + money(pot - lastPot), '30%', 44);
    lastPot = pot; lastPotHand = h.no;
  }

  function fail(msg) { ui.err = msg; ui.busy = false; render(); }

  async function submitLobby(local) {
    const name = ui.name.trim();
    if (!local && ui.tab === 'join' && ui.code.length !== 4) return fail('Table codes are 4 characters.');
    if (!name) return fail('Add your name so the table knows who you are.');
    if (!local && !net) return fail(ui.homeNote || 'Still connecting. Try again in a second.');
    ui.err = ''; ui.busy = true; render();
    T.store.set('chipstack:name', name);
    try {
      if (local || ui.tab === 'create') {
        const [sb, bb] = BLIND_OPTS[ui.blinds];
        const b = local ? await new T.LocalBackend().init() : net;
        const code = await b.create({ startingStack: ui.stack, sb, bb }, name);
        if (!local) T.store.set('chipstack:last', code);
        ui.view = 'room';
        attach(b);
      } else {
        await openTable(ui.code, name);
      }
    } catch (e) { ui.view = 'lobby'; S = null; fail(e.message); return; }
    ui.busy = false; render();
  }
  async function openTable(code, name) {
    const b = net;
    await b.open(code);
    T.store.set('chipstack:last', code);
    ui.view = 'auto';
    attach(b);
    if (!b.state.players.some((p) => p.id === b.me.id)) await b.submit({ type: 'join', name });
  }
  async function rejoin(code) {
    const name = ui.name.trim();
    if (!name) return fail('Add your name so the table knows who you are.');
    if (!net) return fail('Still connecting. Try again in a second.');
    ui.err = ''; ui.busy = true; render();
    T.store.set('chipstack:name', name);
    try { await openTable(code, name); } catch (e) { ui.view = 'lobby'; S = null; return fail(e.message); }
    ui.busy = false; render();
  }
  async function continueLocal() {
    try { const b = new T.LocalBackend(); await b.open(); ui.view = 'auto'; attach(b); } catch (e) { fail(e.message); }
  }
  function leaveToLobby() {
    if (backend && backend.kind !== 'local' && backend.close) backend.close();
    if (unsub) unsub();
    unsub = null; backend = null; S = null; ui.view = 'lobby'; ui.sheet = null; ui.actFor = false; ui.staged = [];
    render();
  }

  // ---------------- rendering core ----------------
  let mounted = null;
  const cache = new Map();
  function mount(name, html) {
    if (mounted === name) return false;
    mounted = name; cache.clear();
    $app.innerHTML = html;
    return true;
  }
  function patch(id, html) {
    if (cache.get(id) === html) return;
    const el = document.getElementById(id);
    if (!el) return;
    cache.set(id, html);
    const a = document.activeElement;
    const keep = a && a.id && el.contains(a) && a.tagName === 'INPUT' ? [a.id, a.selectionStart, a.selectionEnd] : null;
    el.innerHTML = html;
    if (keep) {
      const n = document.getElementById(keep[0]);
      if (n) { n.focus(); try { n.setSelectionRange(keep[1], keep[2]); } catch (e) { /* ignore */ } }
    }
  }
  function render() {
    if (!S) renderLobbyForm();
    else if (ui.view === 'room') renderRoom();
    else renderTable();
    patch('sheet', S ? sheetHTML() : '');
  }

  // scale the 800x420 artboards to their frames
  const ro = window.ResizeObserver ? new ResizeObserver((entries) => {
    for (const en of entries) {
      const el = en.target, w = el.clientWidth, h = el.clientHeight;
      el.style.setProperty('--sc', el.classList.contains('stage') ? Math.min(w / 800, h / 420) : w / 800);
    }
  }) : null;
  function observe(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (ro) ro.observe(el);
    const w = el.clientWidth, h = el.clientHeight;
    el.style.setProperty('--sc', el.classList.contains('stage') ? Math.min(w / 800, (h || 420) / 420) : w / 800);
  }

  // ---------------- lobby ----------------
  function lobbySkeleton(panelId) {
    const pile = [
      { c: { base: '#2F5D73', stripe: '#E3E7D8' }, n: 3 },
      { c: { base: '#141a17', stripe: '#E3C35A' }, n: 6 },
      { c: { base: '#E3C35A', stripe: '#141a17' }, n: 4 },
    ].map((p) => stack3D(p.c, p.n, SIZE.lobby, { noLabel: true })).join('');
    return `<main class="lobby">
      <div class="brand">
        <h1 class="logo">CHIPWRECK</h1>
        <div class="tags"><span style="color:var(--mustard)">REAL CARDS</span><span>DIGITAL CHIPS</span></div>
      </div>
      <div class="lgrid">
        <div class="hero" id="hero" aria-hidden="true"><div class="art">
          ${dealerSVG('lobby')}${tableHTML}${handsSVG}
          <div class="abs px" style="left:150px;top:240px;width:62px;height:88px;border-radius:6px;background:#E3E7D8;box-shadow:0 6px 0 #16291f;transform:rotate(-14deg);padding:6px 7px;box-sizing:border-box;color:#B8432F;font-size:24px;line-height:.8;text-shadow:none">A<div style="font-size:20px">♥</div></div>
          <div class="abs px" style="left:196px;top:250px;width:62px;height:88px;border-radius:6px;background:#E3E7D8;box-shadow:0 6px 0 #16291f;transform:rotate(6deg);padding:6px 7px;box-sizing:border-box;color:#141a17;font-size:24px;line-height:.8;text-shadow:none">A<div style="font-size:20px">♠</div></div>
          <div class="abs" style="left:300px;top:200px;width:200px;height:110px;display:flex;align-items:flex-end;justify-content:center;gap:6px">${pile}</div>
          ${riffleHTML(560, 250)}
        </div></div>
        <section class="panel lpanel" id="${panelId}"></section>
      </div>
    </main>`;
  }

  function renderLobbyForm() {
    if (mount('lobby', lobbySkeleton('lpanel'))) observe('hero');
    const ready = ui.name.trim() && (ui.tab === 'create' || ui.code.length === 4);
    const last = T.store.get('chipstack:last');
    const hosted = net && net.hostedCodes ? net.hostedCodes() : [];
    const hasLocal = !!T.store.get('chipstack:local');
    const seg = (on, label, a, v) => `<button class="abtn ${on ? 'mustard' : 'pine'}" data-a="${a}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
    const extras = [];
    if (last && last !== ui.code) extras.push(`<button class="textlink" data-a="rejoin" data-code="${esc(last)}">Rejoin ${esc(last)}</button>`);
    hosted.filter((c) => c !== last).slice(0, 2).forEach((c) => extras.push(`<button class="textlink" data-a="rejoin" data-code="${esc(c)}">Resume hosting ${esc(c)}</button>`));
    extras.push('<button class="textlink" data-a="local">One phone for everyone</button>');
    if (hasLocal) extras.push('<button class="textlink" data-a="local-continue">Continue one-phone table</button>');
    patch('lpanel', `
      <div class="tabs" role="tablist">
        <button class="abtn ${ui.tab === 'join' ? 'blue' : 'off'}" data-a="tab" data-v="join" role="tab" aria-selected="${ui.tab === 'join'}">JOIN</button>
        <button class="abtn ${ui.tab === 'create' ? 'brick' : 'off'}" data-a="tab" data-v="create" role="tab" aria-selected="${ui.tab === 'create'}">CREATE</button>
      </div>
      ${ui.tab === 'join' ? `
      <label class="flabel"><span class="lbl">Table code</span>
        <input id="in-code" class="field codein" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="4F2K" value="${esc(ui.code)}"></label>` : `
      <div class="flabel"><span class="lbl">Starting stack</span><div class="seg">${STACK_OPTS.map((v) => seg(ui.stack === v, money(v), 'stack', v)).join('')}</div></div>
      <div class="flabel"><span class="lbl">Blinds</span><div class="seg">${BLIND_OPTS.map((b, i) => seg(ui.blinds === i, `$${b[0]}/$${b[1]}`, 'blinds', i)).join('')}</div></div>`}
      <label class="flabel"><span class="lbl">Your name</span>
        <input id="in-name" class="field" maxlength="18" autocomplete="nickname" placeholder="What the table calls you" value="${esc(ui.name)}"></label>
      <button id="b-submit" class="abtn submit ${ready ? 'mustard' : 'dead'}" data-a="submit" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'ONE SEC…' : ui.tab === 'join' ? 'JOIN TABLE' : 'CREATE TABLE'}</button>
      ${ui.err ? `<div class="errpill" role="alert">${esc(ui.err)}</div>` : ''}
      ${!net ? `<p class="note">${esc(ui.homeNote || 'Connecting…')}</p>` : ''}
      <div class="extras">${extras.join('')}</div>`);
  }
  function refreshSubmit() {
    const b = document.getElementById('b-submit');
    if (!b) return;
    const ready = ui.name.trim() && (ui.tab === 'create' || ui.code.length === 4);
    b.classList.toggle('mustard', !!ready); b.classList.toggle('dead', !ready);
    const err = document.querySelector('#lpanel .errpill');
    if (err && ui.err === '') err.remove();
  }

  // ---------------- waiting room ----------------
  function renderRoom() {
    if (mount('room', lobbySkeleton('rpanel'))) observe('hero');
    const host = amHost(), local = isLocal();
    const me = meId();
    const n = S.players.length;
    const canStart = eligibleCount() >= 2;
    const label = local ? 'ONE PHONE TABLE' : host ? 'SHARE THIS CODE' : 'YOU’RE IN';
    const hint = local ? 'Add everyone in seat order, going clockwise.' : host ? (n < 2 ? 'Read the code out. Players join from their phones.' : 'Everyone in? Start when the cards are shuffled.') : 'Waiting for the host to deal.';
    const rows = S.players.map((p, i) => {
      const isH = !local && p.id === S.hostId;
      const away = !local && online.size && !online.has(p.id);
      const tag = isH ? 'HOST' : local ? 'SEAT ' + (i + 1) : away ? 'AWAY' : 'READY';
      const tagStyle = isH ? 'background:var(--mustard);color:var(--ink)' : away ? 'background:var(--pine);color:var(--steel)' : 'background:var(--felt);color:var(--linen)';
      return `<div class="rp">${avatarHTML(ROOM_COLORS[i % ROOM_COLORS.length])}<div class="nm">${esc(p.name)}${p.id === me && !local ? ' (you)' : ''}</div><div class="tag" style="${tagStyle}">${tag}</div></div>`;
    }).join('');
    patch('rpanel', `
      <div class="roomhead"><div class="lbl">${label}</div><button class="textlink" data-a="leave">Leave</button></div>
      ${local ? '' : `<div class="tiles" aria-label="Table code ${esc(S.code)}">${S.code.split('').map((c) => `<div>${esc(c)}</div>`).join('')}</div>`}
      <div class="stats">
        <div class="stat blue"><b>STACK</b><span>${money(S.settings.startingStack)}</span></div>
        <div class="stat brick"><b>BLINDS</b><span>$${S.settings.sb}/$${S.settings.bb}</span></div>
        <div class="stat pine"><b>SEATED</b><span>${n}/10</span></div>
      </div>
      <div class="rplayers">${rows}</div>
      ${local ? `<div class="addrow"><input id="in-add" class="field" maxlength="18" placeholder="Add a player" value="${esc(ui.addName)}"><button class="abtn pine" data-a="add-player">ADD</button></div>` : ''}
      <p class="note">${hint}</p>
      ${host ? `<button id="b-start" class="abtn submit ${canStart ? 'mustard' : 'dead'}" data-a="deal" ${canStart && !ui.busy ? '' : 'disabled'}>START GAME</button>`
        : `<button id="b-seat" class="abtn submit mustard" data-a="seat">TAKE YOUR SEAT</button>`}
      ${!local && net && net.kind === 'peer' ? '<div class="extras"><button class="textlink" data-a="copy-link">Copy invite link</button></div>' : ''}`);
  }

  // ---------------- table ----------------
  const tableSkeleton = () => `<main class="tbl" id="tbl">
      <header class="thead">
        <button class="brandbtn" data-a="menu" aria-label="Table menu"><span class="mini-chip"><i></i></span><span class="px" style="font-size:20px;letter-spacing:.01em">CHIPWRECK</span></button>
        <div class="hpills"><div id="hHand"></div><div id="hBlinds"></div><button data-a="menu">MENU</button></div>
      </header>
      <section class="tpot" aria-label="Pot">
        <div class="stage" id="stage">
          <div class="pops" id="potPops"></div>
          <div class="art" aria-hidden="true">
            ${dealerSVG('table')}${tableHTML}
            <div class="abs" style="left:122px;top:282px;width:58px;height:58px;border-radius:50%;background:#E3E7D8;box-shadow:0 6px 0 #16291f;display:flex;align-items:center;justify-content:center">
              <div class="px" style="width:42px;height:42px;border-radius:50%;border:2px solid #141a17;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:20px;color:#141a17">D</div></div>
            <div class="abs" style="left:612px;top:262px;width:54px;height:76px;border-radius:5px;background:#B8432F;border:4px solid #E3E7D8;box-sizing:border-box;transform:rotate(14deg)"></div>
            <div class="abs" style="left:604px;top:258px;width:54px;height:76px;border-radius:5px;background:#B8432F;border:4px solid #E3E7D8;box-sizing:border-box;box-shadow:0 6px 0 #16291f;transform:rotate(4deg)"></div>
            ${handsSVG}${riffleHTML(560, 322)}
            <div class="potpile" id="potPile"></div>
            <div class="potlabel" id="potLabel"></div>
          </div>
          <div class="spill turn" id="turnPill" aria-live="polite"></div>
          <div class="spill street" id="streetPill"></div>
          <div class="slast" id="lastLine" aria-live="polite"></div>
        </div>
      </section>
      <section class="tplayers" aria-label="Players">
        <div class="phead"><div class="sec">PLAYERS</div><small id="pcount"></small></div>
        <div class="seats" id="seats"></div>
      </section>
      <section class="tchips" aria-label="Your chips">
        <div class="cardhead"><div class="sec">CHIPS</div><div id="avail" style="font-size:15px;font-weight:900" class="num"></div></div>
        <div class="tray" id="tray"></div>
      </section>
      <section class="tstack" aria-label="Your play">
        <div class="cardhead"><div class="sec">YOUR PLAY</div><button class="textlink" data-a="clear">Clear</button></div>
        <div class="zone" id="zone"><div class="pops" id="zonePops"></div><div id="zoneInner"></div></div>
      </section>
      <section class="tme" id="me"></section>
      <section class="tactions" id="actions"></section>
    </main>
    <div id="overlay"></div>`;

  function renderTable() {
    if (mount('table', tableSkeleton())) observe('stage');
    const h = S.hand;
    const actor = actorId();
    const viewer = viewerId();
    const vp = P(viewer);
    const myTurn = !!actor;
    document.getElementById('tbl').classList.toggle('wait', !myTurn);

    // draft resets when the turn, street or bet changes
    const key = actor ? `${h.no}|${h.street}|${actor}|${h.currentBet}` : '';
    if (key !== ui.stageKey) { ui.staged = []; ui.confirmFold = false; ui.stageKey = key; }
    const staged = ui.staged.reduce((a, b) => a + b, 0);

    patch('hHand', `HAND ${h ? h.no : Math.max(1, S.handNo + (S.lastResult ? 0 : 1))}`);
    patch('hBlinds', `$${S.settings.sb} / $${S.settings.bb}`);

    // stage
    const pot = potTotal();
    const groups = {}; greedy(pot).forEach((v) => { groups[v] = (groups[v] || 0) + 1; });
    patch('potPile', CHIPS.filter((c) => groups[c.v]).reverse().map((c) => stack3D(c, Math.min(groups[c.v], 7), SIZE.pot)).join(''));
    patch('potLabel', `<b>POT</b><span class="px num">${money(pot)}</span>`);
    let turnText, turnBg = 'var(--pine)', turnInk = 'var(--linen)';
    if (h && h.street === 'showdown') turnText = 'SHOWDOWN';
    else if (h && h.toAct) {
      if (isLocal() || h.toAct === meId()) { turnText = isLocal() ? `${UP(nameOf(h.toAct))}’S TURN` : 'YOUR TURN'; turnBg = 'var(--mustard)'; turnInk = 'var(--ink)'; }
      else turnText = `${UP(nameOf(h.toAct))}’S TURN`;
    } else turnText = S.lastResult ? 'HAND OVER' : 'WAITING TO DEAL';
    patch('turnPill', `<span style="display:contents">${esc(turnText)}</span>`);
    const tp = document.getElementById('turnPill'); tp.style.background = turnBg; tp.style.color = turnInk;
    patch('streetPill', h ? STREET[h.street] : 'BETWEEN HANDS');
    patch('lastLine', esc(lastLine()));

    // players
    const others = S.players.filter((p) => p.id !== viewer);
    const live = h ? h.seats.filter((id) => !h.folded[id]).length : eligibleCount();
    patch('pcount', h ? `${live} IN HAND` : `${S.players.length} SEATED`);
    patch('seats', others.length ? others.map((p) => seatHTML(p)).join('') : `<div class="empty-seats">${isLocal() ? 'Add players from the table menu.' : `Nobody else yet. Share code ${esc(S.code)}.`}</div>`);

    // tray
    const stack = vp ? vp.stack : 0;
    const avail = stack - staged;
    patch('avail', money(avail));
    patch('tray', CHIPS.map((c) => {
      const ok = myTurn && c.v <= avail;
      return `<div class="tchip ${ok ? '' : 'no'}" data-chip="${c.v}" role="button" tabindex="${myTurn ? 0 : -1}" aria-label="Add ${c.label}" aria-disabled="${!ok}"><div>${stack3D(c, 3, SIZE.tray, { shadowH: 76, labelFn: (x) => `<span style="font-size:${x.v === 100 ? 17 : 20}px">${x.label}</span>` })}</div></div>`;
    }).join(''));

    // zone
    const maxV = isMobile() ? 8 : 5;
    const shown = ui.staged.slice(-maxV), n = shown.length, offset = ui.staged.length - n;
    const stackH = n ? 68 + 20 * n : 0;
    let zone = '';
    if (!n) zone = `<div class="zhint">${myTurn ? 'DRAG OR TAP CHIPS TO STACK YOUR PLAY' : 'WAIT FOR YOUR TURN'}</div>`;
    else {
      zone = `<div class="ztotal px num">${money(staged)}</div><div class="zstack" style="height:${stackH}px">
        <div class="ch-shadow" style="left:20px;top:20px;width:170px;height:${stackH}px;border-radius:85px / 34px"></div>
        ${shown.map((v, i) => `<div class="zchip" data-zchip="${offset + i}" style="top:${(n - 1 - i) * 20}px" aria-label="Remove ${byV(v).label}">${chipHTML(byV(v), SIZE.zone, 0, i === n - 1 ? byV(v).label : '')}</div>`).join('')}
      </div>`;
    }
    patch('zoneInner', zone);

    patch('me', meHTML(viewer, myTurn));
    const wonMe = !h && S.lastResult && S.lastResult.wins.some((w) => w.id === viewer);
    document.getElementById('me').classList.toggle('hot', myTurn || !!wonMe);
    patch('actions', actionsHTML(actor, viewer, staged));
    patch('overlay', overlayHTML());
  }

  function lastLine() {
    const h = S.hand;
    if (h && h.street === 'showdown' && h.runout) return 'All in. Deal out the rest of the board, then show hands.';
    const l = S.log[S.log.length - 1] || '';
    return l.replace(/\.$/, '');
  }

  function statusOf(p) {
    const h = S.hand;
    const won = !h && S.lastResult && S.lastResult.wins.some((w) => w.id === p.id);
    const inHand = h && h.seats.includes(p.id);
    if (won) return 'Won the pot';
    if (!inHand) return p.sittingOut ? 'Sitting out' : p.stack === 0 ? 'Busted' : h ? 'Next hand' : 'Ready';
    if (h.folded[p.id]) return 'Folded';
    if (h.allIn[p.id]) return 'All in';
    if (h.toAct === p.id) return 'Thinking…';
    return (h.last && h.last[p.id]) || 'Waiting';
  }

  function seatHTML(p) {
    const h = S.hand;
    const idx = S.players.indexOf(p);
    const inHand = h && h.seats.includes(p.id);
    const acting = h && h.toAct === p.id && h.street !== 'showdown';
    const won = !h && S.lastResult && S.lastResult.wins.some((w) => w.id === p.id);
    const dim = (inHand && h.folded[p.id]) || (!inHand && (p.sittingOut || p.stack === 0));
    const isDealer = (h ? h.buttonId : S.buttonId) === p.id;
    const bet = inHand ? (h.bets[p.id] || 0) : 0;
    let st = statusOf(p);
    if (!isLocal() && online.size && !online.has(p.id) && !acting) st += ' · away';
    return `<button class="seat ${acting || won ? 'hot' : ''} ${dim ? 'dim' : ''}" data-a="player" data-id="${esc(p.id)}">
      ${avatarHTML(AVATAR[idx % AVATAR.length], isDealer)}
      <div class="who"><div class="nm">${esc(p.name)}</div><div class="st">${esc(st)}</div></div>
      <div class="money"><div class="bet px num">${money(bet)}</div><div class="of num">of ${money(p.stack)}</div></div>
    </button>`;
  }

  function meHTML(viewer, myTurn) {
    const p = P(viewer);
    if (!p) {
      return `<div class="merow">${avatarHTML('var(--ink)', false, 'var(--mustard)')}<div><div class="px mename">YOU</div><div class="mesub">Not seated at this table</div></div></div>
        <button class="abtn ink sm" style="height:52px;font-size:20px;--drop:0px;box-shadow:none" data-a="sit-back">JOIN THIS TABLE</button>`;
    }
    const h = S.hand;
    const isMe = !isLocal() && viewer === meId();
    const won = !h && S.lastResult && S.lastResult.wins.some((w) => w.id === p.id);
    const inRound = h && h.seats.includes(p.id) ? (h.bets[p.id] || 0) : 0;
    const status = myTurn ? (isMe ? 'Your turn' : isLocal() ? 'Your turn. Pass the phone after.' : `Acting for ${p.name}`) : statusOf(p);
    const isDealer = (h ? h.buttonId : S.buttonId) === p.id;
    let extra = '';
    if (!isLocal() && amHost() && h && h.toAct && h.toAct !== meId() && h.street !== 'showdown') {
      extra = ui.actFor ? '<button class="melink" data-a="stop-act">Stop acting for them</button>'
        : `<button class="melink" data-a="act-for">Act for ${esc(nameOf(h.toAct))} (phone died?)</button>`;
    }
    return `<div class="merow">${avatarHTML('var(--ink)', isDealer, 'var(--mustard)')}
        <div style="display:flex;flex-direction:column;gap:3px;min-width:0"><div class="px mename">${isMe ? 'YOU' : esc(UP(p.name))}</div><div class="mesub">${esc(status)}</div></div></div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="font-size:11px;font-weight:900;letter-spacing:.14em;color:var(--pine)">STACK</div>
        <div class="px mestack num">${money(p.stack - (myTurn ? ui.staged.reduce((a, b) => a + b, 0) : 0))}</div>
        <div class="mesub num">${money(inRound)} in this round</div>
        ${extra}
      </div>`;
  }

  function playState(actor, staged) {
    const h = S.hand;
    const L = actor ? E.legal(S, actor) : null;
    if (!L || staged <= 0) return { label: 'PLAY', ok: false };
    const p = P(actor);
    const to = L.mine + staged;
    const allIn = staged === p.stack;
    if (allIn) return { label: `PLAY ${money(staged)}`, ok: true, action: to > h.currentBet ? { type: 'raise', to } : { type: 'call' } };
    if (to === h.currentBet && L.toCall > 0) return { label: `CALL ${money(staged)}`, ok: true, action: { type: 'call' } };
    if (to > h.currentBet && to >= L.minTo) return { label: `PLAY ${money(staged)}`, ok: true, action: { type: 'raise', to } };
    if (to < h.currentBet) return { label: `ADD ${money(h.currentBet - to)}`, ok: false, fill: h.currentBet };
    return { label: `ADD ${money(L.minTo - to)}`, ok: false, fill: L.minTo };
  }

  function actionsHTML(actor, viewer, staged) {
    const h = S.hand;
    const vp = P(viewer);
    const mine = h && vp ? (h.bets[viewer] || 0) : 0;
    const toCall = h && vp ? Math.max(0, Math.min(h.currentBet - mine, vp.stack)) : 0;
    const cc = toCall > 0 ? (vp && toCall >= vp.stack ? `ALL IN ${money(toCall)}` : `CALL ${money(toCall)}`) : 'CHECK';
    const ps = playState(actor, staged);
    const dis = !actor || ui.busy ? 'disabled' : '';
    return `<button class="abtn linen fold ${ui.confirmFold ? 'sure' : ''}" id="b-fold" data-a="fold" ${dis}>${ui.confirmFold ? 'REALLY FOLD?' : 'FOLD'}</button>
      <button class="abtn linen" id="b-call" data-a="checkcall" ${dis}>${cc}</button>
      <button class="abtn linen" id="b-allin" data-a="allin" ${dis}>ALL IN</button>
      <button class="abtn play ${ps.ok ? 'ok' : 'no'}" id="b-play" data-a="play" ${dis}>${ps.label}</button>`;
  }

  // ---------------- end-of-hand modal ----------------
  function overlayHTML() {
    const h = S.hand;
    if (h && h.street === 'showdown') return showdownHTML();
    if (h) return '';
    const res = S.lastResult;
    const canDeal = eligibleCount() >= 2;
    const me = isLocal() ? null : P(meId());
    let kicker, title, amount = null, sub = '';
    if (res && res.wins.length) {
      kicker = `HAND ${res.handNo}`;
      amount = res.wins.reduce((t, w) => t + w.amount, 0);
      if (res.wins.length === 1) title = !isLocal() && res.wins[0].id === meId() ? 'YOU TAKE IT' : `${UP(nameOf(res.wins[0].id))} TAKES IT`;
      else { title = 'SPLIT POT'; sub = res.wins.map((w) => `${nameOf(w.id)} ${money(w.amount)}`).join(' · '); }
    } else if (res) { kicker = `HAND ${res.handNo}`; title = 'HAND OVER'; sub = 'Uncalled chips went back.'; }
    else { kicker = isLocal() ? 'ONE PHONE TABLE' : `TABLE ${S.code}`; title = 'READY TO DEAL'; sub = 'Seat order should match where people sit, clockwise. Change it from the table menu.'; }
    const btns = [];
    btns.push(`<button class="abtn ink mgo" id="b-deal" data-a="deal" ${canDeal && !ui.busy ? '' : 'disabled'}>${canDeal ? (res ? 'DEAL NEXT HAND →' : 'DEAL HAND 1 →') : 'NEED 2 PLAYERS WITH CHIPS'}</button>`);
    if (me && me.stack === 0) btns.push(`<button class="abtn pine mgo" data-a="rebuy-me">REBUY ${money(S.settings.startingStack)}</button>`);
    if (!me && !isLocal()) btns.push('<button class="abtn pine mgo" data-a="sit-back">JOIN THIS TABLE</button>');
    const nextBtn = canDeal ? `<p class="msub">${esc(nameOf(S.buttonId))} has the button. Blinds go in automatically.</p>` : '';
    return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><div class="mcard">
      <div class="mkick">${esc(kicker)}</div>
      <div class="px mtitle" id="m-title">${esc(title)}</div>
      ${amount != null ? `<div class="px mamt num">${money(amount)}</div>` : ''}
      ${sub ? `<p class="msub">${esc(sub)}</p>` : ''}
      ${btns.join('')}
      ${nextBtn}
      <div class="mlinks"><button class="melink" data-a="menu">Table menu</button>${isLocal() ? '<button class="melink" data-a="add-sheet">Add player</button>' : ''}</div>
    </div></div>`;
  }

  function showdownHTML() {
    const h = S.hand;
    const pots = h.pots || [];
    if (ui.pickKey !== String(h.no)) { ui.pickKey = String(h.no); ui.picks = pots.map(() => []); ui.split = false; }
    const total = pots.reduce((t, p) => t + p.amount, 0);
    const multi = pots.length > 1 || ui.split;
    let body;
    if (!multi) {
      body = `<div class="mpick">${pots[0].eligible.map((id) => `<button class="abtn ink" data-a="win1" data-id="${esc(id)}">${esc(!isLocal() && id === meId() ? 'ME' : UP(nameOf(id)))}</button>`).join('')}</div>
        <div class="mlinks"><button class="melink" data-a="split">Split the pot</button></div>`;
    } else {
      const ready = ui.picks.length === pots.length && ui.picks.every((w) => w.length);
      body = pots.map((pot, i) => `<div class="mpot"><div class="lbl"><span>${pots.length > 1 ? (i === 0 ? 'MAIN POT' : 'SIDE POT ' + i) : 'TAP EVERY WINNER'}</span><span class="num">${money(pot.amount)}</span></div>
          <div class="mpick">${pot.eligible.map((id) => `<button class="abtn ink ${ui.picks[i] && ui.picks[i].includes(id) ? 'on' : ''}" data-a="pick" data-pot="${i}" data-id="${esc(id)}" aria-pressed="${!!(ui.picks[i] && ui.picks[i].includes(id))}">${esc(UP(nameOf(id)))}</button>`).join('')}</div></div>`).join('') +
        `${pots.length > 1 ? '<p class="msub">Someone went all in for less, so there are side pots. Only players who matched the bet can win each one. Tap two names to split.</p>' : ''}
        <button class="abtn ink mgo" id="b-award" data-a="award" ${ready && !ui.busy ? '' : 'disabled'}>PAY ${ui.picks.some((w) => w.length > 1) || pots.length > 1 ? 'THE WINNERS' : 'THE WINNER'}</button>
        ${pots.length === 1 ? '<div class="mlinks"><button class="melink" data-a="split">One winner</button></div>' : ''}`;
    }
    return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><div class="mcard">
      <div class="mkick">SHOWDOWN</div>
      <div class="px mtitle" id="m-title">WHO TOOK IT?</div>
      <div class="px mamt num">${money(total)}</div>
      ${h.runout ? '<p class="msub">Deal out the rest of the board first, then show hands.</p>' : ''}
      ${body}
      <div class="mlinks"><button class="melink" data-a="menu">Table menu</button></div>
    </div></div>`;
  }

  // ---------------- sheets ----------------
  function sheetHTML() {
    if (!ui.sheet) return '';
    let inner = '';
    if (ui.sheet === 'menu') inner = menuHTML();
    else if (ui.sheet === 'player') inner = playerSheetHTML();
    else if (ui.sheet === 'add') inner = `<h3>ADD PLAYER</h3><input id="in-add2" class="field" maxlength="18" placeholder="Name" value=""><button class="abtn mustard sm" data-a="add-player2">ADD WITH ${money(S.settings.startingStack)}</button>`;
    return `<div class="sheetwrap" data-a="close-sheet-bg"><div class="panel sheet" role="dialog" aria-modal="true">${inner}<button class="abtn off sm" data-a="close-sheet">CLOSE</button></div></div>`;
  }

  function menuHTML() {
    const host = amHost();
    const rows = S.players.map((p) => {
      const live = S.hand && S.hand.seats.includes(p.id) ? (S.hand.committed[p.id] || 0) : 0;
      const net_ = p.stack + live - p.buyIns * S.settings.startingStack;
      return `<tr data-a="player" data-id="${esc(p.id)}"><td>${esc(p.name)}</td><td>${p.buyIns}×</td><td>${money(p.stack)}</td><td class="${net_ > 0 ? 'pos' : net_ < 0 ? 'neg' : ''}">${net_ > 0 ? '+' : ''}${money(net_).replace('$-', '-$')}</td></tr>`;
    }).join('');
    const peer = backend.kind === 'peer';
    return `<h3>${isLocal() ? 'ONE PHONE TABLE' : 'TABLE ' + esc(S.code)}</h3>
      ${!isLocal() ? `<p class="note">Friends join with code <b style="color:var(--mustard)">${esc(S.code)}</b>.${peer ? ' Keep the host’s phone awake with ChipWreck open.' : ''}</p>
        <div class="sgrid"><button class="abtn pine" data-a="copy-code">COPY CODE</button>${peer ? '<button class="abtn pine" data-a="copy-link">COPY LINK</button>' : ''}</div>` : ''}
      <h4 class="lbl">Players · tap to manage</h4>
      <div style="overflow-x:auto"><table class="ledger"><thead><tr><th>PLAYER</th><th>BUY-INS</th><th>STACK</th><th>NET</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${isLocal() && !S.hand ? '<button class="abtn pine sm" data-a="add-sheet">ADD PLAYER</button>' : ''}
      ${host ? `<h4 class="lbl">Blinds and buy-in</h4>
        <div class="three">
          <input id="in-s-stack" class="field" inputmode="numeric" aria-label="Buy-in" value="${S.settings.startingStack}">
          <input id="in-s-sb" class="field" inputmode="numeric" aria-label="Small blind" value="${S.settings.sb}">
          <input id="in-s-bb" class="field" inputmode="numeric" aria-label="Big blind" value="${S.settings.bb}">
        </div>
        <div class="sgrid"><button class="abtn pine" data-a="save-settings" ${S.hand ? 'disabled' : ''}>${S.hand ? 'AFTER THIS HAND' : 'SAVE'}</button>
        <button class="abtn pine" data-a="undo" ${S.history && S.history.length ? '' : 'disabled'}>UNDO LAST</button></div>` : ''}
      <h4 class="lbl">What happened</h4>
      <div class="logbox">${S.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') || '<div>Nothing yet.</div>'}</div>
      <button class="abtn brick sm" data-a="leave">${isLocal() ? 'BACK TO START (SAVED)' : 'LEAVE TABLE'}</button>`;
  }

  function playerSheetHTML() {
    const p = P(ui.sheetPlayer);
    if (!p) return '<h3>PLAYER LEFT</h3>';
    const self = p.id === meId() || isLocal();
    const host = amHost();
    const inHand = S.hand && S.hand.seats.includes(p.id);
    const between = !S.hand;
    const b = [];
    if (between) {
      b.push('<button class="abtn pine" data-a="pa" data-k="up">MOVE UP</button>');
      b.push('<button class="abtn pine" data-a="pa" data-k="down">MOVE DOWN</button>');
      if (S.buttonId !== p.id) b.push('<button class="abtn pine" data-a="pa" data-k="button">GIVE BUTTON</button>');
    }
    if (self || host) b.push(`<button class="abtn pine" data-a="pa" data-k="sit">${p.sittingOut ? 'BACK IN' : 'SIT OUT'}</button>`);
    if ((self || host) && !inHand) b.push(`<button class="abtn pine" data-a="pa" data-k="rebuy">REBUY</button>`);
    return `<h3>${esc(UP(p.name))}</h3><p class="note">Stack ${money(p.stack)} · ${p.buyIns} buy-in${p.buyIns > 1 ? 's' : ''}</p>
      ${b.length ? `<div class="sgrid">${b.join('')}</div>` : '<p class="note">Seat changes open up between hands.</p>'}
      ${host && between ? `<label class="flabel"><span class="lbl">Fix their stack</span><div class="addrow"><input id="in-adj" class="field" inputmode="numeric" value="${p.stack}"><button class="abtn pine" data-a="pa" data-k="adjust">SAVE</button></div></label>` : ''}
      ${(self || host) && !inHand ? `<button class="abtn ${ui.confirmRemove ? 'brick' : 'off'} sm" data-a="pa" data-k="remove">${ui.confirmRemove ? 'TAP AGAIN TO REMOVE' : 'REMOVE FROM TABLE'}</button>` : ''}`;
  }

  // ---------------- pops ----------------
  function popAt(layerId, text, top, size) {
    const layer = document.getElementById(layerId);
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'pop';
    el.style.top = top; el.style.fontSize = size + 'px';
    el.textContent = text;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  // ---------------- chips: tap, drag in, drag out ----------------
  function addChip(v) {
    const actor = actorId();
    if (!actor) return;
    const p = P(actor);
    const sum = ui.staged.reduce((a, b) => a + b, 0);
    if (sum + v > p.stack) return;
    ui.staged.push(v);
    buzz(8);
    render();
    popAt('zonePops', '+$' + v, '40%', 40);
  }
  function startDrag(e, v, source, idx) {
    if (!actorId()) return;
    if (source === 'tray') { const p = P(actorId()); if (v > p.stack - ui.staged.reduce((a, b) => a + b, 0)) return; }
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const c = byV(v);
    let ghost = null;
    const zoneEl = document.getElementById('zone');
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
        ghost = document.createElement('div');
        ghost.className = 'ghost';
        ghost.style.background = `repeating-conic-gradient(${c.base} 0deg 20deg, ${c.stripe} 20deg 30deg)`;
        ghost.innerHTML = `<i style="background:${c.base};border:2px solid ${c.stripe};color:${c.stripe}">${c.label}</i>`;
        document.body.appendChild(ghost);
        if (zoneEl) zoneEl.classList.add('drag');
      }
      if (ghost) { ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const moved = !!ghost;
      if (ghost) ghost.remove();
      if (zoneEl) zoneEl.classList.remove('drag');
      if (ev.type === 'pointercancel') return;
      const r = zoneEl && zoneEl.getBoundingClientRect();
      const inZone = r && ev.clientY >= r.top - 60 && ev.clientY <= r.bottom + 20 && ev.clientX >= r.left - 30 && ev.clientX <= r.right + 30;
      if (source === 'tray') { if (!moved || inZone) addChip(v); }
      else if (!moved || !inZone) { ui.staged.splice(idx, 1); render(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---------------- events ----------------
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-chip]');
    if (t && $app.contains(t)) return startDrag(e, +t.dataset.chip, 'tray');
    const z = e.target.closest('[data-zchip]');
    if (z && $app.contains(z)) return startDrag(e, ui.staged[+z.dataset.zchip], 'zone', +z.dataset.zchip);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target.closest && e.target.closest('[data-chip]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); addChip(+t.dataset.chip); return; }
    if (e.key === 'Enter' && e.target.id === 'in-code') submitLobby(false);
    if (e.key === 'Enter' && e.target.id === 'in-name' && !S) submitLobby(false);
    if (e.key === 'Enter' && e.target.id === 'in-add') addLocalPlayer('in-add');
    if (e.key === 'Enter' && e.target.id === 'in-add2') addLocalPlayer('in-add2');
    if (e.key === 'Escape' && ui.sheet) { ui.sheet = null; render(); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'in-code') {
      const v = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (t.value !== v) t.value = v;
      ui.code = v; ui.err = ''; cache.delete('lpanel'); refreshSubmit();
    } else if (t.id === 'in-name') {
      ui.name = t.value.slice(0, 18); ui.err = ''; cache.delete('lpanel'); refreshSubmit();
    } else if (t.id === 'in-add') { ui.addName = t.value; cache.delete('rpanel'); }
  });

  async function addLocalPlayer(inputId) {
    const el = document.getElementById(inputId);
    const n = ((el && el.value) || '').trim();
    if (!n) return toast('Type a name first', true);
    const ok = await send({ type: 'join', by: 'l' + T.rid(), name: n });
    if (ok) { ui.addName = ''; cache.delete('rpanel'); if (inputId === 'in-add2') ui.sheet = null; render(); const i = document.getElementById(inputId); if (i) { i.value = ''; i.focus(); } }
  }

  function copy(text, label) {
    const done = () => toast('Copied ' + (label || text));
    try { navigator.clipboard.writeText(text).then(done, () => toast(label ? text : 'Code: ' + text)); }
    catch (e) { toast('Code: ' + text); }
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    const a = el.dataset.a;
    if (a === 'close-sheet-bg') { if (e.target === el) { ui.sheet = null; render(); } return; }
    if (el.disabled) return;
    const h = S && S.hand;
    const actor = S && actorId();
    switch (a) {
      // lobby
      case 'tab': ui.tab = el.dataset.v; ui.err = ''; render(); break;
      case 'stack': ui.stack = +el.dataset.v; render(); break;
      case 'blinds': ui.blinds = +el.dataset.v; render(); break;
      case 'submit': submitLobby(false); break;
      case 'local': submitLobby(true); break;
      case 'local-continue': continueLocal(); break;
      case 'rejoin': rejoin(el.dataset.code); break;
      // room
      case 'seat': ui.view = 'table'; render(); break;
      case 'add-player': addLocalPlayer('in-add'); break;
      case 'add-player2': addLocalPlayer('in-add2'); break;
      case 'add-sheet': ui.sheet = 'add'; render(); setTimeout(() => { const i = document.getElementById('in-add2'); if (i) i.focus(); }, 30); break;
      case 'leave': leaveToLobby(); break;
      case 'deal': ui.view = 'table'; send({ type: 'deal' }); break;
      // table
      case 'menu': ui.sheet = 'menu'; render(); break;
      case 'close-sheet': ui.sheet = null; render(); break;
      case 'player': ui.sheet = 'player'; ui.sheetPlayer = el.dataset.id; ui.confirmRemove = false; render(); break;
      case 'act-for': ui.actFor = true; render(); break;
      case 'stop-act': ui.actFor = false; render(); break;
      case 'clear': if (actor) { ui.staged = []; render(); } break;
      case 'fold': {
        if (!actor) break;
        const L = E.legal(S, actor);
        if (L.canCheck && !ui.confirmFold) { ui.confirmFold = true; render(); break; }
        ui.confirmFold = false;
        send({ type: 'fold', player: actor });
        break;
      }
      case 'checkcall': if (actor) { const L = E.legal(S, actor); send({ type: L.canCheck ? 'check' : 'call', player: actor }); } break;
      case 'allin': if (actor) { const L = E.legal(S, actor); send(L.maxTo > h.currentBet ? { type: 'raise', to: L.maxTo, player: actor } : { type: 'call', player: actor }); } break;
      case 'play': {
        if (!actor) break;
        const ps = playState(actor, ui.staged.reduce((x, y) => x + y, 0));
        if (ps.ok) send({ ...ps.action, player: actor });
        else if (ps.fill) {
          const L = E.legal(S, actor);
          const target = Math.min(L.maxTo, ps.fill);
          ui.staged = greedy(target - L.mine);
          const rest = target - L.mine - ui.staged.reduce((x, y) => x + y, 0);
          if (rest > 0) toast(`Use CALL or ALL IN for the last ${money(rest)}`);
          render();
        }
        break;
      }
      case 'win1': send({ type: 'award', winners: [[el.dataset.id]] }); break;
      case 'split': ui.split = !ui.split; ui.picks = (h.pots || []).map(() => []); render(); break;
      case 'pick': {
        const i = +el.dataset.pot, id = el.dataset.id;
        const w = ui.picks[i] || [];
        ui.picks[i] = w.includes(id) ? w.filter((x) => x !== id) : w.concat(id);
        render();
        break;
      }
      case 'award': send({ type: 'award', winners: ui.picks }); break;
      case 'rebuy-me': send({ type: 'rebuy' }); break;
      case 'sit-back': send({ type: 'join', name: ui.name || T.store.get('chipstack:name') || 'Player' }); break;
      case 'copy-code': copy(S.code); break;
      case 'copy-link': copy(location.origin + location.pathname + '#' + S.code, 'invite link'); break;
      case 'undo': send({ type: 'undo' }); break;
      case 'save-settings': {
        const v = (id) => document.getElementById(id).value;
        send({ type: 'settings', startingStack: v('in-s-stack'), sb: v('in-s-sb'), bb: v('in-s-bb') }).then((ok) => ok && toast('Blinds saved'));
        break;
      }
      case 'pa': playerAction(el.dataset.k); break;
      default: break;
    }
  });

  function playerAction(kind) {
    const id = ui.sheetPlayer;
    const p = P(id);
    if (!p) return;
    if (kind === 'remove') {
      if (!ui.confirmRemove) { ui.confirmRemove = true; render(); return; }
      ui.confirmRemove = false; ui.sheet = null;
      send({ type: 'leave', player: id }).then((ok) => { if (ok && id === meId() && !isLocal()) leaveToLobby(); });
      return;
    }
    const map = {
      up: { type: 'move', player: id, dir: -1 },
      down: { type: 'move', player: id, dir: 1 },
      button: { type: 'button', player: id },
      sit: { type: 'sitOut', player: id, value: !p.sittingOut },
      rebuy: { type: 'rebuy', player: id },
      adjust: { type: 'adjust', player: id, stack: (document.getElementById('in-adj') || {}).value },
    };
    send(map[kind]);
  }

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S && ui.view === 'table') render(); }, 120); });

  const start = () => boot();
  if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start); else start();
})();
