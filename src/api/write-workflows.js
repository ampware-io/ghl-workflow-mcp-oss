/**
 * Workflow write operations for GHL's internal API.
 *
 * Provides createWorkflow which orchestrates GHL's 3-step workflow
 * creation flow (POST shell, POST triggers, PUT save with actions).
 */

import { logger } from '../utils/logger.js';
import { getWorkflow, listWorkflows } from './workflows.js';
import {
  buildActionChain,
  diffAndWireActions,
  buildShellPayload,
  buildTriggerPayload,
  buildSavePayload,
  diffTriggers,
} from '../utils/action-chain.js';
import { extractTags } from '../utils/tag-scanner.js';
import { extractEntityRefs } from '../utils/entity-scanner.js';
import { listTags, createTag, listPipelines, listUsers, listCustomFields, listCustomValues, listCalendars, listForms, listTriggerLinks, listEmailTemplates } from './entities.js';
import { createTrigger, updateTrigger, deleteTrigger } from './triggers.js';

/**
 * Resolve tag dependencies by scanning workflow actions/triggers for tag
 * references, comparing against existing tags (case-insensitive), and
 * auto-creating any missing ones.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {Array} params.actions - Action templates to scan
 * @param {Array} params.triggers - Trigger definitions to scan
 * @returns {Promise<{ autoCreatedTags: string[] }>}
 */
async function resolveTagDependencies(apiClient, { actions, triggers }) {
  const scanTarget = {
    templates: actions || [],
    triggers: triggers || [],
  };
  const referencedTags = extractTags(scanTarget);

  if (referencedTags.length === 0) return { autoCreatedTags: [] };

  const { tags: existingTags } = await listTags(apiClient);
  const existingNames = new Set(existingTags.map(t => t.name.toLowerCase()));
  const missingTags = referencedTags.filter(t => !existingNames.has(t.toLowerCase()));

  const created = [];
  for (const tagName of missingTags) {
    await createTag(apiClient, { tagName });
    created.push(tagName);
  }

  if (created.length > 0) {
    logger.info('Auto-created tags:', created.join(', '));
  }

  return { autoCreatedTags: created };
}

/**
 * Simple closest-match helper for suggesting fix alternatives.
 * Uses lowercase substring matching — no external dependency needed.
 *
 * @param {string} targetId - The invalid ID to match against
 * @param {Array<{id: string, name: string}>} alternatives - Valid alternatives
 * @returns {{id: string, name: string}|null} Best match or first alternative
 */
function findClosestMatch(targetId, alternatives) {
  if (alternatives.length === 0) return null;
  const lower = targetId.toLowerCase();
  const partial = alternatives.find(a =>
    a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase())
  );
  return partial || alternatives[0];
}

/**
 * Validate entity references in workflow actions/triggers against location data.
 * Non-blocking: returns warnings but never prevents workflow saves.
 *
 * Only fetches entity types that are actually referenced (short-circuit per type).
 * Pipeline stage validation checks stage belongs to the referenced pipeline (Pitfall 2).
 * Custom field validation checks both id and fieldKey (Pitfall 1).
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {Array} params.actions - Action templates to scan
 * @param {Array} params.triggers - Trigger definitions to scan
 * @returns {Promise<{ entityWarnings: Array }>}
 */
