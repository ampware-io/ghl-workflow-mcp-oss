/**
 * Plan 18-04 Task 2 — Mock-client integration tests for write-orchestrator.
 *
 * 8 tests across 7 describe blocks covering:
 *   - clean pass (no salvage)
 *   - SOFT salvage preserves caller status (D-04)
 *   - HARD drop forces draft (D-04)
 *   - expander throw (malformed-if-else) recovery
 *   - orchestratedUpdate partial change set (omits actions)
 *   - orchestratedUpdate WITH actions (validation runs)
 *   - envelope shape invariants
 *   - T-17-02-01 envelope security (no attributes leak)
 *
 * NOTE: D-04 status policy is verified at the api-call level. The hardcoded
 * status field in the FINAL save lives on the PUT body (buildSavePayload sets
 * `status` from the orchestrator-final value), NOT the shell POST body
 * (buildShellPayload always emits status:'draft' regardless of input). So we
 * inspect `client._calls.put[0].body.status` to verify the orchestrator's
 * decideFinalStatus output reaches the wire.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  orchestratedCreate,
  orchestratedUpdate,
  HARD_CLASSES,
} from './write-orchestrator.js';

const REGISTRY = {
  actions: {
    email: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [
        { key: 'subject', jsType: 'string' },
        { key: 'html', jsType: 'string' },
      ],
      defaultAttributes: { subject: '', html: '<p></p>' },
    },
    if_else: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [{ key: 'branches', jsType: 'array' }],
      defaultAttributes: { branches: [] },
    },
    sms: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [{ key: 'message', jsType: 'string' }],
      defaultAttributes: { message: '' },
    },
    // SOFT-tier exemplar: captured type NOT in DEEP_CHECKS (email/sms are now
    // deep-checked → reject; regression). Used by the SOFT-status test.
    add_note: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [{ key: 'note', jsType: 'string' }],
      defaultAttributes: { note: '' },
    },
  },
  triggers: {
    form_submission: {
      category: 'Trigger',
      shapeStatus: 'captured',
      requiredAttributes: [{ key: 'formId', jsType: 'string' }],
      defaultAttributes: { formId: '' },
    },
  },
};

/**
 * Mock client compatible with both createWorkflow + updateWorkflow flows.
 *
 * - getLocationId / getWriteContext: stub
 * - post: returns shell with given name; trigger POSTs return fresh ids
 * - put: records body
 * - delete: no-op
 * - get: returns a fixed workflow shape (used by createWorkflow's final
 *   getWorkflow call AND updateWorkflow's pre-merge fetch + post-save fetch)
 *
 * NOTE: withBurst intentionally OMITTED. createWorkflow's burst-mode branch is
 * `typeof apiClient.withBurst === 'function' ? withBurst(execute) : execute(apiClient)`,
 * so omitting the field uses the direct-execute path — same calls, simpler harness.
 */
function createMockWriteClient() {
  const calls = { post: [], put: [], delete: [], get: [] };
  return {
    getLocationId: () => 'loc-test',
    getWriteContext: async () => ({
      locationId: 'loc-test',
      companyId: 'co-test',
      userId: 'usr-test',
      companyAge: 60,
      company_id: 'co-test',
      user_id: 'usr-test',
      company_age: 60,
      customValues: [],
      customFields: [],
      pipelines: [],
      users: [],
    }),
    post: mock.fn(async (path, body) => {
      calls.post.push({ path, body });
      // Trigger POST: /workflow/{loc}/trigger
      if (/\/workflow\/[^/]+\/trigger$/.test(path)) {
        return { id: `tr-${calls.post.length}` };
      }
      // Shell POST: /workflow/{loc}
      return { _id: 'wf-test-id', name: body.name };
    }),
    put: mock.fn(async (path, body) => {
      calls.put.push({ path, body });
      return {};
    }),
    delete: mock.fn(async () => ({})),
    get: mock.fn(async (path) => {
      calls.get.push({ path });
      // getWorkflow makes 2 GETs in parallel: detail + triggers
      if (path.includes('/trigger?')) {
        return { triggers: [] };
      }
      return {
        _id: 'wf-test-id',
        name: 'X',
        status: 'draft',
        triggers: [],
        workflowData: { templates: [] },
      };
    }),
    _calls: calls,
  };
}

describe('orchestratedCreate — clean pass', () => {
  it('emits envelope with partial:false when no salvage occurs', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'OK',
      status: 'draft',
      actions: [
        {
          type: 'email',
          name: 'A',
          attributes: { subject: 'S', html: '<p>x</p>' },
        },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(r.partial, false);
    assert.deepEqual(r.skippedActions, []);
    assert.deepEqual(r.warnings, []);
  });
});

