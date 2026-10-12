import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  listTags,
  createTag,
  listUsers,
  listPipelines,
  listCustomFields,
  listCustomValues,
  listAssociations,
  listBusinessFields,
} = await import('./entities.js');

/**
 * Create a mock apiClient for entity operations.
 * Tracks all API calls and supports configurable responses.
 *
 * @param {object} options
 * @param {Function} [options.getResponder] - Custom GET responder (receives path, returns response)
 * @param {object} [options.postResponse] - Response for POST calls
 * @param {Error} [options.getError] - Error to throw on GET calls
 * @param {Error} [options.postError] - Error to throw on POST calls
 */
function createMockEntityClient(options = {}) {
  const calls = { get: [], post: [] };

  return {
    getLocationId: () => 'test-loc-id',
    getWriteContext: async () => ({
      locationId: 'test-loc-id',
      companyId: 'test-company',
      userId: 'test-user',
      companyAge: 59,
      company_id: 'test-company',
      user_id: 'test-user',
      company_age: 59,
    }),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      if (options.getError) throw options.getError;
      if (options.getResponder) return options.getResponder(path);
      return {};
    }),
    post: mock.fn(async (path, body) => {
      calls.post.push({ path, body });
      if (options.postError) throw options.postError;
      return options.postResponse || {};
    }),
    _calls: calls,
  };
}

describe('listTags', () => {
  it('calls GET /locations/{locationId}/tags and returns tags array', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        tags: [
          { id: 't1', name: 'vip', locationId: 'test-loc-id' },
          { id: 't2', name: 'hot-lead', locationId: 'test-loc-id' },
        ],
      }),
    });

    const result = await listTags(client);

    assert.equal(client._calls.get.length, 1);
    assert.ok(client._calls.get[0].path.includes('/locations/test-loc-id/tags'));
    assert.equal(result.tags.length, 2);
    assert.equal(result.tags[0].name, 'vip');
  });
});

describe('createTag', () => {
  it('calls POST /workflow/{locationId}/tags/create with { tag: tagName }', async () => {
    const client = createMockEntityClient({
      postResponse: { id: 'new-tag-id', name: 'my-tag' },
    });

    const result = await createTag(client, { tagName: 'my-tag' });

    assert.equal(client._calls.post.length, 1);
    assert.ok(client._calls.post[0].path.includes('/workflow/test-loc-id/tags/create'));
    assert.deepEqual(client._calls.post[0].body, { tag: 'my-tag' });
    assert.equal(result.status, 'ok');
    assert.equal(result.tagName, 'my-tag');
    assert.equal(result.message, 'Tag "my-tag" created.');
    assert.equal(result.id, 'new-tag-id');
    assert.equal(result.name, 'my-tag');
  });

  it('returns structured success when GHL returns the bare string "OK"', async () => {
    const client = createMockEntityClient({ postResponse: 'OK' });

    const result = await createTag(client, { tagName: 'newsletter' });

    assert.deepEqual(result, {
      status: 'ok',
      tagName: 'newsletter',
      message: 'Tag "newsletter" created.',
    });
  });

  it('returns structured success when GHL returns an empty object', async () => {
    const client = createMockEntityClient({ postResponse: {} });

    const result = await createTag(client, { tagName: 'beta' });

    assert.deepEqual(result, {
      status: 'ok',
      tagName: 'beta',
      message: 'Tag "beta" created.',
    });
  });
});

describe('listUsers', () => {
  it('calls GET /users/search with companyId and locationId', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        users: [{ id: 'u1', name: 'Alice' }],
        count: 1,
      }),
    });

    const result = await listUsers(client);

    assert.equal(client._calls.get.length, 1);
    const path = client._calls.get[0].path;
    assert.ok(path.includes('/users/search'));
    assert.ok(path.includes('companyId=test-company'));
    assert.ok(path.includes('locationId=test-loc-id'));
    assert.equal(result.users.length, 1);
    assert.equal(result.count, 1);
  });
});

