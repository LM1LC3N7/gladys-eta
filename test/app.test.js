// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake ETAtouch (the answers of a real PE-K), on a virtual clock
// that moves at every read of it (test/kit/clock.mjs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EtaApp } from '../src/app.js';
import { deviceKey } from '../src/config.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  CONFIG,
  HOST,
  HOUR,
  MINUTE,
  PEK,
  SECOND,
  SELECTOR,
  dev,
  errorsXml,
  fakeEta,
  feat,
  lastState,
  pekRoutes,
  recorder,
  settle,
  setup,
  statusOf,
  testClock,
  value,
  xml,
} from './helpers/eta.js';

const BOILER = '/40/10021/0/0/12161';
const PRESSURE = '/40/10021/0/0/12180';
const HOURS = '/40/10021/0/0/12153';
const TOTAL = '/40/10021/0/0/12016';
const STATE = '/40/10021/0/0/19402';
const STOCK = '/40/10211/0/0/12015';
const FLOW_HK2 = '/120/10102/0/0/12241';

const discovered = (gladys, block) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === dev(block));
const featureOf = (gladys, uri) => {
  const [node, fub] = uri.split('/').filter(Boolean);
  return discovered(gladys, `${node}-${fub}`)?.features.find((f) => f.external_id === feat(uri));
};
const varRequests = (eta) => eta.requests.filter((r) => r.path.startsWith('/user/var/'));
/** Virtual ms left before the next cycle may start. */
const left = (app) => {
  const mono = app.monotonic();
  return app.dueAt(mono) - mono;
};

test('discovery: blocks of the menu, main variables, one request at a time, GET only', async (t) => {
  const { gladys, eta } = await setup(t);
  assert.equal(eta.count('/user/api'), 1);
  assert.equal(eta.count('/user/menu'), 1);
  assert.equal(eta.peak, 1, 'never two requests at once');
  // Kessel, WW, HK, Fbh, Sys, LagerUm. and the errors device.
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [
    dev('120-10101'),
    dev('120-10102'),
    dev('120-10111'),
    dev('120-10241'),
    dev('40-10021'),
    dev('40-10211'),
    dev('errors'),
  ]);
  assert.equal(discovered(gladys, '40-10021').name, 'ETA Kessel');
  const boiler = featureOf(gladys, BOILER);
  assert.equal(boiler.category, 'temperature-sensor');
  assert.equal(boiler.type, 'probe');
  assert.equal(boiler.unit, 'celsius');
  assert.equal(boiler.name, 'Kessel > Kessel');
  assert.equal(featureOf(gladys, PRESSURE).unit, 'bar');
  assert.equal(featureOf(gladys, HOURS).unit, 'hours');
  assert.equal(featureOf(gladys, TOTAL).name, 'Zählerstände > Gesamtverbrauch (kg)');
  assert.equal(featureOf(gladys, TOTAL).unit, undefined, 'kg is no unit of a Gladys category');
  assert.equal(featureOf(gladys, STATE).category, 'text');
  // The heating circuit 1 flow reads "---" without a unit: not classified.
  assert.equal(featureOf(gladys, '/120/10101/0/0/12241'), undefined);
  assert.equal(featureOf(gladys, FLOW_HK2).unit, 'celsius');
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.equal(feature.read_only, true, feature.external_id);
      assert.notEqual(feature.category, 'switch');
      assert.equal(feature.supported_options, undefined);
      if (feature.type === 'binary') {
        assert.equal(feature.category, 'unknown', 'a binary sensor only');
      }
    }
  }
  assert.ok(eta.requests.every((r) => r.path.startsWith('/user/')));
  assert.equal(statusOf(gladys).connected, true);
});

