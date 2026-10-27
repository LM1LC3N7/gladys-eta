// -----------------------------------------------------------------------------
// Constants of the ETAtouch RESTful webservices and of the integration.
//
// The interface comes from the manufacturer's document "ETAtouch RESTful
// Webservices", version 1.2 (2019-11-11): HTTP on port 8080, XML answers in
// the namespace http://www.eta.co.at/rest/v1, the resources /user/api,
// /user/menu, /user/var, /user/varinfo (API 1.2, system software x.49.0 and
// later) and /user/errors. No authentication: the LAN access is turned on on
// meineta.at and on the touch display. The variable ids picked by default and
// the units come from Tidone/homeassistant_eta_integration 1.4.2 (MIT, see
// THIRD_PARTY_NOTICES.md) and its answers of a real PE-K boiler.
// -----------------------------------------------------------------------------

/** The manifest action keys. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The manifest scene trigger keys. */
export const SCENE_TRIGGERS = {
  ERROR: 'eta_error',
};

/** The webservices of the ETAtouch. */
export const INTERFACE = {
  defaultPort: 8080,
  namespace: 'http://www.eta.co.at/rest/v1',
  /** /user/varinfo exists from this API version on; below, the reduced mode. */
  varinfoVersion: [1, 2],
};

/** Gladys values (server/utils/constants.js of the core). */
export const GLADYS = {
  ON: 1,
  OFF: 0,
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { default: 60, min: 60, max: 3600 };

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request (the touch display answers in about 0.1 s; a big menu takes longer). */
  requestTimeout: 10_000,
  menuTimeout: 30_000,
  /** Two requests are never closer than this, whatever asks for them. */
  minRequestGap: 100,
  /** Pauses after failures, never shorter than the poll interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** 429: a pause between 60 s and 6 h, Retry-After when given. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** The test button answers within this (the action's timeout is 120 s). */
  buttonWait: 90_000,
  /** The test button reads at most every 30 s (and never faster than the interval). */
  testCooldown: 30_000,
  /** A Discovery scan reads the menu again at most every 10 minutes. */
  discoveryCooldown: 10 * MINUTE,
  /** The whole reading of the menu (menu, varinfo, values) stops after this. */
  discoveryBudget: 10 * MINUTE,
  /** States flushed to Gladys every second; unchanged ones again every 30 min. */
  flushInterval: 1_000,
  stateHeartbeat: 30 * MINUTE,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute. */
  statesPerMinute: 280,
  statesPerRequest: 100,
  sceneEventsPerMinute: 280,
  queuedEvents: 200,
  /** The menu of a big installation is about 50 KB; one value or varinfo about 1 KB. */
  menuBytes: 2 * 1024 * 1024,
  answerBytes: 64 * 1024,
  /** XML: elements and depth of one answer. */
  xmlNodes: 20_000,
  xmlDepth: 32,
  /** Objects of the menu looked at by one discovery ("all variables"). */
  menuObjects: 800,
  /** Functional blocks (devices) and features published. */
  blocks: 40,
  featuresPerDevice: 150,
  features: 400,
  /** Variables read in one cycle (the features created in Gladys). */
  variablesPerCycle: 300,
  /** Requests failing in a row before a discovery or a cycle gives up. */
  failuresInARow: 5,
  /** Active errors read, and their keys remembered in /data. */
  errors: 50,
  seenErrors: 200,
  /** Scene events fired by one read at most. */
  eventsPerRead: 5,
  /** A text state, a name. */
  textLength: 160,
  nameLength: 80,
};

/**
 * The variables shown by default ("main"): the last part of their address
 * (`/<node>/<fub>/0/0/<var id>`). These ids are the same on every ETAtouch
 * (the manufacturer's document and the reference's PE-K answers agree on
 * 12153 "Full load hours", 12080 "On/off button"...); their names come from
 * the display, in its language.
 */
export const MAIN_VARIABLES = new Set([
  // States of the functional blocks (boiler, heating circuit, hot water, extraction).
  19402, 19404, 19406, 19417,
  // Modes shown by "Miscellaneous" (heating circuit, hot water).
  12090, 12129,
  // Boiler: temperatures, setpoint, flue gas, pressure, oxygen, feed, power asked.
  12161, 12001, 12300, 12162, 12180, 12164, 12007, 12077,
  // Outdoor temperature, flow of a heating circuit, hot water and its setpoint.
  12197, 12241, 12271, 12132,
  // Pellets: stock, hopper, consumption (total, since service, since de-ashing, since the ash box).
  12015, 12011, 12016, 12014, 12012, 12013,
  // Counters: full load hours, heating runs, ignitions.
  12153, 12017, 12018,
  // De-ashing and hopper states.
  12050, 12005,
]);
