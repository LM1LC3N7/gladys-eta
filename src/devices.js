// -----------------------------------------------------------------------------
// The variables of the ETAtouch -> Gladys devices and states (pure).
//
// One Gladys device per functional block of the menu (boiler, heating
// circuit, hot water, store...), `ext:<selector>:eta:<node>-<fub>`, and one
// feature per variable, `...:<fkt>-<io>-<var id>`: the address the ETAtouch
// gives the variable, the same after an IP change or a firmware update.
// Plus the "errors" device (`ext:<selector>:eta:errors`) of the active errors.
// Those keys are published forever: never change them.
//
// Read only: every feature is `read_only`, no switch, no setpoint, nothing a
// voice assistant or a scene could change. Temperatures are
// `temperature-sensor/probe` (kept out of the room averages); units are only
// those the core lists for the category (DEVICE_FEATURE_UNITS_BY_CATEGORY):
// °C, bar, Pa and hours; every other unit (kg, %, kW, W, A, V, rpm…) goes in
// the feature name, on an `unknown/decimal` feature. Energy units are not
// energy-sensor features (a heat value, not electricity).
//
// What the reading of a variable gives is decided by the feature itself (its
// address in the external id, its category and unit), so a feature created
// in Gladys is read the same way whatever /data holds.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { GLADYS, LIFETIME_COUNTERS, LIMITS } from './constants.js';
import { cleanText, numberOf } from './eta.js';
import { ERROR_FEATURES, ERRORS_DEVICE, both, word } from './i18n.js';

// --- Kinds -------------------------------------------------------------------

/** Units read as a plain number, the unit in the feature name. */
export const NUMBER_UNITS = new Set([
  '%',
  '%rH',
  'A',
  'mA',
  'Hz',
  'Ohm',
  'U/min',
  'V',
  'mV',
  'W',
  'kW',
  'kWh',
  'MWh',
  'W/m²',
  'kg',
  't',
  'l',
  'l/min',
  'l/h',
  'm²',
  'm³',
  'm³/h',
  'K',
  'min',
  'h',
]);

const TEMPERATURE = { min: -100, max: 1500 };

/** The Gladys feature of each kind (`unit` only from DEVICE_FEATURE_UNITS_BY_CATEGORY). */
const SHAPES = {
  temperature: {
    category: C.TEMPERATURE_SENSOR,
    type: TYPES.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    ...TEMPERATURE,
  },
  bar: { category: C.PRESSURE_SENSOR, type: TYPES.SENSOR.DECIMAL, unit: U.BAR, min: -1, max: 100 },
  pascal: {
    category: C.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: U.PASCAL,
    min: -100_000,
    max: 100_000,
  },
  hours: {
    category: C.DURATION,
    type: TYPES.DURATION.DECIMAL,
    unit: U.HOURS,
    min: 0,
    max: 10_000_000,
  },
  number: {
    category: C.UNKNOWN,
    type: TYPES.SENSOR.DECIMAL,
    min: -1_000_000_000,
    max: 1_000_000_000,
  },
  text: { category: C.TEXT, type: TYPES.TEXT.TEXT, min: 0, max: 0, keep_history: false },
};

/**
 * The kind of a variable from its value and, with API 1.2, its varinfo:
 * `{ kind, unit }` or undefined (time slots, times of day, dates, values
 * neither numbers nor texts). The unit of the value wins: the reference
 * found varinfo and value disagreeing (the full load hours: no unit in
 * varinfo, seconds in the value).
 */
export function classify(value, info) {
  if (!value || info?.type === 'TIMESLOT') {
    return undefined;
  }
  const unit = value.unit || info?.unit || '';
  const text = info ? info.type === 'TEXT' : (value.textOffset ?? 0) > 0 && unit === '';
  if (text) {
    return { kind: 'text', unit: '' };
  }
  // A number only when the display shows one now (a time slot "15:30 - 18:00
  // 55", "Aus" are not), or, with API 1.2, a DEFAULT variable without a value
  // now ("xxx").
  const numeric =
    measure(value) !== undefined ||
    (value.text === undefined &&
      unit !== '' &&
      (info?.type === 'DEFAULT' || info?.type === 'IEEE-754'));
  if (!numeric) {
    return undefined;
  }
  if (unit === '°C') return { kind: 'temperature', unit };
  if (unit === 'bar') return { kind: 'bar', unit };
  if (unit === 'Pa') return { kind: 'pascal', unit };
  if (unit === 's') return { kind: 'hours', unit };
  if (NUMBER_UNITS.has(unit)) return { kind: 'number', unit };
  if (unit === '' && (!info || info.type === 'DEFAULT' || info.type === 'IEEE-754')) {
    return { kind: 'number', unit: '' };
  }
  return undefined;
}

