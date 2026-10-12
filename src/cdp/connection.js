/**
 * CDP Connection Manager for the GHL Workflow MCP server.
 *
 * Manages Chrome DevTools Protocol connections to GHL tabs,
 * with tab discovery, timeout wrappers, and auto-reconnect.
 */

import * as cdpModule from 'chrome-remote-interface';
import { logger } from '../utils/logger.js';

let CDP = cdpModule.default;

/**
 * Test-only hook for swapping the CDP implementation. Used by
 * src/cdp/connection.test.js to inject a fake CDP factory. Do not
 * use in production code paths.
 *
 * @param {Function} fake - Fake CDP factory (or null/undefined to restore real CDP)
 */
export function __setCdpForTest(fake) {
  CDP = fake || cdpModule.default;
}
import {
  GhlMcpError,
  ChromeNotRunningError,
  NoGhlTabError,
  CdpTimeoutError,
} from '../utils/errors.js';

/**
 * Wrap a promise with a timeout. Rejects with CdpTimeoutError if the
 * promise does not settle within the given duration.
 *
 * @param {Promise} promise - The promise to wrap
 * @param {number} [ms=10000] - Timeout in milliseconds
 * @param {string} [operationName='CDP operation'] - Name for error messages
 * @returns {Promise}
 */
export function withTimeout(promise, ms = 10000, operationName = 'CDP operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new CdpTimeoutError(operationName, ms));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** GHL URL patterns for tab discovery */
const GHL_URL_PATTERNS = ['gohighlevel.com', 'leadconnectorhq.com'];

/** Regex to extract locationId from GHL tab URL (primary: /v2/ format) */
const LOCATION_ID_REGEX = /\/v2\/location\/([^/]+)/;
/** Fallback regex for workflow editor pages which use /location/ without /v2/ */
const LOCATION_ID_FALLBACK_REGEX = /\/location\/([^/]+)/;

/**
 * Manages a CDP connection to a GHL tab in Chrome.
 */
export class CdpConnectionManager {
  /** @type {import('chrome-remote-interface').Client | null} */
  #client = null;

  /** @type {number} */
  #port;

  /** @type {string | null} */
  #targetId = null;

  /** @type {string | null} */
  #locationId = null;

  /** @type {{ title: string, url: string, locationId: string | null } | null} */
  #tabInfo = null;

  /** @type {boolean} */
  #connected = false;

  /**
   * Callback fired when the main frame navigates to a different sub-account.
   * Single slot — overwritten on re-registration. Persists across disconnect/reconnect
   * so server.js can register once per connect path without losing the registration.
   * @type {((newId: string, prevId: string | null) => void) | null}
   */
  #onLocationChange = null;

  /** @type {string | null} Frame id of the main (top) frame, captured on connect */
  #mainFrameId = null;

  /**
   * @param {number} [port=49222] - Chrome remote debugging port
   */
  constructor(port = 49222) {
    this.#port = port;
  }

  /**
   * Register a callback to be invoked when the connected tab's main frame
   * navigates to a different GHL sub-account (locationId change). The callback
   * receives `(newLocationId, previousLocationId)`. Only one callback is
   * supported — re-registering replaces the previous callback. The registration
   * persists across disconnect/reconnect so consumers (e.g. server.js) only
   * need to register once per connect path.
   *
   * @param {(newId: string, prevId: string | null) => void} cb
   */
  onLocationChange(cb) {
    this.#onLocationChange = cb;
  }

  /**
   * Install main-frame navigation listeners on a freshly connected CDP client.
   * Captures the current main frame id and registers handlers for both
   * Page.frameNavigated (cross-document navigation) and
   * Page.navigatedWithinDocument (SPA route changes).
   *
   * @param {object} client - CDP client returned by CDP({...})
   */
  async #installNavListeners(client) {
    const { frameTree } = await client.Page.getFrameTree();
    this.#mainFrameId = frameTree.frame.id;

    client.on('Page.frameNavigated', (params) => {
      // Sub-frames have a parentId; ignore them — only main-frame nav matters.
      if (params?.frame?.parentId) return;
      this.#handleNavUrl(params?.frame?.url);
    });

    client.on('Page.navigatedWithinDocument', (params) => {
      if (params?.frameId !== this.#mainFrameId) return;
      this.#handleNavUrl(params?.url);
    });
  }

  /**
   * Handle a main-frame URL change. Extracts the locationId, updates internal
   * state if it changed, and invokes the registered onLocationChange callback.
   * No-op when the URL does not match a GHL location pattern, or when the
   * extracted id is the same as the cached one.
   *
   * Only the strict /v2/location/<id> pattern triggers a sub-account switch.
   * The fallback /location/<id> form (used by workflow/funnel editor pages
   * within the same sub-account) is ignored — those navigations stay inside
   * the current location and must not invalidate apiClient state.
   *
   * @param {string | undefined} url
   */
  #handleNavUrl(url) {
    if (!url) return;
    const match = url.match(LOCATION_ID_REGEX);
    if (!match) return;

    const extracted = match[1];
    if (extracted === this.#locationId) return;

    const prev = this.#locationId;
    this.#locationId = extracted;
    this.#tabInfo = {
      title: this.#tabInfo?.title || 'GHL tab',
      url,
      locationId: extracted,
    };

    logger.info('GHL locationId changed:', prev, '->', extracted);

    if (this.#onLocationChange) {
      try {
        this.#onLocationChange(extracted, prev);
      } catch (err) {
        // A buggy consumer must not crash the navigation listener.
        logger.warn('onLocationChange callback threw:', err?.message || err);
      }
    }
  }

  /**
   * Connect to a GHL tab in Chrome.
   * Discovers tabs, selects the first matching GHL tab, extracts locationId,
   * and establishes a CDP session.
   *
   * @throws {ChromeNotRunningError} When Chrome is not reachable on the configured port
   * @throws {NoGhlTabError} When no GHL tab is found in Chrome
   */
  async connect() {
    // Discover available tabs
    let targets;
    try {
      targets = await CDP.List({ port: this.#port, host: '127.0.0.1' });
    } catch {
      throw new ChromeNotRunningError(this.#port);
    }

    // Filter for GHL tabs
    const ghlTabs = targets.filter(
      (t) =>
        t.type === 'page' &&
        GHL_URL_PATTERNS.some((pattern) => t.url.includes(pattern)),
    );

    if (ghlTabs.length === 0) {
      throw new NoGhlTabError();
    }

    // Select first matching tab (tab selection confirmation happens at server.js level per D-03)
    const selectedTab = ghlTabs[0];

    // Extract locationId from URL (try /v2/ first, fallback to /location/)
    const locationMatch = selectedTab.url.match(LOCATION_ID_REGEX)
      || selectedTab.url.match(LOCATION_ID_FALLBACK_REGEX);
    const locationId = locationMatch ? locationMatch[1] : null;

    if (!locationId) {
      logger.warn('Could not extract locationId from tab URL');
    }

    // Connect CDP client to the selected tab
    const client = await CDP({ target: selectedTab.id, port: this.#port, host: '127.0.0.1' });

    // Enable required CDP domains
    await client.Page.enable();
    await client.Runtime.enable();

    // Listen for disconnect
    client.on('disconnect', () => {
      this.#client = null;
      this.#connected = false;
      logger.info('CDP disconnected');
    });

    // Store connection state
    this.#client = client;
    this.#targetId = selectedTab.id;
    this.#locationId = locationId;
    this.#tabInfo = {
      title: selectedTab.title,
      url: selectedTab.url,
      locationId,
    };

    // Install main-frame navigation listeners so a sub-account switch in the
    // same tab is detected without polling. Done before #connected = true so
    // the manager has its main frame id captured before any consumer code
    // runs against the live connection.
    await this.#installNavListeners(client);

    this.#connected = true;

    logger.info('Connected to GHL tab:', selectedTab.title);
  }

  /**
   * Ensure the CDP connection is active, reconnecting if necessary.
   * Tries to reconnect to the same tab first to avoid silently switching
   * to a different tab/location.
   */
  async ensureConnected() {
    if (this.#connected && this.#client) {
      return;
    }

    // Try to reconnect to the same tab we were previously attached to
    if (this.#targetId) {
      try {
        logger.debug('Attempting to reconnect to previous tab:', this.#targetId);
        await this.connectToTab(this.#targetId);
        return;
      } catch (err) {
        logger.debug('Previous tab unavailable, falling back to discovery:', err.message);
      }
    }

    await this.connect();
  }

  /**
   * Classify an error as a transport-level failure (dead/half-open socket or
   * a CDP operation timeout), as opposed to an in-page app/JS error. Only
   * transport failures are safe to transparently reconnect-and-retry.
   *
   * @param {*} err
   * @returns {boolean}
   */
  #isTransportError(err) {
    if (err instanceof CdpTimeoutError) return true;
    const msg = String(err?.message || err);
    return /socket hang up|ECONNRESET|EPIPE|WebSocket (connection closed|is not open)|not opened/i.test(
      msg,
    );
  }

  /**
   * Tear down the current CDP client after a suspected dead/half-open socket.
   * Nulls the client field and marks disconnected FIRST (before awaiting the
   * close) so a re-entrant call cannot reuse the stale client while close()
   * is in flight.
   */
  async #forceReset() {
    const stale = this.#client;
    this.#client = null;
    this.#connected = false;
    if (stale) {
      try {
        await stale.close();
      } catch {
        // Socket is already dead — nothing to clean up.
      }
    }
  }

  /**
   * Run a CDP operation with transparent reconnect-and-retry-once on transport
   * failure. Ensures a connection first, runs `fn()`, and on a transport-level
   * error (timeout or socket death) tears down the stale client, reconnects via
   * ensureConnected(), and retries `fn()` exactly once. App/JS errors propagate
   * untouched. A second transport failure propagates — no loop.
   *
   * `fn` MUST read `this.#client` fresh each call (never capture it in a
   * variable) so the retry runs against the freshly reconnected client.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withReconnect(fn) {
    await this.ensureConnected();
    try {
      return await fn();
    } catch (err) {
      if (!this.#isTransportError(err)) throw err;
      logger.info(
        'CDP transport failure, reconnecting and retrying once:',
        err?.message || err,
      );
      await this.#forceReset();
      await this.ensureConnected();
      return await fn();
    }
  }

  /**
   * Evaluate a JavaScript expression in the connected tab's main context.
   *
   * @param {string} expression - JavaScript expression to evaluate
   * @param {boolean} [awaitPromise=true] - Whether to await the result if it's a promise
   * @returns {Promise<*>} The evaluation result value
   */
  async evaluate(expression, awaitPromise = true) {
    const result = await this.#withReconnect(() =>
      withTimeout(
        this.#client.Runtime.evaluate({
          expression,
          awaitPromise,
          returnByValue: true,
        }),
        10000,
        'Runtime.evaluate',
      ),
    );

    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Unknown evaluation error';
      throw new Error(`CDP evaluate failed: ${desc}`);
    }

    return result.result.value;
  }

  /**
   * Evaluate a JavaScript expression in a specific execution context.
   * Used by token.js for iframe context evaluation.
   *
   * @param {string} expression - JavaScript expression to evaluate
   * @param {number} contextId - Execution context ID
   * @param {boolean} [awaitPromise=true] - Whether to await the result if it's a promise
   * @returns {Promise<*>} The evaluation result value
   */
  async evaluateInContext(expression, contextId, awaitPromise = true) {
    const result = await this.#withReconnect(() =>
      withTimeout(
        this.#client.Runtime.evaluate({
          expression,
          awaitPromise,
          returnByValue: true,
          contextId,
        }),
        10000,
        'Runtime.evaluate (context)',
      ),
    );

    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Unknown evaluation error';
      throw new Error(`CDP evaluate in context failed: ${desc}`);
    }

    return result.result.value;
  }

  /**
   * Get the frame tree for the connected tab.
   * Used to discover iframe execution contexts.
   *
   * @returns {Promise<object>} The frame tree
   */
  async getFrameTree() {
    return this.#withReconnect(() =>
      withTimeout(this.#client.Page.getFrameTree(), 10000, 'Page.getFrameTree'),
    );
  }

  /**
   * Get info about the currently connected tab.
   * @returns {{ title: string, url: string, locationId: string | null } | null}
   */
  getTabInfo() {
    return this.#tabInfo;
  }

  /**
   * Get the locationId extracted from the connected GHL tab URL.
   * @returns {string | null}
   */
  getLocationId() {
    return this.#locationId;
  }

  /**
   * Navigate the connected tab to a URL and wait for the page to load.
   *
   * @param {string} url - The URL to navigate to
   * @param {number} [timeoutMs=15000] - Maximum wait time for navigation
   */
  async navigate(url, timeoutMs = 15000) {
    await this.#withReconnect(() =>
      withTimeout(
        (async () => {
          await this.#client.Page.navigate({ url });
          await this.#client.Page.loadEventFired();
        })(),
        timeoutMs,
        'Page.navigate',
      ),
    );

    // Re-extract locationId from the new URL
    const { frameTree } = await this.#withReconnect(() =>
      withTimeout(this.#client.Page.getFrameTree(), 5000, 'Page.getFrameTree'),
    );
    const newUrl = frameTree.frame.url;
    const locationMatch = newUrl.match(LOCATION_ID_REGEX);
    if (locationMatch) {
      this.#locationId = locationMatch[1];
    }
    this.#tabInfo = {
      title: frameTree.frame.name || this.#tabInfo?.title || 'GHL tab',
      url: newUrl,
      locationId: this.#locationId,
    };

    logger.info('Navigated to:', newUrl);
  }

  /**
   * Reload the current page and wait for it to finish loading.
   *
   * @param {number} [timeoutMs=15000] - Maximum wait time for reload
   */
  async reload(timeoutMs = 15000) {
    await this.#withReconnect(() =>
      withTimeout(
        (async () => {
          await this.#client.Page.reload();
          await this.#client.Page.loadEventFired();
        })(),
        timeoutMs,
        'Page.reload',
      ),
    );

    logger.info('Page reloaded');
  }

  /**
   * Reload the page and capture the `token-id` header from the first
   * outgoing request to the GHL backend. This is the most reliable way
   * to get a fresh token after a page reload, because it waits for the
   * SPA's own Firebase SDK to refresh and make an authenticated call.
   *
   * @param {number} [timeoutMs=20000] - Maximum wait for a matching request
   * @returns {Promise<string|null>} The captured token, or null if none found
   */
  async reloadAndCaptureToken(timeoutMs = 20000) {
    await this.ensureConnected();

    // Enable Network domain to intercept request headers
    await this.#client.Network.enable();

    const tokenPromise = new Promise((resolve) => {
      const onRequest = (params) => {
        const url = params.request?.url || '';
        const tokenHeader = params.request?.headers?.['token-id'];

        if (url.includes('leadconnectorhq.com') && tokenHeader) {
          logger.debug('Captured token from network request:', url.split('?')[0]);
          this.#client.removeListener('Network.requestWillBeSent', onRequest);
          resolve(tokenHeader);
        }
      };

      this.#client.on('Network.requestWillBeSent', onRequest);

      // Safety: clean up listener on timeout
      setTimeout(() => {
        this.#client.removeListener('Network.requestWillBeSent', onRequest);
        resolve(null);
      }, timeoutMs);
    });

    // Reload the page — the SPA will re-init Firebase and make API calls
    await this.#client.Page.reload();

    const token = await tokenPromise;

    // Disable Network domain to reduce overhead
    try {
      await this.#client.Network.disable();
    } catch {
      // Ignore — page may have navigated
    }

    return token;
  }

  /**
   * Get the raw CDP client for advanced operations.
   * @returns {import('chrome-remote-interface').Client | null}
   */
  getClient() {
    return this.#client;
  }

  /**
   * Check whether the CDP connection is active.
   * @returns {boolean}
   */
  isConnected() {
    return this.#connected;
  }

  /**
   * Get all GHL tabs currently open in Chrome.
   * Used by server.js for tab selection confirmation (D-03).
   *
   * @returns {Promise<Array>} Filtered list of GHL tabs
   * @throws {ChromeNotRunningError} When Chrome is not reachable
   */
  async getGhlTabs() {
    let targets;
    try {
      targets = await CDP.List({ port: this.#port, host: '127.0.0.1' });
    } catch {
      throw new ChromeNotRunningError(this.#port);
    }

    return targets.filter(
      (t) =>
        t.type === 'page' &&
        GHL_URL_PATTERNS.some((pattern) => t.url.includes(pattern)),
    );
  }

  /**
   * Connect to a specific tab by target ID.
   * Disconnects the current session first if one exists.
   *
   * @param {string} targetId - The target ID of the tab to connect to
   */
  async connectToTab(targetId) {
    // Disconnect existing client if any
    if (this.#client) {
      try {
        await this.#client.close();
      } catch {
        // Ignore close errors on stale connections
      }
      this.#client = null;
      this.#connected = false;
    }

    // Get tab info from target list
    let targets;
    try {
      targets = await CDP.List({ port: this.#port, host: '127.0.0.1' });
    } catch {
      throw new ChromeNotRunningError(this.#port);
    }

    const tab = targets.find((t) => t.id === targetId);
    if (!tab) {
      throw new GhlMcpError(
        `Tab with ID "${targetId}" not found. It may have been closed or navigated away.`,
        'TAB_NOT_FOUND',
        'List available tabs and try again with a valid tab ID.',
      );
    }

    // Extract locationId (try /v2/ first, fallback to /location/)
    const locationMatch = tab.url.match(LOCATION_ID_REGEX)
      || tab.url.match(LOCATION_ID_FALLBACK_REGEX);
    const locationId = locationMatch ? locationMatch[1] : null;

    if (!locationId) {
      logger.warn('Could not extract locationId from tab URL');
    }

    // Connect
    const client = await CDP({ target: targetId, port: this.#port, host: '127.0.0.1' });

    await client.Page.enable();
    await client.Runtime.enable();

    client.on('disconnect', () => {
      this.#client = null;
      this.#connected = false;
      logger.info('CDP disconnected');
    });

    this.#client = client;
    this.#targetId = targetId;
    this.#locationId = locationId;
    this.#tabInfo = {
      title: tab.title,
      url: tab.url,
      locationId,
    };

    // Install main-frame navigation listeners — see comment in connect().
    await this.#installNavListeners(client);

    this.#connected = true;

    logger.info('Connected to GHL tab:', tab.title);
  }

  /**
   * Disconnect from the current CDP session and reset all state.
   */
  async disconnect() {
    if (this.#client) {
      try {
        await this.#client.close();
      } catch {
        // Ignore close errors
      }
    }

    this.#client = null;
    this.#targetId = null;
    this.#locationId = null;
    this.#tabInfo = null;
    this.#connected = false;
  }
}
