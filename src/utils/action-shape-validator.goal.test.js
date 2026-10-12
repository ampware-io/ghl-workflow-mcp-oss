/**
 * workflow_goal round-trip shape — KNOWN GAP placeholder (2026-06-02).
 *
 * Sibling bug to the tag-type alias fix. Unlike the tag types,
 * `workflow_goal` IS in the registry (src/registry/action-shapes.json),
 * so it is never HARD-dropped as unknown-type. Its requiredAttributes are
 * `action` (string) + `segments` (array). The concern: a real GHL-authored
 * goal may persist its conditions under a different attribute shape than the
 * captured registry entry expects. If so, the validator SOFT-salvages it —
 * replacing attributes with the empty defaultAttributes
 * ({ type:'workflow_goal', action:'exit', op:'or', segments:[] }) — which
 * silently guts the goal into a no-op on any update_workflow round-trip.
 *
 * We currently have NO captured real-goal fixture, so the exact persisted key
 * names are unverified. Guessing the shape risks SOFT-stripping valid goals or
 * waving through malformed ones, so this is intentionally left unfixed.
 *
 * TODO: capture a real workflow_goal step from a live GHL workflow
 * (getWorkflow includeActionDetails=true on a workflow that has a goal),
 * add it to a fixture, then:
 *   1. assert a real goal round-trips WITHOUT losing its segments/conditions
 *   2. correct registry.actions.workflow_goal.requiredAttributes /
 *      defaultAttributes to match the persisted shape if they diverge
 * Unskip the test below once the fixture exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('workflow_goal round-trip shape (KNOWN GAP)', () => {
  it(
    'real GHL goal round-trips without SOFT-stripping its segments/conditions',
    { skip: 'No captured real-goal fixture yet — see TODO in file header.' },
    () => {
      // Pseudocode for when the fixture lands:
      //   const r = validateActionShapes([realGoal], [], registry);
      //   const survived = r.sanitized.actions.find((a) => a.type === 'workflow_goal');
      //   assert.ok(survived);
      //   assert.ok(survived.attributes.segments.length > 0,
      //     'goal segments must survive — not replaced with empty defaults');
      //   assert.equal(r.skippedActions.filter((s) => s.type === 'workflow_goal').length, 0);
      assert.fail('placeholder — unskip once a real-goal fixture exists');
    },
  );
});
