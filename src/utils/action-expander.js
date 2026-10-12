/**
 * High-level if/else scaffold expander (Phase 18 SPEC #5, SPEC #8, D-05/D-06/D-07/D-08).
 *
 * Pure, stateless, side-effect-free. Transforms an agent-friendly
 *   { type: 'if_else', attributes: { conditions: [...] }, then: [...], else: [...] }
 * shape into Phase 17's verbose three-sibling wire format
 *   ({ nodeType: 'condition-node' } + branch-yes + branch-no + branch children
 *    with parent/parentKey/sibling/next correctly wired).
 *
 * Recursive bottom-up walk (D-06): inner then[]/else[] are expanded first,
 * then the outer if_else materializes its three siblings. An if_else already
 * in verbose form (nodeType: 'condition-node' set on the outer) passes through
 * unchanged (D-06).
 *
 * Empty branches are valid (D-08): then: [] or else: [] makes the
 * corresponding branch sibling have next: undefined — workflow exits there.
 *
 * Mixed scaffold-and-verbose is rejected (D-08): if a then[]/else[] contains
 * an action with nodeType: 'branch-yes' | 'branch-no' | 'condition-node',
 * throws with the message tagged `malformed-if-else` so the orchestrator can
 * convert it into a skippedActions entry.
 *
 * SPEC #8 scaffold-less wrong-shape pre-check: an action with type:'if_else'
 * AND no then/else AND no nodeType:'condition-node' AND attributes.conditions
 * present without attributes.branches is the EOI canonical failure case.
 * HARD-rejected with err.class='malformed-if-else' so the orchestrator drops
 * it (vs SOFT-salvaging it via attributes replacement, which would silently
 * lose the agent's condition logic). The error reason points the agent at the
 * then/else scaffold contract.
 *
 * UUIDs (D-07): outer id reuses caller's if supplied else fresh
 * crypto.randomUUID(); branch-yes / branch-no are always fresh.
 *
 * Phase 17's src/utils/action-chain.js is unmodified — this module produces
 * input to buildActionChain / diffAndWireActions, not a replacement.
 */

import crypto from 'node:crypto';

const NODETYPE_MARKERS = new Set(['condition-node', 'branch-yes', 'branch-no']);

/**
 * Expand a flat actions array, transforming each scaffold if_else into the
 * three-sibling wire format. Non-if_else actions pass through unchanged.
 *
 * @param {Array<object>} actions - Caller-supplied flat actions array
 * @returns {Array<object>} - Flat array with all scaffold if_else expanded
 * @throws {Error} - With class 'malformed-if-else' if (a) a then[]/else[] mixes scaffold+verbose, OR (b) a scaffold-less wrong-shape if_else is encountered (SPEC #8)
 */
export function expandIfElse(actions) {
  const out = [];
  for (const action of actions ?? []) {
    // SPEC #8 scaffold-less wrong-shape pre-check — HARD-reject before any other handling.
    rejectScaffoldlessWrongShape(action);

    if (!isIfElseScaffold(action)) {
      // Non-if_else, OR if_else already in verbose form (nodeType set) — passthrough
      out.push(action);
      continue;
    }
    // Mixed-form rejection runs on the RAW caller branch (D-08). Checking the
    // expanded output would false-trigger because our own bottom-up materialization
    // legitimately introduces nodeType:'condition-node'/'branch-yes'/'branch-no'
    // inside the parent branch when an inner if_else is expanded.
    rejectMixedForm(action.then ?? [], 'then');
    rejectMixedForm(action.else ?? [], 'else');
    // Recursive bottom-up: expand inner branches first, then materialize outer
    const expandedThen = expandIfElse(action.then ?? []);
    const expandedElse = expandIfElse(action.else ?? []);
    const materialized = materializeIfElse(action, expandedThen, expandedElse);
    out.push(...materialized);
  }
  return out;
}

/**
 * Detect scaffold form: type === 'if_else' AND (then or else array present)
 * AND nodeType not already set to a wire-format marker.
 */
function isIfElseScaffold(action) {
  if (!action || action.type !== 'if_else') return false;
  if (NODETYPE_MARKERS.has(action.nodeType)) return false; // already in verbose form
  // Scaffold requires at least one of then/else to be an array
  return Array.isArray(action.then) || Array.isArray(action.else);
}

/**
 * SPEC #8: HARD-reject scaffold-less wrong-shape if_else.
 *
 * Conditions ALL must hold:
 *   - type === 'if_else'
 *   - then === undefined (not supplied; differs from then: [] which is valid empty branch)
 *   - else === undefined
 *   - nodeType !== 'condition-node' (also not branch-yes/branch-no)
 *   - attributes.conditions !== undefined  (caller supplied wrong-shape conditions)
 *   - attributes.branches === undefined    (caller did NOT supply the captured wire shape)
 *
 * This is the EOI canonical failure case: agent hand-authored an if_else with
 * `attributes: { conditions: [...] }` (the OLD wire shape) instead of either
 * the scaffold (then/else with plain actions) or the captured verbose form
 * (nodeType:'condition-node' + attributes.branches[]).
 *
 * Rejecting HARD (rather than SOFT-salvaging via defaultAttributes replacement)
 * preserves the agent's intent visibility — they get an error message pointing
 * at the then/else scaffold contract, not a silently-degraded workflow with
 * the conditions stripped.
 */
