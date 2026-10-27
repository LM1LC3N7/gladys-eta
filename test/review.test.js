// -----------------------------------------------------------------------------
// The points of review r1: getConfig() failing at a connection, the error
// list as a secondary resource, numbers only when the display shows them,
// lifetime counters, the statuses, Retry-After dates, and the bounds of the
// discovery, of the 429 pause and of the states per minute.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/publisher.js';
import { discover } from '../src/catalog.js';
import { parseAnswer } from '../src/eta.js';
import { EtaError } from '../src/http.js';
import { parseRetryAfter } from '../src/http.js';
import { ACTIONS } from '../src/constants.js';
import {
  CONFIG,
  HOUR,
  MINUTE,
  SECOND,
  dev,
  errorsXml,
  feat,
  lastState,
  pekRoutes,
  settle,
  setup,
  statusOf,
  testClock,
  value,
  xml,
} from './helpers/eta.js';

const BOILER = '/40/10021/0/0/12161';
const POWER = '/40/10021/0/0/12077';
const TOTAL = '/40/10021/0/0/12016';
const HOURS = '/40/10021/0/0/12153';
const left = (app) => {
  const mono = app.monotonic();
  return app.dueAt(mono) - mono;
};
const count = (gladys, uri) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === feat(uri)).length;

test('getConfig() failing at the connection is asked again without end, with a status', async (t) => {
  let calls = 0;
  const { gladys, eta, wait } = await setup(t, {
    prepare: (g) => {
      const original = g.getConfig.bind(g);
      g.getConfig = async (...args) => {
        calls += 1;
        // The first call is the SDK's own, at connect().
        if (calls >= 2 && calls <= 4) throw new Error('timeout of 10000ms exceeded');
        return original(...args);
      };
    },
  });
  assert.equal(eta.requests.length, 0);
  assert.equal(statusOf(gladys).connected, false);
  assert.match(statusOf(gladys).message.en, /configuration could not be read.*5 s/);
  await wait(5 * SECOND);
  assert.match(statusOf(gladys).message.en, /15 s/);
  await wait(15 * SECOND);
  assert.match(statusOf(gladys).message.en, /30 s/);
  await wait(30 * SECOND);
  assert.equal(calls, 5);
  await wait(0);
  assert.ok(eta.count('/user/menu') === 1, 'started');
  assert.equal(statusOf(gladys).connected, true);
});

test('getConfig() failing: a saved configuration starts at once and cancels the retry', async (t) => {
  let calls = 0;
  const { gladys, eta, wait } = await setup(t, {
    prepare: (g) => {
      const original = g.getConfig.bind(g);
      g.getConfig = async (...args) => {
        calls += 1;
        if (calls === 1) return original(...args);
        throw new Error('down');
      };
    },
  });
  await gladys.fake.configUpdated(CONFIG);
  await wait(0);
  assert.equal(eta.count('/user/menu'), 1);
  await wait(10 * MINUTE);
  assert.equal(calls, 2, 'no retry after the configuration came');
});

for (const [name, answer] of [
  ['404', { status: 404, body: '' }],
  ['an <error> answer', xml('<error>Illegal resource identifier</error>')],
  ['500', { status: 500, body: '' }],
  ['a list over 256 KB', xml(`<errors>${'<fub uri="/1/2" name="x"/>'.repeat(12_000)}</errors>`)],
  [
    'an unescaped "<"',
    xml(
      '<errors><fub uri="/40/10021" name="K"><error msg="T < 5" priority="E">x</error></fub></errors>',
    ),
  ],
]) {
  test(`the error list failing (${name}) never stops the values`, async (t) => {
    const { gladys, eta, wait, app } = await setup(t, { create: true });
    eta.routes['/user/errors'] = answer;
    eta.routes[`/user/var${BOILER}`] = value(BOILER, {
      str: '70',
      raw: 700,
      unit: '°C',
      scale: 10,
    });
    await wait(left(app));
    assert.equal(lastState(gladys, feat(BOILER)), 70);
    assert.equal(statusOf(gladys).connected, true);
    assert.match(statusOf(gladys).message.en, /error list could not be read/);
    const badge = gladys.fake.transports
      .filter((b) => b.device_external_id === dev('errors'))
      .at(-1);
    assert.equal(badge.degraded, true);
  });
}

