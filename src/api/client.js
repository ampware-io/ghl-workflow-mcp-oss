/**
 * Authenticated HTTP client for GoHighLevel's internal API.
 *
 * GHL uses a dual-token auth system:
 * - Workflow endpoints (/workflow/...) need only the Firebase JWT (`token-id` header)
 *   and accept the workflow microfrontend origin.
 * - Entity endpoints (/users/..., /locations/..., /opportunities/..., etc.) need
 *   both the Firebase JWT AND a GHL session token (`authorization: Bearer` header)
 *   obtained from /oauth/2/login/current, plus the main app origin.
 *
 * This client detects the endpoint type and applies the correct headers automatically.
 */

import { logger } from '../utils/logger.js';
import { GhlApiError } from '../utils/errors.js';

// TODO: D-09 - company_age value. MCP-SPEC.md shows 59. Investigate during Phase 2 whether dynamic or static. For now, callers pass it explicitly if needed.

const GHL_BASE_URL = 'https://backend.leadconnectorhq.com';

const WORKFLOW_ORIGIN = 'https://client-app-automation-workflows.leadconnectorhq.com';
const APP_ORIGIN = 'https://app.gohighlevel.com';

/** Headers shared by all requests */
const BASE_HEADERS = {
  'channel': 'APP',
  'content-type': 'application/json',
  'accept': 'application/json, text/plain, */*',
};

/** Additional headers required by entity (non-workflow) endpoints */
const ENTITY_HEADERS = {
  'source': 'WEB_USER',
  'version': '2021-07-28',
};

/** Refresh the auth token 5 minutes before expiry */
const AUTH_TOKEN_BUFFER_MS = 5 * 60 * 1000;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

/**
 * HTTP client for GHL API calls, authenticated via Firebase JWT
 * and GHL session token.
 */
export class GhlApiClient {
  /** @type {import('../cdp/token.js').TokenManager} */
  #tokenManager;

  /** @type {string} */
  #locationId;

  /** @type {string | null} GHL session token for entity endpoints */
  #authToken = null;

  /** @type {number | null} Epoch ms when #authToken expires */
  #authTokenExpiry = null;

  /**
   * @param {import('../cdp/token.js').TokenManager} tokenManager
   * @param {string} locationId
   */
  constructor(tokenManager, locationId) {
    this.#tokenManager = tokenManager;
    this.#locationId = locationId;
  }

  /**
   * Get the location ID this client is scoped to.
   * @returns {string}
   */
  getLocationId() {
    return this.#locationId;
  }

  /**
   * Swap the locationId this client uses for entity-endpoint requests.
   *
   * The GHL session token (returned by /oauth/2/login/current and used in the
   * `authorization: Bearer` header) is location-scoped, so a sub-account switch
   * requires the cached authToken to be cleared. The next entity-endpoint call
   * will refetch a fresh authToken bound to the new locationId.
   *
   * No-op when called with the same locationId — the cached authToken is
   * preserved so we don't refetch unnecessarily.
   *
   * @param {string} newId - The new locationId
   */
  setLocationId(newId) {
    if (newId === this.#locationId) return;
    this.#locationId = newId;
    this.#authToken = null;
    this.#authTokenExpiry = null;
  }

  /**
   * Make an authenticated request to the GHL API.
   * Automatically detects whether the endpoint is a workflow path or an
   * entity path and applies the correct auth headers.
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} path - API path (appended to GHL_BASE_URL)
   * @param {object | null} [body=null] - Request body (JSON-serializable)
   * @returns {Promise<object>} Parsed JSON response
   * @throws {GhlApiError} On API errors
   */
  async request(method, path, body = null) {
    const headers = await this.#buildHeaders(path);

    const opts = { method, headers };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }

    const response = await fetch(GHL_BASE_URL + path, opts);

    logger.debug(method, path, '->', response.status);

    // Handle 401: refresh tokens and retry once
    if (response.status === 401) {
      logger.debug('401 received, refreshing tokens');
      await this.#tokenManager.refreshWithRetry();
      this.#authToken = null;
      this.#authTokenExpiry = null;

      const freshHeaders = await this.#buildHeaders(path);
      const retryOpts = { method, headers: freshHeaders };
      if (body !== null) {
        retryOpts.body = JSON.stringify(body);
      }

      const retryResponse = await fetch(GHL_BASE_URL + path, retryOpts);

      logger.debug(method, path, '(retry) ->', retryResponse.status);

      if (retryResponse.status === 401) {
        throw new GhlApiError(
          401,
          'Authentication failed after token refresh',
          'Your GHL session may have expired. Log in again in Chrome.',
        );
      }

      return this.#handleResponse(retryResponse, method, path, body);
    }

    // Handle 429, 500, and 503: retry with exponential backoff
    if (response.status === 429 || response.status === 500 || response.status === 503) {
      logger.debug(`${response.status} received, entering backoff retry`);
      return this.#retryWithBackoff(() => this.#rawRequest(method, path, body));
    }

    return this.#handleResponse(response, method, path, body);
  }

