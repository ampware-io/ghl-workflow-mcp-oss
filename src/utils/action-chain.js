/**
 * Pure utility functions for workflow action chain wiring, diffing,
 * trigger format translation, and payload construction.
 *
 * All functions are stateless and side-effect free.
 * UUID generation uses Node 20+ built-in crypto.randomUUID().
 */

import crypto from 'node:crypto';

/**
 * Sorted-key canonical JSON stringify. Stable across engines and
 * key-write order — used by `templateChanged` for the modifiedSteps diff
 * (D-10). First use; promote to src/utils/ at the 3rd caller per the
 * Plan 13.1-05 extraction threshold.
 *
 * @param {*} obj
 * @returns {string}
 */
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Full-template diff for modifiedSteps (D-09, D-10). Excludes the
 * managed `order` field — index-derived, never user intent. Any drift
 * across every other preserved field (next, parent, sibling, attributes,
 * nodeType, parentKey, cat, comments, …) flips the template to modified.
 *
 * @param {object} oldT
 * @param {object} newT
 * @returns {boolean}
 */
/**
 * Wire branch-terminal steps to the convergence point after their if_else block.
 *
 * After if_else expansion, the last child of each branch has next:null (set by
 * the expander to prevent cross-chaining). This leaves any step placed after
 * the if_else in the flat array orphaned. This pass finds those branch-terminal
 * steps and wires them to the first post-block step (the convergence point),
 * matching the GHL builder's behavior where both branches rejoin after the block.
 *
 * Only touches steps where next is explicitly null AND the step's parent is a
 * branch-yes/branch-no sibling. Steps with non-null next (caller-wired) are
 * never modified.
 */
/**
 * Marker set by patch-ops `rewireStep(..., next: null)` to say "this null is a
 * deliberate terminal, not an expander placeholder". wireBranchConvergence
 * skips marked steps; stripExplicitTerminal removes the key before the payload
 * is diffed or sent to GHL. (#77: without it, rewire_step {next:null} on a
 * branch tail was silently re-converged and the patch reported success.)
 */
export const EXPLICIT_TERMINAL = '__explicitTerminal';

function stripExplicitTerminal(templates) {
  for (const t of templates) delete t[EXPLICIT_TERMINAL];
}

function wireBranchConvergence(templates) {
  const idxById = new Map(templates.map((t, i) => [t.id, i]));
  const byId = new Map(templates.map((t) => [t.id, t]));

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (t.next !== null) continue;
    if (t[EXPLICIT_TERMINAL]) continue;   // caller asked for a terminal — honour it
    if (!t.parent) continue;

    const parentTemplate = byId.get(t.parent);
    if (!parentTemplate) continue;
    if (parentTemplate.nodeType !== 'branch-yes' && parentTemplate.nodeType !== 'branch-no') continue;

    // This is a branch-terminal step. Find the if_else outer (grandparent).
    const outerId = parentTemplate.parent;
    if (!outerId || !idxById.has(outerId)) continue;
    const outerIdx = idxById.get(outerId);

    // Scan forward from the outer to find the first step that is NOT part of
    // this if_else block (no parent chain leading back to outerId).
    const blockIds = new Set([outerId]);
    // Collect all IDs that belong to this block (siblings + children)
    for (let j = outerIdx + 1; j < templates.length; j++) {
      if (blockIds.has(templates[j].parent)) {
        blockIds.add(templates[j].id);
      }
    }
    // First step after the block
    for (let j = outerIdx + 1; j < templates.length; j++) {
      if (!blockIds.has(templates[j].id)) {
        templates[i].next = templates[j].id;
        break;
      }
    }
  }
}

function templateChanged(oldT, newT) {
  // eslint-disable-next-line no-unused-vars
  const strip = ({ order, ...rest }) => rest;
  return canonicalStringify(strip(oldT)) !== canonicalStringify(strip(newT));
}

