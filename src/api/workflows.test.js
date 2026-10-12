import { describe, it, mock, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhlApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Dynamic import so we can test the module once it exists
const { listWorkflows, getWorkflow } = await import('./workflows.js');
const workflowCache = await import('../cache/workflow-cache.js');

/**
 * Create a mock apiClient with configurable get responses.
 * @param {Function|Array} getResponses - function(path) or array of sequential responses
 */
function createMockApiClient(getResponses) {
  let callIndex = 0;
  return {
    getLocationId: () => 'test-location-id',
    get: mock.fn(async (path) => {
      if (typeof getResponses === 'function') return getResponses(path);
      return getResponses[callIndex++];
    }),
  };
}

describe('listWorkflows', () => {
  it('auto-fetches all pages when called without limit/offset', async () => {
    const page1 = { rows: Array.from({ length: 50 }, (_, i) => ({ _id: `wf-${i}`, name: `Workflow ${i}` })), count: 60 };
    const page2 = { rows: Array.from({ length: 10 }, (_, i) => ({ _id: `wf-${50 + i}`, name: `Workflow ${50 + i}` })), count: 60 };

    const client = createMockApiClient([page1, page2]);
    const result = await listWorkflows(client);

    assert.equal(result.workflows.length, 60);
    assert.equal(result.workflows[0]._id, 'wf-0');
    assert.equal(result.workflows[59]._id, 'wf-59');
    assert.equal(client.get.mock.callCount(), 2);
  });

  it('returns a single page when called with limit/offset', async () => {
    const page = { rows: [{ _id: 'wf-10', name: 'Workflow 10' }] };
    const client = createMockApiClient([page]);
    const result = await listWorkflows(client, { limit: 5, offset: 10 });

    assert.equal(result.workflows.length, 1);
    assert.equal(client.get.mock.callCount(), 1);

    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(calledPath.includes('limit=5'), `Expected limit=5 in ${calledPath}`);
    assert.ok(calledPath.includes('offset=10'), `Expected offset=10 in ${calledPath}`);
  });

  it('passes sortBy and sortOrder to the API', async () => {
    const client = createMockApiClient([{ rows: [] }]);
    await listWorkflows(client, { sortBy: 'createdAt', sortOrder: 'desc' });

    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(calledPath.includes('sortBy=createdAt'), `Expected sortBy=createdAt in ${calledPath}`);
    assert.ok(calledPath.includes('sortOrder=desc'), `Expected sortOrder=desc in ${calledPath}`);
  });

  it('uses default sort (name, asc) when no options provided', async () => {
    const client = createMockApiClient([{ rows: [] }]);
    await listWorkflows(client);

    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(calledPath.includes('sortBy=name'), `Expected sortBy=name in ${calledPath}`);
    assert.ok(calledPath.includes('sortOrder=asc'), `Expected sortOrder=asc in ${calledPath}`);
  });

  it('returns empty workflows array for empty location', async () => {
    const client = createMockApiClient([{ rows: [], count: 0 }]);
    const result = await listWorkflows(client);

    assert.deepEqual(result, { workflows: [], total_count: 0 });
  });

  it('keeps paginating when API returns fewer rows than requested but count indicates more', async () => {
    const page1 = { rows: Array.from({ length: 44 }, (_, i) => ({ _id: `wf-${i}` })), count: 46 };
    const page2 = { rows: Array.from({ length: 2 }, (_, i) => ({ _id: `wf-${44 + i}` })), count: 46 };

    const client = createMockApiClient([page1, page2]);
    const result = await listWorkflows(client);

    assert.equal(result.workflows.length, 46);
    assert.equal(client.get.mock.callCount(), 2);
  });

  it('propagates GhlApiError on API failure', async () => {
    const error = new GhlApiError(404, 'Not found', 'Check the location ID.');
    const client = createMockApiClient(() => { throw error; });

    await assert.rejects(() => listWorkflows(client), (err) => {
      assert.ok(err instanceof GhlApiError);
      assert.equal(err.status, 404);
      return true;
    });
  });
});

describe('listWorkflows folderId filtering', () => {
  it('adds parentId query param when folderId is provided (single-page mode)', async () => {
    const client = createMockApiClient([{ rows: [{ _id: 'wf-1', name: 'WF' }], count: 1 }]);
    await listWorkflows(client, { limit: 10, folderId: 'folder-abc' });
    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(calledPath.includes('parentId=folder-abc'), `Expected parentId in path: ${calledPath}`);
  });

  it('adds parentId query param when folderId is provided (auto-pagination mode)', async () => {
    const client = createMockApiClient([{ rows: [{ _id: 'wf-1' }], count: 1 }]);
    await listWorkflows(client, { folderId: 'folder-xyz' });
    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(calledPath.includes('parentId=folder-xyz'), `Expected parentId in path: ${calledPath}`);
  });

  it('omits parentId when folderId is not provided', async () => {
    const client = createMockApiClient([{ rows: [], count: 0 }]);
    await listWorkflows(client);
    const calledPath = client.get.mock.calls[0].arguments[0];
    assert.ok(!calledPath.includes('parentId'), `Unexpected parentId in path: ${calledPath}`);
  });
});

describe('getWorkflow', () => {
  it('merges detail and triggers into a single object', async () => {
    const detail = { _id: 'wf-123', name: 'Test Workflow', status: 'published' };
    const triggersResponse = { triggers: [{ type: 'form_submission', config: {} }] };

    const client = createMockApiClient((path) => {
      if (path.includes('/trigger?')) return triggersResponse;
      return detail;
    });

    const result = await getWorkflow(client, 'wf-123');

    assert.equal(result._id, 'wf-123');
    assert.equal(result.name, 'Test Workflow');
    assert.ok(Array.isArray(result.triggers));
    assert.equal(result.triggers.length, 1);
    assert.equal(result.triggers[0].type, 'form_submission');
  });

  it('handles bare array trigger response', async () => {
    const detail = { _id: 'wf-456', name: 'Another Workflow' };
    const bareArray = [{ type: 'contact_tag', config: {} }];

    const client = createMockApiClient((path) => {
      if (path.includes('/trigger?')) return bareArray;
      return detail;
    });

    const result = await getWorkflow(client, 'wf-456');

    assert.ok(Array.isArray(result.triggers));
    assert.equal(result.triggers.length, 1);
    assert.equal(result.triggers[0].type, 'contact_tag');
  });

  it('propagates GhlApiError on API failure', async () => {
    const error = new GhlApiError(500, 'Internal error', 'Try again.');
    const client = createMockApiClient(() => { throw error; });

    await assert.rejects(() => getWorkflow(client, 'wf-123'), (err) => {
      assert.ok(err instanceof GhlApiError);
      assert.equal(err.status, 500);
      return true;
    });
  });
});

describe('getWorkflow cache write-through', () => {
  let cacheDir;
  let originalCacheDir;
  let warnSpy;

  beforeEach(() => {
    originalCacheDir = process.env.GHL_MCP_CACHE_DIR;
    cacheDir = mkdtempSync(join(tmpdir(), 'ghl-wkfl-cache-test-'));
    process.env.GHL_MCP_CACHE_DIR = cacheDir;
    warnSpy = mock.method(logger, 'warn', () => {});
  });

  afterEach(() => {
    warnSpy.mock.restore();
    if (originalCacheDir === undefined) {
      delete process.env.GHL_MCP_CACHE_DIR;
    } else {
      process.env.GHL_MCP_CACHE_DIR = originalCacheDir;
    }
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('writes the response to cache on success', async () => {
    const detail = { _id: 'WF-TEST-1', name: 'CacheTest', workflowData: { templates: [] } };
    const triggersResponse = { triggers: [] };
    const client = createMockApiClient((path) => {
      if (path.includes('/trigger?')) return triggersResponse;
      return detail;
    });

    const result = await getWorkflow(client, 'WF-TEST-1');

    const cached = await workflowCache.read('WF-TEST-1');
    assert.ok(cached !== null, 'expected cache file to exist after getWorkflow');
    assert.deepEqual(cached, result);
  });

  it('does not throw when cache write fails — logs warn instead', async () => {
    // Sabotage cache dir: place a regular file where the workflow JSON file
    // path expects to be writable. Cache write resolves to {dir}/WF-TEST-2.json,
    // and the atomic write opens {dir}/WF-TEST-2.json.tmp with 'wx'. Pre-creating
    // the .tmp as a directory makes open('wx') fail with EISDIR/EEXIST.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(cacheDir, 'WF-TEST-2.json.tmp'));

    const detail = { _id: 'WF-TEST-2', name: 'Sabotaged' };
    const triggersResponse = { triggers: [] };
    const client = createMockApiClient((path) => {
      if (path.includes('/trigger?')) return triggersResponse;
      return detail;
    });

    const result = await getWorkflow(client, 'WF-TEST-2');

    // API result must still come through
    assert.equal(result._id, 'WF-TEST-2');
    // logger.warn must have been invoked with cache.write_failed
    assert.ok(warnSpy.mock.callCount() >= 1, 'expected logger.warn to be called');
    const warnArgs = warnSpy.mock.calls[0].arguments.join(' ');
    assert.ok(
      /cache\.write_failed/.test(warnArgs),
      `expected cache.write_failed in warn args, got: ${warnArgs}`,
    );
  });

  it('does not write cache on API failure', async () => {
    const error = new GhlApiError(500, 'boom', 'try later');
    const client = createMockApiClient(() => { throw error; });

    await assert.rejects(() => getWorkflow(client, 'WF-TEST-3'));

    const exists = await workflowCache.exists('WF-TEST-3');
    assert.equal(exists, false, 'cache file should not exist after API failure');
  });
});
