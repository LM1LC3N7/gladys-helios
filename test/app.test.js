// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Helios unit, with
// the exact wiring of the container (src/handlers.js) and a mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC, NOW, defaultVars, fakeHelios } from './fixtures/fakeHelios.js';
import { ALLOW, CFG, DEVICE, feature, setup } from './helpers/app.js';

const text = (ack) => String(ack.error ?? '');

test('discovery: one device, the values read and published, one connection', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.model, 'Helios KWL EC 300 W R');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'text' && f.type === 'select'),
      `${f.external_id} is writable`,
    );
  }
  const stage = device.features.find((f) => f.external_id === feature('fan-stage'));
  assert.deepEqual(
    stage.supported_options.map((o) => o.value),
    ['1', '2', '3', '4'],
    'stage 0 (fans off) is never offered',
  );
  for (const f of device.features.filter((f) => f.supported_options)) {
    assert.ok(
      f.supported_options.every((o) => typeof o.label === 'string'),
      'labels are strings',
    );
  }
  const roles = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(roles.includes('humidity-1') && roles.includes('co2-1'), 'present sensors');
  assert.ok(!roles.includes('humidity-2') && !roles.includes('co2-2'), 'absent sensors ("-")');
  assert.equal(ctx.state('temperature-outdoor').state, -5.2);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-exhaust').state, 1);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('fan-percent').state, 50);
  assert.equal(ctx.state('fan-supply-rpm').state, 1250);
  assert.equal(ctx.state('filter-days-left').state, 90);
  assert.equal(ctx.state('filter-change').state, 0);
  assert.equal(ctx.state('party').state, 0);
  assert.equal(ctx.state('standby').state, 0);
  assert.equal(ctx.state('fault').state, 0);
  assert.equal(ctx.state('humidity-1').state, 45);
  assert.equal(ctx.state('co2-1').state, 650);
  assert.equal(ctx.state('operating-mode').text, 'manual');
  assert.equal(ctx.state('fan-stage').text, '2');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.fr, /niveau 2, manuel/);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // The MAC address first, then the state; one connection, closed after.
  assert.deepEqual(ctx.unit.selections().slice(0, 5), [
    'v00002',
    'v00101',
    'v00102',
    'v00094',
    'v00099',
  ]);
  assert.equal(ctx.unit.open.size, 0);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.deepEqual(ctx.store.data.identity, { unit: HOST, mac: MAC });
  assert.deepEqual(ctx.store.data.address, { host: HOST, port: 502 });
  assert.deepEqual(ctx.store.data.sensors.keys.sort(), ['co2_1', 'humidity1']);
});

test('a value that is not a number is never published as 0', async (t) => {
  const vars = defaultVars();
  vars.set('v00104', '-');
  vars.set('v00105', '');
  vars.set('v00106', 'abc');
  vars.set('v00348', '9999');
  vars.set('v01123', '');
  const ctx = await setup(t, { unit: fakeHelios({ vars }) });
  for (const role of ['temperature-outdoor', 'temperature-supply', 'temperature-exhaust']) {
    assert.equal(ctx.state(role), undefined, role);
  }
  assert.equal(ctx.state('fan-supply-rpm'), undefined);
  assert.equal(ctx.state('fault'), undefined);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
});

test('another client selecting a variable meanwhile leaves that value unknown', async (t) => {
  const unit = fakeHelios();
  const ctx = await setup(t, { unit, create: false });
  assert.ok(ctx.gladys.fake.discoveredDevices.length > 0);
  await ctx.gladys.fake.deviceCreated(ctx.gladys.fake.discoveredDevices[0]);
  const before = ctx.gladys.fake.states.length;
  unit.vars.set('v00104', '3.5');
  unit.clashes.set('v00104', 'v00105');
  await ctx.advance(61 * SECOND, 20);
  assert.equal(unit.clashes.size, 0, 'the clash happened');
  const published = ctx.gladys.fake.states.slice(before);
  assert.ok(
    !published.some(
      (s) => s.device_feature_external_id === feature('temperature-outdoor') && s.state === 18.5,
    ),
    'the supply temperature is never taken for the outdoor one',
  );
});