async function resolveEntityDependencies(apiClient, { actions, triggers }) {
  const scanTarget = { templates: actions || [], triggers: triggers || [] };
  const refs = extractEntityRefs(scanTarget);
  if (refs.length === 0) return { entityWarnings: [] };

  // Only fetch entity types that are actually referenced (Pitfall 3: minimize API calls)
  const hasPipeline = refs.some(r => r.entityType === 'pipeline' || r.entityType === 'pipelineStage');
  const hasUser = refs.some(r => r.entityType === 'user');
  const hasCustomField = refs.some(r => r.entityType === 'customField');
  const hasCustomValue = refs.some(r => r.entityType === 'customValue');
  const hasTag = refs.some(r => r.entityType === 'tag');
  const hasWorkflow = refs.some(r => r.entityType === 'workflow');
  const hasCalendar = refs.some(r => r.entityType === 'calendar');
  const hasForm = refs.some(r => r.entityType === 'form');
  const hasTriggerLink = refs.some(r => r.entityType === 'triggerLink');
  const hasEmailTemplate = refs.some(r => r.entityType === 'emailTemplate');

  const [pipelinesResult, usersResult, contactFieldsResult, oppFieldsResult, customValuesResult, tagsResult, workflowsResult, calendarsResult, formsResult, linksResult, emailTemplatesResult] = await Promise.all([
    hasPipeline ? listPipelines(apiClient) : { pipelines: [] },
    hasUser ? listUsers(apiClient) : { users: [] },
    hasCustomField ? listCustomFields(apiClient, { model: 'contact' }) : { customFields: [] },
    hasCustomField ? listCustomFields(apiClient, { model: 'opportunity' }) : { customFields: [] },
    hasCustomValue ? listCustomValues(apiClient) : { customValues: [] },
    hasTag ? listTags(apiClient) : { tags: [] },
    hasWorkflow ? listWorkflows(apiClient) : { workflows: [] },
    hasCalendar ? listCalendars(apiClient) : { calendars: [] },
    hasForm ? listForms(apiClient) : { forms: [] },
    hasTriggerLink ? listTriggerLinks(apiClient) : { links: [] },
    hasEmailTemplate ? listEmailTemplates(apiClient) : { emailTemplates: [] },
  ]);

  const pipelines = pipelinesResult.pipelines || [];
  const users = usersResult.users || [];
  const allCustomFields = [
    ...(contactFieldsResult.customFields || []),
    ...(oppFieldsResult.customFields || []),
  ];
  const customValues = customValuesResult.customValues || [];
  const tags = tagsResult.tags || [];
  const workflows = workflowsResult.workflows || [];
  const calendars = calendarsResult.calendars || [];
  const forms = formsResult.forms || [];
  const triggerLinks = linksResult.links || [];
  const emailTemplates = emailTemplatesResult.emailTemplates || [];

  // Build lookup sets
  const pipelineIds = new Set(pipelines.map(p => p.id));
  const userIds = new Set(users.map(u => u.id));
  const customFieldIds = new Set(allCustomFields.map(f => f.id));
  const customFieldKeys = new Set(allCustomFields.map(f => f.fieldKey).filter(Boolean));
  const customValueIds = new Set(customValues.map(v => v.id || v.meta?.id).filter(Boolean));
  // Key-name lookup: extract key from value template "{{ custom_values.key_name }}"
  const customValueKeys = new Set();
  for (const cv of customValues) {
    if (typeof cv.value === 'string') {
      const match = cv.value.match(/\{\{\s*custom_values\.([^}\s]+)\s*\}\}/);
      if (match) customValueKeys.add(match[1]);
    }
  }
  const tagNames = new Set(tags.map(t => t.name));
  const workflowIds = new Set(workflows.map(w => w._id || w.id));
  const calendarIds = new Set(calendars.map(c => c.id));
  const formIds = new Set(forms.map(f => f._id || f.id));
  const triggerLinkIds = new Set(triggerLinks.map(l => l._id || l.id));
  const emailTemplateIds = new Set(emailTemplates.map(e => e._id || e.id));

  // Build stage-to-pipeline map for Pitfall 2 validation
  const stageToPipeline = new Map();
  const allStageIds = new Set();
  for (const pipeline of pipelines) {
    for (const stage of (pipeline.stages || [])) {
      stageToPipeline.set(stage.id, pipeline.id);
      allStageIds.add(stage.id);
    }
  }

  const warnings = [];

  for (const ref of refs) {
    let isValid = false;
    let alternatives = [];
    let message = '';

    switch (ref.entityType) {
      case 'pipeline':
        isValid = pipelineIds.has(ref.id);
        if (!isValid) {
          alternatives = pipelines.slice(0, 10).map(p => ({ id: p.id, name: p.name }));
          message = `Pipeline "${ref.id}" not found in location`;
        }
        break;

      case 'pipelineStage': {
        // Pitfall 2: Check stage belongs to the correct pipeline
        isValid = allStageIds.has(ref.id);
        if (isValid) {
          // If we can find the pipeline ref in the same action, validate stage belongs to it
          const siblingPipelineRef = refs.find(
            r => r.entityType === 'pipeline' && r.source === ref.source
          );
          if (siblingPipelineRef && stageToPipeline.get(ref.id) !== siblingPipelineRef.id) {
            isValid = false;
            message = `Pipeline stage "${ref.id}" exists but belongs to a different pipeline than "${siblingPipelineRef.id}"`;
          }
        }
        if (!isValid) {
          const siblingPipelineRef = refs.find(
            r => r.entityType === 'pipeline' && r.source === ref.source
          );
          const targetPipeline = siblingPipelineRef
            ? pipelines.find(p => p.id === siblingPipelineRef.id)
            : null;
          const stageSource = targetPipeline
            ? (targetPipeline.stages || [])
            : pipelines.flatMap(p => p.stages || []);
          alternatives = stageSource.slice(0, 10).map(s => ({ id: s.id, name: s.name }));
          if (!message) message = `Pipeline stage "${ref.id}" not found in location`;
        }
        break;
      }

      case 'user':
        isValid = userIds.has(ref.id);
        if (!isValid) {
          alternatives = users.slice(0, 10).map(u => ({
            id: u.id,
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id,
          }));
          message = `User "${ref.id}" not found in location`;
        }
        break;

      case 'customField':
        // Pitfall 1: Check both id and fieldKey
        isValid = customFieldIds.has(ref.id) || customFieldKeys.has(ref.id);
        if (!isValid) {
          alternatives = allCustomFields.slice(0, 10).map(f => ({
            id: f.id,
            name: f.name || f.fieldKey || f.id,
          }));
          message = `Custom field "${ref.id}" not found in location`;
        }
        break;

      case 'customValue':
        // Check by ID first, then by key name (from {{custom_values.xxx}} template refs)
        isValid = customValueIds.has(ref.id) || customValueKeys.has(ref.id);
        if (!isValid) {
          alternatives = customValues.slice(0, 10).map(v => ({
            id: v.id || v.meta?.id,
            name: v.label || v.name || v.value || v.id,
          }));
          message = `Custom value "${ref.id}" not found in location`;
        }
        break;

      case 'tag':
        isValid = tagNames.has(ref.id);
        if (!isValid) {
          alternatives = tags.slice(0, 10).map(t => ({ id: t.id || t.name, name: t.name }));
          message = `Tag "${ref.id}" not found in location`;
        }
        break;

      case 'workflow':
        isValid = workflowIds.has(ref.id);
        if (!isValid) {
          alternatives = workflows.slice(0, 10).map(w => ({ id: w._id || w.id, name: w.name }));
          message = `Referenced workflow "${ref.id}" not found in location`;
        }
        break;

      case 'calendar':
        isValid = calendarIds.has(ref.id);
        if (!isValid) {
          alternatives = calendars.slice(0, 10).map(c => ({ id: c.id, name: c.name }));
          message = `Calendar "${ref.id}" not found in location`;
        }
        break;

      case 'form':
        isValid = formIds.has(ref.id);
        if (!isValid) {
          alternatives = forms.slice(0, 10).map(f => ({ id: f._id || f.id, name: f.name }));
          message = `Form "${ref.id}" not found in location`;
        }
        break;

      case 'triggerLink':
        isValid = triggerLinkIds.has(ref.id);
        if (!isValid) {
          alternatives = triggerLinks.slice(0, 10).map(l => ({ id: l._id || l.id, name: l.name }));
          message = `Trigger link "${ref.id}" not found in location`;
        }
        break;

      case 'emailTemplate':
        isValid = emailTemplateIds.has(ref.id);
        if (!isValid) {
          alternatives = emailTemplates.slice(0, 10).map(e => ({ id: e._id || e.id, name: e.name }));
          message = `Email template "${ref.id}" not found in location`;
        }
        break;

      default:
        continue;
    }

    if (!isValid) {
      const suggested = findClosestMatch(ref.id, alternatives);
      warnings.push({
        entityType: ref.entityType,
        referencedId: ref.id,
        location: ref.source,
        message,
        validAlternatives: alternatives,
        suggestedFix: suggested
          ? `Call update_workflow to replace ${ref.entityType === 'pipelineStage' ? 'pipelineStageId' : ref.entityType === 'customField' ? 'field' : ref.entityType + 'Id'} "${ref.id}" with "${suggested.id}" (${suggested.name})`
          : null,
      });
    }
  }

  return { entityWarnings: warnings };
}

