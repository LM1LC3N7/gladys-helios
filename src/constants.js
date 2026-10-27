// -----------------------------------------------------------------------------
// Helios constants: the Modbus TCP interface of the easyControls board,
// manifest keys, feature roles, limits and timings.
//
// The Helios KWL EC units with easyControls (software 2.01 or later) answer
// Modbus TCP on port 502, unit id 180 (both fixed), without authentication.
// The interface is the one Helios publishes in "Modbus Gateway TCP/IP"
// (print no. 82 269-001/09.17): holding registers only, from PDU address 1,
// holding ASCII strings ended by NUL:
//   - a write is "vXXXXX=value\0" (function 16, "write multiple registers");
//   - a read is two steps: write "vXXXXX\0" (function 16), then read the
//     registers from address 1 (function 3), which hold "vXXXXX=value\0";
//     count = (characters + NUL) / 2, rounded up, at least 4.
// Only the variables below are ever read, and only v00094 (party mode),
// v00101 (operating mode) and v00102 (fan stage) are ever written, with the
// values listed in COMMANDS.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** The Modbus address of the unit: always 180 (Helios, chapter 1.3). */
export const UNIT_ID = 180;

/** The register every request starts at: always 1 (PDU address, Helios chapter 1.3). */
export const START_ADDRESS = 1;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  WRITE_MULTIPLE: 0x10,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** Fewer registers than this are refused by the unit (ILLEGAL_DATA_ADDRESS). */
export const MIN_REGISTERS = 4;

/**
 * The variables read, from the Helios list (chapter 4), with the length of
 * their value (`len`, the "Type" column char[n]) and how a value is decoded:
 *   - `int`: digits only, within min..max;
 *   - `float`: an optional minus, digits, an optional decimal part; "-" (no
 *     sensor, Helios: value >= 9999) and anything outside min..max unknown;
 *   - `bool`: "0" or "1" only;
 *   - `mac`, `version`, `text`: identity and information.
 * An empty value ("vXXXXX=", an unknown variable) is unknown, never 0.
 * `group`: `state` (never skipped), `measure` (skipped an hour after a
 * refusal or repeated timeouts), `secondary` (errors, warnings, infos: never
 * holds the values back), `identity`, `info` (read at the first read, then
 * hourly), `external` (external sensors, probed hourly, then read when
 * present).
 */
export const VARIABLES = {
  mac: { name: 'v00002', len: 18, kind: 'mac', group: 'identity' },
  article: { name: 'v00000', len: 31, kind: 'text', group: 'info' },
  software: { name: 'v01101', len: 5, kind: 'version', group: 'info' },
  mode: { name: 'v00101', len: 1, kind: 'int', min: 0, max: 1, group: 'state' },
  fanStage: { name: 'v00102', len: 1, kind: 'int', min: 0, max: 4, group: 'state' },
  party: { name: 'v00094', len: 1, kind: 'bool', group: 'state' },
  standby: { name: 'v00099', len: 1, kind: 'bool', group: 'state' },
  fanPercent: { name: 'v00103', len: 3, kind: 'int', min: 0, max: 100, group: 'measure' },
  outdoor: { name: 'v00104', len: 7, kind: 'float', min: -40, max: 80, group: 'measure' },
  supply: { name: 'v00105', len: 7, kind: 'float', min: -40, max: 80, group: 'measure' },
  exhaust: { name: 'v00106', len: 7, kind: 'float', min: -40, max: 80, group: 'measure' },
  extract: { name: 'v00107', len: 7, kind: 'float', min: -40, max: 80, group: 'measure' },
  partyLeft: { name: 'v00093', len: 3, kind: 'int', min: 0, max: 180, group: 'measure' },
  standbyLeft: { name: 'v00098', len: 3, kind: 'int', min: 0, max: 180, group: 'measure' },
  supplyRpm: { name: 'v00348', len: 4, kind: 'int', min: 0, max: 9998, group: 'measure' },
  extractRpm: { name: 'v00349', len: 4, kind: 'int', min: 0, max: 9998, group: 'measure' },
  filterDue: { name: 'v01031', len: 1, kind: 'bool', group: 'measure' },
  filterMinutes: {
    name: 'v01033',
    len: 10,
    kind: 'int',
    min: 0,
    max: 0xffffffff,
    group: 'measure',
  },
  errors: { name: 'v01123', len: 10, kind: 'int', min: 0, max: 0xffffffff, group: 'secondary' },
  warnings: { name: 'v01124', len: 3, kind: 'int', min: 0, max: 255, group: 'secondary' },
  infos: { name: 'v01125', len: 3, kind: 'int', min: 0, max: 255, group: 'secondary' },
};

/**
 * The external sensors (KWL-FTF humidity, KWL-CO2), 1 to 8 each. Helios
 * lists them as char[4] but also "Format = .1f" for some: read as up to 7
 * characters (more registers than needed come back filled with zeros).
 */