test('a cycle every interval reads the created features: values, units, invalid values', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  const before = varRequests(eta).length;
  await wait(left(app) - SECOND);
  assert.equal(varRequests(eta).length, before, 'not before the interval');
  await wait(2 * SECOND);
  assert.ok(varRequests(eta).length > before);
  assert.equal(lastState(gladys, feat(BOILER)), 67.3);
  assert.equal(lastState(gladys, feat(PRESSURE)), 1.36);
  assert.equal(lastState(gladys, feat(HOURS)), 6940.68, 'the number shown, the raw lost digits');
  assert.equal(lastState(gladys, feat(TOTAL)), 13400.5);
  assert.equal(lastState(gladys, feat(STOCK)), 2678.4);
  assert.equal(lastState(gladys, feat(STATE)), 'Bereit');
  assert.equal(lastState(gladys, `${dev('errors')}:error-count`), 0);
  assert.equal(lastState(gladys, `${dev('errors')}:alarm`), 0);
  assert.equal(eta.peak, 1);
  // "xxx" now: no value at all (never 0).
  eta.routes[`/user/var${BOILER}`] = value(BOILER, { str: 'xxx', raw: 0, unit: '°C', scale: 10 });
  const count = gladys.fake.states.filter((s) => s.device_feature_external_id === feat(BOILER));
  await wait(MINUTE);
  const after = gladys.fake.states.filter((s) => s.device_feature_external_id === feat(BOILER));
  assert.equal(after.length, count.length, 'nothing published for "xxx"');
  // A unit no longer the feature's (°C -> %): no value.
  eta.routes[`/user/var${BOILER}`] = value(BOILER, { str: '50', raw: 50, unit: '%' });
  await wait(MINUTE);
  assert.equal(
    gladys.fake.states.filter((s) => s.device_feature_external_id === feat(BOILER)).length,
    count.length,
  );
  // Out of range: no value.
  eta.routes[`/user/var${BOILER}`] = value(BOILER, {
    str: '9999',
    raw: 99990,
    unit: '°C',
    scale: 10,
  });
  await wait(MINUTE);
  assert.equal(
    gladys.fake.states.filter((s) => s.device_feature_external_id === feat(BOILER)).length,
    count.length,
  );
});

test('cycles keep the interval on a virtual clock (period measured)', async (t) => {
  const { eta, wait } = await setup(t, { create: true });
  await wait(10 * MINUTE + SECOND);
  // From the second cycle (the first one read the menu before its errors).
  const starts = eta.requests
    .filter((r) => r.path === '/user/errors')
    .map((r) => r.at)
    .slice(1);
  assert.equal(starts.length, 10);
  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= MINUTE && gap < MINUTE + SECOND, `gap ${gap}`);
  }
});

test('the test button and Discovery never read sooner than the interval', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  const before = eta.requests.length;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /next read is in 5\d s/);
  await gladys.fake.scanRequest();
  await settle();
  assert.equal(eta.requests.length, before, 'no request from the button nor Discovery');
  await wait(left(app) - 30 * SECOND);
  assert.match((await gladys.fake.action(ACTIONS.TEST_CONNECTION)).data.message.en, /in 30 s/);
  await wait(30 * SECOND);
  assert.equal(eta.count('/user/errors'), 2, 'the cycle ran at the interval');
  // A scan within 10 minutes of the last discovery does not read the menu again.
  assert.equal(eta.count('/user/menu'), 1);
  // Right after the cycle, the button waits again.
  assert.match((await gladys.fake.action(ACTIONS.TEST_CONNECTION)).data.message.en, /in 5\d s/);
  // Ten minutes later, a scan reads the menu again, at the next cycle only.
  await wait(10 * MINUTE);
  const count = eta.requests.length;
  await gladys.fake.scanRequest();
  await settle();
  assert.equal(eta.requests.length, count);
  await wait(left(app));
  assert.equal(eta.count('/user/menu'), 2);
});