/**
 * Create a new workflow via GHL's 3-step API flow.
 * Step 1: POST shell workflow
 * Step 2: POST triggers (if any)
 * Step 3: PUT save with actions and trigger references
 *
 * Per D-01: Single function hides multi-step dance.
 * Per D-02: Minimum input is name only (empty draft).
 * Per D-06: Returns full workflow via getWorkflow on success.
 * Per D-07: Best-effort cleanup on partial failure.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.name - Workflow name (required)
 * @param {Array} [params.triggers=[]] - Trigger definitions
 * @param {Array} [params.actions=[]] - Action definitions (simplified: type, name, attributes)
 * @param {string} [params.status='draft'] - Initial status ('draft' or 'published')
 * @returns {Promise<object>} Full workflow object
 */
export async function createWorkflow(apiClient, params) {
  const {
    name,
    triggers = [],
    actions = [],
    status = 'draft',
  } = params;
  // VRX: forward user-supplied settings to both shell + save payloads; fall back to hardcoded defaults
  const settings = {
    stopOnResponse:            params.stopOnResponse            ?? false,
    allowMultiple:             params.allowMultiple             ?? true,
    allowMultipleOpportunity:  params.allowMultipleOpportunity  ?? true,
    removeContactFromLastStep: params.removeContactFromLastStep ?? true,
    autoMarkAsRead:            params.autoMarkAsRead            ?? false,
    timezone:                  params.timezone                  ?? 'account',
  };
  // Pre-hook: resolve tag dependencies before the burst block (D-04, D-05, D-06)
  let autoCreatedTags = [];
  try {
    const resolved = await resolveTagDependencies(apiClient, { actions, triggers });
    autoCreatedTags = resolved.autoCreatedTags;
  } catch (err) {
    logger.warn('Tag dependency resolution failed, proceeding anyway:', err.message);
  }

  // Pre-hook: validate entity references (D-07, non-blocking per D-04)
  let entityWarnings = [];
  try {
    const entityResult = await resolveEntityDependencies(apiClient, { actions, triggers });
    entityWarnings = entityResult.entityWarnings;
  } catch (err) {
    logger.warn('Entity validation failed, proceeding anyway:', err.message);
  }

  // D-03: Wrap atomic 3-step flow in burst mode to skip inter-step pacing
  const execute = async (client) => {
    const locationId = client.getLocationId();
    const ctx = await client.getWriteContext();
    let shellId = null;

    // #76: snapshot the ids of same-named workflows BEFORE writing anything.
    // A failed call can still leave a workflow in the client's account (GHL
    // stores the shell and then errors, or a retried POST creates a second
    // one), and shellId is never learned in that case. The snapshot is what
    // lets the failure path find exactly what THIS call created — and never
    // touch a workflow the client already had. null = snapshot unavailable.
    const preExistingIds = await snapshotSameNamed(client, name);

    try {
      // Step 1: Create shell
      logger.info('Creating workflow shell:', name);
      const shellPayload = buildShellPayload(name, ctx, settings);
      const shell = await client.post(`/workflow/${locationId}`, shellPayload);
      shellId = shell._id;
      logger.debug('Shell created:', shellId);

      // Step 2: Create triggers (sequential per trigger)
      const createdTriggers = [];
      for (const trigger of triggers) {
        const triggerPayload = buildTriggerPayload(trigger, shellId, locationId, ctx);
        const result = await client.post(`/workflow/${locationId}/trigger`, triggerPayload);
        if (!result.id) {
          throw new Error(`Trigger POST succeeded but returned no id (path: /workflow/${locationId}/trigger). Response: ${JSON.stringify(result).slice(0, 200)}`);
        }
        createdTriggers.push({ ...trigger, id: result.id });
        logger.debug('Trigger created:', result.id);
      }

      // Step 3: Save with actions and trigger references
      const { templates, createdSteps } = buildActionChain(actions);
      const savePayload = buildSavePayload(
        shellId, name, status, templates, createdSteps, [], [], createdTriggers, ctx,
        /* triggersChanged */ undefined,
        /* version */        undefined,
        /* parentId */       null,
        settings,
      );
      await client.put(`/workflow/${locationId}/${shellId}`, savePayload);
      logger.debug('Workflow saved with', templates.length, 'actions');

      // D-06: Return full workflow (includeActionDetails so cache holds the full payload)
      const created = await getWorkflow(client, shellId, { includeActionDetails: true });
      if (preExistingIds && preExistingIds.size > 0) created.__preExistingSameName = [...preExistingIds];
      return created;
    } catch (err) {
      // 404-recovery: GHL sometimes returns 404 even after creating the workflow.
      // Probe listWorkflows by name before running cleanup, since cleanup would
      // delete a workflow that actually succeeded.
      if (err?.status === 404) {
        try {
          const probe = await listWorkflows(client);
          // #76: never adopt a pre-existing same-named workflow as "ours".
          const matches = (probe.workflows || []).filter(
            (w) => w.name === name && !(preExistingIds && preExistingIds.has(w._id)),
          );
          if (matches.length >= 1) {
            const matched = matches.length === 1
              ? matches[0]
              : [...matches].sort((a, b) =>
                  String(b.dateAdded || b.createdAt || '').localeCompare(
                    String(a.dateAdded || a.createdAt || ''),
                  ),
                )[0];
            if (matches.length > 1) {
              logger.warn(
                `createWorkflow 404-recovery: multiple workflows named "${name}" found; selecting most recent (${matched._id})`,
              );
            } else {
              logger.info(
                `createWorkflow received 404 but workflow exists in list — treating as success (id=${matched._id})`,
              );
            }
            return await getWorkflow(client, matched._id, { includeActionDetails: true });
          }
        } catch (probeErr) {
          logger.warn('createWorkflow 404-recovery probe failed:', probeErr.message);
          // fall through and rethrow the original 404 below
        }
      }

      // D-07 + #76: clean up everything this call created — the known shell,
      // plus any same-named workflow that appeared since the snapshot (a shell
      // GHL stored before erroring, or a duplicate from a retried POST).
      const toDelete = new Set(shellId ? [shellId] : []);
      if (preExistingIds) {
        try {
          const after = await listWorkflows(client);
          for (const w of after.workflows || []) {
            if (w.name === name && !preExistingIds.has(w._id)) toDelete.add(w._id);
          }
        } catch (listErr) {
          logger.warn('createWorkflow orphan sweep: list failed:', listErr.message);
          err.message += ` (could not check for orphaned workflows: ${listErr.message})`;
        }
      } else if (!shellId) {
        err.message += ` (could not confirm whether a workflow named "${name}" was created — check list_workflows)`;
      }
      const removed = [];
      const survived = [];
      for (const id of toDelete) {
        try {
          logger.debug('Attempting cleanup of workflow:', id);
          await client.delete(`/workflow/${locationId}/${id}`);
          removed.push(id);
        } catch (cleanupErr) {
          survived.push(id);
          err.message += ` (cleanup also failed for ${id}: ${cleanupErr.message})`;
          logger.warn('Workflow cleanup failed:', id, cleanupErr.message);
        }
      }
      if (removed.length > 0 && removed.some((id) => id !== shellId)) {
        err.message += ` (removed workflow(s) GHL created despite the error: ${removed.join(', ')})`;
      }
      if (survived.length > 0) {
        err.message += ` (ORPHANED workflow(s) left in the account: ${survived.join(', ')} — delete them)`;
      }
      throw err;
    }
  };

  // D-03, D-04: Use burst mode if available (PacedClient), otherwise direct execution
  const result = typeof apiClient.withBurst === 'function'
    ? await apiClient.withBurst(execute)
    : await execute(apiClient);

  // D-05: Include autoCreatedTags in response when tags were created
  if (autoCreatedTags.length > 0) {
    result.autoCreatedTags = autoCreatedTags;
  }

  // Attach entity warnings when validation found issues
  if (entityWarnings.length > 0) {
    result.entityWarnings = entityWarnings;
  }

  // #76: a retry after a failure should not silently produce a second copy.
  // Creation still proceeds (a same name can be intentional), but loudly.
  if (result.__preExistingSameName?.length > 0) {
    result.duplicateNameWarning = {
      message: `A workflow named "${name}" already existed in this location before this call. This created another one — if it was a retry, delete or update the earlier copy instead of keeping both.`,
      existingIds: result.__preExistingSameName,
    };
  }
  delete result.__preExistingSameName;

  return result;
}

