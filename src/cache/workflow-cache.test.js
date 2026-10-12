/**
 * Behavioural tests for src/cache/workflow-cache.js — atomic per-workflow JSON
 * cache. Proves:
 *
 *   - getCacheDir() reflects the GHL_MCP_CACHE_DIR env override (D-11).
 *   - write() then read() round-trips arbitrary JSON.
 *   - read() returns null on cache miss (ENOENT).
 *   - exists() reports true after write, false on miss.
 *   - write() overwrites prior content (atomic rename, no EEXIST).
 *   - write() rejects path-traversal workflowIds.
 *   - write() rejects workflowIds with slashes.
 *   - write() creates the cache directory on first use (mkdir recursive).
 *
 * Per D-12: each test gets a fresh tmpdir via mkdtempSync + GHL_MCP_CACHE_DIR
 * override, with rmSync cleanup in afterEach. The original env value is saved
 * and restored so a parent process running these tests with its own
 * GHL_MCP_CACHE_DIR (e.g., a CI cache shim) is not silently clobbered.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cache from './workflow-cache.js';

let tmpDir;
let originalEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'phase13.4-cache-'));
  originalEnv = process.env.GHL_MCP_CACHE_DIR;
  process.env.GHL_MCP_CACHE_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GHL_MCP_CACHE_DIR;
  else process.env.GHL_MCP_CACHE_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

test('getCacheDir reflects GHL_MCP_CACHE_DIR env override', () => {
  assert.equal(cache.getCacheDir(), tmpDir);
});

test('write then read round-trips JSON', async () => {
  const sample = {
    id: 'wf-abc123',
    name: 'Sample workflow',
    triggers: [{ type: 'CONTACT_CREATED' }],
    actions: [{ type: 'send_email', config: { subject: 'hi' } }],
  };
  await cache.write('wf-abc123', sample);
  const got = await cache.read('wf-abc123');
  assert.deepEqual(got, sample);
});

test('read returns null on cache miss', async () => {
  const got = await cache.read('does-not-exist');
  assert.equal(got, null);
});

test('exists returns false on miss, true after write', async () => {
  assert.equal(await cache.exists('wf-xyz'), false);
  await cache.write('wf-xyz', { id: 'wf-xyz' });
  assert.equal(await cache.exists('wf-xyz'), true);
});

test('write overwrites prior content atomically', async () => {
  await cache.write('wf-overwrite', { v: 1 });
  await cache.write('wf-overwrite', { v: 2 });
  const got = await cache.read('wf-overwrite');
  assert.deepEqual(got, { v: 2 });

  // Atomic-write integrity: no .tmp sibling left after rename.
  const entries = readdirSync(tmpDir);
  const tmpLeftovers = entries.filter((e) => e.endsWith('.tmp'));
  assert.deepEqual(tmpLeftovers, [], 'no .tmp files should remain after rename');
});

test('rejects path-traversal workflowId (..)', async () => {
  await assert.rejects(() => cache.write('../evil', { hack: true }), /Invalid workflowId/);
});

test('rejects workflowId with slash', async () => {
  await assert.rejects(() => cache.write('a/b', {}), /Invalid workflowId/);
});

test('creates cache directory on first write', async () => {
  const nested = join(tmpDir, 'nested', 'deep');
  process.env.GHL_MCP_CACHE_DIR = nested;
  assert.equal(existsSync(nested), false, 'precondition: nested dir absent');
  await cache.write('wf-mkdir', { ok: true });
  assert.equal(existsSync(nested), true, 'mkdir recursive should create nested dirs');
  // And the file lives where we expect it:
  const onDisk = readFileSync(join(nested, 'wf-mkdir.json'), 'utf8');
  assert.deepEqual(JSON.parse(onDisk), { ok: true });
});