test('the button reads once the interval has passed', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { config: { ...CONFIG, poll_interval: 600 } });
  await wait(5 * MINUTE);
  assert.match((await gladys.fake.action(ACTIONS.TEST_CONNECTION)).data.message.en, /in 5 min/);
  await wait(5 * MINUTE - SECOND);
  // The timer is due in 1 s; the button just waits for it.
  await wait(2 * SECOND);
  assert.equal(eta.count('/user/errors'), 2);
  app.clearTimer();
  await wait(10 * MINUTE);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /^Connected/);
  assert.equal(eta.count('/user/errors'), 3);
});

test('a restart right after a cycle waits for the interval (time saved before the request)', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  const first = await setup(t, { store, clock });
  assert.equal(first.eta.count('/user/errors'), 1);
  assert.ok(store.data.lastAttempt > 0);
  first.app.stop();
  await first.wait(20 * SECOND);
  const second = await setup(t, { store, clock });
  assert.equal(second.eta.requests.length, 0, 'no read at once after the restart');
  assert.equal(second.eta.count('/user/menu'), 0, 'the catalog comes from /data');
  assert.ok(second.gladys.fake.discoveredDevices.length > 0, 'Discovery list from /data');
  const rest = left(second.app);
  assert.ok(rest > 30 * SECOND && rest < 40 * SECOND, `${rest}`);
  await second.wait(rest - SECOND);
  assert.equal(second.eta.requests.length, 0);
  await second.wait(2 * SECOND);
  assert.equal(second.eta.count('/user/errors'), 1);
});

test('the time of the attempt is saved before its first request', async (t) => {
  const store = memoryStore();
  const saved = [];
  const spy = {
    load: () => store.load(),
    save: async (data) => {
      saved.push(data.lastAttempt);
      return store.save(data);
    },
  };
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  const eta = fakeEta({ clock });
  const original = eta.transport;
  let savedBeforeFirst;
  eta.transport = async (...args) => {
    savedBeforeFirst ??= saved.some((v) => v > 0);
    return original(...args);
  };
  await setup(t, { store: spy, clock, eta });
  assert.equal(savedBeforeFirst, true);
});

test('/data unreadable: never written over, first read after a full interval', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  let saves = 0;
  const store = {
    load: async () => ({ status: 'unreadable' }),
    save: async () => {
      saves += 1;
    },
  };
  const { eta, wait, logger } = await setup(t, { store, clock });
  assert.equal(eta.requests.length, 0);
  await wait(MINUTE + SECOND);
  assert.equal(eta.count('/user/errors'), 1);
  assert.equal(saves, 0);
  assert.ok(logger.lines.some((l) => /cannot be read/.test(l)));
});

test('a last attempt dated in the future is invalid: a full interval first', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  const key = deviceKey(HOST, 8080);
  const store = memoryStore({ key, lastAttempt: Date.UTC(2026, 9, 28, 10) });
  const { eta, wait } = await setup(t, { store, clock });
  assert.equal(eta.requests.length, 0);
  await wait(MINUTE + SECOND);
  assert.equal(eta.count('/user/errors'), 1);
});

test('a wall clock set back or forward never stops nor hurries the cycles', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  let shift = 0;
  const shifted = { ...clock, now: () => clock.now() + shift };
  const { eta, wait } = await setup(t, { clock: shifted, create: true });
  shift = -24 * HOUR;
  await wait(MINUTE + SECOND);
  assert.equal(eta.count('/user/errors'), 2);
  shift = 24 * HOUR;
  await wait(30 * SECOND);
  assert.equal(eta.count('/user/errors'), 2);
  await wait(30 * SECOND);
  assert.equal(eta.count('/user/errors'), 3);
});

