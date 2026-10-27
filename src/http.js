// -----------------------------------------------------------------------------
// The only network access: one HTTP GET to the ETAtouch webservices, bounded
// in size and in time, and the errors it ends with. Never a write: the
// integration only reads (no POST to /user/var, no PUT of a variable set).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed request. `kind`:
 * - `no_config`: no address (nothing sent);
 * - `forbidden`: 401 or 403 (the LAN access is off, or something else answers);
 * - `not_found`: 404 (an unknown variable, or no ETAtouch on this port);
 * - `rate_limited`: 429, `retryAfter` in ms when given;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no (complete) answer;
 * - `bad_response`, `size`: not the expected XML;
 * - `http`: any other status.
 */
export class EtaError extends Error {
  constructor(kind, message, { status, retryAfter, code } = {}) {
    super(message);
    this.name = 'EtaError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
  HPE_INVALID_CONSTANT: 'not an HTTP answer',
  HPE_HEADER_OVERFLOW: 'headers too large',
};

/** A socket error -> EtaError, from its code only (Node's message holds the address). */
export function networkError(err) {
  if (err instanceof EtaError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new EtaError('network', NETWORK_REASONS[code] ?? 'network error', {
    code: code || undefined,
  });
}

/** A short reason for a log, never an unknown error's message. */
export function errorReason(err) {
  if (err instanceof EtaError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * Retry-After (seconds or an HTTP date) -> milliseconds, undefined when
 * absent. A date is compared to the answer's own `Date` header when it has
 * one (the device's clock), else to `now`.
 */
export function parseRetryAfter(value, now, dateHeader) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (/^\d{1,9}$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  if (Number.isNaN(date)) {
    return undefined;
  }
  const sent = Date.parse(String(dateHeader ?? ''));
  return Math.max(0, date - (Number.isNaN(sent) ? now : sent));
}

/**
 * One GET of `path` (`/user/...`) on host:port; resolves `{ status, headers,
 * body }` (body: a Buffer) whatever the status. The promise settles once;
 * the body read is bounded (a bigger answer is an error, the socket closed at
 * once, before the rest arrives); the whole request is bounded in time. One
 * connection per request (no keep-alive, no pipelining).
 */
export function httpGet(
  { host, port, path },
  { timeout = TIMINGS.requestTimeout, maxBytes = LIMITS.answerBytes } = {},
) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let req;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    try {
      req = http.get(
        {
          hostname: host,
          family: isIP(host) || undefined,
          port,
          path,
          headers: { Accept: 'application/xml, text/xml', Connection: 'close' },
          agent: false,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          const announced = Number(res.headers['content-length']);
          if (Number.isFinite(announced) && announced > maxBytes) {
            settle(reject, new EtaError('size', 'answer too large'));
            req.destroy();
            return;
          }
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              settle(reject, new EtaError('size', 'answer too large'));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            settle(resolve, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => settle(reject, networkError(err)));
          res.on('aborted', () => settle(reject, new EtaError('network', 'answer cut short')));
        },
      );
    } catch (err) {
      settle(reject, new EtaError('network', 'invalid address', { code: err?.code }));
      return;
    }
    timer = setTimeout(() => {
      settle(reject, new EtaError('timeout', `no answer within ${Math.round(timeout / 1000)} s`));
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
  });
}
