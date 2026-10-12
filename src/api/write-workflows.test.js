import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createWorkflow, updateWorkflow, deleteWorkflow, publishWorkflow, cloneWorkflow } = await import('./write-workflows.js');

/**
 * Create a mock apiClient for write operations.
 * Tracks all API calls and supports configurable error injection.
 *
 * @param {object} options
 * @param {Error} [options.postShellError] - Error to throw on the shell-creation POST (path without /trigger)
 * @param {Error} [options.postTriggerError] - Error to throw on POST trigger calls
 * @param {Error} [options.putError] - Error to throw on PUT save calls
 * @param {Error} [options.deleteError] - Error to throw on DELETE cleanup calls
 * @param {object} [options.getWorkflowResponse] - Custom getWorkflow response
 * @param {{rows: Array, count: number}} [options.listWorkflowsResponse] - Override the response from listWorkflows GETs
 * @param {{rows: Array, count: number}} [options.listBefore] - Response for the FIRST list call only (the pre-create snapshot)
 * @param {Error} [options.listWorkflowsError] - Error to throw from listWorkflows GETs (takes precedence over listWorkflowsResponse)
 */
function createMockWriteClient(options = {}) {
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
      if (options.postTriggerError && path.includes('/trigger')) {
        throw options.postTriggerError;
      }
      if (path.includes('/trigger')) {
        return { id: 'trigger-' + calls.post.length };
      }
      // Shell POST (path does NOT include /trigger)
      if (options.postShellError) {
        throw options.postShellError;
      }
      // Shell response
      return { _id: 'new-workflow-id', name: body.name };
    }),
    put: mock.fn(async (path, body) => {
      calls.put.push({ path, body });
      if (options.putError) throw options.putError;
      return {};
    }),
    delete: mock.fn(async (path) => {
      calls.delete.push({ path });
      if (options.deleteError) throw options.deleteError;
      return {};
    }),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      // listWorkflows hits /workflow/{locId}/list?... — error takes precedence
      if (path.includes('/workflow/test-loc-id/list')) {
        calls.listCount = (calls.listCount || 0) + 1;
        if (options.listBefore && calls.listCount === 1) {
          return options.listBefore;
        }
        if (options.listWorkflowsError) {
          throw options.listWorkflowsError;
        }
        if (options.listWorkflowsResponse) {
          return options.listWorkflowsResponse;
        }
      }
      if (options.getWorkflowResponse) return options.getWorkflowResponse;
      return {
        _id: 'new-workflow-id',
        name: 'Test Workflow',
        status: 'draft',
        triggers: [],
        workflowData: { templates: [] },
      };
    }),
    _calls: calls,
  };
}