test('no answer: backoff never under the interval, badges unreachable, then back', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  const routes = eta.routes;
  eta.routes = new Proxy({}, { get: () => 'refused' });
  await wait(left(app));
  assert.equal(statusOf(gladys).connected, false);
  assert.match(statusOf(gladys).message.en, /no answer from the ETAtouch.*60 s/);
  const badge = gladys.fake.transports
    .filter((b) => b.device_external_id === dev('40-10021'))
    .at(-1);
  assert.equal(badge.transport, 'unreachable');
  const count = eta.requests.length;
  await wait(59 * SECOND);
  assert.equal(eta.requests.length, count);
  await wait(2 * SECOND);
  assert.equal(eta.requests.length, count + 1, 'one request, the cycle stops at the first');
  // Second failure: 2 min.
  await wait(MINUTE + 30 * SECOND);
  assert.equal(eta.requests.length, count + 1);
  eta.routes = routes;
  await wait(31 * SECOND);
  assert.equal(statusOf(gladys).connected, true);
  const back = gladys.fake.transports
    .filter((b) => b.device_external_id === dev('40-10021'))
    .at(-1);
  assert.equal(back.transport, 'local');
});

test('two variables timing out in a row end the cycle; one only misses its value', async (t) => {
  const { gladys, eta, wait } = await setup(t, { create: true });
  eta.routes[`/user/var${BOILER}`] = 'timeout';
  await wait(MINUTE);
  assert.equal(statusOf(gladys).connected, true);
  assert.match(statusOf(gladys).message.en, /1 unreadable/);
  const badge = gladys.fake.transports
    .filter((b) => b.device_external_id === dev('40-10021'))
    .at(-1);
  assert.equal(badge.degraded, true);
  // A variable the ETAtouch does not know (404): the others still read.
  eta.routes[`/user/var${BOILER}`] = undefined;
  eta.routes[`/user/var${PRESSURE}`] = value(PRESSURE, {
    str: '1,50',
    raw: 150,
    unit: 'bar',
    scale: 100,
  });
  await wait(MINUTE);
  assert.equal(lastState(gladys, feat(PRESSURE)), 1.5);
  // Everything times out: the cycle ends after two.
  eta.routes = new Proxy(eta.routes, {
    get: (target, path) => (String(path).startsWith('/user/var/') ? 'timeout' : target[path]),
  });
  const count = eta.requests.length;
  await wait(MINUTE);
  assert.equal(eta.requests.length, count + 3, 'errors, then two variables');
  assert.equal(statusOf(gladys).connected, false);
});

test('variables that never answer cannot starve the others (rotation); a 5xx misses one value', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  const list = app.createdDevices().flatMap((d) => d.features.map((f) => f.external_id));
  const uris = eta.requests.filter((r) => r.path.startsWith('/user/var/')).map((r) => r.path);
  assert.ok(list.length > 10 && uris.length > 10);
  // The 3rd and 4th variables of the list time out, the 6th answers 503.
  const order = (await import('../src/devices.js')).variablesToRead(app.createdDevices());
  eta.routes[`/user/var${order[2].uri}`] = 'timeout';
  eta.routes[`/user/var${order[3].uri}`] = 'timeout';
  eta.routes[`/user/var${order[5].uri}`] = { status: 503, body: '' };
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    const before = eta.requests.length;
    await wait(MINUTE);
    for (const r of eta.requests.slice(before)) seen.add(r.path);
  }
  for (const [i, v] of order.entries()) {
    assert.ok(seen.has(`/user/var${v.uri}`), `variable ${i} read`);
  }
  assert.equal(lastState(gladys, order.at(-1).id) !== undefined, true);
});

test('429: a pause of Retry-After for every path, kept across a restart', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  const first = await setup(t, { store, clock, create: true });
  first.eta.routes['/user/errors'] = { status: 429, headers: { 'retry-after': '600' }, body: '' };
  await first.wait(MINUTE);
  assert.match(statusOf(first.gladys).message.en, /slow down: next read in 10 min/);
  const ack = await first.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /slow down/);
  const count = first.eta.requests.length;
  await first.wait(5 * MINUTE);
  assert.equal(first.eta.requests.length, count);
  first.app.stop();
  const second = await setup(t, { store, clock });
  assert.equal(second.eta.requests.length, 0);
  assert.match(statusOf(second.gladys).message.en, /slow down/);
  await second.wait(4 * MINUTE);
  assert.equal(second.eta.requests.length, 0);
  await second.wait(2 * MINUTE);
  assert.ok(second.eta.requests.length > 0);
});