/**
 * #76: ids of workflows named `name` that exist right now, or null when the
 * list call fails (in which case the failure path does not sweep — it cannot
 * tell ours from the client's).
 */
async function snapshotSameNamed(client, name) {
  try {
    const { workflows = [] } = await listWorkflows(client);
    return new Set(workflows.filter((w) => w.name === name).map((w) => w._id));
  } catch (err) {
    logger.warn('createWorkflow pre-create snapshot failed; orphan sweep disabled for this call:', err.message);
    return null;
  }
}

/**
 * Update an existing workflow via read-modify-write.
 * Per D-08: AI passes partial changes, tool fetches, merges, PUTs full object.
 * Per D-09: For actions, AI provides full desired list. Tool handles UUID wiring.
 * Per D-10: Tool diffs to compute createdSteps, modifiedSteps, deletedSteps.
 * Per D-11: Returns full workflow via getWorkflow on success.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {string} workflowId
 * @param {object} changes - Partial changes: { name?, status?, actions? }
 * @returns {Promise<object>} Full updated workflow
 */
export async function updateWorkflow(apiClient, workflowId, changes) {
  const locationId = apiClient.getLocationId();
  const ctx = await apiClient.getWriteContext();

  // Fetch current state (need full action attributes for diffing)
  const current = await getWorkflow(apiClient, workflowId, { includeActionDetails: true });

  // Determine final values
  const finalName = changes.name ?? current.name;
  const finalStatus = changes.status ?? current.status;

  let templates, createdSteps, modifiedSteps, deletedSteps;

  if (changes.actions) {
    // D-09, D-10: Diff old vs new actions
    const oldActions = current.workflowData?.templates || [];
    const diff = diffAndWireActions(oldActions, changes.actions);
    templates = diff.templates;
    createdSteps = diff.createdSteps;
    modifiedSteps = diff.modifiedSteps;
    deletedSteps = diff.deletedSteps;
  } else {
    // No action changes — keep existing
    templates = current.workflowData?.templates || [];
    createdSteps = [];
    modifiedSteps = [];
    deletedSteps = [];
  }

  // 260426-lf7: trigger orchestration. When changes.triggers is supplied,
  // diff against current.triggers (already full-shape because we passed
  // includeActionDetails:true above), then run creates/updates/deletes
  // sequentially BEFORE the Step-3 save. Fail-fast — any HTTP error throws
  // a structured Error naming what succeeded vs what failed; the Step-3
  // save is skipped so the saved newTriggers list never desynchronizes
  // from reality. When changes.triggers is omitted, behavior is identical
  // to today: existingTriggers passed through, triggersChanged: false,
  // zero trigger HTTP calls.
  let finalTriggersList;
  let triggersChangedFlag = false;
  if (changes.triggers !== undefined) {
    const diff = diffTriggers(current.triggers || [], changes.triggers);
    const succeededOps = [];
    const succeededOpsLabel = () =>
      succeededOps.length === 0
        ? 'none'
        : succeededOps.map(op => `${op.kind}(${op.id ?? op.name ?? '?'})`).join(', ');

    // Sequential, fail-fast. Order: deletes → updates → creates → save.
    try {
      for (const del of diff.deletes) {
        await deleteTrigger(apiClient, { triggerId: del.id });
        succeededOps.push({ kind: 'delete', id: del.id, name: del.name });
      }
      for (const upd of diff.updates) {
        await updateTrigger(apiClient, { workflowId, triggerId: upd.id, trigger: upd, ctx });
        succeededOps.push({ kind: 'update', id: upd.id, name: upd.name });
      }
    } catch (err) {
      // Mirror createWorkflow's error decoration style — name what succeeded
      // and what failed, plus the underlying error message. Never leak auth
      // headers / JWTs (T-12-04 envelope contract — these locals carry none).
      throw new Error(
        `Trigger update failed during update_workflow ` +
        `(succeeded: ${succeededOpsLabel()}; failed: delete-or-update; underlying: ${err.message})`,
      );
    }
    // Creates happen last so a creation failure leaves prior succeeded ops
    // visible in the error envelope.
    const createdMaterialized = [];
    try {
      for (const cre of diff.creates) {
        const { id: newId } = await createTrigger(apiClient, { workflowId, trigger: cre, ctx });
        const materialized = { ...cre, id: newId };
        succeededOps.push({ kind: 'create', id: newId, name: cre.name });
        createdMaterialized.push(materialized);
      }
    } catch (err) {
      throw new Error(
        `Trigger update failed during update_workflow ` +
        `(succeeded: ${succeededOpsLabel()}; failed: create; underlying: ${err.message})`,
      );
    }

    // finalTriggers = unchanged (kept) + updates (with their existing ids)
    //               + creates (with their freshly returned ids)
    finalTriggersList = [...diff.unchanged, ...diff.updates, ...createdMaterialized];
    triggersChangedFlag = true;
  } else {
    finalTriggersList = current.triggers || [];
    triggersChangedFlag = false;
  }

  // Pre-hook: resolve tag dependencies on the final set of actions and triggers
  const finalActions = templates;
  const finalTriggers = finalTriggersList;

  let autoCreatedTags = [];
  try {
    const resolved = await resolveTagDependencies(apiClient, { actions: finalActions, triggers: finalTriggers });
    autoCreatedTags = resolved.autoCreatedTags;
  } catch (err) {
    logger.warn('Tag dependency resolution failed, proceeding anyway:', err.message);
  }

  // Pre-hook: validate entity references (D-07, non-blocking per D-04)
  let entityWarnings = [];
  try {
    const entityResult = await resolveEntityDependencies(apiClient, { actions: finalActions, triggers: finalTriggers });
    entityWarnings = entityResult.entityWarnings;
  } catch (err) {
    logger.warn('Entity validation failed, proceeding anyway:', err.message);
  }

  const currentVersion = current.version || 1;

  // VRX: preserve workflow-level settings — explicit override > current state > hardcoded default
  const settings = {
    stopOnResponse:            changes.stopOnResponse            ?? current.stopOnResponse            ?? false,
    allowMultiple:             changes.allowMultiple             ?? current.allowMultiple             ?? true,
    allowMultipleOpportunity:  changes.allowMultipleOpportunity  ?? current.allowMultipleOpportunity  ?? true,
    removeContactFromLastStep: changes.removeContactFromLastStep ?? current.removeContactFromLastStep ?? true,
    autoMarkAsRead:            changes.autoMarkAsRead            ?? current.autoMarkAsRead            ?? false,
    timezone:                  changes.timezone                  ?? current.timezone                  ?? 'account',
  };

  const savePayload = buildSavePayload(
    workflowId, finalName, finalStatus,
    templates, createdSteps, modifiedSteps, deletedSteps,
    finalTriggersList, ctx,
    triggersChangedFlag,
    currentVersion,
    current.parentId,  // preserve folder placement (TK7)
    settings,          // preserve workflow-level settings (VRX)
  );

  logger.info('Updating workflow:', workflowId, finalName);
  await apiClient.put(`/workflow/${locationId}/${workflowId}`, savePayload);

  // D-11: Return full updated workflow (includeActionDetails so cache holds the full payload)
  const result = await getWorkflow(apiClient, workflowId, { includeActionDetails: true });

  // D-05: Include autoCreatedTags in response when tags were created
  if (autoCreatedTags.length > 0) {
    result.autoCreatedTags = autoCreatedTags;
  }

  // Attach entity warnings when validation found issues
  if (entityWarnings.length > 0) {
    result.entityWarnings = entityWarnings;
  }

  return result;
}