describe('createWorkflow', () => {
  it('creates an empty draft workflow with name only (D-02)', async () => {
    const client = createMockWriteClient();
    const result = await createWorkflow(client, { name: 'My Workflow' });

    // Should call POST shell, skip triggers, call PUT save, call getWorkflow
    assert.equal(client._calls.post.length, 1, 'should make 1 POST (shell only)');
    assert.equal(client._calls.put.length, 1, 'should make 1 PUT (save)');

    // Verify shell POST path
    assert.ok(client._calls.post[0].path.includes('/workflow/test-loc-id'));

    // Verify save PUT has empty templates
    const saveBody = client._calls.put[0].body;
    assert.deepEqual(saveBody.workflowData.templates, []);
    assert.deepEqual(saveBody.createdSteps, []);

    // Verify getWorkflow was called to return full workflow. #76 adds one
    // list GET (pre-create same-name snapshot) ahead of it.
    const nonList = client._calls.get.filter((c) => !c.path.includes('/list'));
    assert.equal(nonList.length, 2, 'should call getWorkflow (2 GETs: detail + triggers)');
    assert.equal(client._calls.get.length - nonList.length, 1, 'exactly one pre-create list snapshot');
    assert.equal(result._id, 'new-workflow-id');
  });

  it('creates a workflow with actions wired into a chain (D-03)', async () => {
    const actions = [
      { type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' } },
      { type: 'wait', name: 'Wait 5m', attributes: { duration: 300 } },
    ];
    const client = createMockWriteClient();
    const result = await createWorkflow(client, { name: 'With Actions', actions });

    // Should POST shell, skip triggers, PUT save with actions
    assert.equal(client._calls.post.length, 1, 'should make 1 POST (shell)');
    assert.equal(client._calls.put.length, 1, 'should make 1 PUT (save)');

    const saveBody = client._calls.put[0].body;
    assert.equal(saveBody.workflowData.templates.length, 2);
    assert.equal(saveBody.createdSteps.length, 2);

    // Verify chain wiring: first action has next pointing to second
    const templates = saveBody.workflowData.templates;
    assert.equal(templates[0].next, templates[1].id);
    assert.equal(templates[0].order, 0);
    assert.equal(templates[1].order, 1);
    assert.ok(!('next' in templates[1]), 'last action should not have next');

    assert.equal(result._id, 'new-workflow-id');
  });

  it('creates a workflow with triggers (POST trigger for each)', async () => {
    const triggers = [
      { type: 'form_submission', name: 'Form Submit', conditions: [] },
    ];
    const client = createMockWriteClient();
    const result = await createWorkflow(client, { name: 'With Trigger', triggers });

    // Should POST shell, POST trigger, PUT save
    assert.equal(client._calls.post.length, 2, 'should make 2 POSTs (shell + trigger)');
    assert.ok(client._calls.post[1].path.includes('/trigger'), 'second POST should be trigger');
    assert.equal(client._calls.put.length, 1, 'should make 1 PUT (save)');

    assert.equal(result._id, 'new-workflow-id');
  });

  it('creates a workflow with both actions and triggers in order', async () => {
    const triggers = [{ type: 'form_submission', name: 'Form' }];
    const actions = [{ type: 'add_notes', name: 'Add Note', attributes: { note: 'hello' } }];
    const client = createMockWriteClient();
    await createWorkflow(client, { name: 'Full', triggers, actions });

    // POST shell, POST trigger, PUT save
    assert.equal(client._calls.post.length, 2);
    assert.equal(client._calls.put.length, 1);

    // Save should have both templates and trigger references
    const saveBody = client._calls.put[0].body;
    assert.equal(saveBody.workflowData.templates.length, 1);
    assert.ok(saveBody.triggersChanged === true);
    assert.ok(saveBody.newTriggers.length > 0);
  });

  it('passes status=published through to save payload (D-04)', async () => {
    const client = createMockWriteClient();
    await createWorkflow(client, { name: 'Published', status: 'published' });

    const saveBody = client._calls.put[0].body;
    assert.equal(saveBody.status, 'published');
  });

  it('defaults status to draft when not specified (D-04)', async () => {
    const client = createMockWriteClient();
    await createWorkflow(client, { name: 'Draft' });

    const saveBody = client._calls.put[0].body;
    assert.equal(saveBody.status, 'draft');
  });

  it('attempts DELETE cleanup on trigger creation failure (D-07)', async () => {
    const triggerError = new Error('Trigger creation failed');
    const client = createMockWriteClient({ postTriggerError: triggerError });

    await assert.rejects(
      () => createWorkflow(client, {
        name: 'Fail Trigger',
        triggers: [{ type: 'form_submission', name: 'Form' }],
      }),
      (err) => {
        assert.equal(err.message, 'Trigger creation failed');
        return true;
      },
    );

    // Should have attempted DELETE cleanup
    assert.equal(client._calls.delete.length, 1, 'should attempt cleanup DELETE');
    assert.ok(client._calls.delete[0].path.includes('new-workflow-id'));
  });

  it('includes both errors when trigger failure AND cleanup fails (D-07)', async () => {
    const triggerError = new Error('Trigger creation failed');
    const deleteError = new Error('Delete also failed');
    const client = createMockWriteClient({
      postTriggerError: triggerError,
      deleteError,
    });

    await assert.rejects(
      () => createWorkflow(client, {
        name: 'Double Fail',
        triggers: [{ type: 'form_submission', name: 'Form' }],
      }),
      (err) => {
        assert.ok(err.message.includes('Trigger creation failed'));
        assert.ok(err.message.includes('cleanup also failed'));
        assert.ok(err.message.includes('Delete also failed'));
        return true;
      },
    );
  });

  it('attempts DELETE cleanup on save (Step 3) failure (D-07)', async () => {
    const saveError = new Error('Save failed');
    const client = createMockWriteClient({ putError: saveError });

    await assert.rejects(
      () => createWorkflow(client, { name: 'Fail Save' }),
      (err) => {
        assert.equal(err.message, 'Save failed');
        return true;
      },
    );

    // Should have attempted DELETE cleanup
    assert.equal(client._calls.delete.length, 1, 'should attempt cleanup DELETE');
    assert.ok(client._calls.delete[0].path.includes('new-workflow-id'));
  });

  it('calls correct API paths for all 3 steps', async () => {
    const triggers = [{ type: 'form_submission', name: 'Form' }];
    const actions = [{ type: 'wait', name: 'Wait', attributes: {} }];
    const client = createMockWriteClient();
    await createWorkflow(client, { name: 'Paths Test', triggers, actions });

    // Step 1: POST /workflow/{locationId}
    assert.equal(client._calls.post[0].path, '/workflow/test-loc-id');

    // Step 2: POST /workflow/{locationId}/trigger
    assert.equal(client._calls.post[1].path, '/workflow/test-loc-id/trigger');

    // Step 3: PUT /workflow/{locationId}/{workflowId}
    assert.equal(client._calls.put[0].path, '/workflow/test-loc-id/new-workflow-id');
  });

  it('recovers from false 404 on shell POST by probing listWorkflows and returning matched workflow', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockWriteClient({
      postShellError: err404,
      listBefore: { rows: [], count: 0 }, // #76: nothing by this name existed pre-call
      listWorkflowsResponse: {
        rows: [{ _id: 'recovered-id', name: 'Ghosted Workflow', dateAdded: '2026-04-25T10:00:00.000Z' }],
        count: 1,
      },
      getWorkflowResponse: { _id: 'recovered-id', name: 'Ghosted Workflow', status: 'draft', triggers: [] },
    });

    const result = await createWorkflow(client, { name: 'Ghosted Workflow' });

    assert.equal(result._id, 'recovered-id');
    // shellId never got assigned (error fired on Step 1), so DELETE was never a candidate.
    // This test proves the happy-path return from the recovery branch, NOT the skip-cleanup behavior.
    assert.equal(client._calls.delete.length, 0);
    // listWorkflows hit (at least one GET to /workflow/{locId}/list)
    assert.ok(
      client._calls.get.some((c) => c.path.includes('/workflow/test-loc-id/list')),
      'must call listWorkflows during recovery',
    );
  });

  it('rethrows the original 404 when listWorkflows finds no match', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockWriteClient({
      postShellError: err404,
      listWorkflowsResponse: { rows: [], count: 0 },
    });

    await assert.rejects(
      () => createWorkflow(client, { name: 'Truly Failed' }),
      (err) => {
        assert.equal(err, err404, 'must be the SAME error instance — not wrapped');
        assert.equal(err.status, 404);
        assert.equal(err.message, 'Not Found');
        return true;
      },
    );

    // No cleanup attempted because shellId never got assigned (shell POST is what threw)
    assert.equal(client._calls.delete.length, 0);
  });

  it('selects most recently created workflow when multiple matches exist', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockWriteClient({
      postShellError: err404,
      listBefore: { rows: [], count: 0 }, // #76: nothing by this name existed pre-call
      listWorkflowsResponse: {
        rows: [
          { _id: 'older-id', name: 'Dup Name', dateAdded: '2026-04-20T10:00:00.000Z' },
          { _id: 'newest-id', name: 'Dup Name', dateAdded: '2026-04-25T10:00:00.000Z' },
          { _id: 'middle-id', name: 'Dup Name', dateAdded: '2026-04-22T10:00:00.000Z' },
        ],
        count: 3,
      },
      getWorkflowResponse: { _id: 'newest-id', name: 'Dup Name', status: 'draft', triggers: [] },
    });

    const result = await createWorkflow(client, { name: 'Dup Name' });
    assert.equal(result._id, 'newest-id');

    // Verify getWorkflow was called with the newest id by checking the GET path
    assert.ok(
      client._calls.get.some((c) => c.path.includes('/workflow/test-loc-id/newest-id')),
      'must fetch the most recently created match',
    );
  });

  it('skips DELETE cleanup when 404 fires on PUT save and recovery succeeds (shellId IS set)', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockWriteClient({
      putError: err404,  // 404 fires on Step 3, AFTER shell POST assigns shellId
      listBefore: { rows: [], count: 0 }, // #76: nothing by this name existed pre-call
      listWorkflowsResponse: {
        rows: [{ _id: 'recovered-id', name: 'Late 404 Workflow', dateAdded: '2026-04-25T10:00:00.000Z' }],
        count: 1,
      },
      getWorkflowResponse: { _id: 'recovered-id', name: 'Late 404 Workflow', status: 'draft', triggers: [] },
    });

    const result = await createWorkflow(client, { name: 'Late 404 Workflow' });

    // Recovery returned the matched workflow
    assert.equal(result._id, 'recovered-id');

    // Prove the shell POST DID happen (so shellId was assigned in the closure)
    assert.ok(client._calls.post.length >= 1, 'shell POST must have run before the 404 on PUT');
    assert.equal(
      client._calls.post[0].path,
      '/workflow/test-loc-id',
      'first POST must be the shell-creation call',
    );

    // CRITICAL: prove the recovery branch's early `return` skipped the cleanup DELETE
    // even though shellId WAS set. This is the assertion that distinguishes
    // "recovery works" from "recovery is trivially exercised".
    assert.equal(
      client._calls.delete.length,
      0,
      'must NOT call DELETE — recovery `return` must short-circuit cleanup of the actually-created shell',
    );

    // listWorkflows was called during recovery
    assert.ok(
      client._calls.get.some((c) => c.path.includes('/workflow/test-loc-id/list')),
      'must call listWorkflows during recovery',
    );
  });

  it('rethrows the original 404 when listWorkflows itself throws during recovery', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const probeErr = new Error('list endpoint exploded');
    const client = createMockWriteClient({
      postShellError: err404,
      listWorkflowsError: probeErr,
    });

    await assert.rejects(
      () => createWorkflow(client, { name: 'Probe Failure Case' }),
      (err) => {
        // The ORIGINAL 404 must propagate, NOT the probe error.
        assert.equal(err, err404, 'must rethrow the original 404, not the probe failure');
        assert.equal(err.status, 404);
        // #76: list is unavailable, so the call cannot prove nothing was
        // created. It must say so rather than imply a clean failure.
        assert.match(err.message, /^Not Found \(could not confirm whether a workflow named "Probe Failure Case" was created/);
        return true;
      },
    );

    // shellId never assigned (error fired on Step 1), so no DELETE expected
    assert.equal(client._calls.delete.length, 0);
    // listWorkflows WAS attempted
    assert.ok(
      client._calls.get.some((c) => c.path.includes('/workflow/test-loc-id/list')),
      'must have attempted listWorkflows before its mock threw',
    );
  });

  it('honors caller-supplied settings (regression: VRX — expose workflow settings on create)', async () => {
    const client = createMockWriteClient();
    await createWorkflow(client, {
      name: 'Settings Test',
      stopOnResponse: true,
      allowMultiple: false,
      allowMultipleOpportunity: false,
      removeContactFromLastStep: false,
      autoMarkAsRead: true,
      timezone: 'America/Chicago',
    });

    // Save PUT body should reflect the supplied settings
    const savePut = client._calls.put[0];
    assert.ok(savePut, 'expected a save PUT call');
    assert.equal(savePut.body.stopOnResponse, true);
    assert.equal(savePut.body.allowMultiple, false);
    assert.equal(savePut.body.allowMultipleOpportunity, false);
    assert.equal(savePut.body.removeContactFromLastStep, false);
    assert.equal(savePut.body.autoMarkAsRead, true);
    assert.equal(savePut.body.timezone, 'America/Chicago');

    // Shell POST body should also reflect the four settings present in the shell payload
    // (removeContactFromLastStep is NOT in the shell payload)
    const shellPost = client._calls.post[0];
    assert.ok(shellPost, 'expected a shell POST call');
    assert.equal(shellPost.body.stopOnResponse, true);
    assert.equal(shellPost.body.allowMultiple, false);
    assert.equal(shellPost.body.allowMultipleOpportunity, false);
    assert.equal(shellPost.body.autoMarkAsRead, true);
    assert.equal(shellPost.body.timezone, 'America/Chicago');
  });
});