test('the error list: no answer at all ends the cycle', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  eta.routes['/user/errors'] = 'refused';
  const before = eta.requests.length;
  await wait(left(app));
  assert.equal(eta.requests.length, before + 1);
  assert.equal(statusOf(gladys).connected, false);
});

test('texts and time slots never become 0; units checked for numbers too', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  const boiler = count(gladys, BOILER);
  const power = count(gladys, POWER);
  eta.routes[`/user/var${POWER}`] = value(POWER, { str: 'Aus', raw: 0 });
  eta.routes[`/user/var${BOILER}`] = value(BOILER, { str: 'Aus', raw: 0, unit: '°C' });
  await wait(left(app));
  assert.equal(count(gladys, BOILER), boiler);
  assert.equal(count(gladys, POWER), power);
  // A % value on the "(kW)" feature.
  eta.routes[`/user/var${POWER}`] = value(POWER, {
    str: '99,9',
    raw: 999,
    unit: '%',
    scale: 10,
    dec: 1,
  });
  // A raw value that disagrees with the display.
  eta.routes[`/user/var${BOILER}`] = value(BOILER, { str: '67', raw: 0, unit: '°C', scale: 10 });
  await wait(left(app));
  assert.equal(count(gladys, BOILER), boiler);
  assert.equal(count(gladys, POWER), power);
  // The answer of another variable.
  eta.routes[`/user/var${BOILER}`] = value('/40/10021/0/0/12162', {
    str: '74',
    raw: 740,
    unit: '°C',
    scale: 10,
  });
  await wait(left(app));
  assert.equal(count(gladys, BOILER), boiler);
});

test('reduced mode, all values: a time slot is not a temperature', async (t) => {
  const routes = pekRoutes({ '/user/api': undefined });
  const { gladys } = await setup(t, { routes, config: { ...CONFIG, variables: 'all' } });
  const ww = gladys.fake.discoveredDevices.find((d) => d.external_id === dev('120-10111'));
  assert.ok(ww);
  assert.equal(
    ww.features.find((f) => f.external_id === feat('/120/10111/12130/0/1082')),
    undefined,
  );
});

test('lifetime counters are never published at 0 nor going back', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  await wait(left(app));
  assert.equal(lastState(gladys, feat(TOTAL)), 13400.5);
  const before = count(gladys, TOTAL);
  eta.routes[`/user/var${TOTAL}`] = value(TOTAL, { str: '0', raw: 0, unit: 'kg', scale: 10 });
  eta.routes[`/user/var${HOURS}`] = value(HOURS, { str: '0h 0m', raw: 0, unit: 's' });
  await wait(left(app));
  eta.routes[`/user/var${TOTAL}`] = value(TOTAL, {
    str: '13000',
    raw: 130000,
    unit: 'kg',
    scale: 10,
  });
  await wait(left(app));
  assert.equal(count(gladys, TOTAL), before);
  assert.equal(lastState(gladys, feat(TOTAL)), 13400.5);
  assert.equal(lastState(gladys, feat(HOURS)), 6940.68);
  eta.routes[`/user/var${TOTAL}`] = value(TOTAL, {
    str: '13410',
    raw: 134100,
    unit: 'kg',
    scale: 10,
  });
  await wait(left(app));
  assert.equal(lastState(gladys, feat(TOTAL)), 13410);
});

test('every variable failing: not "Connected"', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  for (const path of Object.keys(eta.routes)) {
    if (path.startsWith('/user/var/'))
      eta.routes[path] = xml('<error>Illegal resource identifier</error>');
  }
  await wait(left(app));
  assert.equal(statusOf(gladys).connected, false);
  assert.match(statusOf(gladys).message.en, /none of the \d+ values/);
});