test('the commands are off by default: refused, nothing written', async (t) => {
  const ctx = await setup(t);
  for (const [role, value] of [
    ['fan-stage', '3'],
    ['operating-mode', 'auto'],
    ['party-start', 1],
  ]) {
    const ack = await ctx.press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(text(ack), /Autoriser les commandes/);
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a fan stage: decided on a fresh read, written, confirmed by the echo and the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const before = ctx.unit.selections().length;
  const ack = await ctx.press('fan-stage', '3');
  assert.equal(ack.success, true, text(ack));
  assert.deepEqual(ctx.unit.writes(), ['v00102=3']);
  // The fresh read (MAC, standby, stage, mode), the write, then the read back.
  assert.deepEqual(ctx.unit.selections().slice(before, before + 5), [
    'v00002',
    'v00099',
    'v00102',
    'v00101',
    'v00102',
  ]);
  assert.equal(ctx.state('fan-stage').text, '3');
  assert.equal(ctx.unit.maxOpen, 1);
});

test('the fan stage is refused in automatic mode, in standby and with the fans stopped', async (t) => {
  for (const [name, value, pattern] of [
    ['v00101', '0', /mode automatique/],
    ['v00099', '1', /mode veille/],
    ['v00102', '0', /arrêtés \(niveau 0\)/],
  ]) {
    const vars = defaultVars();
    vars.set(name, value);
    const unit = fakeHelios({ vars });
    const ctx = await setup(t, { config: ALLOW, unit });
    const ack = await ctx.press('fan-stage', '3');
    assert.equal(ack.success, false, name);
    assert.match(text(ack), pattern);
    assert.deepEqual(unit.writes(), [], name);
    await ctx.app.shutdownApp();
    t.mock.timers.reset();
  }
});

test('a value outside the choices or a select value as a number is never sent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const value of ['0', '5', 3, ' 3', 'auto']) {
    const ack = await ctx.press('fan-stage', value);
    assert.equal(ack.success, false, String(value));
  }
  for (const value of [0, 2, '', 'on', true]) {
    assert.equal((await ctx.press('party-start', value)).success, false, String(value));
  }
  assert.equal((await ctx.press('temperature-outdoor', 1)).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the operating mode: written and confirmed; refused with the fans stopped', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('operating-mode', 'auto');
  assert.equal(ack.success, true, text(ack));
  assert.deepEqual(ctx.unit.writes(), ['v00101=0']);
  assert.equal(ctx.state('operating-mode').text, 'auto');
  ctx.unit.vars.set('v00102', '0');
  const refused = await ctx.press('operating-mode', 'manual');
  assert.equal(refused.success, false);
  assert.deepEqual(ctx.unit.writes(), ['v00101=0']);
});

test('already so: nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('fan-stage', '2');
  assert.equal(ack.success, true);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a write acknowledged but not applied: "sent, without confirmation", never success', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('fan-stage', '4');
  assert.equal(ack.success, false);
  assert.match(text(ack), /envoyée, sans confirmation/);
  assert.match(text(ack), /pas encore appliquée/);
});

test('a write refused by the unit (exception 3): "not applied"; exception 6: "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.vars.set('v00102', '2');
  ctx.unit.respond = ((original) => (pdu) => {
    const textOf = pdu.subarray(6).toString('ascii');
    if (pdu[0] === 0x10 && textOf.startsWith('v00102=')) {
      ctx.unit.log.push({ fc: 0x10, text: textOf.replace(/\0+$/, '') });
      return Buffer.from([0x90, ctx.unit.code]);
    }
    return original(pdu);
  })(ctx.unit.respond);
  ctx.unit.code = 3;
  const refused = await ctx.press('fan-stage', '4');
  assert.match(text(refused), /a refusé la commande/);
  ctx.unit.code = 6;
  const busy = await ctx.press('fan-stage', '4');
  assert.match(text(busy), /envoyée, sans confirmation/);
});

test('the party stop never depends on the option, and is confirmed by the read back', async (t) => {
  const vars = defaultVars();
  vars.set('v00094', '1');
  const ctx = await setup(t, { unit: fakeHelios({ vars }) });
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, true, text(ack));
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
  assert.equal(ctx.state('party').state, 0);
  assert.equal(ctx.store.data.stopGuard.pending, false);
});

