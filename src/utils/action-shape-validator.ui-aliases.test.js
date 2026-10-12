/**
 * GHL-UI action-type aliases round-trip.
 *
 * GHL persists some action types under UI-facing names that differ from the
 * `available-actions` palette names the shape registry (action-shapes.json)
 * was captured from. `getWorkflow` returns the persisted names verbatim, so a
 * read->write round-trip would HARD-drop them as unknown-type unless aliased.
 *
 * ACTION_TYPE_ALIASES maps:
 *   send_sms           -> sms
 *   create_opportunity -> internal_create_opportunity
 *
 * The alias only selects which registry SHAPE to validate against — the
 * action's own `type` is preserved verbatim on the emitted item so it
 * round-trips back to GHL exactly as stored (the write path does no type
 * translation). Sibling to the tag-ACTION alias fix (add_contact_tag /
 * remove_contact_tag -> *_tool) and the contact_tag TRIGGER capture.
 *
 * These two cases supply CANONICAL attributes (message for sms; pipelineId +
 * pipelineStageId + title + status for internal_create_opportunity) so they
 * reach the PASS path — surviving with original type AND original attributes
 * intact, and with an empty skippedActions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateActionShapes } from './action-shape-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
  readFileSync(join(__dirname, '../registry/action-shapes.json'), 'utf8'),
);

describe('GHL-UI action-type aliases', () => {
  it('send_sms aliases to the sms shape and PASSes with original type + attributes', () => {
    const sendSms = {
      type: 'send_sms',
      name: 'Send SMS',
      attributes: { message: 'hi' },
    };
    const r = validateActionShapes([sendSms], [], registry);

    // Not dropped (unknown-type) and not SOFT-stripped (malformed-shape).
    const dropped = r.skippedActions.filter((s) => s.type === 'send_sms');
    assert.equal(dropped.length, 0, 'send_sms must not be dropped or salvaged');
    assert.equal(r.warnings.length, 0, 'captured sms shape must not warn');

    assert.equal(r.sanitized.actions.length, 1);
    const out = r.sanitized.actions[0];
    // Type round-trips verbatim — NOT rewritten to sms.
    assert.equal(out.type, 'send_sms', 'type must round-trip verbatim');
    // Original attributes survive intact (PASS path — not empty defaults).
    assert.equal(out.attributes.message, 'hi', 'original message must survive untouched');
  });

  it('create_opportunity aliases to internal_create_opportunity and PASSes with original type + attributes', () => {
    const createOpp = {
      type: 'create_opportunity',
      name: 'Create opportunity',
      attributes: {
        pipelineId: 'pipeline_123',
        pipelineStageId: 'stage_456',
        title: 'New EOI opportunity',
        status: 'open',
      },
    };
    const r = validateActionShapes([createOpp], [], registry);

    // Full canonical attrs satisfy internal_create_opportunity → PASS.
    const dropped = r.skippedActions.filter((s) => s.type === 'create_opportunity');
    assert.equal(dropped.length, 0, 'create_opportunity must not be dropped or salvaged');
    assert.equal(r.warnings.length, 0, 'captured internal_create_opportunity shape must not warn');

    assert.equal(r.sanitized.actions.length, 1);
    const out = r.sanitized.actions[0];
    // Type round-trips verbatim — NOT rewritten to internal_create_opportunity.
    assert.equal(out.type, 'create_opportunity', 'type must round-trip verbatim');
    // Original attributes survive intact (PASS path — not empty defaults).
    assert.equal(out.attributes.pipelineId, 'pipeline_123');
    assert.equal(out.attributes.pipelineStageId, 'stage_456');
    assert.equal(out.attributes.title, 'New EOI opportunity');
    assert.equal(out.attributes.status, 'open');
  });
});
