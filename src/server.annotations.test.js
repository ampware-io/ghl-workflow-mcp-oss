/**
 * D-07 tool annotation map tripwire (Phase 13.2; updated from Phase 13.1 D-12).
 *
 * Enumerates every tool registered on the MCP server and asserts against an
 * EXACT expected map: 17 readOnly / 9 destructive / 4 unannotated = 30 total.
 * Silent drift (a new tool added without an annotation decision) fails CI.
 *
 * Phase 13.1 expected 32 (the 27 stable tools + 5 start_*). Phase 13.2 D-05
 * deleted the 5 start_* tools; bumped to 29 by 260425-udy quick task adding
 * list_forms + list_trigger_links; bumped to 32 by 260426-l0s quick task
 * adding patch_workflow + read_workflow_outline + read_workflow_step.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline helpers — duplicated from src/server.test.js:18-56 (not exported upstream).
function createMocks() {
  return {
    cdp: {
      ensureConnected: async () => {},
      getTabInfo: () => ({ title: 'GHL', locationId: 'loc1' }),
      isConnected: () => true,
    },
  };
}
function createConnectedState() {
  return {
    tokenManager: { getToken: async () => 'fake-token-12345678' },
    apiClient: { getLocationId: () => 'loc1' },
    locationId: 'loc1',
  };
}
function createFakeLauncher() {
  return { getChildPid: () => null, probeDebugPort: async () => true };
}

const { createServer } = await import('./server.js');

// D-08 + D-09 + D-10 — EXPECTED annotation map. Sorted alphabetically for
// stable diff review. Drift-proof: if a future tool is added without
// extending this map, the tripwire below fails loudly.
const EXPECTED_READ_ONLY = new Set([
  'audit_workflow',
  'get_workflow',
  'list_associations',
  'list_business_fields',
  'list_custom_fields',
  'list_custom_values',
  'list_email_templates',
  'list_folders',
  'list_forms',
  'list_pipelines',
  'list_tags',
  'list_trigger_links',
  'list_users',
  'list_workflows',
  'read_workflow_outline',
  'read_workflow_step',
  'test_connection',
]);

const EXPECTED_DESTRUCTIVE = new Set([
  'clone_workflow',
  'create_folder',
  'create_tag',
  'create_workflow',
  'delete_folder',
  'delete_workflow',
  'patch_workflow',
  'publish_workflow',
  'update_workflow',
]);

const EXPECTED_UNANNOTATED = new Set([
  'launch_chrome',
  'move_workflow',
  'reconnect',
  'rename_folder',
]);

describe('D-07 tool annotation map (tripwire)', () => {
  it(
    'exactly 17 readOnly / 9 destructive / 4 unannotated = 30 tools',
    () => {
      const { cdp } = createMocks();
      const state = createConnectedState();
      const launcher = createFakeLauncher();
      const server = createServer(cdp, state, launcher);
      const registry = server._registeredTools;
      const all = new Set(Object.keys(registry));

      assert.strictEqual(
        all.size,
        EXPECTED_READ_ONLY.size + EXPECTED_DESTRUCTIVE.size + EXPECTED_UNANNOTATED.size,
        `Unexpected tool count — got ${all.size}, expected 30. Audit the annotations map.`,
      );

      for (const name of EXPECTED_READ_ONLY) {
        const a = registry[name]?.annotations;
        assert.strictEqual(a?.readOnlyHint, true, `${name} missing readOnlyHint:true`);
        assert.strictEqual(a?.destructiveHint, undefined, `${name} must not have destructiveHint`);
      }
      for (const name of EXPECTED_DESTRUCTIVE) {
        const a = registry[name]?.annotations;
        assert.strictEqual(a?.destructiveHint, true, `${name} missing destructiveHint:true`);
        assert.strictEqual(a?.readOnlyHint, undefined, `${name} must not have readOnlyHint`);
      }
      for (const name of EXPECTED_UNANNOTATED) {
        const a = registry[name]?.annotations;
        assert.ok(
          a?.readOnlyHint === undefined && a?.destructiveHint === undefined,
          `${name} must have neither annotation — got ${JSON.stringify(a)}`,
        );
      }
    },
  );
});