test('party start (option on) and stop: one connection at a time under a burst', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 60;
  const acks = [
    ctx.fire('party-start'),
    ctx.fire('fan-stage', '3'),
    ctx.fire('party-stop'),
    ctx.fire('party-stop'),
    ctx.app.testConnection(),
    ctx.gladys.fake.scanRequest(),
  ];
  await ctx.advance(6 * SECOND, 20);
  await Promise.all(acks);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.equal(ctx.unit.get('v00094'), '0', 'the last wish (stop) wins');
});

test('the stop guard: never lifted by the time; lifted by the party read on twice in a row elsewhere', async (t) => {
  const vars = defaultVars();
  vars.set('v00094', '1');
  const ctx = await setup(t, { unit: fakeHelios({ vars }) });
  assert.equal((await ctx.press('party-stop')).success, true);
  // An hour later the guard is still there.
  await ctx.advance(60 * MINUTE, 1000);
  assert.ok(ctx.app.stopGuard, 'kept');
  assert.ok(ctx.store.data.stopGuard, 'kept in /data');
  // Started on the unit: read on once (not sent again), twice (lifted).
  ctx.unit.vars.set('v00094', '1');
  await ctx.advance(61 * SECOND, 20);
  assert.ok(ctx.app.stopGuard, 'one read is not enough');
  assert.equal(ctx.app.stopGuard.onStreak, 1);
  await ctx.advance(61 * SECOND, 20);
  assert.equal(ctx.app.stopGuard, undefined, 'lifted');
  assert.equal(ctx.store.data.stopGuard, null);
  assert.deepEqual(ctx.unit.writes(), ['v00094=0'], 'never sent again over the user');
});

test('an unknown value between two reads breaks the count', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('party-stop')).success, true);
  // After the follow-up reads of the stop (5 s, 20 s).
  await ctx.advance(30 * SECOND, 20);
  ctx.unit.vars.set('v00094', '1');
  await ctx.advance(61 * SECOND, 20);
  assert.equal(ctx.app.stopGuard.onStreak, 1);
  ctx.unit.vars.set('v00094', 'x');
  await ctx.advance(61 * SECOND, 20);
  assert.equal(ctx.app.stopGuard.onStreak, 0);
  ctx.unit.vars.set('v00094', '1');
  await ctx.advance(61 * SECOND, 20);
  assert.ok(ctx.app.stopGuard, 'not two reads in a row');
});

test('a stop not applied is sent again by the reads, three times at most', async (t) => {
  const vars = defaultVars();
  vars.set('v00094', '1');
  const ctx = await setup(t, { unit: fakeHelios({ vars }) });
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, false);
  assert.match(text(ack), /sans confirmation \(toujours actif\)/);
  assert.equal(ctx.store.data.stopGuard.pending, true);
  await ctx.advance(10 * MINUTE, 20);
  assert.equal(ctx.unit.writes().length, 4, 'the press and three resends');
  assert.ok(ctx.app.stopGuard, 'still kept: never lifted by the time');
});

test('a party start landing after a confirmed stop: sticky window, stop sent again', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.writeDelays = [3_000];
  ctx.unit.applyClosedWrites = true;
  const start = ctx.fire('party-start');
  await ctx.advance(2_000, 20);
  const stop = await ctx.press('party-stop', 1, 2_000);
  await start;
  assert.equal(stop.success, true, text(stop));
  // The start lands late: the follow-up reads see the party on and send the stop again.
  await ctx.advance(30 * SECOND, 20);
  assert.equal(ctx.unit.get('v00094'), '0');
  assert.ok(ctx.unit.writes().filter((w) => w === 'v00094=0').length >= 2);
});

test('a party start lifts the stop guard; /data not writable refuses it, nothing written', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  assert.equal((await ctx.press('party-stop')).success, true);
  assert.ok(store.data.stopGuard);
  store.failSave = true;
  const refused = await ctx.press('party-start');
  assert.equal(refused.success, false);
  assert.match(text(refused), /\/data/);
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
  assert.ok(ctx.app.stopGuard, 'the guard stays');
  store.failSave = false;
  const ack = await ctx.press('party-start');
  assert.equal(ack.success, true, text(ack));
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(store.data.stopGuard, null);
});

