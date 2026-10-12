/**
 * Pure utility for extracting entity references from GHL workflow JSON.
 *
 * Scans four JSON paths for entity IDs:
 * 1. Action attributes — direct fields (pipelineId, pipelineStageId, userId, assignedTo)
 * 2. Action attributes — nested arrays (update_contact_field fields[].field)
 * 3. If/else conditions — recursive AND/OR groups referencing entity fields
 * 4. Trigger conditions — entity-referencing fields in trigger filter arrays
 *
 * All functions are stateless and side-effect free.
 */

/**
 * @typedef {Object} EntityRef
 * @property {string} entityType - 'pipeline'|'pipelineStage'|'user'|'customField'|'customValue'
 * @property {string} id - The referenced entity ID
 * @property {string} source - Location: 'action:Action Name' or 'trigger:Trigger Name' or 'condition:if_else'
 * @property {string} [actionType] - Source action type (e.g., 'webhook', 'send_email'). Set ONLY for refs
 *   produced inside the templates (action) loop. Refs from the triggers loop and from action types
 *   lacking action.type are unaffected (no actionType). Used by audit_workflow to detect webhook-context
 *   customValue refs (260425-uzg) so the suggestedFix never offers a destructive credential swap.
 */

/**
 * Maps action types to arrays of field descriptors for direct attribute extraction.
 * Each descriptor identifies the attribute field name and which entity type it references.
 */
const ENTITY_FIELD_MAP = {
  'internal_create_opportunity': [
    { field: 'pipelineId', entityType: 'pipeline' },
    { field: 'pipelineStageId', entityType: 'pipelineStage' },
    { field: 'assignedTo', entityType: 'user' },
  ],
  'create_opportunity': [
    { field: 'pipeline_id', entityType: 'pipeline' },
    { field: 'pipeline_stage_id', entityType: 'pipelineStage' },
    { field: 'assigned_to', entityType: 'user' },
  ],
  'internal_update_opportunity': [
    { field: 'pipelineId', entityType: 'pipeline' },
    { field: 'pipelineStageId', entityType: 'pipelineStage' },
  ],
  'assign_to_user_tool': [
    { field: 'userId', entityType: 'user' },
  ],
  'task-notification': [
    { field: 'assignedTo', entityType: 'user' },
  ],
  'add_to_workflow': [
    { field: 'workflow_id', entityType: 'workflow' },
  ],
  'email': [
    { field: 'template_id', entityType: 'emailTemplate' },
  ],
  'send_email': [
    { field: 'template_id', entityType: 'emailTemplate' },
  ],
};

/**
 * Maps action types with non-flat attribute structures to their nested field config.
 * For update_contact_field: attributes.fields[] is an array; each element's .field
 * property contains the custom field ID.
 */
const NESTED_FIELD_MAP = {
  'update_contact_field': {
    path: 'fields',
    subField: 'field',
    entityType: 'customField',
  },
};

/**
 * Maps action types to flat array fields (arrays of string IDs, not objects).
 * For assign_user: attributes.user_list is ["userId1", "userId2"]
 * For add_contact_tag: attributes.tags is ["tagId1", "tagId2"]
 */
const ARRAY_FIELD_MAP = {
  'assign_user': [
    { path: 'user_list', entityType: 'user' },
  ],
  'add_contact_tag': [
    { path: 'tags', entityType: 'tag' },
  ],
  'wait': [
    { path: 'link', entityType: 'triggerLink' },
  ],
};

/**
 * Standard contact field paths that should NOT be treated as custom field IDs.
 * @type {Set<string>}
 */
const STANDARD_CONTACT_FIELDS = new Set([
  'firstName', 'lastName', 'email', 'phone', 'companyName',
  'address1', 'city', 'state', 'postalCode', 'country',
  'source', 'notes', 'dnd',
]);

/**
 * Condition fields that reference entities by ID.
 * Maps condition field path to entity type.
 */
const ENTITY_CONDITION_FIELDS = {
  'opportunity.pipelineStageId': 'pipelineStage',
  'task.assignedTo': 'user',
  'calendar.id': 'calendar',
  'form.id': 'form',
  'link.id': 'triggerLink',
};

