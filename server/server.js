// @ts-check
// Host: static HTTP + JSON API + WebSocket command engine. Plain HTTP on the LAN.
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, rmSync, createReadStream } from 'node:fs';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { openDb, get, all, tx } from './db.js';
import { createEngine } from './engine.js';
import { seedRoles, can } from './rights.js';
import * as auth from './auth.js';
import { getSettings, getPrivate, putSetting, businessDate, readEntity } from './model.js';
import { CmdError } from './errors.js';
import { buildSnapshot } from './snapshot.js';
import { lanIps, isAllowedSource, isLoopback } from './ip.js';
import { dayTally, history, billsCsv } from './reports.js';
import { backupNow, listBackups, backupPath, validateBackup, exportJson } from './backup.js';
import { PrintQueue } from './print/lan.js';
import { renderKot, renderBill, renderTest } from './print/render.js';
import { colsFor } from './print/escpos.js';
import { qrTerminal } from '../web/vendor/qr.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const REPLAY_MAX = 5000;              // larger gaps get a snapshot
const UNACK_MS = 2 * 60_000;          // KOT unacknowledged -> alert billers/managers
const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
});
const SPA = new Set(['/', '/join', '/pair', '/whoami', '/setup', '/login']);
const CSP_BASE = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} [msg] */
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}