function rejectScaffoldlessWrongShape(action) {
  if (!action || action.type !== 'if_else') return;
  if (action.then !== undefined || action.else !== undefined) return; // scaffold form
  if (NODETYPE_MARKERS.has(action.nodeType)) return; // verbose form
  const attrs = action.attributes;
  if (!attrs || typeof attrs !== 'object') return;
  if (attrs.conditions === undefined) return; // no wrong-shape signal
  if (attrs.branches !== undefined) return; // has branches → not the wrong shape
  // All conditions met — this is the EOI canonical failure case
  const reason =
    'if_else uses attributes.conditions without then/else scaffold or condition-node verbose form. ' +
    'Use the then/else scaffold (see the GHL Workflow Docs MCP for the if_else reference).';
  const err = new Error(`malformed-if-else: ${reason}`);
  err.class = 'malformed-if-else';
  err.reason = reason;
  throw err;
}

/**
 * Throw with class 'malformed-if-else' if branchActions contains any
 * wire-format markers (mixed-form rejection per D-08).
 */
function rejectMixedForm(branchActions, branchLabel) {
  for (const a of branchActions) {
    if (a && NODETYPE_MARKERS.has(a.nodeType)) {
      const reason =
        `${branchLabel}[] mixes scaffold and verbose forms; use one or the other ` +
        `(see the GHL Workflow Docs MCP for the if_else reference).`;
      const err = new Error(
        `malformed-if-else: ${branchLabel}[] contains an action with nodeType="${a.nodeType}"; ` +
          `the then/else scaffold cannot be mixed with the verbose wire format inside the same branch. ` +
          `Use either the scaffold (then/else with plain actions) OR the verbose form (three sibling steps with nodeType set), not both.`,
      );
      err.class = 'malformed-if-else';
      err.reason = reason;
      throw err;
    }
  }
}

/**
 * Materialize one if_else scaffold into outer + branch-yes + branch-no
 * + branch children with parent/parentKey set on each child.
 *
 * @returns {Array<object>} - The outer + 2 siblings + then-children + else-children, in that order
 */
function materializeIfElse(scaffold, thenActions, elseActions) {
  const outerId = scaffold.id ?? crypto.randomUUID();
  const yesId = crypto.randomUUID();
  const noId = crypto.randomUUID();

  // OUTER: spread caller fields first (passthrough discipline — Phase 17 D-01),
  // then inject wire-format-managed fields. attributes.branches comes from caller's
  // attributes if shaped, else passthrough as-is (the validator handles shape salvage).
  const outer = {
    ...scaffold,
    id: outerId,
    type: 'if_else',
    nodeType: 'condition-node',
    next: [yesId, noId],
    attributes: scaffold.attributes ?? {},
  };
  // Strip the scaffold-only fields from outer
  delete outer.then;
  delete outer.else;

  // Ensure first-child IDs exist (we mutate the action array in-place to share
  // the assigned id with the actual child object that follows).
  if (thenActions.length > 0 && thenActions[0].id === undefined) {
    thenActions[0].id = crypto.randomUUID();
  }
  if (elseActions.length > 0 && elseActions[0].id === undefined) {
    elseActions[0].id = crypto.randomUUID();
  }

  // BRANCH-YES sibling
  const yesLabel = pickLabel(scaffold, 0, 'Yes branch');
  const branchYes = {
    id: yesId,
    type: 'if_else',
    name: yesLabel,
    nodeType: 'branch-yes',
    parent: outerId,
    parentKey: outerId,
    sibling: [noId],
    attributes: {},
    ...(thenActions.length > 0 ? { next: thenActions[0].id } : {}),
  };

  // BRANCH-NO sibling
  const noLabel = pickLabel(scaffold, 1, 'No branch');
  const branchNo = {
    id: noId,
    type: 'if_else',
    name: noLabel,
    nodeType: 'branch-no',
    parent: outerId,
    parentKey: outerId,
    sibling: [yesId],
    attributes: {},
    ...(elseActions.length > 0 ? { next: elseActions[0].id } : {}),
  };

  // Set parent/parentKey on each child of then[] and else[]
  const thenChildren = thenActions.map((c) => ({ ...c, parent: yesId, parentKey: yesId }));
  const elseChildren = elseActions.map((c) => ({ ...c, parent: noId, parentKey: noId }));

  // Prevent auto-wire from cross-chaining: each branch's last child must
  // explicitly terminate. Without this, buildActionChain fills the missing
  // `next` with the next array item — which is the other branch's first child.
  if (thenChildren.length > 0) thenChildren[thenChildren.length - 1].next = null;
  if (elseChildren.length > 0) elseChildren[elseChildren.length - 1].next = null;

  return [outer, branchYes, branchNo, ...thenChildren, ...elseChildren];
}

/**
 * Pick branch label from scaffold.attributes.branches[idx].label if present,
 * else fall back. NEVER read scaffold.attributes.branches[*].label content
 * for any other purpose (T-17-02-01 — labels are a known-safe field).
 */
function pickLabel(scaffold, idx, fallback) {
  const branches = scaffold?.attributes?.branches;
  const label = Array.isArray(branches) && branches[idx]?.label;
  return typeof label === 'string' && label.length > 0 ? label : fallback;
}
