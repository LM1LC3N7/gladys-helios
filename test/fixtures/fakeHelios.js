// -----------------------------------------------------------------------------
// A fake Helios easyControls unit behind the injected `connect` (no network),
// or behind a real local TCP server (`respond` shared): Modbus TCP framing
// (MBAP, unit id 180), the selection of a variable by function 16 and its
// read by function 3 from address 1, writes applied, answers after a delay
// (mocked timers). It counts the connections open at once (the integration
// must never open a second one). Values made up, never from a real unit.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.90';
export const MAC = '00:0A:5C:11:22:33';
export const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

/** A unit in manual mode at stage 2, no party, no standby, no fault, external sensors 1. */
export function defaultVars() {
  const vars = new Map([
    ['v00000', 'KWL EC 300 W R'],
    ['v00002', MAC],
    ['v01101', '2.27'],
    ['v00101', '1'],
    ['v00102', '2'],
    ['v00094', '0'],
    ['v00099', '0'],
    ['v00103', '50'],
    ['v00104', '-5.2'],
    ['v00105', '18.5'],
    ['v00106', '1.0'],
    ['v00107', '21.4'],
    ['v00093', '0'],
    ['v00098', '0'],
    ['v00348', '1250'],
    ['v00349', '1300'],
    ['v01031', '0'],
    ['v01033', '129600'],
    ['v01123', '0'],
    ['v01124', '0'],
    ['v01125', '0'],
  ]);
  for (let i = 1; i <= 8; i += 1) {
    vars.set(`v${String(110 + i).padStart(5, '0')}`, '-');
    vars.set(`v${String(127 + i).padStart(5, '0')}`, '-');
  }
  vars.set('v00111', '45');
  vars.set('v00128', '650');
  return vars;
}

/** The writable variables and their values (Helios list): anything else is refused. */
const WRITABLE = {
  v00094: /^[01]$/,
  v00101: /^[01]$/,
  v00102: /^[1-4]$/,
};

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.unit.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unit.open.delete(this);
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

export function fakeHelios({ vars = defaultVars() } = {}) {
  const unit = {
    vars,
    /** The variable selected (one for the whole unit, as on the board). */
    selected: undefined,
    open: new Set(),
    maxOpen: 0,
    /** Every request received: { fc, text } for function 16, { fc, count } for function 3. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Variable names whose selection never answers, or answers an exception. */
    silent: new Set(),
    exceptions: new Set(),
    exceptionCode: 2,
    /** Writes acknowledged but not applied. */
    ignoreWrites: false,
    /** Delays of the next writes (one each), and writes applied after their connection closed. */
    writeDelays: [],
    applyClosedWrites: false,
    /** The next connections accepted then closed at once. */
    dropConnections: 0,
    /** Selected name -> another name: another client selects it right before our read (once). */
    clashes: new Map(),
    /** Answers split in two chunks, or with a wrong transaction id, or a wrong echo. */
    split: false,
    wrongTransaction: false,
    badEcho: false,
    /** Variable names read back with one register too few (a frame of the wrong size). */
    shortReads: new Set(),
    /** Called with each write applied ("v00094=1"). */
    onWrite: undefined,
    /** The answer PDU of one request (no MBAP), or undefined for no answer. */
    respond(pdu) {
      const fc = pdu[0];
      if (fc === 0x10) {
        const count = pdu.readUInt16BE(3);
        const data = pdu.subarray(6, 6 + pdu[5]);
        const end = data.indexOf(0);
        const text = data.toString('ascii', 0, end < 0 ? data.length : end);
        unit.log.push({ fc, text });
        const [name, value] = text.split('=');
        if (unit.silent.has(name)) return undefined;
        if (unit.exceptions.has(name)) return Buffer.from([0x90, unit.exceptionCode]);
        if (count < 4 || end < 0) return Buffer.from([0x90, 2]);
        if (value !== undefined) {
          if (!WRITABLE[name]?.test(value)) return Buffer.from([0x90, 3]);
          if (!unit.ignoreWrites) {
            unit.vars.set(name, value);
            unit.onWrite?.(text);
          }
        }
        unit.selected = name;
        const echo = Buffer.from(pdu.subarray(0, 5));
        if (unit.badEcho) echo[4] ^= 1;
        return echo;
      }
      if (fc === 0x03) {
        const count = pdu.readUInt16BE(3);
        unit.log.push({ fc, count });
        if (count < 4 || pdu.readUInt16BE(1) !== 1) return Buffer.from([0x83, 2]);
        if (unit.clashes.has(unit.selected)) {
          const other = unit.clashes.get(unit.selected);
          unit.clashes.delete(unit.selected);
          unit.selected = other;
        }
        const name = unit.selected ?? 'v00000';
        const text = `${name}=${unit.vars.get(name) ?? ''}`;
        const registers = unit.shortReads.has(name) ? count - 1 : count;
        const out = Buffer.alloc(2 + registers * 2);
        out[0] = 3;
        out[1] = registers * 2;
        // Too few registers: the text cut (no NUL), as Helios describes it.
        Buffer.from(text, 'ascii').copy(out, 2, 0, Math.min(text.length, registers * 2));
        return out;
      }
      return Buffer.from([fc | 0x80, 1]);
    },
    frame(request) {
      const pdu = unit.respond(request.subarray(7));
      if (!pdu) return undefined;
      const out = Buffer.alloc(7 + pdu.length);
      const tid = request.readUInt16BE(0);
      out.writeUInt16BE(unit.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
      out.writeUInt16BE(0, 2);
      out.writeUInt16BE(pdu.length + 1, 4);
      out[6] = request[6];
      pdu.copy(out, 7);
      return out;
    },
    handle(socket, request) {
      const pdu = request.subarray(7);
      const isWrite = pdu[0] === 0x10 && pdu.subarray(6).includes(0x3d);
      const writeDelay =
        isWrite && unit.writeDelays.length > 0 ? unit.writeDelays.shift() : undefined;
      setTimeout(() => {
        if (socket.destroyed) {
          // A write already in the unit is applied even when its connection is gone.
          if (isWrite && unit.applyClosedWrites) unit.respond(pdu);
          return;
        }
        if (request[6] !== 180) return;
        const out = unit.frame(request);
        if (!out) return;
        if (unit.split) {
          socket.emit('data', out.subarray(0, 3));
          socket.emit('data', out.subarray(3));
        } else {
          socket.emit('data', out);
        }
      }, writeDelay ?? unit.delay);
    },
    connect() {
      const socket = new FakeSocket(unit);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        if (unit.down) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        if (unit.dropConnections > 0) {
          unit.dropConnections -= 1;
          socket.emit('connect');
          setImmediate(() => !socket.destroyed && socket.emit('close'));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
    /** The writes received ("v00094=0"), in order. */
    writes: () => unit.log.filter((r) => r.fc === 0x10 && r.text.includes('=')).map((r) => r.text),
    /** The variables selected for a read, in order. */
    selections: () =>
      unit.log.filter((r) => r.fc === 0x10 && !r.text.includes('=')).map((r) => r.text),
    get: (name) => unit.vars.get(name),
  };
  unit.connectFn = () => unit.connect();
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
