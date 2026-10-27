// -----------------------------------------------------------------------------
// The integration: the address of the ETAtouch, a discovery of its menu (the
// devices of Discovery), one cycle per interval (60 s by default) that reads
// the active errors and the variables of the features created in Gladys, the
// "ETA error" scene trigger, the transport badges.
//
// Read only (v1): nothing is ever written to the boiler; every command Gladys
// could send is refused, nothing is sent.
//
// Careful reads: one request at a time (src/client.js); a cycle never starts
// sooner than one interval after the previous one, whatever asks for it
// (timer, test button, Discovery, restart: the time of the attempt is saved
// in /data before its first request); a 429 pauses every path for 60 s to
// 6 h; other failures back off (1 to 15 min, never under the interval). The
// pause, the last attempt, the catalog and the errors already seen are kept
// in /data and bounded.
//
// Two clocks: `now` (wall) only dates what /data keeps; `monotonic` paces
// the cycles, the pauses and the freshness, so that a wall clock set back or
// forward never stops nor hurries them. A decision reads the clock once.
// index.js only wires the SDK handlers to this class.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { discover } from './catalog.js';
import { EtaClient } from './client.js';
import { normalizeConfig } from './config.js';
import { LIMITS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  ERRORS_ID,
  buildDevices,
  isLifetimeCounter,
  deviceIds,
  errorStates,
  errorText,
  parseDeviceId,
  stateOf,
  variablesToRead,
} from './devices.js';
import { errorKey, parseErrors, parseValue } from './eta.js';
import { EtaError, errorReason } from './http.js';
import { T, age, join, reasonOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** Errors after which the ETAtouch did not answer at all. */
const OFFLINE = new Set(['network', 'timeout']);
/** Errors of one variable that mean the ETAtouch itself is in trouble. */
const DEVICE_FAILURE = new Set(['network', 'timeout', 'rate_limited', 'no_config']);

export class EtaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'eta' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.client = new EtaClient({ transport, monotonic, now, timers });
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, 0);
    this.generation = 0;
    this.timer = undefined;
    this.running = undefined;
    this.started = false;
    this.lastStatus = undefined;
    this.reset();
  }

  /** Forgets what belongs to the ETAtouch read so far. */
  reset() {
    /** The variables found in the menu (src/catalog.js), or null. */
    this.catalog = null;
    /** Monotonic time of the last discovery (its cooldown), or undefined. */
    this.discoveredAt = undefined;
    this.discoveryAsked = false;
    /** featureId -> { value, at (monotonic) } of the last cycle. */
    this.values = new Map();
    /** featureId -> true for the variables unreadable in the last cycle. */
    this.unreadable = new Set();
    /** featureId -> the highest value published of a lifetime counter. */
    this.counters = new Map();
    /** The failure of the error list in the last cycle, or undefined. */
    this.errorsFailure = undefined;
    /** Where the next cycle starts in the list of variables (after an interrupted one). */
    this.cursor = 0;
    /** The keys of the errors already seen (kept in /data), or undefined: the first read learns. */
    this.errorSeen = undefined;
    /** Monotonic time of the last cycle attempt (its first request), or undefined. */
    this.lastAttemptAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.readOnce = false;
    this.published = undefined;
    this.badges = new Map();
    /** /data could not be read: never written over in this run. */
    this.storeBroken = false;
    this.saveWarned = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    const generation = this.generation;
    this.config = normalizeConfig(raw);
    this.reset();
    this.client.configure(this.config);
    const loaded = await this.store.load().catch(() => ({ status: 'unreadable' }));
    if (generation !== this.generation) {
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    this.storeBroken = loaded?.status === 'unreadable';
    const memory = normalizeMemory(loaded?.status === 'ok' ? loaded.data : null, now);
    this.memory =
      memory.key === this.config.key
        ? memory
        : normalizeMemory({ key: this.config.key || undefined }, now);
    const { pause, catalog, errors, lastAttempt } = this.memory;
    if (pause) {
      this.pause = { kind: pause.kind, until: mono + (pause.until - now) };
      this.failures = pause.failures;
    }
    if (this.storeBroken || memory.future) {
      // Unknown time of the last read (unreadable /data, a date in the
      // future): never faster than the interval, so a full one first.
      this.lastAttemptAt = mono;
    } else if (lastAttempt !== undefined) {
      this.lastAttemptAt = mono - (now - lastAttempt);
    }
    if (catalog && catalog.variables === this.config.variables) {
      this.catalog = catalog;
      this.discoveredAt = mono - Math.max(0, now - catalog.at);
    }
    if (errors) {
      this.errorSeen = { seen: [...errors.seen] };
    }
    if (this.storeBroken) {
      this.logger.warn('ETA: /data/eta-state.json cannot be read; it is left as it is');
    }
    this.publisher.start();
    const missing = this.configMessage();
    if (missing) {
      await this.setStatus(false, missing);
      return;
    }
    await this.setStatus(false, this.pauseMessage(mono) ?? T.connecting);
    await this.publishDevices();
    this.scheduleNext();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.cancelConfigRetry();
    this.publisher.stop();
  }

  cancelConfigRetry() {
    this.configAttempt = (this.configAttempt ?? 0) + 1;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /**
   * Connected to Gladys: the configuration is asked with `getConfig`. When it
   * fails, it is asked again without end (5 s, 15 s, 30 s, then every 60 s)
   * under a status that says so; a newer connection, a saved configuration or
   * the stop cancel the retry.
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = this.configAttempt;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) {
        return;
      }
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures ?? 0, TIMINGS.configRetry.length - 1)];
      this.configFailures = (this.configFailures ?? 0) + 1;
      this.logger.warn(
        `ETA: reading the configuration from Gladys failed (${err?.name ?? 'error'}); again in ${Math.round(wait / 1000)} s`,
      );
      await this.setStatus(false, T.configRetry(age(wait)));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch((e) =>
            this.logger.error(`ETA: start failed: ${e?.message}`),
          );
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) {
      return;
    }
    this.configFailures = 0;
    await this.connected(raw);
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** What the configuration lacks, as a status message; undefined when complete. */
  configMessage() {
    if (this.config.addressError === 'path') {
      return T.addressPath;
    }
    if (this.config.addressError === 'invalid') {
      return T.addressInvalid;
    }
    return this.client.configured ? undefined : T.noConfig;
  }

  get configured() {
    return this.configMessage() === undefined;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges). The pause, the catalog and the client stay; no read is
   * started by a reconnection.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    // Gladys restarted: the values published before are sent again at the
    // next cycle, not skipped as unchanged.
    this.gladys.forgetPublishedStates?.();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** A new address restarts; the rest applies at once (no read started). */
  async configUpdated(raw = {}) {
    // A saved configuration brings it: no need to ask Gladys again.
    this.cancelConfigRetry();
    if (!this.started) {
      return this.connected(raw);
    }
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (
      next.host !== previous.host ||
      next.port !== previous.port ||
      next.addressError !== previous.addressError
    ) {
      return this.start(raw);
    }
    this.config = next;
    if (next.variables !== previous.variables) {
      // Read at the next cycle (never sooner than the interval).
      this.discoveryAsked = true;
    }
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  /** Saves the memory to /data (never over an unreadable file). Resolves true when saved. */
  async save() {
    if (this.storeBroken) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      this.saveWarned = false;
      return true;
    } catch (err) {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`ETA: saving the state to /data failed: ${err?.code ?? 'error'}`);
      }
      return false;
    }
  }

  /** The memory from the app's state, dated on the wall clock. */
  remember(mono = this.monotonic(), now = this.now()) {
    this.memory.key = this.config.key;
    this.memory.pause =
      this.pause && this.pause.until > mono
        ? { kind: this.pause.kind, until: now + (this.pause.until - mono), failures: this.failures }
        : null;
    this.memory.errors = this.errorSeen ? { seen: [...this.errorSeen.seen] } : null;
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Scheduling ------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The rest of the pause at `mono` (0 when none). */
  pauseLeft(mono) {
    return this.pause ? Math.max(0, this.pause.until - mono) : 0;
  }

  /** The monotonic time from which the next cycle may start, from the caller's `mono`. */
  dueAt(mono) {
    const after = this.lastAttemptAt === undefined ? mono : this.lastAttemptAt + this.interval;
    return Math.max(after, mono + this.pauseLeft(mono));
  }

  scheduleNext() {
    this.clearTimer();
    if (!this.configured) {
      return;
    }
    const mono = this.monotonic();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`ETA refresh failed: ${err.message}`));
        }
      },
      Math.max(0, this.dueAt(mono) - mono),
    );
  }

  /** One run at a time: a tick during a run joins it. */
  tick() {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Resolves once nothing runs (for the tests). */
  async idle() {
    while (this.running) {
      await this.running;
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.configured) {
      return;
    }
    const mono = this.monotonic();
    if (this.dueAt(mono) > mono) {
      // Too soon (a pause, or less than one interval since the last cycle).
      this.scheduleNext();
      return;
    }
    await this.begin(mono);
    if (generation !== this.generation) {
      return;
    }
    try {
      if (this.needsDiscovery()) {
        await this.discover(generation);
      }
      if (generation !== this.generation) {
        return;
      }
      const result = await this.cycle(generation);
      if (generation !== this.generation) {
        return;
      }
      this.failures = 0;
      this.offline = false;
      this.readOnce = true;
      if (this.pause?.kind === 'backoff' || this.pauseLeft(this.monotonic()) === 0) {
        this.pause = undefined;
      }
      this.remember();
      await this.save();
      let status = T.connected(result.read, result.unreadable, this.catalog?.reduced);
      if (result.errorsFailure) {
        status = join(status, T.errorsUnreadable(reasonOf(result.errorsFailure)));
      }
      if (this.catalog?.partial) {
        status = join(status, T.partial);
      }
      if (result.total > 0 && result.unreadable === result.total) {
        // Every variable failed: the ETAtouch answers, but gives nothing.
        await this.setStatus(false, T.allUnreadable(result.total));
      } else {
        await this.setStatus(true, status);
      }
    } catch (err) {
      if (generation !== this.generation || err?.kind === 'cancelled') {
        return;
      }
      if (!(err instanceof EtaError)) {
        this.logger.error(`ETA: internal error: ${err?.stack ?? err}`);
      }
      await this.failed(err);
    }
    await this.publishDevices();
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  /**
   * A cycle starts at `mono`: it is dated before its first request, in /data
   * too, so a restart right after never reads again sooner than the interval.
   */
  async begin(mono) {
    this.lastAttemptAt = mono;
    this.memory.lastAttempt = this.now();
    await this.save();
  }

  /** A failure: a pause or a backoff (kept in /data). Never a dead integration. */
  async failed(err) {
    const mono = this.monotonic();
    let wait;
    let message;
    if (err?.kind === 'rate_limited') {
      const asked = err.retryAfter ?? TIMINGS.rateLimitDefault;
      wait = Math.max(TIMINGS.rateLimitMin, Math.min(TIMINGS.rateLimitMax, asked));
      this.pause = { kind: 'rate', until: Math.max(mono + wait, this.pause?.until ?? 0) };
      message = T.rateLimited(age(wait));
    } else {
      wait = Math.max(
        this.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      const rate = this.pause?.kind === 'rate' && this.pause.until > mono;
      this.pause = {
        kind: rate ? 'rate' : 'backoff',
        until: Math.max(mono + wait, this.pause?.until ?? 0),
      };
      this.offline = OFFLINE.has(err?.kind) || err?.kind === 'no_config';
      message = T.unreachable(reasonOf(err), age(wait));
    }
    this.failures += 1;
    this.remember(mono);
    await this.save();
    await this.setStatus(err?.kind === 'rate_limited' && this.readOnce, message);
    this.logger.warn(`ETA: ${errorReason(err)}; next try in ${Math.round(wait / 1000)} s`);
  }

  // --- Discovery and cycles --------------------------------------------------

  needsDiscovery() {
    return !this.catalog || this.catalog.variables !== this.config.variables || this.discoveryAsked;
  }

  async discover(generation) {
    const variables = this.config.variables;
    const catalog = await discover(this.client, {
      variables,
      monotonic: this.monotonic,
      cancelled: () => generation !== this.generation,
      progress: (done, total) => {
        if (done % 20 === 0) {
          this.setStatus(this.readOnce, T.discovering(done, total)).catch(() => {});
        }
      },
    });
    if (generation !== this.generation) {
      return;
    }
    const mono = this.monotonic();
    this.catalog = { ...catalog, at: this.now() };
    this.discoveredAt = mono;
    this.discoveryAsked = false;
    this.memory.catalog = this.catalog;
    this.published = undefined;
    this.logger.info(
      `ETA: menu read, ${catalog.entries.length} variables in ${catalog.blocks.length} blocks` +
        `${catalog.reduced ? ' (reduced mode)' : ''}${catalog.partial ? ' (partial)' : ''}`,
    );
  }

  /** The devices of this integration created in Gladys. */
  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) => parseDeviceId(d.external_id) !== undefined);
  }

  /**
   * One cycle: the active errors, then the variables of the features created
   * in Gladys, one request at a time. The error list is a secondary resource:
   * when it fails (404, <error>, 5xx, too large, broken XML) the errors
   * device is not updated, its badge says so, and the values are read all
   * the same; only the ETAtouch gone (network, timeout, 429) ends the cycle.
   * A variable the ETAtouch does not know or cannot give (404, an <error>, a
   * 5xx, a broken value, another uri) only misses its value; the ETAtouch
   * gone (network or timeout twice in a row, 429) ends the cycle. The next
   * cycle starts after the variable it stopped at (rotation): a few
   * variables that never answer cannot starve the others.
   */
  async cycle(generation) {
    let errorsFailure;
    try {
      const errors = parseErrorsOrThrow(
        await this.client.get('/user/errors', { maxBytes: LIMITS.errorsBytes }),
      );
      if (generation !== this.generation) {
        return { read: 0, unreadable: 0, total: 0 };
      }
      this.ingestErrors(errors);
    } catch (err) {
      if (DEVICE_FAILURE.has(err?.kind) || !(err instanceof EtaError)) {
        throw err;
      }
      errorsFailure = err;
      this.logger.warn(`ETA: the error list could not be read: ${errorReason(err)}`);
    }
    this.errorsFailure = errorsFailure;
    const all = variablesToRead(this.createdDevices(), this.catalogUnits());
    const start = all.length > 0 ? this.cursor % all.length : 0;
    const list = [...all.slice(start), ...all.slice(0, start)];
    let read = 0;
    let failures = 0;
    const unreadable = new Set();
    for (const [index, variable] of list.entries()) {
      if (generation !== this.generation) {
        return { read, unreadable: unreadable.size, total: list.length, errorsFailure };
      }
      let value;
      try {
        value = parseValue(await this.client.get(`/user/var${variable.uri}`));
        failures = 0;
      } catch (err) {
        if (DEVICE_FAILURE.has(err?.kind)) {
          failures += 1;
          if (failures >= 2 || err.kind === 'rate_limited' || err.kind === 'no_config') {
            this.cursor = start + index + 1;
            throw err;
          }
        }
        unreadable.add(variable.id);
        continue;
      }
      if (value.uri !== undefined && value.uri !== variable.uri) {
        // The answer of another variable: never published under this one.
        unreadable.add(variable.id);
        continue;
      }
      const state = stateOf(variable.kind, value, variable.unit);
      if (state === undefined || !this.counterAccepts(variable, state)) {
        // "xxx", "---", a text, out of range, a counter going back: nothing published.
        this.values.delete(variable.id);
        continue;
      }
      read += 1;
      this.values.set(variable.id, { value: state, at: this.monotonic() });
      this.publisher.push(variable.id, state);
    }
    this.cursor = 0;
    this.unreadable = unreadable;
    return { read, unreadable: unreadable.size, total: list.length, errorsFailure };
  }

  /** uri -> unit of the "number" variables of the catalog. */
  catalogUnits() {
    return new Map(
      (this.catalog?.entries ?? []).filter((e) => e.kind === 'number').map((e) => [e.uri, e.unit]),
    );
  }

  /**
   * A lifetime counter (total consumption, full load hours, heating runs,
   * ignitions, kWh/MWh) is never published at 0 nor going back: the last
   * value known (this run, else the one Gladys holds) wins.
   */
  counterAccepts(variable, state) {
    if (!isLifetimeCounter(variable)) {
      return true;
    }
    if (state.state === 0) {
      return false;
    }
    const kept = this.counters.get(variable.id) ?? this.gladysValue(variable.id);
    if (kept !== undefined && state.state < kept) {
      this.logger.warn('ETA: a lifetime counter went back; the value is not published');
      return false;
    }
    this.counters.set(variable.id, state.state);
    return true;
  }

  /** The last value Gladys holds for a feature, or undefined. */
  gladysValue(featureId) {
    for (const device of this.createdDevices()) {
      const feature = (device.features ?? []).find((f) => f.external_id === featureId);
      if (feature) {
        const v = feature.last_value;
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      }
    }
    return undefined;
  }

  /**
   * The active errors: the states of the errors device and the "ETA error"
   * scene events. The keys already seen are kept in /data (200 at most): an
   * error never seen fires, one that stays or comes back never fires again;
   * the very first read without memory only learns.
   */
  ingestErrors(errors) {
    const language = this.config.language;
    const ids = deviceIds(this.gladys, ERRORS_ID);
    const mono = this.monotonic();
    const created = new Set(
      this.createdDevices().flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
    for (const [role, value] of Object.entries(errorStates(errors, language))) {
      this.values.set(ids.feature(role), { value, at: mono });
      // Only the features created in Gladys (it refuses the others).
      if (created.has(ids.feature(role))) {
        this.publisher.push(ids.feature(role), value);
      }
    }
    const keys = errors.map(errorKey);
    if (!this.errorSeen) {
      this.errorSeen = { seen: [...new Set(keys)].slice(-LIMITS.seenErrors) };
      return;
    }
    const { seen } = this.errorSeen;
    const events = [];
    errors.forEach((error, i) => {
      if (!seen.includes(keys[i])) {
        seen.push(keys[i]);
        events.push({
          message: errorText(error) ?? error.msg,
          block: error.blockName ?? '',
          priority: error.priority,
        });
      }
    });
    if (seen.length > LIMITS.seenErrors) {
      seen.splice(0, seen.length - LIMITS.seenErrors);
    }
    for (const data of events.slice(0, LIMITS.eventsPerRead)) {
      this.publisher.pushSceneEvent(SCENE_TRIGGERS.ERROR, data);
      this.logger.warn('ETA: new error on the boiler');
    }
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices() {
    if (!this.catalog && this.createdDevices().length === 0) {
      return;
    }
    const devices = buildDevices(
      this.gladys,
      this.catalog,
      this.createdDevices(),
      this.config.language,
    );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  badge(device) {
    if (this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (parseDeviceId(device.external_id) === ERRORS_ID && this.errorsFailure) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.errorsNotRead };
    }
    const unreadable = (device.features ?? []).some((f) => this.unreadable.has(f.external_id));
    return unreadable
      ? { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.notRead }
      : { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    const entries = [];
    for (const device of this.createdDevices()) {
      const entry = { external_id: device.external_id, ...this.badge(device) };
      const json = JSON.stringify(entry);
      if (this.badges.get(device.external_id) !== json) {
        entries.push([device.external_id, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /**
   * A device was created (or updated): its last values are sent at once if
   * they are fresh (read in the last two intervals), never older ones; its
   * other variables are read at the next cycle.
   */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const mono = this.monotonic();
    const fresh = 2 * this.interval + TIMINGS.requestTimeout;
    for (const feature of device?.features ?? []) {
      const kept = this.values.get(feature.external_id);
      if (kept && mono - kept.at <= fresh) {
        this.publisher.push(feature.external_id, kept.value);
      }
    }
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** Time left before a read asked by hand: max(30 s, interval) after the last attempt. */
  manualWait(mono) {
    const gap = Math.max(TIMINGS.testCooldown, this.interval);
    return this.lastAttemptAt === undefined ? 0 : Math.max(0, this.lastAttemptAt + gap - mono);
  }

  /**
   * The Discovery tab asks for a scan: the menu is read again (at most every
   * 10 minutes) at the next cycle, never sooner than the interval; the list
   * known so far is published at once.
   */
  async scan() {
    const mono = this.monotonic();
    if (
      this.configured &&
      (this.discoveredAt === undefined || mono - this.discoveredAt >= TIMINGS.discoveryCooldown)
    ) {
      this.discoveryAsked = true;
      if (!this.running && this.dueAt(mono) <= mono) {
        await this.tick();
        return;
      }
    }
    await this.publishDevices();
  }

  /** Every feature is read only: a command is refused, nothing is sent. */
  async setValue() {
    throw new Error(word(T.readOnly, this.config.language));
  }

  // --- Configuration button --------------------------------------------------

  pauseMessage(mono) {
    return this.pause?.kind === 'rate' && this.pauseLeft(mono) > 0
      ? T.rateLimited(age(this.pauseLeft(mono)))
      : undefined;
  }

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return missing;
    }
    const mono = this.monotonic();
    const paused = this.pauseMessage(mono);
    if (paused) {
      return paused;
    }
    if (this.running) {
      return T.busy;
    }
    const wait = Math.max(this.manualWait(mono), this.pauseLeft(mono));
    if (wait > 0) {
      const first = T.wait(age(wait));
      return this.lastMessage ? join(first, this.lastMessage) : first;
    }
    // A first reading of the whole menu may take minutes: the button answers
    // within Gladys' timeout of the action, the reading goes on.
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TIMINGS.buttonWait);
    });
    await Promise.race([this.tick(), late]);
    this.timers.clearTimeout(timer);
    return this.running
      ? join(T.busy, this.lastMessage ?? T.connecting)
      : (this.lastMessage ?? T.noConfig);
  }
}

/** The errors of an answer, or a bad_response EtaError. */
function parseErrorsOrThrow(root) {
  try {
    return parseErrors(root);
  } catch {
    throw new EtaError('bad_response', 'no error list in the answer');
  }
}
