// -----------------------------------------------------------------------------
// The configuration, normalized: the address strictly validated (never shown
// again when invalid), the commands off unless exactly true.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 unicast or a host name, optional port', () => {
  assert.deepEqual(parseAddress('192.168.1.90'), { host: '192.168.1.90', port: 502 });
  assert.deepEqual(parseAddress(' KWL.local:1502 '), { host: 'kwl.local', port: 1502 });
  for (const bad of [
    '',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.90:0',
    '192.168.1.90:70000',
    'http://192.168.1.90',
    'kwl\r\n.local',
    'a..b',
    '1.2.3',
    'host name',
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
});

test('defaults: commands off, 60 s, French; an invalid address is never echoed', () => {
  const c = normalizeConfig({});
  assert.equal(c.address, undefined);
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 60);
  assert.equal(c.language, 'fr');
  const bad = normalizeConfig({ host: 'secret-pasted-by-mistake!' });
  assert.equal(bad.address, undefined);
  assert.equal(bad.invalid, 'secret-pasted-by-mistake!'.length);
  assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('the commands are allowed only by exactly true; the interval is bounded and strict', () => {
  for (const value of ['1', 1, 'yes', 'TRUE', {}, null]) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 90.5 }).pollInterval, 60);
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
});
