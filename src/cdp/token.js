/**
 * Firebase JWT extraction from Chrome IndexedDB via the main page context.
 *
 * GHL stores its Firebase auth token in IndexedDB on the main
 * app.gohighlevel.com origin. We evaluate directly in the main page's
 * execution context — no iframe targeting needed.
 *
 * When a token is expired or a 401 is received, we reload the GHL page
 * so the SPA's own Firebase SDK refreshes the token, then re-extract.
 */

import { logger } from '../utils/logger.js';
import { SessionExpiredError } from '../utils/errors.js';

/** Refresh the token 5 minutes before it actually expires */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Manages Firebase JWT extraction and caching.
 */
export class TokenManager {
  /** @type {string | null} */
  #cachedToken = null;

  /** @type {number | null} Epoch ms when the cached token expires */
  #tokenExpiry = null;

  /** @type {import('./connection.js').CdpConnectionManager} */
  #cdp;

  /**
   * @param {import('./connection.js').CdpConnectionManager} cdpConnection
   */
  constructor(cdpConnection) {
    this.#cdp = cdpConnection;
  }

  /**
   * Get the current Firebase JWT, extracting from IndexedDB if not cached
   * or if the cached token is expired/about to expire.
   * @returns {Promise<string>} The Firebase JWT
   */
  async getToken() {
    if (this.#cachedToken !== null && !this.#isExpiredOrStale()) {
      return this.#cachedToken;
    }

    // Token is missing or expired — re-extract from IndexedDB.
    // The SPA may have refreshed it in the background.
    // Do NOT reload the page here — that causes a reload loop since every
    // API call goes through getToken(). Page reloads only happen in
    // refreshWithRetry() which is triggered by an actual 401.
    if (this.#cachedToken !== null) {
      logger.debug('Cached token is expired or near-expiry, re-extracting from IndexedDB');
    }

    const info = await this.#extractTokenInfo();
    this.#cachedToken = info.accessToken;
    this.#tokenExpiry = info.expirationTime;

    if (this.#isExpiredOrStale()) {
      logger.debug('Extracted token is near-expiry or expired — will be used as-is (401 handler will refresh if needed)');
    }

    return this.#cachedToken;
  }

  /**
   * Invalidate the cached token.
   * Next call to getToken() will re-extract from IndexedDB.
   */
  invalidate() {
    this.#cachedToken = null;
    this.#tokenExpiry = null;
  }

  /**
   * Refresh the token by reloading the GHL page and capturing the fresh
   * token from the SPA's own outgoing network requests.
   *
   * Strategy:
   * 1. Reload page + intercept the `token-id` header from the first
   *    authenticated request the SPA makes to leadconnectorhq.com.
   * 2. Fallback: re-read IndexedDB with retries (the SPA may have
   *    updated it in the background).
   *
   * @param {number} [maxRetries=3] - Maximum IndexedDB re-read attempts (fallback)
   * @returns {Promise<string>} The fresh Firebase JWT
   * @throws {SessionExpiredError} If all approaches are exhausted
   */
  async refreshWithRetry(maxRetries = 3) {
    this.invalidate();

    // Primary: reload and capture the token from network traffic
    try {
      const captured = await this.#cdp.reloadAndCaptureToken();
      if (captured) {
        this.#cachedToken = captured;
        // We don't know the exact expiry from the header, so clear it
        // to force an IndexedDB read on next getToken() for expiry info
        this.#tokenExpiry = null;
        logger.debug('Got fresh token from network capture');
        return captured;
      }
      logger.debug('No token captured from network traffic');
    } catch (err) {
      logger.debug('Network capture refresh failed:', err.message);
    }

    // Fallback: re-read IndexedDB with increasing delays.
    // The SPA should have refreshed the token by now after the reload.
    for (let i = 0; i < maxRetries; i++) {
      const delay = 2000 * (i + 1);
      await new Promise((r) => setTimeout(r, delay));
      logger.debug('Token re-extract attempt', i + 1, 'of', maxRetries, `(after ${delay}ms)`);

      try {
        const info = await this.#extractTokenInfo();

        // Only accept if the token is actually fresh
        if (info.expirationTime && !this.#isTimeExpired(info.expirationTime)) {
          this.#cachedToken = info.accessToken;
          this.#tokenExpiry = info.expirationTime;
          logger.debug('Got fresh token on re-extract attempt', i + 1);
          return info.accessToken;
        }

        logger.debug('Re-extracted token still expired (expiry:', info.expirationTime, 'now:', Date.now(), ')');
      } catch (err) {
        if (i === maxRetries - 1) {
          throw new SessionExpiredError();
        }
        logger.debug('Token re-extract failed:', err.message);
      }
    }

    throw new SessionExpiredError();
  }