/**
 * Build an action chain from caller-provided action descriptions.
 *
 * Phase 17 D-01..D-05 contract:
 *   - MANAGED  : `id` (fresh crypto.randomUUID()) and `order` (array index).
 *                Whatever the caller wrote there is overwritten.
 *   - PASSTHROUGH : every other field on the caller action is spread onto
 *                the output template byte-for-byte. The Zod boundary in
 *                src/server.js uses .passthrough() so unlisted wiring
 *                fields (next, nodeType, parent, parentKey, sibling, cat,
 *                comments, …) reach this function intact.
 *   - AUTO-WIRE FALLBACK (D-04) : `next` is auto-filled to the next
 *                template's id ONLY when the caller did NOT include a
 *                `next` key on the source action. If `next` was explicitly
 *                supplied (even as `undefined`), the caller's value wins.
 *   - GOTO SPECIAL CASE (Pitfall 4 / json-schema:469) : when
 *                `action.type === 'goto'`, the auto-wire fallback is
 *                skipped entirely. A goto with no caller `next` ends up
 *                with NO `next` key. A goto WITH explicit `next` keeps it.
 *   - LAST-TEMPLATE STRIP (D-15 canary) : when the last template has no
 *                caller-supplied `next`, the post-spread `next` (if any)
 *                is deleted, preserving the historical "last action has
 *                no next" invariant.
 *
 * @param {Array<{type: string, name: string, attributes?: object}>} actions
 * @returns {{templates: object[], createdSteps: string[]}}
 */
export function buildActionChain(actions) {
  const templates = actions.map((action, index) => {
    const template = {
      ...action,                        // PASSTHROUGH (D-01) — must come first
      id: action.id || crypto.randomUUID(), // MANAGED (D-02) — preserve caller ID when supplied
      order: index,                     // MANAGED (D-03)
    };
    if (template.attributes === undefined) template.attributes = {};
    return template;
  });

  // Per-template auto-wire fallback (D-04) with goto special case (Pitfall 4).
  // The `'next' in action` check reads the SOURCE action (not the post-spread
  // template) so we can distinguish "caller omitted the key" from "caller
  // wrote next: undefined" — both look identical after spread.
  for (let i = 0; i < templates.length; i++) {
    const callerAction = actions[i];
    const callerSuppliedNext = 'next' in callerAction;
    const isGoto = callerAction.type === 'goto';

    if (callerSuppliedNext) continue;          // explicit caller wiring wins
    if (isGoto) continue;                      // Pitfall 4: never auto-wire goto

    if (i < templates.length - 1) {
      // Don't auto-wire across parent boundaries — a branch's last child
      // must not chain into a step with a different parent (cross-chain bug).
      const curParent = templates[i].parent;
      const nextParent = templates[i + 1].parent;
      if (curParent && curParent !== nextParent) continue;

      templates[i].next = templates[i + 1].id;
    } else if ('next' in templates[i]) {
      delete templates[i].next;                // last template strip (D-15 canary)
    }
  }

  wireBranchConvergence(templates);
  stripExplicitTerminal(templates);

  const createdSteps = templates.map((t) => t.id);
  return { templates, createdSteps };
}

/**
 * Normalize a trigger condition from read-format to write-format.
 *
 * Read format:  { operator: "==", value: "string" }
 * Write format: { operator: "is-any-of", value: ["string"], type: "string" }
 *
 * Already-write-format and unknown formats are passed through unchanged (D-16).
 *
 * @param {object} condition - Trigger condition object
 * @returns {object} Normalized condition
 */
export function normalizeToWriteFormat(condition) {
  // Already in write format
  if (condition.operator === 'is-any-of' && Array.isArray(condition.value)) {
    return condition;
  }

  // Read format -> write format conversion
  if (condition.operator === '==' && typeof condition.value === 'string') {
    return { ...condition, operator: 'is-any-of', value: [condition.value], type: 'string' };
  }

  // Unknown format: pass through, let GHL enforce (D-16)
  return condition;
}

/**
 * Compute the diff between old and new action lists and wire the new chain.
 *
 * Actions in newActions WITH an .id matching an old action are preserved.
 * Actions WITHOUT .id get new UUIDs. Old actions not in newActions are deleted.
 *
 * Phase 17 D-01..D-05 contract (mirror of buildActionChain — see that
 * function's JSDoc for the full passthrough / auto-wire / goto rules).
 *
 * Phase 17-02 (D-09, D-10): `modifiedSteps` now uses a full-template
 * canonical-JSON diff (sorted keys, `order` excluded). Wiring drift —
 * including caller `next`, `parent`, `parentKey`, `sibling`,
 * `nodeType`, plus everything in `attributes` — counts. Diff runs AFTER
 * per-template fallback wiring so auto-wired `next` participates.
 *
 * Phase 17-02 (D-06, D-07, D-08): wiring is validated post-fallback.
 * `validateWiring(templates)` returns structured violations; non-empty
 * causes a throw with a formatted summary that names ids + classes
 * (NEVER attributes content per T-17-02-01).
 *
 * @param {object[]} oldActions - Existing templates from getWorkflow response
 * @param {object[]} newActions - New action list from AI input
 * @returns {{templates: object[], createdSteps: string[], modifiedSteps: string[], deletedSteps: string[]}}
 */
