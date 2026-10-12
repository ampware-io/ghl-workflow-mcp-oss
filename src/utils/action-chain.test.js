import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActionChain,
  normalizeToWriteFormat,
  diffAndWireActions,
  buildShellPayload,
  buildTriggerPayload,
  buildSavePayload,
  diffTriggers,
  resolveTriggerConditions,
} from './action-chain.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('buildActionChain', () => {
  it('returns empty templates and createdSteps for empty input', () => {
    const result = buildActionChain([]);
    assert.deepStrictEqual(result, { templates: [], createdSteps: [] });
  });

  it('returns single action with UUID id, order 0, no next property', () => {
    const result = buildActionChain([{ type: 'send_email', name: 'Email' }]);

    assert.equal(result.templates.length, 1);
    assert.match(result.templates[0].id, UUID_RE);
    assert.equal(result.templates[0].order, 0);
    assert.equal(result.templates[0].type, 'send_email');
    assert.equal(result.templates[0].name, 'Email');
    assert.equal('next' in result.templates[0], false);
    assert.deepStrictEqual(result.createdSteps, [result.templates[0].id]);
  });

  it('wires 3 actions with correct order and next pointers', () => {
    const actions = [
      { type: 'a', name: 'A' },
      { type: 'b', name: 'B' },
      { type: 'c', name: 'C' },
    ];
    const result = buildActionChain(actions);

    assert.equal(result.templates.length, 3);
    assert.equal(result.templates[0].order, 0);
    assert.equal(result.templates[1].order, 1);
    assert.equal(result.templates[2].order, 2);

    assert.equal(result.templates[0].next, result.templates[1].id);
    assert.equal(result.templates[1].next, result.templates[2].id);
    assert.equal('next' in result.templates[2], false);

    assert.equal(result.createdSteps.length, 3);
    result.createdSteps.forEach((id) => assert.match(id, UUID_RE));
  });

  it('preserves action type, name, and attributes in output templates', () => {
    const actions = [{ type: 'wait', name: 'Delay', attributes: { delay: 60 } }];
    const result = buildActionChain(actions);

    assert.equal(result.templates[0].type, 'wait');
    assert.equal(result.templates[0].name, 'Delay');
    assert.deepStrictEqual(result.templates[0].attributes, { delay: 60 });
  });

  it('preserves caller-supplied IDs instead of generating fresh UUIDs', () => {
    const actions = [
      { id: 'my-id-1', type: 'a', name: 'A' },
      { id: 'my-id-2', type: 'b', name: 'B' },
    ];
    const result = buildActionChain(actions);
    assert.equal(result.templates[0].id, 'my-id-1');
    assert.equal(result.templates[1].id, 'my-id-2');
    assert.equal(result.templates[0].next, 'my-id-2');
    assert.deepStrictEqual(result.createdSteps, ['my-id-1', 'my-id-2']);
  });

  it('preserves branch wiring when caller supplies IDs with next arrays', () => {
    const actions = [
      { id: 'cond-1', type: 'if_else', name: 'Branch', nodeType: 'condition-node', next: ['yes-1', 'no-1'] },
      { id: 'yes-1', type: 'if_else', name: 'Yes', nodeType: 'branch-yes', parent: 'cond-1', parentKey: 'cond-1', sibling: ['no-1'], next: 'child-1' },
      { id: 'no-1', type: 'if_else', name: 'No', nodeType: 'branch-no', parent: 'cond-1', parentKey: 'cond-1', sibling: ['yes-1'] },
      { id: 'child-1', type: 'email', name: 'Email', parent: 'yes-1', parentKey: 'yes-1' },
    ];
    const result = buildActionChain(actions);
    assert.deepStrictEqual(result.templates[0].next, ['yes-1', 'no-1']);
    assert.equal(result.templates[1].next, 'child-1');
    assert.equal(result.templates[1].parent, 'cond-1');
    assert.deepStrictEqual(result.templates[1].sibling, ['no-1']);
    assert.equal(result.templates[3].parent, 'yes-1');
    assert.equal(result.createdSteps.length, 4);
  });
});

describe('normalizeToWriteFormat', () => {
  it('passes through already-write-format conditions unchanged', () => {
    const condition = { operator: 'is-any-of', value: ['val1', 'val2'], type: 'string' };
    const result = normalizeToWriteFormat(condition);
    assert.deepStrictEqual(result, condition);
  });

  it('converts read-format (==, string) to write-format (is-any-of, array)', () => {
    const condition = { operator: '==', value: 'some-value', field: 'status' };
    const result = normalizeToWriteFormat(condition);

    assert.equal(result.operator, 'is-any-of');
    assert.deepStrictEqual(result.value, ['some-value']);
    assert.equal(result.type, 'string');
    assert.equal(result.field, 'status');
  });

  it('passes through unknown formats unchanged (D-16)', () => {
    const condition = { operator: 'contains', value: 42, custom: true };
    const result = normalizeToWriteFormat(condition);
    assert.deepStrictEqual(result, condition);
  });
});

