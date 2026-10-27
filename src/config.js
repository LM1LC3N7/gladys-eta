// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// The ETAtouch webservices have no password: whoever reaches port 8080 reads
// them. Only an address and a port are asked; the address is checked (no
// path, no broadcast, multicast nor unspecified address).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { INTERFACE, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: INTERFACE.defaultPort,
  variables: 'main',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];
export const VARIABLE_SETS = ['main', 'all'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Addresses no device answers from: unspecified, broadcast, multicast. */
const UNUSABLE = new BlockList();
UNUSABLE.addSubnet('0.0.0.0', 8, 'ipv4');
UNUSABLE.addAddress('255.255.255.255', 'ipv4');
UNUSABLE.addSubnet('224.0.0.0', 4, 'ipv4');
UNUSABLE.addAddress('::', 'ipv6');
UNUSABLE.addSubnet('ff00::', 8, 'ipv6');

export function unusableAddress(host) {
  const family = isIP(host);
  return family !== 0 && UNUSABLE.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The address typed by the user: `{ host, port }`, `{ error: 'path' }` when
 * it holds a path, a query or credentials, `{ error: 'invalid' }` when it is
 * no usable IP address nor host name, `{}` when empty. "http://" and ":port"
 * are accepted (`port` then wins over the port field).
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { error: 'invalid' };
  }
  text = text.replace(/^https?:\/\//i, '');
  // "192.168.1.20:8080/" (a pasted URL) is fine; anything after the slash is not.
  text = text.replace(/\/$/, '');
  if (/[/?#@\s\\]/.test(text)) {
    return { error: 'path' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  if (unusableAddress(host)) {
    return { error: 'invalid' };
  }
  const portNumber = port === undefined ? undefined : Number(port);
  if (portNumber !== undefined && (portNumber < 1 || portNumber > 65535)) {
    return { error: 'invalid' };
  }
  return { host: host.toLowerCase(), port: portNumber };
}

/** The key of an ETAtouch in /data: a hash of its address and port. */
export const deviceKey = (host, port) =>
  host ? createHash('sha256').update(`eta:${host}:${port}`, 'utf8').digest('hex').slice(0, 32) : '';

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

const choice = (raw, list, fallback) => {
  const value = String(raw ?? fallback)
    .trim()
    .toLowerCase();
  return list.includes(value) ? value : fallback;
};

export function normalizeConfig(raw = {}) {
  const address = parseAddress(raw?.host);
  const typedPort = number(raw?.port);
  const port =
    address.port ??
    (Number.isInteger(typedPort) && typedPort >= 1 && typedPort <= 65535
      ? typedPort
      : DEFAULTS.port);
  return {
    host: address.host ?? '',
    port,
    addressError: address.error,
    key: deviceKey(address.host, port),
    variables: choice(raw?.variables, VARIABLE_SETS, DEFAULTS.variables),
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: choice(raw?.language, LANGUAGES, DEFAULTS.language),
  };
}
