import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandIfElse } from './action-expander.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('expandIfElse — SPEC #5 fixture #1 (scaffold → verbose)', () => {
  it('expands a then:[] / else:[<email>] scaffold into 4 templates with correct wiring', () => {
    const input = [{
      type: 'if_else',
      name: 'Check tag',
      attributes: {
        conditions: [{
          conditionType: 'contact_detail',
          conditionSubType: 'tags',
          conditionOperator: 'contains',
          value: 'package purchaser',
        }],
      },
      then: [],
      else: [{ type: 'email', name: 'Follow-up', attributes: { subject: 'X', html: '<p>x</p>' } }],
    }];
    const out = expandIfElse(input);
    assert.equal(out.length, 4, 'expected 4 templates: outer + branch-yes + branch-no + email child');

    const [outer, yes, no, email] = out;

    // Outer
    assert.equal(outer.type, 'if_else');
    assert.equal(outer.nodeType, 'condition-node');
    assert.ok(Array.isArray(outer.next) && outer.next.length === 2);
    assert.equal(outer.then, undefined, 'scaffold-only field then should be stripped from outer');
    assert.equal(outer.else, undefined, 'scaffold-only field else should be stripped from outer');

    // Branch-yes (empty then -> next undefined)
    assert.equal(yes.nodeType, 'branch-yes');
    assert.equal(yes.next, undefined);
    assert.deepEqual(yes.sibling, [no.id]);
    assert.equal(yes.parent, outer.id);
    assert.equal(yes.parentKey, outer.id);

    // Branch-no (else has email -> next = email.id)
    assert.equal(no.nodeType, 'branch-no');
    assert.equal(no.next, email.id);
    assert.deepEqual(no.sibling, [yes.id]);
    assert.equal(no.parent, outer.id);
    assert.equal(no.parentKey, outer.id);

    // Email child
    assert.equal(email.parent, no.id);
    assert.equal(email.parentKey, no.id);

    // Outer.next references both siblings
    assert.deepEqual(outer.next, [yes.id, no.id]);
  });
});

describe('expandIfElse — SPEC #5 fixture #2 (verbose passthrough)', () => {
  it('passes a verbose-form if_else through unchanged', () => {
    const input = [
      { id: 'o1', type: 'if_else', nodeType: 'condition-node', next: ['y1', 'n1'], attributes: { branches: [] } },
      { id: 'y1', type: 'if_else', nodeType: 'branch-yes', parent: 'o1', parentKey: 'o1', sibling: ['n1'], attributes: {} },
      { id: 'n1', type: 'if_else', nodeType: 'branch-no', parent: 'o1', parentKey: 'o1', sibling: ['y1'], attributes: {} },
    ];
    const out = expandIfElse(input);
    assert.deepEqual(out, input, 'verbose form must passthrough unchanged');
  });
});

describe('expandIfElse — recursion', () => {
  it('expands nested if_else inside then[]', () => {
    const input = [{
      type: 'if_else', name: 'outer', attributes: { conditions: [] },
      then: [{
        type: 'if_else', name: 'inner', attributes: { conditions: [] },
        then: [{ type: 'email', name: 'inner-yes-email', attributes: { subject: '', html: '' } }],
        else: [],
      }],
      else: [],
    }];
    const out = expandIfElse(input);
    // Outer: 3 siblings. Inner: 3 siblings + 1 email child = 4. Total = 3 + 4 = 7.
    assert.equal(out.length, 7);
    const conditionNodes = out.filter((t) => t.nodeType === 'condition-node');
    assert.equal(conditionNodes.length, 2);
    const yesBranches = out.filter((t) => t.nodeType === 'branch-yes');
    assert.equal(yesBranches.length, 2);
  });
});

describe('expandIfElse — empty branches (D-08)', () => {
  it('then:[] and else:[] produces 3 templates with both branch siblings next: undefined', () => {
    const out = expandIfElse([{ type: 'if_else', name: 'no-op', attributes: {}, then: [], else: [] }]);
    assert.equal(out.length, 3);
    const [outer, yes, no] = out;
    assert.equal(outer.nodeType, 'condition-node');
    assert.equal(yes.next, undefined);
    assert.equal(no.next, undefined);
  });
});

