// -----------------------------------------------------------------------------
// The Helios easyControls variables over Modbus TCP (pure, no I/O): the
// requests and the decoding of the answers. The framing follows the Helios
// document "Modbus Gateway TCP/IP" (82 269-001/09.17) and eazyctrl (BSD
// 2-Clause, the library of the Home Assistant integration), see
// THIRD_PARTY_NOTICES.md.
//
// Every answer is hostile until checked: the register count and byte count
// exact, the text printable ASCII ended by a NUL inside the registers read,
// the variable name the one asked (another Modbus client may have selected
// another variable between our two requests), and the value strictly of its
// kind (an empty value or "-" is unknown, never 0).
// -----------------------------------------------------------------------------

import { FC, MIN_REGISTERS, START_ADDRESS } from '../constants.js';

const NAME = /^v\d{5}$/;

/** The registers that hold `characters` ASCII characters and the NUL, at least 4. */
export const registersFor = (characters) =>
  Math.max(MIN_REGISTERS, Math.ceil((characters + 1) / 2));

/** Function 16 from address 1 with an ASCII text and its NUL, padded to whole registers. */
function writeText(text) {
  const count = registersFor(text.length);
  const pdu = Buffer.alloc(6 + count * 2);
  pdu[0] = FC.WRITE_MULTIPLE;
  pdu.writeUInt16BE(START_ADDRESS, 1);
  pdu.writeUInt16BE(count, 3);
  pdu[5] = count * 2;
  pdu.write(text, 6, 'ascii');
  return pdu;
}

/** Step 1 of a read: selects the variable (writes "vXXXXX\0"). */
export function selectRequest(variable) {
  if (!NAME.test(variable.name)) {
    throw new Error('bad variable name');
  }
  return writeText(variable.name);
}

/** The registers read for a variable: its name, "=", its longest value and the NUL. */
export const readCount = (variable) => registersFor(variable.name.length + 1 + variable.len);

/** Step 2 of a read: reads the registers that hold "vXXXXX=value\0". */
export function readRequest(variable) {
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.READ_HOLDING;
  pdu.writeUInt16BE(START_ADDRESS, 1);
  pdu.writeUInt16BE(readCount(variable), 3);
  return pdu;
}

/**
 * The only writes ever built: party mode 0/1, operating mode 0/1, fan stage
 * 1-4 (never 0: fans off; never the standby mode). Anything else throws
 * before a byte is built, whatever the caller asks.
 */
export const WRITABLE = {
  v00094: /^[01]$/,
  v00101: /^[01]$/,
  v00102: /^[1-4]$/,
};

/** A write "vXXXXX=value\0", from the whitelist only. */
export function writeRequest(variable, value) {
  const allowed = Object.hasOwn(WRITABLE, variable?.name) ? WRITABLE[variable.name] : undefined;
  if (!allowed || typeof value !== 'string' || !allowed.test(value)) {
    throw new Error('bad write');
  }
  return writeText(`${variable.name}=${value}`);
}

/** The answer to a function 16 request: the function, the address and the count, nothing else. */
export function isWriteEcho(request, pdu) {
  return Buffer.isBuffer(pdu) && pdu.length === 5 && pdu.equals(request.subarray(0, 5));
}

/**
 * The text of a read answer: `{ text }` when well formed (byte count exact,
 * printable ASCII up to a NUL inside the registers read), else `{ error }`:
 * 'size' (the frame does not match the request: the session is not trusted
 * any more), 'truncated' (no NUL: the value is longer than expected) or
 * 'garbled' (a byte that is not printable ASCII).
 */
export function answerText(variable, pdu) {
  const count = readCount(variable);
  if (!Buffer.isBuffer(pdu) || pdu.length !== 2 + count * 2 || pdu[1] !== count * 2) {
    return { error: 'size' };
  }
  const data = pdu.subarray(2);
  const end = data.indexOf(0);
  if (end < 0) {
    return { error: 'truncated' };
  }
  for (let i = 0; i < end; i += 1) {
    if (data[i] < 0x20 || data[i] > 0x7e) {
      return { error: 'garbled' };
    }
  }
  return { text: data.toString('ascii', 0, end) };
}

/**
 * The value of a variable from the text read: `{ value }` (undefined when
 * unknown: empty, "-", out of its range or not of its kind) or
 * `{ other: true }` when the text is the answer for another variable (the
 * selection was changed by another Modbus client meanwhile).
 */
export function parseValue(variable, text) {
  const prefix = `${variable.name}=`;
  if (typeof text !== 'string' || !text.startsWith(prefix)) {
    return { other: true };
  }
  return { value: decodeValue(variable, text.slice(prefix.length)) };
}

/** A value of its kind, else undefined (never 0 for something unreadable). */
export function decodeValue(variable, raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > variable.len) {
    return undefined;
  }
  switch (variable.kind) {
    case 'bool':
      return raw === '1' ? true : raw === '0' ? false : undefined;
    case 'int': {
      if (!/^\d{1,10}$/.test(raw)) return undefined;
      const value = Number(raw);
      return value >= variable.min && value <= variable.max ? value : undefined;
    }
    case 'float': {
      if (!/^-?\d{1,4}(?:\.\d{1,2})?$/.test(raw)) return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < variable.min || value > variable.max) {
        return undefined;
      }
      // + 0 turns -0 into 0.
      return (variable.round ? Math.round(value) : Math.round(value * 10) / 10) + 0;
    }
    case 'mac': {
      if (!/^[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}$/.test(raw)) return undefined;
      const mac = raw.toUpperCase().replaceAll('-', ':');
      return /^(?:00:){5}00$|^(?:FF:){5}FF$/.test(mac) ? undefined : mac;
    }
    case 'version':
      return /^\d{1,2}\.\d{2}$/.test(raw) ? raw : undefined;
    case 'text': {
      // A model name: letters, digits, space and . _ / ( ) + - only; "-" or
      // punctuation alone is no name.
      const value = raw.trim();
      return /^[A-Za-z0-9 ._/()+-]{1,31}$/.test(value) && /[A-Za-z0-9]/.test(value)
        ? value
        : undefined;
    }
    default:
      return undefined;
  }
}