describe('orchestratedCreate — SOFT salvage preserves input status (D-04)', () => {
  it('input status:published is preserved when only SOFT class entries exist', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'SoftSalvage',
      status: 'published',
      actions: [{ type: 'add_note', name: 'X', attributes: { garbage: 1 } }],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(r.partial, true);
    assert.equal(r.skippedActions.length, 1);
    assert.equal(r.skippedActions[0].class, 'malformed-shape-stripped');
    // Verify the FINAL save PUT body carries status='published' — D-04 says
    // SOFT salvage MUST preserve caller's input status. Inspecting the wire
    // call (not just the response envelope) catches the orchestrator-vs-handler
    // interface bug class.
    assert.equal(client._calls.put.length, 1);
    assert.equal(
      client._calls.put[0].body.status,
      'published',
      'SOFT salvage MUST preserve input status (D-04) — verify at the save-PUT body, not via response fallback',
    );
  });
});

describe('orchestratedCreate — HARD drop forces draft (D-04)', () => {
  it('input status:published is overridden to draft when ANY HARD class entry exists', async () => {
    const client = createMockWriteClient();
    // Mix one HARD-dropped action with one survivor so a workflow is still
    // created (the all-dropped case is covered by its own regression test).
    const params = {
      name: 'HardSalvage',
      status: 'published',
      actions: [
        { type: 'frobnicate', name: 'Bad', attributes: {} },
        {
          type: 'email',
          name: 'Survivor',
          attributes: { subject: 'S', html: '<p>x</p>' },
        },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(r.partial, true);
    assert.equal(r.skippedActions.length, 1);
    assert.equal(r.skippedActions[0].class, 'unknown-type');
    assert.ok(HARD_CLASSES.has('unknown-type'));
    assert.equal(
      client._calls.put[0].body.status,
      'draft',
      'HARD drop MUST force status=draft (D-04)',
    );
  });
});

describe('orchestratedCreate — expander throw recovery (malformed-if-else)', () => {
  it('catches mixed-form scaffold throw and converts to skippedActions entry', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'BadIfElse',
      status: 'published',
      actions: [
        {
          type: 'if_else',
          name: 'mixed',
          attributes: { branches: [] },
          then: [{ type: 'if_else', nodeType: 'branch-yes', name: 'oops' }],
          else: [],
        },
        {
          type: 'email',
          name: 'survivor',
          attributes: { subject: 's', html: '<p>x</p>' },
        },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    const malformed = r.skippedActions.find((s) => s.class === 'malformed-if-else');
    assert.ok(malformed, 'expected a malformed-if-else skippedActions entry');
    assert.equal(malformed.kind, 'action');
    assert.equal(malformed.type, 'if_else');
    // Should have forced draft (malformed-if-else is HARD)
    assert.equal(client._calls.put[0].body.status, 'draft');
  });
});

describe('orchestratedUpdate — partial change sets', () => {
  it('skips validation/expansion entirely when actions field is omitted', async () => {
    const client = createMockWriteClient();
    // Updating only the name shouldn't trigger any validation
    const r = await orchestratedUpdate(
      client,
      { workflowId: 'wf-test-id', name: 'Renamed' },
      REGISTRY,
    );
    assert.deepEqual(r.skippedActions, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.partial, false);
  });

  it('runs validation when actions field IS supplied', async () => {
    const client = createMockWriteClient();
    const r = await orchestratedUpdate(
      client,
      {
        workflowId: 'wf-test-id',
        actions: [{ type: 'frobnicate', name: 'X' }],
      },
      REGISTRY,
    );
    assert.equal(r.skippedActions.length, 1);
    assert.equal(r.skippedActions[0].class, 'unknown-type');
  });
});

describe('orchestratedCreate / orchestratedUpdate — envelope shape invariants', () => {
  it('every response has partial / skippedActions / warnings properties', async () => {
    const client = createMockWriteClient();
    const r = await orchestratedCreate(
      client,
      { name: 'Empty', status: 'draft', actions: [], triggers: [] },
      REGISTRY,
    );
    assert.equal(typeof r.partial, 'boolean');
    assert.ok(Array.isArray(r.skippedActions));
    assert.ok(Array.isArray(r.warnings));
  });
});

describe('orchestratedCreate — regression actions persist into save PUT', () => {
  it('round-trip: 2 valid actions land as templates in the save PUT body', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'RoundTrip',
      status: 'draft',
      actions: [
        {
          type: 'email',
          name: 'First',
          attributes: { subject: 'S1', html: '<p>1</p>' },
        },
        { type: 'sms', name: 'Second', attributes: { message: 'hi' } },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(r.partial, false);
    // The whole point of the ticket: actions supplied at create time MUST reach
    // the save PUT. Inspect the wire, not just the response envelope.
    assert.equal(client._calls.put.length, 1);
    const templates = client._calls.put[0].body.workflowData.templates;
    assert.equal(templates.length, 2, 'both actions must persist as templates');
    assert.equal(templates[0].type, 'email');
    assert.equal(templates[1].type, 'sms');
    assert.equal(templates[0].order, 0);
    assert.equal(templates[1].order, 1);
    assert.equal(
      client._calls.put[0].body.createdSteps.length,
      2,
      'createdSteps must list both persisted step ids',
    );
  });

  it('all-unknown create THROWS instead of silently creating an empty workflow', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'AllUnknown',
      status: 'draft',
      actions: [
        { type: 'frobnicate', name: 'X', attributes: {} },
        { type: 'wibble', name: 'Y', attributes: {} },
      ],
      triggers: [],
    };
    await assert.rejects(
      () => orchestratedCreate(client, params, REGISTRY),
      (err) => {
        assert.ok(/frobnicate/.test(err.message), 'error names dropped type frobnicate');
        assert.ok(/wibble/.test(err.message), 'error names dropped type wibble');
        assert.ok(Array.isArray(err.skippedActions), 'skippedActions attached to error');
        return true;
      },
    );
    // No workflow should have been saved.
    assert.equal(client._calls.put.length, 0, 'no PUT save on all-dropped create');
  });

  it('partial salvage still succeeds: 1 known + 1 unknown persists the survivor', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'PartialSalvage',
      status: 'draft',
      actions: [
        {
          type: 'email',
          name: 'Keep',
          attributes: { subject: 'S', html: '<p>x</p>' },
        },
        { type: 'frobnicate', name: 'Drop', attributes: {} },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(client._calls.put.length, 1, 'workflow still created');
    const templates = client._calls.put[0].body.workflowData.templates;
    assert.equal(templates.length, 1, 'only the survivor persists');
    assert.equal(templates[0].type, 'email');
    assert.equal(r.skippedActions.length, 1);
    assert.equal(r.skippedActions[0].class, 'unknown-type');
  });

  it('empty-create still produces a draft (no guard false-trip)', async () => {
    const client = createMockWriteClient();
    const r = await orchestratedCreate(
      client,
      { name: 'EmptyDraft', status: 'draft', actions: [], triggers: [] },
      REGISTRY,
    );
    assert.equal(client._calls.put.length, 1, 'empty-create still saves a shell');
    assert.equal(client._calls.put[0].body.workflowData.templates.length, 0);
    assert.deepEqual(r.skippedActions, []);
  });

  it('alias: send_email validates against email shape and keeps type on emit', async () => {
    const client = createMockWriteClient();
    const params = {
      name: 'Aliased',
      status: 'draft',
      actions: [
        {
          type: 'send_email',
          name: 'Aliased',
          attributes: { subject: 'S', html: '<p>x</p>' },
        },
      ],
      triggers: [],
    };
    const r = await orchestratedCreate(client, params, REGISTRY);
    assert.equal(r.partial, false, 'aliased type must not be dropped');
    const templates = client._calls.put[0].body.workflowData.templates;
    assert.equal(templates.length, 1);
    assert.equal(
      templates[0].type,
      'send_email',
      'emitted template preserves the caller original type (alias only picks the shape)',
    );
  });
});