test('the party stop goes even with getConfig failing, to the address kept in /data', async (t) => {
  const store = memoryStore({ address: { host: HOST, port: 502 } });
  let calls = 0;
  const ctx = await setup(t, {
    store,
    create: false,
    // The SDK reads it once before 'connected'; ours fails every time.
    getConfig: async () => {
      calls += 1;
      if (calls === 1) return { host: HOST };
      throw new Error('503');
    },
  });
  assert.ok(calls >= 2);
  assert.match(ctx.status().message.fr, /configuration n’a pas pu être lue/);
  const ack = await ctx.press('party-stop', 1, 5 * SECOND);
  assert.equal(ack.success, true, text(ack));
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
});

test('getConfig failing in connected: tried again until it works, then the unit is read', async (t) => {
  let calls = 0;
  const unit = fakeHelios();
  const ctx = await setup(t, {
    unit,
    create: false,
    // The SDK's own read succeeds; the integration's first one fails.
    getConfig: async () => {
      calls += 1;
      if (calls === 2) throw new Error('timeout');
      return { host: HOST };
    },
  });
  assert.equal(unit.connections, 0, 'nothing read without the configuration');
  await ctx.advance(6 * SECOND, 20);
  assert.ok(unit.connections >= 1);
  assert.equal(ctx.status().connected, true);
});

test('a stop kept unconfirmed in /data leaves at start, before the configuration', async (t) => {
  const store = memoryStore({
    address: { host: HOST, port: 502 },
    stopGuard: { unit: HOST, host: HOST, port: 502, pending: true, reasserts: 0 },
  });
  const unit = fakeHelios();
  unit.vars.set('v00094', '1');
  const ctx = await setup(t, { store, unit, connect: false });
  await ctx.advance(1_000, 10);
  assert.deepEqual(unit.writes(), ['v00094=0']);
  assert.equal(ctx.gladys.fake.connectionStatuses.length, 0, 'before any connection to Gladys');
  assert.equal(store.data.stopGuard.pending, false);
});

test('another MAC address: nothing published, commands refused, the button accepts it', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  ctx.unit.vars.set('v00002', '00:0A:5C:99:99:99');
  ctx.unit.vars.set('v00104', '33.3');
  await ctx.advance(61 * SECOND, 20);
  assert.notEqual(ctx.state('temperature-outdoor').state, 33.3);
  assert.match(ctx.status().message.fr, /Un autre appareil répond/);
  const ack = await ctx.press('fan-stage', '3');
  assert.equal(ack.success, false);
  assert.match(text(ack), /autre adresse MAC/);
  assert.deepEqual(ctx.unit.writes(), []);
  // The party stop is never held back by the identity.
  assert.equal((await ctx.press('party-stop')).success, true);
  const answer = await ctx.app.testConnection();
  assert.match(answer.fr, /99:99:99/);
  assert.equal(store.data.identity.mac, '00:0A:5C:99:99:99');
});

test('/data unreadable: no identity learnt, nothing overwritten, commands refused, the stop still goes', async (t) => {
  const store = memoryStore({ lastAttemptAt: 1 });
  store.failLoad = true;
  const ctx = await setup(t, { config: ALLOW, store, create: false });
  await ctx.advance(61 * SECOND, 20);
  assert.equal(store.saves, 0, 'never overwritten');
  assert.match(ctx.status().message.fr, /illisible/);
  const ack = await ctx.press('fan-stage', '3');
  assert.equal(ack.success, false);
  assert.match(text(ack), /\/data est illisible/);
  assert.equal(ctx.app.memory.identity, null, 'no identity learnt');
  assert.equal((await ctx.press('party-stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
});

test('errors, warnings and infos refused never hold the values back', async (t) => {
  const unit = fakeHelios();
  unit.exceptions.add('v01123');
  unit.exceptions.add('v01124');
  unit.exceptions.add('v01125');
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('fault'), undefined);
  // Skipped for an hour, then tried again.
  const count = () => unit.selections().filter((s) => s === 'v01123').length;
  const first = count();
  await ctx.advance(5 * MINUTE, 1000);
  assert.equal(count(), first);
});

test('a stuck read never holds the party stop back', async (t) => {
  const vars = defaultVars();
  vars.set('v00094', '1');
  const unit = fakeHelios({ vars });
  const ctx = await setup(t, { unit });
  // The next read stalls on the supply temperature (no answer).
  unit.silent.add('v00105');
  for (let i = 0; i < 7000 && unit.selections().at(-1) !== 'v00105'; i += 1) {
    await ctx.advance(10, 10);
  }
  assert.equal(ctx.app.active?.kind, 'read', 'a read is stuck');
  unit.silent.clear();
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, true, text(ack));
  assert.equal(unit.maxOpen, 1);
});

test('the party stop is tried again after a connection closed at once', async (t) => {
  const ctx = await setup(t);
  ctx.unit.vars.set('v00094', '1');
  ctx.unit.dropConnections = 2;
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, true, text(ack));
});