test('Retry-After as a date is compared to the Date header of the answer', () => {
  const date = 'Tue, 27 Oct 2026 10:05:00 GMT';
  const sent = 'Tue, 27 Oct 2026 10:00:00 GMT';
  // The local clock is a day late: the device's clock decides.
  assert.equal(parseRetryAfter(date, Date.UTC(2026, 9, 26, 10), sent), 5 * MINUTE);
  assert.equal(parseRetryAfter(date, Date.UTC(2026, 9, 27, 10), 'garbage'), 5 * MINUTE);
});

test('429: the pause is capped at 6 h', async (t) => {
  const { gladys, eta, wait, app } = await setup(t, { create: true });
  eta.routes['/user/errors'] = {
    status: 429,
    headers: { 'retry-after': String(48 * 3600) },
    body: '',
  };
  await wait(left(app));
  assert.match(statusOf(gladys).message.en, /in 6 h/);
  eta.routes['/user/errors'] = errorsXml([]);
  const before = eta.requests.length;
  await wait(6 * HOUR - MINUTE);
  assert.equal(eta.requests.length, before);
  await wait(2 * MINUTE);
  assert.ok(eta.requests.length > before);
  assert.ok((await gladys.fake.action(ACTIONS.TEST_CONNECTION)).success);
});

test('a menu over the element limit: "too large", not "not an ETAtouch"', async (t) => {
  const huge = xml(
    `<menu><fub uri="/40/10021" name="K">${'<object uri="/40/10021/0/0/1" name="x"/>'.repeat(61_000)}</fub></menu>`,
  );
  const { gladys } = await setup(t, { routes: pekRoutes({ '/user/menu': huge }) });
  assert.match(statusOf(gladys).message.en, /too large/);
});

test('discovery: bounded to 10 minutes on a slow ETAtouch, partial kept', async () => {
  // A client whose every request takes 9 s on a fake monotonic clock.
  let t = 0;
  const routes = pekRoutes();
  const client = {
    async get(path) {
      t += 9 * SECOND;
      const answer = routes[path];
      if (answer === undefined) throw new EtaError('not_found', 'unknown');
      return parseAnswer(answer);
    },
  };
  const catalog = await discover(client, {
    variables: 'all',
    monotonic: () => t,
    cancelled: () => false,
  });
  assert.equal(catalog.partial, true);
  assert.ok(t <= 10 * MINUTE + 3 * 9 * SECOND, `${t} ms`);
  assert.ok(catalog.entries.length > 0);
});

test('discovery: five network failures in a row stop it', async (t) => {
  const routes = pekRoutes();
  for (const path of Object.keys(routes)) {
    if (path.startsWith('/user/varinfo/')) routes[path] = 'timeout';
  }
  const { gladys, eta } = await setup(t, { routes });
  assert.equal(eta.requests.filter((r) => r.path.startsWith('/user/varinfo/')).length, 5);
  assert.equal(statusOf(gladys).connected, false);
});

test('publisher: 280 states per minute at most, the rest later', async () => {
  const clock = testClock();
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
    publishSceneEvent: async () => {},
  };
  const publisher = new StatePublisher({
    gladys,
    logger: console,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  for (let i = 0; i < 600; i += 1) publisher.push(`f${i}`, { state: i });
  for (let i = 0; i < 5; i += 1) await publisher.flush();
  assert.equal(sent.length, 280);
  await clock.advance(MINUTE + SECOND);
  for (let i = 0; i < 5; i += 1) await publisher.flush();
  assert.equal(sent.length, 560);
  await settle();
});

test('a lifetime counter read at 0 with nothing known before is not published', async (t) => {
  const routes = pekRoutes();
  const { gladys, eta, wait, app } = await setup(t, { routes, create: true });
  eta.routes[`/user/var${TOTAL}`] = value(TOTAL, { str: '0', raw: 0, unit: 'kg', scale: 10 });
  await wait(left(app));
  assert.equal(lastState(gladys, feat(TOTAL)), undefined);
  assert.ok(lastState(gladys, feat(BOILER)) !== undefined);
});