test('errors: the first read learns, a new error fires once, a restart never fires it again', async (t) => {
  const store = memoryStore();
  const clock = testClock({ start: Date.UTC(2026, 9, 27, 10) });
  const old = { msg: 'Water pressure too low 0,00 bar', time: '2026-10-27 09:00:00' };
  const routes = pekRoutes({ '/user/errors': errorsXml([old]) });
  const first = await setup(t, { store, clock, routes, create: true });
  assert.equal(first.gladys.fake.sceneEvents.length, 0, 'the first read only learns');
  await first.wait(MINUTE);
  assert.equal(lastState(first.gladys, `${dev('errors')}:alarm`), 1);
  assert.equal(lastState(first.gladys, `${dev('errors')}:error-count`), 1);
  assert.equal(
    lastState(first.gladys, `${dev('errors')}:last-error`),
    'Kessel: Water pressure too low 0,00 bar (Error, 2026-10-27 09:00:00)',
  );
  const fresh = { msg: 'Flue gas sensor Interrupted', time: '2026-10-27 10:05:00' };
  first.eta.routes['/user/errors'] = errorsXml([old, fresh]);
  await first.wait(MINUTE);
  await first.wait(MINUTE);
  const events = first.gladys.fake.sceneEvents;
  assert.equal(events.length, 1);
  assert.equal(events[0].key, SCENE_TRIGGERS.ERROR);
  assert.match(events[0].data.message, /Flue gas sensor Interrupted/);
  assert.equal(events[0].data.block, 'Kessel');
  first.app.stop();
  const second = await setup(t, {
    store,
    clock,
    routes: first.eta.routes,
    devices: first.gladys.fake.devices,
  });
  await second.wait(2 * MINUTE);
  assert.equal(second.gladys.fake.sceneEvents.length, 0, 'not again after a restart');
});

test('reduced mode: no /user/api (API older than 1.2), no varinfo, kinds from the values', async (t) => {
  const routes = pekRoutes({ '/user/api': undefined });
  const { gladys, eta } = await setup(t, { routes });
  assert.equal(eta.requests.filter((r) => r.path.startsWith('/user/varinfo')).length, 0);
  assert.equal(featureOf(gladys, BOILER).unit, 'celsius');
  assert.equal(featureOf(gladys, BOILER).name, 'Kessel > Kessel');
  assert.equal(featureOf(gladys, STATE).category, 'text');
  assert.equal(featureOf(gladys, HOURS).unit, 'hours');
  assert.match(statusOf(gladys).message.en, /reduced mode/);
});

test('"all variables": the whole menu, time slots skipped, a missing value skips one variable', async (t) => {
  const { gladys, eta } = await setup(t, { config: { ...CONFIG, variables: 'all' } });
  // Every object of the menu got a varinfo request (590 unique uris).
  assert.ok(eta.requests.filter((r) => r.path.startsWith('/user/varinfo')).length > 500);
  // The time slot is not a feature; the inputs (io) are.
  assert.equal(featureOf(gladys, '/120/10111/12130/0/1082'), undefined);
  assert.equal(featureOf(gladys, '/40/10021/0/11109/0').unit, 'celsius');
  assert.equal(
    featureOf(gladys, '/40/10021/0/11108/2066').name,
    'Eingänge > Restsauerstoff > Signal (mV)',
  );
  assert.equal(statusOf(gladys).connected, true);
});

test('a device created keeps its features when the menu no longer lists them', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  delete eta.routes[`/user/varinfo${BOILER}`];
  delete eta.routes[`/user/var${BOILER}`];
  app.discoveryAsked = true;
  await wait(MINUTE);
  assert.equal(eta.count('/user/menu'), 2);
  assert.ok(featureOf(gladys, BOILER), 'still published');
});