describe('orchestratedUpdate — regression guard does NOT apply to update', () => {
  it('update with only unknown actions does not throw (empty-actions = delete all steps)', async () => {
    const client = createMockWriteClient();
    // The all-dropped guard is create-only. update with all-unknown actions must
    // NOT throw — it degrades to the existing skippedActions behaviour.
    const r = await orchestratedUpdate(
      client,
      {
        workflowId: 'wf-test-id',
        actions: [{ type: 'frobnicate', name: 'X', attributes: {} }],
      },
      REGISTRY,
    );
    assert.equal(r.skippedActions.length, 1);
    assert.equal(r.skippedActions[0].class, 'unknown-type');
  });
});

describe('orchestratedCreate — T-17-02-01 envelope security', () => {
  it('skippedActions / warnings entries never contain attributes content', async () => {
    const client = createMockWriteClient();
    const r = await orchestratedCreate(
      client,
      {
        name: 'Sec',
        status: 'draft',
        actions: [
          // A valid survivor so orchestratedCreate does not trip the
          // regression all-dropped guard (which throws before we can
          // inspect skip records). add_note is the mock registry's SOFT-tier
          // exemplar (captured, NOT in DEEP_CHECKS) — it SOFT-salvages and survives.
          { type: 'add_note', name: 'ok', attributes: {} },
          // The security subject: an unrecognized type carrying secret
          // attribute content. Its skip record must NOT echo attributes.
          {
            type: 'email',
            name: 'X',
            attributes: { secretKey: 'leaked' },
          },
        ],
        triggers: [],
      },
      REGISTRY,
    );
    for (const e of r.skippedActions) assert.equal(e.attributes, undefined);
    for (const e of r.warnings) assert.equal(e.attributes, undefined);
  });
});
