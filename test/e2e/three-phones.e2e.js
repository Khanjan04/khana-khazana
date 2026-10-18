// @ts-check
// Browser E2E with 3 Chrome contexts = 3 phones (laptop only; needs Playwright):
//   host/owner (setup, menu, pairing, billing) · captain (order + Send KOT) · kitchen screen (KDS).
// Run:  npm i -D playwright   (once)   then   npm run test:e2e
// Exit: KOT round-trip captain -> kitchen -> "ready" toast on captain; bill printed + settled; no page errors.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../server/server.js';

const dir = mkdtempSync(join(tmpdir(), 'kke2e-'));
let srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
/** @type {string[]} */
const errors = [];
const step = (/** @type {string} */ s) => console.log('  •', s);
/** Optional screenshots: SHOTS=<dir> npm run test:e2e @param {any} page @param {string} name */
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, name + '.png'), fullPage: true }); };

/** @param {string} name */
async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return page;
}

try {
  // ---------- host phone: first-run setup ----------
  const host = await phone('host');
  await host.goto(base + '/');
  await host.getByText('Welcome — set up this host').waitFor();
  step('setup screen');
  await host.fill('#setup-restaurantName', 'Khana Khajana');
  await host.fill('#setup-ownerName', 'Papa');
  await host.fill('#setup-pin', '1234');
  await host.fill('#setup-pin2', '1234');
  await host.getByRole('button', { name: 'Create owner' }).click();
  await host.getByText('Owner recovery code').waitFor();
  await host.getByRole('button', { name: /I wrote it down/ }).click();
  await host.getByRole('button', { name: '+ Group' }).waitFor();
  step('owner logged in, admin open');

  // seed menu/layout/users through the API with the host's own tokens (UI CRUD is exercised below)
  const tokens = await host.evaluate(() => ({ d: JSON.parse(localStorage.getItem('pos.device') || '{}').deviceToken, s: JSON.parse(localStorage.getItem('pos.session') || '{}').sessionToken }));
  let n = 0;
  /** @param {string} type @param {any} payload */
  const cmd = async (type, payload) => {
    const r = await (await fetch(base + '/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': tokens.d, 'x-session-token': tokens.s }, body: JSON.stringify({ opId: 'e2e-' + n++, type, payload }) })).json();
    assert.ok(r.ok, type + ' ' + JSON.stringify(r));
    return r.result;
  };
  const sec = (await cmd('layout.section.save', { name: 'Hall' })).id;
  for (const t of ['1', '2', '3']) await cmd('layout.table.save', { sectionId: sec, name: t });
  await cmd('user.save', { name: 'Amit', roleId: 'captain', pin: '4567' });
  await cmd('user.save', { name: 'Chef', roleId: 'kitchen', pin: '5678' });

  // UI CRUD: add a group and an item from the admin screen
  await host.getByRole('button', { name: '+ Group' }).click();
  await host.locator('.modal input').first().fill('Main course');
  await host.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await host.getByRole('button', { name: '+ Item' }).click();
  const modalInputs = host.locator('.modal input');
  await modalInputs.nth(0).fill('Dal Makhani');
  await modalInputs.nth(1).fill('10');
  await modalInputs.nth(2).fill('219');
  await host.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await host.getByText('Dal Makhani').waitFor();
  const g = (await (await fetch(base + '/api/export/json', { headers: { 'x-device-token': tokens.d, 'x-session-token': tokens.s } })).json()).tables.menu_groups[0].id;
  await cmd('menu.item.save', { name: 'Butter Naan', code: '20', pricePaise: 4500, groupId: g, favourite: true });
  step('menu created via UI + API');

  // ---------- pairing two phones from Admin → Devices ----------
  /** @param {string} which */
  async function pairCode(which) {
    await host.goto(base + '/#/admin');
    await host.getByRole('button', { name: 'Devices' }).click();
    await host.getByRole('button', { name: which }).click();
    const code = (await host.locator('.modal .code-big').textContent())?.trim() ?? '';
    await host.locator('.modal').getByRole('button', { name: 'Close' }).click();
    assert.match(code, /^\d{6}$/);
    return code;
  }
  /** @param {any} page @param {string} code @param {string} kind @param {string} user @param {string} pin */
  async function pairAndLogin(page, code, kind, user, pin) {
    await page.goto(`${base}/pair?code=${code}${kind === 'kds' ? '&kind=kds' : ''}`);
    await page.getByRole('heading', { name: 'Pair this phone' }).waitFor();
    await page.fill('#pair-name', kind === 'kds' ? 'Kitchen' : 'Captain 1');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByText('Who is working?').waitFor();
    await page.getByRole('button', { name: new RegExp('^' + user) }).click();
    for (const d of pin) await page.locator('.keys button', { hasText: new RegExp('^' + d + '$') }).click();
    await page.locator('.keys button', { hasText: 'OK' }).click();
  }
  const captain = await phone('captain');
  await pairAndLogin(captain, await pairCode('+ Staff phone'), 'staff', 'Amit', '4567');
  await captain.locator('button.table', { hasText: '1' }).first().waitFor();
  await shot(captain, '1-captain-tables');
  step('captain paired + logged in, tables visible');

  const kds = await phone('kds');
  await pairAndLogin(kds, await pairCode('+ Kitchen screen'), 'kds', 'Chef', '5678');
  await kds.getByRole('button', { name: 'Start shift' }).click();
  await kds.getByRole('heading', { name: /New/ }).waitFor();
  step('kitchen screen paired, shift started');

  // ---------- captain: order by tap + short code, Send KOT ----------
  await captain.locator('button.table', { hasText: '1' }).first().click();
  await captain.getByText('Table 1 (new)').waitFor();
  await captain.locator('button.item', { hasText: 'Butter Naan' }).click();                 // favourites tab
  await captain.fill('#order-search', '2*10');                                              // short code: 2 × Dal
  await captain.press('#order-search', 'Enter');
  await captain.getByText('Not sent yet').waitFor();
  await shot(captain, '2-captain-order');
  const t0 = Date.now();
  await captain.getByRole('button', { name: /Send KOT \(3\)/ }).click();
  await captain.getByText(/KOT 1 sent/).waitFor();
  step('captain sent KOT 1 (1 naan + 2 dal)');

  // ---------- kitchen: card appears, accept -> preparing -> ready ----------
  const card = kds.locator('.kot-card', { hasText: '#1' });
  await card.waitFor({ timeout: 3000 });
  const latency = Date.now() - t0;
  step(`KOT on kitchen screen after ${latency} ms`);
  assert.ok(latency < 3000);
  await card.getByText('2 ×').waitFor();
  await kds.setViewportSize({ width: 1100, height: 700 });
  await shot(kds, '3-kitchen-screen');
  await card.getByRole('button', { name: 'Accept' }).click();
  await kds.locator('.kds-col.accepted .kot-card').waitFor();
  await kds.locator('.kds-col.accepted .kot-card').getByRole('button', { name: 'Preparing' }).click();
  await kds.locator('.kds-col.preparing .kot-card').getByRole('button', { name: 'Ready' }).click();
  await captain.getByText(/KOT 1 READY/).waitFor({ timeout: 3000 });
  step('captain got READY toast');
  await captain.getByRole('button', { name: 'Served' }).click();
  await captain.locator('.tag.served').first().waitFor();

  // ---------- host: bill + settle ----------
  await host.goto(base + '/#/bills');
  await host.locator('tr.click', { hasText: 'Table 1' }).click();
  await host.getByText('Subtotal (before tax)').waitFor();
  await host.evaluate(() => { window.print = () => {}; });                                  // headless: no dialog
  await host.getByRole('button', { name: 'Print bill' }).click();
  await host.getByText(/Bill KK1\/\d\d-\d\d\/000001/).waitFor();
  await host.getByText('Tax Invoice').waitFor();
  await shot(host, '4-bill-settle');
  await host.getByRole('button', { name: 'Fill rest' }).click();
  await host.getByRole('button', { name: 'Settle', exact: true }).click();
  await host.getByText('Settled').first().waitFor();
  step('bill KK1/…/000001 printed (browser mode) and settled');

  // table is free again on the captain phone
  await captain.goto(base + '/#/tables');
  await captain.locator('button.table.free', { hasText: '1' }).first().waitFor();

  // ---------- host dies; captain sends a KOT offline; host restarts -> KOT arrives once ----------
  const port = srv.port;
  await srv.close();
  await captain.locator('.dot.offline').waitFor({ timeout: 5000 });
  await captain.locator('button.table', { hasText: '2' }).first().click();
  await captain.locator('button.item', { hasText: 'Butter Naan' }).click();
  await captain.getByRole('button', { name: /Send KOT \(1\)/ }).click();
  await captain.getByText(/Host offline — KOT queued/).waitFor();
  const queued = await captain.evaluate(() => JSON.parse(localStorage.getItem('pos.outbox') || '[]').length);
  assert.equal(queued, 1);
  step('host down: KOT queued in the captain outbox');
  srv = await startServer({ port, host: '127.0.0.1', dataDir: dir, quiet: true });
  await captain.getByText(/KOT 2 sent/).waitFor({ timeout: 15000 });
  await kds.locator('.kot-card', { hasText: '#2' }).waitFor({ timeout: 15000 });
  assert.equal(await captain.evaluate(() => JSON.parse(localStorage.getItem('pos.outbox') || '[]').length), 0);
  assert.equal(await kds.locator('.kot-card', { hasText: '#2' }).count(), 1);
  step('host back: queued KOT delivered exactly once to the kitchen');
  await host.reload();

  // ---------- reports + whoami ----------
  await host.goto(base + '/#/reports');
  await host.getByRole('cell', { name: 'TOTAL', exact: true }).waitFor();
  await shot(host, '5-reports');
  await captain.goto(base + '/#/whoami');
  await captain.getByText('isSecureContext').waitFor();
  step('reports + whoami render');

  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('E2E OK');
} catch (e) {
  console.error('E2E FAILED:', e);
  if (errors.length) console.error('page errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
}
