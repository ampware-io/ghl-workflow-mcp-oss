/**
 * Strict per-action-type deep-shape validation (quick-260707-u36).
 *
 * Covers the 4 deep-checked types: sms, email, update_contact_field,
 * internal_create_opportunity. Wrong-but-parseable shapes must be DROPPED
 * (class 'malformed-shape-rejected'), correct shapes pass unchanged, and
 * rejection records must NEVER leak attributes content (T-79-01 / T-17-02-01).
 *
 * Uses the REAL registry (src/registry/action-shapes.json).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateActionShapes } from './action-shape-validator.js';

const registry = JSON.parse(
  readFileSync(new URL('../registry/action-shapes.json', import.meta.url), 'utf8'),
);

function only(result) {
  return result.skippedActions[0];
}

describe('strict deep-check — REJECT wrong-but-parseable shapes', () => {
  it('sms: empty message rejected with malformed-shape-rejected + expectedShape', () => {
    const action = { type: 'sms', name: 'Blank SMS', attributes: { message: '' } };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0, 'malformed sms must be dropped');
    assert.equal(result.skippedActions.length, 1);
    const skip = only(result);
    assert.equal(skip.class, 'malformed-shape-rejected');
    assert.equal(skip.type, 'sms');
    assert.equal(skip.expectedShape, 'sms');
    assert.match(skip.reason, /action-shapes\.json/);
  });

  it('email: neither html nor template_id rejected', () => {
    const action = {
      type: 'email',
      name: 'Bodyless',
      attributes: { subject: 'S', from_email: 'a@b.co', from_name: 'N' },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0);
    const skip = only(result);
    assert.equal(skip.class, 'malformed-shape-rejected');
    assert.equal(skip.type, 'email');
    assert.equal(skip.expectedShape, 'email');
  });

  it('update_contact_field: element missing .field rejected', () => {
    const action = {
      type: 'update_contact_field',
      name: 'Bad fields',
      attributes: {
        type: 'update_contact_field',
        actionType: 'update_field_data',
        fields: [{ value: 'x' }],
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0);
    const skip = only(result);
    assert.equal(skip.class, 'malformed-shape-rejected');
    assert.equal(skip.type, 'update_contact_field');
    assert.equal(skip.expectedShape, 'update_contact_field');
  });

  it('update_contact_field: empty fields array rejected', () => {
    const action = {
      type: 'update_contact_field',
      name: 'Empty fields',
      attributes: {
        type: 'update_contact_field',
        actionType: 'update_field_data',
        fields: [],
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0);
    assert.equal(only(result).class, 'malformed-shape-rejected');
  });

  it('internal_create_opportunity: bogus status rejected', () => {
    const action = {
      type: 'internal_create_opportunity',
      name: 'Bad status',
      attributes: {
        pipelineId: 'p1',
        pipelineStageId: 's1',
        title: 'T',
        status: 'bogus',
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0);
    const skip = only(result);
    assert.equal(skip.class, 'malformed-shape-rejected');
    assert.equal(skip.type, 'internal_create_opportunity');
    assert.equal(skip.expectedShape, 'internal_create_opportunity');
  });

  it('internal_create_opportunity: missing pipelineStageId rejected', () => {
    const action = {
      type: 'internal_create_opportunity',
      name: 'No stage',
      attributes: {
        pipelineId: 'p1',
        title: 'T',
        status: 'open',
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 0);
    assert.equal(only(result).class, 'malformed-shape-rejected');
  });
});

describe('strict deep-check — PASS correct shapes unchanged', () => {
  it('sms with a real message passes unchanged', () => {
    const action = { type: 'sms', name: 'SMS', attributes: { message: 'Hi' } };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('email inline (html) passes unchanged', () => {
    const action = {
      type: 'email',
      name: 'Inline',
      attributes: { subject: 'S', html: '<p>x</p>', from_email: 'a@b.co', from_name: 'N' },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('email template (template_id) passes unchanged', () => {
    const action = {
      type: 'email',
      name: 'Template',
      attributes: { subject: 'S', template_id: 'tpl_1', from_email: 'a@b.co', from_name: 'N' },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('update_contact_field with well-formed fields passes unchanged', () => {
    const action = {
      type: 'update_contact_field',
      name: 'UCF',
      attributes: {
        type: 'update_contact_field',
        actionType: 'update_field_data',
        fields: [{ field: 'cf_1', value: 'x' }],
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('internal_create_opportunity with valid ids + status passes unchanged', () => {
    const action = {
      type: 'internal_create_opportunity',
      name: 'Opp',
      attributes: {
        pipelineId: 'p1',
        pipelineStageId: 's1',
        title: 'T',
        status: 'open',
      },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1);
    assert.deepEqual(result.sanitized.actions[0], action);
    assert.equal(result.skippedActions.length, 0);
    assert.equal(result.warnings.length, 0);
  });
});

describe('strict deep-check — security (T-79-01 / T-17-02-01)', () => {
  it('rejected entries never carry attributes content', () => {
    const actions = [
      { type: 'sms', name: 'A', attributes: { message: '', secret: 'leak-me' } },
      {
        type: 'email',
        name: 'B',
        attributes: { subject: 'S', from_email: 'a@b.co', from_name: 'N', secret: 'leak-me' },
      },
      {
        type: 'internal_create_opportunity',
        name: 'C',
        attributes: { pipelineId: 'p1', pipelineStageId: 's1', title: 'T', status: 'bogus', secret: 'leak-me' },
      },
    ];
    const result = validateActionShapes(actions, [], registry);
    assert.equal(result.skippedActions.length, 3);
    for (const entry of result.skippedActions) {
      assert.equal(entry.class, 'malformed-shape-rejected');
      assert.equal(entry.attributes, undefined, 'reject record must not carry attributes');
      // Ensure no field value leaked anywhere in the serialized record.
      assert.doesNotMatch(JSON.stringify(entry), /leak-me/, 'no field value may appear in the record');
    }
  });
});

describe('strict deep-check — alias safety (scoped to the 4 types only)', () => {
  it('non-deep-checked captured type still SOFT-strips on malformed attributes', () => {
    // event_start_date is captured but NOT in DEEP_CHECKS — must retain SOFT behavior.
    const action = {
      type: 'event_start_date',
      name: 'Bad shape',
      attributes: { garbage: true },
    };
    const result = validateActionShapes([action], [], registry);
    assert.equal(result.sanitized.actions.length, 1, 'SOFT keeps the step');
    assert.equal(result.skippedActions.length, 1);
    assert.equal(result.skippedActions[0].class, 'malformed-shape-stripped');
  });
});
