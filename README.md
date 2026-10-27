# Helios easyControls for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for
Helios KWL EC heat recovery ventilation units with the easyControls board
(software 2.01 or later), over local Modbus TCP (no cloud): temperatures,
operating mode, fan stage and speeds, party and standby modes, filter,
faults, external humidity and CO2 sensors. The operating mode, the fan stage
and the party mode start are optional commands, off by default; stopping
the party mode is not behind that option (see the guide for the cases where
it can fail).

Unofficial, not affiliated with Helios. Never tested with a real device.

- Guide: [English](docs/en.md) · [Français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- Status, decisions and what to check on a real unit: [TODO.md](TODO.md)
- Contributors and coding assistants: [CLAUDE.md](CLAUDE.md)

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run cover       # cover.png (800x534)
```

Modbus TCP has no password: keep the unit on a trusted network.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Third-party notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
