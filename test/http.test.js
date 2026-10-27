// -----------------------------------------------------------------------------
// The HTTP access on a real local server: GET only, bounded answers (cut
// before the end), timeouts, statuses, errors without the address.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EtaClient } from '../src/client.js';
import { httpGet, parseRetryAfter } from '../src/http.js';
import { etaServer, pekRoutes } from './helpers/eta.js';

const client = (port) => {
  const c = new EtaClient({ monotonic: () => performance.now(), now: Date.now });
  c.configure({ host: '127.0.0.1', port });
  return c;
};

test('a GET of the ETAtouch: XML parsed, statuses, one request at a time', async (t) => {
  const srv = await etaServer(
    pekRoutes({ '/user/limited': { status: 429, headers: { 'retry-after': '120' }, body: '' } }),
  );
  t.after(() => srv.close());
  const c = client(srv.port);
  const root = await c.get('/user/api');
  assert.equal(root.name, 'eta');
  await assert.rejects(c.get('/user/nothing'), { kind: 'not_found' });
  await assert.rejects(c.get('/user/limited'), { kind: 'rate_limited', retryAfter: 120_000 });
  srv.routes['/user/x'] = { status: 403, body: '' };
  await assert.rejects(c.get('/user/x'), { kind: 'forbidden' });
  srv.routes['/user/x'] = { status: 503, body: '' };
  await assert.rejects(c.get('/user/x'), { kind: 'unavailable' });
  srv.routes['/user/x'] = '<html/>';
  await assert.rejects(c.get('/user/x'), { kind: 'bad_response' });
  assert.ok(srv.requests.every((r) => r.method === 'GET'));
  // Concurrent calls leave one after the other, spaced.
  srv.latencyMs = 30;
  const before = srv.requests.length;
  await Promise.all([c.get('/user/api'), c.get('/user/api'), c.get('/user/api')]);
  const at = srv.requests.slice(before).map((r) => r.at);
  assert.ok(at[1] - at[0] >= 90 && at[2] - at[1] >= 90, `${at}`);
});

test('an endless answer is cut at the limit, without waiting for its end', async (t) => {
  let written = 0;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/xml\r\n\r\n<eta>');
      const timer = setInterval(() => {
        if (socket.destroyed) return clearInterval(timer);
        written += 16384;
        socket.write(' '.repeat(16384));
      }, 1);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await assert.rejects(
    httpGet({ host: '127.0.0.1', port, path: '/user/menu' }, { maxBytes: 100_000 }),
    {
      kind: 'size',
    },
  );
  assert.ok(written < 1_000_000, `${written} bytes written`);
  // Announced too large: refused at the headers.
  const big = await etaServer({ '/x': { status: 200, body: 'x'.repeat(200_000) } });
  t.after(() => big.close());
  await assert.rejects(
    httpGet({ host: '127.0.0.1', port: big.port, path: '/x' }, { maxBytes: 1000 }),
    {
      kind: 'size',
    },
  );
});

test('a silent ETAtouch times out; a closed port is a network error without the address', async (t) => {
  const srv = await etaServer({ '/user/api': 'timeout' });
  t.after(() => srv.close());
  await assert.rejects(
    httpGet({ host: '127.0.0.1', port: srv.port, path: '/user/api' }, { timeout: 200 }),
    {
      kind: 'timeout',
    },
  );
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const err = await httpGet({ host: '127.0.0.1', port, path: '/user/api' }).catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.doesNotMatch(err.message, /127\.0\.0\.1/);
});

test('Retry-After: seconds or a date', () => {
  assert.equal(parseRetryAfter('60', 0), 60_000);
  assert.equal(parseRetryAfter('Tue, 27 Oct 2026 10:01:00 GMT', Date.UTC(2026, 9, 27, 10)), 60_000);
  assert.equal(parseRetryAfter('soon', 0), undefined);
  assert.equal(parseRetryAfter(undefined, 0), undefined);
});
