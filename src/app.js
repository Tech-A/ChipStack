/* ChipStack UI */
(function () {
  'use strict';
  const E = window.ChipEngine;
  const T = window.ChipTransport;
  const $app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-NZ');

  let net = null;          // ClaudeBackend | PeerBackend (online mode)
  let netReady = null;     // promise resolving to net or throwing
  let backend = null;      // the backend in use at the table
  let S = null;            // current table state
  let online = new Set();
  const ui = {
    screen: 'home', busy: false, err: '', homeNote: '',
    stageKey: '', staged: [], confirmFold: false, actFor: false,
    winKey: '', winners: [], sheet: null, sheetPlayer: null, confirmRemove: false,
  };

  // ---------------- boot ----------------
  async function boot() {
    const hash = (location.hash || '').replace('#', '').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(hash)) ui.prefill = hash;
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
  const isLocal = () => backend && backend.kind === 'local';
  const amHost = () => S && (isLocal() || S.hostId === meId());
  const P = (id) => S.players.find((p) => p.id === id);
  const nameOf = (id) => (P(id) || { name: '?' }).name;

  function denoms() {
    const { sb, bb } = S.settings;
    const vals = [...new Set([sb, bb, bb * 5, bb * 25, bb * 100])].sort((a, b) => a - b);
    return vals.slice(0, 5).map((v, i) => ({ v, cls: 'c' + (i + 1) }));
  }
  function breakdown(amount) {
    const ds = denoms().slice().reverse();
    const out = [];
    let rest = amount;
    for (const d of ds) {
      const n = Math.floor(rest / d.v);
      if (n > 0) { out.push({ ...d, n }); rest -= n * d.v; }
    }
    if (rest > 0) out.push({ v: rest, cls: 'c1', n: 1 });
    return out;
  }
  function pileHTML(amount, maxCols = 5) {
    if (!amount) return '';
    return '<span class="pile" aria-hidden="true">' + breakdown(amount).slice(0, maxCols).map((d) =>
      '<span class="col">' + Array.from({ length: Math.min(d.n, 6) }, () => `<span class="chip mini ${d.cls}"></span>`).join('') + '</span>'
    ).join('') + '</span>';
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
    if (ui.busy) return;
    ui.busy = true; render();
    try { await backend.submit(action); }
    catch (e) { toast(e.message, true); }
    finally { ui.busy = false; render(); }
  }

  let wakeLock = null;
  function keepAwake() {
    if (wakeLock || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
  }
  document.addEventListener('pointerdown', keepAwake, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wakeLock = null; } });

  // ---------------- entering a table ----------------
  let unsub = null;
  function attach(b) {
    if (unsub) unsub();
    backend = b;
    let lastTurn = null;
    const u1 = b.onState((s) => {
      S = s;
      ui.screen = 'table';
      const turn = s.hand && s.hand.toAct;
      if (turn && turn !== lastTurn && turn === meId() && !isLocal()) { try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (e) { /* ignore */ } }
      lastTurn = turn;
      render();
    });
    const u2 = b.onOnline ? b.onOnline((set) => { online = set; render(); }) : () => {};
    unsub = () => { u1(); u2(); };
    T.store.set('chipstack:name', ui.name || T.store.get('chipstack:name') || '');
  }

  async function createTable(form, local) {
    const name = form.name.trim();
    if (!name) return fail('Enter your name first.');
    const settings = { startingStack: +form.stack, sb: +form.sb, bb: +form.bb };
    if (!(settings.startingStack > 0) || !(settings.sb > 0) || !(settings.bb >= settings.sb)) return fail('Check the buy-in and blinds: big blind must be at least the small blind.');
    ui.busy = true; ui.err = ''; render();
    try {
      T.store.set('chipstack:name', name);
      const b = local ? await new T.LocalBackend().init() : await netReady;
      const code = await b.create(settings, name);
      if (!local) T.store.set('chipstack:last', code);
      attach(b);
    } catch (e) { fail(e.message); }
    finally { ui.busy = false; render(); }
  }

  async function joinTable(code, name) {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim();
    if (!name) return fail('Enter your name first.');
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail('Table codes are 4 letters or numbers.');
    ui.busy = true; ui.err = ''; render();
    try {
      T.store.set('chipstack:name', name);
      const b = await netReady;
      await b.open(code);
      attach(b);
      T.store.set('chipstack:last', code);
      if (!b.state.players.some((p) => p.id === b.me.id)) await b.submit({ type: 'join', name });
    } catch (e) { fail(e.message); }
    finally { ui.busy = false; render(); }
  }

  async function continueLocal() {
    try { const b = new T.LocalBackend(); await b.open(); attach(b); } catch (e) { fail(e.message); }
  }

  function fail(msg) { ui.err = msg; ui.busy = false; render(); }

  function leaveToHome() {
    if (backend && backend.kind !== 'local' && backend.close) backend.close();
    if (unsub) unsub();
    backend = null; S = null; ui.screen = 'home'; ui.sheet = null;
    render();
  }

  // ---------------- render ----------------
  function render() {
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = focusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
    if (ui.screen === 'table' && S) renderTable(); else renderHome();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* ignore */ } }
    }
  }

  // keep typed values across re-renders
  const draft = {};
  function val(id, fallback) { return draft[id] != null ? draft[id] : fallback; }

  function renderHome() {
    const name = val('in-name', T.store.get('chipstack:name') || '');
    const last = T.store.get('chipstack:last');
    const hasLocal = !!T.store.get('chipstack:local');
    const peerMode = net && net.kind === 'peer';
    const hosted = peerMode ? net.hostedCodes() : [];
    const ready = !!net;
    $app.innerHTML = `
    <div class="home">
      <div class="brand">
        ${chipSVG()}
        <div><h1>Chip<br>Stack</h1><p>Real cards on the table, chips on your phone. Built for Texas Hold'em.</p></div>
      </div>
      <div class="field"><label for="in-name">Your name</label><input id="in-name" maxlength="16" autocomplete="nickname" placeholder="e.g. Abbey" value="${esc(name)}"></div>

      <section class="panel" aria-labelledby="h-join">
        <h2 id="h-join">Join a table</h2>
        <div class="field"><label for="in-code">Table code</label><input id="in-code" class="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(val('in-code', ui.prefill || ''))}"></div>
        <button class="btn primary" id="b-join" ${ui.busy || !ready ? 'disabled' : ''}>Join table</button>
        ${last && last !== ui.prefill ? `<button class="link" id="b-last">Rejoin ${esc(last)}</button>` : ''}
        ${hosted.map((c) => `<button class="link" data-resume="${esc(c)}">Resume hosting ${esc(c)}</button>`).join('')}
      </section>

      <section class="panel" aria-labelledby="h-new">
        <h2 id="h-new">Start a table</h2>
        <div class="row3">
          <div class="field"><label for="in-stack">Buy-in</label><input id="in-stack" inputmode="numeric" value="${esc(val('in-stack', '1000'))}"></div>
          <div class="field"><label for="in-sb">Small blind</label><input id="in-sb" inputmode="numeric" value="${esc(val('in-sb', '5'))}"></div>
          <div class="field"><label for="in-bb">Big blind</label><input id="in-bb" inputmode="numeric" value="${esc(val('in-bb', '10'))}"></div>
        </div>
        <button class="btn primary" id="b-create" ${ui.busy || !ready ? 'disabled' : ''}>Create table</button>
        ${peerMode ? '<p class="note">You will host the table. Keep this page open on your phone while you play — everyone else connects through it.</p>' : ''}
        <button class="link" id="b-local">One phone for everyone (pass it around)</button>
        ${hasLocal ? '<button class="link" id="b-local-continue">Continue the one-phone table</button>' : ''}
      </section>
      <div class="err" role="alert">${esc(ui.err)}</div>
      ${!ready ? `<p class="note">${esc(ui.homeNote || 'Connecting…')}</p>` : ''}
    </div>`;
    const form = () => ({ name: document.getElementById('in-name').value, stack: document.getElementById('in-stack').value, sb: document.getElementById('in-sb').value, bb: document.getElementById('in-bb').value });
    $app.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => { draft[i.id] = i.value; }));
    on('#b-join', () => joinTable(document.getElementById('in-code').value, document.getElementById('in-name').value));
    on('#b-last', () => joinTable(last, document.getElementById('in-name').value));
    on('#b-create', () => createTable(form(), false));
    on('#b-local', () => createTable(form(), true));
    on('#b-local-continue', continueLocal);
    $app.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', () => joinTable(b.dataset.resume, document.getElementById('in-name').value)));
    const codeIn = document.getElementById('in-code');
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinTable(codeIn.value, document.getElementById('in-name').value); });
  }

  function chipSVG() {
    return `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#c8372d"/>${
      Array.from({ length: 8 }, (_, i) => `<rect x="28" y="2" width="8" height="12" rx="2" fill="#f2ecdc" transform="rotate(${i * 45} 32 32)"/>`).join('')
    }<circle cx="32" cy="32" r="18" fill="#c8372d" stroke="#f2ecdc" stroke-width="2" stroke-dasharray="4 3"/><text x="32" y="38" text-anchor="middle" font-family="Big Shoulders Display, Impact, sans-serif" font-weight="900" font-size="17" fill="#f2ecdc">$</text></svg>`;
  }

  function on(sel, fn) { const el = $app.querySelector(sel) || document.querySelector(sel); if (el) el.addEventListener('click', fn); }

  // ---------------- table screen ----------------
  function renderTable() {
    const h = S.hand;
    const pot = E.potTotal(h);
    const st = h ? h.street : null;
    const streetIdx = st ? E.STREETS.indexOf(st) : -1;
    const labels = ['PRE', 'FLOP', 'TURN', 'RIVER', 'SHOW'];
    const lastRes = S.lastResult && !h ? S.lastResult : null;
    let hint = '';
    if (h) hint = st === 'showdown' ? (h.runout ? 'Run out the rest of the board, then show hands' : E.DEAL_HINT.showdown) : E.DEAL_HINT[st];
    else hint = S.players.length < 2 ? `Waiting for players — share code ${S.code}` : 'Shuffle up and deal when ready';

    const sidePots = h && h.pots && h.pots.length > 1 ? h.pots.map((p, i) => `${i ? 'Side ' + i : 'Main'} ${fmt(p.amount)}`).join(' · ') : '';

    $app.innerHTML = `
    <header class="top">
      <span class="codepill" aria-label="Table code">${esc(S.code === 'HERE' ? 'ONE' : S.code)}</span>
      <div class="meta">${h ? `<b>Hand ${h.no}</b><br>` : `<b>${S.players.length} at the table</b><br>`}Blinds ${fmt(S.settings.sb)}/${fmt(S.settings.bb)}</div>
      <button class="iconbtn" id="b-menu" aria-label="Table menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    </header>
    <main class="scroll">
      ${lastRes && lastRes.wins.length ? `<div class="result">${lastRes.wins.map((w) => `${esc(nameOf(w.id))} won ${fmt(w.amount)}`).join(' · ')}</div>` : ''}
      <section class="potzone" id="potzone" aria-live="polite">
        <div class="streets">${labels.map((l, i) => `<span class="${i === streetIdx ? 'on' : i < streetIdx ? 'done' : ''}">${l}</span>`).join('')}</div>
        <div class="label">Pot</div>
        <div class="amt num">${fmt(pot)}</div>
        ${pileHTML(pot)}
        ${sidePots ? `<div class="side">${sidePots}</div>` : ''}
        <div class="hint">${esc(hint)}</div>
      </section>
      <section class="seats" aria-label="Players in seat order">
        ${S.players.map(seatHTML).join('')}
      </section>
      ${!h ? `<p class="note" style="margin-top:12px">${isLocal() ? 'Tap a player to move seats, give the button or add chips.' : 'Seat order should match where people sit, going clockwise. Tap a player to move them.'}</p>` : ''}
      ${!h && isLocal() ? '<button class="btn ghost small" id="b-add" style="margin-top:4px">Add player</button>' : ''}
    </main>
    <footer class="dock" id="dock">${dockHTML()}</footer>
    ${ui.sheet ? sheetHTML() : ''}`;
    wireTable();
  }

  function seatHTML(p) {
    const h = S.hand;
    const inHand = h && h.seats.includes(p.id);
    const folded = inHand && h.folded[p.id];
    const allIn = inHand && h.allIn[p.id];
    const turn = h && h.toAct === p.id;
    const bet = inHand ? (h.bets[p.id] || 0) : 0;
    const btn = h ? h.buttonId === p.id : S.buttonId === p.id;
    const out = !inHand && (p.sittingOut || p.stack === 0);
    const status = [];
    if (p.id === meId()) status.push('<span class="tag you">You</span>');
    if (p.id === S.hostId && !isLocal()) status.push('<span class="tag">Host</span>');
    if (allIn) status.push('<span class="tag allin">All in</span>');
    if (folded) status.push('<span class="tag">Folded</span>');
    if (p.sittingOut) status.push('<span class="tag">Sitting out</span>');
    else if (p.stack === 0 && !inHand) status.push('<span class="tag">Busted</span>');
    if (h && !inHand && !p.sittingOut && p.stack > 0) status.push('<span class="tag">Next hand</span>');
    if (turn) status.push('<span class="tag" style="background:var(--brass);color:var(--brass-ink)">To act</span>');
    const showOnline = !isLocal() && backend.kind !== 'local';
    return `<button class="seat ${turn ? 'turn' : ''} ${folded ? 'folded' : ''} ${out ? 'out' : ''}" data-player="${esc(p.id)}">
      <span class="tokens">${btn ? '<span class="tok d" title="Dealer button">D</span>' : ''}${h && h.sbId === p.id ? '<span class="tok sb" title="Small blind">SB</span>' : ''}${h && h.bbId === p.id ? '<span class="tok bb" title="Big blind">BB</span>' : ''}</span>
      <span style="min-width:0">
        <span class="nm">${showOnline ? `<span class="dot ${online.has(p.id) ? 'on' : ''}" title="${online.has(p.id) ? 'Online' : 'Offline'}"></span> ` : ''}${esc(p.name)}</span>
        <span class="sub">${status.join('')}</span>
      </span>
      <span><span class="stack num">${fmt(p.stack)}</span>${bet ? `<span class="bet num">${pileHTML(bet, 3)}${fmt(bet)}</span>` : ''}</span>
    </button>`;
  }

  // ----- dock -----
  function actorId() {
    const h = S.hand;
    if (!h || !h.toAct) return null;
    if (isLocal()) return h.toAct;
    if (h.toAct === meId()) return h.toAct;
    if (amHost() && ui.actFor) return h.toAct;
    return null;
  }

  function dockHTML() {
    const h = S.hand;
    const me = isLocal() ? null : P(meId());
    if (!h) {
      const elig = S.players.filter((p) => p.stack > 0 && !p.sittingOut);
      const can = elig.length >= 2;
      return `
        <div class="dockhead"><span class="who">${me ? esc(me.name) : 'Between hands'}</span>${me ? `<span class="mystack num"><small>Stack</small>${fmt(me.stack)}</span>` : ''}</div>
        ${me && me.stack === 0 ? '<button class="btn" id="b-rebuy-me">Rebuy ' + fmt(S.settings.startingStack) + '</button>' : ''}
        <button class="btn primary" id="b-deal" ${!can || ui.busy ? 'disabled' : ''}>${can ? `Deal hand ${S.handNo + 1}` : 'Need 2 players with chips'}</button>
        ${can ? `<p class="note" style="margin:0;text-align:center">${esc(nameOf(S.buttonId))} gets the button. Blinds go in automatically.</p>` : ''}`;
    }
    if (h.street === 'showdown') return showdownHTML();
    const actor = actorId();
    if (!actor) {
      const waitingOn = nameOf(h.toAct);
      return `
        <div class="dockhead"><span class="who">${me ? esc(me.name) : ''}</span>${me ? `<span class="mystack num"><small>Stack</small>${fmt(me.stack)}</span>` : ''}</div>
        <div class="waiting">Waiting for <b>${esc(waitingOn)}</b>${me && h.seats.includes(me.id) && !h.folded[me.id] ? ` · you have ${fmt(h.bets[me.id] || 0)} in this round` : ''}</div>
        ${amHost() ? `<button class="btn ghost small" id="b-actfor">Act for ${esc(waitingOn)}</button>` : ''}`;
    }
    return betDockHTML(actor);
  }

  function betDockHTML(actor) {
    const h = S.hand;
    const p = P(actor);
    const L = E.legal(S, actor);
    const key = `${h.no}|${h.street}|${actor}|${h.currentBet}|${S.version}`;
    if (ui.stageKey.split('|').slice(0, 4).join('|') !== key.split('|').slice(0, 4).join('|')) { ui.staged = []; ui.confirmFold = false; }
    ui.stageKey = key;
    const staged = ui.staged.reduce((t, v) => t + v, 0);
    const to = L.mine + staged;
    const allIn = staged === p.stack;
    let third = { label: L.isBet ? 'Bet' : 'Raise', act: null, disabled: true };
    if (staged > 0) {
      if (to === h.currentBet && L.toCall > 0) third = { label: `Call ${fmt(staged)}`, act: { type: 'call' } };
      else if (to > h.currentBet && (to >= L.minTo || allIn)) third = { label: allIn ? `All in ${fmt(to)}` : (L.isBet ? `Bet ${fmt(to)}` : `Raise to ${fmt(to)}`), act: { type: 'raise', to } };
      else if (to < h.currentBet && allIn) third = { label: `All in ${fmt(staged)}`, act: { type: 'call' } };
      else third = { label: `Min ${fmt(L.minTo)}`, act: 'min' };
    }
    const callLabel = L.canCheck ? 'Check' : (L.toCall >= p.stack ? `All in ${fmt(p.stack)}` : `Call ${fmt(L.toCall)}`);
    const ds = denoms();
    const actingFor = actor !== meId() && !isLocal();
    return `
      <div class="dockhead">
        <span class="who">${isLocal() ? `${esc(p.name)}'s turn` : actingFor ? `Acting for ${esc(p.name)}` : 'Your turn'}${actingFor ? ' · <button class="link" id="b-stopact" style="display:inline;padding:0">stop</button>' : ''}</span>
        <span class="mystack num"><small>Stack</small>${fmt(p.stack - staged)}</span>
      </div>
      <div class="betline" id="betline" aria-label="Betting line — drag or tap chips to add">
        <div class="amt num">${fmt(staged)}<small>${staged ? (L.mine ? `+${fmt(L.mine)} already in = ${fmt(to)}` : 'tap pile to take back') : (L.toCall ? `${fmt(L.toCall)} to call` : 'drag chips here')}</small></div>
        <button class="link" id="b-unstage" aria-label="Take back last chip" style="text-decoration:none">${pileHTML(staged, 5) || ''}</button>
      </div>
      <div class="rack" role="group" aria-label="Your chips">
        ${ds.map((d) => `<button class="chip ${d.cls}" data-chip="${d.v}" ${d.v > p.stack - staged || ui.busy ? 'disabled' : ''} aria-label="Add ${d.v}">${shortNum(d.v)}</button>`).join('')}
      </div>
      <div class="quick">
        <button data-q="min">Min</button><button data-q="half">½ pot</button><button data-q="pot">Pot</button><button data-q="all">All in</button>
      </div>
      <div class="acts">
        <button class="btn ${ui.confirmFold ? 'danger' : 'ghost'}" id="b-fold" ${ui.busy ? 'disabled' : ''}>${ui.confirmFold ? 'Really fold?' : 'Fold'}</button>
        <button class="btn" id="b-call" ${ui.busy ? 'disabled' : ''}>${callLabel}</button>
        <button class="btn primary" id="b-raise" ${third.disabled || ui.busy ? 'disabled' : ''}>${third.label}</button>
      </div>`;
  }
  const shortNum = (v) => v >= 1000 ? (v / 1000) + 'K' : String(v);

  function showdownHTML() {
    const h = S.hand;
    const key = `${h.no}`;
    if (ui.winKey !== key) { ui.winKey = key; ui.winners = h.pots.map(() => []); }
    const ready = ui.winners.length === h.pots.length && ui.winners.every((w) => w.length);
    return `
      <div class="dockhead"><span class="who">Who won?</span><span class="note">Tap two to split</span></div>
      <div class="pots">
        ${h.pots.map((pot, i) => `
          <div class="potpick">
            <div class="h"><span>${h.pots.length > 1 ? (i === 0 ? 'Main pot' : 'Side pot ' + i) : 'Pot'}</span><span class="num">${fmt(pot.amount)}</span></div>
            <div class="pickrow">${pot.eligible.map((id) => `<button class="pick ${ui.winners[i] && ui.winners[i].includes(id) ? 'on' : ''}" data-pot="${i}" data-win="${esc(id)}">${esc(nameOf(id))}</button>`).join('')}</div>
          </div>`).join('')}
      </div>
      <button class="btn primary" id="b-award" ${!ready || ui.busy ? 'disabled' : ''}>Pay the winner${h.pots.length > 1 || ui.winners.some((w) => w.length > 1) ? 's' : ''}</button>`;
  }

  // ----- sheets -----
  function sheetHTML() {
    if (ui.sheet === 'menu') return wrapSheet(menuHTML());
    if (ui.sheet === 'player') return wrapSheet(playerSheetHTML());
    if (ui.sheet === 'add') return wrapSheet(`
      <h3>Add player</h3>
      <div class="field"><label for="in-add">Name</label><input id="in-add" maxlength="16" value="${esc(val('in-add', ''))}"></div>
      <button class="btn primary" id="b-add-go">Add with ${fmt(S.settings.startingStack)}</button>`);
    return '';
  }
  const wrapSheet = (inner) => `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">${inner}<button class="btn ghost" id="b-close">Close</button></div></div>`;

  function menuHTML() {
    const host = amHost();
    const rows = S.players.map((p) => {
      const inBank = p.buyIns * S.settings.startingStack;
      const live = S.hand && S.hand.seats.includes(p.id) ? (S.hand.committed[p.id] || 0) : 0;
      const net = p.stack + live - inBank;
      return `<tr><td>${esc(p.name)}</td><td>${p.buyIns}×</td><td class="num">${fmt(p.stack)}</td><td class="num ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : ''}${fmt(net)}</td></tr>`;
    }).join('');
    const peer = backend.kind === 'peer';
    return `
      <h3>Table ${esc(S.code === 'HERE' ? '(one phone)' : S.code)}</h3>
      ${!isLocal() ? `<p class="note" style="margin:0">Friends open ChipStack and join with code <b style="color:var(--bone)">${esc(S.code)}</b>.${peer ? ' Keep the host\'s phone awake with the app open.' : ''}</p>
      <div class="grid2"><button class="btn small" id="b-copycode">Copy code</button>${peer ? '<button class="btn small" id="b-copylink">Copy invite link</button>' : ''}</div>` : ''}
      <h3 style="font-size:18px">Ledger</h3>
      <div style="overflow-x:auto"><table class="ledger"><thead><tr><th>Player</th><th>Buy-ins</th><th>Stack</th><th>Net</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${host ? `
      <h3 style="font-size:18px">Blinds and buy-in</h3>
      <div class="row3">
        <div class="field"><label for="in-s-stack">Buy-in</label><input id="in-s-stack" inputmode="numeric" value="${esc(val('in-s-stack', S.settings.startingStack))}"></div>
        <div class="field"><label for="in-s-sb">Small</label><input id="in-s-sb" inputmode="numeric" value="${esc(val('in-s-sb', S.settings.sb))}"></div>
        <div class="field"><label for="in-s-bb">Big</label><input id="in-s-bb" inputmode="numeric" value="${esc(val('in-s-bb', S.settings.bb))}"></div>
      </div>
      <div class="grid2"><button class="btn small" id="b-settings" ${S.hand ? 'disabled' : ''}>${S.hand ? 'Change after this hand' : 'Save blinds'}</button>
      <button class="btn small" id="b-undo" ${!S.history || !S.history.length ? 'disabled' : ''}>Undo last action</button></div>` : ''}
      <h3 style="font-size:18px">What happened</h3>
      <div class="logbox">${S.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') || '<div>Nothing yet.</div>'}</div>
      <button class="btn ghost" id="b-leave">${isLocal() ? 'Back to start (table is saved)' : 'Back to start'}</button>`;
  }

  function playerSheetHTML() {
    const p = P(ui.sheetPlayer);
    if (!p) return '<h3>Player left</h3>';
    const self = p.id === meId() || isLocal();
    const host = amHost();
    const inHand = S.hand && S.hand.seats.includes(p.id);
    const between = !S.hand;
    const parts = [`<h3>${esc(p.name)}</h3><p class="note" style="margin:0">Stack ${fmt(p.stack)} · ${p.buyIns} buy-in${p.buyIns > 1 ? 's' : ''}</p>`];
    const btns = [];
    if (between) {
      btns.push(`<button class="btn small" data-pa="up">Move up a seat</button>`);
      btns.push(`<button class="btn small" data-pa="down">Move down a seat</button>`);
      if (S.buttonId !== p.id) btns.push(`<button class="btn small" data-pa="button">Give dealer button</button>`);
    }
    if (self || host) btns.push(`<button class="btn small" data-pa="sit">${p.sittingOut ? 'Back in next hand' : 'Sit out'}</button>`);
    if ((self || host) && !inHand) btns.push(`<button class="btn small" data-pa="rebuy">Rebuy +${fmt(S.settings.startingStack)}</button>`);
    parts.push(btns.length ? `<div class="grid2">${btns.join('')}</div>` : '<p class="note">Seat changes open up between hands.</p>');
    if (host && between) {
      parts.push(`<div class="field"><label for="in-adj">Set stack (fix mistakes)</label><input id="in-adj" inputmode="numeric" value="${esc(val('in-adj', p.stack))}"></div><button class="btn small" data-pa="adjust">Save stack</button>`);
    }
    if ((self || host) && !inHand) parts.push(`<button class="btn small ${ui.confirmRemove ? 'danger' : 'ghost'}" data-pa="remove">${ui.confirmRemove ? `Tap again to remove ${esc(p.name)}` : 'Remove from table'}</button>`);
    return parts.join('');
  }

  // ---------------- wiring ----------------
  function wireTable() {
    $app.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => { draft[i.id] = i.value; }));
    on('#b-menu', () => { ui.sheet = 'menu'; ['in-s-stack', 'in-s-sb', 'in-s-bb'].forEach((k) => delete draft[k]); render(); });
    on('#b-add', () => { ui.sheet = 'add'; delete draft['in-add']; render(); setTimeout(() => { const i = document.getElementById('in-add'); if (i) i.focus(); }, 30); });
    $app.querySelectorAll('.seat').forEach((el) => el.addEventListener('click', () => { ui.sheet = 'player'; ui.sheetPlayer = el.dataset.player; ui.confirmRemove = false; delete draft['in-adj']; render(); }));
    on('#b-deal', () => send({ type: 'deal' }));
    on('#b-rebuy-me', () => send({ type: 'rebuy' }));
    on('#b-actfor', () => { ui.actFor = true; render(); });
    on('#b-stopact', (e) => { e.stopPropagation(); ui.actFor = false; render(); });

    // betting
    const actor = S.hand && actorId();
    if (actor && S.hand.street !== 'showdown') wireBetting(actor);

    // showdown
    $app.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.pot; const id = b.dataset.win;
      const w = ui.winners[i];
      ui.winners[i] = w.includes(id) ? w.filter((x) => x !== id) : w.concat(id);
      render();
    }));
    on('#b-award', () => send({ type: 'award', winners: ui.winners }));

    // sheets
    const scrim = document.getElementById('scrim');
    if (scrim) scrim.addEventListener('click', (e) => { if (e.target === scrim) { ui.sheet = null; render(); } });
    on('#b-close', () => { ui.sheet = null; render(); });
    on('#b-leave', leaveToHome);
    on('#b-undo', () => send({ type: 'undo' }));
    on('#b-settings', () => send({ type: 'settings', startingStack: document.getElementById('in-s-stack').value, sb: document.getElementById('in-s-sb').value, bb: document.getElementById('in-s-bb').value }).then(() => toast('Blinds saved')));
    on('#b-copycode', () => copy(S.code));
    on('#b-copylink', () => copy(location.origin + location.pathname + '#' + S.code));
    on('#b-add-go', addPlayer);
    const addIn = document.getElementById('in-add');
    if (addIn) addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayer(); });
    $app.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => playerAction(b.dataset.pa)));
  }

  async function addPlayer() {
    const n = (document.getElementById('in-add').value || '').trim();
    if (!n) return toast('Type a name first', true);
    await send({ type: 'join', by: 'l' + T.rid(), name: n });
    delete draft['in-add'];
    ui.sheet = null; render();
  }

  function playerAction(kind) {
    const id = ui.sheetPlayer;
    const p = P(id);
    if (!p) return;
    const map = {
      up: { type: 'move', player: id, dir: -1 },
      down: { type: 'move', player: id, dir: 1 },
      button: { type: 'button', player: id },
      sit: { type: 'sitOut', player: id, value: !p.sittingOut },
      rebuy: { type: 'rebuy', player: id },
      adjust: { type: 'adjust', player: id, stack: (document.getElementById('in-adj') || {}).value },
    };
    if (kind === 'remove') {
      if (!ui.confirmRemove) { ui.confirmRemove = true; render(); return; }
      ui.confirmRemove = false; ui.sheet = null;
      send({ type: 'leave', player: id }).then(() => { if (id === meId() && !isLocal()) leaveToHome(); });
      return;
    }
    // in local mode, act as the player themselves
    const a = map[kind];
    if (isLocal() && (kind === 'sit' || kind === 'rebuy')) a.by = '*';
    send(a);
  }

  function copy(text) {
    const done = () => toast('Copied ' + text);
    try { navigator.clipboard.writeText(text).then(done, () => toast('Code: ' + text)); }
    catch (e) { toast('Code: ' + text); }
  }

  function wireBetting(actor) {
    const h = S.hand;
    const p = P(actor);
    const L = E.legal(S, actor);
    const stagedSum = () => ui.staged.reduce((t, v) => t + v, 0);
    const base = { player: actor };
    const setTo = (target) => {
      const to = Math.max(L.minTo, Math.min(L.maxTo, target));
      const amt = to - L.mine;
      ui.staged = breakdown(amt).flatMap((d) => Array.from({ length: d.n }, () => d.v));
      render();
    };
    const sb = S.settings.sb;
    const roundTo = (n) => Math.round(n / sb) * sb;
    $app.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const q = b.dataset.q;
      const potAfterCall = L.pot + L.toCall;
      if (q === 'min') setTo(L.minTo);
      if (q === 'half') setTo(h.currentBet + roundTo(potAfterCall / 2));
      if (q === 'pot') setTo(h.currentBet + roundTo(potAfterCall));
      if (q === 'all') setTo(L.maxTo);
    }));
    on('#b-unstage', () => { ui.staged.pop(); render(); });
    on('#b-fold', () => {
      if (L.canCheck && !ui.confirmFold) { ui.confirmFold = true; render(); return; }
      ui.confirmFold = false;
      send({ type: 'fold', ...base });
    });
    on('#b-call', () => send({ type: L.canCheck ? 'check' : 'call', ...base }));
    on('#b-raise', () => {
      const staged = stagedSum();
      const to = L.mine + staged;
      const allIn = staged === p.stack;
      if (to === h.currentBet && L.toCall > 0) return send({ type: 'call', ...base });
      if (to < h.currentBet && allIn) return send({ type: 'call', ...base });
      if (to > h.currentBet && (to >= L.minTo || allIn)) return send({ type: 'raise', to, ...base });
      setTo(L.minTo);
    });

    // chips: tap to add, or drag onto the betting line / pot
    $app.querySelectorAll('[data-chip]').forEach((chip) => {
      chip.addEventListener('pointerdown', (e) => startDrag(e, chip, +chip.dataset.chip, p.stack));
      chip.addEventListener('click', (e) => { if (chip.dataset.dragged) { delete chip.dataset.dragged; return; } addChip(+chip.dataset.chip, p.stack); e.preventDefault(); });
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addChip(+chip.dataset.chip, p.stack); } });
    });
  }

  function addChip(v, stack) {
    const sum = ui.staged.reduce((t, x) => t + x, 0);
    if (sum + v > stack) return toast('Not enough chips', true);
    ui.staged.push(v);
    try { navigator.vibrate && navigator.vibrate(8); } catch (e) { /* ignore */ }
    render();
  }

  function startDrag(e, chip, v, stack) {
    if (chip.disabled) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null;
    const zones = () => [document.getElementById('betline'), document.getElementById('potzone')].filter(Boolean);
    const overZone = (x, y) => zones().some((z) => { const r = z.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!ghost && Math.hypot(dx, dy) > 8) {
        ghost = chip.cloneNode(true);
        ghost.classList.add('dragghost');
        ghost.removeAttribute('data-chip');
        document.body.appendChild(ghost);
        chip.dataset.dragged = '1';
      }
      if (ghost) {
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
        const bl = document.getElementById('betline');
        if (bl) bl.classList.toggle('over', overZone(ev.clientX, ev.clientY));
        ev.preventDefault();
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove();
      const dy = ev.clientY - sy;
      if (overZone(ev.clientX, ev.clientY) || dy < -60) addChip(v, stack);
      else { const bl = document.getElementById('betline'); if (bl) bl.classList.remove('over'); }
      setTimeout(() => { delete chip.dataset.dragged; }, 50);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // keep open views across a republish
  const start = () => boot();
  if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start); else start();
})();