describe('diffAndWireActions', () => {
  it('treats all new actions as createdSteps when old is empty', () => {
    const newActions = [
      { type: 'a', name: 'A' },
      { type: 'b', name: 'B' },
    ];
    const result = diffAndWireActions([], newActions);

    assert.equal(result.templates.length, 2);
    assert.equal(result.createdSteps.length, 2);
    assert.deepStrictEqual(result.modifiedSteps, []);
    assert.deepStrictEqual(result.deletedSteps, []);
    result.createdSteps.forEach((id) => assert.match(id, UUID_RE));
  });

  it('preserves IDs for existing actions and generates UUIDs for new ones without caller ID', () => {
    const oldActions = [
      { id: 'existing-1', type: 'a', name: 'A', order: 0, attributes: {} },
    ];
    const newActions = [
      { id: 'existing-1', type: 'a', name: 'A', attributes: {} },
      { type: 'b', name: 'B' },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.equal(result.templates[0].id, 'existing-1');
    assert.match(result.templates[1].id, UUID_RE);
    assert.equal(result.createdSteps.length, 1);
    assert.ok(!result.createdSteps.includes('existing-1'));
  });

  it('preserves caller-supplied IDs on new actions (patch-ops scenario)', () => {
    const oldActions = [
      { id: 'existing-1', type: 'a', name: 'A', order: 0, attributes: {} },
    ];
    const newActions = [
      { id: 'existing-1', type: 'a', name: 'A', attributes: {} },
      { id: 'caller-new-1', type: 'b', name: 'B' },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.equal(result.templates[1].id, 'caller-new-1');
    assert.deepStrictEqual(result.createdSteps, ['caller-new-1']);
    assert.ok(!result.modifiedSteps.includes('caller-new-1'));
  });

  it('preserves branch wiring on new steps with caller-supplied IDs', () => {
    const oldActions = [
      { id: 'trunk-1', type: 'wait', name: 'Wait', order: 0, attributes: {}, next: 'trunk-2' },
      { id: 'trunk-2', type: 'email', name: 'Old Email', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'trunk-1', type: 'wait', name: 'Wait', next: 'cond-1' },
      { id: 'cond-1', type: 'if_else', name: 'Branch', nodeType: 'condition-node', next: ['yes-1', 'no-1'], attributes: {} },
      { id: 'yes-1', type: 'if_else', name: 'Yes', nodeType: 'branch-yes', parent: 'cond-1', parentKey: 'cond-1', sibling: ['no-1'], next: 'email-y', attributes: {} },
      { id: 'no-1', type: 'if_else', name: 'No', nodeType: 'branch-no', parent: 'cond-1', parentKey: 'cond-1', sibling: ['yes-1'], next: 'email-n', attributes: {} },
      { id: 'email-y', type: 'email', name: 'Yes Email', parent: 'yes-1', parentKey: 'yes-1', attributes: {} },
      { id: 'email-n', type: 'email', name: 'No Email', parent: 'no-1', parentKey: 'no-1', attributes: {} },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.equal(result.templates[0].id, 'trunk-1');
    assert.equal(result.templates[0].next, 'cond-1');
    assert.equal(result.templates[1].id, 'cond-1');
    assert.deepStrictEqual(result.templates[1].next, ['yes-1', 'no-1']);
    assert.equal(result.templates[2].next, 'email-y');
    assert.equal(result.templates[3].next, 'email-n');
    assert.deepStrictEqual(result.templates[2].sibling, ['no-1']);
    assert.deepStrictEqual(result.templates[3].sibling, ['yes-1']);
    assert.equal(result.createdSteps.length, 5);
    assert.ok(!result.createdSteps.includes('trunk-1'));
    assert.deepStrictEqual(result.deletedSteps, ['trunk-2']);
  });

  it('computes deletedSteps as old IDs not present in new list', () => {
    const oldActions = [
      { id: 'keep-1', type: 'a', name: 'A', order: 0, attributes: {} },
      { id: 'remove-1', type: 'b', name: 'B', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'keep-1', type: 'a', name: 'A', attributes: {} },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.deepStrictEqual(result.deletedSteps, ['remove-1']);
  });

  it('computes modifiedSteps for existing actions with changed attributes', () => {
    const oldActions = [
      { id: 'mod-1', type: 'a', name: 'A', order: 0, attributes: { delay: 10 } },
    ];
    const newActions = [
      { id: 'mod-1', type: 'a', name: 'A', attributes: { delay: 30 } },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.deepStrictEqual(result.modifiedSteps, ['mod-1']);
    assert.deepStrictEqual(result.createdSteps, []);
  });

  it('re-wires next pointers for the new action sequence', () => {
    const oldActions = [
      { id: 'a1', type: 'a', name: 'A', order: 0, attributes: {} },
      { id: 'a2', type: 'b', name: 'B', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'a2', type: 'b', name: 'B', attributes: {} },
      { id: 'a1', type: 'a', name: 'A', attributes: {} },
      { type: 'c', name: 'C' },
    ];
    const result = diffAndWireActions(oldActions, newActions);

    assert.equal(result.templates[0].id, 'a2');
    assert.equal(result.templates[1].id, 'a1');
    assert.equal(result.templates[0].next, result.templates[1].id);
    assert.equal(result.templates[1].next, result.templates[2].id);
    assert.equal('next' in result.templates[2], false);

    assert.equal(result.templates[0].order, 0);
    assert.equal(result.templates[1].order, 1);
    assert.equal(result.templates[2].order, 2);
  });
});

describe('buildActionChain — passthrough (D-01) + per-template next fallback (D-04)', () => {
  it('preserves all caller-supplied fields verbatim on the output template (D-01)', () => {
    // Rich-template fields that the GHL workflow builder emits today.
    const actions = [
      {
        type: 'condition-node-group',
        name: 'Outer Condition',
        attributes: {},
        nodeType: 'condition-node',
        parent: 'outer',
        parentKey: 'outer',
        sibling: ['by-1'],
        cat: 'conditions',
        comments: [],
      },
    ];
    const result = buildActionChain(actions);
    const t = result.templates[0];
    assert.equal(t.nodeType, 'condition-node');
    assert.equal(t.parent, 'outer');
    assert.equal(t.parentKey, 'outer');
    assert.deepStrictEqual(t.sibling, ['by-1']);
    assert.equal(t.cat, 'conditions');
    assert.deepStrictEqual(t.comments, []);
    // Managed fields still managed:
    assert.match(t.id, UUID_RE);
    assert.equal(t.order, 0);
  });

  it('auto-fills next on non-last templates when caller omits next (D-04 fallback)', () => {
    const actions = [
      { type: 'a', name: 'A' },
      { type: 'b', name: 'B' },
    ];
    const { templates } = buildActionChain(actions);
    assert.equal(templates[0].next, templates[1].id);
    assert.equal('next' in templates[1], false);
  });

  it('strips next on the last template when caller did not supply one (D-04 / D-15 canary)', () => {
    const { templates } = buildActionChain([
      { type: 'a', name: 'A' },
      { type: 'b', name: 'B' },
      { type: 'c', name: 'C' },
    ]);
    assert.equal('next' in templates[2], false);
  });
});

describe('buildActionChain — explicit next preserved (D-04)', () => {
  it('preserves an explicit string next on a non-last template (NOT auto-overwritten)', () => {
    const actions = [
      { type: 'a', name: 'A', next: 'specific-id' },
      { type: 'b', name: 'B' },
    ];
    const { templates } = buildActionChain(actions);
    assert.equal(templates[0].next, 'specific-id');
  });

  it('preserves an explicit array next byte-identically', () => {
    const explicit = ['by-1', 'bn-1'];
    const actions = [
      { type: 'if_else', name: 'Branch', next: explicit },
      { type: 'a', name: 'A' },
    ];
    const { templates } = buildActionChain(actions);
    assert.deepStrictEqual(templates[0].next, ['by-1', 'bn-1']);
  });

  it('preserves an explicit next on the LAST template (does NOT delete it)', () => {
    const { templates } = buildActionChain([
      { type: 'a', name: 'A' },
      { type: 'goto', name: 'Loop', next: 'something', attributes: {} },
    ]);
    assert.equal(templates[1].next, 'something');
  });
});

describe('buildActionChain — goto special case (Pitfall 4)', () => {
  it('does NOT auto-fill next on a mid-array goto when caller omits next', () => {
    const actions = [
      { type: 'sms', name: 'A' },
      { type: 'goto', name: 'Loop', attributes: { targetNodeId: 'A-id' } },
      { type: 'sms', name: 'C' },
    ];
    const { templates } = buildActionChain(actions);
    assert.equal('next' in templates[1], false, 'goto in mid-array must not be auto-wired');
    // Non-goto neighbours wire normally:
    assert.equal(templates[0].next, templates[1].id);
    assert.equal('next' in templates[2], false); // last template, no caller next
  });

  it("honors a caller's explicit next on a goto (auto-skip is for fallback only)", () => {
    const actions = [
      { type: 'goto', name: 'Loop', next: 'something', attributes: {} },
      { type: 'sms', name: 'B' },
    ];
    const { templates } = buildActionChain(actions);
    assert.equal(templates[0].next, 'something');
  });
});

describe('diffAndWireActions — passthrough (D-01)', () => {
  it('preserves caller-supplied wiring fields on a freshly created template', () => {
    // Plan 17-02 (D-06): wiring is now validated post-fallback. Caller-supplied
    // ids only survive when they match an oldActions entry (D-02). To keep
    // explicit branch-id wiring stable across test runs we seed oldActions
    // with the three ids; the validator then sees a self-consistent payload.
    const oldActions = [
      { id: 'outer-1', type: 'if_else', name: 'Branch', order: 0, attributes: {} },
      { id: 'by-1', type: 'condition-node-group', name: 'Yes', order: 1, attributes: {} },
      { id: 'bn-1', type: 'condition-node-group', name: 'No', order: 2, attributes: {} },
    ];
    const newActions = [
      {
        id: 'outer-1',
        type: 'if_else',
        name: 'Branch',
        attributes: {},
        nodeType: 'condition-node',
        cat: 'conditions',
        comments: [],
        next: ['by-1', 'bn-1'],
      },
      {
        id: 'by-1',
        type: 'condition-node-group',
        name: 'Yes',
        attributes: {},
        nodeType: 'branch-yes',
        parent: 'outer-1',
        parentKey: 'outer-1',
        sibling: ['bn-1'],
      },
      {
        id: 'bn-1',
        type: 'condition-node-group',
        name: 'No',
        attributes: {},
        nodeType: 'branch-no',
        parent: 'outer-1',
        parentKey: 'outer-1',
        sibling: ['by-1'],
      },
    ];
    const { templates } = diffAndWireActions(oldActions, newActions);
    const outer = templates[0];
    assert.equal(outer.nodeType, 'condition-node');
    assert.equal(outer.cat, 'conditions');
    assert.deepStrictEqual(outer.comments, []);
    assert.deepStrictEqual(outer.next, ['by-1', 'bn-1']);
    // Branch children carry the rich passthrough fields:
    const by = templates[1];
    assert.equal(by.parent, 'outer-1');
    assert.equal(by.parentKey, 'outer-1');
    assert.deepStrictEqual(by.sibling, ['bn-1']);
    assert.equal(by.nodeType, 'branch-yes');
  });

  it('preserves an explicit string next (NOT auto-overwritten by sequential auto-wire)', () => {
    // Caller next on first template points to a specific id (not the array
    // neighbour by default); the explicit pointer must win over the auto-wire
    // fallback. The referenced id must exist in oldActions (D-02 preserves it)
    // for the validator to see a self-consistent payload.
    const oldActions = [
      { id: 'b-id', type: 'b', name: 'B', order: 0, attributes: {} },
    ];
    const newActions = [
      { id: 'b-id', type: 'b', name: 'B' },
      { type: 'a', name: 'A', next: 'b-id' }, // caller explicit non-sequential
    ];
    const { templates } = diffAndWireActions(oldActions, newActions);
    // templates[1] (the new A) must keep its caller-supplied 'b-id' next,
    // not be auto-wired (it IS the last template, but the caller supplied
    // next so the strip path is skipped per Plan 17-01 contract).
    assert.equal(templates[1].next, 'b-id');
  });

  it('skips auto-wire on a mid-array goto with no caller next (Pitfall 4)', () => {
    // Two-template payload: A (auto-wires to the goto), goto (loop back to A
    // via targetNodeId — no `next`). Validator-clean: A is the root, goto is
    // reachable from A.next, and goto.attributes.targetNodeId resolves to A.
    const oldActions = [
      { id: 'a-id', type: 'sms', name: 'A', order: 0, attributes: {} },
    ];
    const newActions = [
      { id: 'a-id', type: 'sms', name: 'A' },
      { type: 'goto', name: 'Loop', attributes: { targetNodeId: 'a-id' } },
    ];
    const { templates } = diffAndWireActions(oldActions, newActions);
    assert.equal('next' in templates[1], false, 'goto must not be auto-wired');
    assert.equal(templates[0].next, templates[1].id, 'A auto-wires to goto');
  });

  it('honors caller explicit next on a goto', () => {
    // goto's explicit next 'b-id' must reference an existing template id;
    // seed oldActions accordingly.
    const oldActions = [
      { id: 'b-id', type: 'sms', name: 'B', order: 0, attributes: {} },
    ];
    const newActions = [
      { type: 'goto', name: 'Loop', next: 'b-id', attributes: {} },
      { id: 'b-id', type: 'sms', name: 'B' },
    ];
    const { templates } = diffAndWireActions(oldActions, newActions);
    assert.equal(templates[0].next, 'b-id');
  });

  it('falls back to neighbour id when caller omits next (D-04)', () => {
    const newActions = [
      { type: 'a', name: 'A' },
      { type: 'b', name: 'B' },
    ];
    const { templates } = diffAndWireActions([], newActions);
    assert.equal(templates[0].next, templates[1].id);
    assert.equal('next' in templates[1], false);
  });

  it('preserves an explicit next on the LAST template under diff (does NOT delete it)', () => {
    // goto loops back to the first template by explicit id; seed oldActions.
    const oldActions = [
      { id: 'a-id', type: 'a', name: 'A', order: 0, attributes: {} },
    ];
    const newActions = [
      { id: 'a-id', type: 'a', name: 'A' },
      { type: 'goto', name: 'Loop', next: 'a-id', attributes: {} },
    ];
    const { templates } = diffAndWireActions(oldActions, newActions);
    assert.equal(templates[1].next, 'a-id');
  });
});

describe('diffAndWireActions — Zod-probe regression (D-01)', () => {
  it('preserves an extra unlisted caller field on the output template', () => {
    // Phase 17 RED-side proof. The harness skips the SDK Zod boundary; this asserts that
    // diffAndWireActions does not strip caller fields once they reach the action-chain
    // utility. The companion .passthrough() in src/server.js is what makes the field
    // SURVIVE the SDK boundary in production. See plan 17-01 Task 1.
    const fixture = [
      { type: 'sms', name: 'Step', __unlistedField__: 'preserved-value' },
    ];
    const { templates } = diffAndWireActions([], fixture);
    assert.equal(
      templates[0].__unlistedField__,
      'preserved-value',
      'unlisted caller field must passthrough — proves spread is not allowlisted',
    );
  });
});

describe('buildShellPayload', () => {
  it('returns correct structure with snake_case company_id, company_age', () => {
    const ctx = {
      company_id: 'comp-1',
      company_age: 59,
      user_id: 'user-1',
      locationId: 'loc-1',
    };
    const result = buildShellPayload('Test Workflow', ctx);

    assert.equal(result.name, 'Test Workflow');
    assert.equal(result.status, 'draft');
    assert.equal(result.company_id, 'comp-1');
    assert.equal(result.company_age, 59);
    assert.equal(result.updatedBy, 'user-1');
    assert.equal(result.parentId, null);
    assert.deepStrictEqual(result.workflowData, { templates: [] });
    assert.deepStrictEqual(result.createdSteps, []);
    assert.deepStrictEqual(result.modifiedSteps, []);
    assert.deepStrictEqual(result.deletedSteps, []);
    assert.equal(result.triggersChanged, false);
  });

  it('preserves passed settings (regression: VRX — settings clobbering)', () => {
    const ctx = { user_id: 'u', company_id: 'c', company_age: 1 };
    const result = buildShellPayload('Test', ctx, {
      stopOnResponse: true,
      allowMultiple: false,
      allowMultipleOpportunity: false,
      autoMarkAsRead: true,
      timezone: 'America/Los_Angeles',
    });
    assert.equal(result.stopOnResponse, true);
    assert.equal(result.allowMultiple, false);
    assert.equal(result.allowMultipleOpportunity, false);
    assert.equal(result.autoMarkAsRead, true);
    assert.equal(result.timezone, 'America/Los_Angeles');
  });

  it('falls back to hardcoded defaults when settings omitted', () => {
    const ctx = { user_id: 'u', company_id: 'c', company_age: 1 };
    const result = buildShellPayload('Test', ctx);
    assert.equal(result.stopOnResponse, false);
    assert.equal(result.allowMultiple, true);
    assert.equal(result.allowMultipleOpportunity, true);
    assert.equal(result.autoMarkAsRead, false);
    assert.equal(result.timezone, '');
  });
});

describe('buildTriggerPayload', () => {
  it('returns correct structure with conditions run through normalizeToWriteFormat', () => {
    const ctx = {
      company_id: 'comp-1',
      company_age: 59,
    };
    const trigger = {
      type: 'contact_tag',
      masterType: 'highlevel',
      name: 'Tag Added',
      conditions: [
        { operator: '==', value: 'vip', field: 'tag' },
      ],
    };
    const result = buildTriggerPayload(trigger, 'wf-1', 'loc-1', ctx);

    assert.equal(result.workflowId, 'wf-1');
    assert.equal(result.type, 'contact_tag');
    assert.equal(result.location_id, 'loc-1');
    assert.equal(result.company_id, 'comp-1');
    assert.equal(result.company_age, 59);
    assert.equal(result.active, true);
    assert.equal(result.triggersChanged, true);

    // Condition should be normalized
    assert.equal(result.conditions[0].operator, 'is-any-of');
    assert.deepStrictEqual(result.conditions[0].value, ['vip']);
  });

  it('resolves conditions from attributes.conditions alias AND normalizes them', () => {
    const ctx = { company_id: 'comp-1', company_age: 59 };
    const trigger = {
      type: 'contact_tag',
      masterType: 'highlevel',
      name: 'Tag Added',
      // Top-level absent; caller mistakenly nested conditions under attributes.
      attributes: {
        conditions: [{ operator: '==', value: 'vip', field: 'tag' }],
      },
    };
    const result = buildTriggerPayload(trigger, 'wf-1', 'loc-1', ctx);

    // Resolved from the nested alias AND normalized to write format.
    assert.equal(result.conditions[0].operator, 'is-any-of');
    assert.deepStrictEqual(result.conditions[0].value, ['vip']);
  });

  it('top-level conditions win when both top-level and attributes.conditions are present', () => {
    const ctx = { company_id: 'comp-1', company_age: 59 };
    const trigger = {
      type: 'contact_tag',
      masterType: 'highlevel',
      name: 'Tag Added',
      conditions: [{ operator: '==', value: 'top', field: 'tag' }],
      attributes: {
        conditions: [{ operator: '==', value: 'nested', field: 'tag' }],
      },
    };
    const result = buildTriggerPayload(trigger, 'wf-1', 'loc-1', ctx);

    // Top-level (canonical) is used; nested alias is ignored.
    assert.deepStrictEqual(result.conditions[0].value, ['top']);
  });
});

describe('buildSavePayload', () => {
  it('returns correct structure with camelCase companyId, companyAge and newTriggers', () => {
    const ctx = {
      locationId: 'loc-1',
      companyId: 'comp-1',
      companyAge: 59,
      userId: 'user-1',
    };
    const templates = [{ id: 't1', type: 'a', name: 'A', order: 0 }];
    const triggers = [
      { id: 'trig-1', type: 'contact_tag', conditions: [{ operator: 'is-any-of', value: ['x'] }] },
    ];

    const result = buildSavePayload(
      'wf-1', 'My Workflow', 'draft',
      templates, ['t1'], [], [], triggers, ctx,
    );

    assert.equal(result._id, 'wf-1');
    assert.equal(result.locationId, 'loc-1');
    assert.equal(result.companyId, 'comp-1');
    assert.equal(result.companyAge, 59);
    assert.equal(result.updatedBy, 'user-1');
    assert.equal(result.name, 'My Workflow');
    assert.equal(result.status, 'draft');
    assert.deepStrictEqual(result.workflowData, { templates });
    assert.deepStrictEqual(result.createdSteps, ['t1']);
    assert.equal(result.triggersChanged, true);
    assert.equal(result.newTriggers.length, 1);
    assert.equal(result.newTriggers[0].workflowId, 'wf-1');
    assert.equal(result.newTriggers[0].type, 'contact_tag');
    assert.equal(result.newTriggers[0].id, 'trig-1');
    assert.equal(result.newTriggers[0].location_id, 'loc-1');
  });

  it('defaults parentId to null when omitted (preserves createWorkflow behavior)', () => {
    const ctx = {
      locationId: 'loc-1',
      companyId: 'comp-1',
      companyAge: 59,
      userId: 'user-1',
    };
    const result = buildSavePayload('wf-1', 'n', 'draft', [], [], [], [], [], ctx);
    assert.equal(result.parentId, null);
  });

  it('preserves a non-null parentId when passed (regression: TK7 — parentId clobbering)', () => {
    const ctx = {
      locationId: 'loc-1',
      companyId: 'comp-1',
      companyAge: 59,
      userId: 'user-1',
    };
    const result = buildSavePayload('wf-1', 'n', 'draft', [], [], [], [], [], ctx, false, 1, 'folder-abc');
    assert.equal(result.parentId, 'folder-abc');
  });

  it('falls back to hardcoded settings defaults when settings omitted (preserves current behavior)', () => {
    const ctx = { locationId: 'loc-1', companyId: 'c', companyAge: 1, userId: 'u' };
    const result = buildSavePayload('wf-1', 'n', 'draft', [], [], [], [], [], ctx);
    assert.equal(result.stopOnResponse, false);
    assert.equal(result.allowMultiple, true);
    assert.equal(result.allowMultipleOpportunity, true);
    assert.equal(result.removeContactFromLastStep, true);
    assert.equal(result.autoMarkAsRead, false);
    assert.equal(result.timezone, 'account');
  });

  it('preserves a full settings override (regression: VRX — settings clobbering)', () => {
    const ctx = { locationId: 'loc-1', companyId: 'c', companyAge: 1, userId: 'u' };
    const result = buildSavePayload(
      'wf-1', 'n', 'draft', [], [], [], [], [], ctx,
      /* triggersChanged */ false,
      /* version */ 1,
      /* parentId */ null,
      {
        stopOnResponse: true,
        allowMultiple: false,
        allowMultipleOpportunity: false,
        removeContactFromLastStep: false,
        autoMarkAsRead: true,
        timezone: 'America/New_York',
      },
    );
    assert.equal(result.stopOnResponse, true);
    assert.equal(result.allowMultiple, false);
    assert.equal(result.allowMultipleOpportunity, false);
    assert.equal(result.removeContactFromLastStep, false);
    assert.equal(result.autoMarkAsRead, true);
    assert.equal(result.timezone, 'America/New_York');
  });

  it('partial settings — supplied fields override, omitted fields fall back to defaults', () => {
    const ctx = { locationId: 'loc-1', companyId: 'c', companyAge: 1, userId: 'u' };
    const result = buildSavePayload(
      'wf-1', 'n', 'draft', [], [], [], [], [], ctx,
      false, 1, null,
      { stopOnResponse: true, timezone: 'UTC' }, // only two of six
    );
    assert.equal(result.stopOnResponse, true);
    assert.equal(result.timezone, 'UTC');
    // The other four take hardcoded defaults:
    assert.equal(result.allowMultiple, true);
    assert.equal(result.allowMultipleOpportunity, true);
    assert.equal(result.removeContactFromLastStep, true);
    assert.equal(result.autoMarkAsRead, false);
  });

  it('newTriggers resolves conditions from attributes.conditions alias, kept raw/un-normalized', () => {
    const ctx = {
      locationId: 'loc-1',
      companyId: 'comp-1',
      companyAge: 59,
      userId: 'user-1',
    };
    const triggers = [
      {
        id: 'trig-1',
        type: 'contact_tag',
        // Top-level absent; already-write-format conditions nested under attributes.
        attributes: { conditions: [{ operator: 'is-any-of', value: ['x'] }] },
      },
    ];
    const result = buildSavePayload(
      'wf-1', 'My Workflow', 'draft',
      [], [], [], [], triggers, ctx,
    );

    // Resolved from the nested alias AND raw (site #2 does NOT normalize) —
    // passing already-write-format conditions makes "raw" observable.
    assert.deepStrictEqual(
      result.newTriggers[0].conditions,
      [{ operator: 'is-any-of', value: ['x'] }],
    );
  });
});

describe('resolveTriggerConditions', () => {
  it('non-empty top-level wins over non-empty nested', () => {
    const trigger = {
      conditions: [{ operator: '==', value: 'top' }],
      attributes: { conditions: [{ operator: '==', value: 'nested' }] },
    };
    assert.deepStrictEqual(
      resolveTriggerConditions(trigger),
      [{ operator: '==', value: 'top' }],
    );
  });

  it('empty top-level [] falls back to non-empty nested', () => {
    const trigger = {
      conditions: [],
      attributes: { conditions: [{ operator: '==', value: 'nested' }] },
    };
    assert.deepStrictEqual(
      resolveTriggerConditions(trigger),
      [{ operator: '==', value: 'nested' }],
    );
  });

  it('nested-only (top-level absent) returns nested', () => {
    const trigger = {
      attributes: { conditions: [{ operator: '==', value: 'nested' }] },
    };
    assert.deepStrictEqual(
      resolveTriggerConditions(trigger),
      [{ operator: '==', value: 'nested' }],
    );
  });

  it('neither present returns []', () => {
    assert.deepStrictEqual(resolveTriggerConditions({}), []);
  });
});

describe('diffAndWireActions — modifiedSteps full-template diff (D-09, D-10)', () => {
  it('M1: wiring drift — only `next` changed, modifiedSteps includes the id', () => {
    // a points to b in old. New: a points to c (new template), with b and c
    // both present and reachable (b via auto-wire from c, c via a.next).
    const oldActions = [
      { id: 'a', type: 'sms', name: 'A', order: 0, attributes: {}, next: 'b' },
      { id: 'b', type: 'sms', name: 'B', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'a', type: 'sms', name: 'A', attributes: {}, next: 'b' }, // explicit; id of b is preserved (D-02)
    ];
    // Replace original — the simplest M1 is: keep both ids, change next from
    // 'b' to a different value the diff can detect. Easiest: same a+b but
    // flip a's `next` from 'b' (old) to undefined → fallback wires to b.id.
    // Old a.next = 'b', new a.next (post-fallback) also = 'b' → no drift.
    // To force drift we add a 3rd template c so fallback wires a→c not b.
    const oldActions2 = [
      { id: 'a', type: 'sms', name: 'A', order: 0, attributes: {}, next: 'b' },
      { id: 'b', type: 'sms', name: 'B', order: 1, attributes: {} },
    ];
    const newActions2 = [
      { id: 'a', type: 'sms', name: 'A', attributes: {} },        // no caller next → fallback
      { type: 'sms', name: 'C' },                                  // new C in middle
      { id: 'b', type: 'sms', name: 'B', attributes: {} },         // b at end
    ];
    const result = diffAndWireActions(oldActions2, newActions2);
    assert.ok(
      result.modifiedSteps.includes('a'),
      'fallback wires a.next = C-uuid; old a.next was "b" → drift counts',
    );
    void newActions; // silence linter; kept for clarity that the original draft is intentionally unused
  });

  it('M2: parent drift — only `parent` changed, modifiedSteps includes the id', () => {
    // Construct a self-consistent parent flip. `a` is a branch child whose
    // `parent` flips from p1 (old) to p2 (new). Both outer ids and the new
    // sibling id are seeded into oldActions so the caller-supplied ids
    // survive D-02 preservation and the validator sees a valid graph.
    const oldActions = [
      { id: 'p1', type: 'if_else', name: 'P1', order: 0, attributes: {}, next: ['a', 'a2-old'] },
      { id: 'a', type: 'cn', name: 'A', order: 1, attributes: {}, nodeType: 'branch-yes', parent: 'p1', sibling: ['a2-old'] },
      { id: 'a2-old', type: 'cn', name: 'A2', order: 2, attributes: {}, nodeType: 'branch-no', parent: 'p1', sibling: ['a'] },
      // Seeded so the new ids survive D-02:
      { id: 'p2', type: 'if_else', name: 'P2 seed', order: 3, attributes: {} },
      { id: 'a2-new', type: 'cn', name: 'A2-new seed', order: 4, attributes: {} },
    ];
    const newActions = [
      { id: 'p2', type: 'if_else', name: 'P2', attributes: {}, next: ['a', 'a2-new'] },
      { id: 'a', type: 'cn', name: 'A', attributes: {}, nodeType: 'branch-yes', parent: 'p2', sibling: ['a2-new'] }, // parent flipped
      { id: 'a2-new', type: 'cn', name: 'A2', attributes: {}, nodeType: 'branch-no', parent: 'p2', sibling: ['a'] },
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.ok(result.modifiedSteps.includes('a'), 'parent drift on `a` must mark modified');
  });

  it('M3: sibling drift — only `sibling` array changed, modifiedSteps includes the id', () => {
    // Old: by paired with bn1. New: by paired with bn2 (sibling array flipped).
    // Old payload — outer routes to by + bn1 via next array.
    const oldActions = [
      { id: 'outer', type: 'if_else', name: 'O', order: 0, attributes: {}, next: ['by', 'bn1'] },
      { id: 'by', type: 'cn', name: 'Yes', order: 1, attributes: {}, nodeType: 'branch-yes', parent: 'outer', sibling: ['bn1'] },
      { id: 'bn1', type: 'cn', name: 'No1', order: 2, attributes: {}, nodeType: 'branch-no', parent: 'outer', sibling: ['by'] },
    ];
    // New payload — bn1 replaced by a fresh bn2 (no caller id → fresh UUID).
    // Caller-supplied `next: ['by', <bn2-id>]` would require knowing the UUID
    // up-front. Workaround: use D-02 to seed bn2 in oldActions so the
    // caller-supplied id 'bn2' is preserved.
    const oldActionsSeeded = [
      ...oldActions,
      { id: 'bn2', type: 'cn', name: 'BN2 seed', order: 3, attributes: {} },
    ];
    const newActions = [
      { id: 'outer', type: 'if_else', name: 'O', attributes: {}, next: ['by', 'bn2'] },
      { id: 'by', type: 'cn', name: 'Yes', attributes: {}, nodeType: 'branch-yes', parent: 'outer', sibling: ['bn2'] }, // sibling flipped
      { id: 'bn2', type: 'cn', name: 'No2', attributes: {}, nodeType: 'branch-no', parent: 'outer', sibling: ['by'] },
    ];
    const result = diffAndWireActions(oldActionsSeeded, newActions);
    assert.ok(result.modifiedSteps.includes('by'), 'sibling drift on `by` must mark modified');
  });

  it('M4: attributes drift (preserves the existing pre-Plan-17-02 contract)', () => {
    // Same fixture as the original action-chain.test.js:131-142 test but
    // re-asserted against the new full-template diff path (D-09).
    const oldActions = [
      { id: 'mod-1', type: 'a', name: 'A', order: 0, attributes: { delay: 10 } },
    ];
    const newActions = [
      { id: 'mod-1', type: 'a', name: 'A', attributes: { delay: 30 } },
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.deepStrictEqual(result.modifiedSteps, ['mod-1']);
    assert.deepStrictEqual(result.createdSteps, []);
  });

  it('M5: key-order independence — same content / different write-order does NOT mark modified', () => {
    const oldActions = [
      { id: 'a', type: 'sms', name: 'A', order: 0, attributes: { x: 1, y: 2 } },
    ];
    const newActions = [
      { id: 'a', type: 'sms', name: 'A', attributes: { y: 2, x: 1 } }, // permuted keys
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.deepStrictEqual(result.modifiedSteps, [], 'canonical-stringify is sorted-key stable');
  });

  it('M6: order excluded from diff — different `order` values do NOT mark modified', () => {
    // Old has order:5 (synthetic — wouldn't normally happen but proves the
    // strip). New gets order:0 from spread+overwrite.
    const oldActions = [
      { id: 'a', type: 'sms', name: 'A', order: 5, attributes: {} },
    ];
    const newActions = [
      { id: 'a', type: 'sms', name: 'A', attributes: {} },
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.deepStrictEqual(result.modifiedSteps, [], '`order` is managed and excluded from the diff');
  });

  it('M7: unchanged template (post-fallback wiring identical) does NOT mark modified', () => {
    const oldActions = [
      { id: 'a', type: 'sms', name: 'A', order: 0, attributes: { x: 1 }, next: 'b' },
      { id: 'b', type: 'sms', name: 'B', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'a', type: 'sms', name: 'A', attributes: { x: 1 }, next: 'b' },
      { id: 'b', type: 'sms', name: 'B', attributes: {} },
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.deepStrictEqual(result.modifiedSteps, []);
  });

  it('M8: fallback-induced "change" — auto-wired `next` differs from old `next`', () => {
    // Old: a → old-b. Caller submits a + new-b (no caller next on either).
    // Per-template fallback wires a.next = new-b.id post-spread. The diff
    // sees old.next='old-b' vs new.next='new-b' → flag `a` as modified.
    const oldActions = [
      { id: 'a', type: 'sms', name: 'A', order: 0, attributes: {}, next: 'old-b' },
      { id: 'old-b', type: 'sms', name: 'OldB', order: 1, attributes: {} },
    ];
    const newActions = [
      { id: 'a', type: 'sms', name: 'A', attributes: {} },         // no caller next
      { type: 'sms', name: 'NewB' },                                // fresh UUID
    ];
    const result = diffAndWireActions(oldActions, newActions);
    assert.ok(result.modifiedSteps.includes('a'), 'fallback wiring drift counts (D-09)');
  });
});

describe('diffAndWireActions — branching round-trip (D-14)', () => {
  // Fixture helper functions live INSIDE the describe block (per existing test-file convention).
  // Each fixture mirrors a real captured shape from the captured GHL builder shapes.
  //
  // Note on `next: undefined`: where a branch/transition has no inner actions,
  // we set `next: undefined` explicitly so the per-template auto-wire fallback
  // skips that template (it checks `'next' in callerAction`). Without this,
  // fallback would inject a sequential `next` pointer and break byte-equivalence.

  function ifElseFixture() {
    // Source: captured builder shape §If/Else (Real) lines ~92-170
    // captured builder shape §Step: If/Else (Real) lines ~473+
    const outerId = 'outer-1';
    const yesId = 'by-1';
    const noId = 'bn-1';
    return [
      {
        id: outerId,
        type: 'if_else',
        cat: 'conditions',
        name: 'yes',
        attributes: {
          branches: [],
          operator: 'and',
          if: true,
          conditionName: 'Condition',
          version: 2,
          noneBranchName: 'None',
        },
        next: [yesId, noId],
        comments: [],
        nodeType: 'condition-node',
      },
      {
        id: yesId,
        type: 'if_else',
        cat: 'conditions',
        name: 'Yes',
        parent: outerId,
        parentKey: outerId,
        sibling: [noId],
        attributes: {
          if: false,
          conditionName: 'Condition',
          operator: 'and',
          branches: [],
        },
        nodeType: 'branch-yes',
        comments: [],
        next: undefined, // explicit-undefined: branch has no inner actions; skip auto-wire
      },
      {
        id: noId,
        type: 'if_else',
        cat: 'conditions',
        name: 'None',
        parent: outerId,
        parentKey: outerId,
        sibling: [yesId],
        attributes: { else: true },
        nodeType: 'branch-no',
        comments: [],
        next: undefined, // explicit-undefined: branch has no inner actions; skip auto-wire
      },
    ];
  }

  function waitEmailEventFixture() {
    // Source: captured builder shape §Step: Wait (Email Event, multi-path) lines ~332-393
    // captured builder shape §Step: Transition (Variant B) lines ~421-441
    const emailId = 'email-1';
    const waitId = 'w-1';
    const primaryId = 't-primary';
    const timeoutId = 't-timeout';
    return [
      {
        id: emailId,
        type: 'email',
        name: 'Send',
        attributes: {},
        next: waitId, // email wires to wait (explicit; semantically meaningful)
      },
      {
        id: waitId,
        type: 'wait',
        name: 'Wait for open',
        next: [primaryId, timeoutId], // THE headline regression: 2-element array
        cat: 'multi-path',
        attributes: {
          type: 'email_event',
          startAfter: { type: 'days', value: 1, when: 'after' },
          emailEventSteps: [emailId],
          emailEventStepsLabel: ['Send'],
          emailEventTypes: ['opened'],
          cat: 'multi-path',
          convertToMultipath: true,
          isHybridAction: true,
          hybridActionType: 'wait',
          transitions: [
            {
              id: primaryId,
              name: 'wait',
              condition: 'primary',
              conditionType: 'user-defined',
              isPrimaryBranch: true,
              description: '',
              attributes: {
                type: 'wait_email_event',
                description: 'What will happen when email is: opened',
              },
            },
            {
              id: timeoutId,
              name: 'timeout',
              condition: 'timeout',
              conditionType: 'user-defined',
              isPrimaryBranch: false,
              description: '',
              attributes: {
                type: 'wait_timeout',
                description: 'What will happen after 1 day',
              },
            },
          ],
        },
      },
      {
        id: primaryId,
        type: 'transition',
        name: 'wait',
        cat: 'transition',
        parent: waitId,
        parentKey: waitId,
        attributes: {
          type: 'wait_email_event',
          description: 'What will happen when email is: opened',
        },
        next: undefined, // explicit-undefined: branch has no inner actions; skip auto-wire
      },
      {
        id: timeoutId,
        type: 'transition',
        name: 'timeout',
        cat: 'transition',
        parent: waitId,
        parentKey: waitId,
        attributes: {
          type: 'wait_timeout',
          description: 'What will happen after 1 day',
        },
        // Last template — no caller `next` and no auto-wire injection
        // (last-template strip path; nothing to strip since no spread next).
      },
    ];
  }

  function gotoConvergenceFixture() {
    // Source: captured builder shape §Step: Go To (Loop Back) lines ~452-471
    // Branch convergence pattern: branch-no → goto → step inside branch-yes.
    const emailId = 'email-1';
    const outerId = 'outer-1';
    const yesId = 'by-1';
    const noId = 'bn-1';
    const smsInYesId = 'sms-yes-1';
    const gotoInNoId = 'goto-no-1';
    return [
      {
        id: emailId,
        type: 'email',
        name: 'Send',
        attributes: {},
        next: outerId,
      },
      {
        id: outerId,
        type: 'if_else',
        cat: 'conditions',
        name: 'check',
        attributes: {
          branches: [],
          operator: 'and',
          if: true,
          conditionName: 'Condition',
          version: 2,
        },
        next: [yesId, noId],
        comments: [],
        nodeType: 'condition-node',
      },
      {
        id: yesId,
        type: 'if_else',
        cat: 'conditions',
        name: 'Yes',
        parent: outerId,
        parentKey: outerId,
        sibling: [noId],
        attributes: {
          if: false,
          conditionName: 'Condition',
          operator: 'and',
          branches: [],
        },
        nodeType: 'branch-yes',
        comments: [],
        next: smsInYesId, // wires to inner action
      },
      {
        id: smsInYesId,
        type: 'sms',
        name: 'Notify',
        parent: yesId,
        parentKey: yesId,
        attributes: { message: 'Welcome' },
        next: undefined, // explicit-undefined: end of yes branch; skip auto-wire
      },
      {
        id: noId,
        type: 'if_else',
        cat: 'conditions',
        name: 'None',
        parent: outerId,
        parentKey: outerId,
        sibling: [yesId],
        attributes: { else: true },
        nodeType: 'branch-no',
        comments: [],
        next: gotoInNoId, // wires to goto
      },
      {
        id: gotoInNoId,
        type: 'goto',
        name: 'Loop back',
        parent: noId,
        parentKey: noId,
        attributes: { targetNodeId: smsInYesId, type: 'goto' },
        // NOTE: gotoInNoId intentionally has NO `next` key — Plan 01's goto
        // special case must NOT inject one. The 'next' in goto === false
        // assertion below proves this.
      },
    ];
  }

  it('round-trips an if_else workflow byte-for-byte (D-14 if_else)', () => {
    const fixture = ifElseFixture();
    // Pass fixture as both old and new — preserves IDs, diff sees zero changes.
    const { templates } = diffAndWireActions(fixture, fixture);
    assert.equal(templates.length, fixture.length);
    for (let i = 0; i < templates.length; i++) {
      const { order: _o1, ...stripped } = templates[i];
      const { order: _o2, ...expected } = fixture[i];
      assert.deepStrictEqual(stripped, expected,
        `template ${i} (${templates[i].name}) not byte-equivalent`);
    }
  });

  it('round-trips a multi-path wait_email_event byte-for-byte (D-14 multi-path)', () => {
    const fixture = waitEmailEventFixture();
    const { templates } = diffAndWireActions(fixture, fixture);
    assert.equal(templates.length, fixture.length);
    for (let i = 0; i < templates.length; i++) {
      const { order: _o1, ...stripped } = templates[i];
      const { order: _o2, ...expected } = fixture[i];
      assert.deepStrictEqual(stripped, expected,
        `template ${i} (${templates[i].name}) not byte-equivalent`);
    }
  });

  it('preserves array next on multi-path wait — the headline regression for Phase 17', () => {
    const fixture = waitEmailEventFixture();
    const waitId = 'w-1';
    const primaryId = 't-primary';
    const timeoutId = 't-timeout';
    const { templates } = diffAndWireActions(fixture, fixture);
    const wait = templates.find((t) => t.id === waitId);
    assert.ok(wait, 'wait template must exist in output');
    assert.deepStrictEqual(wait.next, [primaryId, timeoutId],
      'multi-path wait next must remain a 2-element array — NOT flattened to a string (the exact bug Phase 17 fixes)');
    // Defense-in-depth: confirm the inner attributes survived passthrough too.
    assert.equal(wait.attributes.type, 'email_event');
    assert.deepStrictEqual(wait.attributes.emailEventSteps, ['email-1']);
    assert.deepStrictEqual(wait.attributes.emailEventTypes, ['opened']);
    assert.equal(wait.attributes.transitions.length, 2);
  });

  it('round-trips a goto convergence workflow + preserves attributes.targetNodeId (D-14 goto)', () => {
    const fixture = gotoConvergenceFixture();
    const gotoInNoId = 'goto-no-1';
    const smsInYesId = 'sms-yes-1';
    const { templates } = diffAndWireActions(fixture, fixture);
    const goto = templates.find((t) => t.id === gotoInNoId);
    assert.ok(goto, 'goto template must exist in output');
    assert.equal(goto.attributes.targetNodeId, smsInYesId,
      'goto.attributes.targetNodeId must passthrough (D-01)');
    assert.equal('next' in goto, false,
      'goto template must NOT have a next key auto-injected (Plan 01 goto special case)');
    // Outer + branch wiring survived too:
    assert.equal(templates.length, fixture.length);
    for (let i = 0; i < templates.length; i++) {
      const { order: _o1, ...stripped } = templates[i];
      const { order: _o2, ...expected } = fixture[i];
      assert.deepStrictEqual(stripped, expected,
        `template ${i} (${templates[i].name}) not byte-equivalent`);
    }
  });
});

// ---------------------------------------------------------------------------
// diffTriggers (260426-lf7) — id-keyed creates / updates / deletes diff
// ---------------------------------------------------------------------------

describe('diffTriggers', () => {
  it('returns empty creates/updates/deletes and unchanged=current when requested is undefined', () => {
    const current = [
      { id: 'tr1', type: 'form_submission', name: 'A', conditions: [] },
      { id: 'tr2', type: 'contact_tag', name: 'B', conditions: [] },
    ];
    const diff = diffTriggers(current, undefined);
    assert.deepStrictEqual(diff.creates, []);
    assert.deepStrictEqual(diff.updates, []);
    assert.deepStrictEqual(diff.deletes, []);
    assert.equal(diff.unchanged.length, 2);
    assert.deepStrictEqual(diff.unchanged.map(t => t.id), ['tr1', 'tr2']);
  });

  it('classifies a trigger with id matching current as an update when fields differ', () => {
    const current = [
      { id: 'tr1', type: 'form_submission', name: 'Old', conditions: [] },
    ];
    const requested = [
      { id: 'tr1', type: 'form_submission', name: 'New', conditions: [{ field: 'x', operator: 'is-any-of', value: ['y'], type: 'string' }] },
    ];
    const diff = diffTriggers(current, requested);
    assert.equal(diff.updates.length, 1);
    assert.equal(diff.updates[0].id, 'tr1');
    assert.equal(diff.updates[0].name, 'New');
    assert.equal(diff.creates.length, 0);
    assert.equal(diff.deletes.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it('classifies a trigger with no id as a create', () => {
    const current = [];
    const requested = [{ type: 'form_submission', name: 'Brand New' }];
    const diff = diffTriggers(current, requested);
    assert.equal(diff.creates.length, 1);
    assert.equal(diff.creates[0].name, 'Brand New');
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.deletes.length, 0);
  });

  it('classifies a trigger whose id is not in current as a create', () => {
    const current = [{ id: 'tr1', type: 'form_submission', name: 'A', conditions: [] }];
    const requested = [{ id: 'tr-unknown', type: 'form_submission', name: 'A', conditions: [] }];
    const diff = diffTriggers(current, requested);
    assert.equal(diff.creates.length, 1);
    assert.equal(diff.creates[0].id, 'tr-unknown');
    // tr1 not in requested → delete
    assert.equal(diff.deletes.length, 1);
    assert.equal(diff.deletes[0].id, 'tr1');
  });

  it('classifies a current trigger missing from requested as a delete', () => {
    const current = [
      { id: 'tr1', type: 'form_submission', name: 'A', conditions: [] },
      { id: 'tr2', type: 'contact_tag', name: 'B', conditions: [] },
    ];
    const requested = [
      { id: 'tr1', type: 'form_submission', name: 'A', conditions: [] },
    ];
    const diff = diffTriggers(current, requested);
    assert.equal(diff.deletes.length, 1);
    assert.equal(diff.deletes[0].id, 'tr2');
    // tr1 byte-equal → unchanged, NOT updates
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.unchanged.length, 1);
    assert.equal(diff.unchanged[0].id, 'tr1');
  });

  it('empty requested array deletes ALL current triggers', () => {
    const current = [
      { id: 'tr1', type: 'form_submission', name: 'A', conditions: [] },
      { id: 'tr2', type: 'contact_tag', name: 'B', conditions: [] },
    ];
    const diff = diffTriggers(current, []);
    assert.equal(diff.deletes.length, 2);
    assert.deepStrictEqual(diff.deletes.map(t => t.id).sort(), ['tr1', 'tr2']);
    assert.equal(diff.creates.length, 0);
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it('classifies an identical trigger (same id, byte-equal otherwise) as unchanged, not update', () => {
    const trigger = { id: 'tr1', type: 'form_submission', name: 'A', conditions: [{ field: 'x', operator: 'is-any-of', value: ['y'], type: 'string' }] };
    const current = [trigger];
    // Same content but different object reference + key order
    const requested = [{ name: 'A', type: 'form_submission', id: 'tr1', conditions: [{ type: 'string', value: ['y'], operator: 'is-any-of', field: 'x' }] }];
    const diff = diffTriggers(current, requested);
    assert.equal(diff.unchanged.length, 1);
    assert.equal(diff.unchanged[0].id, 'tr1');
    assert.equal(diff.updates.length, 0);
  });
});

describe('diffAndWireActions — branch terminal steps do not cross-chain across parent boundaries', () => {
  it('does not auto-wire the last yes-branch child into the first no-branch child', () => {
    const outerId = 'outer-1';
    const yesId = 'yes-1';
    const noId = 'no-1';

    // Simulates the verbose flat structure for a branched workflow:
    // outer → [yes-branch, no-branch]
    //   yes-branch → email-a → email-b (should terminate)
    //   no-branch  → sms-c → sms-d (should terminate)
    const oldActions = [];
    const newActions = [
      { id: outerId, type: 'if_else', nodeType: 'condition-node', next: [yesId, noId], attributes: {} },
      { id: yesId, type: 'if_else', nodeType: 'branch-yes', parent: outerId, parentKey: outerId, sibling: [noId], next: 'a', attributes: {} },
      { id: noId, type: 'if_else', nodeType: 'branch-no', parent: outerId, parentKey: outerId, sibling: [yesId], next: 'c', attributes: {} },
      { id: 'a', type: 'email', name: 'Then-1', parent: yesId, parentKey: yesId, attributes: {} },
      { id: 'b', type: 'email', name: 'Then-2', parent: yesId, parentKey: yesId, attributes: {} },
      { id: 'c', type: 'sms', name: 'Else-1', parent: noId, parentKey: noId, attributes: {} },
      { id: 'd', type: 'sms', name: 'Else-2', parent: noId, parentKey: noId, attributes: {} },
    ];

    const { templates } = diffAndWireActions(oldActions, newActions);

    const thenLast = templates.find(t => t.id === 'b');
    const elseLast = templates.find(t => t.id === 'd');

    // The cross-chain bug: without the parent-boundary check, b.next would be 'c'
    // (the first else-child) because auto-wire sees 'c' as the next array element.
    assert.ok(!thenLast.next || thenLast.next === undefined,
      `then-terminal must NOT cross-chain to else-branch (got next: ${thenLast.next})`);
    assert.ok(!elseLast.next || elseLast.next === undefined,
      `else-terminal must NOT cross-chain (got next: ${elseLast.next})`);

    // Non-terminal children within the same branch SHOULD still auto-wire
    const thenFirst = templates.find(t => t.id === 'a');
    const elseFirst = templates.find(t => t.id === 'c');
    assert.equal(thenFirst.next, 'b', 'non-terminal then-child auto-wires within branch');
    assert.equal(elseFirst.next, 'd', 'non-terminal else-child auto-wires within branch');
  });

  it('still auto-wires flat linear chains without parent fields', () => {
    const newActions = [
      { id: 'x', type: 'email', name: 'Step 1', attributes: {} },
      { id: 'y', type: 'sms', name: 'Step 2', attributes: {} },
      { id: 'z', type: 'wait', name: 'Step 3', attributes: {} },
    ];
    const { templates } = diffAndWireActions([], newActions);
    assert.equal(templates[0].next, 'y', 'linear chain auto-wires normally');
    assert.equal(templates[1].next, 'z', 'linear chain auto-wires normally');
    assert.ok(!('next' in templates[2]), 'last step has no next');
  });
});

describe('buildActionChain — scaffold-expanded branch terminals do not cross-chain', () => {
  // Integration test: expandIfElse output → buildActionChain must not auto-wire
  // the last then-child to the first else-child.
  it('respects next:null on branch terminal steps from expander output', () => {
    // Simulate what expandIfElse produces for then:[A,B] else:[C,D]
    const outerId = 'outer-1';
    const yesId = 'yes-1';
    const noId = 'no-1';
    const actions = [
      { id: outerId, type: 'if_else', nodeType: 'condition-node', next: [yesId, noId], attributes: {} },
      { id: yesId, type: 'if_else', nodeType: 'branch-yes', parent: outerId, parentKey: outerId, sibling: [noId], next: 'a', attributes: {} },
      { id: noId, type: 'if_else', nodeType: 'branch-no', parent: outerId, parentKey: outerId, sibling: [yesId], next: 'c', attributes: {} },
      { id: 'a', type: 'email', name: 'Then-1', parent: yesId, parentKey: yesId, attributes: {} },
      { id: 'b', type: 'email', name: 'Then-2', parent: yesId, parentKey: yesId, next: null, attributes: {} },
      { id: 'c', type: 'sms', name: 'Else-1', parent: noId, parentKey: noId, attributes: {} },
      { id: 'd', type: 'sms', name: 'Else-2', parent: noId, parentKey: noId, next: null, attributes: {} },
    ];
    const { templates } = buildActionChain(actions);

    const thenLast = templates.find(t => t.id === 'b');
    const elseLast = templates.find(t => t.id === 'd');
    const elseFirst = templates.find(t => t.id === 'c');

    assert.strictEqual(thenLast.next, null, 'then-terminal must stay null, not auto-wire to else-first');
    assert.strictEqual(elseLast.next, null, 'else-terminal must stay null');
    // Also verify the non-terminal then-child DOES get auto-wired to its sibling
    const thenFirst = templates.find(t => t.id === 'a');
    assert.equal(thenFirst.next, 'b', 'non-terminal then-child should auto-wire to next then-child');
    assert.equal(elseFirst.next, 'd', 'non-terminal else-child should auto-wire to next else-child');
  });

  it('converges branch terminals to the next post-block step', () => {
    const outerId = 'outer-1';
    const yesId = 'yes-1';
    const noId = 'no-1';
    const actions = [
      { id: outerId, type: 'if_else', nodeType: 'condition-node', next: [yesId, noId], attributes: {} },
      { id: yesId, type: 'if_else', nodeType: 'branch-yes', parent: outerId, parentKey: outerId, sibling: [noId], next: 'a', attributes: {} },
      { id: noId, type: 'if_else', nodeType: 'branch-no', parent: outerId, parentKey: outerId, sibling: [yesId], next: 'c', attributes: {} },
      { id: 'a', type: 'email', name: 'Then-1', parent: yesId, parentKey: yesId, next: null, attributes: {} },
      { id: 'c', type: 'sms', name: 'Else-1', parent: noId, parentKey: noId, next: null, attributes: {} },
      { id: 'goal-1', type: 'workflow_goal', name: 'Goal', attributes: {} },
    ];
    const { templates } = buildActionChain(actions);

    const thenLast = templates.find(t => t.id === 'a');
    const elseLast = templates.find(t => t.id === 'c');
    assert.equal(thenLast.next, 'goal-1', 'then-terminal should converge to post-block step');
    assert.equal(elseLast.next, 'goal-1', 'else-terminal should converge to post-block step');
  });
});

