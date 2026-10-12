/**
 * Phase 18 SPEC #8 — EOI Welcome Sequence regression test.
 *
 * Replays the 2026-04-26 EOI Welcome Sequence fixture through the full
 * Phase 18 validation + expansion pipeline (validateActionShapes →
 * expandIfElse) and asserts every documented salvage outcome.
 *
 * The fixture (src/utils/fixtures/eoi-welcome-sequence.json) reproduces
 * the SPEC #8 documented action distribution and the canonical shape
 * pathologies: scaffold-less if_else with attributes.conditions, email
 * with the wrong key set, wait with attributes.startAfter shape,
 * invented update_opportunity_pipeline type, send_whatsapp_template
 * (registry-absent), create_opportunity (registry knows only the
 * internal_* variant). add_contact_tag / remove_contact_tag are GHL's
 * persisted tag-action names — ACTION_TYPE_ALIASES maps them to the
 * *_tool registry shapes and they PASS (round-trip fix, 2026-06-02).
 *
 * Pipeline expectations against the live registry
 * (src/registry/action-shapes.json):
 *   - email actions: type 'email' is captured; fixture's attributes
 *     provide subject/from_email/from_name → PASS path, original
 *     attributes (including inline html) preserved. Per 260501-kgp,
 *     template_id is no longer required so inline-HTML emails round-trip
 *     untouched.
 *   - wait actions: type 'wait' is captured but fixture's attributes
 *     omit the registry-required 'type' key → SOFT-salvage.
 *   - if_else actions: scaffold-less wrong shape (attributes.conditions
 *     present, no then/else, no nodeType, no attributes.branches) →
 *     HARD-reject with class 'malformed-if-else'. Validator fires its
 *     SPEC #8 special case BEFORE SOFT salvage.
 *   - update_opportunity_pipeline / create_opportunity /
 *     send_whatsapp_template: not in the live registry → HARD-drop with
 *     class 'unknown-type'.
 *   - add_contact_tag / remove_contact_tag: GHL's persisted tag-action
 *     names. ACTION_TYPE_ALIASES maps them to add_contact_tag_tool /
 *     remove_contact_tag_tool; their attributes.tags arrays satisfy the
 *     captured shape → PASS (survive with original type + attributes).
 *   - form_submission trigger: type captured but fixture's attributes
 *     omit registry-required 'masterType' + 'conditions' → SOFT-salvage
 *     with kind 'trigger'.
 *
 * D-04 force-draft policy (from write-orchestrator.js): any HARD class
 * (unknown-type or malformed-if-else) means the would-be final status
 * is forced to 'draft' regardless of input status='published'.
 *
 * T-17-02-01: no skippedActions/warnings entry includes attributes
 * content (verified across the entire response).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateActionShapes } from './action-shape-validator.js';
import { expandIfElse } from './action-expander.js';
import { HARD_CLASSES } from '../api/write-orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/eoi-welcome-sequence.json'), 'utf8'),
);
const registry = JSON.parse(
  readFileSync(join(__dirname, '../registry/action-shapes.json'), 'utf8'),
);

describe('EOI Welcome Sequence regression (SPEC #8)', () => {
  it('fixture distribution matches the 2026-04-26 SPEC #8 documented payload', () => {
    assert.ok(
      fixture.actions.length >= 15,
      `expected >= 15 actions, got ${fixture.actions.length}`,
    );
    const counts = fixture.actions.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {});
    // SPEC #8 documented distribution
    assert.equal(counts.if_else, 3, 'expected 3 if_else (canonical wrong-shape case)');
    assert.equal(counts.email, 4, 'expected 4 email (SOFT-salvage case)');
    assert.equal(counts.wait, 4, 'expected 4 wait (SOFT-salvage case)');
    assert.equal(counts.send_whatsapp_template, 2);
    assert.equal(counts.add_contact_tag, 2);
    assert.equal(counts.remove_contact_tag, 1);
    assert.equal(counts.update_opportunity_pipeline, 1, 'canonical HARD case');
    assert.equal(counts.create_opportunity, 1);
    assert.equal(fixture.triggers.length, 1);
    assert.equal(fixture.triggers[0].type, 'form_submission');
  });

  it('drops update_opportunity_pipeline (HARD class unknown-type)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    const hits = r.skippedActions.filter((s) => s.type === 'update_opportunity_pipeline');
    assert.ok(
      hits.length >= 1,
      'expected at least one unknown-type entry for update_opportunity_pipeline',
    );
    for (const h of hits) {
      assert.equal(h.class, 'unknown-type');
      assert.equal(h.kind, 'action');
    }
    // sanitized.actions must NOT contain the invented type
    const survived = r.sanitized.actions.find((a) => a.type === 'update_opportunity_pipeline');
    assert.equal(survived, undefined, 'invented type must not survive validation');
  });

  it('drops send_whatsapp_template per registry (registry-absent → HARD unknown-type)', () => {
    const inRegistry = registry.actions.send_whatsapp_template !== undefined;
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    if (!inRegistry) {
      const hits = r.skippedActions.filter((s) => s.type === 'send_whatsapp_template');
      assert.equal(
        hits.length,
        2,
        'expected 2 unknown-type entries for the 2 send_whatsapp_template actions',
      );
      for (const h of hits) {
        assert.equal(h.class, 'unknown-type');
        assert.equal(h.kind, 'action');
      }
    } else if (registry.actions.send_whatsapp_template.shapeStatus === 'unverified') {
      const warns = r.warnings.filter((w) => w.type === 'send_whatsapp_template');
      assert.ok(
        warns.length >= 1,
        'expected unverified-shape warnings for send_whatsapp_template',
      );
    }
  });

  it('HARD-rejects GHL-UI create_opportunity when attrs fail internal_create_opportunity deep-check', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // ACTION_TYPE_ALIASES maps create_opportunity -> internal_create_opportunity,
    // which regression wired into DEEP_CHECKS. The EOI fixture's snake_case
    // attrs (pipeline_id/stage_id/name/monetary_value) don't satisfy the deep
    // check (require pipelineId/pipelineStageId/title + a valid status), so it
    // is now HARD-rejected (class 'malformed-shape-rejected') rather than
    // SOFT-salvaged — a malformed opportunity node renders broken in GHL, so
    // dropping is safer than stripping it to empty defaults.
    const hits = r.skippedActions.filter((s) => s.type === 'create_opportunity');
    assert.ok(hits.length >= 1, 'expected a HARD reject entry for create_opportunity');
    for (const h of hits) assert.equal(h.class, 'malformed-shape-rejected');
    const survived = r.sanitized.actions.find((a) => a.type === 'create_opportunity');
    assert.equal(survived, undefined, 'HARD-rejected create_opportunity must NOT survive in sanitized.actions');
  });

  it('aliases un-suffixed tag types to *_tool shapes and PASSes them through', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // GHL persists tag actions as add_contact_tag / remove_contact_tag.
    // ACTION_TYPE_ALIASES maps them to the *_tool registry shapes; their
    // attributes.tags arrays satisfy the captured shape → PASS. They must
    // survive with their ORIGINAL (un-suffixed) type so they round-trip back
    // to GHL verbatim, and with their original attributes intact (not the
    // empty defaultAttributes a SOFT-salvage would substitute).
    for (const t of ['add_contact_tag', 'remove_contact_tag']) {
      const dropped = r.skippedActions.filter((s) => s.type === t);
      assert.equal(dropped.length, 0, `${t} must not be dropped after aliasing`);
    }
    const survivingTags = r.sanitized.actions.filter(
      (a) => a.type === 'add_contact_tag' || a.type === 'remove_contact_tag',
    );
    assert.equal(
      survivingTags.length,
      3,
      'all 3 tag actions must survive (2 add + 1 remove) with original type',
    );
    for (const a of survivingTags) {
      assert.ok(
        Array.isArray(a.attributes?.tags) && a.attributes.tags.length > 0,
        'tag action must retain its original non-empty attributes.tags array',
      );
    }
  });

  it('passes through email actions with inline HTML (no template_id required)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // Per 260501-kgp, email no longer requires template_id, so the EOI
    // emails (subject + from_email + from_name + inline html) reach the
    // PASS path and survive with original attributes intact.
    const emailHits = r.skippedActions.filter((s) => s.type === 'email');
    assert.equal(
      emailHits.length,
      0,
      'expected zero salvage entries for emails — they now satisfy the trimmed required set',
    );
    const emailWarns = r.warnings.filter((w) => w.type === 'email');
    assert.equal(emailWarns.length, 0, 'expected zero warnings entries for emails');
    const survivedEmails = r.sanitized.actions.filter((a) => a.type === 'email');
    assert.equal(survivedEmails.length, 4, 'all 4 emails must survive in sanitized output');
    // Each surviving email retains its fixture-supplied subject + inline html.
    assert.equal(survivedEmails[0].attributes.subject, 'Thanks for your interest!');
    assert.match(
      survivedEmails[0].attributes.html,
      /thanks for submitting your EOI/,
      'inline html must survive PASS path untouched',
    );
    for (const e of survivedEmails) {
      assert.notEqual(
        e.attributes.subject,
        '',
        'PASS-path email subjects must equal the fixture subject, not the registry default empty string',
      );
      assert.ok(
        typeof e.attributes.html === 'string' && e.attributes.html.length > 0,
        'PASS-path emails must retain a non-empty inline html attribute',
      );
    }
  });

  it('SOFT-salvages wait actions with wrong attributes.startAfter shape', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    const waitHits = r.skippedActions.filter(
      (s) => s.type === 'wait' && s.class === 'malformed-shape-stripped',
    );
    assert.equal(waitHits.length, 4, 'expected all 4 waits to be SOFT-salvaged');
    const survivedWaits = r.sanitized.actions.filter((a) => a.type === 'wait');
    assert.equal(survivedWaits.length, 4, 'all 4 waits must survive in sanitized output');
    for (const w of survivedWaits) {
      assert.deepEqual(w.attributes, registry.actions.wait.defaultAttributes);
    }
  });

  it('HARD-rejects scaffold-less wrong-shape if_else with class malformed-if-else (SPEC #8)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // Validator SPEC #8 special case: if_else with attributes.conditions and no
    // scaffold (then/else) and no verbose nodeType is HARD-rejected with class
    // 'malformed-if-else' BEFORE SOFT salvage strips attributes.conditions.
    const ifElseHards = r.skippedActions.filter(
      (s) => s.type === 'if_else' && s.class === 'malformed-if-else',
    );
    assert.equal(
      ifElseHards.length,
      3,
      'expected 3 HARD malformed-if-else entries from EOI if_else blocks',
    );
    for (const e of ifElseHards) {
      assert.match(
        e.reason,
        /then\/else scaffold/,
        'malformed-if-else reason must point at the then/else scaffold contract',
      );
    }
    // No salvaged if_else should remain in sanitized.actions (HARD drops them all)
    const salvaged = r.sanitized.actions.find((a) => a.type === 'if_else');
    assert.equal(
      salvaged,
      undefined,
      'HARD-rejected if_else must NOT appear in sanitized.actions',
    );
  });

  it('valid surviving steps reach sanitized output (4 PASS email + 3 PASS tag + 4 SOFT wait)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // 4 email (PASS, original attrs) + 3 tag (PASS via alias, original attrs)
    // + 4 wait (SOFT, replaced attrs) = 11 sanitized actions. create_opportunity
    // is now HARD-rejected (regression deep-check) so it no longer survives.
    assert.equal(r.sanitized.actions.length, 11, 'expected 11 sanitized actions');
    for (const a of r.sanitized.actions) {
      if (a.type === 'wait') {
        // Wait remains SOFT-salvaged — attributes wholesale-replaced with registry defaults.
        assert.deepEqual(
          a.attributes,
          registry.actions.wait.defaultAttributes,
          'salvaged wait attributes must match registry.actions.wait.defaultAttributes',
        );
      }
      // Email branch lives in the dedicated "passes through email actions"
      // test above; nothing to assert here beyond presence.
    }
  });

  it('full pipeline (validate → expand) does not throw for EOI input (no scaffold-form if_else after HARD-drop)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // After HARD-rejection, no if_else remains in sanitized.actions, so
    // expandIfElse passes through verbatim with no scaffold-form to expand.
    assert.doesNotThrow(
      () => expandIfElse(r.sanitized.actions),
      'expandIfElse must not throw on validator-cleaned EOI actions',
    );
    const expanded = expandIfElse(r.sanitized.actions);
    // All survivors are email or wait — count must equal sanitized count
    assert.equal(expanded.length, r.sanitized.actions.length);
  });

  it('partial:true would be set (any salvage activity occurred)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    const partial = r.skippedActions.length > 0 || r.warnings.length > 0;
    assert.ok(partial, 'EOI must produce at least one skippedActions OR warnings entry');
  });

  it('D-04 force-draft policy: HARD entry present → status would be draft', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    const hasHard = r.skippedActions.some((s) => HARD_CLASSES.has(s.class));
    assert.ok(
      hasHard,
      'EOI fixture must contain at least one HARD-class entry (e.g. unknown-type, malformed-if-else)',
    );
    // HARD_CLASSES is the literal source of truth shared with the orchestrator
    assert.ok(HARD_CLASSES.has('unknown-type'));
    assert.ok(HARD_CLASSES.has('malformed-if-else'));
  });

  it('T-17-02-01: no skippedActions or warnings entry contains action.attributes content', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    for (const e of r.skippedActions) {
      assert.equal(e.attributes, undefined, 'skippedActions must never leak attributes');
    }
    for (const e of r.warnings) {
      assert.equal(e.attributes, undefined, 'warnings must never leak attributes');
    }
  });

  it('SPEC #8 acceptance: every input action is classified into exactly one of HARD | SOFT | WARN | PASS', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // SOFT items appear in BOTH skippedActions AND sanitized.actions (advisory
    // skip + survivor with replaced attributes). HARD items appear only in
    // skippedActions. WARN appears in warnings AND sanitized. PASS appears
    // only in sanitized. Correct invariant: HARD + SOFT + WARN + PASS = N.
    const actionSkipped = r.skippedActions.filter((s) => s.kind === 'action');
    const hard = actionSkipped.filter((s) => HARD_CLASSES.has(s.class)).length;
    const soft = actionSkipped.filter((s) => s.class === 'malformed-shape-stripped').length;
    const warn = r.warnings.filter((w) => w.kind === 'action').length;
    // PASS = sanitized actions that were neither SOFT-replaced nor WARN-passed.
    const pass = r.sanitized.actions.length - soft - warn;
    assert.ok(pass >= 0, 'pass count must be non-negative');
    assert.equal(
      hard + soft + warn + pass,
      fixture.actions.length,
      'every input action must be in exactly one of {HARD, SOFT, WARN, PASS}',
    );
    // EOI-specific bucket sizes per the documented expectations.
    // Per 260501-kgp, the 4 emails moved from SOFT (template_id required)
    // to PASS (template_id no longer required, inline html now satisfies
    // the trimmed shape).
    assert.equal(
      hard,
      7,
      'expected 7 HARD entries (3 malformed-if-else + 3 unknown-type: update_opportunity_pipeline + 2 send_whatsapp_template + 1 malformed-shape-rejected create_opportunity — regression deep-check flips the aliased create_opportunity from SOFT to HARD; tags alias to *_tool and PASS)',
    );
    assert.equal(soft, 4, 'expected 4 SOFT entries (4 wait — emails PASS, create_opportunity now HARD-rejected)');
    assert.equal(warn, 0, 'expected 0 WARN entries (no unverified types in EOI fixture)');
    assert.equal(pass, 7, 'expected 7 PASS entries (4 inline-HTML emails + 3 aliased tag actions)');
  });

  it('trigger handling: form_submission SOFT-salvaged (kind=trigger entry in skippedActions)', () => {
    const r = validateActionShapes(fixture.actions, fixture.triggers, registry);
    // Live registry's form_submission requires masterType + conditions; fixture
    // omits both → SOFT-salvage with kind:'trigger'.
    const triggerHits = r.skippedActions.filter((s) => s.kind === 'trigger');
    assert.equal(triggerHits.length, 1, 'expected 1 trigger SOFT-salvage entry');
    assert.equal(triggerHits[0].type, 'form_submission');
    assert.equal(triggerHits[0].class, 'malformed-shape-stripped');
    // Sanitized triggers must include the salvaged form_submission with defaults
    // spread at the top level (triggers carry data at root, not under .attributes)
    assert.equal(r.sanitized.triggers.length, 1);
    const salvaged = r.sanitized.triggers[0];
    assert.equal(salvaged.masterType, registry.triggers.form_submission.defaultAttributes.masterType);
    assert.deepEqual(salvaged.conditions, registry.triggers.form_submission.defaultAttributes.conditions);
  });
});
