/**
 * contact_tag trigger round-trip (shape from a real capture; data synthetic).
 *
 * GHL persists tag triggers under type "contact_tag" (NOT the available-triggers
 * palette names contact_tag_added / contact_tag_removed). The add/remove
 * distinction lives in the condition (field: "tagsAdded", operator:
 * "index-of-true"), and the tag name is a PLAIN STRING in `value`. getWorkflow
 * returns this verbatim, so a read->write round-trip must validate against the
 * `contact_tag` type — otherwise it is HARD-dropped as unknown-type (which
 * force-drafts the whole workflow) AND rejected by the create/update Zod enum
 * (KNOWN_TRIGGER_TYPES) before the handler even runs.
 *
 * The registry now carries a captured `contact_tag` entry (requiredAttributes:
 * masterType + conditions[]). The real trigger has both, so it PASSes through
 * the validator unchanged — type, conditions, and the trigger's own payload
 * (actions[], workflow_id) all survive verbatim.
 *
 * Sibling to the tag-ACTION alias fix (add_contact_tag / remove_contact_tag ->
 * *_tool). Shape modelled on a get_workflow capture of a "Contact Tag" trigger
 * (all IDs and names are synthetic).
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

// Shape of a real "Contact Tag" trigger capture; IDs and names are synthetic.
const realContactTagTrigger = Object.freeze({
  id: 'SyntheticTagTrigger1',
  masterType: 'highlevel',
  name: 'Contact Tag',
  type: 'contact_tag',
  workflow_id: '00000000-0000-4000-8000-000000000001',
  actions: [{ type: 'add_to_workflow', workflow_id: '00000000-0000-4000-8000-000000000001' }],
  conditions: [
    {
      id: 'tag-added',
      type: 'select',
      title: 'Tag Added',
      operator: 'index-of-true',
      value: 'nurture complete',
      field: 'tagsAdded',
    },
  ],
});

describe('contact_tag trigger round-trip (real capture)', () => {
  it('registry carries contact_tag as a captured trigger (enum + validator source of truth)', () => {
    assert.ok(registry.triggers.contact_tag, 'registry.triggers must include contact_tag');
    assert.equal(registry.triggers.contact_tag.shapeStatus, 'captured');
  });

  it('PASSes through validation unchanged — type + conditions preserved verbatim', () => {
    const r = validateActionShapes([], [realContactTagTrigger], registry);

    // Not dropped (unknown-type) and not SOFT-stripped (malformed-shape).
    assert.equal(
      r.skippedActions.length,
      0,
      'real contact_tag trigger must not be dropped or salvaged',
    );
    assert.equal(r.warnings.length, 0, 'captured shape must not warn');

    assert.equal(r.sanitized.triggers.length, 1);
    const out = r.sanitized.triggers[0];

    // Type round-trips verbatim (write path does no type translation).
    assert.equal(out.type, 'contact_tag', 'type must round-trip verbatim');

    // Condition shape survives untouched — NOT replaced with empty defaults.
    assert.deepEqual(out.conditions, realContactTagTrigger.conditions);
    assert.equal(out.conditions[0].field, 'tagsAdded');
    assert.equal(out.conditions[0].operator, 'index-of-true');
    assert.equal(out.conditions[0].value, 'nurture complete');

    // The trigger's own payload (what it does) survives the PASS path too.
    assert.deepEqual(out.actions, realContactTagTrigger.actions);
    assert.equal(out.workflow_id, realContactTagTrigger.workflow_id);
  });

  it('does NOT leak attributes content into any skip/warning record (T-17-02-01)', () => {
    const r = validateActionShapes([], [realContactTagTrigger], registry);
    for (const e of [...r.skippedActions, ...r.warnings]) {
      assert.equal(e.attributes, undefined, 'must never leak attributes/conditions content');
    }
  });
});