export function diffAndWireActions(oldActions, newActions) {
  const oldMap = new Map(oldActions.map((a) => [a.id, a]));

  const createdSteps = [];
  const modifiedSteps = [];

  // Pass 1: build templates (id assignment + createdSteps tracking only).
  // The full-template diff for modifiedSteps lives in a post-fallback pass
  // because the caller's `next` may be filled in by the fallback below.
  const templates = newActions.map((action, index) => {
    let id;
    if (action.id) {
      id = action.id;                    // MANAGED (D-02) — preserve caller ID
      if (!oldMap.has(id)) createdSteps.push(id);
    } else {
      id = crypto.randomUUID();          // MANAGED (D-02; fresh)
      createdSteps.push(id);
    }
    const template = {
      ...action,                         // PASSTHROUGH (D-01) — must come first
      id,
      order: index,                      // MANAGED (D-03)
    };
    if (template.attributes === undefined) template.attributes = {};
    return template;
  });

  // Per-template auto-wire fallback (D-04) with goto special case (Pitfall 4).
  // Identical loop to buildActionChain — see that JSDoc for rationale.
  for (let i = 0; i < templates.length; i++) {
    const callerAction = newActions[i];
    const callerSuppliedNext = 'next' in callerAction;
    const isGoto = callerAction.type === 'goto';

    if (callerSuppliedNext) continue;
    if (isGoto) continue;

    if (i < templates.length - 1) {
      // Don't auto-wire across parent boundaries — a branch's last child
      // must not chain into a step with a different parent (cross-chain bug).
      const curParent = templates[i].parent;
      const nextParent = templates[i + 1].parent;
      if (curParent && curParent !== nextParent) continue;

      templates[i].next = templates[i + 1].id;
    } else if ('next' in templates[i]) {
      delete templates[i].next;
    }
  }

  wireBranchConvergence(templates);
  stripExplicitTerminal(templates);

  // Deleted steps: old IDs not in new list
  const newIdSet = new Set(newActions.filter((a) => a.id).map((a) => a.id));
  const deletedSteps = oldActions
    .filter((a) => !newIdSet.has(a.id))
    .map((a) => a.id);

  // Pass 2: full-template canonical diff for modifiedSteps (D-09, D-10).
  // Runs AFTER per-template fallback so fallback-induced `next` drift counts.
  // `order` is excluded inside templateChanged (managed; index-derived).
  for (const t of templates) {
    if (!oldMap.has(t.id)) continue;     // newly created — already in createdSteps
    const oldT = oldMap.get(t.id);
    if (templateChanged(oldT, t)) {
      modifiedSteps.push(t.id);
    }
  }

  // Pre-flight wiring validation (D-06, D-07, D-08) — runs on FINAL post-fallback
  // templates so auto-wired `next` pointers participate in the dangling check.
  // Throws Error with formatted summary on ≥1 violation; never reaches return.
  const violations = validateWiring(templates);
  if (violations.length > 0) {
    const lines = violations.map(formatViolation);
    const noun = violations.length === 1 ? 'violation' : 'violations';
    throw new Error(
      `Workflow wiring validation failed (${violations.length} ${noun}):\n` +
      lines.map((l) => `  - ${l}`).join('\n'),
    );
  }

  return { templates, createdSteps, modifiedSteps, deletedSteps };
}

/**
 * Pure pre-flight wiring validator. Returns structured violations (never throws).
 *
 * Three classes (D-06):
 *   - dangling-next: a `next` (string or array element) OR a goto's
 *     `attributes.targetNodeId` references an id not in templates.
 *     Distinguished by `pointer: 'next' | 'targetNodeId'`.
 *   - broken-sibling-pair: branch-yes/branch-no nodes don't pair correctly
 *     (count !== 2, sibling[] non-reciprocal, or nodeType not yes+no).
 *   - orphan: template is not first, not reachable via any next, and has no
 *     parent that is in templates.
 *
 * Security (T-17-02-01): violation objects expose only `id`, `name`, ids of
 * related templates, class, and reason. NEVER touches `attributes` content —
 * `formatViolation` and any caller composing user-visible messages must follow
 * the same discipline.
 *
 * @param {object[]} templates
 * @returns {Array<{class: string, [k: string]: any}>}
 */
