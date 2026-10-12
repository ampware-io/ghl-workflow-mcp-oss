/**
 * Pure pointer-rewire helpers for the patch_workflow tool (Phase 13.4).
 *
 * Each helper accepts a workflow object and an op-args object and returns
 * a NEW workflow (input is NOT mutated — uses structuredClone).
 *
 * Errors are THROWN (not returned) so the patch_workflow tool wrapper
 * can catch them and convert to the structured response envelope
 * defined in 13.4-CONTEXT D-08/D-09. Each Error carries:
 *   - .code     : string (one of "step_not_found" | "pointer_fields_forbidden"
 *                | "branched_step_unsupported" | "trigger_not_found")
 *   - .details  : object matching the D-09 shape for that code
 *
 * `isBranchedStep` is a structural-shape predicate (D-03/D-05) used by the
 * splice helpers (insertAfter / deleteStep / moveStep) to refuse operations
 * that would corrupt branched flows. updateStep deliberately does NOT call
 * this gate — attribute-only patches are safe even on branched steps.
 *
 * Branching-pointer correctness is owned by Phase 17. This module restricts
 * splice ops on branched steps as the v1 safety gate.
 *
 * 260426-lf7 added the trigger ops (addTrigger / updateTriggerOp /
 * removeTrigger). They mutate `clone.pendingTriggerOps[]` only — never
 * fire HTTP. The patch_workflow handler replays pendingTriggerOps into an
 * updateWorkflow `triggers` payload after the dry-run loop completes.
 */

import { EXPLICIT_TERMINAL } from './action-chain.js';
import crypto from 'node:crypto';

/**
 * Determine whether a workflow step has multiple outgoing pointers.
 *
 * A step is "branched" if ANY of:
 *   - `step.next` is an array (multi-target)
 *   - `step.branchYes` or `step.branchNo` is defined
 *   - `step.transitions` is an array with length > 1
 *   - `step.multipathBranches` is a non-empty array
 *
 * Lean toward false-positive: better to surface branched_step_unsupported
 * than to silently corrupt a branched workflow (CONTEXT specifics).
 *
 * @param {object} step - A workflow step / action object.
 * @returns {boolean} true if branched, false otherwise.
 */
export function isBranchedStep(step) {
  if (!step || typeof step !== 'object') return false;
  return Boolean(branchReason(step));
}

/**
 * Internal: returns the branch_reason string for a branched step, or null.
 *
 * Reason strings match D-09: "next_is_array" | "branch_yes_no"
 *                          | "transitions_multi" | "multipath".
 *
 * @param {object} step
 * @returns {string|null}
 */
