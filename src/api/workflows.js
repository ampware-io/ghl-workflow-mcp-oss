/**
 * Workflow read operations for GHL's internal API.
 *
 * Provides listWorkflows (with auto-pagination) and getWorkflow
 * (merges detail + triggers into a single response).
 */

import * as workflowCache from '../cache/workflow-cache.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 50;

/**
 * List workflows for the current location.
 *
 * By default, auto-fetches all pages. Pass limit/offset to get a single page.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} [options={}]
 * @param {string} [options.sortBy='name'] - Field to sort by
 * @param {string} [options.sortOrder='asc'] - Sort direction ('asc' or 'desc')
 * @param {number} [options.limit] - Page size (enables single-page mode)
 * @param {number} [options.offset] - Page offset (enables single-page mode)
 * @returns {Promise<{ workflows: object[] }>}
 */
export async function listWorkflows(apiClient, options = {}) {
  const locationId = apiClient.getLocationId();
  const { sortBy = 'name', sortOrder = 'asc', limit, offset, folderId } = options;

  // Single-page mode: caller specified limit or offset
  if (limit !== undefined || offset !== undefined) {
    const params = new URLSearchParams({
      type: 'workflow',
      limit: String(limit ?? 10),
      offset: String(offset ?? 0),
      sortBy,
      sortOrder,
      includeCustomObjects: 'true',
      includeObjectiveBuilder: 'true',
    });
    if (folderId) {
      params.set('parentId', folderId);
    }
    const page = await apiClient.get(`/workflow/${locationId}/list?${params}`);
    return {
      workflows: page.rows || [],
      total_count: page.count ?? (page.rows?.length ?? 0),
    };
  }

  // Auto-pagination mode: fetch all pages
  const allWorkflows = [];
  let currentOffset = 0;
  let totalCount = Infinity;

  while (allWorkflows.length < totalCount) {
    const params = new URLSearchParams({
      type: 'workflow',
      limit: String(BATCH_SIZE),
      offset: String(currentOffset),
      sortBy,
      sortOrder,
      includeCustomObjects: 'true',
      includeObjectiveBuilder: 'true',
    });

    if (folderId) {
      params.set('parentId', folderId);
    }

    const page = await apiClient.get(`/workflow/${locationId}/list?${params}`);
    const workflows = page.rows || [];

    if (page.count !== undefined) {
      totalCount = page.count;
    }

    allWorkflows.push(...workflows);

    if (workflows.length === 0) {
      break;
    }

    currentOffset += workflows.length;
  }

  return { workflows: allWorkflows, total_count: totalCount === Infinity ? allWorkflows.length : totalCount };
}

/**
 * Get workflow detail including triggers.
 *
 * Fetches the workflow detail and triggers endpoints in parallel,
 * merging them into a single object. Returns a summary by default
 * (strips heavy action attributes to keep response size manageable).
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {string} workflowId
 * @param {object} [options={}]
 * @param {boolean} [options.includeActionDetails=false] - Include full action attributes (can produce very large responses)
 * @returns {Promise<object>} Workflow detail with triggers array
 */
export async function getWorkflow(apiClient, workflowId, options = {}) {
  const { includeActionDetails = false } = options;
  const locationId = apiClient.getLocationId();

  const [detail, triggersResponse] = await Promise.all([
    apiClient.get(`/workflow/${locationId}/${workflowId}?includeScheduledPauseInfo=true`),
    apiClient.get(`/workflow/${locationId}/trigger?workflowId=${workflowId}`),
  ]);

  // Handle both { triggers: [...] } wrapper and bare [...] array
  detail.triggers = triggersResponse.triggers || triggersResponse;

  const result = includeActionDetails ? detail : summarizeWorkflow(detail);

  // Best-effort write-through cache (Phase 13.4 D-02). Failures are logged
  // via logger.warn but never propagated to the caller — the API result is
  // the source of truth and tool callers must always receive it.
  try {
    await workflowCache.write(workflowId, result);
  } catch (cacheErr) {
    logger.warn(`cache.write_failed for workflow ${workflowId}: ${cacheErr.message}`);
  }

  return result;
}

/**
 * Strip heavy attributes from workflow actions to produce a compact summary.
 * Keeps action id, order, name, type, and next pointer. Drops attributes
 * (which contain email HTML, webhook configs, etc.) to avoid multi-KB responses.
 *
 * @param {object} detail - Full workflow detail object
 * @returns {object} Summarized workflow
 */
function summarizeWorkflow(detail) {
  const summary = { ...detail };

  if (summary.workflowData?.templates) {
    summary.workflowData = {
      ...summary.workflowData,
      templates: summary.workflowData.templates.map((action) => {
        const compact = {
          id: action.id,
          order: action.order,
          name: action.name,
          type: action.type,
          next: action.next || null,
        };
        if (action.advanceCanvasMeta?.isDisabled) compact.disabled = true;
        return compact;
      }),
    };
  }

  if (summary.triggers) {
    summary.triggers = summary.triggers.map((trigger) => ({
      id: trigger.id || trigger._id,
      name: trigger.name,
      type: trigger.type,
      status: trigger.status,
    }));
  }

  return summary;
}