export function validateWiring(templates) {
  const violations = [];
  const idSet = new Set(templates.map((t) => t.id));
  const reachable = new Set();

  // Class 1: dangling next + dangling targetNodeId
  for (const t of templates) {
    const nexts = Array.isArray(t.next) ? t.next : (t.next ? [t.next] : []);
    for (const n of nexts) {
      if (!idSet.has(n)) {
        violations.push({
          class: 'dangling-next',
          templateId: t.id,
          templateName: t.name,
          offendingId: n,
          pointer: 'next',
        });
      } else {
        reachable.add(n);
      }
    }
    // goto's targetNodeId is its effective next (RESEARCH Open Q3 fold).
    const tnid = t.attributes && t.attributes.targetNodeId;
    if (tnid) {
      if (!idSet.has(tnid)) {
        violations.push({
          class: 'dangling-next',
          templateId: t.id,
          templateName: t.name,
          offendingId: tnid,
          pointer: 'targetNodeId',
        });
      } else {
        reachable.add(tnid);
      }
    }
  }

  // Class 2: branch-yes / branch-no sibling pairing — group by parent
  const branchesByOuter = new Map();
  for (const t of templates) {
    if (t.nodeType === 'branch-yes' || t.nodeType === 'branch-no') {
      const outer = t.parent;
      if (!branchesByOuter.has(outer)) branchesByOuter.set(outer, []);
      branchesByOuter.get(outer).push(t);
    }
  }
  for (const [outerId, kids] of branchesByOuter) {
    if (kids.length !== 2) {
      violations.push({
        class: 'broken-sibling-pair',
        outerId,
        found: kids.map((k) => k.id),
      });
      continue;
    }
    const [a, b] = kids;
    const aSibOk = Array.isArray(a.sibling) && a.sibling.includes(b.id);
    const bSibOk = Array.isArray(b.sibling) && b.sibling.includes(a.id);
    const nodeTypeOk =
      (a.nodeType === 'branch-yes' && b.nodeType === 'branch-no') ||
      (a.nodeType === 'branch-no'  && b.nodeType === 'branch-yes');
    if (!aSibOk || !bSibOk || !nodeTypeOk) {
      violations.push({
        class: 'broken-sibling-pair',
        outerId,
        offendingIds: [a.id, b.id],
        reason: !nodeTypeOk ? 'nodeType-not-paired' : 'sibling-array-mismatch',
      });
    }
  }

  // Class 3: orphan — not the first template, not reachable from any next,
  // and not a branch child whose parent is in templates.
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const isRoot = i === 0;
    const isBranchChild = t.parent && idSet.has(t.parent);
    if (!isRoot && !reachable.has(t.id) && !isBranchChild) {
      violations.push({
        class: 'orphan',
        templateId: t.id,
        templateName: t.name,
      });
    }
  }

  return violations;
}

/**
 * Format a single violation into a user-readable line for the thrown Error
 * message. Composed exclusively from id / name / class / pointer / offendingId
 * / outerId / reason — NEVER touches `attributes` (T-17-02-01 PII guard).
 *
 * @param {{class: string, [k: string]: any}} v
 * @returns {string}
 */
function formatViolation(v) {
  if (v.class === 'dangling-next') {
    const pointerLabel = v.pointer === 'targetNodeId' ? 'attributes.targetNodeId' : 'next';
    const nameLabel = v.templateName ? `"${v.templateName}" ` : '';
    return `dangling-next: template ${nameLabel}(id: ${v.templateId}) → ${pointerLabel} references "${v.offendingId}" which is not in templates`;
  }
  if (v.class === 'broken-sibling-pair') {
    if (v.reason) {
      const ids = (v.offendingIds || []).join(', ');
      return `broken-sibling-pair: outer (id: ${v.outerId}) — ${v.reason} (offending: [${ids}])`;
    }
    const found = (v.found || []).join(', ');
    return `broken-sibling-pair: outer (id: ${v.outerId}) — expected 2 branch children, found [${found}]`;
  }
  if (v.class === 'orphan') {
    const nameLabel = v.templateName ? `"${v.templateName}" ` : '';
    return `orphan: template ${nameLabel}(id: ${v.templateId}) is unreachable from any next pointer or branch parent`;
  }
  // Defensive default — should never fire; new classes must add a branch above.
  return `${v.class}: ${JSON.stringify({ ...v, attributes: undefined })}`;
}

