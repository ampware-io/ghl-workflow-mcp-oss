import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PacedClient } from './paced-client.js';

/**
 * Create a mock GhlApiClient with all public methods stubbed.
 */
function createMockApiClient() {
  return {
    get: mock.fn(async () => ({ data: 'ok' })),
    post: mock.fn(async () => ({ data: 'ok' })),
    put: mock.fn(async () => ({ data: 'ok' })),
    delete: mock.fn(async () => ({ data: 'ok' })),
    getLocationId: mock.fn(() => 'loc-1'),
    getCompanyId: mock.fn(async () => 'company-1'),
    getUserId: mock.fn(async () => 'user-1'),
    getCompanyAge: mock.fn(() => 59),
    getWriteContext: mock.fn(async () => ({})),
  };
}

describe('PacedClient timing behavior', () => {
  let inner;
  let paced;

  beforeEach(() => {
    inner = createMockApiClient();
    paced = new PacedClient(inner);
  });

  it('first request fires immediately with no delay', async () => {
    const start = Date.now();
    await paced.get('/test');
    const elapsed = Date.now() - start;

    assert.equal(inner.get.mock.callCount(), 1);
    assert.ok(elapsed < 100, `Expected < 100ms, got ${elapsed}ms`);
  });

  it('second request has a visible delay', async () => {
    await paced.get('/a');
    const start = Date.now();
    await paced.get('/b');
    const elapsed = Date.now() - start;

    assert.equal(inner.get.mock.callCount(), 2);
    assert.ok(elapsed >= 500, `Expected >= 500ms delay, got ${elapsed}ms`);
  });

  it('GET delays are shorter than DELETE delays on average', async () => {
    // Measure GET delays
    const getClient = new PacedClient(createMockApiClient());
    await getClient.get('/warmup'); // first request, no delay
    const getDelays = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await getClient.get(`/get-${i}`);
      getDelays.push(Date.now() - start);
    }

    // Measure DELETE delays
    const deleteClient = new PacedClient(createMockApiClient());
    await deleteClient.delete('/warmup'); // first request, no delay
    const deleteDelays = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await deleteClient.delete(`/del-${i}`);
      deleteDelays.push(Date.now() - start);
    }

    const avgGet = getDelays.reduce((a, b) => a + b, 0) / getDelays.length;
    const avgDelete = deleteDelays.reduce((a, b) => a + b, 0) / deleteDelays.length;

    assert.ok(
      avgGet < avgDelete,
      `Expected GET avg (${avgGet.toFixed(0)}ms) < DELETE avg (${avgDelete.toFixed(0)}ms)`,
    );
  });

  it('passthrough methods delegate without pacing', () => {
    const locId = paced.getLocationId();
    assert.equal(locId, 'loc-1');
    assert.equal(inner.getLocationId.mock.callCount(), 1);

    const age = paced.getCompanyAge();
    assert.equal(age, 59);
    assert.equal(inner.getCompanyAge.mock.callCount(), 1);

    // getWriteContext is async but should still passthrough
    const ctxPromise = paced.getWriteContext();
    assert.equal(inner.getWriteContext.mock.callCount(), 1);
  });

  it('withBurst skips delays between calls', async () => {
    // Make first request to consume the free immediate pass
    await paced.get('/warmup');

    const start = Date.now();
    await paced.withBurst(async (client) => {
      await client.post('/a', {});
      await client.post('/b', {});
      await client.post('/c', {});
    });
    const elapsed = Date.now() - start;

    assert.equal(inner.post.mock.callCount(), 3);
    assert.ok(elapsed < 200, `Expected < 200ms for burst, got ${elapsed}ms`);
  });

  it('pacing resumes after burst completes', async () => {
    // First request (free)
    await paced.get('/warmup');

    // Burst (no delays)
    await paced.withBurst(async (client) => {
      await client.post('/burst-1', {});
      await client.post('/burst-2', {});
    });

    // After burst, pacing should resume
    const start = Date.now();
    await paced.get('/after');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 500, `Expected pacing to resume after burst, got ${elapsed}ms`);
  });

  it('delegates to inner client methods correctly', async () => {
    await paced.post('/test', { key: 'val' });

    assert.equal(inner.post.mock.callCount(), 1);
    const call = inner.post.mock.calls[0];
    assert.equal(call.arguments[0], '/test');
    assert.deepEqual(call.arguments[1], { key: 'val' });
  });
});
