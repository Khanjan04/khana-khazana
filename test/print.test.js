// @ts-check
// Day 18: escpos (init, align, bold, double, cut, 32/48 cols); LAN printer Buffer -> ip:9100, timeout, retry queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EscPos, ascii, colsFor } from '../server/print/escpos.js';
import { PrintQueue, sendRaw } from '../server/print/lan.js';
import { renderKot, renderBill } from '../server/print/render.js';
import { setup, seedMenu } from './helpers.js';

test('escpos bytes: init, align, bold, double, cut', () => {
  const b = new EscPos(32).align('center').bold(true).double(true).line('KOT 1').double(false).cut().toBuffer();
  assert.deepEqual([...b.subarray(0, 2)], [0x1b, 0x40]);
  assert.ok(b.includes(Buffer.from([0x1b, 0x61, 1])));
  assert.ok(b.includes(Buffer.from([0x1b, 0x45, 1])));
  assert.ok(b.includes(Buffer.from([0x1d, 0x21, 0x11])));
  assert.deepEqual([...b.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
  assert.equal(colsFor(58), 32);
  assert.equal(colsFor(80), 48);
});

test('lr() pads to exactly the column width; ascii() makes ₹ printable', () => {
  const p = new EscPos(32);
  const start = p.bytes.length;
  p.lr('Subtotal', 'Rs.309.00');
  const line = Buffer.from(p.bytes.slice(start)).toString('latin1');
  assert.equal(line, 'Subtotal' + ' '.repeat(32 - 8 - 9) + 'Rs.309.00\n');
  assert.equal(ascii('₹ 10 – café'), 'Rs. 10 - cafe');
});

test('KOT and bill render within 32 and 48 columns', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.tikka, qty: 2, variant: 'Full', extras: ['Cheese'], note: 'no onion' }] });
  const b = t.cmd('biller', 'bill.print', { orderId: r.orderId });
  for (const cols of [32, 48]) {
    for (const buf of [renderKot(t.db, r.kots[0].id, { cols }), renderBill(t.db, b.billId, { cols })]) {
      const text = buf.toString('latin1').replace(/[\x00-\x09\x0b-\x1f][\x00-\xff]{0,3}/g, '');
      for (const ln of text.split('\n')) assert.ok(ln.length <= cols, `${cols}: "${ln}" (${ln.length})`);
    }
  }
  const kot = renderKot(t.db, r.kots[0].id).toString('latin1');
  assert.match(kot, /KOT 1/);
  assert.match(kot, />> no onion/);
  assert.match(renderBill(t.db, b.billId).toString('latin1'), /KK1\/26-27\/000001/);
});

/** Fake ESC/POS printer: collects bytes. */
function fakePrinter() {
  /** @type {Buffer[]} */
  const got = [];
  const srv = net.createServer((s) => { const parts = /** @type {Buffer[]} */ ([]); s.on('data', (d) => parts.push(d)); s.on('end', () => got.push(Buffer.concat(parts))); });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, got, port: /** @type {any} */ (srv.address()).port })));
}

test('LAN: bytes arrive at ip:port', async () => {
  const { srv, got, port } = /** @type {any} */ (await fakePrinter());
  await sendRaw('127.0.0.1', port, Buffer.from('hello'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got[0].toString(), 'hello');
  srv.close();
});

test('LAN: unreachable printer times out / fails and retries, then succeeds when it comes back', async () => {
  // grab a free port, close it, so the first attempts fail with ECONNREFUSED
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (tmp.address()).port;
  await new Promise((r) => tmp.close(() => r(undefined)));
  /** @type {any[]} */
  const statuses = [];
  const q = new PrintQueue({ retries: 5, retryMs: 60, timeout: 300, onStatus: (j) => statuses.push(j.status) });
  const job = q.enqueue({ label: 'KOT 1', ip: '127.0.0.1', port, buf: Buffer.from('kot') });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(job.status, 'queued');
  assert.ok(job.tries >= 1 && job.error);
  /** @type {Buffer[]} */
  const got = [];
  const srv = net.createServer((s) => { s.on('data', (d) => got.push(d)); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', () => r(undefined)));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(job.status, 'sent');
  assert.equal(Buffer.concat(got).toString(), 'kot');
  assert.deepEqual(statuses, ['sent']);
  q.stop(); srv.close();
});

test('LAN: gives up after retries -> failed; manual retry re-queues', async () => {
  const q = new PrintQueue({ retries: 1, retryMs: 20, timeout: 100 });
  const job = q.enqueue({ label: 'Bill', ip: '127.0.0.1', port: 1, buf: Buffer.from('x') });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(job.status, 'failed');
  assert.equal(q.retry(job.id)?.status, 'queued');
  assert.equal(q.list()[0].bytes, 1);
  q.stop();
});
