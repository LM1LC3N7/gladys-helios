// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (its IP address), one
// read of its variables every poll interval over one Modbus TCP connection,
// the Gladys device and its states, the transport badge, the "Test the
// connection" button, and the commands. index.js only wires the SDK handlers
// to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session (two requests per variable: select, then read),
// closed after; a command takes the line from a poll (the poll is dropped,
// nothing of it published); "Stop the party mode" takes it from anything.
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//     a reconnection during a read joins it;
//   - the MAC address of the unit is read first: another one (another device
//     at the address) publishes nothing and refuses the commands; an
//     unreadable one is never "another device";
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied; a value not read this time is never republished as new.
//
// Commands (operating mode, fan stage, party start):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write (nothing runs in between);
//   - decided on a fresh read in the same session (MAC address, standby, fan
//     stage, operating mode or party), never on the state in memory; refused
//     when a value cannot be read; refused in standby or at fan stage 0 (they
//     could start the fans); the fan stage only in manual mode; not written
//     when already so (unless a guard says a previous command may not show
//     yet);
//   - written within 3.5 s of the click or refused unsent; confirmed only by
//     the echo of the write and a read back equal to the value asked, by
//     4.3 s; else "sent, without confirmation" and spaced reads; a Modbus
//     exception 1-3 is "refused by the unit", any other code "sent, without
//     confirmation"; never retried; one at a time;
//   - the ack never waits for a publication to Gladys.
//
// "Stop the party mode" protects: never held back by the option, another
// command, a failed read, a backoff, the identity, a configuration not read
// (it uses the last address kept in /data) nor /data itself; tried again
// until 3.5 s after the press (idempotent write); cancels a command not
// written yet. It leaves a stop guard (kept in /data) that is never lifted
// by the time, only by a party start written from Gladys (option on) or by
// the party read on two reads in a row after the stop took effect (started
// on the unit or by another app). While the stop is not seen applied (or for
// 2 minutes after a party start not confirmed), a read showing the party on
// sends the stop again, three times at most. A stop not confirmed is sent
// again at the start of the container, from /data, before the configuration
// is read.
//
// In-memory times (deadlines, the time of the last read) are on a monotonic
// clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  COMMANDS,
  EXTERNAL_KEYS,
  FEATURES,
  INFO_KEYS,
  LIMITS,
  NOT_APPLIED_EXCEPTIONS,
  POLL_ORDER,
  PRESSED,
  SECOND,
  TIMINGS,
  VARIABLES,
  externalRole,
} from './constants.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  answerText,
  isWriteEcho,
  parseValue,
  readRequest,
  selectRequest,
  writeRequest,
} from './modbus/protocol.js';
import { buildDevice, commandOf, deviceStates, parseFeatureId, unitIds } from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  /** When they were read (monotonic). */
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

const STOP_PLAN = {
  role: FEATURES.PARTY_STOP,
  command: COMMANDS[FEATURES.PARTY_STOP],
  written: '0',
  expected: false,
};