// Mock current workflow for update/delete/publish tests
const mockCurrentWorkflow = {
  _id: 'wf-existing',
  name: 'Old Name',
  status: 'draft',
  workflowData: {
    templates: [
      { id: 'action-1', order: 0, type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' }, next: 'action-2' },
      { id: 'action-2', order: 1, type: 'wait', name: 'Wait', attributes: { duration: 300 } },
    ],
  },
  triggers: [{ type: 'form_submission', id: 'trig-1', conditions: [] }],
};

/**
 * Create a mock client that returns mockCurrentWorkflow for GET calls.
 * Supports the same error injection as createMockWriteClient.
 *
 * 260426-lf7: trigger HTTP routing — POSTs to /workflow/{loc}/trigger
 * return { id: 'tr-new-N' }; PUTs and DELETEs on /trigger paths honor
 * options.triggerError (Error to throw) so partial-failure tests can
 * configure a controlled break. options.currentTriggers overrides the
 * triggers list returned by getWorkflow inside updateWorkflow.
 */
function createMockUpdateClient(options = {}) {
  const calls = { post: [], put: [], delete: [], get: [] };
  let detailGetCount = 0;
  let triggerPostCount = 0;
  // Allow tests to override the triggers GHL would return for the workflow.
  const currentTriggers = options.currentTriggers ?? mockCurrentWorkflow.triggers;

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
      // 260426-lf7: trigger POSTs (path matches /workflow/{loc}/trigger exactly,
      // NOT /workflow/{loc}/trigger/{id}) get a fresh id back.
      if (/\/workflow\/[^/]+\/trigger$/.test(path)) {
        if (options.triggerError) throw options.triggerError;
        triggerPostCount += 1;
        return { id: `tr-new-${triggerPostCount}` };
      }
      return {};
    }),
    put: mock.fn(async (path, body) => {
      calls.put.push({ path, body });
      // 260426-lf7: trigger PUTs (path matches /workflow/{loc}/trigger/{id}).
      if (/\/workflow\/[^/]+\/trigger\/[^/]+$/.test(path)) {
        if (options.triggerError) throw options.triggerError;
        return {};
      }
      if (options.putError) throw options.putError;
      return {};
    }),
    delete: mock.fn(async (path) => {
      calls.delete.push({ path });
      // 260426-lf7: trigger DELETEs (path matches /workflow/{loc}/trigger/{id}).
      if (/\/workflow\/[^/]+\/trigger\/[^/]+$/.test(path)) {
        if (options.triggerError) throw options.triggerError;
        return {};
      }
      if (options.deleteError) throw options.deleteError;
      return {};
    }),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      // getWorkflow calls detail + triggers in parallel
      const isTrigger = path.includes('/trigger?');
      if (!isTrigger) {
        detailGetCount += 1;
        // detailGetCount === 1 → pre-delete name fetch (existing behavior)
        // detailGetCount >= 2 → post-delete probe
        if (detailGetCount >= 2) {
          if (options.probeError) throw options.probeError;
          if (options.probeResponse) return options.probeResponse;
          // Default: behave like a workflow that still exists
          return { ...mockCurrentWorkflow, triggers: undefined };
        }
      } else {
        // Trigger GET. If we're past pre-delete AND probeError is set,
        // throw the same probeError so the parallel Promise.all in
        // getWorkflow rejects regardless of which leg loses the race.
        if (detailGetCount >= 2 && options.probeError) {
          throw options.probeError;
        }
      }
      if (isTrigger) {
        return { triggers: currentTriggers };
      }
      return { ...mockCurrentWorkflow, triggers: undefined };
    }),
    _calls: calls,
  };
}

