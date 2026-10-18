// @ts-check
// Day 5 soak: N simulated captains send random KOTs and randomly drop their connection for
// M minutes, replaying their outbox exactly like web/net.js. Then assert:
//   unique KOT numbers per day, contiguous event seq, each opId applied once, nothing lost.
//
//   node scripts/soak.js --captains 3 --minutes 30
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../server/server.js';
import { all, get } from '../server/db.js';

/** @param {{captains?: number, ms?: number, log?: (s: string) => void}} o */
export async function runSoak(o = {}) {
  const captains = o.captains ?? 3, ms = o.ms ?? 15_000, log = o.log ?? (() => {});
  const dir = mkdtempSync(join(tmpdir(), 'kksoak-'));
  let srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  const base = () => `http://127.0.0.1:${srv.port}`;
  /** @param {string} p @param {any} body @param {Record<string,string>} [h] */
  const post = async (p, body, h = {}) => (await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) })).json();

  // setup: owner, layout, menu, N captain phones
  const own = await post('/api/setup', { ownerName: 'Owner', pin: '1234' });
  const ownerAuth = { 'x-device-token': own.deviceToken, 'x-session-token': own.sessionToken };
  /** @param {string} type @param {any} payload */
  const cmd = async (type, payload) => { const r = await post('/api/cmd', { opId: randomUUID(), type, payload }, ownerAuth); if (!r.ok) throw new Error(type + ' ' + JSON.stringify(r)); return r.result; };
  const g = (await cmd('menu.group.save', { name: 'Main' })).id;
  const sec = (await cmd('layout.section.save', { name: 'Hall' })).id;
  const tables = [];
  for (let i = 1; i <= 12; i++) tables.push((await cmd('layout.table.save', { sectionId: sec, name: String(i) })).id);
  const items = [];
  for (const [n, p, st] of /** @type {[string, number, string][]} */ ([['Dal', 21900, 'kitchen'], ['Naan', 4500, 'kitchen'], ['Lassi', 6900, 'bar']])) items.push((await cmd('menu.item.save', { name: n, pricePaise: p, groupId: g, station: st })).id);
  const phones = [];
  for (let i = 0; i < captains; i++) {
    const uid = (await cmd('user.save', { name: 'Captain ' + i, roleId: 'captain', pin: '1111' })).id;
    const { code } = await cmd('pair.create', { kind: 'staff' });
    const d = await post('/api/pair/claim', { code, name: 'phone ' + i });
    const s = await post('/api/login', { userId: uid, pin: '1111' }, { 'x-device-token': d.deviceToken });
    phones.push({ deviceToken: d.deviceToken, sessionToken: s.sessionToken });
  }

  /** @type {Set<string>} */
  const sentOps = new Set();
  /** @type {Set<string>} */
  const acked = new Set();
  let stop = false, disconnects = 0, restarts = 0;
  const end = Date.now() + ms;

  /** One simulated captain with a persistent outbox. @param {{deviceToken: string, sessionToken: string}} auth @param {number} idx */
  async function captain(auth, idx) {
    /** @type {Map<string, any>} */
    const outbox = new Map();
    let lastSeq = 0;
    while (!stop) {
      const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
      let synced = false;
      const closed = new Promise((res) => { ws.on('close', res); ws.on('error', () => res(undefined)); });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ...auth, lastSeq })));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.t === 'evt' || m.t === 'snapshot') lastSeq = Math.max(lastSeq, m.seq);
        if (m.t === 'synced') { synced = true; for (const c of outbox.values()) ws.send(JSON.stringify(c)); }
        if (m.t === 'ack') {
          if (!m.ok) throw new Error('nack ' + JSON.stringify(m));
          outbox.delete(m.opId); acked.add(m.opId);
        }
      });
      const life = Date.now() + 300 + Math.random() * 2500;
      while (!stop && Date.now() < life && ws.readyState <= 1) {
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 120));
        if (Date.now() > end) break;
        const c = { t: 'cmd', opId: randomUUID(), type: 'kot.create', payload: { tableId: tables[(idx * 4 + Math.floor(Math.random() * 4)) % tables.length], lines: [{ itemId: items[Math.floor(Math.random() * items.length)], qty: 1 + Math.floor(Math.random() * 3) }] } };
        outbox.set(c.opId, c); sentOps.add(c.opId);
        if (synced && ws.readyState === 1) ws.send(JSON.stringify(c));
      }
      if (Date.now() > end && outbox.size === 0) { ws.close(); await closed; break; }
      if (Date.now() <= end) { disconnects++; ws.terminate(); }   // airplane mode mid-order
      else { await new Promise((r) => setTimeout(r, 200)); ws.close(); }
      await closed;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 300));
    }
  }

  const killer = (async () => {           // restart the host a couple of times (Termux killed)
    while (Date.now() < end - 2000) {
      await new Promise((r) => setTimeout(r, ms / 3));
      if (Date.now() >= end - 2000) break;
      const port = srv.port;
      await srv.close();
      srv = await startServer({ port, host: '127.0.0.1', dataDir: dir, quiet: true });
      restarts++;
    }
  })();
  const runners = phones.map((p, i) => captain(p, i));
  await killer;
  const deadline = Date.now() + ms + 20_000;
  await Promise.race([Promise.all(runners), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
  stop = true;

  const db = srv.db;
  const kotOps = get(db, "SELECT COUNT(*) AS n FROM ops WHERE type='kot.create'").n;
  const kotsFromCaptains = get(db, "SELECT COUNT(DISTINCT o.op_id) AS n FROM ops o WHERE o.type='kot.create'").n;
  const dupNos = all(db, 'SELECT business_date, no, COUNT(*) AS c FROM kots GROUP BY business_date, no HAVING c > 1');
  const seqs = all(db, 'SELECT seq FROM events ORDER BY seq').map((r) => r.seq);
  const gaps = seqs.filter((s, i) => i > 0 && s !== seqs[i - 1] + 1).length;
  const kotOrders = get(db, 'SELECT COUNT(DISTINCT order_id) AS n FROM kots').n;
  const report = {
    captains, seconds: Math.round(ms / 1000), sent: sentOps.size, acked: acked.size, applied: kotOps, distinctOps: kotsFromCaptains,
    kots: get(db, 'SELECT COUNT(*) AS n FROM kots').n, kotOrders, duplicateKotNumbers: dupNos.length, seqGaps: gaps, disconnects, restarts,
  };
  log(JSON.stringify(report));
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  const failures = [];
  if (report.acked !== report.sent) failures.push(`lost: sent ${report.sent}, acked ${report.acked}`);
  if (report.applied !== report.sent) failures.push(`applied ${report.applied} ≠ sent ${report.sent}`);
  if (report.duplicateKotNumbers) failures.push('duplicate KOT numbers');
  if (report.seqGaps) failures.push('seq gaps');
  return { report, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (/** @type {string} */ k, /** @type {number} */ d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const { report, failures } = await runSoak({ captains: arg('captains', 3), ms: arg('minutes', 1) * 60_000, log: console.log });
  if (failures.length) { console.error('SOAK FAILED:', failures.join('; ')); process.exit(1); }
  console.log(`SOAK OK: ${report.sent} KOTs from ${report.captains} captains, ${report.disconnects} disconnects, ${report.restarts} host restarts, 0 lost / 0 duplicate`);
}
