// @ts-check
// Run the father's single-file app (legacy/khanakhajana_v13.html) inside node:vm with a stub DOM,
// so scripts can call its REAL functions (calcTotals, defaults, settleOrder, ...).
// Used by make-golden.js, make-sample-backup.js and extract-legacy-defaults.js. Read-only use.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LEGACY_PATH = process.env.LEGACY_HTML ?? join(ROOT, 'legacy', 'khanakhajana_v13.html');

/**
 * @param {{ path?: string, now?: () => number, seed?: number }} [o] seed = deterministic Math.random
 * @returns {{ run: (code: string) => any, ctx: any }}
 */
export function loadLegacy(o = {}) {
  const html = readFileSync(o.path ?? LEGACY_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (!scripts.length) throw new Error('no inline <script> in legacy HTML');
  const noop = () => {};
  /** @type {any} */
  const el = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'value' || k === 'innerHTML' || k === 'textContent' ? '' : k === 'children' ? [] : el),
    apply: () => el, set: () => true,
  });
  /** @type {Record<string, string>} */
  const store = {};
  const RealDate = Date;
  const now = o.now;
  const FakeDate = now
    ? class extends RealDate {
      /** @param {any[]} a */
      constructor(...a) { if (a.length) super(...(/** @type {[any]} */ (a))); else super(now()); }
      static now() { return now ? now() : RealDate.now(); }
    }
    : RealDate;
  let seed = o.seed ?? 0;
  const SeededMath = o.seed === undefined ? Math : Object.assign(Object.create(Math), {
    random: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648),
  });
  const sandbox = {
    console, Math: SeededMath, Number, JSON, Date: FakeDate, Intl, Object, Array, String, Set, Map, RegExp, isFinite, parseFloat, parseInt,
    setTimeout: noop, setInterval: noop, clearTimeout: noop, clearInterval: noop,
    alert: noop, confirm: () => false, prompt: () => null,
    localStorage: { getItem: (/** @type {string} */ k) => store[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = String(v); }, removeItem: (/** @type {string} */ k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: el, navigator: { userAgent: 'node' }, location: { hash: '', href: '' }, addEventListener: noop, requestAnimationFrame: noop,
    innerWidth: 1280, scrollTo: noop, Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: noop },
  };
  /** @type {any} */ (sandbox).window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const s of scripts) vm.runInContext(s, ctx, { filename: 'legacy.html', timeout: 10000 });
  return { ctx, run: (code) => vm.runInContext(code, ctx, { timeout: 10000 }) };
}

/**
 * The legacy calcTotals reads db.settings (a global); swap it in per call.
 * @param {{ run: (code: string) => any, ctx: any }} L
 */
export function legacyCalc(L) {
  return (/** @type {any} */ order, /** @type {any} */ settings) => {
    L.ctx.__o = order; L.ctx.__s = settings;
    return JSON.parse(L.run('(() => { const keep = db.settings; db.settings = __s; try { return JSON.stringify(calcTotals(__o)); } finally { db.settings = keep; } })()'));
  };
}