test('never sooner than the interval: test button, reconnection, restart', async (t) => {
  const ctx = await setup(t);
  const connections = ctx.unit.connections;
  await ctx.app.testConnection();
  await ctx.gladys.fake.scanRequest();
  await ctx.app.onConnected(async () => CFG);
  await ctx.advance(1000);
  assert.equal(ctx.unit.connections, connections);
});

test('a restart never reads sooner than the interval after the last read kept in /data', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const unit = fakeHelios();
  const ctx = await setup(t, { store, unit, create: false });
  assert.equal(unit.connections, 0);
  assert.match(ctx.status().message.fr, /Prochaine lecture/);
  await ctx.app.testConnection();
  assert.equal(unit.connections, 0, 'not the button either');
});

test('a reconnection republishes the status but no old value as new', async (t) => {
  const ctx = await setup(t);
  await ctx.advance(30 * SECOND, 1000);
  const before = ctx.gladys.fake.states.length;
  let queued = 0;
  const original = ctx.app.queueStates.bind(ctx.app);
  ctx.app.queueStates = (...args) => {
    queued += 1;
    return original(...args);
  };
  await ctx.app.onConnected(async () => CFG);
  await ctx.advance(2000, 100);
  assert.equal(ctx.gladys.fake.states.length, before);
  assert.equal(queued, 0, 'the last values are not even queued again');
  assert.equal(ctx.status().connected, true);
});

test('configurations saved in a row apply one by one, the last one wins', async (t) => {
  const ctx = await setup(t);
  const saves = [
    ctx.gladys.fake.configUpdated({ host: '192.168.1.91' }),
    ctx.gladys.fake.configUpdated({ host: '192.168.1.92' }),
    ctx.gladys.fake.configUpdated({ host: HOST, poll_interval: 120 }),
  ];
  await ctx.advance(10 * SECOND, 10);
  await Promise.all(saves);
  assert.equal(ctx.app.config.address.host, HOST);
  assert.equal(ctx.app.config.pollInterval, 120);
});

test('the party stop during a backoff (unit unreachable, then back)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.advance(61 * SECOND, 20);
  assert.equal(ctx.status().connected, false);
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, false);
  assert.match(text(ack), /non envoyée/);
  assert.equal(ctx.store.data.stopGuard.pending, true, 'kept to be sent again');
  ctx.unit.down = false;
  ctx.unit.vars.set('v00094', '1');
  const again = await ctx.press('party-stop');
  assert.equal(again.success, true, text(again));
});

test('a command not written yet when the party stop arrives is never written after it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 150;
  const command = ctx.fire('party-start');
  await ctx.advance(200, 10);
  const stop = ctx.fire('party-stop');
  await ctx.advance(6 * SECOND, 10);
  const [c, s] = await Promise.all([command, stop]);
  assert.equal(c.success, false);
  assert.match(text(c), /arrêté entre-temps/);
  assert.equal(s.success, true, text(s));
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
});

test('the party stop right after a restart, before the first read', async (t) => {
  const store = memoryStore({
    lastAttemptAt: NOW - 5 * SECOND,
    address: { host: HOST, port: 502 },
  });
  const unit = fakeHelios();
  unit.vars.set('v00094', '1');
  const ctx = await setup(t, { store, unit, create: false });
  assert.equal(unit.selections().length, 0, 'no read yet');
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, true, text(ack));
  assert.equal(unit.get('v00094'), '0');
});

test('a device created later gets the last values only while they are recent', async (t) => {
  const ctx = await setup(t, { create: false });
  const device = ctx.gladys.fake.discoveredDevices[0];
  await ctx.advance(10 * SECOND, 100);
  await ctx.gladys.fake.deviceCreated(device);
  await ctx.advance(1500, 100);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  // Restart: the values are gone until the next read; a later creation publishes nothing old.
  ctx.unit.down = true;
  await ctx.advance(61 * SECOND, 20);
  const before = ctx.gladys.fake.states.length;
  await ctx.gladys.fake.deviceUpdated(device);
  await ctx.advance(1500, 100);
  assert.equal(ctx.gladys.fake.states.length, before);
});

