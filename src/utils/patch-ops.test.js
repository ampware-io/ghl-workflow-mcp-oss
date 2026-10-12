import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isBranchedStep,
  insertAfter,
  updateStep,
  deleteStep,
  moveStep,
  rewireStep,
  addTrigger,
  updateTriggerOp,
  removeTrigger,
} from './patch-ops.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '..', '..', 'tests', 'fixtures', 'branched-workflow.json');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('isBranchedStep', () => {
  const fixture = loadFixture();
  const byId = Object.fromEntries(fixture.actions.map((a) => [a.id, a]));

  it('returns true for fixture S3 (branchYes/branchNo)', () => {
    assert.equal(isBranchedStep(byId.S3), true);
  });

  it('returns false for linear steps S1, S2, S4, S5', () => {
    assert.equal(isBranchedStep(byId.S1), false);
    assert.equal(isBranchedStep(byId.S2), false);
    assert.equal(isBranchedStep(byId.S4), false);
    assert.equal(isBranchedStep(byId.S5), false);
  });

  it('returns true when next is an array (next_is_array)', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', next: ['A', 'B'] }), true);
  });

  it('returns true when only branchYes is present', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', branchYes: 'A' }), true);
  });

  it('returns true when only branchNo is present', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', branchNo: 'A' }), true);
  });

  it('returns true when transitions has length > 1 (transitions_multi)', () => {
    assert.equal(
      isBranchedStep({
        id: 'X',
        type: 'foo',
        transitions: [{ to: 'A' }, { to: 'B' }],
      }),
      true,
    );
  });

  it('returns false when transitions has length <= 1', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', transitions: [{ to: 'A' }] }), false);
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', transitions: [] }), false);
  });

  it('returns true when multipathBranches is non-empty (multipath)', () => {
    assert.equal(
      isBranchedStep({ id: 'X', type: 'foo', multipathBranches: [{ name: 'p1' }] }),
      true,
    );
  });

  it('returns false when multipathBranches is empty array', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', multipathBranches: [] }), false);
  });

  it('returns false for plain step with scalar next and no branch fields', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo', next: 'Y' }), false);
  });

  it('returns false for step with no next at all (leaf)', () => {
    assert.equal(isBranchedStep({ id: 'X', type: 'foo' }), false);
  });
});

// Re-export for use across test sections in Task 2
export { loadFixture, UUID_RE, FIXTURE_PATH };

// ---------------------------------------------------------------------------
// Task 2: insertAfter / updateStep / deleteStep / moveStep
// ---------------------------------------------------------------------------

function findStep(workflow, id) {
  return workflow.actions.find((s) => s.id === id);
}