export const EXTERNAL_COUNT = 8;
for (let i = 1; i <= EXTERNAL_COUNT; i += 1) {
  VARIABLES[`humidity${i}`] = {
    name: `v${String(110 + i).padStart(5, '0')}`,
    len: 7,
    kind: 'float',
    min: 0,
    max: 100,
    group: 'external',
  };
  VARIABLES[`co2_${i}`] = {
    name: `v${String(127 + i).padStart(5, '0')}`,
    len: 7,
    kind: 'float',
    min: 0,
    max: 9998,
    round: true,
    group: 'external',
  };
}

/** The keys of the external sensors, in display order. */
export const EXTERNAL_KEYS = [
  ...Array.from({ length: EXTERNAL_COUNT }, (_, i) => `humidity${i + 1}`),
  ...Array.from({ length: EXTERNAL_COUNT }, (_, i) => `co2_${i + 1}`),
];

/** The poll order: the identity first, then the state, then the rest. */
export const POLL_ORDER = [
  'mac',
  'mode',
  'fanStage',
  'party',
  'standby',
  'fanPercent',
  'outdoor',
  'supply',
  'exhaust',
  'extract',
  'partyLeft',
  'standbyLeft',
  'supplyRpm',
  'extractRpm',
  'filterDue',
  'filterMinutes',
  'errors',
  'warnings',
  'infos',
];

/** Read at the first read, then hourly. */
export const INFO_KEYS = ['article', 'software'];

/** The operating mode (v00101): 0 automatic, 1 manual. */
export const MODES = ['auto', 'manual'];

/** The fan stages Gladys may write (v00102). Stage 0 (fans off) is read only, never written. */
export const FAN_STAGES = ['1', '2', '3', '4'];

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5 acknowledge,
 * 6 busy…) may come from a write the unit applies anyway: "sent, without
 * confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'operating-mode',
  FAN_STAGE: 'fan-stage',
  FAN_PERCENT: 'fan-percent',
  PARTY: 'party',
  PARTY_LEFT: 'party-minutes-left',
  STANDBY: 'standby',
  STANDBY_LEFT: 'standby-minutes-left',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXHAUST: 'temperature-exhaust',
  TEMP_EXTRACT: 'temperature-extract',
  SUPPLY_RPM: 'fan-supply-rpm',
  EXTRACT_RPM: 'fan-extract-rpm',
  FILTER_DUE: 'filter-change',
  FILTER_DAYS: 'filter-days-left',
  FAULT: 'fault',
  WARNING: 'warning',
  PARTY_START: 'party-start',
  PARTY_STOP: 'party-stop',
};

/** The feature role of an external sensor key (humidity3 -> humidity-3, co2_5 -> co2-5). */
export const externalRole = (key) => key.replace('_', '-').replace(/^humidity(\d)$/, 'humidity-$1');

/**
 * The commands, by feature role: the variable written, the value written for
 * each choice, the value read back that confirms it.
 * `needsRunning`: may start the fans, so a unit in stand-by or at fan stage 0
 * refuses it. `needsManual`: refused unless the unit is in manual mode (in
 * automatic mode, the unit sets the stage itself). `protective`: never held
 * back by the option nor by another command (stopping the party mode).
 */
export const COMMANDS = {
  [FEATURES.MODE]: {
    variable: 'mode',
    values: { auto: '0', manual: '1' },
    expected: { auto: 0, manual: 1 },
    needsRunning: true,
  },
  [FEATURES.FAN_STAGE]: {
    variable: 'fanStage',
    values: { 1: '1', 2: '2', 3: '3', 4: '4' },
    expected: { 1: 1, 2: 2, 3: 3, 4: 4 },
    needsRunning: true,
    needsManual: true,
  },
  [FEATURES.PARTY_START]: {
    variable: 'party',
    button: ['1', true],
    needsRunning: true,
  },
  [FEATURES.PARTY_STOP]: {
    variable: 'party',
    button: ['0', false],
    protective: true,
  },
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** A measure that times out this many reads in a row (the unit answering others) is skipped. */
  variableTimeouts: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a party stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A measure skipped after repeated timeouts or refusals, the information and the external sensors: this often. */
  variableRetry: HOUR,
  /** A party stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** getConfig() failing at a connection to Gladys: tried again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the connection, the fresh read
   * and the write must be done by 3.5 s after the click, or the command is
   * refused unsent; the read back that confirms it is awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Connecting for a command: 1.5 s at most. */
  commandConnectMax: 1_500,
  /** One request of a fresh read: 1 s at most; 0.3 s at least left to send after it. */
  commandReadMax: 1_000,
  commandMinRead: 200,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /**
   * A party stop after a party start not confirmed: for 2 minutes, the party
   * read on again is taken for that start landing late, and the stop is sent
   * again. A party stop is sent again three times at most.
   */
  stickyWindow: 2 * MINUTE,
  stopReasserts: 3,
  /** The party read on this many reads in a row (after the stop took effect): started elsewhere. */
  changedElsewhereReads: 2,
};
