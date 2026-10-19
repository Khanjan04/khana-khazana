// @ts-check
// Integration over real HTTP + WebSocket on a random port (Days 1, 3, 10, 19):
// /health; setup -> pair -> login; hello/cmd/ack/evt/sync/synced; snapshot on epoch change;
// kill server mid-send -> restart -> no lost/duplicate KOT; revoked device disconnected < 1 s;
// static hardening; restore.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/server.js';
import { isAllowedSource } from '../server/ip.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let srv;
let dir = '';
let base = '';
/** @type {{deviceToken: string, sessionToken: string}} */
let owner;

/** @param {string} path @param {{body?: any, headers?: Record<string,string>, method?: string}} [o] */
async function http(path, o = {}) {
  const r = await fetch(base + path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}
/** @param {{deviceToken: string, sessionToken?: string}} a */
const hdr = (a) => ({ 'x-device-token': a.deviceToken, 'x-session-token': a.sessionToken ?? '' });

/** Minimal protocol client. */
class Client {
  /** @param {{deviceToken: string, sessionToken: string}} auth @param {{lastSeq?: number, epoch?: string}} [o] */
  constructor(auth, o = {}) {
    this.auth = auth;
    /** @type {any[]} */
    this.msgs = [];
    this.lastSeq = o.lastSeq ?? 0;
    this.closeCode = 0;
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', ...auth, lastSeq: this.lastSeq, epoch: o.epoch })));
      this.ws.on('error', rej);
      this.ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        this.msgs.push(m);
        if (m.t === 'evt' || m.t === 'snapshot') this.lastSeq = Math.max(this.lastSeq, m.seq);
        if (m.t === 'synced') res(this);
      });
      this.ws.on('close', (code) => { this.closeCode = code; res(this); });
    });
  }
  /** @param {(m: any) => boolean} pred @param {number} [ms] */
  async waitFor(pred, ms = 2000) {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for message; got ' + JSON.stringify(this.msgs.map((x) => x.t)));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** @param {string} type @param {any} payload @param {string} [opId] */
  async cmd(type, payload, opId = randomUUID()) {
    this.ws.send(JSON.stringify({ t: 'cmd', opId, type, payload }));
    return this.waitFor((m) => m.t === 'ack' && m.opId === opId);
  }
  close() { this.ws.close(); }
}