describe('expandIfElse — mixed-form rejection (D-08)', () => {
  it('throws Error with class malformed-if-else when then[] contains nodeType: branch-yes', () => {
    const input = [{
      type: 'if_else', name: 'mixed', attributes: {},
      then: [{ type: 'if_else', nodeType: 'branch-yes', name: 'oops' }],
      else: [],
    }];
    assert.throws(
      () => expandIfElse(input),
      (err) => {
        assert.equal(err.class, 'malformed-if-else');
        assert.ok(typeof err.reason === 'string' && err.reason.length > 0, 'err.reason must be set');
        assert.match(err.message, /malformed-if-else/);
        return true;
      },
    );
  });

  it('throws when else[] contains nodeType: condition-node', () => {
    const input = [{
      type: 'if_else', name: 'mixed', attributes: {},
      then: [],
      else: [{ type: 'if_else', nodeType: 'condition-node', name: 'oops' }],
    }];
    assert.throws(() => expandIfElse(input), (err) => err.class === 'malformed-if-else');
  });
});

describe('expandIfElse — SPEC #8 scaffold-less wrong-shape rejection (EOI canonical failure)', () => {
  it('throws malformed-if-else for type:if_else with attributes.conditions but no then/else and no nodeType', () => {
    const input = [{
      type: 'if_else',
      name: 'EOI-style if_else',
      attributes: {
        conditions: [{
          conditionType: 'contact_detail',
          conditionSubType: 'tags',
          conditionOperator: 'contains',
          value: 'package purchaser',
        }],
      },
      // NO then, NO else, NO nodeType, NO attributes.branches → the EOI canonical failure
    }];
    assert.throws(
      () => expandIfElse(input),
      (err) => {
        assert.equal(err.class, 'malformed-if-else',
          'SPEC #8: scaffold-less wrong-shape if_else MUST be HARD-rejected with class malformed-if-else');
        assert.ok(typeof err.reason === 'string' && err.reason.length > 0, 'err.reason must be set');
        assert.match(err.message, /then\/else/, 'error message must point at the then/else scaffold');
        assert.match(err.message, /Docs MCP/, 'error message must point at the Docs MCP reference');
        return true;
      },
    );
  });

  it('does NOT reject verbose form (nodeType:condition-node + attributes.branches)', () => {
    const input = [{
      type: 'if_else', nodeType: 'condition-node', next: ['y', 'n'],
      attributes: { branches: [] },
    }];
    assert.doesNotThrow(() => expandIfElse(input));
  });

  it('does NOT reject scaffold form (then/else arrays present, even with attributes.conditions)', () => {
    const input = [{
      type: 'if_else',
      attributes: { conditions: [] },
      then: [], else: [],
    }];
    assert.doesNotThrow(() => expandIfElse(input));
  });

  it('does NOT reject if_else with attributes.branches set (and no scaffold) — passes through to validator', () => {
    const input = [{
      type: 'if_else',
      attributes: { branches: [] },
      // No conditions, no scaffold, no nodeType — passes through (validator handles)
    }];
    assert.doesNotThrow(() => expandIfElse(input));
  });
});

