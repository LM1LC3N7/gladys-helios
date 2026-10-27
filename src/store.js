// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the time of the last read of the unit (written at most once a minute,
//     BEFORE the read), so a restart never reads the unit sooner than the
//     interval;
//   - the identity of the unit (the MAC address of its easyControls board)
//     for the address of the configuration;
//   - the address of the configuration, so a party stop pressed (or kept
//     unconfirmed) before the configuration is read still reaches the unit;
//   - the external sensors seen on the unit (their features are never lost);
//   - a party stop guard (see src/app.js).
// No secret (the Modbus interface has none), no personal data. The file is
// readable by the container user only (0600), bounded and repaired when read
// back. A missing file is an empty state; a file that cannot be read or
// parsed is NOT: load() throws, and the app then neither learns a new
// identity nor overwrites the file.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseAddress } from './config.js';
import { EXTERNAL_KEYS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/helios-state.json';
const MAX_FILE = 8 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw new Error('state file unreadable', { cause: err });
      }
      if (text.length > MAX_FILE) {
        throw new Error('state file too large');
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('state file not JSON', { cause: err });
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failSave`/`failLoad` simulate a broken /data. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failSave: false,
    failLoad: false,
    async load() {
      if (this.failLoad) throw new Error('state file unreadable');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failSave) throw new Error('read-only file system');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

const count = (value, max) => (Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0);

/** A host and port valid for the configuration (same rules), else undefined. */
function address(raw) {
  const a = object(raw);
  const host = shortText(a?.host, 253);
  return host && Number.isInteger(a?.port) ? parseAddress(`${host}:${a.port}`) : undefined;
}

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null;
 * - `identity`: `{ unit, mac }` for the unit `unit` (its address), or null;
 * - `address`: `{ host, port }` of the last configuration, or null;
 * - `sensors`: `{ unit, keys }`, the external sensors seen, or null;
 * - `stopGuard`: `{ unit, host, port, pending, reasserts, seenOff, onStreak,
 *   stickyUntil }` (a party stop guard; `stickyUntil` wall time or null), or
 *   null. The guard itself has no end time: it is never lifted by the time.
 */
export function normalizeMemory(raw, now) {
  const data = object(raw) ?? {};
  const identity = object(data.identity);
  const sensors = object(data.sensors);
  const guard = object(data.stopGuard);
  const unit = shortText(identity?.unit, 280);
  const mac = shortText(identity?.mac, 17);
  const sensorsUnit = shortText(sensors?.unit, 280);
  const keys = Array.isArray(sensors?.keys)
    ? [...new Set(sensors.keys.filter((k) => EXTERNAL_KEYS.includes(k)))]
    : [];
  const guardUnit = shortText(guard?.unit, 280);
  const guardAddress = address(guard);
  const sticky = guard?.stickyUntil;
  return {
    // A time in the future (a clock set back) counts as now: never a read sooner than the interval.
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: unit && mac && /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? { unit, mac } : null,
    address: address(data.address) ?? null,
    sensors: sensorsUnit && keys.length > 0 ? { unit: sensorsUnit, keys } : null,
    stopGuard:
      guardUnit && guardAddress
        ? {
            unit: guardUnit,
            ...guardAddress,
            pending: guard.pending === true,
            reasserts: count(guard.reasserts, 3),
            seenOff: guard.seenOff === true,
            onStreak: count(guard.onStreak, 2),
            // Beyond its longest length from now (a clock set back), the window is not trusted.
            stickyUntil:
              Number.isFinite(sticky) && sticky > now && sticky <= now + TIMINGS.stickyWindow
                ? sticky
                : null,
          }
        : null,
  };
}