test('a party stop counted between the fresh read and the write refuses the command', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 100;
  const ack = ctx.fire('fan-stage', '3');
  await ctx.advance(300, 10);
  // As a stop that came and went while the command read the unit.
  ctx.app.protectSeq += 1;
  await ctx.advance(5 * SECOND, 10);
  const answer = await ack;
  assert.equal(answer.success, false);
  assert.match(text(answer), /arrêté entre-temps/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the option turned off during the fresh read: the command is not written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delay = 100;
  const ack = ctx.fire('fan-stage', '3');
  await ctx.advance(300, 10);
  await ctx.gladys.fake.configUpdated({ host: HOST, allow_commands: false });
  await ctx.advance(5 * SECOND, 10);
  const answer = await ack;
  assert.equal(answer.success, false);
  assert.match(text(answer), /Autoriser les commandes/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a second stop inside the sticky window keeps it: the late start is still stopped', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.writeDelays = [4_000];
  ctx.unit.applyClosedWrites = true;
  const start = ctx.fire('party-start');
  await ctx.advance(1_000, 10);
  const first = ctx.fire('party-stop');
  await ctx.advance(1_500, 10);
  const second = ctx.fire('party-stop');
  await ctx.advance(1_500, 10);
  const [, a, b] = await Promise.all([start, first, second]);
  assert.equal(a.success, true, text(a));
  assert.equal(b.success, true, text(b));
  // The start lands after both stops; the follow-up reads send the stop again.
  await ctx.advance(30 * SECOND, 20);
  assert.equal(ctx.unit.get('v00094'), '0');
});

test('a guard kept without knowing whether the stop was applied never counts as "changed elsewhere"', async (t) => {
  const store = memoryStore({
    address: { host: HOST, port: 502 },
    stopGuard: { unit: HOST, host: HOST, port: 502, pending: false },
  });
  const unit = fakeHelios();
  unit.vars.set('v00094', '1');
  const ctx = await setup(t, { store, unit });
  assert.ok(unit.writes().includes('v00094=0'), 'the stop is sent again');
  assert.ok(ctx.app.stopGuard);
});

test('another address saved drops the stop guard of the previous one', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('party-stop')).success, true);
  assert.ok(ctx.store.data.stopGuard);
  const saved = ctx.gladys.fake.configUpdated({ host: '192.168.1.91' });
  await ctx.advance(2_000, 20);
  await saved;
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
});

test('a party start clicked while the party is already on lifts the stop guard', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.writeDelays = [3_000];
  ctx.unit.applyClosedWrites = true;
  const start = ctx.fire('party-start');
  await ctx.advance(1_000, 10);
  const stop = await ctx.press('party-stop', 1, 2_500);
  await start;
  assert.equal(stop.success, true, text(stop));
  assert.equal(ctx.unit.get('v00094'), '1', 'the late start landed');
  const again = await ctx.press('party-start', 1, 600);
  assert.equal(again.success, true, text(again));
  assert.equal(ctx.app.stopGuard, undefined);
  await ctx.advance(30 * SECOND, 20);
  assert.equal(ctx.unit.get('v00094'), '1', 'the newer wish stays');
  assert.equal(ctx.unit.writes().filter((w) => w === 'v00094=0').length, 1);
});

// --- Review r1 -------------------------------------------------------------------

