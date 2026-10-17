/*
 * Sync backends. Each exposes:
 *   kind, me ({id}), create(settings, name) -> code, open(code), submit(action) -> state,
 *   onState(cb), online (Set of player ids, optional), close()
 *
 * - ClaudeBackend: when the page runs as a claude.ai artifact (shared db doc + room pokes)
 * - PeerBackend:   when hosted anywhere else (GitHub Pages) — host's phone runs the game, public MQTT brokers relay
 * - LocalBackend:  one phone for the whole table (pass-and-play), stored in this browser
 */
(function (root) {
  'use strict';
  const E = root.ChipEngine;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const makeCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const sess = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  class Emitter {
    constructor() { this.subs = new Set(); this.state = null; this.online = new Set(); this.onlineSubs = new Set(); }
    onState(cb) { this.subs.add(cb); if (this.state) cb(this.state); return () => this.subs.delete(cb); }
    onOnline(cb) { this.onlineSubs.add(cb); return () => this.onlineSubs.delete(cb); }
    push(s) {
      if (!s) return;
      if (this.state && this.state.code === s.code && (s.version || 0) < (this.state.version || 0)) return;
      this.state = s;
      this.subs.forEach((cb) => cb(s));
    }
    setOnline(set) { this.online = set; this.onlineSubs.forEach((cb) => cb(set)); }
  }

  // ---------------- claude.ai artifact backend ----------------
  class ClaudeBackend extends Emitter {
    constructor(db, user, room) {
      super();
      this.kind = 'claude';
      this.db = db; this.user = user; this.room = room;
      this.tab = rid();
    }
    async init() {
      const id = this.user ? await this.user.id() : null;
      if (!id) throw new Error('Sign in to claude.ai to join a table.');
      this.me = { id: 'u' + String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) };
      return this;
    }
    ref(code) { return this.db.doc('tables/' + code); }
    async withLease(code, fn) {
      const ref = this.ref(code);
      for (let i = 0; i < 40; i++) {
        let r;
        try { r = await ref.acquire({ holder: this.me.id + ':' + this.tab, ttlMs: 1500 }); }
        catch (e) { if (e && e.code === 'unavailable') { await sleep(300); continue; } throw dbErr(e); }
        if (r && r.acquired) {
          const snap = await ref.get();
          const cur = snap.exists ? snap.data() : null;
          const next = fn(cur && cur.code ? cur : null);
          if (!next) return cur;
          try { await ref.set(next); } catch (e) { throw dbErr(e); }
          this.push(next);
          this.poke(next.version);
          return next;
        }
        await sleep(150 + Math.random() * 250);
      }
      throw new Error('The table is busy — try again.');
    }
    async create(settings, name) {
      for (let tries = 0; tries < 5; tries++) {
        const code = makeCode();
        let taken = false;
        await this.withLease(code, (cur) => {
          if (cur) { taken = true; return null; }
          return E.newTable({ code, hostId: this.me.id, hostName: name, ...settings });
        });
        if (!taken) { await this.open(code); return code; }
      }
      throw new Error('Could not make a table code — try again.');
    }
    async open(code) {
      this.close();
      this.code = code;
      const ref = this.ref(code);
      const snap = await ref.get();
      if (!snap.exists || !(snap.data() || {}).code) throw new Error(`No table with code ${code}.`);
      this.push(snap.data());
      this.unsub = ref.onSnapshot((s) => { const d = s.exists ? s.data() : null; if (d && d.code) this.push(d); }, () => {});
      if (this.room) {
        try {
          this.r = await this.room.join('t-' + code.toLowerCase());
          this.offPoke = this.r.on('poke', async (m) => {
            if (m && m.isMe) return;
            const v = m && m.data && m.data.v;
            if (this.state && v && v <= this.state.version) return;
            try { const s = await ref.get(); if (s.exists) this.push(s.data()); } catch (e) { /* ignore */ }
          });
          this.r.presence({ pid: this.me.id }).catch(() => {});
          this.offPeers = this.r.onPeers(() => {
            const set = new Set();
            for (const p of this.r.peers()) if (p.presence && typeof p.presence.pid === 'string') set.add(p.presence.pid);
            this.setOnline(set);
          });
        } catch (e) { this.r = null; }
      }
    }
    poke(v) { if (this.r) this.r.emit('poke', { v }).catch(() => {}); }
    submit(action) {
      return this.withLease(this.code, (cur) => {
        if (!cur) throw new Error('This table no longer exists.');
        return E.reduce(cur, { ...action, by: this.me.id });
      });
    }
    close() {
      if (this.unsub) this.unsub();
      if (this.offPoke) this.offPoke();
      if (this.offPeers) this.offPeers();
      if (this.r) this.r.leave().catch(() => {});
      this.unsub = this.offPoke = this.offPeers = this.r = null;
      this.state = null;
    }
  }
  function dbErr(e) {
    if (e instanceof Error) return e;
    if (e && e.code === 'invalid_argument') return new Error('You can view this table but not play. Ask the owner for edit access.');
    if (e && e.code === 'quota_exceeded') return new Error('Storage is full. Delete old tables.');
    return new Error((e && e.message) || 'Something went wrong syncing the table.');
  }

  // ---------------- Broker backend (host phone runs the game, public MQTT brokers relay messages) ----------------
  // Every device connects to several free public MQTT brokers at once and sends each message
  // through all of them, so one broker being down doesn't break the table.
  //   chipstack/v2/<CODE>/state   retained, published by the host: the latest table state
  //   chipstack/v2/<CODE>/in      players -> host: hello, act, ping
  //   chipstack/v2/<CODE>/to/<tab> host -> one player: welcome, ok, err
  //   chipstack/v2/<CODE>/lock    retained: which tab is hosting, so a second host tab stands down
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];
  const brokerList = () => root.CHIPSTACK_BROKERS || BROKERS; // tests point this at a local broker
  const TOPIC = (code) => 'chipstack/v2/' + code;
  let mqttLib = null;
  function loadMqtt() {
    if (root.mqtt) return Promise.resolve(root.mqtt);
    if (mqttLib) return mqttLib;
    mqttLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
      s.onload = () => res(root.mqtt);
      s.onerror = () => { mqttLib = null; rej(new Error('Could not load the connection library. Check your internet.')); };
      document.head.appendChild(s);
    });
    return mqttLib;
  }

  class Relay {
    // a bundle of broker connections that behaves like one pub/sub link
    constructor(onMessage) { this.clients = []; this.onMessage = onMessage; this.subs = new Set(); }
    async connect() {
      const lib = await loadMqtt();
      const tries = brokerList().map((url) => new Promise((res) => {
        let done = false;
        const c = lib.connect(url, {
          clientId: 'cs_' + rid(), clean: true, keepalive: 30, connectTimeout: 7000,
          reconnectPeriod: 2500, protocolVersion: 4,
        });
        c.on('connect', () => {
          this.subs.forEach((t) => c.subscribe(t, { qos: 0 }));
          if (!done) { done = true; res(c); }
        });
        c.on('message', (topic, payload) => {
          let msg; try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
          this.onMessage(topic, msg);
        });
        c.on('error', () => {});
        setTimeout(() => { if (!done) { done = true; res(c); } }, 8000); // keep trying in background
      }));
      this.clients = await Promise.all(tries);
      if (!this.clients.some((c) => c.connected)) {
        // give slow networks one more moment
        await sleep(3000);
        if (!this.clients.some((c) => c.connected)) { this.end(); throw new Error("Can't reach the game relay. Check your internet connection and try again."); }
      }
      return this;
    }
    sub(topic) { this.subs.add(topic); this.clients.forEach((c) => c.connected && c.subscribe(topic, { qos: 0 })); }
    pub(topic, msg, retain) {
      const body = JSON.stringify(msg);
      this.clients.forEach((c) => { if (c.connected) c.publish(topic, body, { qos: 0, retain: !!retain }); });
    }
    get up() { return this.clients.some((c) => c.connected); }
    end() { this.clients.forEach((c) => { try { c.end(true); } catch (e) { /* ignore */ } }); this.clients = []; this.subs.clear(); }
  }

  class PeerBackend extends Emitter {
    constructor() {
      super();
      this.kind = 'peer';
      // One identity per browser TAB (sessionStorage survives a refresh), so two tabs or two
      // friends on one browser get separate seats. The host confirms the id on join.
      this.tab = sess.get('chipstack:tab') || rid();
      sess.set('chipstack:tab', this.tab);
      this.me = { id: sess.get('chipstack:pid') || ('p' + rid()) };
      sess.set('chipstack:pid', this.me.id);
      this.pending = new Map();
      this.seen = new Set();
      this.players = new Map(); // host: tab -> { pid, at }
    }
    async init() { await loadMqtt(); return this; }
    hostedCodes() {
      try { return JSON.parse(store.get('chipstack:hosted') || '[]'); } catch (e) { return []; }
    }

    async link(code) {
      this.close();
      this.code = code;
      this.base = TOPIC(code);
      this.retained = null;
      this.relay = new Relay((topic, msg) => this.onMessage(topic, msg));
      this.relay.sub(this.base + '/state');
      this.relay.sub(this.base + '/to/' + this.tab);
      this.relay.sub(this.base + '/lock');
      await this.relay.connect();
    }
    waitForState(ms) {
      return new Promise((res) => {
        if (this.retained) return res(this.retained);
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (this.retained || Date.now() - t0 > ms) { clearInterval(iv); res(this.retained); }
        }, 100);
      });
    }

    onMessage(topic, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id) { if (this.seen.has(msg.id)) return; this.seen.add(msg.id); if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250)); }
      if (topic === this.base + '/state') {
        if (!msg.state || msg.state.code !== this.code) return;
        if (!this.retained || (msg.state.version || 0) >= (this.retained.version || 0)) this.retained = msg.state;
        if (!this.isHost) this.push(msg.state);
        return;
      }
      if (topic === this.base + '/lock') {
        if (this.isHost && msg.tab && msg.tab !== this.tab && msg.at > this.hostSince) {
          this.isHost = false; this.stoodDown = true;
          this.relay.sub(this.base + '/state');
        }
        return;
      }
      if (topic === this.base + '/to/' + this.tab) {
        if (msg.t === 'welcome') {
          this.me.id = msg.pid;
          sess.set('chipstack:pid', msg.pid);
          store.set('chipstack:seat:' + this.code, msg.pid);
          if (this.welcomed) this.welcomed();
          return;
        }
        const p = this.pending.get(msg.rid);
        if (!p) return;
        this.pending.delete(msg.rid);
        msg.t === 'ok' ? p.res(this.state) : p.rej(new Error(msg.msg || 'Something went wrong'));
        return;
      }
      if (topic === this.base + '/in' && this.isHost) this.hostHandle(msg);
    }

    // ----- host side -----
    async create(settings, name) {
      for (let tries = 0; tries < 5; tries++) {
        const code = makeCode();
        await this.link(code);
        const existing = await this.waitForState(1500);
        if (existing) continue; // code used before: pick another
        this.becomeHost(E.newTable({ code, hostId: this.me.id, hostName: name, ...settings }));
        return code;
      }
      throw new Error('Could not make a table code — try again.');
    }
    becomeHost(state) {
      this.isHost = true;
      this.hostSince = Date.now();
      this.relay.sub(this.base + '/in');
      this.relay.pub(this.base + '/lock', { id: rid(), tab: this.tab, at: this.hostSince }, true);
      this.state = null;
      this.apply(state);
      clearInterval(this.onlineTimer);
      this.onlineTimer = setInterval(() => this.updateOnline(), 5000);
      this.updateOnline();
    }
    apply(next) {
      this.push(next);
      this.save();
      this.relay.pub(this.base + '/state', { id: rid(), state: next }, true);
    }
    save() {
      if (!this.isHost || !this.state) return;
      store.set('chipstack:host:' + this.code, JSON.stringify(this.state));
      const list = this.hostedCodes().filter((c) => c !== this.code);
      list.unshift(this.code);
      store.set('chipstack:hosted', JSON.stringify(list.slice(0, 5)));
    }
    reply(tab, msg) { this.relay.pub(this.base + '/to/' + tab, { id: rid(), ...msg }); }
    hostHandle(msg) {
      const tab = typeof msg.tab === 'string' ? msg.tab.slice(0, 40) : null;
      if (!tab) return;
      const now = Date.now();
      const validPid = (p) => typeof p === 'string' && /^p[a-z0-9]{6,30}$/.test(p);
      const takenByOther = (pid) => pid === this.me.id || [...this.players].some(([t, v]) => t !== tab && v.pid === pid && now - v.at < 45000);
      if (msg.t === 'hello') {
        let pid = validPid(msg.pid) ? msg.pid : 'p' + rid();
        if (takenByOther(pid)) pid = 'p' + rid();
        this.players.set(tab, { pid, at: now });
        this.reply(tab, { t: 'welcome', pid });
        this.relay.pub(this.base + '/state', { id: rid(), state: this.state }, true);
        this.updateOnline();
        return;
      }
      if (!validPid(msg.pid)) return;
      const known = this.players.get(tab);
      if (!known) {
        if (takenByOther(msg.pid)) return this.reply(tab, { t: 'err', rid: msg.rid, msg: 'Rejoin the table to keep playing.' });
        this.players.set(tab, { pid: msg.pid, at: now });
      } else known.at = now;
      const pid = this.players.get(tab).pid;
      if (msg.t === 'ping') return;
      if (msg.t !== 'act' || !msg.action) return;
      try {
        const next = E.reduce(this.state, { ...msg.action, by: pid });
        this.apply(next);
        this.reply(tab, { t: 'ok', rid: msg.rid });
      } catch (e) { this.reply(tab, { t: 'err', rid: msg.rid, msg: e.message }); }
    }
    updateOnline() {
      const now = Date.now();
      const set = new Set([this.me.id]);
      this.players.forEach((v) => { if (now - v.at < 40000) set.add(v.pid); });
      this.setOnline(set);
    }

    // ----- player side -----
    async open(code) {
      const saved = store.get('chipstack:host:' + code);
      await this.link(code);
      const live = await this.waitForState(2500);
      if (saved) {
        // resume hosting from this phone's saved copy (or the relay's, if newer)
        const st = JSON.parse(saved);
        const best = live && (live.version || 0) > (st.version || 0) ? live : st;
        if (best.hostId) { this.me.id = best.hostId; sess.set('chipstack:pid', best.hostId); }
        this.becomeHost(best);
        return code;
      }
      if (!live) { this.close(); throw new Error(`No table with code ${code}. Check the code with the host.`); }
      this.push(live);
      await new Promise((res, rej) => {
        let settled = false;
        this.welcomed = () => { if (!settled) { settled = true; res(); } };
        const hello = () => this.relay.pub(this.base + '/in', { id: rid(), t: 'hello', tab: this.tab, pid: store.get('chipstack:seat:' + code) || this.me.id });
        hello();
        const again = setInterval(() => { if (settled) clearInterval(again); else hello(); }, 2500);
        setTimeout(() => {
          if (settled) return;
          settled = true; clearInterval(again);
          rej(new Error("The table exists but the host's phone isn't connected. Ask the host to open the app."));
        }, 12000);
      }).catch((e) => { this.close(); throw e; });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.relay.pub(this.base + '/in', { id: rid(), t: 'ping', tab: this.tab, pid: this.me.id }), 15000);
      this.setOnline(new Set([this.me.id]));
      return code;
    }
    submit(action) {
      if (this.isHost) {
        const next = E.reduce(this.state, { ...action, by: this.me.id });
        this.apply(next);
        return Promise.resolve(next);
      }
      if (this.stoodDown) return Promise.reject(new Error('This table is being hosted from another tab.'));
      return new Promise((res, rej) => {
        if (!this.relay || !this.relay.up) return rej(new Error('Reconnecting…'));
        const id = rid();
        this.pending.set(id, { res, rej });
        this.relay.pub(this.base + '/in', { id: rid(), t: 'act', rid: id, tab: this.tab, pid: this.me.id, action });
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("The host didn't answer. Is the app open on their phone?")); } }, 9000);
      });
    }
    close() {
      clearInterval(this.pingTimer); clearInterval(this.onlineTimer);
      if (this.relay) this.relay.end();
      this.relay = null; this.isHost = false; this.stoodDown = false; this.welcomed = null;
      this.players = new Map(); this.retained = null;
      this.state = null;
    }
  }

  // ---------------- one-phone backend ----------------
  class LocalBackend extends Emitter {
    constructor() { super(); this.kind = 'local'; this.me = { id: '*' }; }
    async init() { return this; }
    async create(settings, name) {
      const code = 'HERE';
      const s = E.newTable({ code, hostId: 'h' + rid(), hostName: name, ...settings });
      this.state = null;
      this.push(s);
      this.save();
      return code;
    }
    async open() {
      const raw = store.get('chipstack:local');
      if (!raw) throw new Error('No saved one-phone table.');
      this.state = null;
      this.push(JSON.parse(raw));
    }
    save() { store.set('chipstack:local', JSON.stringify(this.state)); }
    async submit(action) {
      const a = { ...action, by: action.by || '*' };
      const next = E.reduce(this.state, a);
      this.push(next);
      this.save();
      return next;
    }
    close() { this.state = null; }
  }

  root.ChipTransport = { ClaudeBackend, PeerBackend, LocalBackend, makeCode, store, rid };
})(typeof self !== 'undefined' ? self : this);
