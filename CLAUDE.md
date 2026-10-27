# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Helios
KWL EC ventilation unit with easyControls over Modbus TCP (port 502, unit
id 180, no cloud, no authentication) and shows it as one Gladys device;
commands behind an off-by-default option, "Stop the party mode" never behind
that option. Never tested with a real device, not affiliated with Helios.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi test / gi ci                           # the tests / the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap only (boot: /data first, then connect)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                HeliosApp: boot, getConfig retries, the line (one session),
                          polling, identity, device, states, badge, status, test button,
                          commands, the party stop and its guard
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    Helios variables: selection, read, write, hostile answers (pure)
src/devices.js            -> the Gladys device and its states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/helios-state.json (unreadable is never empty)
src/config.js             config_schema normalized (host, allow_commands, interval, language)
src/constants.js          variables, commands, feature roles, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeHelios.js  the fake unit (injected connector, or behind a real TCP server)
test/kit/                 parts of ~/code/ref/gladys-testkit (Apache-2.0), copied for the CI
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `helios:unit` (never the IP nor the
  MAC address: frozen rule), feature roles in `FEATURES` of
  `src/constants.js` and the external sensors `humidity-1..8`, `co2-1..8`.
  Every base role is always built; an external sensor once seen is always
  built again (kept in /data and taken from the created device).
- Manifest keys (`host`, `allow_commands`, `poll_interval`, `language`, the
  action `test_connection`) are frozen; never a key prefixed `gladys_`.
- **Only the variables of the Helios document** (82 269-001/09.17) are read;
  only v00094, v00101 and v00102 are written, with the digits of
  `COMMANDS`. Never write fan stage 0 nor the standby mode.
- **One Modbus connection at a time, one request at a time**: everything
  goes through `useLine`; a command takes the line from a poll, "Stop the
  party mode" from anything.
- **Commands**: never a switch, a writable binary or a writable fan; refused
  unless `allow_commands` (checked on arrival and in `beforeSend`), except
  `party-stop`; decided on a fresh read in the same session (MAC address
  first); refused in standby or at fan stage 0; fan stage in manual mode
  only; written within 3.5 s; confirmed only by the echo and a read back
  equal to the value asked; a written command is never "not sent"; never
  retried; the ack never waits for Gladys.
- **The party stop guard is never lifted by the time** (see `src/app.js`).
- Never read sooner than the interval (button, scan, reconnection, restart);
  only the reads of a command and the follow-up reads after it.
- **Answers are hostile**: MBAP frames bounded and checked; ASCII strictly
  validated; an empty value or "-" is unknown, never 0; never log the bytes
  received.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network beyond 127.0.0.1.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
