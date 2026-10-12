/**
 * Workflow cache — atomic per-workflow JSON cache module (Phase 13.4 D-02, D-13).
 *
 * Stores one JSON file per workflow at `{cacheDir}/{workflowId}.json`. The
 * cache directory defaults to `~/.ghl-wkfl/cache/` and can be overridden at
 * runtime via the `GHL_MCP_CACHE_DIR` env var (D-11). Resolution happens at
 * function-call time, not module-load time, so tests can override per-test.
 *
 * Atomic write sequence (write to .tmp, then rename):
 *   mkdir(parent, recursive) → unlink(tmp, ignore ENOENT) →
 *   open(tmp,'wx',0o600) → writeFile → fsync → close → rename(tmp, final)
 *
 * Cache-write failures are surfaced via thrown errors. Callers (Wave 2's
 * getWorkflow / patch_workflow) wrap these in best-effort try/catch and
 * stderr-log via logger.warn — the cache module itself does not log.
 *
 * workflowId is sanitised against path traversal: any of `/`, `\\`, `..`,
 * or characters outside [a-zA-Z0-9_-] cause an immediate Error.
 */

import { open, readFile, rename, unlink, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the cache directory. `GHL_MCP_CACHE_DIR` env override wins; default
 * is `~/.ghl-wkfl/cache/`. Resolved at every call so tests can flip the env
 * var per-test without module re-import.
 *
 * @returns {string}
 */
export function getCacheDir() {
  const override = process.env.GHL_MCP_CACHE_DIR;
  if (override) return override;
  return join(homedir(), '.ghl-wkfl', 'cache');
}

/**
 * Validate `workflowId` is filesystem-safe and return the absolute cache file
 * path for it. Rejects path-traversal and any character outside the safe set
 * `[a-zA-Z0-9_-]`.
 *
 * @param {string} workflowId
 * @returns {string}
 */
function cacheFilePath(workflowId) {
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    throw new Error('Invalid workflowId: must be a non-empty string');
  }
  if (workflowId.includes('/') || workflowId.includes('\\') || workflowId.includes('..')) {
    throw new Error('Invalid workflowId: path traversal characters not allowed');
  }
  if (/[^a-zA-Z0-9_-]/.test(workflowId)) {
    throw new Error('Invalid workflowId: only [a-zA-Z0-9_-] characters allowed');
  }
  return join(getCacheDir(), `${workflowId}.json`);
}

/**
 * Read a cached workflow by id. Returns parsed JSON on hit, `null` on cache
 * miss (ENOENT). Other I/O or JSON.parse errors propagate.
 *
 * @param {string} workflowId
 * @returns {Promise<object | null>}
 */
export async function read(workflowId) {
  const path = cacheFilePath(workflowId);
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Atomically persist `json` for `workflowId`. Mirrors the Phase 12
 * atomic-write discipline: write to a `.tmp` sibling
 * with `wx` (exclusive create) at mode 0o600, fsync, close, then rename onto
 * the final path. Any failure cleans up the tmp file before rethrowing so
 * subsequent writes are never blocked by EEXIST.
 *
 * @param {string} workflowId
 * @param {object} json
 * @returns {Promise<void>}
 */
export async function write(workflowId, json) {
  const path = cacheFilePath(workflowId);
  const tmp = path + '.tmp';
  await mkdir(dirname(path), { recursive: true });

  // Best-effort cleanup of stale tmp from a prior crashed write. Without this,
  // a write() that crashed between open('wx') and rename() would leave a .tmp
  // file that permanently blocks every subsequent write() attempt.
  try {
    await unlink(tmp);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let wroteTmp = false;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    wroteTmp = true;
    try {
      await fh.writeFile(JSON.stringify(json, null, 2), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    if (wroteTmp) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}

/**
 * Whether a cache file exists for `workflowId`. Returns `false` for any
 * access() failure (ENOENT, EACCES, etc.) — callers treat this purely as a
 * "should I attempt read()?" hint.
 *
 * @param {string} workflowId
 * @returns {Promise<boolean>}
 */
export async function exists(workflowId) {
  try {
    await access(cacheFilePath(workflowId));
    return true;
  } catch {
    return false;
  }
}
