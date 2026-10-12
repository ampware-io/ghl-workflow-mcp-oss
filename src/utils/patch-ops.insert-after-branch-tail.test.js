import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { insertAfter } from './patch-ops.js';
import { diffAndWireActions, validateWiring } from './action-chain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'branched-workflow-real.json',
);

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function findTemplate(templates, id) {
  return templates.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// regression (260707-wmw): insert_after on a Shape-A branch tail must NOT
// cross-chain the inserted step into the sibling branch. The fixture is the
// real GHL wire model (condition-node outer + branch-yes/branch-no siblings +
// two branch-child tails), which patch-ops.test.js (Shape B) never exercises.
// ---------------------------------------------------------------------------

describe('insert_after on a Shape-A branch tail', () => {
  it('the fixture itself is well-formed (validateWiring returns [])', () => {
    const wf = loadFixture();
    assert.deepEqual(validateWiring(wf.actions), []);
  });

  it('(a) inserted step gets parent + parentKey + explicit next:null', () => {
    const wf = loadFixture();
    const out = insertAfter(wf, {
      after_step_id: 'update-1',
      step: { id: 'note-1', type: 'add_note', name: 'Note', attributes: {} },
    });
    const ins = out.actions.find((a) => a.id === 'note-1');
    assert.ok(ins, 'inserted step present');
    // parent/parentKey point at the step we inserted after (update-1), which is
    // itself a branch tail — this keeps the cross-chain guard's parent-boundary
    // check honest (the Task-1 fix: previously only parentKey was set).
    assert.equal(ins.parent, 'update-1', 'parent set to after_step_id (the Task-1 fix)');
    assert.equal(ins.parentKey, 'update-1', 'parentKey set to after_step_id');
    assert.equal(ins.next, null, 'branch-tail insert terminates with explicit null');
    // update-1 (old tail) now points at the inserted step
    const oldTail = out.actions.find((a) => a.id === 'update-1');
    assert.equal(oldTail.next, 'note-1');
  });

  it('(b) round-trip through diffAndWireActions does NOT cross-chain into sibling branch', () => {
    const wf = loadFixture();
    const oldActions = wf.actions;
    const inserted = insertAfter(wf, {
      after_step_id: 'update-1',
      step: { id: 'note-1', type: 'add_note', name: 'Note', attributes: {} },
    });

    // This is the REAL corruption path. On pre-fix code the inserted step had
    // no `parent` and no explicit `next`, so the auto-wire fallback cross-chained
    // it to `create-1` (the no-branch's first child) — the reported bug. After
    // the Task-1 fix it must resolve to null (a new branch tail). A wiring
    // violation would THROW here; either a throw or a wrong `next` fails.
    let result;
    assert.doesNotThrow(() => {
      result = diffAndWireActions(oldActions, inserted.actions);
    }, 'diffAndWireActions must not throw a wiring violation');

    const ins = findTemplate(result.templates, 'note-1');
    assert.ok(ins, 'inserted template present after round-trip');
    assert.notEqual(ins.next, 'create-1', 'must NOT cross-chain into sibling branch');
    assert.equal(ins.next, null, 'inserted step remains a branch tail (next:null)');
  });

  it('(c) validateWiring is clean after the round-trip', () => {
    const wf = loadFixture();
    const oldActions = wf.actions;
    const inserted = insertAfter(wf, {
      after_step_id: 'update-1',
      step: { id: 'note-1', type: 'add_note', name: 'Note', attributes: {} },
    });
    const result = diffAndWireActions(oldActions, inserted.actions);
    assert.deepEqual(validateWiring(result.templates), []);
  });

  it('refuses insert_after directly on a branch STEP (branch-yes) with branched_step_unsupported', () => {
    const wf = loadFixture();
    let err;
    try {
      insertAfter(wf, {
        after_step_id: 'by-1',
        step: { type: 'add_note', name: 'X', attributes: {} },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw');
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.branch_reason, 'branch_node');
  });

  it('refuses insert_after directly on the condition-node outer (next_is_array wins)', () => {
    const wf = loadFixture();
    let err;
    try {
      insertAfter(wf, {
        after_step_id: 'outer-1',
        step: { type: 'add_note', name: 'X', attributes: {} },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw');
    assert.equal(err.code, 'branched_step_unsupported');
    assert.equal(err.details.branch_reason, 'next_is_array');
  });
});
