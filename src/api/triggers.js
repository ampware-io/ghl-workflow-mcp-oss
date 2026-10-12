/**
 * Trigger CRUD HTTP primitives — thin wrappers over GHL's
 * /workflow/{loc}/trigger[/{id}] endpoints. Reuses buildTriggerPayload
 * (src/utils/action-chain.js) so condition normalization (read-format
 * "==" → write-format "is-any-of") is uniform across POST and PUT.
 *
 * No retry / no rollback / no rate-limit — those concerns belong to the
 * orchestrator (updateWorkflow's trigger diff loop) and the surrounding
 * pacing client. These functions are intentionally minimal so partial-
 * failure semantics stay observable to the caller.
 *
 * Auth: all paths start with /workflow/, which the dual-token detector
 * in src/api/client.js routes through the workflow microfrontend
 * (Firebase JWT only — no GHL session bearer).
 *
 * @module src/api/triggers
 */

import { buildTriggerPayload } from '../utils/action-chain.js';

/**
 * POST /workflow/{loc}/trigger — create a new trigger linked to a workflow.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} args
 * @param {string} args.workflowId
 * @param {object} args.trigger     — { type, name?, conditions?, masterType? }
 * @param {object} args.ctx         — apiClient.getWriteContext() snapshot
 * @returns {Promise<{id: string}>} GHL response containing the new trigger's id
 * @throws {Error} when GHL response lacks an `id` field (mirrors createWorkflow's invariant)
 */
export async function createTrigger(apiClient, { workflowId, trigger, ctx }) {
  const locationId = apiClient.getLocationId();
  const body = buildTriggerPayload(trigger, workflowId, locationId, ctx);
  const result = await apiClient.post(`/workflow/${locationId}/trigger`, body);
  if (!result || !result.id) {
    throw new Error(
      `Trigger POST succeeded but returned no id (path: /workflow/${locationId}/trigger). Response: ${JSON.stringify(result).slice(0, 200)}`,
    );
  }
  return result;
}

/**
 * PUT /workflow/{loc}/trigger/{triggerId} — update an existing trigger.
 *
 * Payload mirrors POST shape with the existing trigger id spliced in.
 * [ASSUMED A1 from RESEARCH.md] — verify in DevTools if a 4xx surfaces.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} args
 * @param {string} args.workflowId
 * @param {string} args.triggerId
 * @param {object} args.trigger     — { type, name?, conditions?, masterType? }
 * @param {object} args.ctx         — apiClient.getWriteContext() snapshot
 * @returns {Promise<object>} PUT response (typically the updated trigger)
 */
export async function updateTrigger(apiClient, { workflowId, triggerId, trigger, ctx }) {
  const locationId = apiClient.getLocationId();
  const body = {
    ...buildTriggerPayload(trigger, workflowId, locationId, ctx),
    id: triggerId,
  };
  return await apiClient.put(`/workflow/${locationId}/trigger/${triggerId}`, body);
}

/**
 * DELETE /workflow/{loc}/trigger/{triggerId} — remove an existing trigger.
 *
 * No body, returns whatever the client returns (typically `{}` or empty).
 * [ASSUMED A2 from RESEARCH.md] — empty body, 200/204 response.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} args
 * @param {string} args.triggerId
 * @returns {Promise<*>}
 */
export async function deleteTrigger(apiClient, { triggerId }) {
  const locationId = apiClient.getLocationId();
  return await apiClient.delete(`/workflow/${locationId}/trigger/${triggerId}`);
}