describe('listPipelines', () => {
  it('calls GET /opportunities/pipelines with locationId', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        pipelines: [{ id: 'p1', name: 'Sales', stages: [] }],
      }),
    });

    const result = await listPipelines(client);

    assert.equal(client._calls.get.length, 1);
    assert.ok(client._calls.get[0].path.includes('/opportunities/pipelines'));
    assert.ok(client._calls.get[0].path.includes('locationId=test-loc-id'));
    assert.equal(result.pipelines.length, 1);
  });
});

describe('listCustomFields', () => {
  it('routes to /customFields?model=opportunity for opportunity model', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        customFields: [{ id: 'cf1', name: 'Deal Size', model: 'opportunity' }],
      }),
    });

    const result = await listCustomFields(client, { model: 'opportunity' });

    assert.equal(client._calls.get.length, 1);
    const path = client._calls.get[0].path;
    assert.ok(path.includes('/customFields?model=opportunity'));
    assert.ok(!path.includes('/customFields/search'));
    assert.equal(result.customFields.length, 1);
  });

  it('routes to /customFields/search for contact model', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        customFields: [{ id: 'cf2', name: 'Source', model: 'contact' }],
        totalItems: 1,
      }),
    });

    const result = await listCustomFields(client, { model: 'contact' });

    assert.equal(client._calls.get.length, 1);
    const path = client._calls.get[0].path;
    assert.ok(path.includes('/customFields/search'));
    assert.ok(path.includes('model=contact'));
    assert.ok(path.includes('includeStandards=true'));
    assert.equal(result.customFields.length, 1);
    assert.equal(result.totalItems, 1);
  });
});

describe('listCustomValues', () => {
  it('calls GET /custom-data/conversations with locationId and types=custom-values', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        static: [{ label: 'sys-var', value: '{{val}}' }],
        'custom-values': [{ label: 'My Val', value: 'custom' }],
      }),
    });

    const result = await listCustomValues(client);

    assert.equal(client._calls.get.length, 1);
    const path = client._calls.get[0].path;
    assert.ok(path.includes('/custom-data/conversations'));
    assert.ok(path.includes('locationId=test-loc-id'));
    assert.ok(path.includes('types=custom-values'));
    assert.equal(result.static.length, 1);
    assert.equal(result.customValues.length, 1);
  });
});

describe('listAssociations', () => {
  it('calls GET /associations/objectKey/contact with locationId', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        associations: [{ id: 'a1', firstObjectKey: 'contact', secondObjectKey: 'company' }],
        total: 1,
      }),
    });

    const result = await listAssociations(client);

    assert.equal(client._calls.get.length, 1);
    assert.ok(client._calls.get[0].path.includes('/associations/objectKey/contact'));
    assert.ok(client._calls.get[0].path.includes('locationId=test-loc-id'));
    assert.equal(result.associations.length, 1);
    assert.equal(result.total, 1);
  });
});

describe('listBusinessFields', () => {
  it('calls GET /objects/business/ with locationId and fetchProperties=true', async () => {
    const client = createMockEntityClient({
      getResponder: () => ({
        object: { key: 'business', labels: { singular: 'Business' } },
        fields: [{ id: 'bf1', name: 'Company Name', fieldKey: 'company_name' }],
      }),
    });

    const result = await listBusinessFields(client);

    assert.equal(client._calls.get.length, 1);
    const path = client._calls.get[0].path;
    assert.ok(path.includes('/objects/business/'));
    assert.ok(path.includes('locationId=test-loc-id'));
    assert.ok(path.includes('fetchProperties=true'));
    assert.ok(result.object !== null);
    assert.equal(result.fields.length, 1);
  });
});

describe('error propagation', () => {
  it('error from client.get() bubbles up from listTags', async () => {
    const error = new Error('API Error');
    const client = createMockEntityClient({ getError: error });

    await assert.rejects(
      () => listTags(client),
      (err) => {
        assert.equal(err.message, 'API Error');
        return true;
      },
    );
  });

  it('error from client.post() bubbles up from createTag', async () => {
    const error = new Error('POST Error');
    const client = createMockEntityClient({ postError: error });

    await assert.rejects(
      () => createTag(client, { tagName: 'fail' }),
      (err) => {
        assert.equal(err.message, 'POST Error');
        return true;
      },
    );
  });
});
