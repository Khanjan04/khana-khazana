// @ts-check
// Updating the app on an existing host: a plain restart keeps the epoch (phones keep their cache),
// a schema upgrade renews it so every phone takes a fresh snapshot with the new fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.js';
import { openDb, run } from '../server/db.js';

test('restart keeps the epoch; schema upgrade renews it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kkup-'));
  const epochOnce = async () => {
    const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
    const e = (await (await fetch(`http://127.0.0.1:${s.port}/api/info`)).json()).epoch;
    await s.close();
    return e;
  };
  try {
    const e1 = await epochOnce();
    assert.equal(await epochOnce(), e1);
    const db = openDb(join(dir, 'pos.sqlite'));
    run(db, "UPDATE settings SET value='2' WHERE key='_schema'"); // as if the data came from an older version
    db.close();
    assert.notEqual(await epochOnce(), e1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