describe('updateWorkflow', () => {
  it('updates name only — fetches current, merges name, PUTs full payload (D-08)', async () => {
    const client = createMockUpdateClient();
    const result = await updateWorkflow(client, 'wf-existing', { name: 'New Name' });

    // Should PUT with new name but existing actions
    assert.equal(client._calls.put.length, 1);
    const putBody = client._calls.put[0].body;
    assert.equal(putBody.name, 'New Name');
    assert.equal(putBody.status, 'draft');
    assert.equal(putBody.workflowData.templates.length, 2);
    // Should return full workflow via getWorkflow
    assert.equal(result._id, 'wf-existing');
  });

  it('updates status only — merges status into PUT payload (D-08)', async () => {
    const client = createMockUpdateClient();
    await updateWorkflow(client, 'wf-existing', { status: 'published' });

    const putBody = client._calls.put[0].body;
    assert.equal(putBody.status, 'published');
    assert.equal(putBody.name, 'Old Name');
  });

  it('updates actions — calls diffAndWireActions with createdSteps/modifiedSteps/deletedSteps (D-09, D-10)', async () => {
    const client = createMockUpdateClient();
    const newActions = [
      { type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' }, id: 'action-1' },
      { type: 'add_notes', name: 'Notes', attributes: { note: 'hello' } }, // new action, no id
    ];
    await updateWorkflow(client, 'wf-existing', { actions: newActions });

    const putBody = client._calls.put[0].body;
    assert.equal(putBody.workflowData.templates.length, 2);
    assert.equal(putBody.createdSteps.length, 1, 'new action should be in createdSteps');
    assert.ok(putBody.deletedSteps.includes('action-2'), 'removed action-2 should be in deletedSteps');
  });

  it('preserves existing action IDs and generates new UUIDs for new actions (D-09)', async () => {
    const client = createMockUpdateClient();
    const newActions = [
      { type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' }, id: 'action-1' },
      { type: 'wait', name: 'Wait', attributes: { duration: 300 }, id: 'action-2' },
      { type: 'add_notes', name: 'New Note', attributes: {} },
    ];
    await updateWorkflow(client, 'wf-existing', { actions: newActions });

    const putBody = client._calls.put[0].body;
    const templates = putBody.workflowData.templates;
    assert.equal(templates[0].id, 'action-1', 'existing ID preserved');
    assert.equal(templates[1].id, 'action-2', 'existing ID preserved');
    assert.notEqual(templates[2].id, undefined, 'new action gets UUID');
    assert.notEqual(templates[2].id, 'action-1');
    assert.notEqual(templates[2].id, 'action-2');
    assert.equal(putBody.createdSteps.length, 1);
    assert.equal(putBody.deletedSteps.length, 0);
  });

  it('includes old IDs in deletedSteps when actions are removed (D-10)', async () => {
    const client = createMockUpdateClient();
    // Only keep first action, remove second
    const newActions = [
      { type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' }, id: 'action-1' },
    ];
    await updateWorkflow(client, 'wf-existing', { actions: newActions });

    const putBody = client._calls.put[0].body;
    assert.deepEqual(putBody.deletedSteps, ['action-2']);
    assert.equal(putBody.workflowData.templates.length, 1);
  });

  it('returns full workflow via getWorkflow on success (D-11)', async () => {
    const client = createMockUpdateClient();
    const result = await updateWorkflow(client, 'wf-existing', { name: 'Updated' });

    // getWorkflow is called twice: once to fetch current state, once to return result
    // Each getWorkflow call does 2 GETs (detail + triggers) = 4 total
    assert.ok(client._calls.get.length >= 4, 'should call getWorkflow twice (fetch + return)');
    assert.equal(result._id, 'wf-existing');
  });

  it('preserves current settings when changes object does not include them (regression: VRX — settings clobbering)', async () => {
    // Augment mockCurrentWorkflow with non-default settings
    const currentWithSettings = {
      ...mockCurrentWorkflow,
      stopOnResponse: true,
      allowMultiple: false,
      allowMultipleOpportunity: false,
      removeContactFromLastStep: false,
      autoMarkAsRead: true,
      timezone: 'America/Los_Angeles',
    };
    const client = createMockUpdateClient();
    // Override the GET response for this test only
    client.get = mock.fn(async (path) => {
      client._calls.get.push({ path });
      if (path.includes('/trigger?')) {
        return { triggers: currentWithSettings.triggers };
      }
      return { ...currentWithSettings, triggers: undefined };
    });

    await updateWorkflow(client, 'wf-existing', { name: 'Renamed' });

    const putBody = client._calls.put[0].body;
    assert.equal(putBody.stopOnResponse, true,             'stopOnResponse preserved from current');
    assert.equal(putBody.allowMultiple, false,             'allowMultiple preserved from current');
    assert.equal(putBody.allowMultipleOpportunity, false,  'allowMultipleOpportunity preserved from current');
    assert.equal(putBody.removeContactFromLastStep, false, 'removeContactFromLastStep preserved from current');
    assert.equal(putBody.autoMarkAsRead, true,             'autoMarkAsRead preserved from current');
    assert.equal(putBody.timezone, 'America/Los_Angeles',  'timezone preserved from current');
  });

  it('honors explicit changes.<setting> overrides over current state (override > current > default)', async () => {
    // mockCurrentWorkflow has no settings → current tier yields undefined → default tier applies UNLESS changes provides a value
    const client = createMockUpdateClient();
    await updateWorkflow(client, 'wf-existing', {
      stopOnResponse: true,
      allowMultiple: false,
      timezone: 'UTC',
    });

    const putBody = client._calls.put[0].body;
    assert.equal(putBody.stopOnResponse, true, 'changes.stopOnResponse wins');
    assert.equal(putBody.allowMultiple, false, 'changes.allowMultiple wins');
    assert.equal(putBody.timezone, 'UTC',      'changes.timezone wins');
    // Unset fields fall through to hardcoded defaults (current also has none):
    assert.equal(putBody.allowMultipleOpportunity, true);
    assert.equal(putBody.removeContactFromLastStep, true);
    assert.equal(putBody.autoMarkAsRead, false);
  });

  // -------------------------------------------------------------------------
  // 260426-lf7: trigger CRUD via update_workflow.triggers[]
  // -------------------------------------------------------------------------

  it('create-via-update — adds a trigger when changes.triggers includes one with no id', async () => {
    // Start with no current triggers
    const client = createMockUpdateClient({ currentTriggers: [] });
    await updateWorkflow(client, 'wf-existing', {
      triggers: [{ type: 'form_submission', name: 'Form', conditions: [] }],
    });

    // 1 POST /workflow/{loc}/trigger; 1 PUT save (Step-3)
    const triggerPosts = client._calls.post.filter(c => /\/trigger$/.test(c.path));
    assert.equal(triggerPosts.length, 1, 'expected exactly 1 trigger POST');
    assert.equal(triggerPosts[0].path, '/workflow/test-loc-id/trigger');
    assert.equal(client._calls.put.length, 1, 'expected exactly 1 save PUT');
    assert.equal(client._calls.put[0].path, '/workflow/test-loc-id/wf-existing');

    const savePut = client._calls.put[0];
    assert.equal(savePut.body.triggersChanged, true);
    assert.equal(savePut.body.newTriggers.length, 1);
    assert.equal(savePut.body.newTriggers[0].id, 'tr-new-1');
  });

  it('update existing trigger — issues 1 PUT /trigger/{id} then 1 PUT save', async () => {
    const client = createMockUpdateClient({
      currentTriggers: [
        { id: 'tr1', type: 'form_submission', name: 'Old', conditions: [], masterType: 'highlevel' },
      ],
    });

    await updateWorkflow(client, 'wf-existing', {
      triggers: [{
        id: 'tr1',
        type: 'form_submission',
        name: 'New',
        conditions: [{ field: 'email', operator: '==', value: 'x@y.com' }],
      }],
    });

    // PUT /workflow/{loc}/trigger/tr1
    const triggerPuts = client._calls.put.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    assert.equal(triggerPuts.length, 1);
    assert.equal(triggerPuts[0].path, '/workflow/test-loc-id/trigger/tr1');
    // Conditions normalized: == → is-any-of
    assert.equal(triggerPuts[0].body.conditions[0].operator, 'is-any-of');
    assert.deepEqual(triggerPuts[0].body.conditions[0].value, ['x@y.com']);
    assert.equal(triggerPuts[0].body.id, 'tr1', 'PUT body must include trigger id');

    // 1 save PUT (the Step-3) AFTER the trigger PUT
    const savePuts = client._calls.put.filter(c => /\/wf-existing$/.test(c.path));
    assert.equal(savePuts.length, 1);
    assert.equal(savePuts[0].body.triggersChanged, true);
  });

  it('delete trigger — empty triggers array DELETEs all current triggers then PUTs save', async () => {
    const client = createMockUpdateClient({
      currentTriggers: [{ id: 'tr1', type: 'form_submission', name: 'A', conditions: [] }],
    });

    await updateWorkflow(client, 'wf-existing', { triggers: [] });

    const triggerDeletes = client._calls.delete.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    assert.equal(triggerDeletes.length, 1);
    assert.equal(triggerDeletes[0].path, '/workflow/test-loc-id/trigger/tr1');
    // Save PUT issued
    const savePuts = client._calls.put.filter(c => /\/wf-existing$/.test(c.path));
    assert.equal(savePuts.length, 1);
    assert.equal(savePuts[0].body.triggersChanged, true);
    assert.deepEqual(savePuts[0].body.newTriggers, []);
  });

  it('mixed CRUD — deletes + updates + creates in sequence then saves', async () => {
    const client = createMockUpdateClient({
      currentTriggers: [
        { id: 'tr1', type: 'form_submission', name: 'Tr1', conditions: [], masterType: 'highlevel' },
        { id: 'tr2', type: 'contact_tag', name: 'Tr2', conditions: [], masterType: 'highlevel' },
      ],
    });

    await updateWorkflow(client, 'wf-existing', {
      triggers: [
        { id: 'tr1', type: 'form_submission', name: 'Tr1 Updated', conditions: [], masterType: 'highlevel' },
        { type: 'birthday', name: 'Brand New', conditions: [] },
      ],
    });

    // 1 DELETE for tr2
    const triggerDeletes = client._calls.delete.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    assert.equal(triggerDeletes.length, 1);
    assert.equal(triggerDeletes[0].path, '/workflow/test-loc-id/trigger/tr2');

    // 1 PUT for tr1
    const triggerPuts = client._calls.put.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    assert.equal(triggerPuts.length, 1);
    assert.equal(triggerPuts[0].path, '/workflow/test-loc-id/trigger/tr1');

    // 1 POST for the new trigger
    const triggerPosts = client._calls.post.filter(c => /\/trigger$/.test(c.path));
    assert.equal(triggerPosts.length, 1);

    // Save PUT issued AFTER all trigger calls
    const savePuts = client._calls.put.filter(c => /\/wf-existing$/.test(c.path));
    assert.equal(savePuts.length, 1);
    assert.equal(savePuts[0].body.triggersChanged, true);
    assert.equal(savePuts[0].body.newTriggers.length, 2, 'finalTriggers = updates + creates');
  });

  it('no-op (omitted) — no trigger HTTP, save body has triggersChanged:false', async () => {
    const client = createMockUpdateClient();
    await updateWorkflow(client, 'wf-existing', { name: 'Renamed' });

    // Zero trigger HTTP calls
    const triggerPosts = client._calls.post.filter(c => /\/trigger$/.test(c.path));
    const triggerPuts  = client._calls.put.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    const triggerDels  = client._calls.delete.filter(c => /\/trigger\/[^/]+$/.test(c.path));
    assert.equal(triggerPosts.length, 0);
    assert.equal(triggerPuts.length, 0);
    assert.equal(triggerDels.length, 0);

    const savePut = client._calls.put.filter(c => /\/wf-existing$/.test(c.path))[0];
    assert.ok(savePut);
    assert.equal(savePut.body.triggersChanged, false);
  });

  it('partial-failure — trigger PUT throws → no save PUT issued, error names succeeded+failed', async () => {
    const triggerErr = Object.assign(new Error('trigger update boom'), { status: 500 });
    const client = createMockUpdateClient({
      currentTriggers: [
        { id: 'trA', type: 'form_submission', name: 'A', conditions: [], masterType: 'highlevel' },
        { id: 'trB', type: 'contact_tag', name: 'B', conditions: [], masterType: 'highlevel' },
      ],
      triggerError: triggerErr,
    });

    await assert.rejects(
      () => updateWorkflow(client, 'wf-existing', {
        triggers: [
          // Empty array would delete both — to exercise update path, supply a different shape for trA
          { id: 'trA', type: 'form_submission', name: 'A renamed', conditions: [], masterType: 'highlevel' },
        ],
      }),
      (err) => {
        // Error message must mention what failed and succeeded
        assert.ok(/trigger/i.test(err.message), `expected trigger context, got: ${err.message}`);
        assert.ok(/succeeded|failed/i.test(err.message), 'message should reference success/failure markers');
        return true;
      },
    );

    // CRITICAL: no save PUT for this workflow
    const savePuts = client._calls.put.filter(c => /\/wf-existing$/.test(c.path));
    assert.equal(savePuts.length, 0, 'must NOT issue Step-3 save when a trigger op failed');
  });
});

describe('deleteWorkflow', () => {
  it('fetches workflow name before deleting (D-14)', async () => {
    const client = createMockUpdateClient();
    await deleteWorkflow(client, 'wf-existing');

    // getWorkflow called first (2 GETs), then DELETE
    assert.ok(client._calls.get.length >= 2, 'should fetch workflow before delete');
    assert.equal(client._calls.delete.length, 1);
    // GET happened before DELETE
    assert.ok(client._calls.get[0].path.includes('wf-existing'));
  });

  it('calls DELETE /workflow/{locationId}/{workflowId} (D-12)', async () => {
    const client = createMockUpdateClient();
    await deleteWorkflow(client, 'wf-existing');

    assert.equal(client._calls.delete[0].path, '/workflow/test-loc-id/wf-existing');
  });

  it('returns { status: "deleted", workflowId, name } (D-14)', async () => {
    const client = createMockUpdateClient();
    const result = await deleteWorkflow(client, 'wf-existing');

    assert.deepEqual(result, {
      status: 'deleted',
      workflowId: 'wf-existing',
      name: 'Old Name',
    });
  });

  it('recovers from false 5xx on delete by probing getWorkflow and returning success when probe 404s', async () => {
    const err502 = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockUpdateClient({
      deleteError: err502,
      probeError: err404,
    });

    const result = await deleteWorkflow(client, 'wf-existing');

    assert.deepEqual(result, {
      status: 'deleted',
      workflowId: 'wf-existing',
      name: 'Old Name',
    });
    // DELETE was attempted exactly once
    assert.equal(client._calls.delete.length, 1);
    // getWorkflow called twice: pre-delete name fetch + post-delete probe
    const detailGets = client._calls.get.filter((c) => !c.path.includes('/trigger?'));
    assert.equal(detailGets.length, 2, 'expected 2 detail GETs: pre-delete + probe');
  });

  it('rethrows the original 5xx by reference when the probe finds the workflow still present', async () => {
    const err502 = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const client = createMockUpdateClient({
      deleteError: err502,
      probeResponse: {
        _id: 'wf-existing',
        name: 'Old Name',
        status: 'draft',
        triggers: [],
        workflowData: { templates: [] },
      },
    });

    await assert.rejects(
      () => deleteWorkflow(client, 'wf-existing'),
      (err) => {
        assert.equal(err, err502, 'must rethrow the original 502 by reference, not wrap');
        assert.equal(err.status, 502);
        assert.equal(err.message, 'Bad Gateway');
        return true;
      },
    );
    // DELETE attempted, probe ran (2 detail GETs total)
    assert.equal(client._calls.delete.length, 1);
    const detailGets = client._calls.get.filter((c) => !c.path.includes('/trigger?'));
    assert.equal(detailGets.length, 2, 'expected pre-delete + probe detail GETs');
  });

  it('does not probe and rethrows unchanged when delete itself returns 4xx (e.g. 404)', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const client = createMockUpdateClient({
      deleteError: err404,
    });

    await assert.rejects(
      () => deleteWorkflow(client, 'wf-existing'),
      (err) => {
        assert.equal(err, err404, 'must rethrow the original 404 by reference');
        assert.equal(err.status, 404);
        return true;
      },
    );
    // DELETE attempted once
    assert.equal(client._calls.delete.length, 1);
    // CRITICAL: getWorkflow called ONLY for pre-delete name fetch (NO probe)
    // Pre-delete getWorkflow = 1 detail GET + 1 trigger GET = exactly 2 GETs total
    assert.equal(client._calls.get.length, 2, 'must NOT probe — only pre-delete name fetch');
    const detailGets = client._calls.get.filter((c) => !c.path.includes('/trigger?'));
    assert.equal(detailGets.length, 1, 'exactly 1 detail GET (pre-delete only, no probe)');
  });

  it('rethrows the original 5xx by reference and logs warn when the probe itself fails (non-404)', async () => {
    const err502 = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const err503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const client = createMockUpdateClient({
      deleteError: err502,
      probeError: err503,
    });

    const { logger } = await import('../utils/logger.js');
    const originalWarn = logger.warn;
    const warnCalls = [];
    logger.warn = (...args) => { warnCalls.push(args); };
    try {
      await assert.rejects(
        () => deleteWorkflow(client, 'wf-existing'),
        (err) => {
          assert.equal(err, err502, 'must rethrow the ORIGINAL 502 by reference, not the 503 probe error');
          assert.equal(err.status, 502);
          assert.equal(err.message, 'Bad Gateway');
          return true;
        },
      );
      // A warn was logged about the probe failure
      assert.ok(
        warnCalls.some((args) => String(args[0] ?? '').includes('probe failed')),
        'must log warn about probe failure',
      );
    } finally {
      logger.warn = originalWarn;
    }

    // DELETE attempted, probe ran
    assert.equal(client._calls.delete.length, 1);
    const detailGets = client._calls.get.filter((c) => !c.path.includes('/trigger?'));
    assert.equal(detailGets.length, 2, 'expected pre-delete + probe detail GETs');
  });
});

describe('publishWorkflow', () => {
  it('PUTs with status "published" and returns full workflow (D-15)', async () => {
    const client = createMockUpdateClient();
    const result = await publishWorkflow(client, 'wf-existing');

    // Should PUT with published status
    assert.equal(client._calls.put.length, 1);
    const putBody = client._calls.put[0].body;
    assert.equal(putBody.status, 'published');
    assert.equal(result._id, 'wf-existing');
  });

  it('calls getWorkflow to get current state before updating (D-15)', async () => {
    const client = createMockUpdateClient();
    await publishWorkflow(client, 'wf-existing');

    // getWorkflow called at least once to fetch current state
    assert.ok(client._calls.get.length >= 2, 'should fetch current workflow state');
  });
});

/**
 * Create a mock client for clone operations.
 * Handles the two-phase getWorkflow pattern:
 * - First pair of GETs: source workflow (for name lookup)
 * - POST: duplicate endpoint returns { id }
 * - Second pair of GETs: cloned workflow (for return value)
 */
function createMockCloneClient(options = {}) {
  const calls = { post: [], put: [], delete: [], get: [] };
  let getCallCount = 0;

  const sourceWorkflow = options.sourceWorkflow || {
    _id: 'source-wf-id',
    name: 'Original Workflow',
    status: 'draft',
    triggers: [],
    workflowData: { templates: [] },
  };

  const clonedWorkflow = options.clonedWorkflow || {
    _id: 'cloned-wf-id',
    name: 'Copy - Original Workflow',
    status: 'draft',
    triggers: [],
    workflowData: { templates: [] },
  };

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
      return { id: 'cloned-wf-id' };
    }),
    put: mock.fn(async () => ({})),
    delete: mock.fn(async () => ({})),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      if (options.getError && getCallCount === 0) {
        getCallCount++;
        throw options.getError;
      }
      getCallCount++;
      // getWorkflow does 2 GETs per call (detail + triggers)
      // GETs 1-2: source workflow, GETs 3-4: cloned workflow
      if (path.includes('/trigger?')) {
        // Trigger endpoint — return triggers from appropriate workflow
        return { triggers: [] };
      }
      // Detail endpoint — return source for first call, clone for second
      if (getCallCount <= 2) {
        return { ...sourceWorkflow, triggers: undefined };
      }
      return { ...clonedWorkflow, triggers: undefined };
    }),
    _calls: calls,
  };
}

