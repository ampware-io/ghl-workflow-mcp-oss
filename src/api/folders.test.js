import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createFolder, deleteFolder, renameFolder, moveWorkflow, listFolders } = await import('./folders.js');

/**
 * Create a mock apiClient for folder operations.
 * Tracks all API calls and supports configurable responses for pagination testing.
 *
 * @param {object} options
 * @param {Function} [options.getResponder] - Custom GET responder (receives path, returns response)
 * @param {Error} [options.postError] - Error to throw on POST calls
 * @param {Error} [options.deleteError] - Error to throw on DELETE calls
 * @param {Error} [options.putError] - Error to throw on PUT calls
 */
function createMockFolderClient(options = {}) {
  const calls = { post: [], put: [], delete: [], get: [] };

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
    post: mock.fn(async (path, body) => {
      calls.post.push({ path, body });
      if (options.postError) throw options.postError;
      return { _id: 'new-folder-id', name: body.name };
    }),
    put: mock.fn(async (path, body) => {
      calls.put.push({ path, body });
      if (options.putError) throw options.putError;
      return {};
    }),
    delete: mock.fn(async (path, body) => {
      calls.delete.push({ path, body });
      if (options.deleteError) throw options.deleteError;
      return {};
    }),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      if (options.getResponder) return options.getResponder(path);
      return { rows: [], count: 0 };
    }),
    _calls: calls,
  };
}

describe('createFolder', () => {
  it('posts to /workflow/{locationId}/directory with correct payload', async () => {
    const client = createMockFolderClient();
    const result = await createFolder(client, { name: 'My Folder' });

    assert.equal(client._calls.post.length, 1);
    assert.ok(client._calls.post[0].path.includes('/workflow/test-loc-id/directory'));
    assert.equal(result.status, 'created');
  });

  it('payload includes type: directory, company_id, company_age, updatedBy', async () => {
    const client = createMockFolderClient();
    await createFolder(client, { name: 'Test Folder' });

    const body = client._calls.post[0].body;
    assert.equal(body.type, 'directory');
    assert.equal(body.name, 'Test Folder');
    assert.equal(body.company_id, 'test-company');
    assert.equal(body.company_age, 59);
    assert.equal(body.updatedBy, 'test-user');
    assert.equal(body.parentId, null);
  });
});

describe('deleteFolder', () => {
  it('calls delete with path and body containing type: directory and workflowIds', async () => {
    const client = createMockFolderClient();
    const result = await deleteFolder(client, { folderId: 'folder-123' });

    assert.equal(client._calls.delete.length, 1);
    assert.ok(client._calls.delete[0].path.includes('/workflow/test-loc-id/delete'));

    const body = client._calls.delete[0].body;
    assert.equal(body.type, 'directory');
    assert.deepEqual(body.workflowIds, ['folder-123']);
    assert.equal(body.updatedBy, 'test-user');
  });

  it('result contains note about workflows moved to root', async () => {
    const client = createMockFolderClient();
    const result = await deleteFolder(client, { folderId: 'folder-123' });

    assert.equal(result.status, 'deleted');
    assert.equal(result.folderId, 'folder-123');
    assert.ok(result.note.toLowerCase().includes('workflow'));
  });
});

describe('renameFolder', () => {
  it('puts to correct path with {name}', async () => {
    const client = createMockFolderClient();
    const result = await renameFolder(client, { folderId: 'folder-123', name: 'New Name' });

    assert.equal(client._calls.put.length, 1);
    assert.equal(client._calls.put[0].path, '/workflow/test-loc-id/rename-directory/folder-123');
    assert.deepEqual(client._calls.put[0].body, { name: 'New Name' });
    assert.equal(result.status, 'renamed');
    assert.equal(result.folderId, 'folder-123');
    assert.equal(result.name, 'New Name');
  });
});

describe('moveWorkflow', () => {
  it('puts to correct path with {parentId: folderId}', async () => {
    const client = createMockFolderClient();
    const result = await moveWorkflow(client, { workflowId: 'wf-1', folderId: 'folder-123' });

    assert.equal(client._calls.put.length, 1);
    assert.equal(client._calls.put[0].path, '/workflow/test-loc-id/move-directory/wf-1');
    assert.deepEqual(client._calls.put[0].body, { parentId: 'folder-123' });
    assert.equal(result.status, 'moved');
    assert.equal(result.workflowId, 'wf-1');
    assert.equal(result.destination, 'folder-123');
  });

  it('with null folderId sends parentId: null (root move)', async () => {
    const client = createMockFolderClient();
    const result = await moveWorkflow(client, { workflowId: 'wf-1', folderId: null });

    assert.deepEqual(client._calls.put[0].body, { parentId: null });
    assert.equal(result.destination, 'root');
  });

  it('with omitted folderId defaults to parentId: null (root move)', async () => {
    const client = createMockFolderClient();
    const result = await moveWorkflow(client, { workflowId: 'wf-1' });

    assert.deepEqual(client._calls.put[0].body, { parentId: null });
    assert.equal(result.destination, 'root');
  });
});

describe('listFolders', () => {
  it('filters to type === directory only', async () => {
    const client = createMockFolderClient({
      getResponder: () => ({
        rows: [
          { _id: 'f1', name: 'Folder 1', type: 'directory' },
          { _id: 'w1', name: 'Workflow 1', type: 'workflow' },
          { _id: 'f2', name: 'Folder 2', type: 'directory' },
        ],
        count: 3,
      }),
    });

    const result = await listFolders(client);
    assert.equal(result.folders.length, 2);
    assert.ok(result.folders.every((f) => f.type === 'directory'));
  });

  it('paginates across multiple pages', async () => {
    let callCount = 0;
    const client = createMockFolderClient({
      getResponder: () => {
        callCount++;
        if (callCount === 1) {
          return {
            rows: [
              { _id: 'f1', name: 'Folder 1', type: 'directory' },
              { _id: 'w1', name: 'WF', type: 'workflow' },
            ],
            count: 4,
          };
        }
        return {
          rows: [
            { _id: 'f2', name: 'Folder 2', type: 'directory' },
            { _id: 'w2', name: 'WF2', type: 'workflow' },
          ],
          count: 4,
        };
      },
    });

    const result = await listFolders(client);
    assert.equal(result.folders.length, 2);
    assert.equal(client._calls.get.length, 2);
  });

  it('returns empty folders array when no directories exist', async () => {
    const client = createMockFolderClient({
      getResponder: () => ({
        rows: [{ _id: 'w1', name: 'WF', type: 'workflow' }],
        count: 1,
      }),
    });

    const result = await listFolders(client);
    assert.deepEqual(result.folders, []);
  });
});

describe('error propagation', () => {
  it('error from client.post() bubbles up from createFolder', async () => {
    const error = new Error('API Error');
    const client = createMockFolderClient({ postError: error });

    await assert.rejects(
      () => createFolder(client, { name: 'Fail' }),
      (err) => {
        assert.equal(err.message, 'API Error');
        return true;
      },
    );
  });
});
