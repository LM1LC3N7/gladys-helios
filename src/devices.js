// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:helios:unit`: one device per integration. FROZEN RULE: the
// device is keyed by the unit of the configuration, never by its IP address
// nor its MAC address (a new address or a replaced board keeps the device
// and its history; the MAC address is the identity checked before every read
// and command, src/app.js). The feature roles (the last part of their
// external ids) are published forever: never rename them. Every base role is
// always built; an external sensor (humidity-1..8, co2-1..8), once seen, is
// always built again (kept in /data and taken from the device Gladys has), so
// a republished device never loses a feature.
//
// No switch, no writable binary, no writable fan: a "turn everything off"
// (Google Home, Alexa, HomeKit, MCP, `switch.*` scenes) never reaches the
// ventilation. The commands are two `text/select` features (the operating
// mode, the fan stage 1-4) and `button/push` features (party mode start and
// stop); all are refused unless the configuration allows the commands,
// except "Stop the party mode" (src/app.js). Fan stage 0 (fans off) and the
// standby mode are never offered.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, % on
// humidity-sensor, ppm on co2-sensor, minutes and days on duration. The fan
// speeds in rpm and the fan level in % have no unit in the core: `unknown`
// sensors whose name says the unit.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COMMANDS, EXTERNAL_KEYS, FAN_STAGES, FEATURES, MODES, externalRole } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, STAGE_NAMES, word } from './i18n.js';

export const SERVICE = 'helios';
export const PLATFORM_ID = 'unit';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -40,
  max: 80,
});
const rpm = sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 9998 });
const minutesLeft = sensor({
  category: C.DURATION,
  type: T.DURATION.INTEGER,
  unit: U.MINUTES,
  min: 0,
  max: 180,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const humidity = sensor({
  category: C.HUMIDITY_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const co2 = sensor({
  category: C.CO2_SENSOR,
  type: T.SENSOR.INTEGER,
  unit: U.PPM,
  min: 0,
  max: 9998,
});

/** The base features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: select,
  [FEATURES.FAN_STAGE]: select,
  [FEATURES.FAN_PERCENT]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 100 }),
  [FEATURES.PARTY]: binary,
  [FEATURES.PARTY_LEFT]: minutesLeft,
  [FEATURES.STANDBY]: binary,
  [FEATURES.STANDBY_LEFT]: minutesLeft,
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXHAUST]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.SUPPLY_RPM]: rpm,
  [FEATURES.EXTRACT_RPM]: rpm,
  [FEATURES.FILTER_DUE]: binary,
  [FEATURES.FILTER_DAYS]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.DAYS,
    min: 0,
    max: 3650,
  }),
  [FEATURES.FAULT]: binary,
  [FEATURES.WARNING]: binary,
  [FEATURES.PARTY_START]: button,
  [FEATURES.PARTY_STOP]: button,
};

/** The definition of an external sensor role. */
export const externalDefinition = (role) => (role.startsWith('co2-') ? co2 : humidity);

export const BASE_ROLES = Object.keys(DEFINITIONS);
export const EXTERNAL_ROLES = EXTERNAL_KEYS.map(externalRole);
export const ROLES = [...BASE_ROLES, ...EXTERNAL_ROLES];

/** The value read for each numeric or binary base role. */
const VALUE_OF = {
  [FEATURES.FAN_PERCENT]: 'fanPercent',
  [FEATURES.PARTY]: 'party',
  [FEATURES.PARTY_LEFT]: 'partyLeft',
  [FEATURES.STANDBY]: 'standby',
  [FEATURES.STANDBY_LEFT]: 'standbyLeft',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXHAUST]: 'exhaust',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.SUPPLY_RPM]: 'supplyRpm',
  [FEATURES.EXTRACT_RPM]: 'extractRpm',
  [FEATURES.FILTER_DUE]: 'filterDue',
  [FEATURES.FILTER_DAYS]: 'filterDays',
  [FEATURES.FAULT]: 'fault',
  [FEATURES.WARNING]: 'warning',
};
for (const key of EXTERNAL_KEYS) {
  VALUE_OF[externalRole(key)] = key;
}

export const unitIds = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

const options = (values, names, language) =>
  values.map((value, index) => ({
    value,
    label: word(names[value], language),
    sort_order: index,
  }));

/**
 * The Gladys device of the unit: every base feature, and the external
 * sensors of `externals` (their keys), in a fixed order.
 */
export function buildDevice(gladys, { language, externals = [], model }) {
  const ids = unitIds(gladys);
  const present = new Set(externals.map(externalRole));
  const roles = [...BASE_ROLES, ...EXTERNAL_ROLES.filter((r) => present.has(r))];
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: model ? `Helios ${model}` : 'Helios KWL EC (easyControls)',
    should_poll: false,
    features: roles.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...(DEFINITIONS[role] ?? externalDefinition(role)),
      ...(role === FEATURES.MODE
        ? { supported_options: options(MODES, MODE_NAMES, language) }
        : {}),
      ...(role === FEATURES.FAN_STAGE
        ? { supported_options: options(FAN_STAGES, STAGE_NAMES, language) }
        : {}),
    })),
    params: [{ name: 'protocol', value: 'Modbus TCP (easyControls)' }],
  };
}

/** Whether a role is a command, and which. */
export const commandOf = (role) => (Object.hasOwn(COMMANDS, role) ? COMMANDS[role] : undefined);

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Select texts are stable keys, whatever
 * the language (scenes keep working).
 */
export function deviceStates(ids, values) {
  const states = [];
  if (values.mode === 0 || values.mode === 1) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.MODE),
      text: MODES[values.mode],
    });
  }
  // The list only shows its options: fan stage 0 (fans off) does not change it.
  if (Number.isInteger(values.fanStage) && values.fanStage >= 1 && values.fanStage <= 4) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.FAN_STAGE),
      text: String(values.fanStage),
    });
  }
  const derived = {
    ...values,
    fault: Number.isInteger(values.errors) ? values.errors !== 0 : undefined,
    warning: Number.isInteger(values.warnings) ? values.warnings !== 0 : undefined,
    filterDays: Number.isInteger(values.filterMinutes)
      ? Math.floor(values.filterMinutes / 1440)
      : undefined,
  };
  for (const [role, key] of Object.entries(VALUE_OF)) {
    let value = derived[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    const { min, max } = DEFINITIONS[role] ?? externalDefinition(role);
    if (Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