describe('cloneWorkflow', () => {
  it('clones with default name "Copy - {source name}" when no custom name given', async () => {
    const client = createMockCloneClient();
    const result = await cloneWorkflow(client, 'source-wf-id');

    // Should POST to duplicate endpoint
    assert.equal(client._calls.post.length, 1);
    const postBody = client._calls.post[0].body;
    assert.equal(postBody.new_workflow_name, 'Copy - Original Workflow');
    assert.equal(postBody.workflow_id, 'source-wf-id');

    // Should return full cloned workflow
    assert.equal(result._id, 'cloned-wf-id');
  });

  it('uses custom name when provided instead of default', async () => {
    const client = createMockCloneClient();
    await cloneWorkflow(client, 'source-wf-id', { name: 'My Custom Clone' });

    const postBody = client._calls.post[0].body;
    assert.equal(postBody.new_workflow_name, 'My Custom Clone');
  });

  it('calls apiClient.post with correct path and body shape', async () => {
    const client = createMockCloneClient();
    await cloneWorkflow(client, 'source-wf-id');

    assert.equal(client._calls.post[0].path, '/workflow/test-loc-id');
    const postBody = client._calls.post[0].body;
    assert.equal(postBody.new_workflow_name, 'Copy - Original Workflow');
    assert.equal(postBody.workflow_id, 'source-wf-id');
    assert.equal(postBody.parentId, null); // source has no parentId → clone lands in root
    assert.equal(postBody.company_id, 'test-company');
    assert.equal(postBody.company_age, 59);
  });

  it('inherits source.parentId so clone lands in the same folder (regression: TK7)', async () => {
    const sourceWithFolder = {
      _id: 'source-wf-id',
      name: 'Original Workflow',
      status: 'draft',
      triggers: [],
      workflowData: { templates: [] },
      parentId: 'folder-xyz',
    };
    const client = createMockCloneClient({ sourceWorkflow: sourceWithFolder });
    await cloneWorkflow(client, 'source-wf-id');

    const postBody = client._calls.post[0].body;
    assert.equal(postBody.parentId, 'folder-xyz', 'clone should inherit source folder');
  });

  it('propagates errors from getWorkflow (source not found) without POST', async () => {
    const sourceError = new Error('Workflow not found');
    const client = createMockCloneClient({ getError: sourceError });

    await assert.rejects(
      () => cloneWorkflow(client, 'nonexistent-id'),
      (err) => {
        assert.equal(err.message, 'Workflow not found');
        return true;
      },
    );

    // Should NOT have attempted the POST
    assert.equal(client._calls.post.length, 0, 'should not POST when source fetch fails');
  });

  it('propagates errors from the duplicate POST', async () => {
    const postError = new Error('Duplicate endpoint failed');
    const client = createMockCloneClient({ postError });

    await assert.rejects(
      () => cloneWorkflow(client, 'source-wf-id'),
      (err) => {
        assert.equal(err.message, 'Duplicate endpoint failed');
        return true;
      },
    );
  });
});

