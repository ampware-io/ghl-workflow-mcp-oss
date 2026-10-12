/**
 * Folder management operations for GHL's internal API.
 *
 * Provides createFolder, deleteFolder, renameFolder, moveWorkflow,
 * and listFolders for managing workflow folders.
 */

import { logger } from '../utils/logger.js';

const BATCH_SIZE = 50;

/**
 * Create a new folder in the workflow builder.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.name - Folder name
 * @returns {Promise<{ status: string, folder: object }>}
 */
export async function createFolder(apiClient, { name }) {
  const locationId = apiClient.getLocationId();
  const ctx = await apiClient.getWriteContext();

  logger.info('Creating folder:', name);

  const payload = {
    type: 'directory',
    name,
    updatedBy: ctx.user_id,
    parentId: null,
    company_id: ctx.company_id,
    company_age: ctx.company_age,
  };

  const result = await apiClient.post(`/workflow/${locationId}/directory`, payload);

  logger.debug('Folder created:', result._id);

  return { status: 'created', folder: result };
}

/**
 * Delete a folder. Any workflows inside are moved to root.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.folderId - ID of the folder to delete
 * @returns {Promise<{ status: string, folderId: string, note: string }>}
 */
export async function deleteFolder(apiClient, { folderId }) {
  const locationId = apiClient.getLocationId();
  const ctx = await apiClient.getWriteContext();

  logger.info('Deleting folder:', folderId);

  const body = {
    type: 'directory',
    workflowIds: [folderId],
    updatedBy: ctx.user_id,
  };

  await apiClient.delete(`/workflow/${locationId}/delete`, body);

  return {
    status: 'deleted',
    folderId,
    note: 'Any workflows in this folder have been moved to root.',
  };
}

/**
 * Rename a folder.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.folderId - ID of the folder to rename
 * @param {string} params.name - New folder name
 * @returns {Promise<{ status: string, folderId: string, name: string }>}
 */
export async function renameFolder(apiClient, { folderId, name }) {
  const locationId = apiClient.getLocationId();

  logger.info('Renaming folder:', folderId, '->', name);

  await apiClient.put(`/workflow/${locationId}/rename-directory/${folderId}`, { name });

  return { status: 'renamed', folderId, name };
}

/**
 * Move a workflow into a folder, or to root if folderId is null.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @param {object} params
 * @param {string} params.workflowId - ID of the workflow to move
 * @param {string|null} [params.folderId=null] - Target folder ID, or null for root
 * @returns {Promise<{ status: string, workflowId: string, destination: string }>}
 */
export async function moveWorkflow(apiClient, { workflowId, folderId = null }) {
  const locationId = apiClient.getLocationId();

  logger.info('Moving workflow:', workflowId, '-> folder:', folderId || 'root');

  await apiClient.put(`/workflow/${locationId}/move-directory/${workflowId}`, { parentId: folderId });

  return {
    status: 'moved',
    workflowId,
    destination: folderId || 'root',
  };
}

/**
 * List all folders for the current location.
 * Auto-paginates through all items and filters to type === 'directory'.
 *
 * @param {import('./client.js').GhlApiClient} apiClient
 * @returns {Promise<{ folders: object[] }>}
 */
export async function listFolders(apiClient) {
  const locationId = apiClient.getLocationId();

  const MAX_PAGES = 100;
  const allItems = [];
  let currentOffset = 0;
  let totalCount = Infinity;
  let pagesFetched = 0;

  while (allItems.length < totalCount) {
    if (pagesFetched >= MAX_PAGES) {
      logger.debug('listFolders: hit MAX_PAGES safety ceiling, stopping pagination');
      break;
    }
    const params = new URLSearchParams({
      type: 'directory',
      limit: String(BATCH_SIZE),
      offset: String(currentOffset),
      sortBy: 'name',
      sortOrder: 'asc',
    });

    const page = await apiClient.get(`/workflow/${locationId}/list?${params}`);
    const rows = page.rows || [];

    if (page.count !== undefined) {
      totalCount = page.count;
    }

    allItems.push(...rows);

    if (rows.length === 0) {
      break;
    }

    currentOffset += rows.length;
    pagesFetched = pagesFetched + 1;
  }

  const folders = allItems.filter((item) => item.type === 'directory');

  logger.debug('Listed', folders.length, 'folders');

  return { folders };
}
