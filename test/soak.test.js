// @ts-check
// Short version of the Day 5 soak (scripts/soak.js runs the 30-minute one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSoak } from '../scripts/soak.js';

test('soak: 3 captains, random disconnects and a host restart -> 0 lost, 0 duplicate', { timeout: 60_000 }, async () => {
  const { report, failures } = await runSoak({ captains: 3, ms: 8000 });
  assert.deepEqual(failures, [], JSON.stringify(report));
  assert.ok(report.sent > 20, 'sent enough traffic: ' + report.sent);
  assert.ok(report.disconnects > 0 && report.restarts > 0, JSON.stringify(report));
});
