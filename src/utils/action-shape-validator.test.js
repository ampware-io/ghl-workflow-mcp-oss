import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateActionShapes } from './action-shape-validator.js';

const FIXTURE_REGISTRY = {
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
    // SOFT-tier exemplar: a captured type that is NOT in DEEP_CHECKS, so a
    // malformed shape still SOFT-strips (email is now deep-checked → rejects,
    // regression). Used by the malformed-shape-stripped + security tests.
    add_note: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [
        { key: 'note', jsType: 'string' },
      ],
      defaultAttributes: { note: '' },
    },
    send_whatsapp_template: {
      category: 'Integration',
      shapeStatus: 'unverified',
      requiredAttributes: [],
      defaultAttributes: {},
    },
    if_else: {
      category: 'Native',
      shapeStatus: 'captured',
      requiredAttributes: [{ key: 'branches', jsType: 'array' }],
      defaultAttributes: { branches: [] },
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

describe('validateActionShapes — HARD class (unknown-type) (SPEC #2)', () => {
  it('drops actions with unknown types and reports skippedActions with class unknown-type', () => {
    const result = validateActionShapes(
      [{ type: 'update_opportunity_pipeline', name: 'Move', attributes: {} }],
      [],
      FIXTURE_REGISTRY,
    );
    assert.equal(result.sanitized.actions.length, 0);
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'unknown-type');
    assert.equal(result.skippedActions[0].kind, 'action');
    assert.equal(result.skippedActions[0].type, 'update_opportunity_pipeline');
    assert.equal(result.warnings.length, 0);
  });

  it('drops triggers with unknown types and tags kind=trigger', () => {
    const result = validateActionShapes(
      [],
      [{ type: 'frobnicate', name: 'X' }],
      FIXTURE_REGISTRY,
    );
    assert.equal(result.sanitized.triggers.length, 0);
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].kind, 'trigger');
    assert.equal(result.skippedActions[0].class, 'unknown-type');
  });

  it('drops items with missing type field', () => {
    const result = validateActionShapes([{ name: 'No type' }], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 0);
    assert.equal(result.skippedActions[0].class, 'unknown-type');
    assert.equal(result.skippedActions[0].type, '(missing)');
  });
});

describe('validateActionShapes — SOFT class (malformed-shape-stripped) (SPEC #2)', () => {
  it('replaces attributes with defaultAttributes and keeps the step', () => {
    const result = validateActionShapes(
      [{ type: 'add_note', name: 'Welcome', attributes: { garbage: 'value' } }],
      [],
      FIXTURE_REGISTRY,
    );
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, { note: '' });
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'malformed-shape-stripped');
    assert.equal(result.warnings.length, 0);
  });

  it('preserves caller-supplied wiring fields (id, next, parent, sibling, parentKey, nodeType) on SOFT salvage', () => {
    const result = validateActionShapes(
      [
        {
          type: 'add_note',
          name: 'X',
          attributes: { wrong: 1 },
          id: 'abc',
          next: 'xyz',
          parent: 'p1',
          sibling: ['s1'],
          parentKey: 'p1',
          nodeType: 'something',
          cat: 'Email',
          comments: '',
        },
      ],
      [],
      FIXTURE_REGISTRY,
    );
    const out = result.sanitized.actions[0];
    assert.equal(out.id, 'abc');
    assert.equal(out.next, 'xyz');
    assert.equal(out.parent, 'p1');
    assert.deepEqual(out.sibling, ['s1']);
    assert.equal(out.parentKey, 'p1');
    assert.equal(out.nodeType, 'something');
  });

  it('SOFT-salvages when attributes is null', () => {
    const result = validateActionShapes(
      [{ type: 'add_note', name: 'X', attributes: null }],
      [],
      FIXTURE_REGISTRY,
    );
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, { note: '' });
    assert.equal(result.skippedActions[0].class, 'malformed-shape-stripped');
  });
});