/**
 * Delete a workflow.
 * Per D-12: No confirmation — just delete.
 * Per D-13: Delete workflow only, don't manually clean triggers.
 * Per D-14: Fetch name before deleting for confirmation response.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {string} workflowId
 * @returns {Promise<{ status: string, workflowId: string, name: string }>}
 */
export async function deleteWorkflow(apiClient, workflowId) {
  const locationId = apiClient.getLocationId();

  // D-14: Fetch name before deleting
  logger.info('Fetching workflow before delete:', workflowId);
  const workflow = await getWorkflow(apiClient, workflowId);
  const name = workflow.name;

  // D-12: Just delete, no confirmation
  logger.info('Deleting workflow:', workflowId, name);
  try {
    await apiClient.delete(`/workflow/${locationId}/${workflowId}`);
  } catch (err) {
    // 5xx-recovery: GHL sometimes returns 502 even after the delete succeeded
    // server-side. Probe getWorkflow — a 404 confirms deletion (return success).
    // Probe returning the workflow confirms the failure is real (rethrow original).
    // Probe failures (non-404) rethrow the original error and warn.
    if (err?.status >= 500 && err?.status < 600) {
      let probeOutcome; // 'deleted' | 'still-exists' | 'probe-failed'
      try {
        await getWorkflow(apiClient, workflowId);
        probeOutcome = 'still-exists';
      } catch (probeErr) {
        if (probeErr?.status === 404) {
          probeOutcome = 'deleted';
        } else {
          probeOutcome = 'probe-failed';
          logger.warn(
            `deleteWorkflow 5xx-recovery probe failed: ${probeErr?.message ?? probeErr}`,
          );
        }
      }
      if (probeOutcome === 'deleted') {
        logger.info(
          `deleteWorkflow received 5xx but workflow no longer exists — treating as success (id=${workflowId})`,
        );
        return { status: 'deleted', workflowId, name };
      }
      if (probeOutcome === 'still-exists') {
        logger.info(
          `deleteWorkflow 5xx-recovery probe found workflow still present — original error is real (id=${workflowId})`,
        );
      }
    }
    throw err;
  }

  return { status: 'deleted', workflowId, name };
}