test('commands are refused, nothing is sent', async (t) => {
  const { gladys, eta } = await setup(t, { create: true });
  const device = gladys.fake.devices.find((d) => d.external_id === dev('40-10021'));
  const count = eta.requests.length;
  const ack = await gladys.fake.setValue(device, device.features[0], 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /lecture seule/);
  assert.equal(eta.requests.length, count);
});

test('a menu too large is refused before it is read whole', async (t) => {
  const huge = xml(`<menu>${' '.repeat(3 * 1024 * 1024)}</menu>`);
  const { gladys } = await setup(t, { routes: pekRoutes({ '/user/menu': huge }) });
  assert.equal(statusOf(gladys).connected, false);
  assert.match(statusOf(gladys).message.en, /too large/);
});

test('not an ETAtouch: a clear status', async (t) => {
  const { gladys } = await setup(t, {
    routes: pekRoutes({ '/user/api': '<html><body>router</body></html>', '/user/menu': '{"a":1}' }),
  });
  assert.equal(statusOf(gladys).connected, false);
  assert.match(statusOf(gladys).message.en, /not an ETAtouch one/);
});

test('configuration: no address, an address with a path, a broadcast address', async (t) => {
  for (const [host, pattern] of [
    ['', /Enter the IP address/],
    ['192.168.1.50/user/menu', /without a path/],
    ['255.255.255.255', /not an IP address/],
    ['224.0.0.1', /not an IP address/],
  ]) {
    const { gladys, eta } = await setup(t, { config: { host } });
    assert.match(statusOf(gladys).message.en, pattern, host);
    assert.equal(eta.requests.length, 0);
  }
});

test('a reconnection to Gladys resends status and Discovery, and reads nothing', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  await wait(left(app) + SECOND);
  const count = eta.requests.length;
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(eta.requests.length, count);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.equal(statusOf(gladys).connected, true);
  // The unchanged values are published again at the next cycle.
  const states = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === feat(BOILER)).length;
  const before = states();
  await wait(left(app) + SECOND);
  assert.equal(states(), before + 1);
});

test('a device created long after the last read gets no stale value', async (t) => {
  const { gladys, eta, wait, app } = await setup(t);
  const boiler = gladys.fake.discoveredDevices.find((d) => d.external_id === dev('40-10021'));
  // Values of the boiler read once by hand, then the ETAtouch goes silent.
  app.values.set(feat(BOILER), { value: { state: 60 }, at: app.monotonic() });
  eta.routes = new Proxy({}, { get: () => 'refused' });
  await wait(10 * MINUTE);
  await gladys.fake.deviceCreated(boiler);
  await settle();
  assert.equal(lastState(gladys, feat(BOILER)), undefined);
});

test('changing "variables" reads the menu again at the next cycle, not sooner', async (t) => {
  const { gladys, eta, wait } = await setup(t);
  await gladys.fake.configUpdated({ ...CONFIG, variables: 'all' });
  await settle();
  assert.equal(eta.count('/user/menu'), 1);
  await wait(MINUTE);
  assert.equal(eta.count('/user/menu'), 2);
});

test('a new address restarts with another catalog and another memory', async (t) => {
  const store = memoryStore();
  const { gladys, eta, wait } = await setup(t, { store });
  await gladys.fake.configUpdated({ host: '192.168.1.60' });
  await wait(0);
  assert.equal(eta.count('/user/menu'), 2);
  assert.equal(eta.requests.at(-1).host, '192.168.1.60');
  assert.equal(store.data.key, deviceKey('192.168.1.60', 8080));
});

test('the reference answers are those of the fixture', () => {
  assert.ok(PEK['/user/menu'].includes('name="Kessel"'));
  assert.equal(SELECTOR, 'test-integration');
  assert.ok(createFakeGladys && EtaApp && registerHandlers && recorder);
});
