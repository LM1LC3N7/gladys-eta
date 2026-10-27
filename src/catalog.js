// -----------------------------------------------------------------------------
// Discovery: what the ETAtouch offers, read from its menu (as the reference
// does, Tidone/homeassistant_eta_integration 1.4.2, MIT, changed: see
// THIRD_PARTY_NOTICES.md).
//
// 1. /user/api: the API version. 1.2 and later have /user/varinfo; before
//    (or when /user/api does not answer), the reduced mode: the kind of a
//    variable is guessed from its value alone, its name from the menu.
// 2. /user/menu: the functional blocks and their variables (bounded: 2 MB,
//    800 objects, 30 s).
// 3. For the variables chosen ("main": a fixed list of ids; "all": every
//    object of the menu), varinfo (1.2) then the value, one request at a
//    time, classified into a kind (src/devices.js classify).
// The whole discovery is bounded in time (10 min): past it, what was read is
// kept and marked "partial". Requests only read (GET): nothing is written.
// -----------------------------------------------------------------------------

import { INTERFACE, LIMITS, MAIN_VARIABLES, TIMINGS } from './constants.js';
import { atLeast, parseApiVersion, parseMenu, parseValue, parseVarInfo } from './eta.js';
import { classify } from './devices.js';
import { EtaError } from './http.js';

/** Errors after which the ETAtouch is gone (the discovery stops); others skip one variable. */
const FATAL = new Set(['network', 'timeout', 'rate_limited', 'unavailable', 'no_config']);

/**
 * Reads the menu and classifies the variables. `client`: an EtaClient;
 * `variables`: 'main' | 'all'; `monotonic`: the clock of the budget;
 * `cancelled()`: true when the app stopped or restarted; `progress(done,
 * total)`: called between two variables. Resolves the catalog, or rejects
 * with an EtaError.
 */
export async function discover(client, { variables, monotonic, cancelled, progress = () => {} }) {
  const deadline = monotonic() + TIMINGS.discoveryBudget;
  let version;
  try {
    version = parseApiVersion(await client.get('/user/api'));
  } catch (err) {
    if (FATAL.has(err?.kind)) {
      throw err;
    }
    version = undefined;
  }
  const reduced = !atLeast(version, INTERFACE.varinfoVersion);
  const root = await client.get('/user/menu', {
    timeout: TIMINGS.menuTimeout,
    maxBytes: LIMITS.menuBytes,
    maxNodes: LIMITS.menuNodes,
  });
  let menu;
  try {
    menu = parseMenu(root);
  } catch {
    throw new EtaError('bad_response', 'no menu in the answer');
  }
  const candidates =
    variables === 'all'
      ? menu.objects
      : menu.objects.filter((o) => o.fkt === 0 && o.io === 0 && MAIN_VARIABLES.has(o.id));
  const entries = [];
  let partial = menu.truncated;
  let failures = 0;
  for (const [index, object] of candidates.entries()) {
    if (cancelled()) {
      throw new EtaError('cancelled', 'stopped');
    }
    if (monotonic() >= deadline || entries.length >= LIMITS.features) {
      partial = true;
      break;
    }
    progress(index, candidates.length);
    try {
      const info = reduced
        ? undefined
        : parseVarInfo(await client.get(`/user/varinfo${object.uri}`));
      if (info?.type === 'TIMESLOT') {
        failures = 0;
        continue;
      }
      const value = parseValue(await client.get(`/user/var${object.uri}`));
      failures = 0;
      const kind = classify(value, info);
      if (kind) {
        entries.push({
          ...object,
          name: info?.fullName ?? object.path.join(' > '),
          ...kind,
        });
      }
    } catch (err) {
      if (FATAL.has(err?.kind)) {
        failures += 1;
        if (failures >= LIMITS.failuresInARow || err.kind === 'rate_limited') {
          throw err;
        }
      }
      // Any other answer (404, an <error>, a broken value): this variable only.
    }
  }
  return {
    variables,
    version: version ?? null,
    reduced,
    partial,
    blocks: menu.blocks.filter((b) => entries.some((e) => e.node === b.node && e.fub === b.fub)),
    entries,
  };
}
