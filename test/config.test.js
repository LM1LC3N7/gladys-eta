// -----------------------------------------------------------------------------
// The configuration: address parsing, defaults, bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, deviceKey, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IP, host name, port, pasted URL', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: undefined });
  assert.deepEqual(parseAddress(' http://192.168.1.50:8080/ '), {
    host: '192.168.1.50',
    port: 8080,
  });
  assert.deepEqual(parseAddress('ETAtouch.local'), { host: 'etatouch.local', port: undefined });
  assert.deepEqual(parseAddress('[fe80::1]:8081'), { host: 'fe80::1', port: 8081 });
  assert.deepEqual(parseAddress('fd00::50'), { host: 'fd00::50', port: undefined });
  assert.deepEqual(parseAddress(''), {});
});

test('addresses refused: paths, credentials, broadcast, multicast, unspecified, controls', () => {
  for (const raw of ['192.168.1.50/user/menu', 'user@192.168.1.50', '192.168.1.50?x', 'a b']) {
    assert.deepEqual(parseAddress(raw), { error: 'path' }, raw);
  }
  for (const raw of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.251',
    '239.1.1.1',
    '::',
    'ff02::1',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    'bad_host',
    '192.168.1.50\r\nX: y',
  ]) {
    assert.equal(parseAddress(raw).error, 'invalid', raw);
  }
});

test('defaults and bounds', () => {
  const config = normalizeConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.variables, DEFAULTS.variables);
  assert.equal(config.pollInterval, 60);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ variables: 'ALL' }).variables, 'all');
  assert.equal(normalizeConfig({ variables: 'x' }).variables, 'main');
  assert.equal(normalizeConfig({ host: '10.0.0.2:9000', port: 8080 }).port, 9000);
  assert.equal(normalizeConfig({ host: '10.0.0.2', port: '8081' }).port, 8081);
  assert.equal(normalizeConfig({ host: '10.0.0.2', port: 1.5 }).port, 8080);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('the /data key depends on the address and the port only', () => {
  assert.match(deviceKey('10.0.0.2', 8080), /^[0-9a-f]{32}$/);
  assert.notEqual(deviceKey('10.0.0.2', 8080), deviceKey('10.0.0.2', 8081));
  assert.equal(deviceKey('', 8080), '');
});