/**
 * Id-keyed diff between current and requested trigger lists.
 *
 * Pure function — no clones, no mutations, no HTTP. Mirrors the shape of
 * `diffAndWireActions` so callers can iterate creates → updates → deletes
 * sequentially and produce a `finalTriggers` list for the Step-3 save.
 *
 * Classification rules (260426-lf7):
 *   - `requested === undefined` → caller did not ask for trigger changes;
 *     returns { creates: [], updates: [], deletes: [], unchanged: [...current] }.
 *   - For each item in `requested`:
 *       - `id` in current AND byte-equal (canonicalStringify, id stripped)
 *         → `unchanged` (skip the no-op PUT).
 *       - `id` in current and content differs                 → `updates`.
 *       - `id` missing or not in current                      → `creates`.
 *   - For each current trigger whose id is NOT in `requested` → `deletes`.
 *   - `requested === []` → all current triggers go to `deletes`.
 *
 * @param {object[]} current   — full-shape current triggers from getWorkflow(..., {includeActionDetails: true})
 * @param {object[]|undefined} requested — caller-supplied trigger list (may be undefined / empty)
 * @returns {{creates: object[], updates: object[], deletes: object[], unchanged: object[]}}
 */
export function diffTriggers(current, requested) {
  const currentArr = current || [];

  if (requested === undefined) {
    return { creates: [], updates: [], deletes: [], unchanged: [...currentArr] };
  }

  const currentById = new Map();
  for (const t of currentArr) {
    if (t && t.id) currentById.set(t.id, t);
  }

  // Strip id before canonical comparison so id-only equality differences don't
  // flip an otherwise-byte-equal trigger into an `update`.
  const stripId = (t) => {
    // eslint-disable-next-line no-unused-vars
    const { id, ...rest } = t;
    return rest;
  };

  const creates = [];
  const updates = [];
  const unchanged = [];
  const seenIds = new Set();

  for (const req of requested) {
    if (req && req.id && currentById.has(req.id)) {
      seenIds.add(req.id);
      const cur = currentById.get(req.id);
      if (canonicalStringify(stripId(cur)) === canonicalStringify(stripId(req))) {
        unchanged.push(cur);
      } else {
        updates.push(req);
      }
    } else {
      creates.push(req);
    }
  }

  const deletes = currentArr.filter((t) => t && t.id && !seenIds.has(t.id));

  return { creates, updates, deletes, unchanged };
}

/**
 * Build the Step 1 shell payload for creating a new workflow.
 * Uses snake_case company_id and company_age per MCP-SPEC.md.
 *
 * @param {string} name - Workflow name
 * @param {object} ctx - Write context from apiClient.getWriteContext()
 * @param {object} [settings] - Workflow-level settings; falls back to hardcoded defaults when fields are omitted. (VRX)
 * @returns {object} Shell payload
 */
export function buildShellPayload(name, ctx, settings = {}) {
  return {
    name,
    status: 'draft',
    parentId: null,
    updatedBy: ctx.user_id,
    modifiedSteps: [],
    deletedSteps: [],
    createdSteps: [],
    senderAddress: {},
    stopOnResponse: settings.stopOnResponse ?? false,
    allowMultiple: settings.allowMultiple ?? true,
    allowMultipleOpportunity: settings.allowMultipleOpportunity ?? true,
    autoMarkAsRead: settings.autoMarkAsRead ?? false,
    eventStartDate: '',
    timezone: settings.timezone ?? '',
    workflowData: { templates: [] },
    triggersChanged: false,
    company_id: ctx.company_id,
    company_age: ctx.company_age,
  };
}

/**
 * Resolve a trigger's conditions from either the canonical top-level
 * `conditions` or the tolerated `attributes.conditions` alias. Top-level
 * wins when it is a non-empty array (top-level is the shape GHL persists).
 * A stray/mirrored `attributes.conditions` is only used when top-level is
 * empty or absent. Returns raw (un-normalized) conditions — callers
 * normalize as needed (buildTriggerPayload does, buildSavePayload does not).
 *
 * @param {object} trigger
 * @returns {object[]}
 */