const PLAIN = /^-?[0-9]{1,12}(?:[.,]([0-9]{1,6}))?$/;
const DURATION =
  /^(?:([0-9]{1,6})d)?\s*(?:([0-9]{1,9})h)?\s*(?:([0-9]{1,3})m)?\s*(?:([0-9]{1,3})(?:[.,]([0-9]{1,3}))?s)?$/;

/**
 * The number the display shows (strValue): "-12,5", "12.5", and for
 * seconds "1d 2h", "6940h 41m" or "2m 15,0s"; `{ number, step }` (one unit
 * of the last digit shown) or undefined (a text, a time, a time slot).
 */
export function shownNumber(text, unit) {
  const t = String(text ?? '').trim();
  const plain = PLAIN.exec(t);
  if (plain) {
    return { number: Number(t.replace(',', '.')), step: 10 ** -(plain[1]?.length ?? 0) };
  }
  const m = unit === 's' ? DURATION.exec(t) : null;
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const n = (v) => Number(v ?? '0');
    const seconds = Number(`${m[4] ?? '0'}.${m[5] ?? '0'}`);
    const step = m[4] !== undefined ? 10 ** -(m[5]?.length ?? 0) : m[3] ? 60 : m[2] ? 3600 : 86400;
    return { number: n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + seconds, step };
  }
  return undefined;
}

/**
 * A measure: raw / scaleFactor, only when the display shows the same number
 * within one unit of its last digit (rounded or truncated); undefined
 * otherwise ("Aus", a time slot, "xxx", a raw value that disagrees). When
 * the raw value lost digits (written as `2.49865e+07`: 6 significant
 * digits), it must agree within 1e-5, and the number shown is the one kept.
 */
export function measure(value) {
  const number = numberOf(value);
  const shown = value ? shownNumber(value.text, value.unit) : undefined;
  if (number === undefined || shown === undefined) {
    return undefined;
  }
  const tolerance =
    shown.step +
    (value.rounded ? Math.abs(shown.number) * 1e-5 : 0) +
    Math.abs(shown.number) * 1e-9;
  if (Math.abs(number - shown.number) > tolerance) {
    return undefined;
  }
  return value.rounded ? shown.number : number;
}

/** The kind of a feature created in Gladys (its category, type and unit). */
export function kindOfFeature(feature) {
  switch (feature?.category) {
    case C.TEMPERATURE_SENSOR:
      return feature.unit === U.CELSIUS ? 'temperature' : undefined;
    case C.PRESSURE_SENSOR:
      return feature.unit === U.BAR ? 'bar' : feature.unit === U.PASCAL ? 'pascal' : undefined;
    case C.DURATION:
      return feature.unit === U.HOURS ? 'hours' : undefined;
    case C.TEXT:
      return feature.type === TYPES.TEXT.TEXT ? 'text' : undefined;
    case C.UNKNOWN:
      return feature.type === TYPES.SENSOR.DECIMAL ? 'number' : undefined;
    default:
      return undefined;
  }
}

/** The unit the value must have for each kind ("number": the unit of the feature). */
const UNIT_OF_KIND = { temperature: '°C', bar: 'bar', pascal: 'Pa', hours: 's' };

const inRange = (number, { min, max }) =>
  number !== undefined && number >= min && number <= max ? number : undefined;

/**
 * The Gladys state of a value read for a feature of `kind` (`unit`: the
 * unit of a "number" feature, '' when it has none, undefined when unknown:
 * then any number unit): `{ state }`, `{ text }`,
 * or undefined (invalid now: "xxx", "---", a text where a number is
 * expected, out of range, or a unit no longer the one of the feature).
 */