// === Tag Dependency Resolution Tests ===

describe('createWorkflow — no orphans on failure (#76)', () => {
  it('deletes a workflow GHL created even though the shell POST returned an error', async () => {
    // GHL stored the shell, then answered 422 — so shellId is never known.
    const err422 = Object.assign(new Error('Validation failed'), { status: 422 });
    const client = createMockWriteClient({
      postShellError: err422,
      listBefore: { rows: [{ _id: 'pre-existing', name: 'Other WF' }], count: 1 },
      listWorkflowsResponse: {
        rows: [{ _id: 'pre-existing', name: 'Other WF' }, { _id: 'ghost-id', name: 'Lead Response' }],
        count: 2,
      },
    });

    await assert.rejects(
      () => createWorkflow(client, { name: 'Lead Response' }),
      (err) => {
        assert.match(err.message, /Validation failed/);
        assert.match(err.message, /ghost-id/, 'error must name the orphan it removed');
        return true;
      },
    );
    assert.deepEqual(
      client._calls.delete.map((d) => d.path),
      ['/workflow/test-loc-id/ghost-id'],
      'must delete exactly the workflow this call created — nothing pre-existing',
    );
  });

  it('never deletes a same-named workflow that existed before the call', async () => {
    const err422 = Object.assign(new Error('Validation failed'), { status: 422 });
    const same = { rows: [{ _id: 'clients-real-one', name: 'Lead Response' }], count: 1 };
    const client = createMockWriteClient({ postShellError: err422, listBefore: same, listWorkflowsResponse: same });

    await assert.rejects(() => createWorkflow(client, { name: 'Lead Response' }));
    assert.equal(client._calls.delete.length, 0, 'pre-existing workflow must never be deleted');
  });

  it('names a surviving orphan in the error when its cleanup DELETE fails', async () => {
    const err422 = Object.assign(new Error('Validation failed'), { status: 422 });
    const client = createMockWriteClient({
      postShellError: err422,
      deleteError: new Error('delete refused'),
      listBefore: { rows: [], count: 0 },
      listWorkflowsResponse: { rows: [{ _id: 'ghost-id', name: 'Lead Response' }], count: 1 },
    });

    await assert.rejects(
      () => createWorkflow(client, { name: 'Lead Response' }),
      (err) => {
        assert.match(err.message, /ghost-id/);
        assert.match(err.message, /delete refused/);
        return true;
      },
    );
  });

  it('404-recovery does not hand back a pre-existing workflow that merely shares the name', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const same = { rows: [{ _id: 'clients-real-one', name: 'Dup' }], count: 1 };
    const client = createMockWriteClient({ postShellError: err404, listBefore: same, listWorkflowsResponse: same });

    await assert.rejects(() => createWorkflow(client, { name: 'Dup' }), (err) => err.status === 404);
    assert.equal(client._calls.delete.length, 0);
  });

  it('warns loudly when a workflow with the same name already exists', async () => {
    const client = createMockWriteClient({
      listBefore: { rows: [{ _id: 'first-attempt', name: 'Lead Response' }], count: 1 },
    });
    const result = await createWorkflow(client, { name: 'Lead Response' });
    assert.ok(result.duplicateNameWarning, 'result must carry duplicateNameWarning');
    assert.deepEqual(result.duplicateNameWarning.existingIds, ['first-attempt']);
  });
});

describe('tag dependency resolution in createWorkflow', () => {
  /**
   * Create a mock client that also tracks listTags and createTag calls
   * via the GET and POST paths used by entities.js functions.
   */
  function createTagAwareClient(options = {}) {
    const calls = { post: [], put: [], delete: [], get: [] };
    const existingTags = options.existingTags || [];
    let shellCreated = false;

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
        if (path.includes('/tags/create')) {
          return { tag: body.tag };
        }
        if (path.includes('/trigger')) {
          return { id: 'trigger-' + calls.post.length };
        }
        // Shell creation
        shellCreated = true;
        return { _id: 'new-workflow-id', name: body.name || 'test' };
      }),
      put: mock.fn(async (path, body) => {
        calls.put.push({ path, body });
        return {};
      }),
      delete: mock.fn(async (path) => {
        calls.delete.push({ path });
        return {};
      }),
      get: mock.fn(async (path) => {
        calls.get.push({ path });
        if (path.includes('/locations/') && path.includes('/tags')) {
          return { tags: existingTags };
        }
        if (path.includes('/trigger?')) {
          return { triggers: [] };
        }
        return {
          _id: 'new-workflow-id',
          name: 'Test Workflow',
          status: 'draft',
          triggers: [],
          workflowData: { templates: [] },
        };
      }),
      _calls: calls,
    };
  }

  it('does not call listTags when workflow has no tag-related actions', async () => {
    const client = createTagAwareClient();
    const actions = [
      { type: 'assign_user', name: 'Assign', attributes: { userId: 'u1' } },
    ];
    await createWorkflow(client, { name: 'No Tags', actions });

    // listTags is a GET to /locations/{locationId}/tags
    const tagGets = client._calls.get.filter(c => c.path.includes('/locations/') && c.path.includes('/tags'));
    assert.equal(tagGets.length, 0, 'should NOT call listTags when no tags referenced');
  });

  it('does not call createTag when all referenced tags already exist', async () => {
    const client = createTagAwareClient({
      existingTags: [
        { id: 'tag-1', name: 'VIP', locationId: 'test-loc-id' },
        { id: 'tag-2', name: 'Lead', locationId: 'test-loc-id' },
      ],
    });
    const actions = [
      { type: 'add_contact_tag_tool', name: 'Add Tags', attributes: { tags: ['VIP', 'Lead'] } },
    ];
    await createWorkflow(client, { name: 'Existing Tags', actions });

    // Should call listTags (1 GET) but NOT createTag (no POST to tags/create)
    const tagGets = client._calls.get.filter(c => c.path.includes('/locations/') && c.path.includes('/tags'));
    assert.equal(tagGets.length, 1, 'should call listTags once');
    const tagCreates = client._calls.post.filter(c => c.path.includes('/tags/create'));
    assert.equal(tagCreates.length, 0, 'should NOT create any tags');
  });

  it('creates missing tags and includes autoCreatedTags in response', async () => {
    const client = createTagAwareClient({
      existingTags: [
        { id: 'tag-1', name: 'VIP', locationId: 'test-loc-id' },
      ],
    });
    const actions = [
      { type: 'add_contact_tag_tool', name: 'Add Tags', attributes: { tags: ['VIP', 'NewTag', 'AnotherNew'] } },
    ];
    const result = await createWorkflow(client, { name: 'Missing Tags', actions });

    const tagCreates = client._calls.post.filter(c => c.path.includes('/tags/create'));
    assert.equal(tagCreates.length, 2, 'should create 2 missing tags');
    assert.equal(tagCreates[0].body.tag, 'NewTag');
    assert.equal(tagCreates[1].body.tag, 'AnotherNew');

    // Response should include autoCreatedTags
    assert.deepEqual(result.autoCreatedTags, ['NewTag', 'AnotherNew']);
  });

  it('compares tags case-insensitively (existing "VIP" matches scanned "vip")', async () => {
    const client = createTagAwareClient({
      existingTags: [
        { id: 'tag-1', name: 'VIP', locationId: 'test-loc-id' },
      ],
    });
    const actions = [
      { type: 'add_contact_tag_tool', name: 'Add Tags', attributes: { tags: ['vip'] } },
    ];
    await createWorkflow(client, { name: 'Case Test', actions });

    const tagCreates = client._calls.post.filter(c => c.path.includes('/tags/create'));
    assert.equal(tagCreates.length, 0, 'should NOT create tag when case-insensitive match exists');
  });

  it('catches resolveTagDependencies errors and proceeds with workflow creation', async () => {
    // Create a client where listTags throws an error
    const client = createTagAwareClient();
    // Override the get mock to throw for tag listing
    const originalGet = client.get.mock.implementation;
    client.get = mock.fn(async (path) => {
      client._calls.get.push({ path });
      if (path.includes('/locations/') && path.includes('/tags')) {
        throw new Error('Tag service unavailable');
      }
      if (path.includes('/trigger?')) {
        return { triggers: [] };
      }
      return {
        _id: 'new-workflow-id',
        name: 'Test Workflow',
        status: 'draft',
        triggers: [],
        workflowData: { templates: [] },
      };
    });

    const actions = [
      { type: 'add_contact_tag_tool', name: 'Add Tags', attributes: { tags: ['VIP'] } },
    ];

    // Should NOT throw — error is caught and workflow proceeds
    const result = await createWorkflow(client, { name: 'Error Resilient', actions });
    assert.ok(result._id, 'workflow should be created despite tag resolution failure');
  });

  it('does not include autoCreatedTags in response when no tags were created', async () => {
    const client = createTagAwareClient({
      existingTags: [
        { id: 'tag-1', name: 'VIP', locationId: 'test-loc-id' },
      ],
    });
    const actions = [
      { type: 'add_contact_tag_tool', name: 'Add Tags', attributes: { tags: ['VIP'] } },
    ];
    const result = await createWorkflow(client, { name: 'No New Tags', actions });

    assert.equal(result.autoCreatedTags, undefined, 'should not include autoCreatedTags when empty');
  });
});

