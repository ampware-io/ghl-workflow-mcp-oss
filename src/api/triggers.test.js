import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const { createTrigger, updateTrigger, deleteTrigger } = await import('./triggers.js');

/**
 * Mock CDP client for the triggers module. Captures all HTTP calls and
 * supports per-method response/error injection.
 */
function createMockClient(options = {}) {
  const calls = { post: [], put: [], delete: [], get: [] };
  return {
    getLocationId: () => 'loc-1',
    getWriteContext: async () => ({
      locationId: 'loc-1',
      companyId: 'co-1',
      userId: 'u-1',
      companyAge: 12,
      company_id: 'co-1',
      user_id: 'u-1',
      company_age: 12,
    }),
    post: mock.fn(async (path, body) => {
      calls.post.push({ path, body });
      if (options.postError) throw options.postError;
      if (options.postResponse !== undefined) return options.postResponse;
      return { id: 'tr-new-1' };
    }),
    put: mock.fn(async (path, body) => {
      calls.put.push({ path, body });
      if (options.putError) throw options.putError;
      return options.putResponse ?? {};
    }),
    delete: mock.fn(async (path) => {
      calls.delete.push({ path });
      if (options.deleteError) throw options.deleteError;
      return options.deleteResponse ?? {};
    }),
    get: mock.fn(async () => ({})),
    _calls: calls,
  };
}

describe('createTrigger', () => {
  it('POSTs /workflow/{loc}/trigger with buildTriggerPayload-shaped body and returns {id}', async () => {
    const client = createMockClient({ postResponse: { id: 'tr-fresh-1' } });
    const ctx = await client.getWriteContext();
    const result = await createTrigger(client, {
      workflowId: 'wf-1',
      trigger: { type: 'form_submission', name: 'Form', conditions: [] },
      ctx,
    });

    assert.equal(client._calls.post.length, 1);
    assert.equal(client._calls.post[0].path, '/workflow/loc-1/trigger');
    const body = client._calls.post[0].body;
    assert.equal(body.workflowId, 'wf-1');
    assert.equal(body.type, 'form_submission');
    assert.equal(body.name, 'Form');
    assert.equal(body.location_id, 'loc-1');
    assert.equal(body.masterType, 'highlevel');
    assert.deepEqual(body.actions, [{ workflow_id: 'wf-1', type: 'add_to_workflow' }]);
    assert.equal(result.id, 'tr-fresh-1');
  });

  it('throws when POST response lacks an id', async () => {
    const client = createMockClient({ postResponse: { foo: 'bar' } });
    const ctx = await client.getWriteContext();
    await assert.rejects(
      () => createTrigger(client, {
        workflowId: 'wf-1',
        trigger: { type: 'form_submission', name: 'Form' },
        ctx,
      }),
      (err) => /no id/i.test(err.message),
    );
  });

  it('normalizes read-format conditions ("==" → "is-any-of") via buildTriggerPayload', async () => {
    const client = createMockClient();
    const ctx = await client.getWriteContext();
    await createTrigger(client, {
      workflowId: 'wf-1',
      trigger: {
        type: 'contact_tag',
        name: 'Tag',
        conditions: [{ field: 'tag', operator: '==', value: 'vip' }],
      },
      ctx,
    });
    const body = client._calls.post[0].body;
    assert.equal(body.conditions[0].operator, 'is-any-of');
    assert.deepEqual(body.conditions[0].value, ['vip']);
    assert.equal(body.conditions[0].type, 'string');
  });
});

describe('updateTrigger', () => {
  it('PUTs /workflow/{loc}/trigger/{triggerId} with buildTriggerPayload-shaped body including the id', async () => {
    const client = createMockClient({ putResponse: { ok: true } });
    const ctx = await client.getWriteContext();
    const result = await updateTrigger(client, {
      workflowId: 'wf-1',
      triggerId: 'tr-existing',
      trigger: { type: 'form_submission', name: 'Renamed', conditions: [] },
      ctx,
    });

    assert.equal(client._calls.put.length, 1);
    assert.equal(client._calls.put[0].path, '/workflow/loc-1/trigger/tr-existing');
    const body = client._calls.put[0].body;
    assert.equal(body.id, 'tr-existing');
    assert.equal(body.workflowId, 'wf-1');
    assert.equal(body.name, 'Renamed');
    assert.equal(body.location_id, 'loc-1');
    assert.deepEqual(result, { ok: true });
  });

  it('normalizes "==" conditions on the PUT body', async () => {
    const client = createMockClient();
    const ctx = await client.getWriteContext();
    await updateTrigger(client, {
      workflowId: 'wf-1',
      triggerId: 'tr-1',
      trigger: {
        type: 'contact_tag',
        name: 'Tag',
        conditions: [{ field: 'tag', operator: '==', value: 'vip' }],
      },
      ctx,
    });
    const body = client._calls.put[0].body;
    assert.equal(body.conditions[0].operator, 'is-any-of');
    assert.deepEqual(body.conditions[0].value, ['vip']);
  });
});

describe('deleteTrigger', () => {
  it('DELETEs /workflow/{loc}/trigger/{triggerId} with no body', async () => {
    const client = createMockClient({ deleteResponse: {} });
    await deleteTrigger(client, { triggerId: 'tr-doomed' });

    assert.equal(client._calls.delete.length, 1);
    assert.equal(client._calls.delete[0].path, '/workflow/loc-1/trigger/tr-doomed');
  });

  it('returns whatever the client returns (e.g. {})', async () => {
    const client = createMockClient({ deleteResponse: { status: 'ok' } });
    const result = await deleteTrigger(client, { triggerId: 'tr-x' });
    assert.deepEqual(result, { status: 'ok' });
  });
});
