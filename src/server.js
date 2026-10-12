/**
 * MCP server setup and tool registration for the GHL Workflow MCP (open-source
 * access server).
 *
 * Gives an MCP client read and write access to GoHighLevel workflows through
 * the user's own logged-in Chrome session (CDP + session JWT). Every tool is
 * free; there is no licence gate.
 *
 * Writes are protected by a strict shape validator (src/utils/
 * action-shape-validator.js) backed by the registry at
 * src/registry/action-shapes.json. Full step documentation (field meanings,
 * allowed values, linking rules, worked examples) is published separately as
 * the GHL Workflow Docs MCP.
 *
 * Resources (1): ghl://entities/guide — entity validation guide.
 *
 * Tools that require a GHL connection are gated via requireConnection().
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { TokenManager } from './cdp/token.js';
import { GhlApiClient } from './api/client.js';
import { PacedClient } from './api/paced-client.js';
import { listWorkflows, getWorkflow } from './api/workflows.js';
import { createWorkflow, updateWorkflow, deleteWorkflow, publishWorkflow, cloneWorkflow } from './api/write-workflows.js';
import { createFolder, deleteFolder, renameFolder, moveWorkflow, listFolders } from './api/folders.js';
import { listTags, createTag, listUsers, listPipelines, listCustomFields, listCustomValues, listAssociations, listBusinessFields, listCalendars, listForms, listTriggerLinks, listEmailTemplates } from './api/entities.js';
import { extractEntityRefs } from './utils/entity-scanner.js';
import * as workflowCache from './cache/workflow-cache.js';
import { insertAfter, updateStep, deleteStep, moveStep, rewireStep, addTrigger, updateTriggerOp, removeTrigger, verifyRewires } from './utils/patch-ops.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CURRENT_VERSION } from './version.js';
import { orchestratedCreate, orchestratedUpdate } from './api/write-orchestrator.js';
import { validateActionShapes } from './utils/action-shape-validator.js';

// Action/trigger shape registry. Drives the zod enums on the write tools and
// the strict shape validator. Frozen for the process lifetime.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const registry = JSON.parse(readFileSync(join(__dirname, 'registry', 'action-shapes.json'), 'utf8'));
const KNOWN_ACTION_TYPES = Object.freeze(Object.keys(registry.actions));
const KNOWN_TRIGGER_TYPES = Object.freeze(Object.keys(registry.triggers));

/**
 * Pointer appended to write-tool descriptions and validator errors.
 * The step reference (fields, allowed values, examples) lives in the
 * separate GHL Workflow Docs MCP.
 */
export const DOCS_MCP_HINT = 'For field meanings, allowed values and worked examples for every step type, use the GHL Workflow Docs MCP.';

/**
 * Extract the template key from a GHL custom value's value field.
 * Custom values store their key inside the value template: "{{custom_values.from_company_name}}".
 * @param {object} cv - Custom value object from the GHL API
 * @returns {string|null}
 */
function extractCustomValueKey(cv) {
  if (typeof cv?.value !== 'string') return null;
  const match = cv.value.match(/\{\{\s*custom_values\.([^}\s]+)\s*\}\}/);
  return match ? match[1] : null;
}

/**
 * Audit a workflow's entity references against the location's actual data.
 * Fetches only the entity types that are actually referenced.
 *
 * Lifted from createServer's closure to module scope so unit tests can call it
 * directly with a stubbed apiClient (260425-uzg). The function never references
 * createServer's closure state — it only calls module-imported list* helpers.
 *
 * @param {import('./api/client.js').GhlApiClient} apiClient
 * @param {object} workflow - Full workflow object from getWorkflow
 * @returns {Promise<{valid: object[], invalid: object[], summary: object}>}
 */
