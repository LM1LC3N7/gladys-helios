// -----------------------------------------------------------------------------
// /data: the real file store (in a temporary directory, removed after), the
// repair of what is read back, an unreadable file never taken for an empty one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINUTE } from '../src/constants.js';
import { fileStore, normalizeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

test('the file store: missing is empty, saved 0600, unreadable or not JSON throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'helios-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { a: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(path, 'x'.repeat(9000));
  await assert.rejects(store.load(), /too large/);
  await rm(path);
  await writeFile(path, '{}');
  const directory = fileStore(dir);
  await assert.rejects(directory.load(), /unreadable/);
});

test('normalizeMemory: bounded, repaired, a future time never trusted', () => {
  const m = normalizeMemory(
    {
      lastAttemptAt: NOW + 10 * MINUTE,
      identity: { unit: '192.168.1.90', mac: '00:0A:5C:11:22:33' },
      address: { host: '192.168.1.90', port: 502 },
      sensors: { unit: '192.168.1.90', keys: ['humidity1', 'co2_9', '__proto__', 'humidity1'] },
      stopGuard: {
        unit: '192.168.1.90',
        host: '192.168.1.90',
        port: 502,
        pending: 'yes',
        reasserts: 99,
        onStreak: -4,
        stickyUntil: NOW + 60 * MINUTE,
      },
    },
    NOW,
  );
  assert.equal(m.lastAttemptAt, NOW, 'a future time counts as now');
  assert.deepEqual(m.sensors.keys, ['humidity1']);
  assert.equal(m.stopGuard.pending, false, 'only true is true');
  assert.equal(m.stopGuard.reasserts, 3);
  assert.equal(m.stopGuard.onStreak, 0);
  assert.equal(m.stopGuard.stickyUntil, null, 'a window beyond 2 minutes is not trusted');
  const bad = normalizeMemory(
    {
      identity: { unit: 'x', mac: 'not a mac' },
      address: { host: '0.0.0.0', port: 502 },
      stopGuard: { unit: 'x', host: '224.0.0.1', port: 502 },
    },
    NOW,
  );
  assert.equal(bad.identity, null);
  assert.equal(bad.address, null);
  assert.equal(bad.stopGuard, null);
  for (const raw of [null, [], 'text', 42]) {
    assert.equal(normalizeMemory(raw, NOW).stopGuard, null);
  }
});
