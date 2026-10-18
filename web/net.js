// @ts-check
// uuid, outbox, replay (GUIDE §5.4). Must work on an INSECURE origin (http://192.168.x.y):
// no crypto.randomUUID, no service worker, no secure-context APIs.

export function uuid() {                         // works on insecure origins
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const OB = 'pos.outbox', SQ = 'pos.lastSeq', EP = 'pos.epoch', HOSTS = 'pos.hosts';

/** @param {string} k @param {any} d */
function read(k, d) {
  try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
}
/** @param {string} k @param {any} v */
function write(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

/** @returns {{t: 'cmd', opId: string, type: string, payload: any, ts: number}[]} */
export const outbox = () => read(OB, []);
/** @param {any[]} a */
const saveOutbox = (a) => write(OB, a);
export const lastSeq = () => Number(read(SQ, 0)) || 0;
/** @param {number} s */
export const setLastSeq = (s) => write(SQ, s);
export const lastEpoch = () => read(EP, '');
/** @returns {string[]} */
export const knownHosts = () => read(HOSTS, []);
/** @param {string[]} list */
export const saveHosts = (list) => write(HOSTS, [...new Set(list)].slice(0, 10));

/**
 * @typedef {{ hello: () => Record<string, any>, onMsg: (msg: any) => void,
 *   onStatus: (s: 'connecting'|'online'|'offline') => void, onClose: (code: number) => void,
 *   onUnreachable: () => void }} ConnectOpts
 */

/** @type {WebSocket | null} */
let ws = null;
let backoff = 500, failures = 0, stopped = false;
/** @type {ConnectOpts | null} */
let opts = null;
/** @type {Map<string, {resolve: (v: any) => void, reject: (e: any) => void}>} */
const pending = new Map();
let synced = false;

/** @param {ConnectOpts} o */
export function connect(o) {
  opts = o;
  stopped = false;
  open();
  document.addEventListener('visibilitychange', () => {
    // Chrome freezes background tabs; reconnect and resync from lastSeq on resume.
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { backoff = 500; open(); }
  });
  window.addEventListener('online', () => { if (!ws || ws.readyState > 1) open(); });
}

export function disconnect() {
  stopped = true;
  ws?.close();
}

function open() {
  if (!opts || stopped) return;
  if (ws && ws.readyState <= 1) return;
  const o = opts;
  o.onStatus('connecting');
  synced = false;
  const sock = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
  ws = sock;
  sock.onopen = () => {
    backoff = 500; failures = 0;
    sock.send(JSON.stringify({ t: 'hello', ...o.hello(), lastSeq: lastSeq(), epoch: lastEpoch() }));
  };
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'evt') {
      const cur = lastSeq();
      if (msg.seq <= cur) return;                                       // already applied
      if (synced && msg.seq > cur + 1) {                               // gap: ask for replay
        sock.send(JSON.stringify({ t: 'sync', since: cur, epoch: lastEpoch() }));
        return;
      }
      o.onMsg(msg);
      setLastSeq(msg.seq);
    } else if (msg.t === 'snapshot') {
      write(EP, msg.epoch);
      o.onMsg(msg);
      setLastSeq(msg.seq);
    } else if (msg.t === 'synced') {
      synced = true;
      write(EP, msg.epoch);
      if (msg.seq > lastSeq()) setLastSeq(msg.seq);
      o.onStatus('online');
      for (const c of outbox()) sock.send(JSON.stringify(c));          // replay unacked commands
      o.onMsg(msg);
    } else if (msg.t === 'ack') {
      saveOutbox(outbox().filter((c) => c.opId !== msg.opId));
      const p = pending.get(msg.opId);
      pending.delete(msg.opId);
      if (p) msg.ok ? p.resolve(msg.result) : p.reject(Object.assign(new Error(msg.error?.msg || msg.error?.code), { code: msg.error?.code }));
      o.onMsg(msg);
    } else o.onMsg(msg);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    o.onStatus('offline');
    if (e.code >= 4000) { o.onClose(e.code); if (e.code !== 4010) return; }
    failures++;
    if (failures === 4) o.onUnreachable();
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}

/**
 * Queue a command (persisted in the localStorage outbox until the host acks it).
 * @param {string} type @param {any} [payload]
 * @returns {Promise<any>}
 */
export function send(type, payload = {}) {
  const cmd = /** @type {const} */ ({ t: 'cmd', opId: uuid(), type, payload, ts: Date.now() });
  saveOutbox([...outbox(), cmd]);                                         // survive reload / offline
  if (ws?.readyState === 1 && synced) ws.send(JSON.stringify(cmd));
  return new Promise((resolve, reject) => pending.set(cmd.opId, { resolve, reject }));
}

/** Drop a queued command that the user abandoned (e.g. failed approval). @param {string} opId */
export function dropQueued(opId) {
  saveOutbox(outbox().filter((c) => c.opId !== opId));
}

export const isOnline = () => !!ws && ws.readyState === 1 && synced;

/** Probe another host origin; opaque success = reachable. Allowed by the host's CSP connect-src. @param {string} origin */
export async function probe(origin) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    await fetch(origin + '/health', { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** HTTP JSON helper with device/session headers. @param {string} path @param {{method?: string, body?: any, auth?: {deviceToken?: string, sessionToken?: string}}} [o] */
export async function api(path, o = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (o.auth?.deviceToken) headers['x-device-token'] = o.auth.deviceToken;
  if (o.auth?.sessionToken) headers['x-session-token'] = o.auth.sessionToken;
  const r = await fetch(path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers, body: o.body ? JSON.stringify(o.body) : undefined, cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok || (data && data.ok === false)) throw Object.assign(new Error(data?.error?.msg || r.statusText), { code: data?.error?.code || String(r.status) });
  return data;
}
