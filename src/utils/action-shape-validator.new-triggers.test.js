/**
 * Four native trigger types added to the registry (regression, 260707-s4z):
 * pipeline_stage_updated, opportunity_changed, opportunity_decay, survey_submission.
 *
 * KNOWN LIMITATION — the four `type` strings are UNVERIFIED best-guesses against
 * live GHL. They are flagged shapeStatus:"unverified" (NOT "captured") to keep
 * that honest. A follow-up DevTools runtime capture (watch POST /workflow/{loc}/
 * trigger in the GHL builder) must confirm each persisted string.
 *
 * A WRONG string fails SILENTLY on round-trip: get_workflow returns the real
 * GHL type, and if it doesn't match a registry key the trigger is HARD-dropped
 * as unknown-type on the next update (force-drafting the whole workflow) AND the
 * create/update Zod enum (KNOWN_TRIGGER_TYPES) rejects the guessed string before
 * the handler runs. So presence in the enum is necessary but not sufficient —
 * the string still has to equal what GHL persists.
 *
 * This test asserts only the honest minimum: each key exists in the registry and
 * carries shapeStatus === "unverified". No validateActionShapes round-trip is
 * attempted — without a real capture the conditions would be fabricated, which
 * is exactly the guess this test refuses to launder as verified.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
  readFileSync(join(__dirname, '../registry/action-shapes.json'), 'utf8'),
);

const NEW_TRIGGER_KEYS = Object.freeze([
  'pipeline_stage_updated',
  'opportunity_changed',
  'opportunity_decay',
  'survey_submission',
]);

describe('new native trigger types', () => {
  it('registry.triggers carries all four keys, each shapeStatus "unverified"', () => {
    for (const key of NEW_TRIGGER_KEYS) {
      assert.ok(
        registry.triggers[key],
        `registry.triggers must include ${key} (source of KNOWN_TRIGGER_TYPES z.enum)`,
      );
      assert.equal(
        registry.triggers[key].shapeStatus,
        'unverified',
        `${key} shapeStatus must be "unverified" (honest — string is an unconfirmed best-guess, not a live capture)`,
      );
    }
  });
});
