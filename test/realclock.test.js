// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local TCP server playing the unit (the fake unit's frames): the reads
// really start at 0, the interval and twice the interval, one connection at a
// time. The time is sped up 20 times (30 s of the interval are 1.5 s) but it
// is the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { HeliosApp } from '../src/app.js';
import { POLL_INTERVAL, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { fakeHelios } from './fixtures/fakeHelios.js';
import { quietLogger } from './helpers/app.js';

const SPEED = 20;

test('real clock x20: a read at once, then every interval, one connection at a time', async () => {
  const unit = fakeHelios();
  const server = await tcpServer({ onData: (chunk) => unit.frame(chunk) });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const app = new HeliosApp({
    gladys,
    logger: quietLogger(),
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    const started = clock.monotonic();
    await app.connected({ host: `127.0.0.1:${server.port}`, poll_interval: POLL_INTERVAL.min });
    const gaps = await measurePeriod(spy, { count: 3, period: POLL_INTERVAL.min * SECOND });
    assert.ok(spy.calls[0].at - started < 5 * SECOND, 'the first read at once');
    assert.equal(gaps.length, 2);
    assert.equal(server.peak, 1, 'one connection at a time');
    assert.ok(unit.selections().length > 40, 'the unit was really read');
  } finally {
    spy.restore();
    await app.shutdownApp();
    clock.close();
    await server.close();
  }
});
