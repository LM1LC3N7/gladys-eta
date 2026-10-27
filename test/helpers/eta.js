// -----------------------------------------------------------------------------
// A fake ETAtouch behind the transport (virtual clock), the same routes over a
// real local HTTP server (real clock), and the app wired as in the container
// (src/handlers.js) against the SDK's fake Gladys.
//
// The answers of test/fixtures/pek.json come from the fixtures of
// Tidone/homeassistant_eta_integration 1.4.2 (MIT, see THIRD_PARTY_NOTICES.md):
// a real ETA PE-K and its heating circuits, API 1.2.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EtaApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { EtaError } from '../../src/http.js';
import { memoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const HOST = '192.168.1.50';
export const CONFIG = { host: HOST };
export const SELECTOR = 'test-integration';

export const PEK = JSON.parse(
  readFileSync(new URL('../fixtures/pek.json', import.meta.url), 'utf8'),
);

export const dev = (block) => `ext:${SELECTOR}:eta:${block}`;
export const feat = (uri) => {
  const [node, fub, fkt, io, id] = uri.split('/').filter(Boolean);
  return `ext:${SELECTOR}:eta:${node}-${fub}:${fkt}-${io}-${id}`;
};

export const xml = (inner) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<eta version="1.0" xmlns="http://www.eta.co.at/rest/v1">\n${inner}\n</eta>\n`;

/** A /user/var answer. */
export const value = (uri, { str, raw, unit = '', scale = 1, dec = 0, offset = 0 }) =>
  xml(
    `<value uri="/user/var${uri}" strValue="${str}" unit="${unit}" decPlaces="${dec}" scaleFactor="${scale}" advTextOffset="${offset}">${raw}</value>`,
  );

/** A /user/errors answer, from `[{ fub, name, msg, priority, time, text }]`. */
export function errorsXml(list = []) {
  const blocks = new Map();
  for (const e of list) {
    const key = `${e.fub ?? '/40/10021'}|${e.name ?? 'Kessel'}`;
    blocks.set(key, [...(blocks.get(key) ?? []), e]);
  }
  const body = [...blocks]
    .map(([key, errors]) => {
      const [uri, name] = key.split('|');
      const inner = errors
        .map(
          (e) =>
            `<error msg="${e.msg}" priority="${e.priority ?? 'Error'}" time="${e.time ?? '2026-01-01 10:00:00'}">${e.text ?? ''}</error>`,
        )
        .join('\n');
      return `<fub uri="${uri}" name="${name}">${inner}</fub>`;
    })
    .join('\n');
  return xml(`<errors uri="/user/errors">${body}<fub uri="/120/10101" name="HK"/></errors>`);
}

/**
 * The routes of a PE-K: path -> XML text, `{ status, body, headers }`,
 * 'timeout', 'refused', or a function (path) -> one of those.
 */
export function pekRoutes(overrides = {}) {
  return { ...PEK, '/user/errors': errorsXml([]), ...overrides };
}

/** The fake ETAtouch behind the transport: every request recorded with its time. */
export function fakeEta({ routes = pekRoutes(), clock } = {}) {
  const eta = {
    routes,
    requests: [],
    /** Requests in flight (at most 1 when the client serializes them). */
    inFlight: 0,
    peak: 0,
    /** A promise the next answers wait for (a slow ETAtouch), or undefined. */
    hold: undefined,
    count: (path) => eta.requests.filter((r) => r.path === path).length,
    async transport({ host, port, path }, { maxBytes }) {
      eta.requests.push({ host, port, path, at: clock?.monotonic() });
      eta.inFlight += 1;
      eta.peak = Math.max(eta.peak, eta.inFlight);
      try {
        if (eta.hold) await eta.hold;
        let answer = eta.routes[path];
        if (typeof answer === 'function') answer = answer(path);
        if (answer === 'timeout') throw new EtaError('timeout', 'no answer within 10 s');
        if (answer === 'refused') throw new EtaError('network', 'connection refused');
        if (answer === undefined)
          return { status: 404, headers: {}, body: Buffer.from('not found') };
        const reply = typeof answer === 'string' ? { status: 200, body: answer } : answer;
        const body = Buffer.from(reply.body ?? '');
        if (body.length > maxBytes) throw new EtaError('size', 'answer too large');
        return { status: reply.status, headers: reply.headers ?? {}, body };
      } finally {
        eta.inFlight -= 1;
      }
    },
  };
  return eta;
}

/** The same routes over a real HTTP server on 127.0.0.1. */
export async function etaServer(routes = pekRoutes()) {
  const srv = { routes, requests: [], latencyMs: 0 };
  const server = createServer((req, res) => {
    srv.requests.push({ path: req.url, at: performance.now(), method: req.method });
    const respond = () => {
      let answer = srv.routes[req.url];
      if (typeof answer === 'function') answer = answer(req.url);
      if (answer === 'timeout') return;
      if (answer === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      const reply = typeof answer === 'string' ? { status: 200, body: answer } : answer;
      res.writeHead(reply.status, { 'content-type': 'application/xml', ...(reply.headers ?? {}) });
      res.end(reply.body);
    };
    if (srv.latencyMs > 0) setTimeout(respond, srv.latencyMs);
    else respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  srv.port = server.address().port;
  srv.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return srv;
}

/** A logger keeping every line. */
export const recorder = (lines = []) => ({
  lines,
  ...Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) =>
        lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  ),
});

/**
 * The app on a virtual clock. `create`: create every discovered device in
 * Gladys after the first cycle (as the user would).
 */
export async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    clock = testClock({ start: Date.UTC(2026, 9, 27, 10) }),
    routes,
    eta = fakeEta({ routes, clock }),
    devices = [],
    create = false,
    prepare = () => {},
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  prepare(gladys);
  const logger = recorder();
  const app = new EtaApp({
    gladys,
    logger,
    transport: eta.transport,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  // Moves the virtual clock by `ms`, then on by small steps while a run is
  // still going (its requests are spaced on the same virtual timers).
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle();
    for (let i = 0; i < 100_000 && app.running; i += 1) {
      await clock.advance(10);
      await settle(2);
    }
    await settle();
  };
  await gladys.connect();
  await wait(0);
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  return { gladys, app, eta, clock, store, wait, logger };
}

export const statusOf = (gladys) => gladys.fake.connectionStatus;
export const lastState = (gladys, id) => gladys.fake.lastState(id);
export { settle, testClock };
