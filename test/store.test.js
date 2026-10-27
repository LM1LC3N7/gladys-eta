// -----------------------------------------------------------------------------
// /data: the file store and the repair of what it holds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TIMINGS } from '../src/constants.js';
import { fileStore, normalizeMemory } from '../src/store.js';

const KEY = 'a'.repeat(32);
const NOW = Date.UTC(2026, 9, 27, 10);

test('file store: missing, saved (0600), unreadable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'eta-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { status: 'missing' });
  await store.save({ key: KEY });
  assert.deepEqual(await store.load(), { status: 'ok', data: { key: KEY } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  assert.equal(await readFile(path, 'utf8'), '{broken');
  if (process.getuid?.() !== 0) {
    await store.save({ key: KEY });
    await chmod(path, 0o000);
    assert.deepEqual(await store.load(), { status: 'unreadable' });
  }
});

test('memory: pause capped, last attempt in the future invalid, catalog checked', () => {
  const memory = normalizeMemory(
    {
      key: KEY,
      lastAttempt: NOW + 1000,
      pause: { kind: 'rate', until: NOW + 365 * 86_400_000, failures: 99 },
      catalog: {
        variables: 'main',
        blocks: [{ node: 40, fub: 10021, name: 'Kessel' }, { node: 'x' }],
        entries: [
          { uri: '/40/10021/0/0/12161', kind: 'temperature', name: 'K' },
          { uri: '/40/10021/0/0/1', kind: 'switch' },
          { uri: '../etc', kind: 'text' },
          { uri: '/40/10021/0/0/12016', kind: 'number', unit: '<script>' },
        ],
      },
      errors: { seen: ['a', 1, 'b'] },
    },
    NOW,
  );
  assert.equal(memory.lastAttempt, undefined);
  assert.equal(memory.future, true);
  assert.equal(memory.pause.until, NOW + TIMINGS.rateLimitMax);
  assert.equal(memory.pause.failures, 10);
  assert.equal(memory.catalog.blocks.length, 1);
  assert.deepEqual(
    memory.catalog.entries.map((e) => [e.uri, e.kind, e.unit]),
    [
      ['/40/10021/0/0/12161', 'temperature', ''],
      ['/40/10021/0/0/12016', 'number', ''],
    ],
  );
  assert.deepEqual(memory.errors.seen, ['a', 'b']);
  assert.equal(normalizeMemory({ key: KEY, pause: { until: NOW - 1 } }, NOW).pause, null);
  assert.equal(normalizeMemory({ key: 'bad' }, NOW).key, '');
  assert.equal(normalizeMemory(null, NOW).catalog, null);
});