/** Pair + login a new staff phone as the given seeded user. @param {string} userId @param {string} pin */
async function newPhone(userId, pin) {
  const c = new Client(owner);
  await c.ready;
  const code = (await c.cmd('pair.create', { kind: 'staff' })).result.code;
  c.close();
  const d = (await http('/api/pair/claim', { body: { code, name: 'Captain phone' } })).json;
  const s = (await http('/api/login', { body: { userId, pin }, headers: hdr(d) })).json;
  return { deviceToken: d.deviceToken, sessionToken: s.sessionToken, deviceId: d.deviceId };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kksrv-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test('/health reports ok, seq, node, uptime', async () => {
  const r = await http('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.seq, 'number');
  assert.equal(r.json.node, process.version);
  assert.ok(r.json.uptime >= 0);
});

test('first-run setup from loopback, then login flow', async () => {
  assert.equal((await http('/api/info')).json.needsSetup, true);
  const r = await http('/api/setup', { body: { ownerName: 'Papa', pin: '1234', restaurantName: 'Khana Khajana' } });
  assert.equal(r.status, 200, r.text);
  owner = { deviceToken: r.json.deviceToken, sessionToken: r.json.sessionToken };
  assert.equal((await http('/api/setup', { body: { ownerName: 'X', pin: '1234' } })).json.error.code, 'ALREADY_SETUP');
  const users = (await http('/api/users', { headers: hdr(owner) })).json.users;
  // only the Owner registers; Manager, Captain and Kitchen logins are created by default
  assert.deepEqual(users.map((/** @type {any} */ u) => `${u.name}:${u.roleId}`).sort(), ['Captain:captain', 'Kitchen:kitchen', 'Manager:manager', 'Papa:owner']);
  const cap = users.find((/** @type {any} */ u) => u.name === 'Captain');
  assert.ok((await http('/api/login', { body: { userId: cap.id, pin: '1111' }, headers: hdr(owner) })).json.sessionToken);
  assert.equal((await http('/api/users')).status, 401);
  const bad = await http('/api/login', { body: { userId: users.find((/** @type {any} */ u) => u.name === 'Papa').id, pin: '0000' }, headers: hdr(owner) });
  assert.equal(bad.json.error.code, 'BAD_LOGIN');
});

test('static hardening: CSP, no data/ dir, no traversal, SPA routes', async () => {
  const idx = await http('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(idx.headers.get('access-control-allow-origin'), null);
  assert.equal((await http('/join')).status, 200);
  assert.equal((await http('/data/pos.sqlite')).status, 404);
  assert.notEqual((await http('/%2e%2e/server/server.js')).status, 200);
  assert.notEqual((await http('/../package.json')).status, 200);
  assert.equal((await http('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await http('/api/cmd', { body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
});

test('source IP filter allows only LAN/loopback', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:192.168.1.9', '10.1.2.3', '172.20.0.1', 'fe80::1', 'fd12::1']) assert.ok(isAllowedSource(ok), ok);
  for (const no of ['8.8.8.8', '::ffff:1.1.1.1', '172.32.0.1', '2001:db8::1', '', undefined]) assert.ok(!isAllowedSource(no), String(no));
});

test('WS: hello -> welcome + snapshot + synced; cmd -> ack + evt to every client; reconnect replays only the gap', async () => {
  const a = new Client(owner);
  await a.ready;
  const welcome = await a.waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.user.roleId, 'owner');
  assert.ok(a.msgs.find((m) => m.t === 'snapshot'));
  const g = (await a.cmd('menu.group.save', { name: 'Main' })).result.id;
  const s = (await a.cmd('layout.section.save', { name: 'Hall' })).result.id;
  const tbl = (await a.cmd('layout.table.save', { sectionId: s, name: '1' })).result.id;
  const item = (await a.cmd('menu.item.save', { name: 'Dal', pricePaise: 21900, groupId: g })).result.id;
  const epoch = welcome.epoch;
  const seqBefore = a.lastSeq;

  const b = new Client(owner, { lastSeq: seqBefore, epoch });
  await b.ready;
  assert.equal(b.msgs.filter((m) => m.t === 'snapshot').length, 0, 'tail replay, not snapshot');
  const ack = await a.cmd('kot.create', { tableId: tbl, lines: [{ itemId: item, qty: 2 }] });
  assert.equal(ack.ok, true);
  const evt = await b.waitFor((m) => m.t === 'evt' && m.seq === ack.seq);
  assert.ok(evt.data.changes.some((/** @type {any} */ c) => c.entity === 'kots'));
  b.close();

  // offline: two more events, then reconnect from the old seq -> exactly those two replayed in order
  const s1 = (await a.cmd('order.persons', { orderId: ack.result.orderId, persons: 2 })).seq;
  const s2 = (await a.cmd('order.comment', { orderId: ack.result.orderId, comment: 'hi' })).seq;
  const c = new Client(owner, { lastSeq: ack.seq, epoch });
  await c.ready;
  assert.deepEqual(c.msgs.filter((m) => m.t === 'evt').map((m) => m.seq), [s1, s2]);
  assert.equal(c.msgs.at(-1).t, 'synced');

  // wrong epoch (e.g. host restored a backup) -> snapshot
  const d = new Client(owner, { lastSeq: s2, epoch: 'other' });
  await d.ready;
  assert.ok(d.msgs.find((m) => m.t === 'snapshot'));

  // errors come back as nack with a code
  const nack = await a.cmd('kot.status', { kotId: ack.result.kots[0].id, to: 'served' });
  assert.deepEqual([nack.ok, nack.error.code], [false, 'BAD_TRANSITION']);
  for (const x of [a, c, d]) x.close();
});

test('kill server mid-send -> restart -> outbox replay: no lost or duplicate KOT', async () => {
  const a = new Client(owner);
  await a.ready;
  const snap = a.msgs.find((m) => m.t === 'snapshot');
  const tbl = snap.data.entities.dining_tables[0].id;
  const item = snap.data.entities.items[0].id;
  const before = (await http('/api/reports/day', { headers: hdr(owner) })).json.kots.new ?? 0;
  // "outbox": five KOT commands; the server dies after receiving them, before (some) acks
  const outbox = Array.from({ length: 5 }, () => ({ t: 'cmd', opId: randomUUID(), type: 'kot.create', payload: { tableId: tbl, lines: [{ itemId: item, qty: 1 }] } }));
  for (const c of outbox.slice(0, 3)) a.ws.send(JSON.stringify(c));
  await a.waitFor((m) => m.t === 'ack' && m.opId === outbox[2].opId);
  await srv.close();                                   // host killed; client still holds all 5 in its outbox
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
  const b = new Client(owner, { lastSeq: a.lastSeq, epoch: srv.epoch });
  await b.ready;
  for (const c of outbox) b.ws.send(JSON.stringify(c)); // replay the WHOLE outbox after 'synced'
  for (const c of outbox) await b.waitFor((m) => m.t === 'ack' && m.opId === c.opId);
  const after = (await http('/api/reports/day', { headers: hdr(owner) })).json.kots.new;
  assert.equal(after - before, 5);
  const health = (await http('/health')).json;
  assert.ok(health.restarts >= 1);
  b.close();
});

test('revoked device is disconnected in < 1 s and cannot reconnect', async () => {
  const usersRes = (await http('/api/users', { headers: hdr(owner) })).json.users;
  const ownerId = usersRes.find((/** @type {any} */ u) => u.roleId === 'owner').id;
  const phone = await newPhone(ownerId, '1234');
  const c = new Client(phone);
  await c.ready;
  assert.equal(c.closeCode, 0);
  const admin = new Client(owner);
  await admin.ready;
  const t0 = Date.now();
  await admin.cmd('device.revoke', { deviceId: phone.deviceId });
  while (!c.closeCode && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.closeCode, 4001);
  assert.ok(Date.now() - t0 < 1000);
  const again = new Client(phone);
  await again.ready;
  assert.equal(again.closeCode, 4001);
  admin.close();
});

test('HTTP: print render for RawBT, CSV export, rights enforced', async () => {
  const a = new Client(owner);
  await a.ready;
  const snap = a.msgs.find((m) => m.t === 'snapshot');
  const kot = snap.data.entities.kots[0];
  const r = await http(`/api/print/render?kind=kot&id=${kot.id}`, { headers: hdr(owner) });
  assert.ok(Buffer.from(r.json.b64, 'base64').subarray(0, 2).equals(Buffer.from([0x1b, 0x40])));
  assert.equal((await http(`/api/print/render?kind=kot&id=${kot.id}`)).status, 401);
  const csv = await http('/api/export/csv', { headers: hdr(owner) });
  assert.match(csv.text, /^bill_no,/);
  a.close();
});

test('backup + restore over HTTP: data reverts, clients told to resync (4010)', async () => {
  const a = new Client(owner);
  await a.ready;
  const g = (await a.cmd('menu.group.save', { name: 'Before backup' })).result.id;
  const bk = (await http('/api/backups', { method: 'POST', headers: hdr(owner) })).json;
  assert.match(bk.file, /^\d{8}-manual\.sqlite$/);
  await a.cmd('menu.group.save', { name: 'After backup' });
  assert.equal((await http('/api/restore', { body: { file: bk.file, confirm: 'nope' }, headers: hdr(owner) })).status, 400);
  const r = await http('/api/restore', { body: { file: bk.file, confirm: 'RESTORE' }, headers: hdr(owner) });
  assert.equal(r.status, 200, r.text);
  await a.ready;
  const t0 = Date.now();
  while (!a.closeCode && Date.now() - t0 < 1000) await new Promise((res) => setTimeout(res, 5));
  assert.equal(a.closeCode, 4010);
  const b = new Client(owner, { lastSeq: a.lastSeq, epoch: 'old' });
  await b.ready;
  const groups = b.msgs.find((m) => m.t === 'snapshot').data.entities.menu_groups.map((/** @type {any} */ x) => x.name);
  assert.ok(groups.includes('Before backup') && !groups.includes('After backup'));
  assert.ok(groups.length >= 2 && g);
  b.close();
});

test('HTTP import from the old billing app: settings right, every bill copied, phones resync', async () => {
  const raw = readFileSync(new URL('./golden/backup_v13.json', import.meta.url));
  const post = (/** @type {Record<string, string>} */ h) => fetch(base + '/api/import/legacy', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: raw });
  assert.equal((await post({})).status, 401);
  const r = await post(hdr(owner));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.imported.bills, 77);
  assert.equal(j.equal, true);
  assert.equal((await (await post(hdr(owner))).json()).skipped, true); // same file twice: no duplicates
});
