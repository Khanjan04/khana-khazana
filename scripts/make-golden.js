// @ts-check
// Day 8: run the LEGACY calcTotals (the father's app, loaded via node:vm) over every bill in
// test/golden/backup_v13.json and write test/golden/expected_totals.json. Run once and commit
// (ALLOW_PROTECTED=1); afterwards test/golden/ is protected. Re-run only for a new real backup.
//   node scripts/make-golden.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadLegacy, legacyCalc, LEGACY_PATH } from './legacy-vm.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKUP = join(ROOT, 'test', 'golden', 'backup_v13.json');
const OUT = process.env.GOLDEN_OUT ?? join(ROOT, 'test', 'golden', 'expected_totals.json');

/** A settled legacy bill -> the order calcTotals saw (split shares are skipped: their totals are pro-rated). @param {any} b */
export const goldenOrder = (b) => ({ lines: b.lines, discount: b.discount, comp: !!b.totals.comp, delivery: b.totals.delivery });

const backup = JSON.parse(readFileSync(BACKUP, 'utf8'));
const calc = legacyCalc(loadLegacy());
/** @type {Record<string, any>} */
const expected = {};
for (const b of backup.bills) if (!b.splitNo) expected[b.id] = calc(goldenOrder(b), backup.settings);
for (const o of Object.values(backup.orders ?? {})) expected['open:' + /** @type {any} */ (o).id] = calc(o, backup.settings);
writeFileSync(OUT, JSON.stringify(expected, null, 1) + '\n');
console.log(`LEGACY calcTotals from ${LEGACY_PATH}: wrote ${Object.keys(expected).length} expected totals to ${OUT}`);