  /**
   * Check whether the cached token is expired or within the buffer window.
   * @returns {boolean}
   */
  #isExpiredOrStale() {
    if (!this.#tokenExpiry) return false;
    return this.#isTimeExpired(this.#tokenExpiry);
  }

  /**
   * Check whether a given expiry timestamp is expired or within the buffer window.
   * @param {number} expiryMs - Epoch ms expiry time
   * @returns {boolean}
   */
  #isTimeExpired(expiryMs) {
    return Date.now() >= expiryMs - EXPIRY_BUFFER_MS;
  }

  /**
   * Extract the Firebase JWT and metadata from IndexedDB in the main page context.
   * @returns {Promise<{ accessToken: string, expirationTime: number | null }>}
   */
  async #extractTokenInfo() {
    const expression = `
      new Promise((resolve, reject) => {
        const request = indexedDB.open('firebaseLocalStorageDb');
        request.onerror = () => reject(new Error('Failed to open firebaseLocalStorageDb'));
        request.onsuccess = (event) => {
          const db = event.target.result;
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const store = tx.objectStore('firebaseLocalStorage');
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const entries = getAll.result;
            for (const entry of entries) {
              if (entry?.value?.stsTokenManager?.accessToken) {
                resolve({
                  accessToken: entry.value.stsTokenManager.accessToken,
                  expirationTime: entry.value.stsTokenManager.expirationTime || null,
                });
                return;
              }
            }
            reject(new Error('No Firebase token found in IndexedDB'));
          };
          getAll.onerror = () => reject(new Error('Failed to read firebaseLocalStorage'));
        };
      })
    `;

    let info;
    try {
      info = await this.#cdp.evaluate(expression, true);
    } catch (err) {
      logger.warn('Known IndexedDB path failed, attempting dynamic search:', err.message);
      info = await this.#dynamicTokenSearch();
    }

    if (!info || !info.accessToken || typeof info.accessToken !== 'string') {
      throw new Error(
        'Failed to extract Firebase token from IndexedDB. Ensure you are logged in to GHL.',
      );
    }

    logger.debug(
      'Token extracted, last 8 chars:', info.accessToken.slice(-8),
      info.expirationTime ? `expires: ${new Date(info.expirationTime).toISOString()}` : '(no expiry)',
    );
    return info;
  }

  /**
   * Dynamic fallback: enumerate all IndexedDB databases to find the Firebase token.
   * Used when the known path (firebaseLocalStorageDb) fails.
   *
   * @returns {Promise<{ accessToken: string, expirationTime: number | null }>}
   */
  async #dynamicTokenSearch() {
    const expression = `
      (async () => {
        const databases = await indexedDB.databases();
        for (const dbInfo of databases) {
          try {
            const db = await new Promise((resolve, reject) => {
              const req = indexedDB.open(dbInfo.name);
              req.onerror = () => reject(req.error);
              req.onsuccess = () => resolve(req.result);
            });
            const storeNames = Array.from(db.objectStoreNames);
            for (const storeName of storeNames) {
              try {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const entries = await new Promise((resolve, reject) => {
                  const req = store.getAll();
                  req.onerror = () => reject(req.error);
                  req.onsuccess = () => resolve(req.result);
                });
                for (const entry of entries) {
                  if (entry?.value?.stsTokenManager?.accessToken) {
                    return {
                      accessToken: entry.value.stsTokenManager.accessToken,
                      expirationTime: entry.value.stsTokenManager.expirationTime || null,
                    };
                  }
                }
              } catch {
                // Skip inaccessible stores
              }
            }
            db.close();
          } catch {
            // Skip inaccessible databases
          }
        }
        throw new Error('No Firebase token found in any IndexedDB database');
      })()
    `;

    return this.#cdp.evaluate(expression, true);
  }
}
