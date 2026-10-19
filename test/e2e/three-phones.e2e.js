// @ts-check
// Browser E2E with 3 Chrome contexts = 3 phones (laptop only; needs Playwright):
//   host/owner (setup with default staff + menu, admin, pairing, billing) · captain (order + KOT) · kitchen screen (KDS).
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
  // the test stops the host on purpose: Chrome logs the refused WebSocket reconnects, which are expected
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .* failed/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}

try {
  // ---------- host phone: first-run setup (Owner registers; default staff + KHANAKHAJANA menu) ----------
  const host = await phone('host');
  await host.goto(base + '/');
  await host.getByText('Welcome — set up this host').waitFor();
  step('setup screen');
  await host.fill('#setup-ownerName', 'Papa');
  await host.fill('#setup-pin', '1234');
  await host.fill('#setup-pin2', '1234');
  assert.ok(await host.locator('#setup-defaults').isChecked());
  await host.getByRole('button', { name: 'Create owner' }).click();
  await host.getByText('Owner recovery code').waitFor();
  await host.getByText('Staff logins created for you').waitFor();
  for (const [u, pin] of [['Manager', '2222'], ['Captain', '1111'], ['Kitchen', '3333']]) await host.locator('tr', { hasText: u }).getByText(pin).waitFor();
  await host.getByText(/Loaded 186 dishes and \d+ tables/).waitFor();
  await shot(host, '0-setup-done');
  await host.getByRole('button', { name: /I wrote it down/ }).click();
  await host.getByRole('button', { name: 'Bulk add dishes' }).waitFor();
  step('owner logged in; Manager/Captain/Kitchen created; legacy menu loaded');

  // ---------- admin UI: bulk add, extras, layout builder ----------
  await host.getByRole('button', { name: 'Bulk add dishes' }).click();
  await host.locator('.bulk textarea').fill('Test Thali 199\nTest Papad - 30');
  await host.getByText('2 dish(es) ready').waitFor();
  await host.getByRole('button', { name: 'Add all' }).click();
  await host.getByText('2 dishes added').waitFor();
  await host.getByRole('button', { name: 'Extras & notes' }).click();
  await host.getByRole('button', { name: '+ Extra' }).click();
  await host.locator('.modal input').nth(0).fill('Extra Butter');
  await host.locator('.modal input').nth(1).fill('30');
  await host.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await host.getByRole('cell', { name: 'Extra Butter' }).waitFor();
  await host.getByRole('button', { name: 'Layout', exact: true }).click();
  await host.getByRole('button', { name: 'Build tables' }).first().waitFor();
  await shot(host, '0b-admin-layout');
  step('admin: bulk add, extras, layout builder');

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
    if (kind !== 'kds') for (const u of ['Papa', 'Manager', 'Captain', 'Kitchen']) await page.locator('.user-grid button', { hasText: u }).first().waitFor();
    await page.getByRole('button', { name: new RegExp('^' + user) }).click();
    for (const d of pin) await page.locator('.keys button', { hasText: new RegExp('^' + d + '$') }).click();
    await page.locator('.keys button', { hasText: 'OK' }).click();
  }
  const captain = await phone('captain');
  await pairAndLogin(captain, await pairCode('+ Staff phone'), 'staff', 'Captain', '1111');
  await captain.getByText('Namaste, Captain').waitFor();
  await shot(captain, '1-captain-home');
  await captain.getByRole('button', { name: /Dining/ }).click();
  const tile = (/** @type {string} */ name) => captain.locator('.tbl', { has: captain.locator('.tn', { hasText: new RegExp('^' + name + '$') }) });
  await tile('AC1').waitFor();
  await shot(captain, '1b-captain-tables');
  step('captain (default user, PIN 1111) paired + logged in, table view visible');

  const kds = await phone('kds');
  await pairAndLogin(kds, await pairCode('+ Kitchen screen'), 'kds', 'Kitchen', '3333');
  await kds.getByRole('button', { name: 'Start shift' }).click();
  await kds.getByRole('heading', { name: /New/ }).waitFor();
  step('kitchen screen paired (default Kitchen user), shift started');

  // ---------- captain: tap, short code, search + variation/extra/note popup, KOT ----------
  await tile('AC1').click();
  await captain.getByRole('heading', { name: 'Table AC1' }).waitFor();
  await captain.locator('button.item', { hasText: 'Mango Lassi' }).click();                // Favorite Items
  await captain.fill('#order-sc', 'mch');                                                   // short code
  await captain.locator('.scl button.on', { hasText: 'Masala Chaas' }).waitFor();
  await captain.press('#order-sc', 'Enter');
  await captain.fill('#order-search', 'pav bhaji');
  await captain.locator('button.item', { hasText: 'Pav Bhaji' }).click();
  const pop = captain.locator('.modal');
  await pop.getByRole('button', { name: /Butter/ }).click();
  await pop.locator('.xtra', { hasText: 'Chutney - Red' }).getByRole('button', { name: '+' }).click();
  await pop.locator('select').selectOption('Less Spicy');
  await pop.getByRole('button', { name: 'Save' }).click();
  await captain.getByText('NEW KOT').waitFor();
  await captain.locator('.kot-group.draft .line').nth(2).getByText('Less Spicy').waitFor();
  await shot(captain, '2-captain-order');
  const t0 = Date.now();
  await captain.getByRole('button', { name: 'KOT (3)', exact: true }).click();
  await captain.getByText(/KOT 1 sent/).waitFor();
  step('captain sent KOT 1 (lassi + chaas + pav bhaji butter, extra, note)');

  // ---------- kitchen: card appears, accept -> preparing -> ready ----------
  const card = kds.locator('.kot-card', { hasText: '#1' });
  await card.waitFor({ timeout: 3000 });
  const latency = Date.now() - t0;
  step(`KOT on kitchen screen after ${latency} ms`);
  assert.ok(latency < 3000);
  await card.getByText('Sides: Chutney - Red - 1').waitFor();
  await kds.setViewportSize({ width: 1100, height: 700 });
  await shot(kds, '3-kitchen-screen');
  await card.getByRole('button', { name: 'Accept' }).click();
  await kds.locator('.kds-col.accepted .kot-card').waitFor();
  await kds.locator('.kds-col.accepted .kot-card').getByRole('button', { name: 'Preparing' }).click();
  await kds.locator('.kds-col.preparing .kot-card').getByRole('button', { name: 'Ready' }).click();
  await captain.getByText(/KOT 1 READY/).waitFor({ timeout: 3000 });
  step('captain got READY toast');
  await tile('AC1').click();
  await captain.getByRole('button', { name: 'Served' }).click();
  await captain.locator('.tag.served').first().waitFor();

  // ---------- host: bill (discount chip) + settle cash with change ----------
  await host.goto(base + '/#/bills');
  await host.locator('tr.click', { hasText: 'AC1' }).click();
  await host.getByRole('button', { name: 'Print Bill' }).waitFor();
  await host.evaluate(() => { window.print = () => {}; });                                  // headless: no dialog
  await host.getByRole('button', { name: '10%' }).click();
  // Pav Bhaji Butter 400 + Chutney 25 + Lassi 150 + Chaas 60 = 635; −10% = 571.50; taxes from the legacy settings
  await host.locator('.sumd .pr', { hasText: 'Discount' }).getByText('−₹63.50').waitFor();
  await host.getByRole('button', { name: 'Print Bill' }).click();
  await host.locator('.modal').getByRole('button', { name: 'Skip' }).click();               // "ask customer details" (legacy setting on)
  await host.getByText(/^Bill \S+: ₹/).waitFor();
  await host.locator('.preview').getByText('Pav Bhaji').waitFor();
  await shot(host, '4-bill-settle');
  await host.fill('#paid', '1000');
  await host.getByText('Return to customer').waitFor();
  await host.getByRole('button', { name: 'Settle & Save' }).click();
  await host.getByText(/Settled\. Return ₹/).waitFor();
  step('bill printed with 10% discount and settled in cash with change');

  // table is free again on the captain phone
  await captain.goto(base + '/#/tables');
  await captain.locator('.tbl.blank', { has: captain.locator('.tn', { hasText: /^AC1$/ }) }).waitFor();

  // ---------- host dies; captain sends a KOT offline; host restarts -> KOT arrives once ----------
  const port = srv.port;
  await srv.close();
  await captain.locator('.dot.offline').waitFor({ timeout: 5000 });
  await tile('AC2').click();
  await captain.locator('button.item', { hasText: 'Mango Lassi' }).click();
  await captain.getByRole('button', { name: 'KOT (1)', exact: true }).click();
  await captain.getByText(/Host offline — saved on this phone/).waitFor();
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
  await host.getByText('Total billing amount').waitFor();
  await host.getByText('✓ Matches').waitFor();
  await shot(host, '5-reports');
  await host.getByRole('button', { name: 'Most ordered' }).click();
  await host.getByRole('cell', { name: 'Pav Bhaji' }).waitFor();
  await captain.goto(base + '/#/whoami');
  await captain.getByText('isSecureContext').waitFor();
  step('reports + whoami render');

  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('E2E OK');
} catch (e) {
  console.error('E2E FAILED:', e);
  if (process.env.SHOTS) for (const pg of browser.contexts().flatMap((c) => c.pages())) await pg.screenshot({ path: join(process.env.SHOTS, 'fail-' + browser.contexts().indexOf(pg.context()) + '.png'), fullPage: true }).catch(() => {});
  if (errors.length) console.error('page errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await srv.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
