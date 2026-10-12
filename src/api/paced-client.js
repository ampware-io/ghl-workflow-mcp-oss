/**
 * PacedClient wraps GhlApiClient to add human-like timing delays between
 * API calls. Uses log-normal distribution (Box-Muller transform) for
 * realistic inter-request timing. Per-method timing profiles make GETs
 * faster and DELETEs slower, mimicking real user behavior.
 *
 * First request fires immediately (no delay). Burst mode via withBurst()
 * skips pacing for atomic multi-step operations (e.g., createWorkflow).
 */

import { logger } from '../utils/logger.js';

/**
 * Per-method timing profiles. Each profile defines:
 * - min/max: hard clamp boundaries in milliseconds
 * - mu/sigma: parameters for the log-normal distribution
 *
 * GET is fastest (reading), POST/PUT medium (writing), DELETE slowest
 * (destructive actions where users typically hesitate).
 */
const TIMING_PROFILES = {
  GET:    { min: 800,  max: 1500, mu: 7.0,  sigma: 0.15 },
  POST:   { min: 1200, max: 2500, mu: 7.46, sigma: 0.18 },
  PUT:    { min: 1200, max: 2500, mu: 7.46, sigma: 0.18 },
  DELETE: { min: 1500, max: 3000, mu: 7.66, sigma: 0.18 },
};

class PacedClient {
  /** @type {import('./client.js').GhlApiClient} */
  #inner;

  /** @type {number} Timestamp of the last request (0 = no request yet) */
  #lastRequestTime = 0;

  /** @type {boolean} When true, pacing is skipped (burst mode) */
  #inBurst = false;

  /**
   * @param {import('./client.js').GhlApiClient} innerClient
   */
  constructor(innerClient) {
    this.#inner = innerClient;
  }

  /**
   * Generate a human-like delay for the given HTTP method using
   * log-normal distribution via Box-Muller transform.
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @returns {number} Delay in milliseconds (integer, clamped to profile bounds)
   */
  #generateDelay(method) {
    const profile = TIMING_PROFILES[method];

    // Box-Muller transform: generate standard normal from two uniform randoms
    const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());

    // Log-normal: exp(mu + sigma * z)
    const delay = Math.exp(profile.mu + profile.sigma * z);

    // Clamp to [min, max]
    return Math.round(Math.min(Math.max(delay, profile.min), profile.max));
  }

  /**
   * Apply pacing delay before a request. Skips delay when:
   * - In burst mode (#inBurst)
   * - This is the first request (#lastRequestTime === 0)
   *
   * @param {string} method - HTTP method for timing profile selection
   */
  async #pace(method) {
    if (this.#inBurst) {
      return;
    }

    if (this.#lastRequestTime === 0) {
      this.#lastRequestTime = Date.now();
      return;
    }

    const delay = this.#generateDelay(method);
    const elapsed = Date.now() - this.#lastRequestTime;

    if (elapsed < delay) {
      const waitTime = delay - elapsed;
      logger.debug('Pacing:', method, delay, 'ms');
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.#lastRequestTime = Date.now();
  }

  // --- HTTP methods (paced, then delegated to inner client) ---

  async get(path) {
    await this.#pace('GET');
    return this.#inner.get(path);
  }

  async post(path, body) {
    await this.#pace('POST');
    return this.#inner.post(path, body);
  }

  async put(path, body) {
    await this.#pace('PUT');
    return this.#inner.put(path, body);
  }

  async delete(path, body = null) {
    await this.#pace('DELETE');
    return this.#inner.delete(path, body);
  }

  // --- Passthrough methods (no pacing needed) ---

  getLocationId() {
    return this.#inner.getLocationId();
  }

  setLocationId(newId) {
    return this.#inner.setLocationId(newId);
  }

  getCompanyId() {
    return this.#inner.getCompanyId();
  }

  getUserId() {
    return this.#inner.getUserId();
  }

  getCompanyAge() {
    return this.#inner.getCompanyAge();
  }

  getWriteContext() {
    return this.#inner.getWriteContext();
  }

  // --- Burst mode ---

  /**
   * Execute a function with pacing disabled. All API calls made within
   * the callback skip inter-request delays. Used for atomic multi-step
   * operations (e.g., createWorkflow's 3-step flow).
   *
   * @param {(client: PacedClient) => Promise<T>} fn - Function to execute in burst mode
   * @returns {Promise<T>} Result of fn
   * @template T
   */
  async withBurst(fn) {
    this.#inBurst = true;
    try {
      return await fn(this);
    } finally {
      this.#inBurst = false;
    }
  }
}

export { PacedClient };