/**
 * Extract entity ref from a direct attribute field.
 * @param {object|null|undefined} attributes - Action attributes object
 * @param {{ field: string, entityType: string }} mapping - Field descriptor
 * @param {string} source - Source identifier for the ref
 * @param {EntityRef[]} refs - Accumulator array
 */
function extractFromAttributes(attributes, mapping, source, refs) {
  if (!attributes) return;
  const value = attributes[mapping.field];
  if (typeof value === 'string' && value.length > 0) {
    refs.push({ entityType: mapping.entityType, id: value, source });
  }
}

/**
 * Extract entity refs from nested array fields (e.g., update_contact_field fields[]).
 * @param {object|null|undefined} attributes - Action attributes object
 * @param {{ path: string, subField: string, entityType: string }} config - Nested field config
 * @param {string} source - Source identifier for the ref
 * @param {EntityRef[]} refs - Accumulator array
 */
function extractNestedFields(attributes, config, source, refs) {
  if (!attributes) return;
  const arr = attributes[config.path];
  if (!Array.isArray(arr)) return;
  for (const element of arr) {
    if (!element) continue;
    const value = element[config.subField];
    if (typeof value === 'string' && value.length > 0 && !STANDARD_CONTACT_FIELDS.has(value)) {
      refs.push({ entityType: config.entityType, id: value, source });
    }
  }
}

/**
 * Extract entity refs from flat array fields (arrays of string IDs).
 * For assign_user: attributes.user_list = ["userId1", "userId2"]
 * For add_contact_tag: attributes.tags = ["tagId1", "tagId2"]
 * @param {object|null|undefined} attributes - Action attributes object
 * @param {{ path: string, entityType: string }} config - Array field config
 * @param {string} source - Source identifier for the ref
 * @param {EntityRef[]} refs - Accumulator array
 */
function extractFromArrayField(attributes, config, source, refs) {
  if (!attributes) return;
  const arr = attributes[config.path];
  if (!Array.isArray(arr)) return;
  for (const value of arr) {
    if (typeof value === 'string' && value.length > 0) {
      refs.push({ entityType: config.entityType, id: value, source });
    }
  }
}

/**
 * Regex to match {{custom_values.key_name}} template references in strings.
 * Captures the key name (e.g., "fathom_api_key" from "{{custom_values.fathom_api_key}}").
 */
const CUSTOM_VALUES_PATTERN = /\{\{custom_values\.([^}]+)\}\}/g;

/**
 * Recursively scan an object's string values for {{custom_values.xxx}} template references.
 * @param {*} obj - Any value to scan (recurses into objects and arrays)
 * @param {string} source - Source identifier for the ref
 * @param {EntityRef[]} refs - Accumulator array
 */
function scanForCustomValueRefs(obj, source, refs) {
  if (typeof obj === 'string') {
    let match;
    CUSTOM_VALUES_PATTERN.lastIndex = 0;
    while ((match = CUSTOM_VALUES_PATTERN.exec(obj)) !== null) {
      refs.push({ entityType: 'customValue', id: match[1], source });
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      scanForCustomValueRefs(item, source, refs);
    }
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      scanForCustomValueRefs(value, source, refs);
    }
  }
}

/**
 * Recursively scan a conditions object for entity-referencing fields.
 * Handles nested AND/OR groups: { operator, conditions: [...] }
 * For leaf conditions whose field is in ENTITY_CONDITION_FIELDS, extracts value(s).
 *
 * @param {object|null|undefined} conditionsObj - Conditions object or nested group
 * @param {EntityRef[]} refs - Accumulator array
 * @param {string} source - Source identifier for the ref
 */
