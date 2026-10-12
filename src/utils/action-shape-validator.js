/**
 * Per-action shape validator (Phase 18 SPEC #2).
 *
 * Pure, stateless, side-effect-free. Single-pass three-tier classification
 * (D-02): HARD (unknown-type → drop), SOFT (known captured type, malformed
 * shape → keep step but replace attributes with registry defaultAttributes),
 * WARN (known type, shapeStatus !== 'captured' → pass through with advisory).
 *
 * Hand-rolled key-presence check (D-11) — no Zod-per-type authoring burden.
 *
 * Security (T-17-02-01 inherited from Phase 17): violation/warning records
 * NEVER include action.attributes content. Only class + kind + name + type +
 * reason are exposed.
 *
 * Composes with Phase 17 — runs BEFORE buildActionChain/diffAndWireActions/
 * validateWiring (D-03). Phase 17's src/utils/action-chain.js is unmodified.
 */

/**
 * Read→write type aliases (round-trip fix).
 *
 * GHL persists some action types under different names than the
 * `available-actions` palette the registry (action-shapes.json) was captured
 * from. `getWorkflow` returns the persisted (un-suffixed) names verbatim, so a
 * read→write round-trip would HARD-drop these as unknown-type unless aliased.
 *
 * The alias only selects which registry ENTRY (shape) to validate against —
 * the action's own `type` is preserved unchanged on the emitted item so it
 * round-trips back to GHL exactly as stored (the write path does no type
 * translation). Keys = persisted names; values = canonical registry keys.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ACTION_TYPE_ALIASES = Object.freeze({
  // Read→write round-trip fixes (persisted names → registry keys)
  add_contact_tag: 'add_contact_tag_tool',
  remove_contact_tag: 'remove_contact_tag_tool',
  create_opportunity: 'internal_create_opportunity',

  // regression: human/verb-form names agents naturally emit when hand-authoring
  // create_workflow actions. Each value below is a real key in action-shapes.json.
  // The alias only selects the shape entry — item.type is preserved on emit.
  send_email: 'email',
  send_sms: 'sms',
  send_internal_notification: 'internal_notification',
  send_notification: 'internal_notification',
  notification: 'internal_notification',
  add_note: 'add_notes',
  add_contact_note: 'add_notes',
  note: 'add_notes',
  assign_user: 'assign_to_user_tool',
  assign_to_user: 'assign_to_user_tool',
});

/**
 * Per-type DEEP shape checks.
 *
 * The shallow matchesShape() only asserts top-level key presence + jsType. For
 * a handful of high-traffic action types that pass the shallow check yet render
 * as broken/non-functional nodes in GHL, we add a stricter predicate. A failure
 * here is a HARD REJECT (class 'malformed-shape-rejected') — the step is DROPPED,
 * NOT stripped-to-defaults. Keys are CANONICAL registry keys (post-alias), so an
 * aliased persisted type resolves to its canonical deep check. Scoped to exactly
 * these 4 types — every other captured type keeps the existing SOFT behaviour.
 *
 * Each predicate receives the attributes object (never the raw item) and returns
 * true when the shape is functional. Predicates must be pure and must never be
 * used to echo attribute content into skip records (T-79-01 / T-17-02-01).
 *
 * @type {Readonly<Record<string, (attributes: object) => boolean>>}
 */
const OPPORTUNITY_STATUSES = new Set(['open', 'won', 'lost', 'abandoned']);

export const DEEP_CHECKS = Object.freeze({
  // sms renders broken without a body.
  sms: (a) => typeof a?.message === 'string' && a.message.trim() !== '',
  // email XOR body: inline (html) OR template (template_id) — reject neither.
  // Do NOT require both, and do NOT require html (would regress templated emails).
  email: (a) =>
    (typeof a?.html === 'string' && a.html.trim() !== '') ||
    (typeof a?.template_id === 'string' && a.template_id.trim() !== ''),
  // fields[] must be a non-empty array of {field:<non-empty string>, ...} objects.
  // Emptiness rule isolated in its own clause so it is easy to relax later.
  update_contact_field: (a) => {
    if (!Array.isArray(a?.fields)) return false;
    if (a.fields.length === 0) return false; // no-op placeholder renders broken
    return a.fields.every(
      (f) => f !== null && typeof f === 'object' && typeof f.field === 'string' && f.field.trim() !== '',
    );
  },
  // Pipeline ids must be present + status must be a real GHL opportunity status.
  // (title presence already covered by matchesShape's requiredAttributes.)
  internal_create_opportunity: (a) =>
    typeof a?.pipelineId === 'string' && a.pipelineId.trim() !== '' &&
    typeof a?.pipelineStageId === 'string' && a.pipelineStageId.trim() !== '' &&
    typeof a?.status === 'string' && OPPORTUNITY_STATUSES.has(a.status),
});

