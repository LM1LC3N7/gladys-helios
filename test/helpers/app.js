// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Helios unit, with
// the exact wiring of the container (src/handlers.js) and a mocked clock: the
// mocked Date moves with the timers, and the monotonic clock given to the app
// also moves by 1 µs at each read (a decision that reads it twice sees it
// move, as on a real clock).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HeliosApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, fakeHelios, settle } from '../fixtures/fakeHelios.js';

export const CFG = { host: HOST };
export const ALLOW = { host: HOST, allow_commands: true };
export const DEVICE = 'ext:test-integration:helios:unit';
export const feature = (role) => `${DEVICE}:${role}`;

export function quietLogger(logs = []) {
  return Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
}

/** A clock that moves: the mocked Date plus 1 µs per read. */
function movingClock() {
  let reads = 0;
  return () => {
    reads += 1;
    return Date.now() + reads / 1000;
  };
}

export async function setup(
  t,
  {
    config = CFG,
    unit = fakeHelios(),
    store = memoryStore(),
    create = true,
    getConfig,
    connect = true,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  const logs = [];
  const logger = quietLogger(logs);
  const app = new HeliosApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    clock: movingClock(),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  t.after(() => app.shutdownApp());
  const ctx = { gladys, app, unit, advance, logs, store };
  ctx.boot = app.boot();
  await settle();
  if (connect) {
    const connecting = gladys.connect();
    await settle();
    await advance(2000);
    await connecting;
    if (create && gladys.fake.discoveredDevices.length > 0) {
      await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
      await settle();
      await advance(1100);
    }
  }
  ctx.fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  ctx.press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = ctx.fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  ctx.state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  ctx.status = () => gladys.fake.connectionStatus;
  return ctx;
}