function scanConditionsForEntities(conditionsObj, refs, source) {
  if (!conditionsObj || typeof conditionsObj !== 'object') {
    return;
  }

  // If this is a group with nested conditions array, recurse into each
  const nested = conditionsObj.conditions;
  if (Array.isArray(nested)) {
    for (const condition of nested) {
      scanConditionsForEntities(condition, refs, source);
    }
    return;
  }

  // Leaf condition — check if field references an entity
  const entityType = ENTITY_CONDITION_FIELDS[conditionsObj.field];
  if (entityType && conditionsObj.value != null) {
    const val = conditionsObj.value;
    if (typeof val === 'string' && val !== 'any') {
      refs.push({ entityType, id: val, source });
    } else if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === 'string' && v !== 'any') {
          refs.push({ entityType, id: v, source });
        }
      }
    }
  }

  // conditionSubType: when "tags", extract conditionValue as tag refs;
  // otherwise treat as custom field ID (if not a standard contact field)
  const subType = conditionsObj.conditionSubType;
  if (subType === 'tags') {
    const tagVal = conditionsObj.conditionValue;
    if (typeof tagVal === 'string' && tagVal.length > 0) {
      refs.push({ entityType: 'tag', id: tagVal, source });
    } else if (Array.isArray(tagVal)) {
      for (const t of tagVal) {
        if (typeof t === 'string' && t.length > 0) {
          refs.push({ entityType: 'tag', id: t, source });
        }
      }
    }
  } else if (typeof subType === 'string' && subType.length > 0 && !STANDARD_CONTACT_FIELDS.has(subType)) {
    refs.push({ entityType: 'customField', id: subType, source });
  }
}

/**
 * Extract all entity references from workflow JSON.
 *
 * @param {object|null|undefined} workflowData - Workflow data object (may contain templates[] and triggers[])
 * @returns {EntityRef[]} Array of entity reference objects
 */
export function extractEntityRefs(workflowData) {
  if (!workflowData || typeof workflowData !== 'object') {
    return [];
  }

  const refs = [];

  // Path 1 & 2: Scan templates (actions)
  const templates = workflowData.templates;
  if (Array.isArray(templates)) {
    for (const action of templates) {
      if (!action || !action.type) continue;
      const source = `action:${action.name || action.type}`;
      const actionType = action.type;
      // Snapshot length before this action's helpers run; every ref pushed by any
      // helper below gets tagged with `actionType` so audit_workflow can detect
      // webhook-context refs (260425-uzg).
      const beforeAction = refs.length;

      // Path 1: Direct attribute fields
      const mappings = ENTITY_FIELD_MAP[action.type];
      if (mappings) {
        for (const mapping of mappings) {
          extractFromAttributes(action.attributes, mapping, source, refs);
        }
      }

      // Path 2: Nested array fields (objects with sub-fields)
      const nestedConfig = NESTED_FIELD_MAP[action.type];
      if (nestedConfig) {
        extractNestedFields(action.attributes, nestedConfig, source, refs);
      }

      // Path 2b: Flat array fields (arrays of string IDs)
      const arrayMappings = ARRAY_FIELD_MAP[action.type];
      if (arrayMappings) {
        for (const config of arrayMappings) {
          extractFromArrayField(action.attributes, config, source, refs);
        }
      }

      // Path 3: If/else and wait conditions
      if ((action.type === 'if_else' || action.type === 'wait') && action.attributes?.conditions) {
        scanConditionsForEntities(action.attributes.conditions, refs, `condition:${action.name || action.type}`);
      }

      // Path 5: {{custom_values.xxx}} template references in any attribute string
      if (action.attributes) {
        scanForCustomValueRefs(action.attributes, source, refs);
      }

      // Tag every ref produced by this action with its actionType.
      // Triggers-loop refs are intentionally untagged (see typedef).
      for (let i = beforeAction; i < refs.length; i++) {
        refs[i].actionType = actionType;
      }
    }
  }

  // Path 4: Trigger conditions
  const triggers = workflowData.triggers;
  if (Array.isArray(triggers)) {
    for (const trigger of triggers) {
      if (!trigger) continue;
      const conditions = trigger.conditions;
      if (Array.isArray(conditions)) {
        for (const condition of conditions) {
          scanConditionsForEntities(condition, refs, `trigger:${trigger.name || trigger.type}`);
        }
      }
    }
  }

  return refs;
}
