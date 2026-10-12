/**
 * Entity API functions for GoHighLevel location resources.
 *
 * Provides list and create operations for tags, users, pipelines,
 * custom fields, custom values, associations, and business fields.
 * All functions follow the same pattern as folders.js: apiClient as
 * first parameter, options as second.
 */

import { logger } from '../utils/logger.js';

/**
 * List all tags for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ tags: Array<{id: string, name: string, locationId: string}> }>}
 */
export async function listTags(apiClient) {
  const locationId = apiClient.getLocationId();

  const result = await apiClient.get(`/locations/${locationId}/tags`);

  logger.debug('Listed', (result.tags || []).length, 'tags');

  return { tags: result.tags || [] };
}

/**
 * Create a new tag for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.tagName - Tag name to create
 * @returns {Promise<{status: 'ok', tagName: string, message: string, id?: string, name?: string}>}
 */
export async function createTag(apiClient, { tagName }) {
  const locationId = apiClient.getLocationId();

  logger.info('Creating tag:', tagName);

  // GHL returns the bare string "OK" on success — normalize so MCP callers get a deterministic signal.
  const result = await apiClient.post(`/workflow/${locationId}/tags/create`, { tag: tagName });

  const response = {
    status: 'ok',
    tagName,
    message: `Tag "${tagName}" created.`,
  };
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.id) response.id = result.id;
    if (result.name) response.name = result.name;
  }
  return response;
}

/**
 * List users with access to the current location.
 * Requires companyId from the write context.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ users: Array<{id: string, name: string, email: string}>, count: number }>}
 */
export async function listUsers(apiClient) {
  const locationId = apiClient.getLocationId();
  const ctx = await apiClient.getWriteContext();

  const params = new URLSearchParams({
    companyId: ctx.companyId,
    locationId,
    skip: '0',
    limit: '500',
  });

  const result = await apiClient.get(`/users/search?${params}`);

  logger.debug('Listed', (result.users || []).length, 'users');

  return { users: result.users || [], count: result.count || 0 };
}

/**
 * List pipelines for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ pipelines: Array<{id: string, name: string, stages: object[]}> }>}
 */
export async function listPipelines(apiClient) {
  const locationId = apiClient.getLocationId();

  const result = await apiClient.get(`/opportunities/pipelines?locationId=${locationId}`);

  logger.debug('Listed', (result.pipelines || []).length, 'pipelines');

  return { pipelines: result.pipelines || [] };
}

/**
 * List custom fields for a given model (contact or opportunity).
 * Routes to different endpoints based on the model parameter:
 * - opportunity: GET /locations/{locationId}/customFields?model=opportunity
 * - contact: GET /locations/{locationId}/customFields/search?limit=10000&documentType=field&includeStandards=true&model=contact
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.model - 'contact' or 'opportunity'
 * @returns {Promise<{ customFields: object[], totalItems?: number }>}
 */
export async function listCustomFields(apiClient, { model }) {
  const locationId = apiClient.getLocationId();

  let result;

  if (model === 'opportunity') {
    result = await apiClient.get(`/locations/${locationId}/customFields?model=opportunity`);
    logger.debug('Listed', (result.customFields || []).length, 'opportunity custom fields');
    return { customFields: result.customFields || [] };
  }

  // contact model uses the search endpoint
  const params = new URLSearchParams({
    limit: '10000',
    documentType: 'field',
    includeStandards: 'true',
    model: 'contact',
  });

  result = await apiClient.get(`/locations/${locationId}/customFields/search?${params}`);

  logger.debug('Listed', (result.customFields || []).length, 'contact custom fields');

  return { customFields: result.customFields || [], totalItems: result.totalItems || 0 };
}

/**
 * List custom values (template variables) for conversations.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ static: object[], customValues: object[] }>}
 */
export async function listCustomValues(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    types: 'custom-values',
  });

  const result = await apiClient.get(`/custom-data/conversations?${params}`);

  logger.debug('Listed custom values');

  return { static: result.static || [], customValues: result['custom-values'] || [] };
}

/**
 * List object associations for contacts.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ associations: object[], total: number }>}
 */
export async function listAssociations(apiClient) {
  const locationId = apiClient.getLocationId();

  const result = await apiClient.get(`/associations/objectKey/contact?locationId=${locationId}`);

  logger.debug('Listed', (result.associations || []).length, 'associations');

  return { associations: result.associations || [], total: result.total || 0 };
}

/**
 * List business object definition and its fields.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ object: object|null, fields: object[] }>}
 */
export async function listBusinessFields(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    fetchProperties: 'true',
  });

  const result = await apiClient.get(`/objects/business/?${params}`);

  logger.debug('Listed business fields');

  return { object: result.object || null, fields: result.fields || [] };
}

/**
 * List email templates for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ emailTemplates: Array<{id: string, _id: string, name: string}> }>}
 */
export async function listEmailTemplates(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    deleted: 'false',
    fields: 'name,id,dateAdded,dateUpdated',
  });

  const result = await apiClient.get(`/emails/builder/all?${params}`);

  // Response is a raw array, not wrapped in an object
  const templates = Array.isArray(result) ? result : [];

  logger.debug('Listed', templates.length, 'email templates');

  return { emailTemplates: templates };
}

/**
 * List calendars for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ calendars: Array<{id: string, name: string}> }>}
 */
export async function listCalendars(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    showDrafted: 'false',
    showThirdParty: 'true',
  });

  const result = await apiClient.get(`/calendars/?${params}`);

  logger.debug('Listed', (result.calendars || []).length, 'calendars');

  return { calendars: result.calendars || [] };
}

/**
 * List forms for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ forms: Array<{_id: string, name: string}>, total: number }>}
 */
export async function listForms(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    query: '',
    type: 'form',
    skip: '0',
    limit: '500',
  });

  const result = await apiClient.get(`/forms/?${params}`);

  logger.debug('Listed', (result.forms || []).length, 'forms');

  return { forms: result.forms || [], total: result.total || 0 };
}

/**
 * List trigger links for the current location.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ links: Array<{_id: string, name: string}>, totalCount: number }>}
 */
export async function listTriggerLinks(apiClient) {
  const locationId = apiClient.getLocationId();

  const params = new URLSearchParams({
    locationId,
    skip: '0',
    limit: '500',
  });

  const result = await apiClient.get(`/links/search?${params}`);

  logger.debug('Listed', (result.links || []).length, 'trigger links');

  return { links: result.links || [], totalCount: result.totalCount || 0 };
}