export function stateOf(kind, value, unit) {
  if (!value || !Object.hasOwn(SHAPES, kind)) {
    return undefined;
  }
  if (kind === 'text') {
    return value.text === undefined ? undefined : { text: value.text };
  }
  const expected = kind === 'number' ? unit : UNIT_OF_KIND[kind];
  if (
    expected === undefined
      ? value.unit !== '' && !NUMBER_UNITS.has(value.unit)
      : value.unit !== expected
  ) {
    return undefined;
  }
  const number = measure(value);
  if (kind === 'hours') {
    const hours = number === undefined ? undefined : Math.round((number / 3600) * 100) / 100;
    const state = inRange(hours, SHAPES.hours);
    return state === undefined ? undefined : { state };
  }
  const state = inRange(number, SHAPES[kind]);
  return state === undefined ? undefined : { state };
}

/** A lifetime counter (by id only: a kWh value may well restart every day). */
export function isLifetimeCounter(variable) {
  const parts = String(variable?.uri ?? '').split('/');
  return parts[3] === '0' && parts[4] === '0' && LIFETIME_COUNTERS.has(Number(parts[5]));
}

// --- Ids ---------------------------------------------------------------------

export const ERRORS_ID = 'errors';

export const deviceIds = (gladys, block) => gladys.externalIds('eta', String(block));

/** "40-10021" of a node and a fub. */
export const blockId = (node, fub) => `${node}-${fub}`;

