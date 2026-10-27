// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// a real local HTTP server playing the ETAtouch: the cycles really start at
// the interval, measured on the method that decides, with a bounded number
// of timers. The time is sped up 20 times (60 s of the interval are 3 s),
// but it is the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EtaApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { etaServer, pekRoutes } from './helpers/eta.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('real clock x20: cycles at 0, the interval, twice the interval', async (t) => {
  const srv = await etaServer(pekRoutes());
  t.after(() => srv.close());
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const gladys = createFakeGladys({ selector: 'eta', config: {} });
  await gladys.connect();
  const app = new EtaApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  // `begin` dates a cycle once it is decided (its first request may follow a discovery).
  const spy = spyOn(app, 'begin', clock);
  let gaps;
  try {
    await app.start({ host: '127.0.0.1', port: srv.port });
    gaps = await measurePeriod(spy, { count: 3, period: 60_000, timeoutMs: 20_000 });
  } finally {
    app.stop();
    await app.idle();
  }
  assert.equal(gaps.length, 2);
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(srv.requests.every((r) => r.method === 'GET'));
});