describe('tag dependency resolution in updateWorkflow', () => {
  function createTagAwareUpdateClient(options = {}) {
    const calls = { post: [], put: [], delete: [], get: [] };
    const existingTags = options.existingTags || [];
    const currentWorkflow = options.currentWorkflow || {
      _id: 'wf-existing',
      name: 'Old Name',
      status: 'draft',
      workflowData: {
        templates: [
          { id: 'action-1', order: 0, type: 'add_contact_tag_tool', name: 'Add Tag', attributes: { tags: ['ExistingTag'] } },
        ],
      },
      triggers: [],
    };

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
        if (path.includes('/tags/create')) {
          return { tag: body.tag };
        }
        return {};
      }),
      put: mock.fn(async (path, body) => {
        calls.put.push({ path, body });
        return {};
      }),
      delete: mock.fn(async (path) => {
        calls.delete.push({ path });
        return {};
      }),
      get: mock.fn(async (path) => {
        calls.get.push({ path });
        if (path.includes('/locations/') && path.includes('/tags')) {
          return { tags: existingTags };
        }
        if (path.includes('/trigger?')) {
          return { triggers: currentWorkflow.triggers };
        }
        return { ...currentWorkflow, triggers: undefined };
      }),
      _calls: calls,
    };
  }

  it('scans current actions when no action changes provided', async () => {
    const client = createTagAwareUpdateClient({
      existingTags: [],
      currentWorkflow: {
        _id: 'wf-existing',
        name: 'Old Name',
        status: 'draft',
        workflowData: {
          templates: [
            { id: 'action-1', order: 0, type: 'add_contact_tag_tool', name: 'Add Tag', attributes: { tags: ['NeedThis'] } },
          ],
        },
        triggers: [],
      },
    });

    const result = await updateWorkflow(client, 'wf-existing', { name: 'New Name' });

    // Should have called createTag for 'NeedThis'
    const tagCreates = client._calls.post.filter(c => c.path.includes('/tags/create'));
    assert.equal(tagCreates.length, 1, 'should create missing tag from current actions');
    assert.equal(tagCreates[0].body.tag, 'NeedThis');
  });
});

// === Entity Validation Tests ===

describe('entity validation in createWorkflow', () => {
  /**
   * Create a mock client that handles entity list API calls (pipelines, users,
   * custom fields, custom values) in addition to the standard write operations.
   */
  function createEntityAwareClient(options = {}) {
    const calls = { post: [], put: [], delete: [], get: [] };
    const existingTags = options.existingTags || [];
    const pipelines = options.pipelines || [];
    const users = options.users || [];
    const contactFields = options.contactFields || [];
    const oppFields = options.oppFields || [];
    const customValues = options.customValues || [];

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
        if (path.includes('/tags/create')) {
          return { tag: body.tag };
        }
        if (path.includes('/trigger')) {
          return { id: 'trigger-' + calls.post.length };
        }
        return { _id: 'new-workflow-id', name: body.name || 'test' };
      }),
      put: mock.fn(async (path, body) => {
        calls.put.push({ path, body });
        return {};
      }),
      delete: mock.fn(async (path) => {
        calls.delete.push({ path });
        return {};
      }),
      get: mock.fn(async (path) => {
        calls.get.push({ path });
        // Tag listing
        if (path.includes('/locations/') && path.includes('/tags')) {
          return { tags: existingTags };
        }
        // Pipeline listing
        if (path.includes('/opportunities/pipelines')) {
          return { pipelines };
        }
        // User listing
        if (path.includes('/users/search')) {
          return { users, count: users.length };
        }
        // Custom fields - contact search endpoint
        if (path.includes('/customFields/search')) {
          return { customFields: contactFields, totalItems: contactFields.length };
        }
        // Custom fields - opportunity endpoint
        if (path.includes('/customFields?model=opportunity')) {
          return { customFields: oppFields };
        }
        // Custom values
        if (path.includes('/custom-data/conversations')) {
          return { static: [], 'custom-values': customValues };
        }
        // Trigger listing for getWorkflow
        if (path.includes('/trigger?')) {
          return { triggers: [] };
        }
        // Default getWorkflow response
        return {
          _id: 'new-workflow-id',
          name: 'Test Workflow',
          status: 'draft',
          triggers: [],
          workflowData: { templates: [] },
        };
      }),
      _calls: calls,
    };
  }

  it('returns no entityWarnings when workflow has no entity references', async () => {
    const client = createEntityAwareClient();
    const actions = [
      { type: 'wait', name: 'Wait 5m', attributes: { duration: 300 } },
    ];
    const result = await createWorkflow(client, { name: 'No Entities', actions });

    assert.equal(result.entityWarnings, undefined, 'should not include entityWarnings when none exist');
  });

  it('returns no entityWarnings when all pipeline IDs are valid', async () => {
    const client = createEntityAwareClient({
      pipelines: [
        { id: 'pipe-1', name: 'Sales Pipeline', stages: [{ id: 'stage-1', name: 'New' }] },
      ],
    });
    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'pipe-1', pipelineStageId: 'stage-1' },
      },
    ];
    const result = await createWorkflow(client, { name: 'Valid Pipeline', actions });

    assert.equal(result.entityWarnings, undefined, 'should not include entityWarnings when all valid');
  });

  it('returns warning with alternatives for invalid pipeline ID', async () => {
    const client = createEntityAwareClient({
      pipelines: [
        { id: 'pipe-1', name: 'Sales Pipeline', stages: [] },
        { id: 'pipe-2', name: 'Support Pipeline', stages: [] },
      ],
    });
    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'invalid-pipe', pipelineStageId: 'stage-1' },
      },
    ];
    const result = await createWorkflow(client, { name: 'Invalid Pipeline', actions });

    assert.ok(result.entityWarnings, 'should include entityWarnings');
    assert.ok(result.entityWarnings.length >= 1, 'should have at least 1 warning');

    const pipelineWarning = result.entityWarnings.find(w => w.entityType === 'pipeline');
    assert.ok(pipelineWarning, 'should have a pipeline warning');
    assert.equal(pipelineWarning.referencedId, 'invalid-pipe');
    assert.ok(pipelineWarning.validAlternatives.length <= 10, 'alternatives capped at 10');
    assert.ok(pipelineWarning.validAlternatives.length >= 1, 'should have at least 1 alternative');
    // Each alternative has id + name
    assert.ok(pipelineWarning.validAlternatives[0].id, 'alternative should have id');
    assert.ok(pipelineWarning.validAlternatives[0].name, 'alternative should have name');
  });

  it('validates pipeline stage belongs to referenced pipeline (Pitfall 2)', async () => {
    const client = createEntityAwareClient({
      pipelines: [
        { id: 'pipe-1', name: 'Sales', stages: [{ id: 'stage-A', name: 'New' }] },
        { id: 'pipe-2', name: 'Support', stages: [{ id: 'stage-B', name: 'Open' }] },
      ],
    });
    // stage-B belongs to pipe-2, but action references pipe-1
    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'pipe-1', pipelineStageId: 'stage-B' },
      },
    ];
    const result = await createWorkflow(client, { name: 'Wrong Stage', actions });

    assert.ok(result.entityWarnings, 'should include entityWarnings');
    const stageWarning = result.entityWarnings.find(w => w.entityType === 'pipelineStage');
    assert.ok(stageWarning, 'should have a pipelineStage warning');
    assert.equal(stageWarning.referencedId, 'stage-B');
    assert.ok(stageWarning.message.includes('different pipeline'), 'should mention different pipeline');
  });

  it('returns warning with alternatives for invalid user ID', async () => {
    const client = createEntityAwareClient({
      users: [
        { id: 'user-1', firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
        { id: 'user-2', firstName: 'Jane', lastName: 'Smith', email: 'jane@test.com' },
      ],
    });
    const actions = [
      {
        type: 'assign_to_user_tool',
        name: 'Assign User',
        attributes: { userId: 'nonexistent-user' },
      },
    ];
    const result = await createWorkflow(client, { name: 'Invalid User', actions });

    assert.ok(result.entityWarnings, 'should include entityWarnings');
    const userWarning = result.entityWarnings.find(w => w.entityType === 'user');
    assert.ok(userWarning, 'should have a user warning');
    assert.equal(userWarning.referencedId, 'nonexistent-user');
    assert.ok(userWarning.validAlternatives.length >= 1);
    // User alternatives should have name composed from firstName + lastName
    assert.equal(userWarning.validAlternatives[0].name, 'John Doe');
  });

  it('validates custom fields against both id and fieldKey (Pitfall 1)', async () => {
    const client = createEntityAwareClient({
      contactFields: [
        { id: 'cf-1', name: 'Company Size', fieldKey: 'contact.company_size' },
      ],
    });
    const actions = [
      {
        type: 'update_contact_field',
        name: 'Update Field',
        attributes: { fields: [{ field: 'contact.company_size', value: 'large' }] },
      },
    ];
    const result = await createWorkflow(client, { name: 'Valid FieldKey', actions });

    // Should NOT produce a warning because 'contact.company_size' matches the fieldKey
    const cfWarnings = (result.entityWarnings || []).filter(w => w.entityType === 'customField');
    assert.equal(cfWarnings.length, 0, 'should not warn when fieldKey matches');
  });

  it('includes suggestedFix in each warning (D-06)', async () => {
    const client = createEntityAwareClient({
      pipelines: [
        { id: 'pipe-1', name: 'Sales Pipeline', stages: [] },
      ],
    });
    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'bad-pipe' },
      },
    ];
    const result = await createWorkflow(client, { name: 'Suggested Fix', actions });

    assert.ok(result.entityWarnings);
    const warning = result.entityWarnings.find(w => w.entityType === 'pipeline');
    assert.ok(warning.suggestedFix, 'warning should include suggestedFix');
    assert.ok(warning.suggestedFix.includes('update_workflow'), 'suggestedFix should mention update_workflow');
  });

  it('only fetches entity types that are actually referenced (short-circuit)', async () => {
    const client = createEntityAwareClient({
      pipelines: [{ id: 'pipe-1', name: 'Sales', stages: [] }],
      users: [{ id: 'user-1', firstName: 'John', lastName: 'Doe' }],
    });
    // Only pipeline referenced, not users
    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'pipe-1' },
      },
    ];
    await createWorkflow(client, { name: 'Short Circuit', actions });

    // Should have called pipelines endpoint but NOT users endpoint
    const pipelineGets = client._calls.get.filter(c => c.path.includes('/opportunities/pipelines'));
    const userGets = client._calls.get.filter(c => c.path.includes('/users/search'));
    assert.equal(pipelineGets.length, 1, 'should fetch pipelines');
    assert.equal(userGets.length, 0, 'should NOT fetch users when none referenced');
  });

  it('catches entity validation errors and proceeds with workflow creation', async () => {
    const client = createEntityAwareClient();
    // Override get to throw for pipeline listing
    const originalGet = client.get;
    client.get = mock.fn(async (path) => {
      client._calls.get.push({ path });
      if (path.includes('/opportunities/pipelines')) {
        throw new Error('Pipeline service unavailable');
      }
      if (path.includes('/trigger?')) {
        return { triggers: [] };
      }
      return {
        _id: 'new-workflow-id',
        name: 'Test Workflow',
        status: 'draft',
        triggers: [],
        workflowData: { templates: [] },
      };
    });

    const actions = [
      {
        type: 'internal_create_opportunity',
        name: 'Create Opp',
        attributes: { pipelineId: 'pipe-1' },
      },
    ];

    // Should NOT throw — error is caught and workflow proceeds
    const result = await createWorkflow(client, { name: 'Error Resilient Entity', actions });
    assert.ok(result._id, 'workflow should be created despite entity validation failure');
  });
});

