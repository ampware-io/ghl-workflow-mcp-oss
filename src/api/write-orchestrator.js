/**
 * Phase 18 write-flow orchestrator (D-01, D-03, D-04).
 *
 * Sequences the Phase 18 pre-flight pipeline:
 *   1. validateActionShapes(actions, triggers, registry)  // Plan 02
 *   2. expandIfElse(sanitized.actions)                     // Plan 03
 *   3. createWorkflow / updateWorkflow                     // Phase 17, unchanged
 *   4. Compose response envelope: { ...workflow, partial, skippedActions, warnings }
 *
 * Force-draft policy (D-04 — refines SPEC #3): only HARD-class skips
 * (unknown-type, malformed-if-else) force status='draft'. SOFT class
 * (malformed-shape-stripped) honors caller's input status. WARN never forces.
 *
 * Catches expander throws (err.class === 'malformed-if-else') and converts
 * into a skippedActions entry with the malformed if_else dropped from the
 * pipeline. Re-runs the expansion on the trimmed input (bounded loop).
 *
 * Phase 17's src/api/write-workflows.js is unmodified — createWorkflow and
 * updateWorkflow are invoked verbatim with the post-validation/post-expansion
 * actions array.
 */

import { validateActionShapes } from '../utils/action-shape-validator.js';
import { expandIfElse } from '../utils/action-expander.js';
import { createWorkflow, updateWorkflow } from './write-workflows.js';

/**
 * HARD-class set used by the force-draft policy (D-04). Exported so Plan 06's
 * EOI regression test and Plan 05's status-policy unit tests share the same
 * literal set.
 */
export const HARD_CLASSES = new Set(['unknown-type', 'malformed-if-else', 'malformed-shape-rejected']);

/**
 * Orchestrate a create_workflow call.
 *
 * @param {object} apiClient - GHL API client
 * @param {object} params - create_workflow params (Zod-validated by SDK already)
 * @param {object} registry - src/registry/action-shapes.json contents (passed by server.js)
 * @returns {Promise<object>} - { ...workflow, partial, skippedActions, warnings }
 */
export async function orchestratedCreate(apiClient, params, registry) {
  const inputStatus = params.status ?? 'draft';
  const inputActions = params.actions ?? [];
  const { sanitizedActions, sanitizedTriggers, skippedActions, warnings } =
    runPipeline(inputActions, params.triggers ?? [], registry);

  // regression: refuse to silently create an empty workflow.
  // If the caller supplied actions but every one was HARD-dropped
  // (unknown-type / malformed-if-else), creating a named-but-empty workflow
  // is worse than failing — the caller has no signal their actions vanished.
  // Guard is create-only and gates on non-empty INPUT with zero survivors, so
  // legitimate empty-create and partial salvage (some survive) are unaffected.
  // update's empty-actions is a valid "delete all steps" op, so this stays here.
  assertActionsSurvived(inputActions, sanitizedActions, skippedActions);

  const finalStatus = decideFinalStatus(inputStatus, skippedActions);

  // Phase 17 createWorkflow is invoked verbatim with sanitized+expanded actions
  const workflow = await createWorkflow(apiClient, {
    ...params,
    actions: sanitizedActions,
    triggers: sanitizedTriggers,
    status: finalStatus,
  });

  return composeResponse(workflow, skippedActions, warnings);
}

/**
 * Orchestrate an update_workflow call.
 *
 * @param {object} apiClient - GHL API client
 * @param {object} params - update_workflow params (workflowId + changes flattened)
 * @param {object} registry
 * @returns {Promise<object>}
 */
export async function orchestratedUpdate(apiClient, params, registry) {
  const { workflowId, ...changes } = params;
  const inputStatus = changes.status ?? undefined; // undefined = "leave alone"

  // Only run shape pipeline on actions/triggers that were supplied.
  // updateWorkflow accepts partial change sets; if actions/triggers omitted,
  // skip validation/expansion for them entirely.
  const willValidateActions = Array.isArray(changes.actions);
  const willValidateTriggers = Array.isArray(changes.triggers);

  const { sanitizedActions, sanitizedTriggers, skippedActions, warnings } =
    runPipeline(
      willValidateActions ? changes.actions : null,
      willValidateTriggers ? changes.triggers : null,
      registry,
    );

  const updatedChanges = { ...changes };
  if (willValidateActions) updatedChanges.actions = sanitizedActions;
  if (willValidateTriggers) updatedChanges.triggers = sanitizedTriggers;
  if (inputStatus !== undefined) {
    updatedChanges.status = decideFinalStatus(inputStatus, skippedActions);
  }

  const workflow = await updateWorkflow(apiClient, workflowId, updatedChanges);
  return composeResponse(workflow, skippedActions, warnings);
}

/**
 * Run the validate → expand pipeline. Catches expander throws and converts
 * malformed-if-else into a skippedActions entry, then re-runs the expansion
 * on the trimmed input.
 *
 * Triggers don't go through expandIfElse (no scaffold contract for triggers).
 *
 * @param {Array<object>|null} actions - null = "not supplied; skip"
 * @param {Array<object>|null} triggers
 * @param {object} registry
 * @returns {{ sanitizedActions: Array<object>|null, sanitizedTriggers: Array<object>|null, skippedActions: Array<object>, warnings: Array<object> }}
 */