describe('insertAfter', () => {
  it('inserts a new step after S1, rewires pointers and renumbers order', () => {
    const wf = loadFixture();
    const newStep = {
      id: 'S1A',
      type: 'wait',
      name: 'Inserted wait',
      attributes: { duration: '5m' },
    };
    const out = insertAfter(wf, { after_step_id: 'S1', step: newStep });

    const s1 = findStep(out, 'S1');
    const ins = findStep(out, 'S1A');
    assert.equal(s1.next, 'S1A');
    assert.equal(ins.parentKey, 'S1');
    assert.equal(ins.next, 'S2'); // old S1.next
    // Order is contiguous 1..N
    const orders = out.actions.map((s) => s.order).sort((a, b) => a - b);
    assert.deepEqual(orders, [1, 2, 3, 4, 5, 6]);
    assert.equal(out.actions.length, 6);
  });

  it('generates a UUID id when step.id is omitted', () => {
    const wf = loadFixture();
    const out = insertAfter(wf, {
      after_step_id: 'S1',
      step: { type: 'wait', name: 'X', attributes: {} },
    });
    const s1 = findStep(out, 'S1');
    const ins = findStep(out, s1.next);
    assert.match(ins.id, UUID_RE);
    assert.equal(ins.parentKey, 'S1');
    assert.equal(ins.next, 'S2');
  });

  it('generates a UUID id when step.id is empty string', () => {
    const wf = loadFixture();
    const out = insertAfter(wf, {
      after_step_id: 'S2',
      step: { id: '', type: 'wait', name: 'X', attributes: {} },
    });
    const s2 = findStep(out, 'S2');
    const ins = findStep(out, s2.next);
    assert.match(ins.id, UUID_RE);
    assert.notEqual(ins.id, '');
  });

  it('uses caller-supplied step.id verbatim when provided', () => {
    const wf = loadFixture();
    const out = insertAfter(wf, {
      after_step_id: 'S1',
      step: { id: 'CUSTOM-ID-123', type: 'wait', name: 'X', attributes: {} },
    });
    assert.ok(findStep(out, 'CUSTOM-ID-123'));
  });

  it('throws branched_step_unsupported when targeting S3 (branchYes/No)', () => {
    const wf = loadFixture();
    let err;
    try {
      insertAfter(wf, {
        after_step_id: 'S3',
        step: { type: 'wait', name: 'X', attributes: {} },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw');
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.step_id, 'S3');
    assert.equal(err.details.branch_reason, 'branch_yes_no');
  });

  it('throws step_not_found with valid_step_ids when after_step_id is missing', () => {
    const wf = loadFixture();
    let err;
    try {
      insertAfter(wf, {
        after_step_id: 'NOPE',
        step: { type: 'wait', name: 'X', attributes: {} },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.equal(err.details.step_id, 'NOPE');
    assert.deepEqual(err.details.valid_step_ids, ['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('does not mutate the input workflow', () => {
    const wf = loadFixture();
    const snapshot = JSON.stringify(wf);
    insertAfter(wf, {
      after_step_id: 'S1',
      step: { id: 'NEW', type: 'wait', name: 'X', attributes: {} },
    });
    assert.equal(JSON.stringify(wf), snapshot);
  });
});

describe('updateStep', () => {
  it('deep-merges patch.attributes into target step', () => {
    const wf = loadFixture();
    const out = updateStep(wf, {
      step_id: 'S2',
      patch: { attributes: { subject: 'Updated subject' } },
    });
    const s2 = findStep(out, 'S2');
    assert.equal(s2.attributes.subject, 'Updated subject');
    assert.equal(s2.attributes.body, 'Hello!'); // preserved
  });

  it('merges top-level non-pointer fields like name', () => {
    const wf = loadFixture();
    const out = updateStep(wf, {
      step_id: 'S2',
      patch: { name: 'Renamed' },
    });
    assert.equal(findStep(out, 'S2').name, 'Renamed');
  });

  it('throws pointer_fields_forbidden when patch contains top-level next', () => {
    const wf = loadFixture();
    let err;
    try {
      updateStep(wf, { step_id: 'S2', patch: { next: 'S5' } });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'pointer_fields_forbidden');
    assert.equal(err.details.step_id, 'S2');
    assert.deepEqual(err.details.forbidden_fields_present, ['next']);
  });

  it('throws pointer_fields_forbidden listing all present forbidden fields', () => {
    const wf = loadFixture();
    let err;
    try {
      updateStep(wf, {
        step_id: 'S2',
        patch: { next: 'S5', parentKey: 'X', order: 99, attributes: {} },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'pointer_fields_forbidden');
    assert.deepEqual(
      err.details.forbidden_fields_present.slice().sort(),
      ['next', 'order', 'parentKey'],
    );
  });

  it('allows attribute-only update on a branched step (S3)', () => {
    const wf = loadFixture();
    const out = updateStep(wf, {
      step_id: 'S3',
      patch: { attributes: { condition: 'has_other_tag' } },
    });
    const s3 = findStep(out, 'S3');
    assert.equal(s3.attributes.condition, 'has_other_tag');
    // Branch pointers preserved
    assert.equal(s3.branchYes, 'S4');
    assert.equal(s3.branchNo, 'S5');
  });

  it('throws step_not_found with valid_step_ids for missing id', () => {
    const wf = loadFixture();
    let err;
    try {
      updateStep(wf, { step_id: 'NOPE', patch: { name: 'x' } });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.deepEqual(err.details.valid_step_ids, ['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('does not mutate the input workflow', () => {
    const wf = loadFixture();
    const snapshot = JSON.stringify(wf);
    updateStep(wf, { step_id: 'S2', patch: { attributes: { subject: 'Changed' } } });
    assert.equal(JSON.stringify(wf), snapshot);
  });

  it('allows next:null to terminate a non-branched step', () => {
    const wf = loadFixture();
    const out = updateStep(wf, { step_id: 'S2', patch: { next: null } });
    const s2 = findStep(out, 'S2');
    assert.strictEqual(s2.next, null, 'next should be explicitly null');
  });

  it('preserves other attributes when setting next:null', () => {
    const wf = loadFixture();
    const out = updateStep(wf, {
      step_id: 'S2',
      patch: { next: null, attributes: { subject: 'Updated' } },
    });
    const s2 = findStep(out, 'S2');
    assert.strictEqual(s2.next, null);
    assert.equal(s2.attributes.subject, 'Updated');
  });

  it('throws pointer_fields_forbidden for next:null on a branched step (S3)', () => {
    const wf = loadFixture();
    let err;
    try {
      updateStep(wf, { step_id: 'S3', patch: { next: null } });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw for next:null on branched step');
    assert.equal(err.code, 'pointer_fields_forbidden');
    assert.deepEqual(err.details.forbidden_fields_present, ['next']);
  });

  it('still rejects non-null next values (e.g. next: "S5")', () => {
    const wf = loadFixture();
    let err;
    try {
      updateStep(wf, { step_id: 'S2', patch: { next: 'S5' } });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'pointer_fields_forbidden');
    assert.deepEqual(err.details.forbidden_fields_present, ['next']);
  });

  it('sets advanceCanvasMeta.isDisabled to disable a step', () => {
    const wf = loadFixture();
    const out = updateStep(wf, {
      step_id: 'S2',
      patch: { advanceCanvasMeta: { isDisabled: true } },
    });
    const s2 = findStep(out, 'S2');
    assert.deepEqual(s2.advanceCanvasMeta, { isDisabled: true });
  });

  it('sets advanceCanvasMeta.isDisabled to false when patch is null (re-enable)', () => {
    const wf = loadFixture();
    // First disable
    const disabled = updateStep(wf, {
      step_id: 'S2',
      patch: { advanceCanvasMeta: { isDisabled: true } },
    });
    assert.deepEqual(findStep(disabled, 'S2').advanceCanvasMeta, { isDisabled: true });
    // Then re-enable
    const enabled = updateStep(disabled, {
      step_id: 'S2',
      patch: { advanceCanvasMeta: null },
    });
    assert.deepEqual(findStep(enabled, 'S2').advanceCanvasMeta, { isDisabled: false });
  });
});

describe('deleteStep', () => {
  it('removes S2 and patches S1.next to old S2.next (S3)', () => {
    const wf = loadFixture();
    const out = deleteStep(wf, { step_id: 'S2' });
    assert.equal(findStep(out, 'S2'), undefined);
    assert.equal(findStep(out, 'S1').next, 'S3');
    assert.equal(out.actions.length, 4);
    const orders = out.actions.map((s) => s.order).sort((a, b) => a - b);
    assert.deepEqual(orders, [1, 2, 3, 4]);
  });

  it('throws branched_step_unsupported when targeting S3', () => {
    const wf = loadFixture();
    let err;
    try {
      deleteStep(wf, { step_id: 'S3' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.branch_reason, 'branch_yes_no');
  });

  it('throws step_not_found for missing id', () => {
    const wf = loadFixture();
    let err;
    try {
      deleteStep(wf, { step_id: 'NOPE' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
  });

  it('does not mutate the input workflow', () => {
    const wf = loadFixture();
    const snapshot = JSON.stringify(wf);
    deleteStep(wf, { step_id: 'S2' });
    assert.equal(JSON.stringify(wf), snapshot);
  });
});

describe('moveStep', () => {
  it('moves S2 to after S4: rewires old + new neighbours', () => {
    const wf = loadFixture();
    const out = moveStep(wf, { step_id: 'S2', after_step_id: 'S4' });

    // Old predecessor S1.next was S2 → now points to old S2.next (S3)
    assert.equal(findStep(out, 'S1').next, 'S3');
    // New predecessor S4.next now = S2
    assert.equal(findStep(out, 'S4').next, 'S2');
    // Moved S2.next = old S4.next (undefined / not present)
    const s2 = findStep(out, 'S2');
    assert.equal('next' in s2 ? s2.next : undefined, undefined);
    // parentKey updated
    assert.equal(s2.parentKey, 'S4');
    // Length unchanged, order contiguous
    assert.equal(out.actions.length, 5);
    const orders = out.actions.map((s) => s.order).sort((a, b) => a - b);
    assert.deepEqual(orders, [1, 2, 3, 4, 5]);
  });

  it('throws branched_step_unsupported when moving S3 (branched source)', () => {
    const wf = loadFixture();
    let err;
    try {
      moveStep(wf, { step_id: 'S3', after_step_id: 'S4' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.step_id, 'S3');
  });

  it('throws branched_step_unsupported when target after_step_id is branched', () => {
    const wf = loadFixture();
    let err;
    try {
      moveStep(wf, { step_id: 'S4', after_step_id: 'S3' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.step_id, 'S3');
  });

  it('throws step_not_found for missing step_id', () => {
    const wf = loadFixture();
    let err;
    try {
      moveStep(wf, { step_id: 'NOPE', after_step_id: 'S4' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.equal(err.details.step_id, 'NOPE');
  });

  it('throws step_not_found for missing after_step_id', () => {
    const wf = loadFixture();
    let err;
    try {
      moveStep(wf, { step_id: 'S2', after_step_id: 'NOPE' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.equal(err.details.step_id, 'NOPE');
  });

  it('does not mutate the input workflow', () => {
    const wf = loadFixture();
    const snapshot = JSON.stringify(wf);
    moveStep(wf, { step_id: 'S2', after_step_id: 'S4' });
    assert.equal(JSON.stringify(wf), snapshot);
  });
});

describe('rewireStep', () => {
  it('rewires S1.next → S4 without repositioning or renumbering', () => {
    const wf = loadFixture();
    const out = rewireStep(wf, { step_id: 'S1', next: 'S4' });
    assert.equal(findStep(out, 'S1').next, 'S4');
    // Array position unchanged (no splice)
    assert.deepEqual(out.actions.map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
    // Order unchanged (no renumber)
    assert.deepEqual(out.actions.map((s) => s.order), [1, 2, 3, 4, 5]);
    // parentKey untouched
    assert.equal(findStep(out, 'S1').parentKey, null);
  });

  it('terminates a chain with next:null', () => {
    const wf = loadFixture();
    const out = rewireStep(wf, { step_id: 'S2', next: null });
    assert.strictEqual(findStep(out, 'S2').next, null);
  });

  it('throws step_not_found when the subject is missing', () => {
    const wf = loadFixture();
    let err;
    try {
      rewireStep(wf, { step_id: 'NOPE', next: 'S2' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.equal(err.details.step_id, 'NOPE');
  });

  it('throws step_not_found when the target is missing', () => {
    const wf = loadFixture();
    let err;
    try {
      rewireStep(wf, { step_id: 'S1', next: 'NOPE' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'step_not_found');
    assert.equal(err.details.step_id, 'NOPE');
    assert.deepEqual(err.details.valid_step_ids, ['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('throws branched_step_unsupported for a branched subject (S3)', () => {
    const wf = loadFixture();
    let err;
    try {
      rewireStep(wf, { step_id: 'S3', next: 'S4' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.branch_reason, 'branch_yes_no');
  });

  it('throws self_loop_forbidden when next === step_id', () => {
    const wf = loadFixture();
    let err;
    try {
      rewireStep(wf, { step_id: 'S1', next: 'S1' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'self_loop_forbidden');
    assert.equal(err.details.step_id, 'S1');
    assert.equal(err.details.next, 'S1');
  });

  it('does not mutate the input workflow', () => {
    const wf = loadFixture();
    const snapshot = JSON.stringify(wf);
    rewireStep(wf, { step_id: 'S1', next: 'S4' });
    assert.equal(JSON.stringify(wf), snapshot);
  });
});

// ---------------------------------------------------------------------------
// 260426-lf7: addTrigger / updateTriggerOp / removeTrigger pure helpers.
// These mutate clone.pendingTriggerOps[] only — never fire HTTP.
// The patch_workflow handler replays pendingTriggerOps into an updateWorkflow
// triggers payload after the dry-run loop completes.
// ---------------------------------------------------------------------------

function makeTriggerWorkflow(overrides = {}) {
  return {
    _id: 'wf-1',
    name: 'WF',
    triggers: [
      { id: 'trA', type: 'form_submission', name: 'Form A', conditions: [] },
      { id: 'trB', type: 'contact_tag', name: 'Tag B', conditions: [] },
    ],
    actions: [],
    ...overrides,
  };
}

describe('addTrigger', () => {
  it('initializes pendingTriggerOps to [] and appends a {kind:create} entry', () => {
    const wf = makeTriggerWorkflow();
    const trigger = { type: 'form_submission', name: 'Brand New' };
    const out = addTrigger(wf, { trigger });

    assert.ok(Array.isArray(out.pendingTriggerOps), 'pendingTriggerOps should exist on output');
    assert.equal(out.pendingTriggerOps.length, 1);
    assert.equal(out.pendingTriggerOps[0].kind, 'create');
    assert.deepEqual(out.pendingTriggerOps[0].trigger, trigger);
  });

  it('appends to existing pendingTriggerOps without losing prior entries', () => {
    const wf = makeTriggerWorkflow({ pendingTriggerOps: [{ kind: 'delete', triggerId: 'trA' }] });
    const trigger = { type: 'form_submission', name: 'Second' };
    const out = addTrigger(wf, { trigger });

    assert.equal(out.pendingTriggerOps.length, 2);
    assert.equal(out.pendingTriggerOps[0].kind, 'delete');
    assert.equal(out.pendingTriggerOps[1].kind, 'create');
    assert.equal(out.pendingTriggerOps[1].trigger.name, 'Second');
  });

  it('does not mutate the input workflow', () => {
    const wf = makeTriggerWorkflow();
    const snapshot = JSON.stringify(wf);
    const out = addTrigger(wf, { trigger: { type: 'form_submission', name: 'X' } });
    assert.equal(JSON.stringify(wf), snapshot);
    assert.notEqual(out, wf);
    assert.equal(wf.pendingTriggerOps, undefined);
  });
});

describe('updateTriggerOp', () => {
  it('throws trigger_not_found with valid_trigger_ids when id is missing', () => {
    const wf = makeTriggerWorkflow();
    let err;
    try {
      updateTriggerOp(wf, { trigger_id: 'nope', patch: { name: 'New' } });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'trigger_not_found');
    assert.equal(err.details.trigger_id, 'nope');
    assert.deepEqual(err.details.valid_trigger_ids, ['trA', 'trB']);
  });

  it('appends an {kind:update} entry on success', () => {
    const wf = makeTriggerWorkflow();
    const out = updateTriggerOp(wf, { trigger_id: 'trA', patch: { name: 'Renamed' } });

    assert.equal(out.pendingTriggerOps.length, 1);
    assert.equal(out.pendingTriggerOps[0].kind, 'update');
    assert.equal(out.pendingTriggerOps[0].triggerId, 'trA');
    assert.deepEqual(out.pendingTriggerOps[0].patch, { name: 'Renamed' });
  });

  it('does not mutate the input workflow', () => {
    const wf = makeTriggerWorkflow();
    const snapshot = JSON.stringify(wf);
    const out = updateTriggerOp(wf, { trigger_id: 'trA', patch: { name: 'X' } });
    assert.equal(JSON.stringify(wf), snapshot);
    assert.notEqual(out, wf);
    assert.equal(wf.pendingTriggerOps, undefined);
  });
});

describe('removeTrigger', () => {
  it('throws trigger_not_found for unknown id', () => {
    const wf = makeTriggerWorkflow();
    let err;
    try {
      removeTrigger(wf, { trigger_id: 'gone' });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'trigger_not_found');
    assert.equal(err.details.trigger_id, 'gone');
    assert.deepEqual(err.details.valid_trigger_ids, ['trA', 'trB']);
  });

  it('appends a {kind:delete} entry on success', () => {
    const wf = makeTriggerWorkflow();
    const out = removeTrigger(wf, { trigger_id: 'trB' });

    assert.equal(out.pendingTriggerOps.length, 1);
    assert.equal(out.pendingTriggerOps[0].kind, 'delete');
    assert.equal(out.pendingTriggerOps[0].triggerId, 'trB');
  });

  it('does not mutate the input workflow', () => {
    const wf = makeTriggerWorkflow();
    const snapshot = JSON.stringify(wf);
    const out = removeTrigger(wf, { trigger_id: 'trB' });
    assert.equal(JSON.stringify(wf), snapshot);
    assert.notEqual(out, wf);
    assert.equal(wf.pendingTriggerOps, undefined);
  });
});