export async function auditWorkflowEntities(apiClient, workflow) {
  const workflowData = {
    templates: workflow.workflowData?.templates || workflow.actions || [],
    triggers: workflow.triggers || [],
  };
  const refs = extractEntityRefs(workflowData);
  if (refs.length === 0) {
    return { valid: [], invalid: [], summary: { total: 0, valid: 0, invalid: 0, entityTypes: {} } };
  }

  // Fetch only entity types that are referenced
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
  const allCustomFields = [...(contactFieldsResult.customFields || []), ...(oppFieldsResult.customFields || [])];
  const customValues = customValuesResult.customValues || [];
  const tags = tagsResult.tags || [];
  const workflows = workflowsResult.workflows || [];
  const calendars = calendarsResult.calendars || [];
  const forms = formsResult.forms || [];
  const links = linksResult.links || [];
  const emailTemplates = emailTemplatesResult.emailTemplates || [];

  // Build lookup structures
  const pipelineMap = new Map(pipelines.map(p => [p.id, p]));
  const userMap = new Map(users.map(u => [u.id, u]));
  const customFieldIdSet = new Set(allCustomFields.map(f => f.id));
  const customFieldKeySet = new Set(allCustomFields.map(f => f.fieldKey).filter(Boolean));
  const customFieldMap = new Map(allCustomFields.map(f => [f.id, f]));
  for (const f of allCustomFields) {
    if (f.fieldKey) customFieldMap.set(f.fieldKey, f);
  }
  const customValueIdSet = new Set(customValues.map(v => v.id || v.meta?.id).filter(Boolean));
  // Build key -> customValue map by extracting the key from the cv.value template string.
  // GHL custom values store their key embedded in value: "{{custom_values.from_company_name}}".
  // The API response does NOT expose a standalone fieldKey/key/slug property.
  const customValueKeyMap = new Map();
  for (const cv of customValues) {
    const key = extractCustomValueKey(cv);
    if (key) customValueKeyMap.set(key, cv);
  }
  const tagNameSet = new Set(tags.map(t => t.name));
  const tagMap = new Map(tags.map(t => [t.name, t]));
  const workflowIdSet = new Set(workflows.map(w => w._id || w.id));
  const workflowMap = new Map(workflows.map(w => [w._id || w.id, w]));
  const calendarMap = new Map(calendars.map(c => [c.id, c]));
  const formMap = new Map(forms.map(f => [f._id || f.id, f]));
  const linkMap = new Map(links.map(l => [l._id || l.id, l]));
  const emailTemplateMap = new Map(emailTemplates.map(e => [e._id || e.id, e]));

  const stageToPipeline = new Map();
  const stageMap = new Map();
  for (const pipeline of pipelines) {
    for (const stage of (pipeline.stages || [])) {
      stageToPipeline.set(stage.id, pipeline.id);
      stageMap.set(stage.id, { ...stage, pipelineName: pipeline.name });
    }
  }

  const valid = [];
  const invalid = [];
  const entityTypeCounts = {};

  for (const ref of refs) {
    if (!entityTypeCounts[ref.entityType]) {
      entityTypeCounts[ref.entityType] = { valid: 0, invalid: 0 };
    }

    let isValid = false;
    let name = null;
    let alternatives = [];

    switch (ref.entityType) {
      case 'pipeline': {
        const p = pipelineMap.get(ref.id);
        isValid = !!p;
        name = p?.name;
        if (!isValid) alternatives = pipelines.slice(0, 10).map(pp => ({ id: pp.id, name: pp.name }));
        break;
      }
      case 'pipelineStage': {
        const s = stageMap.get(ref.id);
        isValid = !!s;
        name = s?.name;
        if (isValid) {
          // Check pipeline context — stage must belong to the pipeline referenced in the same action
          const siblingPipelineRef = refs.find(r => r.entityType === 'pipeline' && r.source === ref.source);
          if (siblingPipelineRef && stageToPipeline.get(ref.id) !== siblingPipelineRef.id) {
            isValid = false;
            name = null;
          }
        }
        if (!isValid) {
          const siblingPipelineRef = refs.find(r => r.entityType === 'pipeline' && r.source === ref.source);
          const targetPipeline = siblingPipelineRef ? pipelineMap.get(siblingPipelineRef.id) : null;
          const stageSource = targetPipeline ? (targetPipeline.stages || []) : pipelines.flatMap(p => p.stages || []);
          alternatives = stageSource.slice(0, 10).map(ss => ({ id: ss.id, name: ss.name }));
        }
        break;
      }
      case 'user': {
        const u = userMap.get(ref.id);
        isValid = !!u;
        name = u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : null;
        if (!isValid) alternatives = users.slice(0, 10).map(uu => ({
          id: uu.id,
          name: [uu.firstName, uu.lastName].filter(Boolean).join(' ') || uu.email || uu.id,
        }));
        break;
      }
      case 'customField': {
        const f = customFieldMap.get(ref.id);
        isValid = !!f || customFieldIdSet.has(ref.id) || customFieldKeySet.has(ref.id);
        name = f?.name || (customFieldMap.get(ref.id)?.name);
        if (!isValid) alternatives = allCustomFields.slice(0, 10).map(ff => ({
          id: ff.id,
          name: ff.name || ff.fieldKey || ff.id,
        }));
        break;
      }
      case 'customValue': {
        // Check by ID first, then by key name (from {{custom_values.xxx}} template refs)
        const cvById = customValues.find(v => (v.id || v.meta?.id) === ref.id);
        const cvByKey = customValueKeyMap.get(ref.id);
        isValid = !!cvById || !!cvByKey;
        const cvMatch = cvById || cvByKey;
        name = cvMatch?.label || cvMatch?.name || cvMatch?.value;
        // Alternatives carry `slug` so the suggestedFix branch can emit
        // `{{custom_values.<altSlug>}}` syntax (the SPA-rendered form).
        // Prior shape used only id/name and produced broken replacements (260425-uzg).
        if (!isValid) alternatives = customValues.slice(0, 10).map(vv => ({
          id: vv.id || vv.meta?.id,
          slug: extractCustomValueKey(vv),
          name: vv.label || vv.name || vv.value || vv.id,
        }));
        break;
      }
      case 'tag': {
        const t = tagMap.get(ref.id);
        isValid = !!t;
        name = t?.name;
        if (!isValid) alternatives = tags.slice(0, 10).map(tt => ({ id: tt.id || tt.name, name: tt.name }));
        break;
      }
      case 'workflow': {
        const w = workflowMap.get(ref.id);
        isValid = !!w;
        name = w?.name;
        if (!isValid) alternatives = workflows.slice(0, 10).map(ww => ({ id: ww._id || ww.id, name: ww.name }));
        break;
      }
      case 'calendar': {
        const cal = calendarMap.get(ref.id);
        isValid = !!cal;
        name = cal?.name;
        if (!isValid) alternatives = calendars.slice(0, 10).map(cc => ({ id: cc.id, name: cc.name }));
        break;
      }
      case 'form': {
        const fm = formMap.get(ref.id);
        isValid = !!fm;
        name = fm?.name;
        if (!isValid) alternatives = forms.slice(0, 10).map(ff => ({ id: ff._id || ff.id, name: ff.name }));
        break;
      }
      case 'triggerLink': {
        const lk = linkMap.get(ref.id);
        isValid = !!lk;
        name = lk?.name;
        if (!isValid) alternatives = links.slice(0, 10).map(ll => ({ id: ll._id || ll.id, name: ll.name }));
        break;
      }
      case 'emailTemplate': {
        const et = emailTemplateMap.get(ref.id);
        isValid = !!et;
        name = et?.name;
        if (!isValid) alternatives = emailTemplates.slice(0, 10).map(ee => ({ id: ee._id || ee.id, name: ee.name }));
        break;
      }
      default:
        continue;
    }

    if (isValid) {
      entityTypeCounts[ref.entityType].valid++;
      valid.push({ entityType: ref.entityType, id: ref.id, name, location: ref.source });
    } else {
      entityTypeCounts[ref.entityType].invalid++;
      const suggested = alternatives.length > 0 ? alternatives[0] : null;
      // Branching for suggestedFix (260425-uzg):
      //   - Webhook customValue refs: NEVER auto-suggest a replacement. These are
      //     virtually always credentials/tokens; a destructive swap is unsafe.
      //   - Other customValue refs: emit slug-form `{{custom_values.<altSlug>}}` —
      //     using the entity ID would produce broken template syntax.
      //   - All other entity types: unchanged id-form replacement.
      let suggestedFix;
      if (ref.entityType === 'customValue' && ref.actionType === 'webhook') {
        suggestedFix = 'Webhook attribute — manual review required; do NOT auto-replace credentials/secret slugs';
      } else if (ref.entityType === 'customValue') {
        suggestedFix = suggested?.slug
          ? `Call update_workflow to replace {{custom_values.${ref.id}}} with {{custom_values.${suggested.slug}}} (${suggested.name})`
          : 'No valid alternatives found in location';
      } else {
        suggestedFix = suggested
          ? `Call update_workflow to replace ${ref.id} with "${suggested.id}" (${suggested.name})`
          : 'No valid alternatives found in location';
      }
      invalid.push({
        entityType: ref.entityType,
        id: ref.id,
        location: ref.source,
        validAlternatives: alternatives,
        suggestedFix,
      });
    }
  }

  return {
    valid,
    invalid,
    summary: {
      total: valid.length + invalid.length,
      valid: valid.length,
      invalid: invalid.length,
      entityTypes: entityTypeCounts,
    },
  };
}

/**
 * Create and configure the MCP server with all tool registrations.
 *
 * @param {import('./cdp/connection.js').CdpConnectionManager} cdp - CDP connection manager
 * @param {{ tokenManager: import('./cdp/token.js').TokenManager|null, apiClient: import('./api/client.js').GhlApiClient|null, locationId: string|null }} state - Mutable shared state
 * @param {import('./chrome/launcher.js').ChromeLauncher} launcher - Chrome lifecycle manager
 * @returns {McpServer} Configured MCP server instance
 */