/**
 * @param {{port?: number, host?: string, dataDir?: string, quiet?: boolean, now?: () => number}} [opts]
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const dataDir = resolve(opts.dataDir ?? process.env.POS_DATA ?? join(ROOT, 'data'));
  const webDir = join(ROOT, 'web');
  const dirs = { images: join(dataDir, 'images'), backups: join(dataDir, 'backups'), logs: join(dataDir, 'logs') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const dbPath = join(dataDir, 'pos.sqlite');
  const now = opts.now ?? Date.now;
  const log = opts.quiet ? () => {} : (/** @type {any[]} */ ...a) => console.log(new Date().toISOString(), ...a);

  // restart counter for /health
  const restartsFile = join(dataDir, 'restarts.json');
  let restarts = 0;
  try { restarts = JSON.parse(readFileSync(restartsFile, 'utf8')).count + 1; } catch { restarts = 0; }
  writeFileSync(restartsFile, JSON.stringify({ count: restarts, lastStart: now() }));

  /** @type {Set<{ws: import('ws').WebSocket, auth: any, alive: boolean, ip: string}>} */
  const clients = new Set();
  const state = { db: /** @type {any} */ (null), exec: /** @type {any} */ (null), epoch: '', lastBackup: /** @type {any} */ (null) };

  /** @param {any} msg @param {(c: any) => boolean} [filter] */
  const broadcast = (msg, filter) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.auth && c.ws.readyState === 1 && (!filter || filter(c))) c.ws.send(s);
  };

  function boot() {
    state.db = openDb(dbPath);
    tx(state.db, () => {
      seedRoles(state.db);
      if (!getPrivate(state.db, '_epoch')) putSetting(state.db, '_epoch', randomBytes(8).toString('hex'));
    });
    state.epoch = getPrivate(state.db, '_epoch');
    state.exec = createEngine(state.db, broadcast);
  }
  boot();
  const lb = listBackups(dirs.backups)[0];
  state.lastBackup = lb ? { file: lb.file, ts: lb.ts } : null;

  // ---- printing ----
  const queue = new PrintQueue({
    onStatus: (job) => {
      log('print', job.label, job.status, job.error ?? '');
      broadcast({ t: 'alert', kind: 'print', ok: job.status === 'sent', label: job.label, error: job.error ?? '' },
        (c) => can(c.auth.user, 'bill') || can(c.auth.user, 'kot.reprint'));
    },
  });

  /** @param {string} kind @param {string} id @param {{reprint?: boolean}} [o] */
  function print(kind, id, o = {}) {
    const s = getSettings(state.db);
    const printers = /** @type {Record<string, {ip: string, port?: number}>} */ (s.printers || {});
    const cols = colsFor(s.paper);
    let printer, buf, label;
    if (kind === 'kot') {
      const k = get(state.db, 'SELECT no, station FROM kots WHERE id=?', id);
      printer = printers[k.station] ?? printers.kitchen;
      buf = renderKot(state.db, id, { cols, reprint: o.reprint });
      label = `KOT ${k.no} (${k.station})`;
    } else if (kind === 'bill') {
      printer = printers.bill;
      buf = renderBill(state.db, id, { cols });
      label = `Bill ${get(state.db, 'SELECT no FROM bills WHERE id=?', id).no}`;
    } else {
      printer = printers[id];
      buf = renderTest(id, cols);
      label = `Test ${id}`;
    }
    if (!printer?.ip) {
      broadcast({ t: 'alert', kind: 'print', ok: false, label, error: 'No LAN printer set for this station (Admin → Settings → Printers)' },
        (c) => can(c.auth.user, 'bill') || can(c.auth.user, 'kot.reprint'));
      return;
    }
    queue.enqueue({ label, ip: printer.ip, port: printer.port ?? 9100, buf });
  }

  /** @param {(c: any) => boolean} match @param {number} code @param {string} reason */
  function closeWhere(match, code, reason) {
    for (const c of clients) if (c.auth && match(c)) { c.ws.close(code, reason); c.auth = null; }
  }

  /** @param {string} dataUrl */
  function saveImage(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new CmdError('BAD_IMAGE');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1_500_000) throw new CmdError('IMAGE_TOO_BIG', 'Image over 1.5 MB');
    const name = createHash('sha1').update(buf).digest('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    const f = join(dirs.images, name);
    if (!existsSync(f)) writeFileSync(f, buf);
    return name;
  }

  function doBackup(/** @type {string | undefined} */ label) {
    const b = backupNow(state.db, dirs.backups, { label, now: now() });
    state.lastBackup = { file: b.file, ts: b.ts };
    log('backup', b.file, b.size);
    return b;
  }

  const hooks = {
    print,
    closeDevice: (/** @type {string} */ id) => closeWhere((c) => c.auth.device.id === id, 4001, 'revoked'),
    closeUser: (/** @type {string} */ id) => closeWhere((c) => c.auth.user.id === id, 4003, 'session'),
    backup: doBackup,
    saveImage,
  };

  /** Host-originated event (not a client command), e.g. a device paired over HTTP. @param {string} type @param {any[]} changes */
  function appendEvent(type, changes) {
    const seq = Number(get(state.db, 'INSERT INTO events(op_id,type,changes,ts) VALUES (?,?,?,?) RETURNING seq', 'host:' + randomBytes(8).toString('hex'), type, JSON.stringify(changes), now()).seq);
    broadcast({ t: 'evt', seq, data: { changes } });
  }

  /** @param {any} a @param {any} cmd */
  function execCmd(a, cmd) {
    if (!auth.sessionAlive(state.db, a.sessionHash, now())) throw new HttpError(401, 'SESSION', 'Session expired');
    return state.exec(cmd, { user: a.user, device: a.device, hooks, now: now() });
  }

  /** @param {any} e */
  const errBody = (e) => ({ ok: false, error: { code: e.code || 'INTERNAL', msg: e.code ? e.message : 'Internal error' } });

  // ---- HTTP ----
  // CSP connect-src also lists this host's other LAN addresses and configured fallback hosts,
  // so a client can probe them when the current address dies (known-hosts failover).
  let cspCache = { at: 0, value: '' };
  const sec = () => {
    if (now() - cspCache.at > 30_000) {
      const port = /** @type {any} */ (server.address())?.port;
      const origins = [...lanIps().map((ip) => `http://${ip}:${port}`), ...(getSettings(state.db).fallbackHosts ?? [])];
      const connect = ["'self'", ...origins, ...origins.map((o) => o.replace(/^http/, 'ws'))].join(' ');
      cspCache = { at: now(), value: `${CSP_BASE}; connect-src ${connect}` };
    }
    return { 'Content-Security-Policy': cspCache.value, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
  };
  /** @param {http.IncomingMessage} req */
  const readJson = (req) => new Promise((res, rej) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_500_000) { rej(new HttpError(413, 'TOO_LARGE')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { rej(new HttpError(400, 'BAD_JSON')); }
    });
    req.on('error', rej);
  });

  /** @param {http.ServerResponse} res @param {number} status @param {any} body */
  const json = (res, status, body) => {
    res.writeHead(status, { ...sec(), 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** @param {http.IncomingMessage} req @param {string} [right] */
  function httpAuth(req, right) {
    const a = auth.authenticate(state.db, /** @type {string} */ (req.headers['x-device-token']), /** @type {string} */ (req.headers['x-session-token']), now());
    if (!a) throw new HttpError(401, 'AUTH', 'Login required');
    if (right && !right.split('|').some((r) => can(a.user, r))) throw new HttpError(403, 'FORBIDDEN', right);
    return a;
  }

  /** @param {URL} url */
  const dateParam = (url) => {
    const d = url.searchParams.get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : businessDate(state.db, now());
  };

  /** rate limit for pairing: 10 claims / minute / IP */
  const pairHits = new Map();
  /** @param {string} ip */
  const pairLimited = (ip) => {
    const t = now(), w = (pairHits.get(ip) || []).filter((/** @type {number} */ x) => t - x < 60_000);
    w.push(t);
    pairHits.set(ip, w);
    return w.length > 10;
  };

  /** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL, ip: string) => any>} */
  const routes = {
    'GET /health': () => ({
      ok: true, seq: Number(get(state.db, 'SELECT COALESCE(MAX(seq),0) AS s FROM events').s), node: process.version, version: VERSION,
      uptime: Math.round(process.uptime()), restarts, lastBackup: state.lastBackup, clients: [...clients].filter((c) => c.auth).length,
      businessDate: businessDate(state.db, now()),
    }),
    'GET /api/info': (req, res, url, ip) => ({
      name: getSettings(state.db).name, needsSetup: auth.needsSetup(state.db), loopback: isLoopback(ip),
      ips: lanIps(), port: server.address() && /** @type {any} */ (server.address()).port, epoch: state.epoch, version: VERSION,
    }),
    'POST /api/setup': async (req, res, url, ip) => {
      if (!isLoopback(ip)) throw new HttpError(403, 'LOOPBACK_ONLY', 'Run setup on the host phone at http://127.0.0.1:8080');
      const b = await readJson(req);
      return auth.setup(state.db, { ownerName: b.ownerName, pin: b.pin, restaurantName: b.restaurantName }, now());
    },
    'POST /api/recover': async (req, res, url, ip) => {
      if (!isLoopback(ip)) throw new HttpError(403, 'LOOPBACK_ONLY');
      const b = await readJson(req);
      return auth.recover(state.db, b.code, b.pin);
    },
    'POST /api/pair/claim': async (req, res, url, ip) => {
      if (pairLimited(ip)) throw new HttpError(429, 'RATE_LIMIT', 'Too many attempts, wait a minute');
      const b = await readJson(req);
      const r = auth.claimPairCode(state.db, { code: b.code, kind: b.kind, name: b.name }, now());
      appendEvent('device.paired', [{ entity: 'devices', id: r.deviceId, value: readEntity(state.db, 'devices', r.deviceId) }]);
      return r;
    },
    'GET /api/users': (req) => {
      const d = auth.deviceFromToken(state.db, /** @type {string} */ (req.headers['x-device-token']));
      if (!d) throw new HttpError(401, 'BAD_DEVICE', 'Device not paired or revoked');
      return { device: d, users: all(state.db, 'SELECT u.id, u.name, u.role_id AS roleId, r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active=1 ORDER BY u.name') };
    },
    'POST /api/login': async (req) => {
      const b = await readJson(req);
      return auth.login(state.db, { deviceToken: /** @type {string} */ (req.headers['x-device-token']), userId: b.userId, pin: b.pin }, now());
    },
    'POST /api/logout': (req) => {
      const t = /** @type {string} */ (req.headers['x-session-token']);
      if (t) {
        auth.logout(state.db, t);
        const h = auth.sha256(t);
        closeWhere((c) => c.auth.sessionHash === h, 4003, 'logout');
      }
      return { ok: true };
    },
    'POST /api/cmd': async (req) => {
      const a = httpAuth(req);
      const b = await readJson(req);
      return execCmd(a, { opId: b.opId, type: b.type, payload: b.payload });
    },
    'GET /api/print/render': (req, res, url) => {
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? '';
      const cols = Number(url.searchParams.get('cols')) || colsFor(getSettings(state.db).paper);
      if (kind === 'kot') { httpAuth(req, 'kot|kot.reprint'); return { b64: renderKot(state.db, id, { cols, reprint: url.searchParams.has('reprint') }).toString('base64') }; }
      if (kind === 'bill') { httpAuth(req, 'bill|bill.reprint'); return { b64: renderBill(state.db, id, { cols }).toString('base64') }; }
      if (kind === 'test') { httpAuth(req, 'settings'); return { b64: renderTest('rawbt', cols).toString('base64') }; }
      throw new HttpError(400, 'BAD_KIND');
    },
    'GET /api/print/jobs': (req) => { httpAuth(req, 'settings|bill'); return { jobs: queue.list() }; },
    'POST /api/print/retry': async (req) => { httpAuth(req, 'settings|bill'); const b = await readJson(req); return { job: queue.retry(Number(b.id)) ?? null }; },
    'GET /api/reports/day': (req, res, url) => { httpAuth(req, 'reports'); return dayTally(state.db, dateParam(url)); },
    'GET /api/history': (req, res, url) => { httpAuth(req, 'history'); return { bills: history(state.db, dateParam(url)) }; },
    'GET /api/export/csv': (req, res, url) => {
      httpAuth(req, 'export');
      const d = dateParam(url);
      res.writeHead(200, { ...sec(), 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bills-${d}.csv"`, 'Cache-Control': 'no-store' });
      res.end(billsCsv(state.db, d));
    },
    'GET /api/export/json': (req, res) => {
      httpAuth(req, 'export');
      res.writeHead(200, { ...sec(), 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="khanakhajana-export-${businessDate(state.db, now())}.json"`, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(exportJson(state.db)));
    },
    'GET /api/backups': (req) => { httpAuth(req, 'settings'); return { backups: listBackups(dirs.backups), lastBackup: state.lastBackup }; },
    'POST /api/backups': (req) => { httpAuth(req, 'settings'); return doBackup('manual'); },
    'GET /api/backups/download': (req, res, url) => {
      httpAuth(req, 'settings');
      const f = backupPath(dirs.backups, url.searchParams.get('file') ?? '');
      if (!f) throw new HttpError(404, 'NOT_FOUND');
      res.writeHead(200, { ...sec(), 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="${url.searchParams.get('file')}"` });
      createReadStream(f).pipe(res);
    },
    'POST /api/restore': async (req) => {
      httpAuth(req, 'settings');
      const b = await readJson(req);
      if (b.confirm !== 'RESTORE') throw new HttpError(400, 'CONFIRM', 'Type RESTORE to confirm');
      const f = backupPath(dirs.backups, b.file);
      if (!f) throw new HttpError(404, 'NOT_FOUND', 'backup not found');
      return restore(f);
    },
  };

  /** Replace the live DB with a backup; every client resyncs from a snapshot. @param {string} file */
  function restore(file) {
    const v = validateBackup(file);
    if (!v.ok) throw new HttpError(400, 'BAD_BACKUP');
    const staged = join(dataDir, 'restore-staged.sqlite');
    copyFileSync(file, staged);
    doBackup('pre-restore');
    closeWhere(() => true, 4010, 'restore');
    state.db.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    copyFileSync(staged, dbPath);
    rmSync(staged, { force: true });
    boot();
    putSetting(state.db, '_epoch', randomBytes(8).toString('hex')); // new epoch -> clients take a snapshot
    state.epoch = getPrivate(state.db, '_epoch');
    log('restored', file);
    return { ok: true, restored: file.split(sep).pop(), orders: v.orders };
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} path */
  function serveStatic(req, res, path) {
    let file;
    const img = /^\/img\/([0-9a-f]{40}\.(?:jpg|png|webp))$/.exec(path);
    if (img) file = join(dirs.images, img[1]);
    else {
      const rel = SPA.has(path) ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
      file = normalize(join(webDir, rel));
      if (!file.startsWith(webDir)) throw new HttpError(403, 'FORBIDDEN');
    }
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'NOT_FOUND');
    res.writeHead(200, { ...sec(), 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': img ? 'max-age=31536000, immutable' : 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? '';
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (!isAllowedSource(ip)) throw new HttpError(403, 'LAN_ONLY', 'Only LAN clients are allowed');
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'ORIGIN');
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const out = await route(req, res, url, ip);
        if (!res.headersSent) json(res, 200, out);
      } else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
      else throw new HttpError(404, 'NOT_FOUND');
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (!err.code) log('http error', req.method, url.pathname, err);
      if (!res.headersSent) json(res, err.status ?? (err.code ? 400 : 500), errBody(err));
    }
  });

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress ?? '';
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const originOk = !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
    if (path !== '/ws' || !isAllowedSource(ip) || !originOk) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  /** @param {import('ws').WebSocket} ws @param {string} ip */
  function onConnection(ws, ip) {
    const c = { ws, auth: /** @type {any} */ (null), alive: true, ip };
    clients.add(c);
    const helloTimer = setTimeout(() => { if (!c.auth) ws.close(4000, 'hello timeout'); }, 10_000);
    /** @param {any} m */
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => { clearTimeout(helloTimer); clients.delete(c); });
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      /** @type {any} */
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return send({ t: 'error', code: 'BAD_JSON' }); }
      if (msg.t === 'hello') {
        const a = auth.authenticate(state.db, msg.deviceToken, msg.sessionToken, now());
        if (!a) {
          const dev = auth.deviceFromToken(state.db, msg.deviceToken);
          return ws.close(dev ? 4003 : 4001, dev ? 'session' : 'device');
        }
        c.auth = a;
        clearTimeout(helloTimer);
        send({ t: 'welcome', user: { ...a.user, rights: [...a.user.rights] }, device: a.device, epoch: state.epoch, businessDate: businessDate(state.db, now()) });
        return sync(c, Number(msg.lastSeq) || 0, msg.epoch);
      }
      if (!c.auth) return ws.close(4003, 'session');
      if (msg.t === 'sync') return sync(c, Number(msg.since) || 0, msg.epoch);
      if (msg.t === 'ping') return send({ t: 'pong', ts: now() });
      if (msg.t === 'cmd') {
        try {
          const r = execCmd(c.auth, msg);
          send({ t: 'ack', opId: msg.opId, ...r });
        } catch (e) {
          const err = /** @type {any} */ (e);
          if (!err.code) log('cmd error', msg.type, err);
          send({ t: 'ack', opId: msg.opId, ...errBody(err) });
          if (err.code === 'SESSION') ws.close(4003, 'session');
        }
      }
    });
  }

  /** @param {any} c @param {number} since @param {string} [epoch] */
  function sync(c, since, epoch) {
    const max = Number(get(state.db, 'SELECT COALESCE(MAX(seq),0) AS s FROM events').s);
    const send = (/** @type {any} */ m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
    if (epoch !== state.epoch || since <= 0 || since > max || max - since > REPLAY_MAX) {
      send(buildSnapshot(state.db, { epoch: state.epoch, now: now() }));
    } else {
      for (const e of all(state.db, 'SELECT seq, changes FROM events WHERE seq>? ORDER BY seq', since)) {
        send({ t: 'evt', seq: e.seq, data: { changes: JSON.parse(e.changes) } });
      }
    }
    send({ t: 'synced', seq: max, epoch: state.epoch });
  }

  // ---- timers ----
  /** @type {Map<string, number>} */
  const unackSent = new Map();
  const timers = [
    setInterval(() => {            // keepalive: drop dead sockets
      for (const c of clients) {
        if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closed */ }
      }
    }, 20_000),
    setInterval(() => {            // unacknowledged KOT > 2 min -> alert managers/billers
      const t = now();
      for (const k of all(state.db, "SELECT k.id, k.no, k.created_at, o.table_id FROM kots k JOIN orders o ON o.id=k.order_id WHERE k.status='new' AND k.created_at < ?", t - UNACK_MS)) {
        const last = unackSent.get(k.id) ?? 0;
        if (t - last < UNACK_MS) continue;
        unackSent.set(k.id, t);
        broadcast({ t: 'alert', kind: 'kot_unack', kotId: k.id, no: k.no, ageMin: Math.floor((t - k.created_at) / 60000) }, (c) => can(c.auth.user, 'bill') || can(c.auth.user, 'approve'));
      }
    }, 15_000),
    setInterval(() => {            // nightly backup after 03:00 if none today
      const d = new Date(now());
      if (d.getHours() < 3) return;
      const name = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.sqlite`;
      if (!existsSync(join(dirs.backups, name))) {
        try { doBackup(); } catch (e) { log('nightly backup failed', e); }
      }
    }, 10 * 60_000),
  ];

  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, () => res(undefined)); });
  const actualPort = /** @type {any} */ (server.address()).port;
  log(`KhanaKhajana POS ${VERSION} on http://127.0.0.1:${actualPort} (node ${process.version}, data ${dataDir})`);

  return {
    port: actualPort,
    get db() { return state.db; },
    get epoch() { return state.epoch; },
    clients,
    queue,
    restore,
    async close() {
      for (const t of timers) clearInterval(t);
      queue.stop();
      for (const c of clients) c.ws.terminate();
      wss.close();
      await new Promise((r) => server.close(() => r(undefined)));
      server.closeAllConnections?.();
      state.db.close();
    },
  };
}

// ---- CLI entry ----
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const srv = await startServer();
  const ips = lanIps();
  for (const ip of ips) console.log(`  LAN: http://${ip}:${srv.port}  (join page: http://${ip}:${srv.port}/join)`);
  if (ips[0] && process.stdout.isTTY) console.log(qrTerminal(`http://${ips[0]}:${srv.port}/join`));
  const stop = async () => { await srv.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
