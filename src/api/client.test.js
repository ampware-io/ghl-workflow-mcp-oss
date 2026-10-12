import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GhlApiClient } from './client.js';

/**
 * Build a minimal JWT string from a payload object.
 * Uses base64url encoding matching real Firebase JWTs.
 */
function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

/**
 * Create a mock TokenManager that returns the given JWT.
 */
function createMockTokenManager(jwt) {
  return {
    getToken: mock.fn(async () => jwt),
    invalidate: mock.fn(),
    refreshWithRetry: mock.fn(async () => jwt),
  };
}

const TEST_PAYLOAD = {
  user_id: 'test-user-123',
  company_id: 'test-company-456',
  exp: 9999999999,
};

const TEST_JWT = makeJwt(TEST_PAYLOAD);

describe('GhlApiClient identity accessors', () => {
  it('getCompanyId() decodes JWT payload and returns the company_id claim', async () => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const companyId = await client.getCompanyId();
    assert.equal(companyId, 'test-company-456');
  });

  it('getUserId() decodes JWT payload and returns the user_id claim', async () => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const userId = await client.getUserId();
    assert.equal(userId, 'test-user-123');
  });

  it('getCompanyAge() returns 59', () => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const age = client.getCompanyAge();
    assert.equal(age, 59);
  });

  it('getWriteContext() returns combined identity object with both casing conventions', async () => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const ctx = await client.getWriteContext();

    // camelCase fields (used by Step 3 / PUT save)
    assert.equal(ctx.companyId, 'test-company-456');
    assert.equal(ctx.userId, 'test-user-123');
    assert.equal(ctx.companyAge, 59);
    assert.equal(ctx.locationId, 'loc-1');

    // snake_case fields (used by Steps 1-2 / POST shell & trigger)
    assert.equal(ctx.company_id, 'test-company-456');
    assert.equal(ctx.user_id, 'test-user-123');
    assert.equal(ctx.company_age, 59);
  });

  it('JWT decode handles base64url padding correctly', async () => {
    // Create a payload that produces a base64url string needing padding
    const payload = { user_id: 'u', company_id: 'c', extra: 'x' };
    const jwt = makeJwt(payload);
    const tm = createMockTokenManager(jwt);
    const client = new GhlApiClient(tm, 'loc-1');

    const companyId = await client.getCompanyId();
    assert.equal(companyId, 'c');
  });

  it('getCompanyId() throws if company_id missing from JWT', async () => {
    const jwt = makeJwt({ user_id: 'u' });
    const tm = createMockTokenManager(jwt);
    const client = new GhlApiClient(tm, 'loc-1');

    await assert.rejects(() => client.getCompanyId(), {
      message: 'company_id not found in JWT claims',
    });
  });

  it('getUserId() throws if user_id missing from JWT', async () => {
    const jwt = makeJwt({ company_id: 'c' });
    const tm = createMockTokenManager(jwt);
    const client = new GhlApiClient(tm, 'loc-1');

    await assert.rejects(() => client.getUserId(), {
      message: 'user_id not found in JWT claims',
    });
  });
});