export function createServer(cdp, state, launcher) {
  const server = new McpServer(
    {
      name: 'ghl-workflow-mcp',
      version: CURRENT_VERSION,
    },
    {
      // Returned in the MCP `initialize` response; the client reads it before
      // choosing any tool.
      instructions: [
        'This MCP server gives read + write access to GoHighLevel workflow automation through the user\'s own Chrome session.',
        '',
        'Connection first: if Chrome is not connected, call `launch_chrome` (or `test_connection` if Chrome is already running with the debug port).',
        '',
        'Writes (create_workflow, update_workflow, patch_workflow) are checked by a strict shape validator. Action and trigger types must be from the enums in each tool schema. Malformed steps are dropped and reported in skippedActions[] / warnings[]; when that happens the workflow is saved as a draft.',
        '',
        DOCS_MCP_HINT,
      ].join('\n'),
    },
  );

  /**
   * Check whether the server is connected to GHL.
   * Returns an error response object if not connected, or null if connected.
   */
  function requireConnection() {
    if (!state.apiClient) {
      return {
        content: [{
          type: 'text', text: JSON.stringify({
            status: 'not_connected',
            error: 'Not connected to GoHighLevel. Call launch_chrome first to start Chrome, or test_connection if Chrome is already running.',
          }, null, 2)
        }],
        isError: true,
      };
    }
    return null;
  }

  /**
   * Format an audit report as human-readable markdown.
   *
   * @param {{valid: object[], invalid: object[], summary: object}} report
   * @returns {string} Markdown-formatted report
   */
  function formatAuditReport(report) {
    const lines = ['# Workflow Entity Audit Report', ''];
    lines.push(`**Total references:** ${report.summary.total} | **Valid:** ${report.summary.valid} | **Invalid:** ${report.summary.invalid}`);
    lines.push('');

    if (report.valid.length > 0) {
      lines.push('## Valid References', '');
      lines.push('| Entity Type | ID | Name | Location |');
      lines.push('|-------------|-----|------|----------|');
      for (const v of report.valid) {
        lines.push(`| ${v.entityType} | ${v.id} | ${v.name || '-'} | ${v.location} |`);
      }
      lines.push('');
    }

    if (report.invalid.length > 0) {
      lines.push('## Invalid References', '');
      lines.push('| Entity Type | Referenced ID | Location | Suggested Fix |');
      lines.push('|-------------|---------------|----------|---------------|');
      for (const inv of report.invalid) {
        lines.push(`| ${inv.entityType} | ${inv.id} | ${inv.location} | ${inv.suggestedFix} |`);
      }
      lines.push('');

      lines.push('## Valid Alternatives', '');
      const byType = {};
      for (const inv of report.invalid) {
        if (!byType[inv.entityType] && inv.validAlternatives.length > 0) {
          byType[inv.entityType] = inv.validAlternatives;
        }
      }
      for (const [type, alts] of Object.entries(byType)) {
        lines.push(`### ${type}`, '');
        lines.push('| ID | Name |');
        lines.push('|-----|------|');
        for (const alt of alts) {
          lines.push(`| ${alt.id} | ${alt.name} |`);
        }
        lines.push('');
      }
    }

    if (report.invalid.length === 0) {
      lines.push('All entity references are valid.');
    }

    return lines.join('\n');
  }

  // launch_chrome: Launch a dedicated Chrome window and connect to GHL.
  // Two-phase flow: first call returns instructions and asks for confirmation,
  // second call with confirm=true actually launches Chrome.
  server.registerTool(
    'launch_chrome',
    {
      description: 'Launch a dedicated Chrome window with GoHighLevel. Call this when test_connection fails because Chrome is not running. First call without confirm returns instructions for the user. Call again with confirm=true after the user agrees to proceed.',
      inputSchema: z.object({
        confirm: z.boolean().optional()
          .describe('Set to true to actually launch Chrome. Omit or false to get instructions first.'),
      }),
    },
    async (params) => {
      try {
        // Check if already connected or we own a Chrome process (T-2.1-05: prevent spawning multiple Chrome instances)
        if (cdp.isConnected() || launcher.getChildPid() !== null) {
          return {
            content: [{
              type: 'text', text: JSON.stringify({
                status: 'already_connected',
                message: 'Chrome is already running or connected. Use test_connection to verify, or reconnect to switch locations.',
              }, null, 2)
            }],
          };
        }

        // Phase 1: Return instructions and ask for confirmation
        if (!params.confirm) {
          return {
            content: [{
              type: 'text', text: JSON.stringify({
                status: 'awaiting_confirmation',
                message: 'Ready to launch Chrome. Please confirm to proceed.',
                instructions: [
                  'A Chrome browser window will open to GoHighLevel (app.gohighlevel.com).',
                  'Once Chrome opens, log in to your GoHighLevel account as you normally would.',
                  'After logging in, navigate to the sub-account you want to work with.',
                  'The server will automatically detect when you are logged in and connected to a sub-account (this may take a few moments).',
                ],
                next_step: 'Tell the user what will happen and ask them to confirm. Then call launch_chrome again with confirm=true.',
              }, null, 2)
            }],
          };
        }

        // Phase 2: Actually launch Chrome
        logger.info('Launching Chrome...');
        await launcher.launch();

        // Wait for GHL login (D-04, D-05: 5-minute timeout, polls for /v2/location/ URL)
        logger.info('Chrome launched. Waiting for GHL login...');
        const ghlTab = await launcher.waitForGhlLogin();

        // Connect CDP to the detected GHL tab
        await cdp.connect();

        // Auto-navigate to workflows page so the GHL SPA initialises workflow session state
        const locationId = cdp.getLocationId();
        if (locationId) {
          logger.info('Navigating to workflows page...');
          await cdp.navigate(`https://app.gohighlevel.com/v2/location/${locationId}/automation/workflows?listTab=all`);
        }

        // Initialize state
        const tokenManager = new TokenManager(cdp);
        const finalLocationId = cdp.getLocationId();
        const rawClient = finalLocationId ? new GhlApiClient(tokenManager, finalLocationId) : null;
        const apiClient = rawClient ? new PacedClient(rawClient) : null;

        // Mutate shared state so other tools can use it
        state.tokenManager = tokenManager;
        state.locationId = finalLocationId;
        state.apiClient = apiClient;

        // If the user later switches sub-accounts in the same tab, the CDP
        // listeners installed during connect() detect the URL change and fire
        // this callback. We mirror the new id into shared state, swap it on
        // the apiClient (clears the cached GHL session token so the next
        // entity-endpoint call refetches), and invalidate the Firebase JWT
        // (forces a fresh token-id read from IndexedDB).
        if (apiClient) {
          cdp.onLocationChange((newId) => {
            state.locationId = newId;
            if (state.apiClient) state.apiClient.setLocationId(newId);
            if (state.tokenManager) state.tokenManager.invalidate();
          });
        }

        return {
          content: [{
            type: 'text', text: JSON.stringify({
              status: 'connected',
              message: 'Chrome launched and connected to GoHighLevel. Browser has been navigated to the workflows page.',
              location_id: finalLocationId || 'unknown (navigate to a sub-account)',
              tab: cdp.getTabInfo()?.title || 'GHL tab',
            }, null, 2)
          }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // reconnect: Re-scan Chrome for GHL tabs and switch to a different tab/location.
  server.registerTool(
    'reconnect',
    {
      description: 'Re-scan Chrome for GoHighLevel tabs and switch to a different tab or location. Use this to change locations without restarting the server. If called with no targetId, lists available GHL tabs. If called with a targetId, switches to that tab.',
      inputSchema: z.object({
        targetId: z.string().optional()
          .describe('Tab target ID to connect to (from a previous reconnect call that listed tabs). Omit to list available tabs.'),
      }),
    },
    async (params) => {
      try {
        // reconnect requires Chrome to be reachable (D-10: does NOT launch Chrome)
        const tabs = await cdp.getGhlTabs();

        if (tabs.length === 0) {
          return {
            content: [{
              type: 'text', text: JSON.stringify({
                status: 'no_tabs',
                error: 'No GoHighLevel tabs found in Chrome.',
                suggestion: 'Open GoHighLevel in Chrome (app.gohighlevel.com) and log in, then call reconnect again.',
              }, null, 2)
            }],
            isError: true,
          };
        }

        // If no targetId provided, list available tabs for the user to choose
        if (!params.targetId) {
          const tabList = tabs.map((t) => {
            const locMatch = t.url.match(/\/v2\/location\/([^/]+)/)
              || t.url.match(/\/location\/([^/]+)/);
            return {
              targetId: t.id,
              title: t.title,
              url: t.url,
              locationId: locMatch ? locMatch[1] : null,
            };
          });

          return {
            content: [{
              type: 'text', text: JSON.stringify({
                status: 'tabs_found',
                message: `Found ${tabs.length} GHL tab(s). Call reconnect with a targetId to switch.`,
                tabs: tabList,
              }, null, 2)
            }],
          };
        }

        // Connect to the specified tab
        await cdp.connectToTab(params.targetId);

        // Only navigate to workflows page if the tab isn't already there
        const locationId = cdp.getLocationId();
        const currentTabInfo = cdp.getTabInfo();
        const alreadyOnWorkflows = currentTabInfo?.url?.includes('/automation/workflows');

        if (locationId && !alreadyOnWorkflows) {
          logger.info('Navigating to workflows page...');
          await cdp.navigate(`https://app.gohighlevel.com/v2/location/${locationId}/automation/workflows?listTab=all`);
        } else if (alreadyOnWorkflows) {
          logger.info('Tab already on workflows page, skipping navigation');
        }

        // Re-initialize state with new location
        const tokenManager = new TokenManager(cdp);
        const finalLocationId = cdp.getLocationId();
        const rawClient = finalLocationId ? new GhlApiClient(tokenManager, finalLocationId) : null;
        const apiClient = rawClient ? new PacedClient(rawClient) : null;

        state.tokenManager = tokenManager;
        state.locationId = finalLocationId;
        state.apiClient = apiClient;

        // Re-register the location-change callback (see launch_chrome path).
        if (apiClient) {
          cdp.onLocationChange((newId) => {
            state.locationId = newId;
            if (state.apiClient) state.apiClient.setLocationId(newId);
            if (state.tokenManager) state.tokenManager.invalidate();
          });
        }

        return {
          content: [{
            type: 'text', text: JSON.stringify({
              status: 'reconnected',
              message: alreadyOnWorkflows
                ? 'Reconnected to existing GHL tab (already on workflows page).'
                : 'Switched to new GHL tab. Browser has been navigated to the workflows page.',
              location_id: finalLocationId || 'unknown',
              tab: cdp.getTabInfo()?.title || 'GHL tab',
            }, null, 2)
          }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // test_connection: Verify Chrome is reachable, GHL tab is found, and Firebase token is extractable.
  server.registerTool(
    'test_connection',
    {
      description: 'Verify Chrome is reachable, GHL tab is found, and Firebase token is extractable. Call this first to confirm the MCP server can communicate with GoHighLevel.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        // If not connected, try to connect (user may have started Chrome manually)
        if (!cdp.isConnected()) {
          const probeOk = await launcher.probeDebugPort();
          if (!probeOk) {
            return {
              content: [{
                type: 'text', text: JSON.stringify({
                  status: 'not_connected',
                  error: 'Chrome is not running with a debug port. Call launch_chrome to start Chrome.',
                }, null, 2)
              }],
              isError: true,
            };
          }
          // Chrome is running but we haven't connected yet -- connect now
          await cdp.connect();

          // Only navigate to workflows page if the tab isn't already there
          const locationId = cdp.getLocationId();
          const currentTabInfo = cdp.getTabInfo();
          const alreadyOnWorkflows = currentTabInfo?.url?.includes('/automation/workflows');

          if (locationId && !alreadyOnWorkflows) {
            logger.info('Navigating to workflows page...');
            await cdp.navigate(`https://app.gohighlevel.com/v2/location/${locationId}/automation/workflows?listTab=all`);
          } else if (alreadyOnWorkflows) {
            logger.info('Tab already on workflows page, skipping navigation');
          }

          const tokenManager = new TokenManager(cdp);
          const finalLocationId = cdp.getLocationId();
          const rawClient = finalLocationId ? new GhlApiClient(tokenManager, finalLocationId) : null;
          const apiClient = rawClient ? new PacedClient(rawClient) : null;
          state.tokenManager = tokenManager;
          state.locationId = finalLocationId;
          state.apiClient = apiClient;

          // Re-register the location-change callback (see launch_chrome path).
          if (apiClient) {
            cdp.onLocationChange((newId) => {
              state.locationId = newId;
              if (state.apiClient) state.apiClient.setLocationId(newId);
              if (state.tokenManager) state.tokenManager.invalidate();
            });
          }
        }

        const tabInfo = cdp.getTabInfo();
        if (!tabInfo) {
          throw new Error('Connected to Chrome but no tab info available. Try reconnecting.');
        }
        if (!state.tokenManager) {
          throw new Error('Token manager not initialised. Try calling test_connection again or reconnect.');
        }
        const token = await state.tokenManager.getToken();
        const tokenPreview = '...' + token.slice(-8);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'connected',
              chrome_port: cdp.isConnected() ? 'connected' : 'disconnected',
              chrome_tab_title: tabInfo.title,
              location_id: tabInfo.locationId || 'unknown',
              token_available: true,
              token_preview: tokenPreview,
              _note: 'chrome_tab_title is Chrome\'s display string for the current tab — often the GHL agency name, NOT the sub-account/location name. The authoritative identifier for the active sub-account is location_id. Do not describe chrome_tab_title as the sub-account name to the user; use location_id, or fetch the location name via the GHL API if needed.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const errorResponse = {
          status: 'error',
          error: err.message,
        };
        if (err.suggestion) {
          errorResponse.suggestion = err.suggestion;
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // list_workflows: List all workflows in the current GHL location.
  server.registerTool(
    'list_workflows',
    {
      description: 'List all workflows in the current GoHighLevel location. Returns workflow summaries including name, ID, status, and dates. Auto-fetches all pages by default. Optionally pass limit/offset to get a specific page, or sortBy/sortOrder to control ordering.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: z.number().int().positive().optional()
          .describe('Max workflows to return (overrides auto-fetch-all behavior)'),
        offset: z.number().int().min(0).optional()
          .describe('Number of workflows to skip (use with limit for pagination)'),
        sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional()
          .describe('Field to sort by (default: name)'),
        sortOrder: z.enum(['asc', 'desc']).optional()
          .describe('Sort direction (default: asc)'),
        folderId: z.string().optional()
          .describe('Filter to workflows in a specific folder (folder ID from list_folders). Omit to list all workflows at root level.'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listWorkflows(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // get_workflow: Get detail of a specific workflow including triggers.
  server.registerTool(
    'get_workflow',
    {
      description: 'Get a GoHighLevel workflow\'s structure including actions and triggers. By default returns a summary with action names, types, and ordering (compact). Set includeActionDetails=true for full action attributes (warning: responses can be very large). Call list_workflows first to find workflow IDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1)
          .describe('The workflow ID (UUID format, from list_workflows results)'),
        includeActionDetails: z.boolean().optional()
          .describe('Include full action attributes/configuration (default: false). Warning: can produce very large responses.'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await getWorkflow(state.apiClient, params.workflowId, {
          includeActionDetails: params.includeActionDetails,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // create_workflow: Create a new workflow in the current GHL location.
  server.registerTool(
    'create_workflow',
    {
      description: 'Create a new workflow. Action and trigger types must come from the enums in this schema. Use the then/else scaffold for if_else conditions; the verbose three-sibling form is also accepted. Salvage decisions surface in skippedActions[] (HARD drops) and warnings[] (advisory). When any HARD drop occurs, status is forced to draft. ' + DOCS_MCP_HINT + '',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        name: z.string().min(1)
          .describe('Workflow name (required)'),
        status: z.enum(['draft', 'published']).optional()
          .describe('Initial status (default: draft). Set to "published" to create and publish in one step.'),
        triggers: z.array(z.object({
          type: z.enum(KNOWN_TRIGGER_TYPES).describe('Trigger type — must be one of the registry trigger types.'),
          name: z.string().optional().describe('Human-readable trigger name (defaults to trigger type)'),
          conditions: z.array(z.object({
            field: z.string(),
            operator: z.string(),
            value: z.union([z.string(), z.array(z.string())]),
            title: z.string().optional(),
            type: z.string().optional(),
          })).optional().describe('Trigger filter conditions'),
          masterType: z.string().optional().describe('Master type (default: highlevel)'),
          // regression passthrough: lets caller-supplied fields (notably an
          // `attributes.conditions` alias) survive Zod parse and reach
          // resolveTriggerConditions verbatim. Mirrors update_workflow's trigger
          // schema below. Without it, Zod v3 ZodObject .strip() silently drops
          // `attributes` before any JS runs, dropping the nested conditions.
        }).passthrough()).optional().describe('Triggers to add. Omit for a triggerless workflow.'),
        actions: z.array(z.object({
          type: z.string().min(1).describe('Action type — should be one of the registry action types. Unknown types are dropped with a warning by the shape validator.'),
          name: z.string().describe('Human-readable step name'),
          attributes: z.record(z.unknown()).optional().describe('Action-specific configuration (varies by type)'),
          // Phase 17 D-01 passthrough: lets caller-supplied wiring fields (next, nodeType, parent,
          // parentKey, sibling, cat, comments, etc.) survive Zod parse and reach diffAndWireActions /
          // buildActionChain verbatim. Without .passthrough(), Zod v3 ZodObject default .strip() mode
          // silently drops every key not declared above (RESEARCH Pitfall 5; SDK calls plain
          // safeParseAsync — see node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:174).
        }).passthrough()).optional().describe('Action steps. Omit for an empty workflow. UUIDs and chain wiring are handled automatically.'),
        // VRX: workflow-level settings (flat top-level — destructured by createWorkflow into `params.<setting>`)
        stopOnResponse: z.boolean().optional()
          .describe('When true, pauses workflow execution if a contact responds. Default: false.'),
        allowMultiple: z.boolean().optional()
          .describe('When true, the same contact can be enrolled multiple times concurrently. Default: true.'),
        allowMultipleOpportunity: z.boolean().optional()
          .describe('When true, allows multiple opportunities per contact. Default: true.'),
        removeContactFromLastStep: z.boolean().optional()
          .describe('When true, contacts are removed after completing the final step. Default: true.'),
        autoMarkAsRead: z.boolean().optional()
          .describe('When true, conversation messages are auto-marked as read. Default: false.'),
        timezone: z.string().optional()
          .describe('Workflow timezone — "account" for location default, or IANA zone (e.g. "America/Los_Angeles"). Default: "account".'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const rest = params;
        const result = await orchestratedCreate(state.apiClient, rest, registry);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // update_workflow: Update an existing workflow with partial changes.
  server.registerTool(
    'update_workflow',
    {
      description: 'Update an existing workflow with partial changes. Action and trigger types must come from the enums in this schema. Use the then/else scaffold for if_else; verbose three-sibling form also accepted. Pass only fields you want to change. Salvage decisions surface in skippedActions[] and warnings[]. When any HARD drop occurs, status is forced to draft. ' + DOCS_MCP_HINT + '',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1)
          .describe('The workflow ID to update (from list_workflows)'),
        name: z.string().min(1).optional()
          .describe('New workflow name'),
        status: z.enum(['draft', 'published']).optional()
          .describe('New workflow status'),
        actions: z.array(z.object({
          type: z.string().min(1).describe('Action type — should be one of the registry action types. Unknown types are dropped with a warning by the shape validator.'),
          name: z.string().describe('Step name'),
          attributes: z.record(z.unknown()).optional().describe('Action-specific configuration'),
          id: z.string().optional().describe('Existing action ID to preserve. Omit for new actions.'),
          // Phase 17 D-01 passthrough: lets caller-supplied wiring fields (next, nodeType, parent,
          // parentKey, sibling, cat, comments, etc.) survive Zod parse and reach diffAndWireActions
          // verbatim. See create_workflow above for full rationale.
        }).passthrough()).optional().describe('Complete replacement action list. Include existing action IDs to keep them, omit ID for new actions.'),
        // 260426-lf7: trigger CRUD via the `triggers` array. Inline shape mirrors
        // create_workflow's triggers array PLUS an optional `id` field (id present
        // → update existing, id absent → create new). Triggers in current state
        // whose ids are NOT present in the requested array are DELETED. Omitting
        // `triggers` entirely preserves today's pass-through (zero trigger HTTP).
        // .passthrough() for forward compatibility (mirrors actions discipline).
        triggers: z.array(z.object({
          id: z.string().optional().describe('Existing trigger ID to update. Omit to create a new trigger.'),
          type: z.enum(KNOWN_TRIGGER_TYPES).describe('Trigger type — must be one of the registry trigger types.'),
          name: z.string().optional().describe('Human-readable trigger name (defaults to trigger type)'),
          conditions: z.array(z.object({
            field: z.string(),
            operator: z.string(),
            value: z.union([z.string(), z.array(z.string())]),
            title: z.string().optional(),
            type: z.string().optional(),
          })).optional().describe('Trigger filter conditions'),
          masterType: z.string().optional().describe('Master type (default: highlevel)'),
        }).passthrough()).optional().describe('Complete replacement trigger list. Include existing trigger IDs to keep/update them, omit ID for new triggers. Triggers in the workflow whose IDs are not in this array will be DELETED. Pass [] to delete ALL triggers. Omit entirely to leave triggers untouched.'),
        // VRX: workflow-level settings (flat top-level — destructured into `changes` and applied with three-tier fallback: changes > current > default)
        stopOnResponse: z.boolean().optional()
          .describe('When true, pauses workflow execution if a contact responds. Preserved on partial updates.'),
        allowMultiple: z.boolean().optional()
          .describe('When true, the same contact can be enrolled in this workflow multiple times concurrently. Preserved on partial updates.'),
        allowMultipleOpportunity: z.boolean().optional()
          .describe('When true, allows multiple opportunities per contact in this workflow. Preserved on partial updates.'),
        removeContactFromLastStep: z.boolean().optional()
          .describe('When true, contacts are removed from the workflow after completing the final step. Preserved on partial updates.'),
        autoMarkAsRead: z.boolean().optional()
          .describe('When true, conversation messages received during the workflow are auto-marked as read. Preserved on partial updates.'),
        timezone: z.string().optional()
          .describe('Workflow timezone — use "account" for the location default, or an IANA zone (e.g. "America/Los_Angeles"). Preserved on partial updates.'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const rest = params;
        const result = await orchestratedUpdate(state.apiClient, rest, registry);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 13.4: cache-backed read tools + patch_workflow
  // ---------------------------------------------------------------------------

  /**
   * Extract the actions array from a workflow snapshot.
   *
   * The GHL detail response stores steps at `workflowData.templates`; our
   * patch-ops helpers (and our outline shape) operate on a flat `actions`
   * array. Cached snapshots may carry either shape (Plan 13.4-03 caches
   * the raw detail; the patch-ops fixture uses top-level `actions`). This
   * helper picks whichever is present, preferring `actions`.
   *
   * @param {object} wf
   * @returns {object[]}
   */
  function extractActions(wf) {
    if (Array.isArray(wf?.actions)) return wf.actions;
    if (Array.isArray(wf?.workflowData?.templates)) return wf.workflowData.templates;
    return [];
  }

  /**
   * Deterministic hash for drift detection (D-19) — used as fallback when
   * the live workflow lacks a `version` field. Hashes [name, status, ordered
   * step IDs] only — attribute changes do NOT count as drift here because
   * the version field is the canonical signal; this hash is the structural
   * floor.
   *
   * @param {object} wf
   * @returns {string}
   */
  function deterministicHash(wf) {
    const ids = extractActions(wf).map((a) => a.id);
    const payload = JSON.stringify([wf?.name ?? null, wf?.status ?? null, ids]);
    return createHash('sha256').update(payload).digest('hex');
  }

  // read_workflow_outline: cheap step-index map; no attributes (D-16 — FREE).
  server.registerTool(
    'read_workflow_outline',
    {
      description: '(FREE) Cheap targeted read — returns workflow metadata + step IDs/types/names/order/next/parentKey only (no attributes). Prefer this as the FIRST read when editing a workflow; follow with read_workflow_step for any step you intend to mutate.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1).describe('Workflow ID (from list_workflows)'),
      }),
    },
    async ({ workflowId }) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        let wf = null;
        try {
          wf = await workflowCache.read(workflowId);
        } catch (cacheErr) {
          logger.warn('workflow-cache read failed, falling back to live:', cacheErr.message);
        }
        if (!wf) {
          wf = await getWorkflow(state.apiClient, workflowId, { includeActionDetails: true });
          // Best-effort write-through so subsequent reads hit cache (D-15 parity).
          try {
            await workflowCache.write(workflowId, wf);
          } catch (writeErr) {
            logger.warn('workflow-cache write failed:', writeErr.message);
          }
        }
        const steps = extractActions(wf).map((s) => {
          const entry = {
            id: s.id,
            type: s.type,
            name: s.name,
            order: s.order,
            next: s.next,
            parentKey: s.parentKey,
          };
          if (s.advanceCanvasMeta?.isDisabled) entry.disabled = true;
          return entry;
        });
        const outline = {
          workflow_id: workflowId,
          name: wf.name,
          status: wf.status,
          steps,
        };
        return { content: [{ type: 'text', text: JSON.stringify(outline, null, 2) }] };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // read_workflow_step: single step's full JSON (D-16 — FREE).
  server.registerTool(
    'read_workflow_step',
    {
      description: '(FREE) Returns one step\'s full JSON for a given workflow + step ID. Use after read_workflow_outline to inspect a specific step before patching it. Returns a structured step_not_found error with valid_step_ids when the step does not exist.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1).describe('Workflow ID (from list_workflows)'),
        stepId: z.string().min(1).describe('Step ID (from read_workflow_outline.steps[].id)'),
      }),
    },
    async ({ workflowId, stepId }) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        let wf = null;
        try {
          wf = await workflowCache.read(workflowId);
        } catch (cacheErr) {
          logger.warn('workflow-cache read failed, falling back to live:', cacheErr.message);
        }
        if (!wf) {
          wf = await getWorkflow(state.apiClient, workflowId, { includeActionDetails: true });
          try {
            await workflowCache.write(workflowId, wf);
          } catch (writeErr) {
            logger.warn('workflow-cache write failed:', writeErr.message);
          }
        }
        const steps = extractActions(wf);
        const step = steps.find((s) => s.id === stepId);
        if (!step) {
          // D-09: step_not_found shape; D-10: isError:false (structured rejection).
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'step_not_found',
                message: `Step "${stepId}" not found in workflow "${workflowId}"`,
                details: { step_id: stepId, valid_step_ids: steps.map((s) => s.id) },
              }, null, 2),
            }],
            isError: false,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(step, null, 2) }] };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // patch_workflow: Apply ordered patch operations with deterministic
  // pointer rewiring (D-06/D-07 dry-run, D-08/D-09/D-10 structured errors,
  // D-14/D-15 update_workflow response shape, D-16 paid, D-18/D-19 drift).
  server.registerTool(
    'patch_workflow',
    {
      description: 'Apply an ordered list of patch operations to a workflow with deterministic server-side pointer rewiring. Ops: insert_after / update_step / delete_step / move / rewire_step (plus add_trigger / update_trigger / remove_trigger). Param roles — step_id = the SUBJECT the op acts on (update_step/delete_step/move/rewire_step); after_step_id = the ANCHOR to position after (insert_after/move); next = the target pointer for rewire_step (a step ID or null to terminate); trigger_id = the subject trigger. insert_after also accepts step_id as an alias for after_step_id. rewire_step overwrites a non-branched step scalar next in place (no splice, no reorder) — it does NOT validate for cycles or orphaned downstream steps; the caller owns flow correctness. All-or-nothing: any op failure aborts before any GHL write. Detects external workflow changes via the version field. Use after read_workflow_outline + read_workflow_step. For whole-workflow rewrites or branched-step splices, fall back to update_workflow. ' + DOCS_MCP_HINT,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1).describe('Workflow ID (from list_workflows)'),
        operations: z.array(z.discriminatedUnion('op', [
          z.object({
            op: z.literal('insert_after'),
            after_step_id: z.string().min(1).optional().describe('Step ID after which the new step is inserted (anchor). Provide this or its alias step_id.'),
            step_id: z.string().min(1).optional().describe('Alias for after_step_id (the anchor step). Provide one or the other.'),
            step: z.object({
              id: z.string().optional().describe('Optional explicit ID; auto-generated when omitted'),
              type: z.string().describe('Action type'),
              name: z.string().describe('Step name'),
              attributes: z.record(z.unknown()).optional(),
            }).passthrough(),
          }),
          z.object({
            op: z.literal('update_step'),
            step_id: z.string().min(1),
            patch: z.record(z.unknown()).describe('Deep-merged into the step. MUST NOT include next/parentKey/order.'),
          }),
          z.object({
            op: z.literal('delete_step'),
            step_id: z.string().min(1),
          }),
          z.object({
            op: z.literal('move'),
            step_id: z.string().min(1),
            after_step_id: z.string().min(1),
          }),
          z.object({
            op: z.literal('rewire_step'),
            step_id: z.string().min(1).describe('Subject step whose scalar next pointer is rewired'),
            next: z.string().nullable().describe('Target step ID to point next at, or null to terminate the chain. Does NOT splice/reposition — only overwrites the scalar next.'),
          }),
          // 260426-lf7: trigger ops — append to clone.pendingTriggerOps[] during
          // dry-run; the handler replays the queue into a final triggers[] payload
          // that updateWorkflow's diff path materializes via POST/PUT/DELETE.
          z.object({
            op: z.literal('add_trigger'),
            trigger: z.object({
              type: z.string().describe('Trigger type (e.g., form_submission, contact_tag, opportunity_status_changed)'),
              name: z.string().optional().describe('Human-readable trigger name'),
              conditions: z.array(z.object({
                field: z.string(),
                operator: z.string(),
                value: z.union([z.string(), z.array(z.string())]),
                title: z.string().optional(),
                type: z.string().optional(),
              })).optional(),
              masterType: z.string().optional(),
            }).passthrough().describe('New trigger to attach to the workflow (no id — GHL assigns it on create).'),
          }),
          z.object({
            op: z.literal('update_trigger'),
            trigger_id: z.string().min(1),
            patch: z.record(z.unknown()).describe('Fields to merge onto the matching trigger. May include type, name, conditions, masterType.'),
          }),
          z.object({
            op: z.literal('remove_trigger'),
            trigger_id: z.string().min(1),
          }),
        ])).min(1).describe('Ordered list of patch operations'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      const { workflowId, operations } = params;
      try {
        // Drift detection setup (D-18/D-19): capture pre-refresh cached version
        // (or hash fallback) BEFORE the live refresh so a real `live.version`
        // can be compared against the version the user thinks they're patching.
        let cachedPre = null;
        try {
          cachedPre = await workflowCache.read(workflowId);
        } catch (cacheErr) {
          logger.warn('workflow-cache read failed, drift detection degraded:', cacheErr.message);
        }
        const cachedVersionPre = cachedPre?.version ?? null;
        const cachedHashPre = cachedPre ? deterministicHash(cachedPre) : null;

        // Refresh live workflow. (Cache write-through is owned by Plan 13.4-03.
        // We tolerate either presence or absence.)
        const live = await getWorkflow(state.apiClient, workflowId, { includeActionDetails: true });
        const liveVersion = live.version ?? null;
        const liveHash = deterministicHash(live);

        // Drift triggers when we have a cache to compare against AND either
        // the version field differs (preferred) or — when no version field is
        // available on either side — the structural hash differs (D-19 fallback).
        let driftDetected = false;
        if (cachedPre) {
          if (cachedVersionPre !== null && liveVersion !== null) {
            driftDetected = cachedVersionPre !== liveVersion;
          } else {
            driftDetected = cachedHashPre !== liveHash;
          }
        }
        if (driftDetected) {
          // D-09 workflow_changed_externally + D-10 isError:false.
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'workflow_changed_externally',
                message: 'Workflow changed externally since cached snapshot. Re-read before retrying patch.',
                details: {
                  cached_version: cachedVersionPre,
                  live_version: liveVersion,
                  recommendation: 're-read workflow before retrying patch',
                },
              }, null, 2),
            }],
            isError: false,
          };
        }

        // Dry-run (D-06/D-07): apply ops to a structuredClone, abort on first
        // failure with the structured envelope. The patch-ops helpers accept
        // a workflow whose actions are at top-level — normalise the GHL detail
        // shape (workflowData.templates) onto a flat actions array first so
        // patch-ops can splice/update/delete without reaching into nested keys.
        //
        // Possible thrown error codes from patch-ops (D-09): step_not_found,
        // pointer_fields_forbidden, branched_step_unsupported. Each carries
        // its `.code` and `.details` fields verbatim into the response envelope
        // below so callers see structured rejections (D-08/D-10 isError:false).
        const liveActions = extractActions(live);
        let clone = structuredClone({
          ...live,
          actions: liveActions,
        });
        for (const op of operations) {
          try {
            if (op.op === 'insert_after') {
              // Accept `step_id` as an alias for `after_step_id` (the anchor).
              // zod ^3.25 rejects .refine/.transform members inside a
              // discriminatedUnion, so the both-optional schema + this
              // normalisation replace the schema-level alias transform.
              const anchor = op.after_step_id ?? op.step_id;
              if (!anchor) {
                const e = new Error('insert_after requires after_step_id (or its alias step_id)');
                e.code = 'missing_anchor';
                e.details = { op: 'insert_after' };
                throw e;
              }
              clone = insertAfter(clone, { after_step_id: anchor, step: op.step });
            } else if (op.op === 'update_step') {
              clone = updateStep(clone, { step_id: op.step_id, patch: op.patch });
            } else if (op.op === 'delete_step') {
              clone = deleteStep(clone, { step_id: op.step_id });
            } else if (op.op === 'move') {
              clone = moveStep(clone, { step_id: op.step_id, after_step_id: op.after_step_id });
            } else if (op.op === 'rewire_step') {
              clone = rewireStep(clone, { step_id: op.step_id, next: op.next });
            } else if (op.op === 'add_trigger') {
              clone = addTrigger(clone, { trigger: op.trigger });
            } else if (op.op === 'update_trigger') {
              clone = updateTriggerOp(clone, { trigger_id: op.trigger_id, patch: op.patch });
            } else if (op.op === 'remove_trigger') {
              clone = removeTrigger(clone, { trigger_id: op.trigger_id });
            }
          } catch (opErr) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: opErr.code ?? 'patch_op_failed',
                  message: opErr.message,
                  details: opErr.details ?? {},
                }, null, 2),
              }],
              isError: false,
            };
          }
        }

        // Commit via existing updateWorkflow path. updateWorkflow internally invokes
        // diffAndWireActions(oldActions, changes.actions) at src/api/write-workflows.js:502
        // to convert the actions array to the wire format expected by GHL.
        // diffAndWireActions now preserves caller-supplied IDs on new steps, so
        // patch-ops branch wiring (next arrays, parent/parentKey/sibling pointers)
        // survives the diff pass intact. No ID-stripping reconciliation needed.

        // 260426-lf7: replay clone.pendingTriggerOps[] against live.triggers
        // to compute a final triggers[] payload. updateWorkflow's diff path
        // (src/api/write-workflows.js) then materializes the diff via
        // POST/PUT/DELETE before the Step-3 save. Only attach `triggers` to
        // the updateWorkflow call when at least one trigger op was queued —
        // omitting the key preserves updateWorkflow's no-op behavior for
        // patch_workflow operation lists that don't touch triggers.
        const pendingOps = Array.isArray(clone.pendingTriggerOps) ? clone.pendingTriggerOps : [];
        const updateArgs = {
          actions: clone.actions,
          name: clone.name,
          status: clone.status,
        };
        if (pendingOps.length > 0) {
          const liveTriggers = Array.isArray(live.triggers) ? live.triggers : [];
          const finalTriggers = [];
          // Start by carrying every live trigger forward.
          for (const t of liveTriggers) finalTriggers.push({ ...t });
          for (const pendingOp of pendingOps) {
            if (pendingOp.kind === 'create') {
              // No id — updateWorkflow's diff path will assign one via POST.
              finalTriggers.push({ ...pendingOp.trigger });
            } else if (pendingOp.kind === 'update') {
              const idx = finalTriggers.findIndex(t => t.id === pendingOp.triggerId);
              if (idx !== -1) {
                finalTriggers[idx] = { ...finalTriggers[idx], ...pendingOp.patch, id: pendingOp.triggerId };
              }
            } else if (pendingOp.kind === 'delete') {
              const idx = finalTriggers.findIndex(t => t.id === pendingOp.triggerId);
              if (idx !== -1) finalTriggers.splice(idx, 1);
            }
          }
          updateArgs.triggers = finalTriggers;
        }

        // regression: reject-gate. patch_workflow historically bypassed shape
        // validation entirely, letting malformed shapes render broken in GHL.
        // Validate the committed actions and refuse to commit if any deep-checked
        // type is malformed. Reject-gate only — passing actions commit unchanged
        // (patch semantics preserve caller wiring; do NOT substitute sanitized).
        // skippedActions carry only class/kind/name/type/reason/expectedShape —
        // safe to surface (no attributes content, T-79-01).
        const shapeValidation = validateActionShapes(updateArgs.actions ?? [], [], registry);
        const rejected = shapeValidation.skippedActions.filter(
          (s) => s.class === 'malformed-shape-rejected',
        );
        if (rejected.length > 0) {
          const rejectedTypes = [...new Set(rejected.map((s) => s.type))].join(', ');
          const rejectResponse = {
            status: 'error',
            error: `patch rejected: malformed action shape(s) for type(s): ${rejectedTypes}. See src/registry/action-shapes.json for the canonical shape. ${DOCS_MCP_HINT}`,
            skippedActions: rejected,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(rejectResponse, null, 2) }],
            isError: true,
          };
        }

        await updateWorkflow(state.apiClient, workflowId, updateArgs);

        // D-15: post-commit re-fetch (write-through caches the new live state).
        const refreshed = await getWorkflow(state.apiClient, workflowId, { includeActionDetails: true });
        try {
          await workflowCache.write(workflowId, refreshed);
        } catch (writeErr) {
          logger.warn('workflow-cache write failed:', writeErr.message);
        }
        // #77: read back what GHL actually stored. A rewire that did not land
        // must fail loudly — never "success + version bump + nothing changed".
        const mismatches = verifyRewires(operations, extractActions(refreshed));
        if (mismatches.length > 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'patch_not_applied',
                message: `GHL accepted the save but ${mismatches.length} rewire_step op(s) did not persist. The workflow was written (version ${refreshed.version ?? 'unknown'}) — re-read it before retrying.`,
                details: { mismatches, version: refreshed.version ?? null },
              }, null, 2),
            }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(refreshed, null, 2) }] };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // delete_workflow: Delete a workflow permanently.
  server.registerTool(
    'delete_workflow',
    {
      description: 'Delete a workflow permanently. Returns the deleted workflow name for confirmation. No undo — the workflow is removed from GHL immediately.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1)
          .describe('The workflow ID to delete (from list_workflows)'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const result = await deleteWorkflow(state.apiClient, params.workflowId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // publish_workflow: Publish a draft workflow.
  server.registerTool(
    'publish_workflow',
    {
      description: 'Publish a draft workflow, changing its status to published. The workflow will become active and start processing contacts when triggered. Returns the full workflow object after publishing.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1)
          .describe('The workflow ID to publish (from list_workflows)'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const result = await publishWorkflow(state.apiClient, params.workflowId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // clone_workflow: Clone an existing workflow on the same location.
  server.registerTool(
    'clone_workflow',
    {
      description: 'Clone an existing workflow, creating an independent copy on the same location. GHL handles all UUID remapping and action chain wiring server-side. By default the clone is named "Copy - {original name}" — pass a custom name to override. Returns the full cloned workflow object.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1)
          .describe('The workflow ID to clone (from list_workflows)'),
        name: z.string().min(1).optional()
          .describe('Custom name for the clone. Defaults to "Copy - {original name}".'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const result = await cloneWorkflow(state.apiClient, params.workflowId, { name: params.name });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // --- Folder management tools ---

  server.registerTool(
    'create_folder',
    {
      description: 'Create a new workflow folder in the current GHL location. Returns the created folder object.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        name: z.string().min(1).describe('Name for the new folder'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await createFolder(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'delete_folder',
    {
      description: 'Delete a workflow folder. Any workflows inside the folder are automatically moved to root level by GHL. Cannot be undone.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        folderId: z.string().min(1).describe('The folder ID to delete (from list_folders)'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await deleteFolder(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'rename_folder',
    {
      description: 'Rename an existing workflow folder.',
      inputSchema: z.object({
        folderId: z.string().min(1).describe('The folder ID to rename (from list_folders)'),
        name: z.string().min(1).describe('New name for the folder'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await renameFolder(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'move_workflow',
    {
      description: 'Move a workflow into a folder, or back to root level. To move to root, omit folderId or pass null.',
      inputSchema: z.object({
        workflowId: z.string().min(1).describe('The workflow ID to move (from list_workflows)'),
        folderId: z.string().nullable().optional()
          .describe('Target folder ID (from list_folders). Omit or null to move to root level.'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await moveWorkflow(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_folders',
    {
      description: 'List all workflow folders in the current GHL location. Returns folder names and IDs. Use folder IDs with move_workflow or list_workflows (folderId param).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listFolders(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // --- Entity tools (tags, users, pipelines, custom fields, etc.) ---

  server.registerTool(
    'list_tags',
    {
      description: 'List all tags in the current GoHighLevel location. Returns tag names and IDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listTags(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'create_tag',
    {
      description: 'Create a new tag in the current GoHighLevel location.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        tagName: z.string().min(1).describe('Name for the new tag'),
      }),
    },
    async (params) => {
      const connGate = requireConnection();
      if (connGate) return connGate;
      try {
        const result = await createTag(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_users',
    {
      description: 'List all users with access to the current GoHighLevel location. Returns user names, emails, roles, and permissions.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listUsers(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_pipelines',
    {
      description: 'List all opportunity pipelines in the current GoHighLevel location. Returns pipeline names with their stages (name, position).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listPipelines(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_custom_fields',
    {
      description: 'List custom fields in the current GoHighLevel location. Requires a model parameter to specify which entity type (contact or opportunity). Contact and opportunity custom fields use different API endpoints internally.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ model: z.enum(['contact', 'opportunity']).describe('Entity model to list custom fields for') }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listCustomFields(state.apiClient, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_custom_values',
    {
      description: 'List custom values (template variables) for conversations in the current GoHighLevel location. Returns system-defined static variables and location-specific custom values.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listCustomValues(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_associations',
    {
      description: 'List object associations for contacts in the current GoHighLevel location. Returns association types and cardinality between objects.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listAssociations(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_business_fields',
    {
      description: 'List the business object definition and its fields in the current GoHighLevel location. Returns the object metadata and all custom/standard fields.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listBusinessFields(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_forms',
    {
      description: 'List all forms in the current GoHighLevel location. Returns form names and IDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listForms(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_trigger_links',
    {
      description: 'List all trigger links (one-click action links) in the current GoHighLevel location. Returns link names and IDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listTriggerLinks(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_email_templates',
    {
      description: 'List all email templates in the current GoHighLevel location. Returns template names and IDs for use in workflow email actions.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const result = await listEmailTemplates(state.apiClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // --- Audit tool (entity validation) ---

  server.registerTool(
    'audit_workflow',
    {
      description: 'Audit a workflow for broken entity references. Scans all actions and triggers for pipeline, stage, user, custom field, and custom value IDs, then validates each against the location data. Returns which references are valid, which are broken, and suggests replacements.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workflowId: z.string().min(1).describe('Workflow ID to audit (UUID format, from list_workflows results)'),
      }),
    },
    async (params) => {
      const gate = requireConnection();
      if (gate) return gate;
      try {
        const workflow = await getWorkflow(state.apiClient, params.workflowId, { includeActionDetails: true });
        const report = await auditWorkflowEntities(state.apiClient, workflow);
        const markdown = formatAuditReport(report);
        return {
          content: [
            { type: 'text', text: markdown },
            { type: 'text', text: JSON.stringify(report, null, 2) },
          ],
        };
      } catch (err) {
        const errorResponse = { status: 'error', error: err.message };
        if (err.suggestion) errorResponse.suggestion = err.suggestion;
        return {
          content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }],
          isError: true,
        };
      }
    },
  );

  const entityGuideContent = `# Entity-Aware Workflow Building Guide

## Overview

The GHL Workflow MCP server validates entity references in workflows. When you create or edit a workflow, all ID-based entity references (pipelines, pipeline stages, users, custom fields, custom values) are checked against the location's actual data.

## Which Entities Need Real IDs

| Entity Type | Example Field | How to Get Valid IDs |
|-------------|---------------|---------------------|
| Pipeline | pipelineId | Call list_pipelines tool |
| Pipeline Stage | pipelineStageId | Call list_pipelines tool (stages nested inside pipelines) |
| User | userId, assignedTo | Call list_users tool |
| Custom Field | fields[].field | Call list_custom_fields tool (model: "contact" or "opportunity") |
| Custom Value | custom value ID | Call list_custom_values tool |

## Which Values Are Text (No Validation Needed)

- Tag names (text strings, auto-created if missing)
- Standard contact fields (firstName, lastName, email, phone, etc.)
- Freeform text content (SMS messages, email bodies)
- Wait step durations
- Webhook URLs

## Recommended Workflow

1. **Before building:** Query entity list tools to get valid IDs for the target location
2. **Build the workflow:** Use real IDs from the list tool responses
3. **After creation:** Check the response for entityWarnings — fix any invalid references
4. **For imported workflows:** Use audit_workflow tool to scan for broken references before publishing

## Validation Behavior

- Validation is **non-blocking** — workflows save even with invalid references
- Invalid references produce **warnings** with up to 10 valid alternatives
- Each warning includes a **suggested fix** action
- Tags are **auto-created** if missing (separate from entity validation)

## Pipeline Stage Validation

Pipeline stages are validated in context — a stage must belong to the pipeline referenced in the same action. If you reference pipelineId "A" and pipelineStageId "X", stage X must be a stage within pipeline A.
`;

  server.registerResource(
    'entities-guide',
    'ghl://entities/guide',
    {
      title: 'Entity-Aware Workflow Building Guide',
      description: 'Describes which workflow fields need real entity IDs, how to get them, and how entity validation works.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: entityGuideContent,
      }],
    }),
  );

  return server;
}
