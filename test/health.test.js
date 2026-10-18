// @ts-check
// Day 1 exit: /health {ok, seq, node, uptime} on a random port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.js';

test('GET /health on a random port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kkh-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.port}/health`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.seq, 0);
    assert.equal(r.node, process.version);
    assert.equal(typeof r.uptime, 'number');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