function runPipeline(actions, triggers, registry) {
  // Tier 1: shape validation
  const validation = validateActionShapes(
    actions ?? [],
    triggers ?? [],
    registry,
  );
  const skippedActions = [...validation.skippedActions];
  const warnings = [...validation.warnings];

  // Tier 2: expand if_else scaffolds (recursively, with malformed-if-else recovery)
  let sanitizedActions = validation.sanitized.actions;
  if (actions !== null) {
    sanitizedActions = expandWithRecovery(sanitizedActions, skippedActions);
  }

  return {
    sanitizedActions: actions === null ? null : sanitizedActions,
    sanitizedTriggers: triggers === null ? null : validation.sanitized.triggers,
    skippedActions,
    warnings,
  };
}

/**
 * Try expandIfElse; on err.class === 'malformed-if-else', drop the offending
 * outer if_else, append a skippedActions entry, and retry on the trimmed input.
 * Bounded retry to avoid infinite loops in pathological inputs (defensive).
 */
function expandWithRecovery(actions, skippedOut) {
  let current = actions;
  for (let i = 0; i <= current.length; i += 1) {
    try {
      return expandIfElse(current);
    } catch (err) {
      if (err?.class !== 'malformed-if-else') throw err;
      // Drop the FIRST scaffold-form if_else (recursion encountered the
      // malformed one bottom-up; FIRST scaffold drop is the simplest
      // deterministic recovery without re-entering the recursion logic).
      const idx = current.findIndex((a) => isScaffoldIfElse(a));
      if (idx === -1) throw err; // no scaffold to drop — re-raise
      const dropped = current[idx];
      skippedOut.push({
        class: err.class, // forwarded from expander (D-03 contract)
        kind: 'action',
        name: dropped.name ?? '(unnamed)',
        type: 'if_else',
        reason: err.reason ?? err.message, // err.reason from expander; fall back to message
      });
      current = current.filter((_, j) => j !== idx);
    }
  }
  return current;
}

function isScaffoldIfElse(a) {
  if (!a || a.type !== 'if_else') return false;
  if (a.nodeType === 'condition-node' || a.nodeType === 'branch-yes' || a.nodeType === 'branch-no') return false;
  return Array.isArray(a.then) || Array.isArray(a.else);
}

/**
 * regression guard: throw when a create supplied actions but ALL of them
 * were HARD-dropped, leaving zero survivors. Prevents silently creating an
 * empty workflow the caller didn't ask for.
 *
 * Only throws when:
 *   - the caller supplied a non-empty actions array (empty-create still works), AND
 *   - no actions survived validation/expansion (partial salvage still works).
 *
 * Keys on HARD classes so a create that drops everything gets a loud, actionable
 * error naming the offending types. Called from orchestratedCreate ONLY —
 * orchestratedUpdate's empty-actions is a legitimate "delete all steps" op.
 *
 * @param {Array<object>} inputActions - caller-supplied actions (pre-pipeline)
 * @param {Array<object>} sanitizedActions - survivors after validate+expand
 * @param {Array<object>} skippedActions - skip records from the pipeline
 * @throws {Error} with .skippedActions attached when the guard trips
 */
function assertActionsSurvived(inputActions, sanitizedActions, skippedActions) {
  if (inputActions.length === 0) return; // legitimate empty-create
  if (sanitizedActions.length > 0) return; // partial salvage — some survived

  const hardDrops = skippedActions.filter((s) => HARD_CLASSES.has(s.class));
  if (hardDrops.length === 0) return; // not a HARD-drop situation — leave as-is

  const droppedTypes = [...new Set(hardDrops.map((s) => s.type ?? '(missing)'))];
  const err = new Error(
    `create_workflow: all ${inputActions.length} supplied action(s) were dropped as ` +
      `unrecognized (types: ${droppedTypes.join(', ')}). Refusing to create an empty ` +
      `workflow. Check the action \`type\` values against the action registry ` +
      `(src/registry/action-shapes.json) — the type names must match GHL's ` +
      `registry keys (or a known alias).`,
  );
  err.skippedActions = skippedActions;
  throw err;
}

/**
 * Decide final workflow status (D-04 force-draft policy).
 */
function decideFinalStatus(inputStatus, skippedActions) {
  const hasHardDrop = skippedActions.some((s) => HARD_CLASSES.has(s.class));
  return hasHardDrop ? 'draft' : inputStatus;
}

/**
 * Compose the response envelope. Always includes skippedActions[] and
 * warnings[] (possibly empty). partial = true iff any salvage activity occurred
 * (HARD or SOFT or WARN).
 */
function composeResponse(workflow, skippedActions, warnings) {
  const partial = skippedActions.length > 0 || warnings.length > 0;
  return {
    ...workflow,
    partial,
    skippedActions,
    warnings,
  };
}
