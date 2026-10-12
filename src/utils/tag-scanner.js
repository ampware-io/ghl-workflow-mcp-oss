/**
 * Pure utility for extracting tag references from GHL workflow JSON.
 *
 * Scans three JSON paths for tag names:
 * 1. Tag actions (add_contact_tag_tool, remove_contact_tag_tool) — attributes.tags[]
 * 2. If/else conditions where field === 'contact.tags' — recursively nested
 * 3. Trigger conditions where field === 'contact.tags'
 *
 * All functions are stateless and side-effect free.
 */

import { ACTION_TYPE_ALIASES } from './action-shape-validator.js';

/**
 * Canonical (registry) tag action types.
 * @type {string[]}
 */
const CANONICAL_TAG_TYPES = ['add_contact_tag_tool', 'remove_contact_tag_tool'];

/**
 * Action types that reference tags in their attributes.tags array.
 *
 * Includes both the canonical registry names and GHL's persisted (un-suffixed)
 * aliases — derived from ACTION_TYPE_ALIASES so this stays in sync without
 * leaking any future non-tag aliases into the set.
 * @type {Set<string>}
 */
const TAG_ACTION_TYPES = new Set([
  ...CANONICAL_TAG_TYPES,
  ...Object.entries(ACTION_TYPE_ALIASES)
    .filter(([, canonical]) => CANONICAL_TAG_TYPES.includes(canonical))
    .map(([alias]) => alias),
]);

/**
 * Condition `field` values that reference contact tags.
 *
 * - `contact.tags`: if/else conditions + the UI-builder/palette tag-trigger form
 *   (operator `is-any-of`, array value).
 * - `tagsAdded`: the persisted `contact_tag` trigger's Tag-Added condition
 *   (operator `index-of-true`, plain-string value) — captured from a real
 *   workflow.
 * - `tagsRemoved`: the Tag-Removed counterpart. Inferred-symmetric from the
 *   captured `tagsAdded` shape; not yet captured from a live remove trigger.
 *   Read-only extraction, so an over- or under-match here is non-fatal.
 * @type {Set<string>}
 */
const TAG_CONDITION_FIELDS = new Set(['contact.tags', 'tagsAdded', 'tagsRemoved']);

/**
 * Recursively scan a conditions object for tag references.
 * Handles nested AND/OR groups: { operator, conditions: [...] }
 * For leaf conditions whose field references contact tags, extracts value(s).
 *
 * @param {object|null|undefined} conditionsObj - Conditions object or nested group
 * @param {Set<string>} tags - Accumulator set for discovered tag names
 */
function scanConditions(conditionsObj, tags) {
  if (!conditionsObj || typeof conditionsObj !== 'object') {
    return;
  }

  // If this is a group with nested conditions array, recurse into each
  const nested = conditionsObj.conditions;
  if (Array.isArray(nested)) {
    for (const condition of nested) {
      scanConditions(condition, tags);
    }
    return;
  }

  // Leaf condition — check if it references contact tags (contact.tags for
  // if/else + palette triggers; tagsAdded/tagsRemoved for persisted contact_tag)
  if (TAG_CONDITION_FIELDS.has(conditionsObj.field) && conditionsObj.value != null) {
    const val = conditionsObj.value;
    if (typeof val === 'string') {
      tags.add(val);
    } else if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === 'string') {
          tags.add(v);
        }
      }
    }
  }
}

/**
 * Extract all tag names referenced in a workflow's actions, conditions, and triggers.
 *
 * @param {object|null|undefined} workflowData - Workflow data object (may contain templates[] and triggers[])
 * @returns {string[]} Deduplicated array of tag names
 */
export function extractTags(workflowData) {
  if (!workflowData || typeof workflowData !== 'object') {
    return [];
  }

  const tags = new Set();

  // Path 1 & 2: Scan templates (actions)
  const templates = workflowData.templates;
  if (Array.isArray(templates)) {
    for (const action of templates) {
      if (!action || !action.type) continue;

      // Path 1: Tag action types — extract from attributes.tags[]
      if (TAG_ACTION_TYPES.has(action.type)) {
        const actionTags = action.attributes?.tags;
        if (Array.isArray(actionTags)) {
          for (const tag of actionTags) {
            if (typeof tag === 'string') {
              tags.add(tag);
            }
          }
        }
      }

      // Path 2: If/else conditions — recursively scan for contact.tags
      if (action.type === 'if_else' && action.attributes?.conditions) {
        scanConditions(action.attributes.conditions, tags);
      }
    }
  }

  // Path 3: Trigger conditions
  const triggers = workflowData.triggers;
  if (Array.isArray(triggers)) {
    for (const trigger of triggers) {
      if (!trigger) continue;
      const conditions = trigger.conditions;
      if (Array.isArray(conditions)) {
        for (const condition of conditions) {
          scanConditions(condition, tags);
        }
      }
    }
  }

  return [...tags];
}
