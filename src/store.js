// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with the ETAtouch it belongs to (a hash of its address and
// port), bounded and repaired when read back:
// - `lastAttempt`: the wall time of the last cycle, saved BEFORE its first
//   request, so a restart never reads faster than the interval;
// - `pause`: a 429 pause or the backoff after failures (`until`, wall time);
// - `catalog`: the variables found in the menu (Discovery), so a restart does
//   not read the whole menu again;
// - `errors`: the keys of the active errors already seen (200 at most), so a
//   restart never fires an old error again nor misses a new one.
// A file that exists but cannot be read is not "empty": the app then never
// writes over it and waits a full interval before its first read.
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { parseAddress } from './eta.js';
import { NUMBER_UNITS } from './devices.js';

export const STATE_FILE = '/data/eta-state.json';

/**
 * `load()` resolves `{ status: 'ok', data }`, `{ status: 'missing' }` (no
 * file: a fresh install) or `{ status: 'unreadable' }`. `save()` writes
 * through a temporary file, one write at a time.
 */
export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
      }
      try {
        return { status: 'ok', data: JSON.parse(text) };
      } catch {
        return { status: 'unreadable' };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** A store in memory, for the tests and the scripts. */
export function memoryStore(initial) {
  let data = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    saves: 0,
    async load() {
      return data === undefined ? { status: 'missing' } : { status: 'ok', data: JSON.parse(data) };
    },
    async save(value) {
      this.saves += 1;
      data = JSON.stringify(value);
    },
    get data() {
      return data === undefined ? undefined : JSON.parse(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const KINDS = new Set(['temperature', 'bar', 'pascal', 'hours', 'number', 'text']);
const text = (value, max) =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;

function normalizeCatalog(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.blocks)
  ) {
    return null;
  }
  const blocks = raw.blocks
    .filter((b) => Number.isInteger(b?.node) && Number.isInteger(b?.fub))
    .slice(0, LIMITS.blocks)
    .map((b) => ({ node: b.node, fub: b.fub, name: text(b.name, LIMITS.nameLength) }));
  const entries = [];
  for (const e of raw.entries.slice(0, LIMITS.features)) {
    const address = parseAddress(e?.uri);
    if (!address || !KINDS.has(e.kind)) {
      continue;
    }
    const unit = e.kind === 'number' ? (NUMBER_UNITS.has(e.unit) ? e.unit : '') : '';
    entries.push({ ...address, name: text(e.name, 2 * LIMITS.nameLength), kind: e.kind, unit });
  }
  return {
    variables: raw.variables === 'all' ? 'all' : 'main',
    version: Array.isArray(raw.version) ? raw.version.slice(0, 2).map(Number) : null,
    reduced: raw.reduced === true,
    partial: raw.partial === true,
    at: time(raw.at) ?? 0,
    blocks,
    entries,
  };
}

/**
 * The persisted state, repaired. The end of a pause is capped from `now`
 * (a clock jump or a hand-edited file never stops for good); a last attempt
 * in the future is invalid (undefined: the app then waits a full interval).
 */
export function normalizeMemory(raw, now) {
  const key = typeof raw?.key === 'string' && /^[0-9a-f]{32}$/.test(raw.key) ? raw.key : '';
  if (!key) {
    return {
      key: '',
      lastAttempt: undefined,
      future: false,
      pause: null,
      catalog: null,
      errors: null,
    };
  }
  const p = raw.pause;
  const kind = p?.kind === 'backoff' ? 'backoff' : 'rate';
  const cap = kind === 'rate' ? TIMINGS.rateLimitMax : TIMINGS.backoff.at(-1) * 4;
  const pause =
    time(p?.until) && p.until > now
      ? {
          kind,
          until: Math.min(p.until, now + cap),
          failures: Number.isInteger(p.failures) && p.failures >= 0 ? Math.min(p.failures, 10) : 0,
        }
      : null;
  const attempt = time(raw.lastAttempt);
  const seen = Array.isArray(raw.errors?.seen)
    ? raw.errors.seen.filter((k) => text(k, 400) !== undefined).slice(-LIMITS.seenErrors)
    : null;
  return {
    key,
    lastAttempt: attempt !== undefined && attempt <= now ? attempt : undefined,
    future: attempt !== undefined && attempt > now,
    pause,
    catalog: normalizeCatalog(raw.catalog),
    errors: seen ? { seen } : null,
  };
}
