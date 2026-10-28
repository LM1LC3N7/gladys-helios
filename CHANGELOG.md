# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- Helios KWL EC heat recovery ventilation with easyControls (software 2.01
  or later) over local Modbus TCP: outdoor, supply, exhaust and extract
  temperatures, operating mode, fan stage, fan level and speeds, party and
  standby modes with their time left, filter change and days left, fault
  and warning, external humidity and CO2 sensors.
- Commands behind "Allow the commands" (off by default): operating mode,
  fan stage 1 to 4 (manual mode only) and party mode start; refused in
  standby mode or with the fans stopped; confirmed only by a read back.
- "Stop the party mode", which never depends on that option, with a stop
  guard kept in `/data` (see the guide for the cases where it can fail).
- The MAC address of the unit checked before every read and command.
- Guides in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-helios/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-helios/releases/tag/v0.1.1