  /**
   * Process a response: parse JSON on success, throw GhlApiError on failure.
   *
   * @param {Response} response - Fetch response
   * @param {string} method - HTTP method (for error context)
   * @param {string} path - API path (for error context)
   * @param {object | null} body - Request body (for error context)
   * @returns {Promise<object>} Parsed JSON
   * @throws {GhlApiError} On non-2xx responses
   */
  async #handleResponse(response, method, path, body) {
    if (response.ok) {
      // Some endpoints return empty bodies (204, etc.)
      const text = await response.text();
      if (!text) {
        return {};
      }
      try {
        return JSON.parse(text);
      } catch {
        // GHL returns plain-text success bodies (e.g. "OK", "Success") on 200 for
        // some endpoints (create_tag, trigger writes). The 2xx status already
        // confirms success, so trust it and return an empty object rather than
        // failing on a body that carries no structured data we consume. Callers
        // that need a specific field (e.g. an id) enforce their own invariant and
        // will surface a precise error instead of a misleading "Invalid JSON".
        //
        logger.debug('Non-JSON 2xx body treated as success:', text.slice(0, 80));
        return {};
      }
    }

    // Error response -- extract message
    let errorMessage;
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.message || errorBody.msg || errorBody.error || response.statusText;
    } catch {
      errorMessage = response.statusText;
    }

    // Handle 429/500/503 that appeared in a retry response
    if (response.status === 429 || response.status === 500 || response.status === 503) {
      throw new GhlApiError(response.status, errorMessage, 'Server error or rate limited. The request will be retried automatically.');
    }

    const suggestion = this.#getSuggestionForStatus(response.status);
    throw new GhlApiError(response.status, errorMessage, suggestion);
  }

  /**
   * Get a helpful suggestion message based on HTTP status code.
   *
   * @param {number} status - HTTP status code
   * @returns {string} Suggestion text
   */
  #getSuggestionForStatus(status) {
    switch (status) {
      case 403:
        return 'Your GHL account may not have permission for this operation.';
      case 404:
        return 'The requested resource was not found. Check the workflow or location ID.';
      default:
        return 'An unexpected error occurred. Check --verbose logs for details.';
    }
  }

  /**
   * Make a raw authenticated request (used for backoff retries).
   * Handles 401 by refreshing both tokens and retrying once, since tokens
   * may expire during a long backoff chain.
   *
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @param {object | null} body - Request body
   * @returns {Promise<object>} Parsed JSON response
   * @throws {GhlApiError} On API errors
   */
  async #rawRequest(method, path, body) {
    const headers = await this.#buildHeaders(path);

    const opts = { method, headers };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }

    const response = await fetch(GHL_BASE_URL + path, opts);

    logger.debug(method, path, '->', response.status);

    // Handle 401 within backoff retries — token may have expired mid-chain
    if (response.status === 401) {
      logger.debug('401 during backoff retry, refreshing tokens');
      await this.#tokenManager.refreshWithRetry();
      this.#authToken = null;
      this.#authTokenExpiry = null;

      const freshHeaders = await this.#buildHeaders(path);
      const retryOpts = { method, headers: freshHeaders };
      if (body !== null) {
        retryOpts.body = JSON.stringify(body);
      }

      const retryResponse = await fetch(GHL_BASE_URL + path, retryOpts);
      logger.debug(method, path, '(401 retry) ->', retryResponse.status);

      if (retryResponse.status === 401) {
        throw new GhlApiError(
          401,
          'Authentication failed after token refresh',
          'Your GHL session may have expired. Log in again in Chrome.',
        );
      }

      return this.#handleResponse(retryResponse, method, path, body);
    }

    return this.#handleResponse(response, method, path, body);
  }

  /**
   * Build the correct request headers for a given API path.
   * Workflow paths (/workflow/...) use the microfrontend origin and only need token-id.
   * All other paths need the main app origin plus the GHL session authToken.
   *
   * @param {string} path - API path
   * @returns {Promise<object>} Headers object
   */
  async #buildHeaders(path) {
    const token = await this.#tokenManager.getToken();
    const isWorkflow = path.startsWith('/workflow/');

    const headers = {
      ...BASE_HEADERS,
      'token-id': token,
      'origin': isWorkflow ? WORKFLOW_ORIGIN : APP_ORIGIN,
    };

    if (!isWorkflow) {
      const authToken = await this.#getAuthToken(token);
      headers['authorization'] = `Bearer ${authToken}`;
      Object.assign(headers, ENTITY_HEADERS);
    }

    return headers;
  }

  /**
   * Get the GHL session auth token, fetching from /oauth/2/login/current if
   * not cached or expired. This token is required for entity endpoints.
   *
   * @param {string} firebaseToken - Current Firebase JWT for the request
   * @returns {Promise<string>} The GHL auth token
   */
  async #getAuthToken(firebaseToken) {
    if (this.#authToken && this.#authTokenExpiry && Date.now() < this.#authTokenExpiry - AUTH_TOKEN_BUFFER_MS) {
      return this.#authToken;
    }

    logger.debug('Fetching GHL auth token from /oauth/2/login/current');

    const response = await fetch(`${GHL_BASE_URL}/oauth/2/login/current`, {
      headers: {
        'token-id': firebaseToken,
        'channel': 'APP',
        'source': 'WEB_USER',
        'version': '2021-07-28',
        'accept': 'application/json, text/plain, */*',
        'origin': APP_ORIGIN,
      },
    });

    if (!response.ok) {
      throw new GhlApiError(
        response.status,
        `Failed to obtain GHL auth token (${response.status})`,
        'Could not authenticate with GHL. Ensure you are logged in.',
      );
    }

    const data = await response.json();

    if (!data.authToken) {
      throw new GhlApiError(
        500,
        'GHL login/current response missing authToken',
        'Unexpected response from GHL auth endpoint.',
      );
    }

    this.#authToken = data.authToken;

    // Decode expiry from the authToken JWT, or default to 1 hour
    try {
      const claims = this.#decodeJwtPayload(data.authToken);
      this.#authTokenExpiry = claims.exp ? claims.exp * 1000 : Date.now() + 3600_000;
    } catch {
      this.#authTokenExpiry = Date.now() + 3600_000;
    }

    logger.debug('GHL auth token obtained, expires:', new Date(this.#authTokenExpiry).toISOString());
    return this.#authToken;
  }

  /**
   * Retry a function with exponential backoff and jitter.
   * Only retries on 429/500/503 GhlApiError; other errors are thrown immediately.
   *
   * @param {() => Promise<object>} fn - Function to retry
   * @param {number} [maxRetries=MAX_RETRIES] - Maximum retry attempts
   * @param {number} [baseDelay=BASE_DELAY_MS] - Base delay in milliseconds
   * @returns {Promise<object>} Result from successful call
   * @throws {GhlApiError} After all retries exhausted or on non-retryable error
   */
  async #retryWithBackoff(fn, maxRetries = MAX_RETRIES, baseDelay = BASE_DELAY_MS) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const isRetryable =
          err instanceof GhlApiError &&
          (err.status === 429 || err.status === 500 || err.status === 503);

        if (!isRetryable || attempt === maxRetries - 1) {
          throw err;
        }

        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        logger.debug(
          'Rate limited, retry', attempt + 1, 'of', maxRetries,
          'after', Math.round(delay), 'ms',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Decode the payload section of a Firebase JWT.
   *
   * @param {string} token - Full JWT string (header.payload.signature)
   * @returns {object} Parsed claims object
   * @throws {Error} If decoding or parsing fails
   */
  #decodeJwtPayload(token) {
    try {
      const segments = token.split('.');
      if (segments.length < 3) {
        throw new Error('Token is not a valid JWT (expected 3 segments)');
      }
      let payload = segments[1];
      // base64url -> base64: replace URL-safe chars
      payload = payload.replace(/-/g, '+').replace(/_/g, '/');
      // Add padding if needed
      while (payload.length % 4) payload += '=';
      const json = Buffer.from(payload, 'base64').toString('utf-8');
      return JSON.parse(json);
    } catch {
      throw new Error('Failed to decode Firebase JWT payload');
    }
  }

  /**
   * Get the company ID from the Firebase JWT claims.
   * @returns {Promise<string>}
   * @throws {Error} If company_id not found in JWT claims
   */
  async getCompanyId() {
    const token = await this.#tokenManager.getToken();
    const claims = this.#decodeJwtPayload(token);
    if (!claims.company_id) {
      throw new Error('company_id not found in JWT claims');
    }
    return claims.company_id;
  }

  /**
   * Get the user ID from the Firebase JWT claims.
   * @returns {Promise<string>}
   * @throws {Error} If user_id not found in JWT claims
   */
  async getUserId() {
    const token = await this.#tokenManager.getToken();
    const claims = this.#decodeJwtPayload(token);
    if (!claims.user_id) {
      throw new Error('user_id not found in JWT claims');
    }
    return claims.user_id;
  }

  /**
   * Get the company age value.
   * Hardcoded to 59 per MCP-SPEC.md observation (see A3 assumption in RESEARCH.md).
   * @returns {number}
   */
  getCompanyAge() {
    return 59;
  }

  /**
   * Get the full write context needed by all write API payloads.
   * Returns identity fields in both casing conventions:
   * - camelCase (companyId, userId, companyAge) for Step 3 PUT save
   * - snake_case (company_id, user_id, company_age) for Steps 1-2 POST shell/trigger
   *
   * @returns {Promise<object>}
   */
  async getWriteContext() {
    const companyId = await this.getCompanyId();
    const userId = await this.getUserId();
    const companyAge = this.getCompanyAge();

    return {
      locationId: this.#locationId,
      companyId,
      userId,
      companyAge,
      company_id: companyId,
      user_id: userId,
      company_age: companyAge,
    };
  }

  /**
   * GET request.
   * @param {string} path - API path
   * @returns {Promise<object>}
   */
  async get(path) {
    return this.request('GET', path);
  }

  /**
   * POST request.
   * @param {string} path - API path
   * @param {object} body - Request body
   * @returns {Promise<object>}
   */
  async post(path, body) {
    return this.request('POST', path, body);
  }

  /**
   * PUT request.
   * @param {string} path - API path
   * @param {object} body - Request body
   * @returns {Promise<object>}
   */
  async put(path, body) {
    return this.request('PUT', path, body);
  }

  /**
   * DELETE request.
   * @param {string} path - API path
   * @param {object|null} [body=null] - Optional request body (used by folder delete)
   * @returns {Promise<object>}
   */
  async delete(path, body = null) {
    return this.request('DELETE', path, body);
  }
}