describe('entity validation in updateWorkflow', () => {
  function createEntityAwareUpdateClient(options = {}) {
    const calls = { post: [], put: [], delete: [], get: [] };
    const pipelines = options.pipelines || [];
    const users = options.users || [];
    const currentWorkflow = options.currentWorkflow || {
      _id: 'wf-existing',
      name: 'Old Name',
      status: 'draft',
      workflowData: {
        templates: [
          { id: 'action-1', order: 0, type: 'assign_to_user_tool', name: 'Assign', attributes: { userId: 'bad-user' } },
        ],
      },
      triggers: [],
    };

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
        if (path.includes('/tags/create')) return { tag: body.tag };
        return {};
      }),
      put: mock.fn(async (path, body) => {
        calls.put.push({ path, body });
        return {};
      }),
      delete: mock.fn(async (path) => {
        calls.delete.push({ path });
        return {};
      }),
      get: mock.fn(async (path) => {
        calls.get.push({ path });
        if (path.includes('/locations/') && path.includes('/tags')) {
          return { tags: [] };
        }
        if (path.includes('/opportunities/pipelines')) {
          return { pipelines };
        }
        if (path.includes('/users/search')) {
          return { users, count: users.length };
        }
        if (path.includes('/customFields/search')) {
          return { customFields: [], totalItems: 0 };
        }
        if (path.includes('/customFields?model=opportunity')) {
          return { customFields: [] };
        }
        if (path.includes('/custom-data/conversations')) {
          return { static: [], 'custom-values': [] };
        }
        if (path.includes('/trigger?')) {
          return { triggers: currentWorkflow.triggers };
        }
        return { ...currentWorkflow, triggers: undefined };
      }),
      _calls: calls,
    };
  }

  it('attaches entityWarnings to updateWorkflow result for invalid user', async () => {
    const client = createEntityAwareUpdateClient({
      users: [
        { id: 'user-real', firstName: 'Real', lastName: 'User', email: 'real@test.com' },
      ],
    });

    const result = await updateWorkflow(client, 'wf-existing', { name: 'Updated Name' });

    assert.ok(result.entityWarnings, 'should include entityWarnings on update');
    const userWarning = result.entityWarnings.find(w => w.entityType === 'user');
    assert.ok(userWarning, 'should have user warning');
    assert.equal(userWarning.referencedId, 'bad-user');
  });

  it('tag resolution still works alongside entity validation (ENT-05)', async () => {
    const client = createEntityAwareUpdateClient({
      users: [{ id: 'user-real', firstName: 'Real', lastName: 'User' }],
    });
    // Override to have tag-related actions
    client.get = mock.fn(async (path) => {
      client._calls.get.push({ path });
      if (path.includes('/locations/') && path.includes('/tags')) {
        return { tags: [] };
      }
      if (path.includes('/opportunities/pipelines')) return { pipelines: [] };
      if (path.includes('/users/search')) return { users: [{ id: 'user-real', firstName: 'Real', lastName: 'User' }], count: 1 };
      if (path.includes('/customFields/search')) return { customFields: [], totalItems: 0 };
      if (path.includes('/customFields?model=opportunity')) return { customFields: [] };
      if (path.includes('/custom-data/conversations')) return { static: [], 'custom-values': [] };
      if (path.includes('/trigger?')) return { triggers: [] };
      return {
        _id: 'wf-existing',
        name: 'Old Name',
        status: 'draft',
        triggers: undefined,
        workflowData: {
          templates: [
            { id: 'action-1', order: 0, type: 'add_contact_tag_tool', name: 'Add Tag', attributes: { tags: ['NewTag'] } },
          ],
        },
      };
    });

    const result = await updateWorkflow(client, 'wf-existing', { name: 'Tag Test' });

    // Tag should have been created
    const tagCreates = client._calls.post.filter(c => c.path.includes('/tags/create'));
    assert.equal(tagCreates.length, 1, 'tag auto-creation should still work');
    assert.deepEqual(result.autoCreatedTags, ['NewTag']);
  });
});