function branchReason(step) {
  if (!step || typeof step !== 'object') return null;
  if (Array.isArray(step.next)) return 'next_is_array';
  if (step.branchYes !== undefined || step.branchNo !== undefined) return 'branch_yes_no';
  if (Array.isArray(step.transitions) && step.transitions.length > 1) return 'transitions_multi';
  if (Array.isArray(step.multipathBranches) && step.multipathBranches.length > 0) return 'multipath';
  // Shape-A branch STEP (real GHL wire model): the outer if_else condition-node
  // and its branch-yes/branch-no sibling steps. Splicing directly after one of
  // these is ambiguous and must stay refused. (RESEARCH §1/§3(b).) Note: a
  // branch CHILD/tail carries `parent`/`parentKey` but NOT one of these
  // nodeTypes, so it is not caught here and remains a supported insert target.
  if (step.nodeType === 'condition-node' || step.nodeType === 'branch-yes' || step.nodeType === 'branch-no') {
    return 'branch_node';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers (error builders + workflow utilities)
// ---------------------------------------------------------------------------

/**
 * Build a structured Error with `.code` and `.details` per D-09.
 *
 * @param {string} code
 * @param {string} message
 * @param {object} details
 * @returns {Error}
 */
function patchError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

function listValidStepIds(workflow) {
  return workflow.actions.map((a) => a.id);
}

function findStepIndex(workflow, stepId) {
  return workflow.actions.findIndex((a) => a.id === stepId);
}

/**
 * Throw step_not_found if no step in workflow has the given id.
 * Returns the index of the matching step on success.
 */
function requireStep(workflow, stepId) {
  const idx = findStepIndex(workflow, stepId);
  if (idx === -1) {
    throw patchError(
      'step_not_found',
      `Step "${stepId}" not found in workflow`,
      { step_id: stepId, valid_step_ids: listValidStepIds(workflow) },
    );
  }
  return idx;
}

/**
 * Throw branched_step_unsupported if the step matches the structural-branch
 * predicate. Used by splice helpers (insertAfter / deleteStep / moveStep)
 * but NOT by updateStep.
 */
function requireNotBranched(step) {
  const reason = branchReason(step);
  if (reason) {
    throw patchError(
      'branched_step_unsupported',
      `Step "${step.id}" is branched (${reason}); splice ops are not supported in v1. Use update_workflow for branched-step mutations.`,
      { step_id: step.id, branch_reason: reason },
    );
  }
}

/**
 * Whether `step` is a MEMBER of a branch (a Shape-A branch child/tail) rather
 * than a plain linear step. A branch child carries `parent`/`parentKey` back to
 * its enclosing branch step, or itself carries a branch nodeType. Used by
 * insertAfter to decide whether a leaf insert must terminate with an explicit
 * `next: null` (branch tail) vs `delete next` (linear leaf). (RESEARCH §3(a).)
 */
function isBranchMember(step) {
  if (!step || typeof step !== 'object') return false;
  return Boolean(step.parent || step.parentKey) ||
    step.nodeType === 'condition-node' ||
    step.nodeType === 'branch-yes' ||
    step.nodeType === 'branch-no';
}

/**
 * Renumber the `order` field of each action contiguously starting at 1,
 * preserving array order. Mutates the passed array in place (callers
 * always work on a structuredClone).
 */
function renumberOrder(actions) {
  for (let i = 0; i < actions.length; i++) {
    actions[i].order = i + 1;
  }
}

/**
 * Deep-merge `patch` into `target` in place. Plain-object values are merged
 * recursively; arrays and primitives replace wholesale. Used by updateStep
 * for attribute merging.
 */
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      target[k] !== null &&
      typeof target[k] === 'object' &&
      !Array.isArray(target[k])
    ) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Public mutation helpers
// ---------------------------------------------------------------------------

/**
 * Insert a new step immediately after `after_step_id`.
 *
 * Pointer wiring (D-04, SPEC Requirement 4):
 *   - new step's `parentKey` ← after_step_id
 *   - new step's `next`      ← old after_step_id.next
 *   - after_step_id.next     ← new step's id
 *   - `order` is renumbered contiguously across all actions
 *
 * Step ID semantics: if `step.id` is omitted or an empty string, a fresh
 * UUID is generated via `crypto.randomUUID()` BEFORE pointer wiring so
 * the inserted step's id is observable on the returned workflow (chained
 * patch ops can reference it).
 *
 * Refuses to operate when the target step is branched (D-04 — Phase 17
 * owns branch-pointer correctness).
 *
 * @param {object} workflow - Cached workflow snapshot.
 * @param {{after_step_id: string, step: object}} args
 * @returns {object} New workflow with the step inserted.
 * @throws {Error} code=step_not_found | branched_step_unsupported
 */
export function insertAfter(workflow, { after_step_id, step }) {
  const out = structuredClone(workflow);
  const afterIdx = requireStep(out, after_step_id);
  const afterStep = out.actions[afterIdx];
  requireNotBranched(afterStep);

  const newStep = structuredClone(step);
  if (!newStep.id || newStep.id === '') {
    newStep.id = crypto.randomUUID();
  }
  // parent vs parentKey invariant (RESEARCH §6): GHL persists/keys on
  // `parentKey`; the downstream auto-wire cross-chain guard
  // (action-chain.js:252-254) keys on `parent`. BOTH must be set — setting
  // only `parentKey` (the prior bug) left `parent` undefined, so the guard was
  // skipped and the inserted step cross-chained into the SIBLING branch's first
  // child (the reported corruption).
  newStep.parentKey = after_step_id;
  newStep.parent = after_step_id;
  // new.next inherits whatever after.next was (may be undefined for a leaf)
  if ('next' in afterStep) {
    newStep.next = afterStep.next;
  } else if (isBranchMember(afterStep)) {
    // Inserting after a branch TAIL (a branch member with no `next`): the
    // inserted step becomes the new tail. Set `next: null` EXPLICITLY (not
    // delete) so the auto-wire fallback treats it as caller-wired
    // (`'next' in {next:null}` is true → fallback skips it) instead of
    // cross-chaining it into the sibling branch. validateWiring treats
    // null `next` as no outgoing pointer, so no dangling-next violation.
    newStep.next = null;
  } else {
    // Linear leaf: keep prior behaviour so the auto-wire fallback can fill it.
    delete newStep.next;
  }
  afterStep.next = newStep.id;

  out.actions.splice(afterIdx + 1, 0, newStep);
  renumberOrder(out.actions);
  return out;
}

/**
 * Deep-merge `patch` into the named step. Top-level pointer fields
 * (`parentKey`, `order`) are always forbidden. `next` is forbidden
 * UNLESS the patch sets it to `null` (explicit termination) AND the
 * target step is not branched — this allows clearing a cross-chain
 * pointer without a full update_workflow resubmit.
 *
 * @param {object} workflow
 * @param {{step_id: string, patch: object}} args
 * @returns {object} New workflow with the step's attributes merged.
 * @throws {Error} code=step_not_found | pointer_fields_forbidden
 */
export function updateStep(workflow, { step_id, patch }) {
  const ALWAYS_FORBIDDEN = ['parentKey', 'order'];
  const present = ALWAYS_FORBIDDEN.filter((f) => patch && Object.prototype.hasOwnProperty.call(patch, f));

  // next:null (terminate) is allowed on non-branched steps; any other next value is forbidden
  const hasNext = patch && Object.prototype.hasOwnProperty.call(patch, 'next');
  const isTerminate = hasNext && patch.next === null;
  if (hasNext && !isTerminate) {
    present.push('next');
  }

  if (present.length > 0) {
    throw patchError(
      'pointer_fields_forbidden',
      `update_step patch contains forbidden pointer fields: ${present.join(', ')}. Use insert_after / delete_step / move for pointer changes.`,
      { step_id, forbidden_fields_present: present },
    );
  }

  const out = structuredClone(workflow);
  const idx = requireStep(out, step_id);
  const target = out.actions[idx];

  // Block next:null on branched steps — clearing a multi-target next would corrupt the branch
  if (isTerminate && isBranchedStep(target)) {
    throw patchError(
      'pointer_fields_forbidden',
      `update_step cannot set next:null on branched step "${step_id}" (${branchReason(target)}). Use update_workflow for branched-step pointer changes.`,
      { step_id, forbidden_fields_present: ['next'] },
    );
  }

  if (patch && typeof patch === 'object') {
    deepMerge(target, patch);
  }

  // next:null needs direct assignment — deepMerge won't set a key to null
  // when the target doesn't already have it, and we need the explicit null
  // to survive into the final payload
  if (isTerminate) {
    target.next = null;
  }

  // advanceCanvasMeta:null → set isDisabled:false (re-enable the step)
  if (patch && patch.advanceCanvasMeta === null) {
    target.advanceCanvasMeta = { isDisabled: false };
  }

  return out;
}

/**
 * Remove the named step. The predecessor (whichever step's `next` pointed
 * at the deleted id) has its `next` set to whatever the deleted step's
 * `next` was. `order` is renumbered contiguously.
 *
 * Refuses to operate when the target is branched.
 *
 * @param {object} workflow
 * @param {{step_id: string}} args
 * @returns {object}
 * @throws {Error} code=step_not_found | branched_step_unsupported
 */
export function deleteStep(workflow, { step_id }) {
  const out = structuredClone(workflow);
  const idx = requireStep(out, step_id);
  const target = out.actions[idx];
  requireNotBranched(target);

  const successor = 'next' in target ? target.next : undefined;

  // Patch the predecessor (any step whose scalar `next` pointed at step_id)
  for (const a of out.actions) {
    if (a.id !== step_id && a.next === step_id) {
      if (successor === undefined) {
        delete a.next;
      } else {
        a.next = successor;
      }
    }
  }

  out.actions.splice(idx, 1);
  renumberOrder(out.actions);
  return out;
}

/**
 * Splice the named step out of its current position and insert it after
 * `after_step_id`.
 *
 * Wiring:
 *   - old predecessor.next ← moved.next   (close the gap)
 *   - new after.next       ← step_id      (point new predecessor at moved)
 *   - moved.next           ← old after.next  (moved inherits new successor)
 *   - moved.parentKey      ← after_step_id
 *
 * Refuses to operate when EITHER the moved step OR the target after-step
 * is branched.
 *
 * @param {object} workflow
 * @param {{step_id: string, after_step_id: string}} args
 * @returns {object}
 * @throws {Error} code=step_not_found | branched_step_unsupported
 */
export function moveStep(workflow, { step_id, after_step_id }) {
  const out = structuredClone(workflow);
  const movedIdx = requireStep(out, step_id);
  const moved = out.actions[movedIdx];
  requireNotBranched(moved);

  const afterIdx = requireStep(out, after_step_id);
  const afterStep = out.actions[afterIdx];
  requireNotBranched(afterStep);

  // 1. Patch old predecessor: its .next was moved.id → becomes moved.next
  const oldNext = 'next' in moved ? moved.next : undefined;
  for (const a of out.actions) {
    if (a.id !== moved.id && a.next === moved.id) {
      if (oldNext === undefined) {
        delete a.next;
      } else {
        a.next = oldNext;
      }
    }
  }

  // 2. Splice moved out of its current position
  out.actions.splice(movedIdx, 1);

  // 3. Recompute after-step index (may have shifted) and inherit its old next
  const newAfterIdx = findStepIndex(out, after_step_id);
  const newAfterStep = out.actions[newAfterIdx];
  if ('next' in newAfterStep) {
    moved.next = newAfterStep.next;
  } else {
    delete moved.next;
  }
  newAfterStep.next = moved.id;
  moved.parentKey = after_step_id;

  // 4. Insert moved after the target
  out.actions.splice(newAfterIdx + 1, 0, moved);
  renumberOrder(out.actions);
  return out;
}

/**
 * Rewire a step's scalar `next` pointer IN PLACE — no splice, no reposition,
 * no `order` renumber (distinct from moveStep). Only overwrites the scalar
 * `next` field on the subject step.
 *
 * Validation:
 *   1. subject must exist                     → step_not_found
 *   2. subject must NOT be branched            → branched_step_unsupported
 *   3. if next !== null, target must exist     → step_not_found (target id in details)
 *   4. if next !== null, refuse self-loop      → self_loop_forbidden
 *   5. set subject.next = next (allow explicit null)
 *
 * Does NOT do cycle/orphan reachability analysis (v1 caveat — caller owns
 * flow correctness). Only the trivial self-loop is blocked.
 *
 * @param {object} workflow
 * @param {{step_id: string, next: string|null}} args
 * @returns {object} New workflow with subject.next rewired.
 * @throws {Error} code=step_not_found | branched_step_unsupported | self_loop_forbidden
 */
export function rewireStep(workflow, { step_id, next }) {
  const out = structuredClone(workflow);
  const idx = requireStep(out, step_id);
  const subject = out.actions[idx];
  requireNotBranched(subject);

  if (next !== null) {
    // self-loop refused before existence check on identical id is redundant,
    // but check self-loop explicitly so the error is self_loop_forbidden not step_not_found
    if (next === step_id) {
      throw patchError(
        'self_loop_forbidden',
        `rewire_step cannot point step "${step_id}" at itself`,
        { step_id, next },
      );
    }
    requireStep(out, next); // throws step_not_found (with next id + valid ids) if target missing
  }

  subject.next = next; // explicit null allowed (terminate)
  if (next === null) {
    // #77: tell the convergence pass this null is deliberate. Stripped by
    // action-chain before the payload is diffed or sent.
    subject[EXPLICIT_TERMINAL] = true;
  } else {
    delete subject[EXPLICIT_TERMINAL];
  }
  return out;
}

/**
 * #77 read-back check: compare each rewire_step op against the workflow GHL
 * returned AFTER the save. Returns one mismatch per step whose stored `next`
 * is not what the caller asked for. Only the last rewire per step counts, and
 * steps deleted by a later op are skipped.
 *
 * @param {object[]} operations - patch_workflow operations, in order
 * @param {object[]} observedActions - actions from the post-save GET
 * @returns {Array<{op: string, step_id: string, requested_next: string|null, observed_next: string|null}>}
 */
export function verifyRewires(operations, observedActions) {
  const wanted = new Map();
  for (const op of operations) {
    if (op.op === 'rewire_step') wanted.set(op.step_id, op.next);
    if (op.op === 'delete_step') wanted.delete(op.step_id);
  }
  const byId = new Map((observedActions || []).map((a) => [a.id, a]));
  const mismatches = [];
  for (const [stepId, requested] of wanted) {
    const step = byId.get(stepId);
    const observed = step ? (step.next ?? null) : '(step missing)';
    if (observed !== requested) {
      mismatches.push({ op: 'rewire_step', step_id: stepId, requested_next: requested, observed_next: observed });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// 260426-lf7: trigger ops — append to clone.pendingTriggerOps[].
// These do NOT fire HTTP. The patch_workflow handler replays the pending
// queue into a final triggers[] payload that updateWorkflow's diff path
// then materializes via POST/PUT/DELETE before the Step-3 save.
// ---------------------------------------------------------------------------

/**
 * Internal: throw `trigger_not_found` if the workflow's `triggers` array
 * has no entry whose id matches `triggerId`. Mirrors `requireStep` shape.
 */
function requireTrigger(workflow, triggerId) {
  const triggers = Array.isArray(workflow?.triggers) ? workflow.triggers : [];
  const found = triggers.find((t) => t && t.id === triggerId);
  if (!found) {
    throw patchError(
      'trigger_not_found',
      `Trigger "${triggerId}" not found in workflow`,
      {
        trigger_id: triggerId,
        valid_trigger_ids: triggers.map((t) => t.id).filter(Boolean),
      },
    );
  }
  return found;
}

/**
 * Append a {kind:'create', trigger} entry to clone.pendingTriggerOps[].
 * Initializes the array on the clone if absent. Input not mutated.
 *
 * @param {object} workflow
 * @param {{trigger: object}} args
 * @returns {object}
 */
export function addTrigger(workflow, { trigger }) {
  const out = structuredClone(workflow);
  if (!Array.isArray(out.pendingTriggerOps)) out.pendingTriggerOps = [];
  out.pendingTriggerOps.push({ kind: 'create', trigger });
  return out;
}

/**
 * Append a {kind:'update', triggerId, patch} entry to clone.pendingTriggerOps[].
 * Throws trigger_not_found if the id is missing from current triggers.
 * Exported as `updateTriggerOp` (NOT `updateTrigger`) to avoid colliding
 * with src/api/triggers.js#updateTrigger when both are imported.
 *
 * @param {object} workflow
 * @param {{trigger_id: string, patch: object}} args
 * @returns {object}
 * @throws {Error} code=trigger_not_found
 */
export function updateTriggerOp(workflow, { trigger_id, patch }) {
  requireTrigger(workflow, trigger_id);
  const out = structuredClone(workflow);
  if (!Array.isArray(out.pendingTriggerOps)) out.pendingTriggerOps = [];
  out.pendingTriggerOps.push({ kind: 'update', triggerId: trigger_id, patch });
  return out;
}

/**
 * Append a {kind:'delete', triggerId} entry to clone.pendingTriggerOps[].
 * Throws trigger_not_found if the id is missing from current triggers.
 *
 * @param {object} workflow
 * @param {{trigger_id: string}} args
 * @returns {object}
 * @throws {Error} code=trigger_not_found
 */
export function removeTrigger(workflow, { trigger_id }) {
  requireTrigger(workflow, trigger_id);
  const out = structuredClone(workflow);
  if (!Array.isArray(out.pendingTriggerOps)) out.pendingTriggerOps = [];
  out.pendingTriggerOps.push({ kind: 'delete', triggerId: trigger_id });
  return out;
}
