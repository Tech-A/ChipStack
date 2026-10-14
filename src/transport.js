/*
 * Sync backends. Each exposes:
 *   kind, me ({id}), create(settings, name) -> code, open(code), submit(action) -> state,
 *   onState(cb), online (Set of player ids, optional), close()
 *
 * - ClaudeBackend: when the page runs as a claude.ai artifact (shared db doc + room pokes)
 * - PeerBackend:   when hosted anywhere else (GitHub Pages) — host's phone is the server, via PeerJS
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
      for (let i = 0; i < 20; i++) {
        let r;
        try { r = await ref.acquire({ holder: this.me.id + ':' + this.tab, ttlMs: 5000 }); }
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

  // ---------------- PeerJS backend (host phone is the server) ----------------
  let peerLib = null;
  function loadPeer() {
    if (root.Peer) return Promise.resolve(root.Peer);
    if (peerLib) return peerLib;
    peerLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js';
      s.onload = () => res(root.Peer);
      s.onerror = () => rej(new Error('Could not load the connection library. Check your internet.'));
      document.head.appendChild(s);
    });
    return peerLib;
  }
  const PEER_PREFIX = 'chipstack-v1-';

  class PeerBackend extends Emitter {
    constructor() {
      super();
      this.kind = 'peer';
      let id = store.get('chipstack:pid');
      if (!id) { id = 'p' + rid(); store.set('chipstack:pid', id); }
      this.me = { id };
      this.pending = new Map();
      this.conns = new Set();
    }
    async init() { await loadPeer(); return this; }
    async create(settings, name) {
      for (let tries = 0; tries < 5; tries++) {
        const code = makeCode();
        try {
          await this.host(code, E.newTable({ code, hostId: this.me.id, hostName: name, ...settings }));
          return code;
        } catch (e) { if (!/taken/.test(e.message)) throw e; }
      }
      throw new Error('Could not make a table code — try again.');
    }
    hostedCodes() {
      try { return JSON.parse(store.get('chipstack:hosted') || '[]'); } catch (e) { return []; }
    }
    host(code, state) {
      this.close();
      this.code = code; this.isHost = true;
      return new Promise((res, rej) => {
        const peer = new root.Peer(PEER_PREFIX + code, { debug: 0 });
        this.peer = peer;
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.state = null;
          this.push(state);
          this.save();
          res(code);
        });
        peer.on('error', (err) => {
          if (!opened) {
            if (err.type === 'unavailable-id') rej(new Error('Code taken'));
            else rej(new Error('Could not start the table: ' + (err.type || err.message)));
          }
        });
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* ignore */ } });
        peer.on('connection', (conn) => {
          conn.on('open', () => { this.conns.add(conn); conn.send({ t: 'state', state: this.state }); this.updateOnline(); });
          conn.on('close', () => { this.conns.delete(conn); this.updateOnline(); });
          conn.on('data', (msg) => {
            if (!msg || msg.t !== 'act') return;
            conn.pid = msg.action && msg.action.by;
            this.updateOnline();
            try {
              const next = E.reduce(this.state, msg.action);
              this.apply(next);
              conn.send({ t: 'ok', rid: msg.rid });
            } catch (e) { conn.send({ t: 'err', rid: msg.rid, msg: e.message }); }
          });
        });
      });
    }
    updateOnline() {
      const set = new Set([this.me.id]);
      this.conns.forEach((c) => c.pid && set.add(c.pid));
      this.setOnline(set);
    }
    save() {
      if (!this.isHost || !this.state) return;
      store.set('chipstack:host:' + this.code, JSON.stringify(this.state));
      const list = this.hostedCodes().filter((c) => c !== this.code);
      list.unshift(this.code);
      store.set('chipstack:hosted', JSON.stringify(list.slice(0, 5)));
    }
    apply(next) {
      this.push(next);
      this.save();
      this.conns.forEach((c) => { try { c.send({ t: 'state', state: next }); } catch (e) { /* ignore */ } });
    }
    async open(code) {
      const saved = store.get('chipstack:host:' + code);
      if (saved) {
        try { return await this.host(code, JSON.parse(saved)); }
        catch (e) { if (!/taken/.test(e.message)) throw e; /* someone else hosts it now: join as guest */ }
      }
      return this.join(code);
    }
    join(code) {
      this.close();
      this.code = code; this.isHost = false;
      return new Promise((res, rej) => {
        const peer = new root.Peer({ debug: 0 });
        this.peer = peer;
        let settled = false;
        const connect = () => {
          const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
          this.conn = conn;
          conn.on('open', () => { this.setOnline(new Set([this.me.id])); });
          conn.on('data', (msg) => {
            if (!msg) return;
            if (msg.t === 'state') { this.push(msg.state); if (!settled) { settled = true; res(code); } }
            else if (msg.t === 'ok' || msg.t === 'err') {
              const p = this.pending.get(msg.rid);
              if (!p) return;
              this.pending.delete(msg.rid);
              msg.t === 'ok' ? p.res(this.state) : p.rej(new Error(msg.msg));
            }
          });
          conn.on('close', () => {
            if (this.conn !== conn || this.closed) return;
            this.setOnline(new Set());
            setTimeout(() => { if (this.conn === conn && !this.closed) connect(); }, 2000);
          });
        };
        peer.on('open', connect);
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') {
            if (!settled) { settled = true; rej(new Error(`No table with code ${code} is open. The host's phone needs the app open.`)); }
            else setTimeout(() => !this.closed && connect(), 3000);
          } else if (!settled) { settled = true; rej(new Error('Connection failed: ' + (err.type || err.message))); }
        });
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* ignore */ } });
      });
    }
    submit(action) {
      const a = { ...action, by: this.me.id };
      if (this.isHost) {
        const next = E.reduce(this.state, a);
        this.apply(next);
        return Promise.resolve(next);
      }
      return new Promise((res, rej) => {
        if (!this.conn || !this.conn.open) return rej(new Error('Reconnecting to the host…'));
        const id = rid();
        this.pending.set(id, { res, rej });
        this.conn.send({ t: 'act', rid: id, action: a });
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('The host did not answer. Is their app open?')); } }, 8000);
      });
    }
    close() {
      this.closed = true;
      try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
      this.peer = this.conn = null;
      this.conns = new Set();
      this.state = null;
      this.closed = false;
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