describe('expandIfElse — UUID + caller id discipline (D-07)', () => {
  it('branch-yes and branch-no IDs are fresh UUID v4', () => {
    const out = expandIfElse([{ type: 'if_else', attributes: {}, then: [], else: [] }]);
    const [, yes, no] = out;
    assert.match(yes.id, UUID_RE);
    assert.match(no.id, UUID_RE);
    assert.notEqual(yes.id, no.id);
  });

  it('preserves caller-supplied outer id', () => {
    const out = expandIfElse([{ id: 'outer-abc', type: 'if_else', attributes: {}, then: [], else: [] }]);
    assert.equal(out[0].id, 'outer-abc');
    assert.match(out[1].id, UUID_RE);
    assert.match(out[2].id, UUID_RE);
  });

  it('preserves caller passthrough fields on outer (cat, comments, version)', () => {
    const out = expandIfElse([{
      type: 'if_else', name: 'X', attributes: {},
      cat: 'condition', comments: 'note', version: 1,
      then: [], else: [],
    }]);
    const outer = out[0];
    assert.equal(outer.cat, 'condition');
    assert.equal(outer.comments, 'note');
    assert.equal(outer.version, 1);
  });

  it('uses attributes.branches[0].label / [1].label for branch sibling names if present', () => {
    const out = expandIfElse([{
      type: 'if_else', attributes: { branches: [{ label: 'Hot lead' }, { label: 'Cold lead' }] },
      then: [], else: [],
    }]);
    assert.equal(out[1].name, 'Hot lead');
    assert.equal(out[2].name, 'Cold lead');
  });
});

describe('expandIfElse — branch terminal next:null (cross-chain prevention)', () => {
  it('sets next:null on the last child of each branch to prevent auto-wire cross-chaining', () => {
    const input = [{
      type: 'if_else', name: 'Branch', attributes: {},
      then: [
        { type: 'email', name: 'Then-1', attributes: {} },
        { type: 'email', name: 'Then-2', attributes: {} },
      ],
      else: [
        { type: 'sms', name: 'Else-1', attributes: {} },
        { type: 'sms', name: 'Else-2', attributes: {} },
      ],
    }];
    const out = expandIfElse(input);
    // [outer, branch-yes, branch-no, then-1, then-2, else-1, else-2]
    assert.equal(out.length, 7);

    const then2 = out[4]; // last then-child
    const else2 = out[6]; // last else-child
    assert.equal(then2.name, 'Then-2');
    assert.equal(else2.name, 'Else-2');
    assert.strictEqual(then2.next, null, 'last then-child must have next:null to prevent cross-chain');
    assert.strictEqual(else2.next, null, 'last else-child must have next:null to prevent cross-chain');
  });

  it('sets next:null on single-step branches', () => {
    const input = [{
      type: 'if_else', name: 'Branch', attributes: {},
      then: [{ type: 'email', name: 'Only-then', attributes: {} }],
      else: [{ type: 'sms', name: 'Only-else', attributes: {} }],
    }];
    const out = expandIfElse(input);
    // [outer, branch-yes, branch-no, only-then, only-else]
    assert.equal(out.length, 5);
    assert.strictEqual(out[3].next, null, 'single then-child must terminate');
    assert.strictEqual(out[4].next, null, 'single else-child must terminate');
  });

  it('does not add next:null when branch is empty (no children to terminate)', () => {
    const out = expandIfElse([{
      type: 'if_else', name: 'empty', attributes: {}, then: [], else: [],
    }]);
    assert.equal(out.length, 3); // outer + 2 siblings only
    assert.equal(out[1].next, undefined, 'empty yes-branch sibling has no next');
    assert.equal(out[2].next, undefined, 'empty no-branch sibling has no next');
  });

  it('sets next:null on then-child but not on empty else (asymmetric branches)', () => {
    const input = [{
      type: 'if_else', name: 'one-sided', attributes: {},
      then: [{ type: 'email', name: 'A', attributes: {} }],
      else: [],
    }];
    const out = expandIfElse(input);
    // [outer, branch-yes, branch-no, A]
    assert.equal(out.length, 4);
    assert.strictEqual(out[3].next, null, 'then-child must terminate even when else is empty');
  });
});

describe('expandIfElse — passthrough of non-if_else actions', () => {
  it('returns flat array of non-if_else actions unchanged', () => {
    const input = [
      { type: 'email', name: 'A', attributes: { subject: '', html: '' } },
      { type: 'sms', name: 'B', attributes: { message: '' } },
    ];
    const out = expandIfElse(input);
    assert.deepEqual(out, input);
  });

  it('handles undefined input as empty array', () => {
    assert.deepEqual(expandIfElse(undefined), []);
  });
});
