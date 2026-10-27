// -----------------------------------------------------------------------------
// The Helios variables over Modbus TCP: the bytes of the requests (the
// examples of the Helios document), the decoding of hostile answers, and the
// MBAP session (bounded frames, transaction, unit id 180).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VARIABLES } from '../src/constants.js';
import { ERROR_KINDS, ModbusSession } from '../src/modbus/client.js';
import {
  answerText,
  decodeValue,
  isWriteEcho,
  parseValue,
  readCount,
  readRequest,
  registersFor,
  selectRequest,
  writeRequest,
} from '../src/modbus/protocol.js';

const hex = (buffer) => buffer.toString('hex');

test('the write of the Helios example: "v00102=4" in 5 registers from address 1', () => {
  const pdu = writeRequest(VARIABLES.fanStage, '4');
  // 0x10, address 1, count 5, 10 bytes, then 0x7630 0x3031 0x3032 0x3d34 0x0000.
  assert.equal(hex(pdu), '10' + '0001' + '0005' + '0a' + '7630303130323d340000');
});

test('the selection of a read: "v00104\\0" in 4 registers; the read of 8 registers', () => {
  assert.equal(hex(selectRequest(VARIABLES.outdoor)), '1000010004087630303130340000');
  assert.equal(hex(readRequest(VARIABLES.outdoor)), '0300010008');
  assert.equal(readCount(VARIABLES.mac), 13, 'the count of the Helios list');
  assert.equal(readCount(VARIABLES.filterMinutes), 9);
  assert.equal(readCount(VARIABLES.errors), 9);
  assert.equal(readCount(VARIABLES.warnings), 6);
  assert.equal(readCount(VARIABLES.article), 20);
  assert.equal(registersFor(1), 4, 'never fewer than 4 registers');
});

test('only digits of the commands are ever written', () => {
  for (const value of ['', '1234', '1;v00000=x', '-1', '1.5', 1, null]) {
    assert.throws(() => writeRequest(VARIABLES.party, value), /bad write/, String(value));
  }
  assert.throws(() => selectRequest({ name: 'v001\n' }), /bad variable/);
});

function answer(variable, text, { count = readCount(variable), pad = 0 } = {}) {
  const pdu = Buffer.alloc(2 + count * 2, pad);
  pdu[0] = 3;
  pdu[1] = count * 2;
  pdu.fill(0, 2);
  Buffer.from(text, 'latin1').copy(pdu, 2);
  return pdu;
}

test('an answer: the Helios example "v00104=25.50" is 25.5 °C', () => {
  const read = answerText(VARIABLES.outdoor, answer(VARIABLES.outdoor, 'v00104=25.50'));
  assert.deepEqual(read, { text: 'v00104=25.50' });
  assert.deepEqual(parseValue(VARIABLES.outdoor, read.text), { value: 25.5 });
});

test('hostile answers: wrong size, no NUL, control bytes, another variable', () => {
  const v = VARIABLES.outdoor;
  assert.deepEqual(answerText(v, answer(v, 'v00104=1', { count: 7 })), { error: 'size' });
  const wrongCount = answer(v, 'v00104=1');
  wrongCount[1] = 14;
  assert.deepEqual(answerText(v, wrongCount), { error: 'size' });
  assert.deepEqual(answerText(v, answer(v, 'v00104=1234567890')), { error: 'truncated' });
  assert.deepEqual(answerText(v, answer(v, 'v00104=1\x072')), { error: 'garbled' });
  assert.deepEqual(answerText(v, answer(v, 'v00104=\xe9')), { error: 'garbled' });
  assert.deepEqual(parseValue(v, 'v00105=18.5'), { other: true });
  assert.deepEqual(parseValue(v, 'v0010'), { other: true });
});

test('values: strict kinds, "-" and empty unknown, never 0', () => {
  const t = VARIABLES.outdoor;
  for (const raw of ['', '-', ' 1', '1e3', '0x10', '25.', '.5', '9999', '-50', 'NaN', '12.345']) {
    assert.equal(decodeValue(t, raw), undefined, JSON.stringify(raw));
  }
  assert.equal(decodeValue(t, '-27.0'), -27);
  assert.equal(decodeValue(t, '0'), 0);
  const stage = VARIABLES.fanStage;
  for (const raw of ['', '5', '-1', '1.0', ' ', '01x']) {
    assert.equal(decodeValue(stage, raw), undefined, JSON.stringify(raw));
  }
  assert.equal(decodeValue(stage, '0'), 0);
  const party = VARIABLES.party;
  assert.equal(decodeValue(party, '1'), true);
  assert.equal(decodeValue(party, '0'), false);
  assert.equal(decodeValue(party, '2'), undefined);
  assert.equal(decodeValue(party, ''), undefined);
  assert.equal(decodeValue(VARIABLES.errors, '4294967295'), 4294967295);
  assert.equal(decodeValue(VARIABLES.errors, '4294967296'), undefined);
  assert.equal(decodeValue(VARIABLES.co2_1, '650.4'), 650);
  assert.equal(decodeValue(VARIABLES.humidity1, '101'), undefined);
  assert.equal(decodeValue(VARIABLES.mac, '00-0a-5c-11-22-33'), '00:0A:5C:11:22:33');
  assert.equal(decodeValue(VARIABLES.mac, '00:00:00:00:00:00'), undefined);
  assert.equal(decodeValue(VARIABLES.mac, '00:0A:5C:11:22'), undefined);
  assert.equal(decodeValue(VARIABLES.software, '2.27'), '2.27');
  assert.equal(decodeValue(VARIABLES.software, '2.2'), undefined);
});

