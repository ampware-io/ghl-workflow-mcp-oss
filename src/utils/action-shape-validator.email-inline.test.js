/**
 * Positive coverage for the inline-HTML email shape (260501-kgp).
 *
 * After dropping `template_id` from the email shape's requiredAttributes, an
 * email action whose only payload is `{ subject, html, from_email, from_name }`
 * must reach the PASS path of validateActionShapes — original attributes
 * preserved, no skippedActions/warnings entry. Pre-fix this same input was
 * SOFT-salvaged and the inline `html` was wiped by the registry's
 * defaultAttributes replacement, producing empty email steps in GHL.
 *
 * Three cases:
 *   1. Inline-only (subject + html + from_email + from_name) → PASS, html
 *      survives intact.
 *   2. Template-only (subject + template_id + from_email + from_name) → PASS,
 *      template_id survives intact (backward compat with existing template
 *      bindings).
 *   3. Inline missing from_email → REJECT (regression: email is now a
 *      deep-checked type, so a shape failure — including a missing required
 *      key — is a HARD reject/drop, not a SOFT strip. The trimmed shape isn't
 *      a free pass, and it is no longer silently wiped to defaults either.).
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

describe('email action shape — inline HTML default (260501-kgp)', () => {
  it('email with inline HTML attributes passes validation untouched', () => {
    const inlineEmail = {
      id: 'a1',
      type: 'email',
      name: 'Welcome',
      attributes: {
        subject: 'Hello',
        html: '<p>Hi</p>',
        from_email: 'a@b.co',
        from_name: 'Team',
      },
    };
    const r = validateActionShapes([inlineEmail], [], registry);
    // No salvage entries for emails — PASS path.
    assert.equal(
      r.skippedActions.filter((s) => s.type === 'email').length,
      0,
      'inline-HTML email must not be SOFT-salvaged',
    );
    assert.equal(
      r.warnings.filter((w) => w.type === 'email').length,
      0,
      'inline-HTML email must not generate warnings',
    );
    assert.equal(r.sanitized.actions.length, 1);
    const survived = r.sanitized.actions[0];
    assert.equal(survived.attributes.html, '<p>Hi</p>', 'html must survive intact');
    assert.equal(survived.attributes.subject, 'Hello');
    assert.equal(survived.attributes.from_email, 'a@b.co');
    assert.equal(survived.attributes.from_name, 'Team');
    // PASS preserves the object reference (validator only spreads on SOFT path).
    assert.equal(survived, inlineEmail, 'PASS path must preserve original action object');
  });

  it('email with template_id but no html still passes (backwards compat)', () => {
    const templateEmail = {
      id: 'a2',
      type: 'email',
      name: 'Template-bound',
      attributes: {
        subject: 'Hi',
        template_id: 'abc-123',
        from_email: 'a@b.co',
        from_name: 'Team',
      },
    };
    const r = validateActionShapes([templateEmail], [], registry);
    assert.equal(r.skippedActions.filter((s) => s.type === 'email').length, 0);
    assert.equal(r.warnings.filter((w) => w.type === 'email').length, 0);
    assert.equal(r.sanitized.actions[0].attributes.template_id, 'abc-123');
    assert.equal(r.sanitized.actions[0].attributes.subject, 'Hi');
  });

  it('email missing from_email is REJECTED (deep-checked type; remaining required keys still enforced)', () => {
    const incompleteEmail = {
      id: 'a3',
      type: 'email',
      name: 'Missing from_email',
      attributes: {
        subject: 'Hi',
        html: '<p>Hi</p>',
        from_name: 'Team',
        // from_email omitted
      },
    };
    const r = validateActionShapes([incompleteEmail], [], registry);
    const hits = r.skippedActions.filter((s) => s.type === 'email');
    assert.equal(hits.length, 1, 'email missing from_email must be rejected');
    assert.equal(hits[0].class, 'malformed-shape-rejected');
    assert.equal(hits[0].expectedShape, 'email');
    // Rejected: the malformed step is DROPPED, not kept-with-defaults.
    assert.equal(r.sanitized.actions.length, 0);
    // Security: reject record carries no attributes content.
    assert.equal(hits[0].attributes, undefined);
  });
});
