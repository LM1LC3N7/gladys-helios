# TODO — Helios easyControls v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385
  (lot 17) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-27): the unit by IP address, its
      variables every interval over one connection (never sooner, even after
      a restart), MAC address checked first, one device with the external
      sensors seen, operating mode, fan stage and party start behind
      `allow_commands` (off), "Stop the party mode" never held back by the
      option, its guard in /data, test button, getConfig retried, docs
      en/fr, cover. Tested against a fake unit only.
- [x] **Review r1 fixes** (2026-10-27): stale getConfig() answer dropped
      (I1), an empty or invalid address keeps the stop guard and the stop
      goes to /data (I2), tests for the surviving mutants (I3), model name
      filtered (I4), write whitelist in `writeRequest` (I5); minors: -0, CO2
      below 250 ppm unknown, resends at start counted, a joined stop that
      fails gets its own tries, one clock read per status. Tests `r1 …`.
- [ ] **Milestone 2 — real unit**: run against a real KWL EC (see "To check").
- [ ] **Milestone 3 — more**: filter change reset (v01031) as a button
      behind the option, if a real unit shows how its effect is confirmed;
      VOC sensors (v00136-v00143); standby start and stop (their own option,
      off by default, never a switch).

## To check on a real unit

- That a selection followed by a read in the same TCP connection answers
  each variable (eazyctrl opens one connection per variable; we keep one
  per poll), and how long a poll of about 20 variables takes.
- That the registers after the NUL come back as zeros (we stop at the NUL
  and ignore the rest).
- That a write shows at once in the read back (else every command answers
  "sent, without confirmation" and the follow-up reads confirm it).
- What the unit answers for an unknown variable and for an absent external
  sensor ("vXXXXX=" or "vXXXXX=-"), and the format of the CO2 values
  (char[4] but ".1f" in the Helios list).
- Whether writing the fan stage in automatic mode is kept (we refuse it).
- Whether the values come padded with spaces (" 21.5"): they are refused
  today (strict), so no temperature would ever be published (review r1 M3).
- How long one request takes: a command needs 11 requests before its ack;
  above about 300 ms per request every command is "too slow, not sent"
  (review r1 M4).