test('r1 I1: a getConfig() answer older than a save is dropped (the option unchecked stays off)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  let answer;
  const slow = () =>
    new Promise((resolve) => {
      answer = () => resolve({ ...ALLOW, poll_interval: 600 });
    });
  const reconnecting = ctx.app.onConnected(slow);
  await ctx.advance(100, 10);
  await ctx.gladys.fake.configUpdated({ host: HOST, allow_commands: false, poll_interval: 120 });
  answer();
  await ctx.advance(500, 10);
  await reconnecting;
  assert.equal(ctx.app.config.allowCommands, false);
  assert.equal(ctx.app.config.pollInterval, 120);
  const ack = await ctx.press('fan-stage', '4');
  assert.equal(ack.success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('r1 I2: an empty or invalid address never lifts the stop guard; the stop goes to /data', async (t) => {
  const vars = defaultVars();
  vars.set('v00094', '1');
  const ctx = await setup(t, { unit: fakeHelios({ vars }) });
  ctx.unit.ignoreWrites = true;
  assert.equal((await ctx.press('party-stop')).success, false);
  assert.equal(ctx.store.data.stopGuard.pending, true);
  for (const host of ['not a host', '']) {
    const saved = ctx.gladys.fake.configUpdated({ host });
    await ctx.advance(1_000, 20);
    await saved;
    assert.ok(ctx.app.stopGuard, `kept with "${host}"`);
    assert.ok(ctx.store.data.stopGuard, `kept in /data with "${host}"`);
  }
  // Without a valid address, the stop goes to the address kept in /data.
  ctx.unit.ignoreWrites = false;
  const ack = await ctx.press('party-stop');
  assert.equal(ack.success, true, text(ack));
  assert.equal(ctx.unit.get('v00094'), '0');
  const saved = ctx.gladys.fake.configUpdated({ host: HOST });
  await ctx.advance(5_000, 20);
  await saved;
  assert.ok(ctx.app.stopGuard, 'the same address keeps it');
});

test('r1 I3: the option unchecked during the /data write of a party start: nothing written', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  assert.equal((await ctx.press('party-stop')).success, true);
  const save = store.save.bind(store);
  store.save = (data) =>
    new Promise((resolve, reject) => {
      setTimeout(() => save(data).then(resolve, reject), 1_000);
    });
  const start = ctx.fire('party-start');
  for (let i = 0; i < 300 && !ctx.app.active; i += 1) await ctx.advance(10, 10);
  // The fresh read is done (8 requests), the /data write is pending.
  await ctx.advance(400, 10);
  await ctx.gladys.fake.configUpdated({ host: HOST, allow_commands: false });
  await ctx.advance(5 * SECOND, 10);
  const ack = await start;
  assert.equal(ack.success, false);
  assert.match(text(ack), /Autoriser les commandes/);
  assert.deepEqual(ctx.unit.writes(), ['v00094=0']);
  assert.ok(ctx.app.stopGuard, 'the guard is kept again');
});

test('r1 I3: a command refused on arrival opens no connection and leaves a read alone', async (t) => {
  const ctx = await setup(t);
  const connections = ctx.unit.connections;
  ctx.unit.delay = 200;
  await ctx.advance(60 * SECOND, 20);
  assert.equal(ctx.app.active?.kind, 'read');
  const reading = ctx.app.active;
  const ack = ctx.fire('fan-stage', '3');
  await ctx.advance(50, 10);
  assert.equal(ctx.app.active, reading, 'the read goes on');
  assert.equal((await ack).success, false);
  assert.equal(ctx.unit.connections, connections + 1, 'only the read connected');
});

test('r1 I3: the time of a read is in /data before its first request', async (t) => {
  const store = memoryStore();
  const unit = fakeHelios();
  const at = [];
  const save = store.save.bind(store);
  store.save = (data) => {
    if (Number.isFinite(data.lastAttemptAt)) at.push(unit.log.length);
    return save(data);
  };
  await setup(t, { store, unit });
  assert.equal(at[0], 0, 'written before any request');
  assert.equal(store.data.lastAttemptAt, NOW);
});

test('r1 I3: a wrong echo of the selection or a read of the wrong size ends the read', async (t) => {
  for (const spoil of [(u) => (u.badEcho = true), (u) => u.shortReads.add('v00101')]) {
    const unit = fakeHelios();
    spoil(unit);
    const ctx = await setup(t, { unit, create: false });
    assert.equal(ctx.status().connected, false);
    assert.match(ctx.status().message.fr, /a mal répondu \(protocol\)/);
    assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
    assert.ok(unit.selections().length <= 2, 'nothing more asked on that session');
    await ctx.app.shutdownApp();
    t.mock.timers.reset();
  }
});

test('r1 M5: a stop kept unconfirmed is sent at start three times at most', async (t) => {
  const store = memoryStore({
    address: { host: HOST, port: 502 },
    stopGuard: { unit: HOST, host: HOST, port: 502, pending: true, reasserts: 3 },
  });
  const unit = fakeHelios();
  const ctx = await setup(t, { store, unit, connect: false });
  await ctx.advance(1_000, 10);
  assert.deepEqual(unit.writes(), []);
  assert.ok(ctx.app.stopGuard, 'still kept');
});