/**
 * Publish a workflow (change status from draft to published).
 * Per D-15: Standalone tool. Returns full workflow after publishing.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {string} workflowId
 * @returns {Promise<object>} Full workflow object after publishing
 */
export async function publishWorkflow(apiClient, workflowId) {
  // Reuse updateWorkflow with status change only
  return await updateWorkflow(apiClient, workflowId, { status: 'published' });
}

/**
 * Clone a workflow using GHL's native duplicate endpoint.
 * Per D-01: POST /workflow/{locationId} with workflow_id + new_workflow_name.
 * Per D-04: Fetch source workflow to build default name.
 * Per D-06: Return full cloned workflow via getWorkflow.
 * Per D-07: Trust GHL's duplicate — no post-clone verification.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {string} workflowId - Source workflow ID to clone
 * @param {object} [options]
 * @param {string} [options.name] - Custom name for clone (default: "Copy - {source name}")
 * @returns {Promise<object>} Full cloned workflow object
 */
export async function cloneWorkflow(apiClient, workflowId, { name } = {}) {
  const locationId = apiClient.getLocationId();
  const ctx = await apiClient.getWriteContext();

  // D-04: Fetch source workflow for naming (also validates source exists per D-09)
  const source = await getWorkflow(apiClient, workflowId);

  // D-03: Default name is "Copy - {original name}", custom name overrides
  const cloneName = name || `Copy - ${source.name}`;

  // D-01: Use GHL's native duplicate endpoint
  logger.info('Cloning workflow:', workflowId, '->', cloneName);
  const result = await apiClient.post(`/workflow/${locationId}`, {
    new_workflow_name: cloneName,
    workflow_id: workflowId,
    parentId: source.parentId ?? null, // inherit source's folder; null = root (TK7)
    company_id: ctx.company_id,
    company_age: ctx.company_age,
  });

  const cloneId = result.id;
  logger.debug('Clone created:', cloneId);

  // D-06: Return full cloned workflow (includeActionDetails so cache holds the full payload)
  return await getWorkflow(apiClient, cloneId, { includeActionDetails: true });
}