describe('validateActionShapes — HARD class (malformed-if-else) (SPEC #8 EOI canonical case)', () => {
  it('HARD-rejects scaffold-less if_else with attributes.conditions and no attributes.branches', () => {
    const result = validateActionShapes(
      [
        {
          type: 'if_else',
          name: 'Has package?',
          attributes: { conditions: [{ conditionType: 'contact_detail', value: 'pkg' }] },
        },
      ],
      [],
      FIXTURE_REGISTRY,
    );
    assert.equal(result.sanitized.actions.length, 0);
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'malformed-if-else');
    assert.equal(result.skippedActions[0].kind, 'action');
    assert.equal(result.skippedActions[0].type, 'if_else');
    assert.match(result.skippedActions[0].reason, /then\/else scaffold/);
  });

  it('PASSES if_else with the then/else scaffold (defers to expander)', () => {
    const action = {
      type: 'if_else',
      name: 'Scaffold form',
      attributes: { conditions: [] },
      then: [],
      else: [],
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    // Scaffold form is not HARD-rejected here — expander owns expansion.
    // attributes.branches is missing so SOFT-replaces with defaultAttributes — that's OK,
    // but the scaffold-less HARD path must NOT fire.
    const malformed = result.skippedActions.find((s) => s.class === 'malformed-if-else');
    assert.equal(malformed, undefined, 'scaffold form must not trip malformed-if-else');
  });

  it('PASSES verbose if_else (nodeType: condition-node) without HARD-rejecting', () => {
    const action = {
      type: 'if_else',
      name: 'Verbose',
      nodeType: 'condition-node',
      attributes: { branches: [] },
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    const malformed = result.skippedActions.find((s) => s.class === 'malformed-if-else');
    assert.equal(malformed, undefined);
    assert.equal(result.sanitized.actions.length, 1);
  });
});

describe('validateActionShapes — branch sibling passthrough (branch-yes / branch-no)', () => {
  it('passes branch-no with {else:true} attributes unchanged (no SOFT strip)', () => {
    const action = {
      type: 'if_else',
      name: 'Prospect (no purchase)',
      nodeType: 'branch-no',
      parent: 'cond-1',
      parentKey: 'cond-1',
      sibling: ['yes-1'],
      attributes: { else: true },
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, { else: true },
      'branch-no attributes must survive, not be replaced with condition-node defaults');
    assert.equal(result.skippedActions.length, 0, 'no SOFT strip for branch siblings');
  });

  it('passes branch-yes with empty attributes unchanged', () => {
    const action = {
      type: 'if_else',
      name: 'Purchased',
      nodeType: 'branch-yes',
      parent: 'cond-1',
      parentKey: 'cond-1',
      sibling: ['no-1'],
      attributes: {},
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, {});
    assert.equal(result.skippedActions.length, 0);
  });
});

describe('validateActionShapes — WARN class (unverified-shape) (SPEC #2)', () => {
  it('passes the step through unchanged with a warnings entry', () => {
    const action = { type: 'send_whatsapp_template', name: 'WA', attributes: { message: 'hi' } };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action); // verbatim
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].class, 'unverified-shape');
    assert.equal(result.skippedActions.length, 0);
  });
});

describe('validateActionShapes — PASS', () => {
  it('emits well-shaped action unchanged with no entries', () => {
    const action = { type: 'email', name: 'OK', attributes: { subject: 'Hi', html: '<p>x</p>' } };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });
});