/** The block of a device external id (`40-10021`, or `errors`), or undefined. */
export function parseDeviceId(externalId) {
  const match = /:eta:(errors|[0-9]{1,5}-[0-9]{1,6})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/**
 * A feature external id: `{ block, uri }` for a variable, `{ block:
 * 'errors', role }` for the errors device, or undefined.
 */
export function parseFeatureId(externalId) {
  const text = String(externalId ?? '');
  const variable = /:eta:([0-9]{1,5})-([0-9]{1,6}):([0-9]{1,6})-([0-9]{1,6})-([0-9]{1,6})$/.exec(
    text,
  );
  if (variable) {
    const [node, fub, fkt, io, id] = variable.slice(1).map(Number);
    return { block: blockId(node, fub), uri: `/${node}/${fub}/${fkt}/${io}/${id}` };
  }
  const error = /:eta:errors:([a-z-]{1,32})$/.exec(text);
  return error && Object.hasOwn(ERROR_FEATURES, error[1])
    ? { block: ERRORS_ID, role: error[1] }
    : undefined;
}

/** The feature key of a variable: `<fkt>-<io>-<var id>`. */
export const variableKey = (entry) => `${entry.fkt}-${entry.io}-${entry.id}`;

// --- Devices -----------------------------------------------------------------

/** "Kessel > Kessel Soll", with the unit when Gladys has none for it: "… (kg)". */
export function featureName(entry) {
  const base = cleanText(entry.name, LIMITS.nameLength * 2) ?? entry.uri;
  return entry.kind === 'number' && entry.unit ? `${base} (${entry.unit})` : base;
}

/** "ETA Kessel" ("ETA 40-10021" when the menu gives no name). */
export function deviceName(block) {
  return `ETA ${cleanText(block.name, LIMITS.nameLength) ?? blockId(block.node, block.fub)}`;
}

/** The Gladys feature of a catalog entry. */
export function buildFeature(ids, entry) {
  return {
    name: featureName(entry),
    external_id: ids.feature(variableKey(entry)),
    read_only: true,
    has_feedback: false,
    keep_history: true,
    ...SHAPES[entry.kind],
  };
}

/** A feature already created in Gladys, published again as it is. */
function keptFeature(feature) {
  const kept = {
    name: feature.name,
    external_id: feature.external_id,
    category: feature.category,
    type: feature.type,
    read_only: true,
    has_feedback: false,
    keep_history: feature.keep_history ?? true,
    min: feature.min ?? 0,
    max: feature.max ?? 0,
  };
  if (feature.unit) {
    kept.unit = feature.unit;
  }
  return kept;
}

/** The errors device: an alarm, the number of active errors, the last one. */
export function buildErrorsDevice(gladys, language) {
  const ids = deviceIds(gladys, ERRORS_ID);
  const shapes = {
    alarm: { category: C.UNKNOWN, type: TYPES.SENSOR.BINARY, min: 0, max: 1 },
    'error-count': { category: C.UNKNOWN, type: TYPES.SENSOR.INTEGER, min: 0, max: 1000 },
    'last-error': SHAPES.text,
  };
  return {
    name: word(ERRORS_DEVICE, language),
    external_id: ids.device,
    features: Object.keys(ERROR_FEATURES).map((role) => ({
      name: word(ERROR_FEATURES[role], language),
      external_id: ids.feature(role),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...shapes[role],
    })),
    params: [{ name: 'block', value: ERRORS_ID }],
  };
}

/**
 * The devices of Discovery: one per block of the catalog, with its
 * variables, plus the features (and devices) already created in Gladys that
 * the catalog no longer lists (a feature never disappears), plus the errors
 * device. Bounded: LIMITS.featuresPerDevice per device, LIMITS.features in
 * all (the created ones first).
 */
export function buildDevices(gladys, catalog, created, language) {
  const blocks = new Map();
  for (const block of catalog?.blocks ?? []) {
    blocks.set(blockId(block.node, block.fub), { block, features: new Map() });
  }
  let total = 0;
  const add = (id, feature) => {
    const device = blocks.get(id);
    if (
      !device ||
      device.features.has(feature.external_id) ||
      device.features.size >= LIMITS.featuresPerDevice ||
      total >= LIMITS.features
    ) {
      return;
    }
    device.features.set(feature.external_id, feature);
    total += 1;
  };
  // Created first: they are never dropped for the limits.
  for (const device of created) {
    const id = parseDeviceId(device.external_id);
    if (id === undefined || id === ERRORS_ID) {
      continue;
    }
    if (!blocks.has(id)) {
      const [node, fub] = id.split('-').map(Number);
      blocks.set(id, {
        block: { node, fub, name: undefined },
        name: device.name,
        features: new Map(),
      });
    }
    for (const feature of device.features ?? []) {
      if (parseFeatureId(feature.external_id)?.block === id && kindOfFeature(feature)) {
        add(id, keptFeature(feature));
      }
    }
  }
  for (const entry of catalog?.entries ?? []) {
    const id = blockId(entry.node, entry.fub);
    add(id, buildFeature(deviceIds(gladys, id), entry));
  }
  const devices = [];
  for (const [id, { block, name, features }] of blocks) {
    if (features.size === 0) {
      continue;
    }
    devices.push({
      name: name ?? deviceName(block),
      external_id: deviceIds(gladys, id).device,
      features: [...features.values()],
      params: [{ name: 'block', value: id }],
    });
  }
  devices.push(buildErrorsDevice(gladys, language));
  return devices;
}

/**
 * The variables to read in a cycle: those of the features created in
 * Gladys, `[{ id (feature external id), uri, kind, block }]`, each feature
 * once, at most `max`.
 */
export function variablesToRead(created, units = new Map(), max = LIMITS.variablesPerCycle) {
  const list = [];
  const seen = new Set();
  for (const device of created) {
    const block = parseDeviceId(device.external_id);
    for (const feature of device.features ?? []) {
      const parsed = parseFeatureId(feature.external_id);
      const kind = kindOfFeature(feature);
      if (!parsed?.uri || parsed.block !== block || !kind || seen.has(feature.external_id)) {
        continue;
      }
      if (list.length >= max) {
        return list;
      }
      seen.add(feature.external_id);
      // A "number" feature: the catalog's unit, else the one in its name, else
      // unknown (a feature renamed and no longer in the menu): any unit.
      const unit = kind === 'number' ? (units.get(parsed.uri) ?? unitInName(feature.name)) : '';
      list.push({ id: feature.external_id, uri: parsed.uri, kind, unit, block });
    }
  }
  return list;
}

/** The unit at the end of a feature name, "… (kg)" -> "kg"; undefined when none. */
export function unitInName(name) {
  const match = /\(([^()]{1,8})\)$/.exec(String(name ?? '').trim());
  return match && NUMBER_UNITS.has(match[1]) ? match[1] : undefined;
}

// --- Errors ------------------------------------------------------------------

/** "Kessel: Flue gas sensor interrupted (Error, 2011-06-29 12:47:50)". */
export function errorText(error) {
  const where = error.blockName ? `${error.blockName}: ` : '';
  const details = [error.priority, error.time].filter(Boolean).join(', ');
  return cleanText(`${where}${error.msg}${details ? ` (${details})` : ''}`);
}

/** The states of the errors device from a list of active errors. */
export function errorStates(errors, language) {
  const newest = [...errors].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))[0];
  return {
    alarm: { state: errors.length > 0 ? GLADYS.ON : GLADYS.OFF },
    'error-count': { state: errors.length },
    'last-error': {
      text: newest
        ? errorText(newest)
        : word(both('No active error', 'Aucune erreur active'), language),
    },
  };
}