export class HeliosApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'helios' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    /** The configuration was read from Gladys at least once. */
    this.configLoaded = false;
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: nothing is written to it, no identity is learnt. */
    this.memoryUnreadable = false;
    this.booted = undefined;
    this.shutdown = false;
    this.unit = freshUnit();
    this.generation = 0;
    this.connectSeq = 0;
    this.configWait = undefined;
    /** Configurations (connected, saved) applied one at a time, in order. */
    this.configChain = Promise.resolve();
    /** Configurations saved so far: a getConfig() answer older than a save is dropped. */
    this.configSaves = 0;
    this.started = false;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The command in flight (one at a time), and the party stop in flight. */
    this.inFlight = undefined;
    this.protecting = undefined;
    /** Counts the party stops: a command that sees it change before its write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** A party start written and not confirmed yet: a party stop after it gets a sticky window. */
    this.partyStartOpen = false;
    /** The MAC address read when it differs from the one kept for this address. */
    this.mismatch = undefined;
    /** Variable key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The party stop guard (see the header), or undefined. */
    this.stopGuard = undefined;
    /** Variable key -> timeouts in a row while the unit answered the others. */
    this.timeouts = new Map();
    /** Variable key -> when it is tried again (skipped after repeated timeouts or refusals). */
    this.skipped = new Map();
    /** The external sensors present (keys), and when they are probed again. */
    this.externals = new Set();
    this.probeAt = -Infinity;
    /** Model and software version, and when they are read again. */
    this.info = {};
    this.infoAt = -Infinity;
    /** The pending reaffirmation of a party stop. */
    this.reassertTimer = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Before the connection to Gladys: /data is read, and a party stop kept
   * unconfirmed there is sent at once to the address kept with it (no
   * configuration, no read needed). Runs once; every entry point awaits it.
   */
  boot() {
    if (!this.booted) {
      this.booted = (async () => {
        await this.loadMemory();
        const kept = this.memory.stopGuard;
        if (kept) {
          this.stopGuard = {
            unit: kept.unit,
            address: { host: kept.host, port: kept.port },
            sentAt: this.mono(),
            pending: kept.pending,
            reasserts: kept.reasserts,
            seenOff: kept.seenOff,
            onStreak: kept.onStreak,
            stickyUntil:
              kept.stickyUntil === null ? -Infinity : this.mono() + (kept.stickyUntil - this.now()),
          };
          if (kept.pending && kept.reasserts < TIMINGS.stopReasserts) {
            // Counted as a resend: a container restarting in a loop sends it three times at most.
            this.stopGuard.reasserts += 1;
            this.persistStopGuard();
            this.logger.warn('Helios: a party stop kept unconfirmed in /data is sent again');
            this.protect(STOP_PLAN, this.mono(), { keepCount: true }).catch((err) =>
              this.logger.warn(`Helios: party stop at start: ${err.message}`),
            );
          }
        }
      })();
    }
    return this.booted;
  }

  async loadMemory() {
    try {
      this.memory = normalizeMemory(await this.store.load(), this.now());
      this.memoryUnreadable = false;
    } catch (err) {
      // Unreadable is not empty: no identity learnt, nothing overwritten.
      this.memoryUnreadable = true;
      this.logger.warn(`Helios: the state in /data cannot be read (${err.message})`);
    }
  }

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    await this.boot();
    this.stop({ keepProtect: true });
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    this.configLoaded = true;
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    if (this.memoryUnreadable) {
      await this.loadMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    this.unit = freshUnit();
    this.mismatch = undefined;
    this.timeouts.clear();
    this.skipped.clear();
    this.info = {};
    this.infoAt = -Infinity;
    this.probeAt = -Infinity;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.adoptAddress();
    this.publisher.start();
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The unit of the configuration, as kept in /data: its address. */
  unitKey() {
    return this.config.address ? addressKey(this.config.address) : '';
  }

  /**
   * The address of the configuration: kept in /data (for a party stop before
   * the next configuration read); the external sensors and a stop guard of
   * another address are dropped.
   */
  adoptAddress() {
    const key = this.unitKey();
    // Only a valid, different address is another unit: an empty or invalid one keeps the guard.
    if (this.stopGuard && key && this.stopGuard.unit !== key) {
      this.logger.info('Helios: the party stop guard of another address is dropped');
      this.stopGuard = undefined;
      this.persistStopGuard();
    }
    this.externals = new Set(
      this.memory.sensors && this.memory.sensors.unit === key ? this.memory.sensors.keys : [],
    );
    const address = this.config.address ?? null;
    if (address && JSON.stringify(address) !== JSON.stringify(this.memory.address)) {
      this.memory.address = { host: address.host, port: address.port };
      this.saveMemory().catch(() => {});
    }
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    // The wall time kept, as a time of the monotonic clock.
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  /** `keepProtect`: a party stop on the line goes on (a new configuration of the same run). */
  stop({ keepProtect = false } = {}) {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    if (!keepProtect || this.active?.kind !== 'protect') {
      this.active?.abort('stopped');
    }
    this.publisher.stop();
    this.guards.clear();
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
  }

  /** The container stops: everything ends, the stop guard stays in /data. */
  async shutdownApp() {
    this.shutdown = true;
    this.connectSeq += 1;
    this.configWait?.();
    this.stop();
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys (also after every reconnection): the configuration
   * is read, and read again after 5 s, 15 s, 30 s, then every minute while it
   * fails, with a status that says so (never a start on a missing
   * configuration). A newer connection replaces this loop.
   */
  async onConnected(getConfig) {
    await this.boot();
    const seq = ++this.connectSeq;
    for (let attempt = 0; ; attempt += 1) {
      let raw;
      const saves = this.configSaves;
      try {
        raw = await getConfig();
      } catch (err) {
        if (seq !== this.connectSeq || this.shutdown) {
          return;
        }
        const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
        this.logger.warn(
          `Helios: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
        );
        this.lastStatus = undefined;
        await this.setStatus(false, T.configUnreadable(age(wait)));
        await new Promise((resolve) => {
          const handle = this.timers.setTimeout(resolve, wait);
          this.configWait = () => {
            this.timers.clearTimeout(handle);
            resolve();
          };
        });
        this.configWait = undefined;
        if (seq !== this.connectSeq || this.shutdown) {
          return;
        }
        continue;
      }
      if (seq !== this.connectSeq || this.shutdown) {
        return;
      }
      // A configuration saved while this one was read (or queued) is newer: this one is dropped.
      await this.serial(() => (saves === this.configSaves ? this.connected(raw) : undefined));
      return;
    }
  }

  /** Runs `fn` after the configurations received before it (saved in a row: the last one wins). */
  serial(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * The configuration read. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery list, badge),
   * without reading the unit nor republishing old values as new.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.rescheduleOnNewInterval(previous);
    await this.publishAll({ states: false });
  }

  /** Only a new address restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid
    );
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  /**
   * A configuration saved: applied in the order saved (the last one wins);
   * before the first start, it is the start.
   */
  configUpdated(raw = {}) {
    this.configSaves += 1;
    return this.serial(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    await this.boot();
    if (!this.started) {
      this.started = true;
      this.connectSeq += 1;
      this.configWait?.();
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Helios commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
      this.lastStatus = undefined;
      await this.publishAll({ states: false });
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Writes the state to /data; never when it could not be read (it would be overwritten). */
  async saveMemory({ strict = false } = {}) {
    if (this.memoryUnreadable) {
      if (strict) throw new Error('state file unreadable');
      return;
    }
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
      if (strict) throw err;
    }
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection; the line is held until it ends.
   * `retryUntil`: a refused connection is tried again every 250 ms until then
   * (the unit may free its place a moment after our own close); nothing is
   * sent before the connection, so this never repeats a command.
   */
  async useLine(kind, timeoutMs, fn, { retryUntil, address = this.config.address } = {}) {
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: address.host,
          port: address.port,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /**
   * One variable read in `session` (select, then read): `{ value }` (undefined
   * when unknown) or `{ other: true }` (another client selected another
   * variable meanwhile). A frame of the wrong size ends the session.
   */
  async readVariable(session, key, { timeoutMs = TIMINGS.requestTimeout, timeLeft } = {}) {
    const variable = VARIABLES[key];
    const budget = () =>
      timeLeft === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(0, timeLeft()));
    const select = selectRequest(variable);
    const echo = await session.request(select, { timeoutMs: budget() });
    if (!isWriteEcho(select, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the selection'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the selection', { sent: true });
    }
    const pdu = await session.request(readRequest(variable), { timeoutMs: budget() });
    const answer = answerText(variable, pdu);
    if (answer.error === 'size') {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    if (answer.error) {
      return { value: undefined };
    }
    return parseValue(variable, answer.text);
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    // The interval counted from the start of the last read (never sooner), or
    // the backoff after a failure; capped at the interval: a clock jump never
    // stops the reads.
    const untilDue = Math.min(this.interval, this.due - this.mono());
    const base = delay ?? (u.online === false ? u.wait : undefined);
    const wait = Math.max(base ?? 0, untilDue, 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Helios refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it). At
   * most one write a minute.
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    let result;
    let failure;
    try {
      result = await this.useLine('read', TIMINGS.connectTimeout, (session) =>
        this.readAll(session),
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      // A command took the line: nothing of this read is applied.
      this.logger.debug('Helios: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Helios: read begun before a command, not applied');
    } else {
      await this.applyRead(result);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** The variables of this poll, in order: identity, state, measures, then the rare ones. */
  pollKeys() {
    const now = this.mono();
    const keys = [...POLL_ORDER];
    if (now >= this.infoAt) {
      keys.push(...INFO_KEYS);
    }
    const info = now >= this.infoAt;
    const probing = now >= this.probeAt;
    for (const key of EXTERNAL_KEYS) {
      if (this.externals.has(key) || probing) {
        keys.push(key);
      }
    }
    return { keys, probing, info };
  }

  /**
   * Every variable, one after the other. The MAC address first: another one
   * ends the read (nothing of it applied). A variable that times out while
   * the unit answered the ones before ends the read (the session is gone):
   * what was read is kept. A variable refused by the unit (Modbus exception)
   * is unknown this time. A state variable is never skipped; a measure or a
   * secondary one refused, or timing out three reads in a row, is skipped and
   * tried again every hour. Errors, warnings and infos never hold the values
   * back. Another client changing the selection leaves the value unknown.
   */
  async readAll(session) {
    const values = {};
    const { keys, probing, info } = this.pollKeys();
    let answered = 0;
    let complete = true;
    for (const key of keys) {
      const group = VARIABLES[key].group;
      const skippedUntil = this.skipped.get(key);
      if (skippedUntil !== undefined && this.mono() < skippedUntil) {
        continue;
      }
      let read;
      try {
        read = await this.readVariable(session, key);
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          answered += 1;
          if (group === 'state' || group === 'identity') {
            this.logger.warn(`Helios: ${VARIABLES[key].name} refused (${errorReason(err)})`);
          } else {
            if (skippedUntil === undefined && group !== 'external') {
              this.logger.warn(
                `Helios: ${VARIABLES[key].name} refused (${errorReason(err)}), tried again every hour`,
              );
            }
            this.skipped.set(key, this.mono() + TIMINGS.variableRetry);
          }
          continue;
        }
        if (err.kind === ERROR_KINDS.TIMEOUT && answered > 0) {
          const count = (this.timeouts.get(key) ?? 0) + 1;
          this.timeouts.set(key, count);
          if (group !== 'state' && group !== 'identity' && count >= LIMITS.variableTimeouts) {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Helios: ${VARIABLES[key].name} never answers, tried again every hour`,
              );
            }
            this.skipped.set(key, this.mono() + TIMINGS.variableRetry);
          } else {
            this.logger.warn(`Helios: ${VARIABLES[key].name} did not answer`);
          }
          complete = false;
          break;
        }
        throw err;
      }
      answered += 1;
      this.timeouts.delete(key);
      this.skipped.delete(key);
      if (read.other) {
        this.logger.debug(`Helios: ${VARIABLES[key].name}: another client selected a variable`);
        continue;
      }
      if (read.value !== undefined) {
        values[key] = read.value;
      }
      if (key === 'mac' && read.value !== undefined && this.isOtherUnit(read.value)) {
        // Another device at the address: nothing more is read nor applied.
        return { values: { mac: read.value }, probing: false, info: false };
      }
    }
    return { values, probing: probing && complete, info: info && complete };
  }

  /** Whether `mac` differs from the MAC address kept for this address. */
  isOtherUnit(mac) {
    const kept = this.memory.identity;
    return Boolean(kept && kept.unit === this.unitKey() && kept.mac !== mac);
  }

  /** A read: the values of this read only (a value not read is unknown). */
  async applyRead({ values, probing, info }) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    this.checkIdentity(values.mac);
    if (this.mismatch !== undefined) {
      // Another device: its values are never shown.
      u.values = undefined;
      return;
    }
    u.values = values;
    u.readAt = this.mono();
    if (INFO_KEYS.some((k) => values[k] !== undefined)) {
      const model = values.article ?? this.info.article;
      if (model !== this.info.article) this.published = undefined;
      this.info = { article: model, software: values.software ?? this.info.software };
    }
    if (info) {
      this.infoAt = this.mono() + TIMINGS.variableRetry;
    }
    let added = false;
    for (const key of EXTERNAL_KEYS) {
      if (values[key] !== undefined && !this.externals.has(key)) {
        this.externals.add(key);
        added = true;
      }
    }
    if (probing) {
      this.probeAt = this.mono() + TIMINGS.variableRetry;
    }
    if (added) {
      this.memory.sensors = { unit: this.unitKey(), keys: [...this.externals] };
      this.published = undefined;
      await this.saveMemory();
    }
    this.observe(values);
  }

  /**
   * The identity of the unit: the MAC address of its easyControls board,
   * learnt at the first read and kept in /data for this address. Another one
   * means another device answers at the address: nothing of it is published
   * and the commands are refused until the test button accepts it. An
   * unreadable one is never "another device"; with /data unreadable, nothing
   * is learnt.
   */
  checkIdentity(seen) {
    if (seen === undefined) {
      return;
    }
    const kept = this.memory.identity;
    if (!kept || kept.unit !== this.unitKey()) {
      if (this.memoryUnreadable) {
        return;
      }
      this.memory.identity = { unit: this.unitKey(), mac: seen };
      this.mismatch = undefined;
      this.saveMemory().catch(() => {});
      return;
    }
    if (kept.mac === seen) {
      this.mismatch = undefined;
      return;
    }
    if (this.mismatch !== seen) {
      this.logger.warn(
        `Helios: another MAC address at this address (${kept.mac} -> ${seen}); nothing published, commands refused until the test button accepts it`,
      );
    }
    this.mismatch = seen;
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`Helios: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    const now = this.mono();
    const withMemory = (text) =>
      this.memoryUnreadable
        ? both(`${text.en}${T.memoryUnreadable.en}`, `${text.fr}${T.memoryUnreadable.fr}`)
        : text;
    if (!c.address) {
      return c.invalid ? T.invalid(c.invalid) : T.noHost;
    }
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      return withMemory(
        [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
          ? T.unreachable(addressKey(c.address), wait)
          : T.failing(u.error ?? 'error', wait),
      );
    }
    if (u.online === true && this.mismatch !== undefined) {
      return T.otherUnit(this.memory.identity?.mac ?? '?', this.mismatch);
    }
    if (u.online === undefined) {
      return withMemory(u.timer && this.due > now ? T.waiting(age(this.due - now)) : T.connecting);
    }
    return withMemory(T.connected(T.summary(u.values ?? {})));
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = unitIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  /** `states: false` (a reconnection, a new language): status, Discovery, badge only. */
  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) {
      this.queueStates();
      await this.flush();
      if (generation !== this.generation) {
        return;
      }
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The external sensors of the device: those seen, and those the created device has. */
  externalKeys() {
    const keys = new Set(this.externals);
    const ids = unitIds(this.gladys);
    for (const f of this.createdDevice()?.features ?? []) {
      for (const key of EXTERNAL_KEYS) {
        if (f?.external_id === ids.feature(externalRole(key))) keys.add(key);
      }
    }
    return EXTERNAL_KEYS.filter((k) => keys.has(k));
  }

  /** The device, once the unit answered (every base feature, always). */
  async publishDevices() {
    if (this.unit.online !== true || this.mismatch !== undefined) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, {
        language: this.config.language,
        externals: this.externalKeys(),
        model: this.info.article,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      unitIds(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** The values of the last read, only while they are not older than the interval. */
  queueStates(created) {
    const u = this.unit;
    if (u.online === true && u.values && this.mono() - u.readAt <= this.interval) {
      this.queueValues(u.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport:
          online === true && this.mismatch === undefined
            ? DEVICE_TRANSPORTS.LOCAL
            : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its values sent at once when they are recent. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    if (this.mismatch !== undefined) {
      // Accepts exactly the MAC address shown in the status, without a read.
      const accepted = this.mismatch;
      if (this.memoryUnreadable) {
        return this.status();
      }
      this.memory.identity = { unit: this.unitKey(), mac: accepted };
      this.mismatch = undefined;
      await this.saveMemory();
      this.logger.info(`Helios: unit accepted with the MAC address ${accepted}`);
      await this.updateStatus();
      return T.accepted(accepted);
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    const now = this.mono();
    if (now < this.due) {
      const waited = T.waiting(age(this.due - now));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(now - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    let written;
    let expected;
    if (command.button) {
      // Strictly 1: null, '', true, 0 or "on" never press a button.
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      [written, expected] = command.button;
    } else {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !Object.hasOwn(command.values, value)) {
        throw this.refusal(ERRORS.badValue);
      }
      written = command.values[value];
      expected = command.expected[value];
    }
    const plan = { role, command, written, expected };
    if (command.protective) {
      return this.protect(plan, received);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (!this.configLoaded) {
      throw this.refusal(ERRORS.notStarted);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    if (this.memoryUnreadable) {
      throw this.refusal(ERRORS.memoryUnreadable);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values, { fromCommand = false } = {}) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.observe(values, { fromCommand });
    this.queueValues(values);
    // Shown in the background: the ack never waits for Gladys.
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The checks before the write, on the latest configuration.
    const check = () => {
      if (!this.config.allowCommands) {
        throw this.refusal(ERRORS.disabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.protectMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.protectMeanwhile : ERRORS.busy);
      }
      check();
      const connectBudget = Math.min(
        TIMINGS.commandConnectMax,
        sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead - this.mono(),
      );
      if (connectBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      return await this.useLine('command', connectBudget, (session) =>
        this.commandSession(session, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
      if (state.guardLifted && !state.written) {
        // The party start did not leave: the stop guard is kept again in /data.
        this.stopGuard = state.guardLifted;
        this.persistStopGuard();
      }
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (err instanceof Refusal) {
      // Only a reason can be refused after the write: the command may have left.
      if (state.written && !state.refused) {
        return this.unconfirmed(plan, state, err.message);
      }
      return err;
    }
    if (err?.beforeSend) {
      return err;
    }
    const reason = errorReason(err);
    const what = `${plan.role} ${plan.written}`;
    // Only the write says whether the command may have left (a read never does).
    if (!state.written) {
      this.logger.warn(`Helios: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // A Modbus exception to the write: the unit did not apply it.
      this.logger.warn(`Helios: command refused by the unit (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    const key = plan.command.variable;
    this.guards.set(key, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Helios: command sent, NOT confirmed (${plan.role}): ${reason}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async commandSession(session, plan, { check, sendBy, answerBy, state }) {
    const { command } = plan;
    // The state just before acting, read now in this session, never the one in memory:
    // the identity, what would make the command start the fans, and the variable written.
    const keys = [
      ...new Set([
        'mac',
        ...(command.needsRunning ? ['standby', 'fanStage'] : []),
        ...(command.needsManual ? ['mode'] : []),
        command.variable,
      ]),
    ];
    const fresh = {};
    const timeLeft = () => sendBy - TIMINGS.commandMinSend - this.mono();
    for (const key of keys) {
      if (timeLeft() < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      let read;
      try {
        read = await this.readVariable(session, key, {
          timeoutMs: TIMINGS.commandReadMax,
          timeLeft,
        });
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
      if (read.other) {
        throw this.refusal(ERRORS.unknownState(word(ERRORS.otherClient, this.config.language)));
      }
      if (read.value === undefined) {
        throw this.refusal(
          key === 'mac'
            ? ERRORS.noIdentity
            : ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)),
        );
      }
      fresh[key] = read.value;
    }
    check();
    // The identity read in the same session: another unit refuses the command.
    this.checkIdentity(fresh.mac);
    if (this.mismatch !== undefined) {
      throw this.refusal(ERRORS.otherUnit);
    }
    if (!this.memory.identity || this.memory.identity.unit !== this.unitKey()) {
      throw this.refusal(ERRORS.memoryNotSaved);
    }
    const { mac: _mac, ...seen } = fresh;
    // A fresh read of a command never reaffirms a party stop.
    this.noteValues(seen, { fromCommand: true });
    if (command.needsRunning) {
      // A unit in standby or with its fans stopped is never started by Gladys.
      if (fresh.standby === true) {
        throw this.refusal(ERRORS.unitStandby);
      }
      if (fresh.fanStage === 0) {
        throw this.refusal(ERRORS.unitStopped);
      }
    }
    if (command.needsManual && fresh.mode !== 1) {
      throw this.refusal(ERRORS.notManual);
    }
    state.from = fresh[command.variable];
    const isPartyStart = plan.role === FEATURES.PARTY_START;
    if (isPartyStart && this.stopGuard) {
      // The click is the newer wish and lifts the stop guard, even when the
      // party is already on: /data first (a restart must never send the stop
      // again after this start), then the write.
      const lifted = this.stopGuard;
      const kept = this.memory.stopGuard;
      this.memory.stopGuard = null;
      try {
        await this.saveMemory({ strict: true });
      } catch {
        this.memory.stopGuard = kept;
        throw this.refusal(ERRORS.memoryNotSaved);
      }
      state.guardLifted = lifted;
      // After the await: the option, the configuration and a party stop again
      // (a refusal puts the guard back, see command()).
      check();
    }
    // A guard of another value still alive: written again, never "already so".
    if (state.from === plan.expected && !this.guardActive(command.variable)) {
      // Already so: nothing sent.
      if (state.guardLifted) {
        // Exits before beforeSend: checked here before the guard is lifted.
        check();
        this.stopGuard = undefined;
        state.guardLifted = undefined;
        this.logger.info('Helios: party stop guard lifted by a party start (already on)');
      }
      this.logger.info(`Helios: ${plan.role} already so, nothing sent`);
      return;
    }
    this.logger.info(`Helios: ${plan.role} (${plan.written})`);
    const request = writeRequest(VARIABLES[command.variable], plan.written);
    const previousOpen = this.partyStartOpen;
    let echo;
    try {
      echo = await session.request(request, {
        timeoutMs: Math.max(100, answerBy - this.mono()),
        startBy: sendBy,
        beforeSend: () => {
          // The option, the configuration and a party stop, checked right before the write.
          check();
          state.written = true;
          this.lastSentAt = this.mono();
          if (isPartyStart) {
            // The latest wish, lifted right before its synchronous write: an older
            // party stop is never reaffirmed after it.
            this.partyStartOpen = true;
            this.stopGuard = undefined;
            state.guardLifted = undefined;
          }
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
        // Refused by the unit (illegal function, address or value): not applied,
        // and never counts as the latest party start. Other exception codes
        // (device failure, acknowledge, busy) may be applied: "sent, without confirmation".
        state.refused = true;
        this.partyStartOpen = previousOpen;
      }
      throw err;
    }
    if (!isWriteEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
    // Confirmed only by the value read back equal to the value asked.
    if (answerBy - this.mono() < 100) {
      throw new ModbusError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
    }
    const back = await this.readVariable(session, command.variable, {
      timeLeft: () => answerBy - this.mono(),
    });
    if (back.other) {
      // Answered as "sent, without confirmation (another client…)" by commandError.
      throw this.refusal(ERRORS.otherClient);
    }
    if (back.value !== plan.expected) {
      if (back.value !== undefined) {
        this.noteValues({ [command.variable]: back.value });
      }
      // Equal to the value before: not applied yet (never a success).
      throw this.refusal(
        back.value === undefined
          ? ERRORS.unreadable
          : back.value === state.from
            ? ERRORS.notAppliedYet
            : ERRORS.readBackDiffers,
      );
    }
    this.guards.delete(command.variable);
    if (isPartyStart) {
      this.partyStartOpen = false;
    }
    this.noteValues({ [command.variable]: back.value });
    this.logger.info(`Helios: ${plan.role} confirmed by the unit`);
  }

  // --- The party stop (protective) -----------------------------------------------

  /**
   * The address a party stop goes to: the configuration's once it was read,
   * else the one kept in /data (with the stop guard, or the last configured).
   */
  stopAddress() {
    if (this.configLoaded && this.config.address) {
      return this.config.address;
    }
    return this.stopGuard?.address ?? this.memory.address ?? undefined;
  }

  /**
   * A second press while one runs joins it; when the joined one fails, this
   * press still gets its own tries if its 3.5 s are not over.
   */
  async protect(plan, received, { keepCount = false } = {}) {
    if (this.protecting) {
      try {
        return await this.protecting;
      } catch (err) {
        if (
          this.protecting ||
          this.mono() + TIMINGS.connectRetry >= received + TIMINGS.commandSendBy
        ) {
          throw err;
        }
      }
    }
    const promise = this.sendStop(plan, received, { keepCount });
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
    }
  }

  /**
   * Never held back: takes the line from anything, one write, without a
   * fresh read; a refused connection is tried again every 250 ms until 3.5 s
   * after the click (nothing is sent before it); the echo of the write and
   * the party read back confirm it. Answered by 4.3 s; still running then,
   * it goes on, bounded by its connection (3 s) and its requests (2 s each),
   * and the answer says whether it was written yet.
   */
  async sendStop(plan, received, { keepCount }) {
    if (this.booted) {
      await this.booted;
    }
    const address = this.stopAddress();
    if (!address) {
      throw this.refusal(ERRORS.noAddressKnown);
    }
    const unit = addressKey(address);
    // A command not written yet gives way (checked right before its write).
    this.protectSeq += 1;
    // A party start that may have left before this stop and is not confirmed
    // may still be applied after it: for 2 minutes, a party read on is taken
    // for it and the stop is sent again.
    // (A window already open is kept by keepStopGuard.)
    const sticky =
      this.partyStartOpen ||
      (this.guardActive('party') && this.guards.get('party').expected === true);
    const state = { written: false, sentAt: undefined };
    const retryUntil = received + TIMINGS.commandSendBy;
    const stillValid = () =>
      !this.shutdown &&
      (!this.configLoaded || !this.config.address || addressKey(this.config.address) === unit);
    // Writing 0 is idempotent: a connection closed, a timeout or a wrong
    // answer is tried again every 250 ms until 3.5 s after the press.
    const attempt = (session) =>
      (async () => {
        const request = writeRequest(VARIABLES.party, plan.written);
        const echo = await session.request(request, {
          timeoutMs: Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono())),
          beforeSend: () => {
            state.written = true;
            state.sentAt = this.mono();
            this.lastSentAt = this.mono();
            // The stop now carries a start not confirmed (its sticky window).
            this.partyStartOpen = false;
          },
        });
        if (!isWriteEcho(request, echo)) {
          session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
          throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
            sent: true,
          });
        }
        return this.readVariable(session, 'party');
      })();
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect']);
        for (;;) {
          try {
            return await this.useLine('protect', TIMINGS.connectTimeout, attempt, {
              retryUntil,
              address,
            });
          } catch (err) {
            const again =
              AGAIN.includes(err?.kind) &&
              stillValid() &&
              this.mono() + TIMINGS.connectRetry < retryUntil;
            if (!again) {
              throw err;
            }
            await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
            if (!stillValid()) {
              throw err;
            }
          }
        }
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info(`Helios: party stop${sticky ? ' (after a party start not confirmed)' : ''}`);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back: back?.value, other: back?.other }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    const confirmed = outcome.back === false;
    this.keepStopGuard({ unit, address, sticky, confirmed, keepCount });
    this.followUp();
    if (confirmed) {
      this.guards.delete('party');
      this.noteValues({ party: false });
      this.logger.info('Helios: party stop confirmed by the unit');
      return;
    }
    if (outcome.late) {
      sending.catch((err) =>
        this.logger.warn(`Helios: party stop failed after the ack (${errorReason(err)})`),
      );
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(
        ERRORS.sentUnconfirmed(
          word(both('no answer yet', 'pas encore de réponse'), this.config.language),
        ),
      );
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`Helios: party stop failed (${reason})`);
      if (!state.written) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (
        outcome.err.kind === ERROR_KINDS.REFUSED &&
        NOT_APPLIED_EXCEPTIONS.has(outcome.err.code)
      ) {
        throw this.refusal(ERRORS.refused(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (outcome.back === true) {
      this.noteValues({ party: true }, { fromCommand: true });
    }
    throw this.refusal(
      ERRORS.sentUnconfirmed(
        outcome.other
          ? word(ERRORS.otherClient, this.config.language)
          : word(
              outcome.back === true
                ? both('still on', 'toujours actif')
                : both('not read back', 'non relu'),
              this.config.language,
            ),
      ),
    );
  }

  /**
   * Sets (or updates) the party stop guard after a stop, kept in /data. A
   * press from the user starts a new count of resends; a resend keeps it.
   */
  keepStopGuard({ unit, address, sticky, confirmed, keepCount }) {
    const previous = this.stopGuard?.unit === unit ? this.stopGuard : undefined;
    const stickyUntil = sticky
      ? this.mono() + TIMINGS.stickyWindow
      : (previous?.stickyUntil ?? -Infinity);
    this.stopGuard = {
      unit,
      address: { host: address.host, port: address.port },
      sentAt: this.mono(),
      pending: !confirmed,
      reasserts: keepCount ? (previous?.reasserts ?? 0) : 0,
      seenOff: confirmed,
      onStreak: 0,
      stickyUntil,
    };
    this.persistStopGuard();
  }

  /** Keeps the party stop guard in /data (or clears it). */
  persistStopGuard() {
    const g = this.stopGuard;
    const next = g
      ? {
          unit: g.unit,
          host: g.address.host,
          port: g.address.port,
          pending: g.pending,
          reasserts: g.reasserts,
          seenOff: g.seenOff,
          onStreak: g.onStreak,
          stickyUntil:
            this.mono() < g.stickyUntil ? this.now() + (g.stickyUntil - this.mono()) : null,
        }
      : null;
    if (JSON.stringify(next) === JSON.stringify(this.memory.stopGuard ?? null)) {
      return;
    }
    this.memory.stopGuard = next;
    this.saveMemory().catch(() => {});
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards. A command guard lifts when the value moved
   * from the start state to the one asked (never on an unknown value). The
   * party stop guard (never lifted by the time):
   *   - party read off: the stop took effect;
   *   - party read on while the stop is not seen applied, or within the
   *     sticky window: the stop is sent again (three times at most);
   *   - party read on after the stop took effect, outside the window: counted;
   *     on two reads in a row, the party was started elsewhere and the guard
   *     is lifted; an unknown value breaks the count.
   */
  observe(values, { fromCommand = false } = {}) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    const stop = this.stopGuard;
    if (!stop || stop.unit !== this.unitKey() || fromCommand) {
      return;
    }
    if (values.party === undefined) {
      if (stop.onStreak !== 0) {
        stop.onStreak = 0;
        this.persistStopGuard();
      }
      return;
    }
    if (values.party === false) {
      if (stop.pending || !stop.seenOff || stop.onStreak !== 0) {
        stop.pending = false;
        stop.seenOff = true;
        stop.onStreak = 0;
        this.persistStopGuard();
      }
      return;
    }
    if (stop.pending || !stop.seenOff || this.mono() < stop.stickyUntil) {
      this.reassert(stop);
      return;
    }
    stop.onStreak += 1;
    if (stop.onStreak >= TIMINGS.changedElsewhereReads) {
      this.logger.info('Helios: the party mode was started elsewhere; party stop guard lifted');
      this.stopGuard = undefined;
    }
    this.persistStopGuard();
  }

  /** Sends the stop again, a second after the read closed the line, three times at most. */
  reassert(stop) {
    if (this.protecting || this.reassertTimer || stop.reasserts >= TIMINGS.stopReasserts) {
      return;
    }
    stop.reasserts += 1;
    this.persistStopGuard();
    this.logger.warn('Helios: the party mode is still on after a stop, stop sent again');
    const generation = this.generation;
    this.reassertTimer = this.timers.setTimeout(() => {
      this.reassertTimer = undefined;
      if (generation !== this.generation || this.stopGuard !== stop) {
        return;
      }
      this.protect(STOP_PLAN, this.mono(), { keepCount: true }).catch((err) =>
        this.logger.warn(`Helios: party stop sent again: ${err.message}`),
      );
    }, TIMINGS.reassertDelay);
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    if (!this.configLoaded || !this.config.address) {
      return;
    }
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Helios refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
