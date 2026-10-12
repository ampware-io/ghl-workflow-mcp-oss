import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWiring, diffAndWireActions } from './action-chain.js';

/**
 * Phase 17 Plan 02 — pre-flight wiring validator (D-06, D-07, D-08, D-16).
 *
 * V1-V8: validateWiring detects each violation class with the structured shape.
 * V9-V12: diffAndWireActions throws on violations (post-fallback) with a
 *         formatted summary that names class + offending id (and never leaks
 *         attributes content per T-17-02-01).
 */

describe('validateWiring — dangling-next class (D-06)', () => {
  it('V1: detects dangling string next', () => {
    const violations = validateWiring([
      { id: 'a', name: 'A', type: 'sms', next: 'MISSING' },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'dangling-next');
    assert.equal(violations[0].templateId, 'a');
    assert.equal(violations[0].offendingId, 'MISSING');
    assert.equal(violations[0].pointer, 'next');
  });

  it('V2: detects dangling array element while ignoring valid neighbours', () => {
    const violations = validateWiring([
      { id: 'wait', name: 'Wait', type: 'wait_email_event', next: ['t1', 't-MISSING'] },
      { id: 't1', name: 'T1', type: 'sms' },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'dangling-next');
    assert.equal(violations[0].templateId, 'wait');
    assert.equal(violations[0].offendingId, 't-MISSING');
    assert.equal(violations[0].pointer, 'next');
  });

  it('V3: detects dangling goto targetNodeId with pointer discriminator', () => {
    const violations = validateWiring([
      { id: 'g', name: 'Loop', type: 'goto', attributes: { targetNodeId: 'MISSING' } },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'dangling-next');
    assert.equal(violations[0].templateId, 'g');
    assert.equal(violations[0].offendingId, 'MISSING');
    assert.equal(violations[0].pointer, 'targetNodeId');
  });
});

describe('validateWiring — broken-sibling-pair class (D-06)', () => {
  it('V4: detects sibling-array non-reciprocal', () => {
    const violations = validateWiring([
      { id: 'outer', name: 'If', type: 'if_else', next: ['by', 'bn'] },
      {
        id: 'by',
        name: 'Yes',
        type: 'condition-node-group',
        nodeType: 'branch-yes',
        parent: 'outer',
        sibling: ['SOMETHING-ELSE'],
      },
      {
        id: 'bn',
        name: 'No',
        type: 'condition-node-group',
        nodeType: 'branch-no',
        parent: 'outer',
        sibling: ['by'],
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'broken-sibling-pair');
    assert.equal(violations[0].outerId, 'outer');
    assert.equal(violations[0].reason, 'sibling-array-mismatch');
    assert.deepEqual(violations[0].offendingIds.sort(), ['bn', 'by']);
  });

  it('V5: detects only-one-branch-found (count !== 2)', () => {
    const violations = validateWiring([
      { id: 'outer', name: 'If', type: 'if_else', next: ['by'] },
      {
        id: 'by',
        name: 'Yes',
        type: 'condition-node-group',
        nodeType: 'branch-yes',
        parent: 'outer',
        sibling: [],
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'broken-sibling-pair');
    assert.equal(violations[0].outerId, 'outer');
    assert.deepEqual(violations[0].found, ['by']);
  });

  it('V6: detects two branch-yes / no branch-no (nodeType not paired)', () => {
    const violations = validateWiring([
      { id: 'outer', name: 'If', type: 'if_else', next: ['by1', 'by2'] },
      {
        id: 'by1',
        name: 'Yes 1',
        type: 'condition-node-group',
        nodeType: 'branch-yes',
        parent: 'outer',
        sibling: ['by2'],
      },
      {
        id: 'by2',
        name: 'Yes 2',
        type: 'condition-node-group',
        nodeType: 'branch-yes',
        parent: 'outer',
        sibling: ['by1'],
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'broken-sibling-pair');
    assert.equal(violations[0].outerId, 'outer');
    assert.equal(violations[0].reason, 'nodeType-not-paired');
    assert.deepEqual(violations[0].offendingIds.sort(), ['by1', 'by2']);
  });
});

describe('validateWiring — orphan class (D-06)', () => {
  it('V7: detects orphan template (not first, no next pointer to it, no parent)', () => {
    const violations = validateWiring([
      { id: 'a', name: 'A', type: 'sms', next: 'b' },
      { id: 'b', name: 'B', type: 'sms' },
      { id: 'orphan', name: 'Hidden', type: 'sms' },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].class, 'orphan');
    assert.equal(violations[0].templateId, 'orphan');
    assert.equal(violations[0].templateName, 'Hidden');
  });

  it('V8: branch children with valid parent + reachable from outer.next array are NOT orphans', () => {
    const violations = validateWiring([
      { id: 'outer', name: 'If', type: 'if_else', next: ['by', 'bn'] },
      {
        id: 'by',
        name: 'Yes',
        type: 'condition-node-group',
        nodeType: 'branch-yes',
        parent: 'outer',
        sibling: ['bn'],
      },
      {
        id: 'bn',
        name: 'No',
        type: 'condition-node-group',
        nodeType: 'branch-no',
        parent: 'outer',
        sibling: ['by'],
      },
    ]);
    assert.deepEqual(violations, []);
  });
});

describe('validateWiring — purity contract (D-07)', () => {
  it('V11: returns array (never throws) for invalid input', () => {
    assert.doesNotThrow(() => validateWiring([{ id: 'a', name: 'A', type: 'sms', next: 'MISSING' }]));
    const v = validateWiring([{ id: 'a', name: 'A', type: 'sms', next: 'MISSING' }]);
    assert.equal(Array.isArray(v), true);
    assert.equal(v.length, 1);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(validateWiring([]), []);
  });
});

describe('diffAndWireActions — throws on violations (D-07)', () => {
  it('V9: throws naming dangling-next class + offending id + template name', () => {
    assert.throws(
      () => diffAndWireActions([], [{ type: 'sms', name: 'A', next: 'MISSING' }]),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.match(err.message, /dangling-next/);
        assert.match(err.message, /MISSING/);
        assert.match(err.message, /"A"|'A'|\bA\b/);
        return true;
      },
    );
  });

  it('V12: throws containing both class strings when multiple violations exist', () => {
    // One dangling-next + one orphan in the same payload.
    assert.throws(
      () => diffAndWireActions(
        [],
        [
          { id: 'a', type: 'sms', name: 'A', next: 'MISSING' },
          { id: 'orphan', type: 'sms', name: 'Hidden' },
        ],
      ),
      (err) => {
        assert.match(err.message, /dangling-next/);
        assert.match(err.message, /orphan/);
        return true;
      },
    );
  });

  it('error message does NOT leak attributes content (T-17-02-01 / PII guard)', () => {
    const SECRET = 'sensitive-email-subject@example.com';
    let caught;
    try {
      diffAndWireActions(
        [],
        [
          {
            type: 'send_email',
            name: 'Email Step',
            attributes: { subject: SECRET, body: 'private body content' },
            next: 'MISSING',
          },
        ],
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'must throw');
    assert.equal(
      caught.message.includes(SECRET),
      false,
      `error message must not leak attributes content; got: ${caught.message}`,
    );
    assert.equal(
      caught.message.includes('private body content'),
      false,
      `error message must not leak body content; got: ${caught.message}`,
    );
  });
});

describe('validateWiring — D-08: validation runs on FINAL post-fallback templates', () => {
  it('V10: per-template fallback fills next; validator sees no dangling pointer (no throw)', () => {
    // Caller omits next entirely on both actions. Plan 17-01 fallback wires
    // templates[0].next = templates[1].id post-build. Validator must NOT
    // see a dangling pointer — proves it runs AFTER the fallback (D-08).
    assert.doesNotThrow(() => {
      diffAndWireActions(
        [],
        [
          { type: 'a', name: 'A' },
          { type: 'b', name: 'B' },
        ],
      );
    });
  });
});