describe('validateActionShapes — ACTION_TYPE_ALIASES', () => {
  it('send_email aliases to the email shape and survives validation', () => {
    const action = {
      type: 'send_email',
      name: 'Aliased',
      attributes: { subject: 'Hi', html: '<p>x</p>' },
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(result.sanitized.actions.length, 1, 'aliased type must not HARD-drop');
    assert.equal(result.skippedActions.length, 0);
  });

  it('alias preserves the caller original type on the emitted action', () => {
    const action = {
      type: 'send_email',
      name: 'Aliased',
      attributes: { subject: 'Hi', html: '<p>x</p>' },
    };
    const result = validateActionShapes([action], [], FIXTURE_REGISTRY);
    assert.equal(
      result.sanitized.actions[0].type,
      'send_email',
      'alias only selects the shape entry — item.type must round-trip unchanged',
    );
  });
});

describe('validateActionShapes — security & edge cases (T-17-02-01)', () => {
  it('NEVER includes attributes content in skippedActions entries', () => {
    const result = validateActionShapes(
      [{ type: 'add_note', name: 'X', attributes: { secretKey: 'sensitive' } }],
      [],
      FIXTURE_REGISTRY,
    );
    for (const entry of result.skippedActions) {
      assert.equal(entry.attributes, undefined, 'skippedActions entry must not carry attributes content');
    }
  });

  it('NEVER includes attributes content in warnings entries', () => {
    const result = validateActionShapes(
      [{ type: 'send_whatsapp_template', name: 'X', attributes: { secretKey: 'sensitive' } }],
      [],
      FIXTURE_REGISTRY,
    );
    for (const entry of result.warnings) {
      assert.equal(entry.attributes, undefined);
    }
  });

  it('handles empty inputs cleanly', () => {
    const result = validateActionShapes([], [], FIXTURE_REGISTRY);
    assert.deepEqual(result, {
      sanitized: { actions: [], triggers: [] },
      skippedActions: [],
      warnings: [],
    });
  });

  it('handles null/undefined arrays', () => {
    const result = validateActionShapes(undefined, undefined, FIXTURE_REGISTRY);
    assert.deepEqual(result, {
      sanitized: { actions: [], triggers: [] },
      skippedActions: [],
      warnings: [],
    });
  });
});

describe('validateActionShapes — event_start_date + date-anchored wait (real registry)', () => {
  // Uses the actual action-shapes.json registry to verify the new entries work end-to-end
  const realRegistry = JSON.parse(
    readFileSync(
      new URL('../registry/action-shapes.json', import.meta.url), 'utf8',
    ),
  );

  it('passes event_start_date with correct captured shape', () => {
    const action = {
      type: 'event_start_date',
      name: 'Set Event Start Time',
      attributes: {
        type: 'event_start_date',
        event_start_type: 'datetime',
        value: '2026-06-15T12:00:00+01:00',
      },
    };
    const result = validateActionShapes([action], [], realRegistry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0, 'event_start_date must not be rejected');
  });

  it('SOFT-salvages event_start_date with missing required attributes', () => {
    const action = {
      type: 'event_start_date',
      name: 'Bad shape',
      attributes: { garbage: true },
    };
    const result = validateActionShapes([action], [], realRegistry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'malformed-shape-stripped');
  });

  it('passes date-anchored wait (appointmentStartAfter) without stripping attributes', () => {
    const action = {
      type: 'wait',
      name: 'Wait 14 days before event',
      attributes: {
        type: 'appointment',
        appointmentStartAfter: {
          when: 'before',
          type: 'minutes',
          value: 20160,
          distributed: { months: 0, days: 14, hours: 0, minutes: 0 },
        },
        appointmentCondition: 'skip',
        isHybridAction: true,
        hybridActionType: 'wait',
        convertToMultipath: false,
        transitions: [],
      },
    };
    const result = validateActionShapes([action], [], realRegistry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, action.attributes,
      'date-anchored wait attributes must survive shape validation');
    assert.equal(result.skippedActions.length, 0,
      'date-anchored wait must not be stripped to time-based defaults');
  });

  it('passes trigger with top-level conditions + masterType (not under .attributes)', () => {
    const trigger = {
      type: 'contact_tag_added',
      name: 'Tag: reduced ad lead',
      masterType: 'highlevel',
      conditions: [{ value: 'reduced ad lead', id: 'tag-added', field: 'tagsAdded', type: 'select', title: 'Has Tag', operator: 'index-of-true' }],
    };
    const result = validateActionShapes([], [trigger], realRegistry);
    assert.equal(result.sanitized.triggers.length, 1);
    assert.deepEqual(result.sanitized.triggers[0].conditions, trigger.conditions,
      'trigger conditions must survive shape validation (not SOFT-stripped)');
    assert.equal(result.skippedActions.length, 0, 'valid trigger must not be salvaged');
  });

  it('SOFT-salvages trigger missing required top-level keys', () => {
    const trigger = {
      type: 'contact_tag_added',
      name: 'Bad trigger',
    };
    const result = validateActionShapes([], [trigger], realRegistry);
    assert.equal(result.sanitized.triggers.length, 1);
    assert.equal(result.sanitized.triggers[0].masterType, 'highlevel');
    assert.deepEqual(result.sanitized.triggers[0].conditions, []);
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'malformed-shape-stripped');
    assert.equal(result.skippedActions[0].kind, 'trigger');
  });

  it('still passes time-based wait (startAfter) unchanged', () => {
    const action = {
      type: 'wait',
      name: 'Wait 5 minutes',
      attributes: {
        type: 'time',
        startAfter: { type: 'minutes', value: 5, when: 'after' },
        isHybridAction: true,
        hybridActionType: 'wait',
        convertToMultipath: false,
        transitions: [],
      },
    };
    const result = validateActionShapes([action], [], realRegistry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0].attributes, action.attributes);
    assert.equal(result.skippedActions.length, 0);
  });
});
