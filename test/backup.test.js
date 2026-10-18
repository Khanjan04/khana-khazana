// @ts-check
// Day 19: VACUUM INTO data/backups/YYYYMMDD.sqlite (keep 30), JSON export without secrets, restore validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, seedMenu } from './helpers.js';
import { backupNow, listBackups, validateBackup, exportJson, backupPath, KEEP } from '../server/backup.js';
import { openDb, get } from '../server/db.js';

test('backup file is a valid DB with the same data; keep the newest 30', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kkbk-'));
  const t = setup({ path: join(dir, 'pos.sqlite') });
  const m = seedMenu(t);
  t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  const b = backupNow(t.db, join(dir, 'backups'), { now: new Date('2026-10-18T03:05:00').getTime() });
  assert.equal(b.file, '20261018.sqlite');
  const v = validateBackup(join(dir, 'backups', b.file));
  assert.deepEqual([v.ok, v.orders], [true, 1]);
  const copy = openDb(join(dir, 'backups', b.file));
  assert.equal(get(copy, 'SELECT COUNT(*) AS n FROM kots').n, 1);
  copy.close();
  for (let i = 0; i < KEEP + 5; i++) writeFileSync(join(dir, 'backups', `2025${String(i).padStart(4, '0')}.sqlite`), '');
  backupNow(t.db, join(dir, 'backups'), { label: 'dayclose-2026-10-18' });
  assert.equal(listBackups(join(dir, 'backups')).length, KEEP);
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.includes('dayclose')));
  t.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backupPath rejects traversal and unknown names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kkbk-'));
  writeFileSync(join(dir, '20261018.sqlite'), '');
  assert.ok(backupPath(dir, '20261018.sqlite'));
  assert.equal(backupPath(dir, '../pos.sqlite'), null);
  assert.equal(backupPath(dir, '20261018.sqlite/../../x'), null);
  assert.equal(backupPath(dir, 'nope.sqlite'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('owner JSON export contains data but no PIN/token hashes or private settings', () => {
  const t = setup();
  seedMenu(t);
  const e = exportJson(t.db);
  assert.ok(e.tables.items.length >= 4);
  const s = JSON.stringify(e);
  assert.ok(!s.includes('pin_hash') && !s.includes('pin_salt') && !s.includes('token_hash'));
  assert.ok(!e.tables.settings.some((/** @type {any} */ r) => r.key.startsWith('_')));
});