test('the echo of a write is exact', () => {
  const request = writeRequest(VARIABLES.party, '0');
  assert.ok(isWriteEcho(request, request.subarray(0, 5)));
  const bad = Buffer.from(request.subarray(0, 5));
  bad[4] ^= 1;
  assert.ok(!isWriteEcho(request, bad));
  assert.ok(!isWriteEcho(request, request.subarray(0, 6)));
});

class Socket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }
  write(bytes) {
    this.written.push(Buffer.from(bytes));
  }
  destroy() {
    this.destroyed = true;
  }
}

function frame(tid, pdu, { unitId = 180, length } = {}) {
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(length ?? pdu.length + 1, 4);
  out[6] = unitId;
  pdu.copy(out, 7);
  return out;
}

test('the session: unit id 180, the answer to its own transaction only, bounded frames', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket);
  const request = session.request(readRequest(VARIABLES.party));
  const sent = socket.written[0];
  assert.equal(sent[6], 180);
  const tid = sent.readUInt16BE(0);
  const pdu = answer(VARIABLES.party, 'v00094=1');
  socket.emit('data', frame(tid, pdu).subarray(0, 4));
  socket.emit('data', frame(tid, pdu).subarray(4));
  assert.deepEqual(await request, pdu);

  for (const [name, bytes] of [
    ['another transaction', (t) => frame(t + 1, pdu)],
    ['another unit id', (t) => frame(t, pdu, { unitId: 1 })],
    ['a frame announced too long', (t) => frame(t, pdu, { length: 300 })],
    ['bytes beyond the frame', (t) => Buffer.concat([frame(t, pdu), Buffer.from([0])])],
  ]) {
    const s = new Socket();
    const other = new ModbusSession(s);
    const pending = other.request(readRequest(VARIABLES.party));
    s.emit('data', bytes(s.written[0].readUInt16BE(0)));
    await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    assert.ok(s.destroyed, name);
  }

  const big = new Socket();
  const flooded = new ModbusSession(big);
  const pending = flooded.request(readRequest(VARIABLES.party));
  big.emit('data', Buffer.alloc(2 * 1024 * 1024, 0x41));
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.PROTOCOL);
  assert.ok(big.destroyed, 'cut before reading it all');
});

test('a Modbus exception is "refused", with its code', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket);
  const request = session.request(writeRequest(VARIABLES.party, '1'));
  socket.emit('data', frame(socket.written[0].readUInt16BE(0), Buffer.from([0x90, 3])));
  await assert.rejects(request, (err) => err.kind === ERROR_KINDS.REFUSED && err.code === 3);
});

test('r1 I5: only the whitelist is ever written (never the standby, never stage 0)', () => {
  assert.throws(() => writeRequest(VARIABLES.standby, '1'), /bad write/);
  assert.throws(() => writeRequest(VARIABLES.standby, '0'), /bad write/);
  assert.throws(() => writeRequest(VARIABLES.fanStage, '0'), /bad write/);
  assert.throws(() => writeRequest(VARIABLES.fanStage, '5'), /bad write/);
  assert.throws(() => writeRequest(VARIABLES.mode, '2'), /bad write/);
  assert.throws(() => writeRequest(VARIABLES.party, '2'), /bad write/);
  assert.throws(() => writeRequest({ name: 'v01031' }, '0'), /bad write/);
  for (const [variable, value] of [
    [VARIABLES.party, '0'],
    [VARIABLES.party, '1'],
    [VARIABLES.mode, '0'],
    [VARIABLES.mode, '1'],
    [VARIABLES.fanStage, '1'],
    [VARIABLES.fanStage, '4'],
  ]) {
    assert.ok(writeRequest(variable, value));
  }
});

test('r1 I4, M2: the model name, -0 and a CO2 below 250 ppm', () => {
  for (const raw of ['-', '--', ' - ', '<img src=x onerror=1>', 'KWL;rm', '"x"', '.', '']) {
    assert.equal(decodeValue(VARIABLES.article, raw), undefined, JSON.stringify(raw));
  }
  assert.equal(decodeValue(VARIABLES.article, 'KWL EC 300 W R'), 'KWL EC 300 W R');
  assert.equal(decodeValue(VARIABLES.article, 'KWL 270/370 (D) +'), 'KWL 270/370 (D) +');
  assert.ok(Object.is(decodeValue(VARIABLES.outdoor, '-0.0'), 0));
  assert.equal(decodeValue(VARIABLES.co2_1, '0'), undefined);
  assert.equal(decodeValue(VARIABLES.co2_1, '249'), undefined);
  assert.equal(decodeValue(VARIABLES.co2_1, '400'), 400);
});

test('r1 I3: a request past its deadline is never sent; one request at a time', async () => {
  const late = new Socket();
  let now = 1_000;
  const session = new ModbusSession(late, { now: () => now });
  await assert.rejects(
    session.request(writeRequest(VARIABLES.party, '1'), { startBy: 999 }),
    (err) => err.kind === ERROR_KINDS.LATE && !err.sent,
  );
  assert.equal(late.written.length, 0, 'nothing sent');
  now = 0;
  const first = session.request(readRequest(VARIABLES.party), { startBy: 999 });
  await assert.rejects(
    session.request(readRequest(VARIABLES.mode)),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  assert.equal(late.written.length, 1, 'the second request never left');
  session.close();
  await assert.rejects(first);
});