- Whether the unit accepts a second Modbus client (Home Assistant and Gladys
  at once): the selection is shared, a clash leaves one value unknown.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-helios:0.1.0`); the
  first patch release gives 0.1.1. The manifest test checks the semver
  shape and that the four agree, never a pinned value.
- **SDK 0.16.0** (latest on npm, 2026-10-27; its CHANGELOG adds nothing this
  module uses).
- **Reference**: the Helios document "Modbus Gateway TCP/IP" (82
  269-001/09.17, easycontrols.net, the current download for easyControls
  2.x). Ports: eazyctrl 0.4 (BSD 2-Clause, LICENSE read: "Copyright (c)
  2019-2020, Bálint Aradi"; framing) and homeassistant-easycontrols 0.7.0
  (MIT, LICENSE read: "Copyright (c) 2022 Laszlo Jakab"; choice of variables,
  manual mode for the fan stage), cloned read-only in `~/code/ref/lot17/`
  (commits 7dda21c and f9c1015). The Home Assistant integration has no
  commit since 2024-11-30: the variables come from the Helios document;
  v02119 (bypass) and v02136 (humidity of the extract air), read by Home
  Assistant but absent from the document, are not used.
- **Sibling modules**: gladys-salda-smarty (structure, line, polling, guards,
  protective stop, publisher, store), gladys-zehnder-comfoair and
  gladys-duco (ventilation), gladys-sinapsi-alfa (test kit copied).
- **Identity (FROZEN RULE)**: the device is `helios:unit`, one per
  integration, never the IP nor the MAC address. The MAC address (v00002)
  is read first at every poll and command, learnt at the first read and
  kept in /data with the address; another one: nothing published, commands
  refused, the test button accepts the one shown. Unreadable is never
  another device; /data unreadable: nothing learnt, nothing written, the
  commands (not the party stop) refused.
- **Variables**: the Helios list, `len` = its char[n] (external sensors read
  as 7 characters: the list says char[4] and ".1f"); count = (name + "=" +
  value + NUL) / 2 rounded up, at least 4; a value empty, "-", out of range
  or malformed is unknown, never 0; a text ending without NUL is unknown.
  Plausible ranges: temperatures -40..80 °C (Helios: from -27), rpm
  0..9998, humidity 0..100 %, CO2 0..9998 ppm. Info (model, software) and
  the probe of the external sensors: at the first read, then hourly.
- **One Modbus connection at a time** (`useLine`), one request at a time: a
  poll is one session (two requests per variable), closed after; a command
  aborts a running poll and opens its own session; "Stop the party mode"
  aborts anything. A test checks that the unit never sees two connections
  at once (also on a real TCP server, `test/realclock.test.js`).
- **Commands**: operating mode (v00101, 0/1), fan stage (v00102, 1-4, manual
  mode only), party start (v00094=1). `needsRunning`: refused in standby
  (v00099=1) or at fan stage 0. The fresh read takes 4 variables (8
  requests) before the write: a slow unit makes the command "too slow, not
  sent" rather than late. Fan stage 0 and the standby mode are never
  written (stopping or starting the fans is out of v1).
- **Protective command**: "Stop the party mode" (v00094=0). Not behind the
  option, the identity, /data, a backoff, nor the configuration (before it
  is read: the address kept in /data). Tried again every 250 ms until 3.5 s
  (idempotent). **Stop guard** in /data, never lifted by the time: lifted
  by a party start written from Gladys (option on; /data written first, a
  failure refuses the start), by the party read on two reads in a row after
  the stop was seen applied, or by another address. While the stop is not
  seen applied (or within 2 minutes after a party start not confirmed:
  sticky window), a read with the party on sends the stop again, three
  times at most per press. A stop not confirmed is sent at the start of the
  container from /data, before getConfig.
- **Deadlines**: connection 1.5 s max, each request of the fresh read 1 s
  max, write by 3.5 s after the click (checked right before the bytes),
  read back until 4.3 s. Written flag set in `beforeSend`; Modbus exception
  1-3 to a write = "refused by the unit"; any other = "sent, without
  confirmation" with a guard and follow-up reads (5 s, 20 s).
- **Clocks**: deadlines, guards and the time of the last read in memory on
  a monotonic clock; the wall clock only for /data. A time in /data in the
  future counts as now; a sticky window longer than 2 minutes is dropped.
- **getConfig()** failing in `connected`: tried again after 5 s, 15 s, 30 s,
  then every minute, the status says so; configurations saved in a row are
  applied one at a time (the last one wins).
- **Reconnection to Gladys**: status, Discovery and badge republished, no
  read, no old value republished; a device created later gets the last
  values only while they are younger than the interval.
- **Review r1**: a getConfig() answer is dropped when a configuration was
  saved since it was asked (counter of saves; the last saved wins). Only a
  valid, different address lifts the stop guard; without a valid address
  in the configuration, the stop goes to the address kept in /data. Writes
  are whitelisted in `writeRequest` itself (v00094 0/1, v00101 0/1, v00102
  1-4). The model name keeps `[A-Za-z0-9 ._/()+-]` (31 at most) with a
  letter or digit. A CO2 value below 250 ppm is unknown. The stop sent at
  start counts in the three resends. A variable answered with a frame of
  the wrong size ends the read (the session is not trusted any more); a
  read that ends early keeps the values read (review r1 M1).
  Equivalent mutants left: the empty-value check in `decodeValue` (each
  kind refuses "" anyway), the `read.other` branch of `readAll` (logs
  only), and `!guardActive` in the "already so" test (the fresh read lifts
  a command guard whenever the value reads as asked).
- **Not done**: Bluetooth (none), scenes, widgets, VOC sensors, holiday
  programme, bypass, heaters, standby commands, filter reset; `keywords`
  and `countries` are not in the manifest (DE, AT, CH, FR).
