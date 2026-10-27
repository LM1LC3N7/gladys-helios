// -----------------------------------------------------------------------------
// The states of a read: a value outside the bounds of its feature is dropped.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceStates } from '../src/devices.js';

const ids = { feature: (role) => role };
const roles = (values) => deviceStates(ids, values).map((s) => s.device_feature_external_id);

test('values outside the bounds of their feature are not published', () => {
  assert.deepEqual(roles({ filterMinutes: 3651 * 1440 }), []);
  assert.deepEqual(roles({ filterMinutes: 3650 * 1440 }), ['filter-days-left']);
  assert.deepEqual(roles({ fanPercent: 101, partyLeft: 181, supplyRpm: 9999, outdoor: 81 }), []);
  assert.deepEqual(
    roles({ fanStage: 0, mode: 2 }),
    [],
    'stage 0 and unknown modes not in the lists',
  );
  assert.deepEqual(roles({ co2_1: -1, humidity1: 100.5 }), []);
});