/**
 * Validate per-action and per-trigger shapes against a registry.
 *
 * @param {Array<object>} actions - Caller-supplied actions array (may be empty)
 * @param {Array<object>} triggers - Caller-supplied triggers array (may be empty)
 * @param {object} registry - Loaded from src/registry/action-shapes.json
 * @returns {{ sanitized: { actions: Array<object>, triggers: Array<object> }, skippedActions: Array<object>, warnings: Array<object> }}
 */
export function validateActionShapes(actions, triggers, registry) {
  const sanitizedActions = [];
  const sanitizedTriggers = [];
  const skippedActions = [];
  const warnings = [];

  for (const item of actions ?? []) {
    classify(item, 'action', registry.actions, sanitizedActions, skippedActions, warnings);
  }
  for (const item of triggers ?? []) {
    classify(item, 'trigger', registry.triggers, sanitizedTriggers, skippedActions, warnings);
  }

  return {
    sanitized: { actions: sanitizedActions, triggers: sanitizedTriggers },
    skippedActions,
    warnings,
  };
}

/**
 * Single-pass classifier. Mutates the four output arrays in place.
 * Item kept | dropped per the three-tier logic (D-02).
 */
function classify(item, kind, entryMap, sanitizedOut, skippedOut, warningsOut) {
  const type = item?.type;
  const name = item?.name ?? '(unnamed)';
  // Resolve via the registry directly, falling back to a read→write alias so
  // GHL's persisted type names (e.g. add_contact_tag) validate against their
  // canonical registry shape (add_contact_tag_tool). item.type is left intact.
  // Canonical registry key: `type` when the direct lookup hits, else the alias
  // target. DEEP_CHECKS is keyed on this canonical key (never on item.type).
  const canonicalKey = type
    ? (entryMap[type] ? type : (entryMap[ACTION_TYPE_ALIASES[type]] ? ACTION_TYPE_ALIASES[type] : undefined))
    : undefined;
  const entry = canonicalKey ? entryMap[canonicalKey] : undefined;

  if (!entry) {
    // HARD: unknown type → drop
    skippedOut.push({
      class: 'unknown-type',
      kind,
      name,
      type: type ?? '(missing)',
      reason: `Type "${type ?? '(missing)'}" not in registry`,
    });
    return;
  }

  // SPEC #8 SPECIAL CASE — scaffold-less wrong-shape if_else.
  // If a caller submits an if_else with attributes.conditions (the EOI failure
  // pattern) but neither the then/else scaffold nor the verbose condition-node
  // wire form, HARD-reject BEFORE SOFT salvage strips attributes.conditions.
  // The agent gets a signal pointing at the then/else scaffold contract.
  // (Plan 03 expander has a defense-in-depth check; this validator catch fires
  // first because runs before expandIfElse.)
  if (kind === 'action' && type === 'if_else' && isScaffoldlessWrongShapeIfElse(item)) {
    skippedOut.push({
      class: 'malformed-if-else',
      kind,
      name,
      type,
      reason:
        'if_else uses attributes.conditions without then/else scaffold or condition-node verbose form. Use the then/else scaffold (see the GHL Workflow Docs MCP for the if_else reference).',
    });
    return;
  }

  if (entry.shapeStatus !== 'captured') {
    // WARN: registry uncertain → pass through, advisory only
    warningsOut.push({
      class: 'unverified-shape',
      kind,
      name,
      type,
    });
    sanitizedOut.push(item);
    return;
  }

  // Scaffold if_else bypasses shape check — the scaffold form uses then/else
  // arrays (not attributes.branches), and the expander converts to the wire
  // format downstream. SOFT-salvaging here would wipe attributes.conditions
  // before the expander can use them.
  if (kind === 'action' && type === 'if_else' && (Array.isArray(item.then) || Array.isArray(item.else))) {
    sanitizedOut.push(item);
    return;
  }

  // Branch sibling nodes (branch-yes / branch-no) share type 'if_else' but
  // have structurally different attributes ({} or {else:true}) — they don't
  // carry attributes.branches. Applying the condition-node shape check would
  // SOFT-strip their attributes on every write.
  if (kind === 'action' && type === 'if_else' && (item.nodeType === 'branch-yes' || item.nodeType === 'branch-no')) {
    sanitizedOut.push(item);
    return;
  }

  // Deep-check tier: for the scoped 4 canonical types, a shape
  // failure — whether the shallow matchesShape fails OR the deep predicate fails
  // — is a HARD REJECT. Drop the step; do NOT substitute defaults. Never echo
  // attributes content into the skip record (T-79-01 / T-17-02-01).
  const deepCheck = kind === 'action' ? DEEP_CHECKS[canonicalKey] : undefined;
  if (deepCheck) {
    const attrs = item?.attributes;
    const okAttrs = attrs !== null && typeof attrs === 'object';
    if (!matchesShape(item, entry, kind) || !okAttrs || !deepCheck(attrs)) {
      skippedOut.push({
        class: 'malformed-shape-rejected',
        kind,
        name,
        type,
        reason: `attributes do not match canonical ${canonicalKey} shape; see src/registry/action-shapes.json and the GHL Workflow Docs MCP`,
        expectedShape: canonicalKey,
      });
      return;
    }
    sanitizedOut.push(item);
    return;
  }

  if (!matchesShape(item, entry, kind)) {
    // SOFT: captured but malformed → keep, replace with registry defaults.
    // Actions store data in .attributes; triggers store data at the top level.
    const defaults = { ...(entry.defaultAttributes ?? {}) };
    if (kind === 'trigger') {
      sanitizedOut.push({ ...item, ...defaults });
    } else {
      sanitizedOut.push({ ...item, attributes: defaults });
    }
    skippedOut.push({
      class: 'malformed-shape-stripped',
      kind,
      name,
      type,
      reason: 'attributes did not satisfy requiredAttributes; replaced with defaultAttributes',
    });
    return;
  }

  // PASS: shape matches; emit unchanged
  sanitizedOut.push(item);
}

