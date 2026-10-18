// @ts-check
// Day 8: run the LEGACY calcTotals (loaded from legacy/khanakhajana_v13.html via node:vm)
// over every order in test/golden/backup_v13.json and write test/golden/expected_totals.json.
// You run this ONCE and commit; afterwards test/golden/ is protected.
//
//   node scripts/make-golden.js                 # from the legacy HTML (the real arbiter)
//   node scripts/make-golden.js --bootstrap     # NO legacy file yet: uses the port itself
//                                               # (circular! only to keep CI green until Day 8)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEGACY = process.env.LEGACY_HTML ?? join(ROOT, 'legacy', 'khanakhajana_v13.html');
const BACKUP = join(ROOT, 'test', 'golden', 'backup_v13.json');
const OUT = process.env.GOLDEN_OUT ?? join(ROOT, 'test', 'golden', 'expected_totals.json');
const bootstrap = process.argv.includes('--bootstrap');

/** Load calcTotals from the father's single-file app with a stub DOM. */
function loadLegacy() {
  const html = readFileSync(LEGACY, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (!scripts.length) throw new Error('no inline <script> in legacy HTML');
  const noop = () => {};
  /** @type {any} */
  const el = new Proxy(function () {}, { get: (_t, k) => (k === 'style' || k === 'classList' || k === 'dataset' ? el : k === Symbol.toPrimitive ? () => '' : el), apply: () => el, set: () => true });
  /** @type {Record<string, any>} */
  const store = {};
  const sandbox = {
    console, Math, Number, JSON, Date, setTimeout: noop, setInterval: noop, clearTimeout: noop, clearInterval: noop,
    alert: noop, confirm: () => false, prompt: () => null,
    localStorage: { getItem: (/** @type {string} */ k) => store[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = String(v); }, removeItem: (/** @type {string} */ k) => { delete store[k]; } },
    document: el, navigator: { userAgent: 'node' }, location: { hash: '', href: '' }, addEventListener: noop, requestAnimationFrame: noop,
  };
  /** @type {any} */ (sandbox).window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const s of scripts) {
    try { vm.runInContext(s, ctx, { filename: 'legacy.html', timeout: 5000 }); } catch (e) { console.warn('legacy script error (ignored):', /** @type {Error} */ (e).message); }
  }
  const fn = /** @type {any} */ (ctx).calcTotals;
  if (typeof fn !== 'function') throw new Error('calcTotals not found as a global in the legacy HTML');
  // If legacy calcTotals reads settings from a global (e.g. S.settings), set it before each call here.
  return (/** @type {any} */ order, /** @type {any} */ settings) => {
    /** @type {any} */ (ctx).settings = settings;
    /** @type {any} */ (ctx).S = { ...(/** @type {any} */ (ctx).S ?? {}), settings };
    return JSON.parse(JSON.stringify(fn(order, settings)));
  };
}

const backup = JSON.parse(readFileSync(BACKUP, 'utf8'));
let calc;
if (existsSync(LEGACY) && !bootstrap) {
  calc = loadLegacy();
  console.log('using LEGACY calcTotals from', LEGACY);
} else if (bootstrap) {
  calc = (await import('../server/domain/totals.js')).calcTotals;
  console.warn('BOOTSTRAP: expected values come from the port itself. Re-run without --bootstrap once legacy/ is in place.');
} else {
  console.error(`missing ${LEGACY}. Copy the father's file there, or pass --bootstrap.`);
  process.exit(2);
}
/** @type {Record<string, any>} */
const expected = {};
for (const o of backup.orders) expected[o.id] = calc(o, backup.settings);
writeFileSync(OUT, JSON.stringify(expected, null, 1) + '\n');
console.log(`wrote ${Object.keys(expected).length} expected totals to ${OUT}`);
