// -----------------------------------------------------------------------------
// The client of the ETAtouch webservices: GET only, one request at a time
// (the next one leaves after the answer of the previous one), never two
// closer than 100 ms, whatever asks for them (cycle, discovery, test button).
// Paced on the monotonic clock.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';
import { AnswerError, answerError, parseAnswer } from './eta.js';
import { EtaError, httpGet, parseRetryAfter } from './http.js';

export class EtaClient {
  constructor({ transport = httpGet, monotonic, now, timers = globalThis } = {}) {
    this.transport = transport;
    this.monotonic = monotonic;
    this.now = now;
    this.timers = timers;
    this.host = '';
    this.port = 0;
    /** Monotonic time of the last request sent, failed ones included. */
    this.lastRequestAt = -Infinity;
    this.queue = Promise.resolve();
  }

  configure({ host, port }) {
    this.host = host ?? '';
    this.port = port ?? 0;
  }

  get configured() {
    return this.host !== '' && this.port > 0;
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  /**
   * One GET of `path` after the previous request has ended: the `<eta>` root,
   * or an EtaError (an `<error>` answer is a `not_found` one).
   */
  get(path, { timeout = TIMINGS.requestTimeout, maxBytes = LIMITS.answerBytes } = {}) {
    const run = this.queue.catch(() => {}).then(() => this.getNow(path, timeout, maxBytes));
    this.queue = run.catch(() => {});
    return run;
  }

  async getNow(path, timeout, maxBytes) {
    if (!this.configured) {
      throw new EtaError('no_config', 'no address');
    }
    const wait = this.lastRequestAt + TIMINGS.minRequestGap - this.monotonic();
    if (wait > 0) {
      await this.sleep(Math.min(wait, TIMINGS.minRequestGap));
    }
    this.lastRequestAt = this.monotonic();
    const { status, headers, body } = await this.transport(
      { host: this.host, port: this.port, path },
      { timeout, maxBytes },
    );
    if (status === 200) {
      let root;
      try {
        root = parseAnswer(body);
      } catch (err) {
        throw new EtaError('bad_response', err instanceof AnswerError ? err.message : 'bad answer');
      }
      if (answerError(root) !== undefined && root.children.length === 1) {
        throw new EtaError('not_found', 'the ETAtouch answered an error', { status });
      }
      return root;
    }
    if (status === 401 || status === 403) {
      throw new EtaError('forbidden', 'access refused by the ETAtouch', { status });
    }
    if (status === 404) {
      throw new EtaError('not_found', 'unknown resource', { status });
    }
    if (status === 429) {
      throw new EtaError('rate_limited', 'too many requests', {
        status,
        retryAfter: parseRetryAfter(headers?.['retry-after'], this.now()),
      });
    }
    if (status >= 500 && status < 600) {
      throw new EtaError('unavailable', 'the ETAtouch answered an error', { status });
    }
    throw new EtaError('http', 'unexpected answer', { status });
  }
}