/**
 * SPEC #8 — detect the EOI canonical failure shape: if_else with
 * attributes.conditions but no scaffold (then/else) and no verbose
 * wire form (nodeType: condition-node | branch-yes | branch-no), and
 * no attributes.branches[]. Returning true means HARD-reject the item
 * with class 'malformed-if-else'. Caller already verified type==='if_else'.
 *
 * Recognized non-scaffold-less shapes (return false → continue normal flow):
 *   - then[] or else[] supplied (scaffold form — expander handles)
 *   - nodeType is 'condition-node' / 'branch-yes' / 'branch-no' (verbose form)
 *   - attributes.branches is an array (already in captured shape)
 *
 * @param {object} item
 * @returns {boolean}
 */
function isScaffoldlessWrongShapeIfElse(item) {
  if (Array.isArray(item.then) || Array.isArray(item.else)) return false;
  const nt = item.nodeType;
  if (nt === 'condition-node' || nt === 'branch-yes' || nt === 'branch-no') return false;
  const attrs = item.attributes;
  if (attrs && typeof attrs === 'object' && Array.isArray(attrs.branches)) return false;
  if (attrs && typeof attrs === 'object' && attrs.conditions !== undefined) return true;
  return false;
}

/**
 * Hand-rolled key-presence + jsType check (D-11). No schema engine.
 *
 * Actions carry data in item.attributes; triggers carry data at the top level
 * (conditions, masterType live directly on the trigger object). The `kind`
 * parameter selects which container to inspect.
 *
 * @param {object} item - Action or trigger object
 * @param {object} entry - Registry entry with requiredAttributes array
 * @param {'action'|'trigger'} kind - Whether this is an action or trigger
 * @returns {boolean}
 */
function matchesShape(item, entry, kind) {
  const container = kind === 'trigger' ? item : item?.attributes;
  if (container === undefined || container === null || typeof container !== 'object') return false;
  for (const { key, jsType } of entry.requiredAttributes) {
    const v = container[key];
    if (v === undefined) return false;
    if (jsType === 'array') {
      if (!Array.isArray(v)) return false;
    } else if (typeof v !== jsType) {
      return false;
    }
  }
  return true;
}