export function resolveTriggerConditions(trigger) {
  const top = trigger?.conditions;
  if (Array.isArray(top) && top.length > 0) return top;
  const nested = trigger?.attributes?.conditions;
  if (Array.isArray(nested) && nested.length > 0) return nested;
  return Array.isArray(top) ? top : (Array.isArray(nested) ? nested : []);
}

/**
 * Build the Step 2 trigger payload for attaching a trigger to a workflow.
 * Uses snake_case company_id and company_age per MCP-SPEC.md.
 * Conditions are run through normalizeToWriteFormat.
 *
 * @param {object} trigger - Trigger definition
 * @param {string} workflowId - Workflow ID from Step 1
 * @param {string} locationId - Location ID
 * @param {object} ctx - Write context
 * @returns {object} Trigger payload
 */
export function buildTriggerPayload(trigger, workflowId, locationId, ctx) {
  return {
    status: 'draft',
    workflowId,
    schedule_config: {},
    conditions: resolveTriggerConditions(trigger).map(normalizeToWriteFormat),
    type: trigger.type,
    masterType: trigger.masterType || 'highlevel',
    name: trigger.name || trigger.type,
    actions: [{ workflow_id: workflowId, type: 'add_to_workflow' }],
    active: true,
    triggersChanged: true,
    location_id: locationId,
    company_id: ctx.company_id,
    company_age: ctx.company_age,
  };
}

/**
 * Build the Step 3 save payload for updating a workflow with actions and triggers.
 * Uses camelCase companyId and companyAge per MCP-SPEC.md (different from Steps 1-2).
 *
 * @param {string} workflowId - Workflow ID
 * @param {string} name - Workflow name
 * @param {string} status - Workflow status (draft, published)
 * @param {object[]} templates - Action templates
 * @param {string[]} createdSteps - IDs of newly created steps
 * @param {string[]} modifiedSteps - IDs of modified steps
 * @param {string[]} deletedSteps - IDs of deleted steps
 * @param {object[]} triggers - Trigger definitions
 * @param {object} ctx - Write context
 * @param {boolean} [triggersChanged] - Explicit flag; defaults to triggers.length > 0 to preserve createWorkflow behavior
 * @param {number} [version] - Workflow version (default 1)
 * @param {string|null} [parentId] - Folder ID; null = root. Defaults to null to preserve createWorkflow behavior.
 * @param {object} [settings] - Workflow-level settings (stopOnResponse, allowMultiple, allowMultipleOpportunity, removeContactFromLastStep, autoMarkAsRead, timezone). Each field falls back to its hardcoded default when omitted. (VRX)
 * @returns {object} Save payload
 */
export function buildSavePayload(workflowId, name, status, templates, createdSteps, modifiedSteps, deletedSteps, triggers, ctx, triggersChanged = triggers.length > 0, version = 1, parentId = null, settings = {}) {
  return {
    _id: workflowId,
    locationId: ctx.locationId,
    companyId: ctx.companyId,
    companyAge: ctx.companyAge,
    name,
    status,
    version,
    dataVersion: 7,
    allowMultiple: settings.allowMultiple ?? true,
    timezone: settings.timezone ?? 'account',
    removeContactFromLastStep: settings.removeContactFromLastStep ?? true,
    stopOnResponse: settings.stopOnResponse ?? false,
    autoMarkAsRead: settings.autoMarkAsRead ?? false,
    permission: 380,
    type: 'workflow',
    parentId,
    updatedBy: ctx.userId,
    deleted: false,
    allowMultipleOpportunity: settings.allowMultipleOpportunity ?? true,
    creationSource: 'builder',
    workflowData: { templates },
    modifiedSteps: modifiedSteps || [],
    deletedSteps: deletedSteps || [],
    createdSteps,
    senderAddress: {},
    eventStartDate: '',
    triggersChanged,
    newTriggers: triggers.map((t) => ({
      status: 'draft',
      workflowId,
      conditions: resolveTriggerConditions(t),
      type: t.type,
      masterType: t.masterType || 'highlevel',
      name: t.name || t.type,
      actions: [{ workflow_id: workflowId, type: 'add_to_workflow' }],
      active: true,
      id: t.id,
      location_id: ctx.locationId,
    })),
  };
}