describe('GhlApiClient setLocationId', () => {
  /**
   * Build a fetch stub that:
   * - returns a fresh authToken on /oauth/2/login/current and counts the calls
   * - returns 200 {} on any other URL
   * Returns { fetchFn, counts } so tests can assert.
   */
  function makeFetchStub() {
    const counts = { loginCurrent: 0, other: 0 };
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes('/oauth/2/login/current')) {
        counts.loginCurrent += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ authToken: makeJwt({ exp: 9999999999 }) }),
        };
      }
      counts.other += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      };
    };
    return { fetchFn, counts };
  }

  it('clears cached authToken when locationId changes (next entity call refetches /oauth/2/login/current)', async (t) => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const { fetchFn, counts } = makeFetchStub();
    t.mock.method(global, 'fetch', fetchFn);

    // First entity request — populates the authToken cache
    await client.get('/users/me');
    assert.equal(counts.loginCurrent, 1, 'first entity call should fetch authToken once');

    // Switch to a different locationId — should clear the cached authToken
    client.setLocationId('loc-2');
    assert.equal(client.getLocationId(), 'loc-2');

    // Next entity request — should refetch authToken because cache was cleared
    await client.get('/users/me');
    assert.equal(counts.loginCurrent, 2, 'after setLocationId(new), next entity call refetches authToken');
  });

  it('is a no-op when called with the same locationId (cached authToken preserved)', async (t) => {
    const tm = createMockTokenManager(TEST_JWT);
    const client = new GhlApiClient(tm, 'loc-1');

    const { fetchFn, counts } = makeFetchStub();
    t.mock.method(global, 'fetch', fetchFn);

    await client.get('/users/me');
    assert.equal(counts.loginCurrent, 1);

    // Same id — must NOT clear the cache
    client.setLocationId('loc-1');
    assert.equal(client.getLocationId(), 'loc-1');

    await client.get('/users/me');
    assert.equal(counts.loginCurrent, 1, 'same-id setLocationId must not invalidate the cached authToken');
  });
});

describe('GhlApiClient #handleResponse — non-JSON 2xx bodies', () => {
  /**
   * Build a fetch stub that returns a 2xx (or given status) response with the
   * supplied text body. `json()` throws to mimic a non-JSON body reaching the
   * error branch. Uses a /workflow/ path in the caller so no
   * /oauth/2/login/current fetch is needed (workflow-token branch).
   */
  function makeBodyStub({ ok = true, status = 200, text = '' }) {
    return async () => ({
      ok,
      status,
      text: async () => text,
      json: async () => {
        try {
          return JSON.parse(text);
        } catch {
          throw new Error('not json');
        }
      },
    });
  }

  it('resolves to {} on a 200 with a plain-text body ("Success") instead of throwing', async (t) => {
    const client = new GhlApiClient(createMockTokenManager(TEST_JWT), 'loc-1');
    t.mock.method(global, 'fetch', makeBodyStub({ text: 'Success' }));

    const result = await client.post('/workflow/loc-1/tags/create', { tag: 'x' });
    assert.deepEqual(result, {}, 'plain-text 2xx body should resolve to {}');
  });

  it('resolves to {} on a 200 with the legacy "OK" body', async (t) => {
    const client = new GhlApiClient(createMockTokenManager(TEST_JWT), 'loc-1');
    t.mock.method(global, 'fetch', makeBodyStub({ text: 'OK' }));

    const result = await client.post('/workflow/loc-1/tags/create', { tag: 'x' });
    assert.deepEqual(result, {}, '"OK" body should still resolve to {}');
  });

  it('resolves to {} on a 200 with a whitespace-only body', async (t) => {
    const client = new GhlApiClient(createMockTokenManager(TEST_JWT), 'loc-1');
    t.mock.method(global, 'fetch', makeBodyStub({ text: '   ' }));

    const result = await client.post('/workflow/loc-1/trigger', {});
    assert.deepEqual(result, {}, 'whitespace-only 2xx body should resolve to {}');
  });

  it('still returns the parsed object for a valid-JSON 2xx body (no regression)', async (t) => {
    const client = new GhlApiClient(createMockTokenManager(TEST_JWT), 'loc-1');
    t.mock.method(global, 'fetch', makeBodyStub({ text: '{"id":"abc"}' }));

    const result = await client.post('/workflow/loc-1/trigger', {});
    assert.deepEqual(result, { id: 'abc' }, 'valid JSON must still be parsed and returned');
  });

  it('still throws GhlApiError on a 4xx with a plain-text body (error path untouched)', async (t) => {
    const client = new GhlApiClient(createMockTokenManager(TEST_JWT), 'loc-1');
    t.mock.method(global, 'fetch', makeBodyStub({ ok: false, status: 400, text: 'Bad Request' }));

    await assert.rejects(
      () => client.post('/workflow/loc-1/tags/create', { tag: 'x' }),
      (err) => err.name === 'GhlApiError' && err.status === 400,
      '4xx plain-text response must still throw GhlApiError',
    );
  });
});
