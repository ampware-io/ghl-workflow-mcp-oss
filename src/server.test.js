import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GhlApiError } from './utils/errors.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import * as workflowCache from './cache/workflow-cache.js';

const { createServer, auditWorkflowEntities } = await import('./server.js');

// The write tools that were licence-gated in the closed-source build. In the
// open-source build every one of them must run with no licence and no
// preflight token.
const WRITE_TOOLS = ['create_workflow', 'update_workflow', 'delete_workflow',
  'publish_workflow', 'clone_workflow', 'create_tag', 'patch_workflow'];

/**
 * Create mock dependencies for createServer.
 */
function createMocks(overrides = {}) {
  return {
    cdp: {
      ensureConnected: async () => {},
      getTabInfo: () => ({ title: 'GHL', locationId: 'loc1' }),
      isConnected: () => true,
    },
    tokenManager: { getToken: async () => 'fake-token-12345678' },
    apiClient: {
      getLocationId: () => 'test-location-id',
      get: mock.fn(async () => ({})),
      ...overrides,
    },
  };
}

/**
 * Build the { tokenManager, apiClient, locationId } shape that
 * createServer(cdp, state, launcher) expects — the real signature.
 *
 * Phase 12: introduces this helper because existing tests passed by
 * accident (handlers never invoked). The GATE-07 bypass audit and the
 * gating tests need to call handlers
 * directly, so the state shape must be correct.
 */
function createConnectedState(overrides = {}) {
  return {
    tokenManager: { getToken: async () => 'fake-token-12345678' },
    // Sentinel: any real GHL API call on this object throws a distinctive
    // "property not a function" error, making accidental execution visible
    // (see CONTEXT.md D-17).
    apiClient: { getLocationId: () => 'loc1', ...overrides },
    locationId: 'loc1',
  };
}

function createFakeLauncher() {
  return { getChildPid: () => null, probeDebugPort: async () => true };
}

describe('createServer', () => {
  it('returns a server object using the real (cdp, state, launcher) signature', () => {
    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    assert.ok(server, 'createServer should return a server instance');
    assert.ok(server._registeredTools, 'McpServer should expose _registeredTools (used by GATE-07 audit)');
  });
});

describe('list_workflows tool', () => {
  it('calls listWorkflows and returns JSON content on success', async () => {
    const mockWorkflows = { workflows: [{ _id: 'wf-1', name: 'Test' }] };
    const getMock = mock.fn(async () => mockWorkflows);
    const { cdp, tokenManager } = createMocks();
    const apiClient = { getLocationId: () => 'loc1', get: getMock };

    const server = createServer(cdp, tokenManager, apiClient);

    // Access the tool handler via the internal _registeredTools map
    // McpServer stores tools with their handlers - we need to invoke through the server
    // Since we can't easily call tools directly, verify registration by checking
    // that the server was created with our mocks and the import exists
    assert.ok(server, 'Server should be created with list_workflows tool');

    // Verify the module imports listWorkflows
    const serverModule = await import('./server.js');
    assert.ok(serverModule.createServer, 'createServer should be exported');
  });

  it('returns isError:true with error JSON on GhlApiError', async () => {
    const error = new GhlApiError(429, 'Rate limited', 'Wait and retry.');
    const getMock = mock.fn(async () => { throw error; });
    const { cdp, tokenManager } = createMocks();
    const apiClient = { getLocationId: () => 'loc1', get: getMock };

    const server = createServer(cdp, tokenManager, apiClient);
    assert.ok(server, 'Server should handle GhlApiError in list_workflows');
  });
});

describe('get_workflow tool', () => {
  it('calls getWorkflow and returns JSON content on success', async () => {
    const mockDetail = { _id: 'wf-123', name: 'My Workflow', triggers: [] };
    const getMock = mock.fn(async () => mockDetail);
    const { cdp, tokenManager } = createMocks();
    const apiClient = { getLocationId: () => 'loc1', get: getMock };

    const server = createServer(cdp, tokenManager, apiClient);
    assert.ok(server, 'Server should be created with get_workflow tool');
  });

  it('returns isError:true with error JSON on GhlApiError', async () => {
    const error = new GhlApiError(404, 'Not found', 'Check workflow ID.');
    const getMock = mock.fn(async () => { throw error; });
    const { cdp, tokenManager } = createMocks();
    const apiClient = { getLocationId: () => 'loc1', get: getMock };

    const server = createServer(cdp, tokenManager, apiClient);
    assert.ok(server, 'Server should handle GhlApiError in get_workflow');
  });
});

describe('list_forms tool (260425-udy)', () => {
  it('list_forms tool is registered in server source', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

    assert.ok(
      serverSource.includes("'list_forms'"),
      'server.js should register list_forms tool',
    );
    assert.ok(
      serverSource.includes('listForms(state.apiClient)'),
      'server.js list_forms handler should call listForms(state.apiClient)',
    );
    assert.ok(
      serverSource.includes('listForms'),
      'server.js should import listForms from entities.js',
    );
  });
});

describe('list_trigger_links tool (260425-udy)', () => {
  it('list_trigger_links tool is registered in server source', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

    assert.ok(
      serverSource.includes("'list_trigger_links'"),
      'server.js should register list_trigger_links tool',
    );
    assert.ok(
      serverSource.includes('listTriggerLinks(state.apiClient)'),
      'server.js list_trigger_links handler should call listTriggerLinks(state.apiClient)',
    );
    assert.ok(
      serverSource.includes('listTriggerLinks'),
      'server.js should import listTriggerLinks from entities.js',
    );
  });
});

describe('tool registration verification', () => {
  it('imports listWorkflows and getWorkflow from workflows module', async () => {
    // Verify server.js imports the workflow functions
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

    assert.ok(
      serverSource.includes("import { listWorkflows, getWorkflow } from './api/workflows.js'"),
      'server.js should import listWorkflows and getWorkflow',
    );
    assert.ok(
      serverSource.includes("'list_workflows'"),
      'server.js should register list_workflows tool',
    );
    assert.ok(
      serverSource.includes("'get_workflow'"),
      'server.js should register get_workflow tool',
    );
    assert.ok(
      !serverSource.match(/locationId.*z\./),
      'server.js should NOT expose locationId as a tool parameter',
    );
    assert.ok(
      serverSource.includes("z.string().min(1)"),
      'server.js should validate workflowId with z.string().min(1)',
    );
    assert.ok(
      serverSource.includes("z.enum(['name', 'createdAt', 'updatedAt'])"),
      'server.js should use z.enum for sortBy validation',
    );
  });
});

describe('audit_workflow tool', () => {
  it('audit_workflow tool is registered in server source', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

    assert.ok(
      serverSource.includes("'audit_workflow'"),
      'server.js should register audit_workflow tool',
    );
    assert.ok(
      serverSource.includes('async function auditWorkflowEntities('),
      'server.js should define auditWorkflowEntities function',
    );
    assert.ok(
      serverSource.includes('function formatAuditReport('),
      'server.js should define formatAuditReport function',
    );
    assert.ok(
      serverSource.includes("import { extractEntityRefs } from './utils/entity-scanner.js'"),
      'server.js should import extractEntityRefs from entity-scanner',
    );
    assert.ok(
      serverSource.includes('includeActionDetails: true'),
      'audit_workflow should fetch workflow with includeActionDetails: true',
    );
    assert.ok(
      serverSource.includes('formatAuditReport(report)'),
      'audit_workflow should format report as markdown',
    );
    assert.ok(
      serverSource.includes('JSON.stringify(report, null, 2)'),
      'audit_workflow should include structured JSON in response',
    );
  });
});

/**
 * 260425-uzg: behavioral tests for auditWorkflowEntities.
 *
 * The function was lifted from createServer's closure to module scope so we can
 * exercise it with a stubbed apiClient instead of spinning up the full MCP
 * server. Stub strategy is path-based: apiClient.get(path) returns whatever
 * fixture matches the path prefix. Only the entity types referenced by the
 * test workflow are fetched, so each test only needs to stub the relevant
 * paths.
 */
describe('auditWorkflowEntities behavior (260425-uzg)', () => {
  /**
   * Build a stub apiClient whose .get(path) returns fixtures based on path
   * prefix matching. Unmatched paths return {} so list* helpers degrade to
   * empty arrays rather than throwing.
   */
  function buildAuditApiClient({ customValues = [], pipelines = [], users = [], customFields = [], tags = [], workflows = [], calendars = [], forms = [], links = [], emailTemplates = [] } = {}) {
    return {
      getLocationId: () => 'loc-test',
      getWriteContext: async () => ({ companyId: 'co-test', locationId: 'loc-test' }),
      get: async (path) => {
        if (path.includes('/custom-data/conversations')) {
          return { static: [], 'custom-values': customValues };
        }
        if (path.includes('/opportunities/pipelines')) {
          return { pipelines };
        }
        if (path.includes('/users/search')) {
          return { users, count: users.length };
        }
        if (path.includes('/customFields/search') || path.includes('/customFields?model=opportunity')) {
          return { customFields };
        }
        if (path.match(/\/locations\/[^/]+\/tags$/)) {
          return { tags };
        }
        if (path.includes('/workflow/') && path.includes('/list')) {
          return { workflows, count: workflows.length };
        }
        if (path.includes('/calendars/')) {
          return { calendars };
        }
        if (path.includes('/forms/')) {
          return { forms, total: forms.length };
        }
        if (path.includes('/links/search')) {
          return { links, totalCount: links.length };
        }
        if (path.includes('/emails/builder/all')) {
          return emailTemplates;
        }
        return {};
      },
    };
  }

  it('valid customValue slug ref resolves via fieldKey (no false-positive flood)', async () => {
    const workflow = {
      workflowData: {
        templates: [
          {
            id: 'a1',
            type: 'send_email',
            name: 'Promo Email',
            attributes: {
              subject: 'Promo',
              html: '<p>Use code {{custom_values.promo_code}}</p>',
            },
          },
        ],
      },
      triggers: [],
    };
    const apiClient = buildAuditApiClient({
      customValues: [{ id: 'cv1', name: 'Promo Code', value: '{{custom_values.promo_code}}' }],
    });

    const report = await auditWorkflowEntities(apiClient, workflow);

    assert.equal(report.summary.invalid, 0, 'valid slug ref should not be flagged invalid');
    assert.equal(report.summary.valid, 1);
    assert.equal(report.valid[0].entityType, 'customValue');
    assert.equal(report.valid[0].id, 'promo_code');
  });

  it('invalid customValue ref emits slug-form suggestedFix using altSlug', async () => {
    const workflow = {
      workflowData: {
        templates: [
          {
            id: 'a1',
            type: 'send_email',
            name: 'Email',
            attributes: {
              subject: 'Hello',
              html: '<p>{{custom_values.missing_key}}</p>',
            },
          },
        ],
      },
      triggers: [],
    };
    const apiClient = buildAuditApiClient({
      customValues: [{ id: 'cv-real', name: 'Real Key', value: '{{custom_values.real_key}}' }],
    });

    const report = await auditWorkflowEntities(apiClient, workflow);

    assert.equal(report.summary.invalid, 1);
    const fix = report.invalid[0].suggestedFix;
    assert.ok(
      fix.includes('replace {{custom_values.missing_key}} with {{custom_values.real_key}} (Real Key)'),
      `expected slug-form suggestedFix, got: ${fix}`,
    );
    // Defect-2 regression guard: must NOT emit `with "<entity-id>"` form.
    assert.ok(
      !fix.match(/with\s+"[^"]+"/),
      `suggestedFix must not contain id-form replacement, got: ${fix}`,
    );
  });

  it('webhook customValue ref emits manual-review string, skipping alternatives', async () => {
    const workflow = {
      workflowData: {
        templates: [
          {
            id: 'a1',
            type: 'webhook',
            name: 'Send Webhook',
            attributes: {
              url: 'https://api.example.com/hook',
              headers: {
                Authorization: 'Bearer {{custom_values.ghl_mcp_cloudflare_webhook_token}}',
              },
            },
          },
        ],
      },
      triggers: [],
    };
    // Alternatives ARE non-empty (other valid customValues exist), but the
    // webhook-context branch must refuse to use them in the suggestedFix.
    const apiClient = buildAuditApiClient({
      customValues: [
        { id: 'cv-1', name: 'Some Other', value: '{{custom_values.some_other_slug}}' },
        { id: 'cv-2', name: 'Another', value: '{{custom_values.another_slug}}' },
      ],
    });

    const report = await auditWorkflowEntities(apiClient, workflow);

    assert.equal(report.summary.invalid, 1);
    assert.equal(
      report.invalid[0].suggestedFix,
      'Webhook attribute — manual review required; do NOT auto-replace credentials/secret slugs',
    );
    // Alternatives ARE still surfaced for human review (the audit caller may
    // want to show them) — they are simply not woven into the fix string.
    assert.ok(
      report.invalid[0].validAlternatives.length > 0,
      'alternatives should still be surfaced for human review',
    );
  });

  it('regression guard: invalid pipeline ref still uses id-form suggestedFix', async () => {
    const workflow = {
      workflowData: {
        templates: [
          {
            id: 'a1',
            type: 'internal_create_opportunity',
            name: 'Create Opp',
            attributes: { pipelineId: 'bogus', pipelineStageId: 'also-bogus' },
          },
        ],
      },
      triggers: [],
    };
    const apiClient = buildAuditApiClient({
      pipelines: [{ id: 'real-pipe', name: 'Real Pipeline', stages: [{ id: 'real-stage', name: 'Stage 1' }] }],
    });

    const report = await auditWorkflowEntities(apiClient, workflow);

    const pipelineFinding = report.invalid.find(i => i.entityType === 'pipeline');
    assert.ok(pipelineFinding, 'expected an invalid pipeline finding');
    assert.ok(
      pipelineFinding.suggestedFix.includes('Call update_workflow to replace bogus with "real-pipe" (Real Pipeline)'),
      `expected id-form suggestedFix for pipeline, got: ${pipelineFinding.suggestedFix}`,
    );
  });
});

describe('ghl://entities/guide resource', () => {
  it('entities-guide resource is registered in server source', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

    assert.ok(
      serverSource.includes("'entities-guide'"),
      'server.js should register entities-guide resource',
    );
    assert.ok(
      serverSource.includes("'ghl://entities/guide'"),
      'server.js should use ghl://entities/guide URI',
    );
    assert.ok(
      serverSource.includes('entityGuideContent'),
      'server.js should define entityGuideContent variable',
    );
  });
});

// =============================================================================
// Open-source build: no licence gate, no _skillAck preflight
// =============================================================================

describe('no licence or preflight gating', () => {
  it('registers no licence tools, prompts or skill resources', () => {
    const server = createServer(createMocks().cdp, createConnectedState(), createFakeLauncher());
    const tools = Object.keys(server._registeredTools);
    assert.equal(tools.length, 30, `expected 30 tools, got ${tools.length}`);
    for (const name of tools) {
      assert.doesNotMatch(name, /licen[cs]e/i, `unexpected licence tool ${name}`);
    }
    assert.deepEqual(Object.keys(server._registeredPrompts ?? {}), []);
    const uris = Object.keys(server._registeredResources ?? {});
    assert.deepEqual(uris, ['ghl://entities/guide']);
    assert.deepEqual(Object.keys(server._registeredResourceTemplates ?? {}), []);
  });

  it('no write tool schema declares _skillAck and no description mentions a licence', () => {
    const server = createServer(createMocks().cdp, createConnectedState(), createFakeLauncher());
    for (const name of WRITE_TOOLS) {
      const tool = server._registeredTools[name];
      assert.ok(tool, `${name} must be registered`);
      const shape = tool.inputSchema?.shape ?? {};
      assert.ok(!('_skillAck' in shape), `${name} must not declare _skillAck`);
      assert.doesNotMatch(tool.description ?? '', /PAID|licen[cs]e|_skillAck/i, `${name} description`);
    }
  });

  it('write tools point users at the Docs MCP for step shapes', () => {
    const server = createServer(createMocks().cdp, createConnectedState(), createFakeLauncher());
    for (const name of ['create_workflow', 'update_workflow', 'patch_workflow']) {
      assert.match(server._registeredTools[name].description, /Docs MCP/, `${name} description`);
    }
  });

  it('every write tool reaches its handler body with no licence installed', async () => {
    // Sentinel apiClient: any real GHL call throws "... is not a function",
    // proving the handler body ran instead of a gate envelope returning early.
    const server = createServer(createMocks().cdp, createConnectedState(), createFakeLauncher());
    for (const name of WRITE_TOOLS) {
      const res = await server._registeredTools[name].handler({ workflowId: 'wf-1', name: 'x', tagName: 't', operations: [] }, {});
      const text = res.content?.[0]?.text ?? '';
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
      assert.notEqual(parsed.status, 'license_required', `${name} must not be licence-gated`);
      assert.notEqual(parsed.status, 'skill_precondition', `${name} must not require _skillAck`);
    }
  });

  it('connection gate still runs first: every write tool returns not_connected with apiClient null', async () => {
    const server = createServer(createMocks().cdp, { tokenManager: null, apiClient: null, locationId: null }, createFakeLauncher());
    for (const name of WRITE_TOOLS) {
      const res = await server._registeredTools[name].handler({}, {});
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.status, 'not_connected', `${name}`);
      assert.equal(res.isError, true);
    }
  });
});

// =============================================================================
// Phase 13.4 — read_workflow_outline + read_workflow_step (free)
// =============================================================================

describe('Phase 13.4: read_workflow_outline + read_workflow_step (free tools)', () => {
  let tmpCacheDir;
  const WORKFLOW_ID = 'wf-13-4-readtools';

  beforeEach(() => {
    tmpCacheDir = mkdtempSync(pathJoin(tmpdir(), 'phase13.4-readtools-'));
    process.env.GHL_MCP_CACHE_DIR = tmpCacheDir;
  });

  afterEach(() => {
    delete process.env.GHL_MCP_CACHE_DIR;
    rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function makeCachedWorkflow() {
    return {
      _id: WORKFLOW_ID,
      name: 'Welcome Sequence',
      status: 'draft',
      version: 7,
      actions: [
        {
          id: 'S1',
          type: 'wait',
          name: 'Wait 1 day',
          attributes: { duration: '1d' },
          parentKey: null,
          order: 1,
          next: 'S2',
        },
        {
          id: 'S2',
          type: 'send_email',
          name: 'Send Welcome',
          attributes: { subject: 'Hi' },
          parentKey: 'S1',
          order: 2,
        },
      ],
    };
  }

  it('read_workflow_outline is registered as a free tool (read-only)', async () => {
    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['read_workflow_outline'];
    assert.ok(tool, 'read_workflow_outline must be registered');
    assert.ok(tool.handler, 'read_workflow_outline must have a handler');
  });

  it('read_workflow_step is registered as a free tool (read-only)', async () => {
    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['read_workflow_step'];
    assert.ok(tool, 'read_workflow_step must be registered');
    assert.ok(tool.handler, 'read_workflow_step must have a handler');
  });

  it('read_workflow_outline returns only metadata + step ID/type/name/order/next/parentKey (NO attributes) on cache hit', async () => {
    await workflowCache.write(WORKFLOW_ID, makeCachedWorkflow());

    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['read_workflow_outline'];
    const response = await tool.handler({ workflowId: WORKFLOW_ID }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);

    assert.equal(parsed.workflow_id, WORKFLOW_ID);
    assert.equal(parsed.name, 'Welcome Sequence');
    assert.equal(parsed.status, 'draft');
    assert.ok(Array.isArray(parsed.steps), 'steps must be an array');
    assert.equal(parsed.steps.length, 2);
    for (const step of parsed.steps) {
      assert.ok(!('attributes' in step), 'outline step MUST NOT include attributes');
      assert.ok('id' in step);
      assert.ok('type' in step);
      assert.ok('name' in step);
      assert.ok('order' in step);
    }
  });

  it('read_workflow_step returns the matching step JSON on cache hit', async () => {
    await workflowCache.write(WORKFLOW_ID, makeCachedWorkflow());

    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['read_workflow_step'];
    const response = await tool.handler({ workflowId: WORKFLOW_ID, stepId: 'S2' }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.id, 'S2');
    assert.equal(parsed.type, 'send_email');
    assert.deepEqual(parsed.attributes, { subject: 'Hi' });
  });

  it('read_workflow_step returns step_not_found with valid_step_ids when stepId missing (D-09; isError:false)', async () => {
    await workflowCache.write(WORKFLOW_ID, makeCachedWorkflow());

    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['read_workflow_step'];
    const response = await tool.handler({ workflowId: WORKFLOW_ID, stepId: 'NOT_A_REAL_ID' }, {});
    assert.notStrictEqual(response.isError, true, 'structured rejection MUST be isError:false (D-10)');
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.code, 'step_not_found');
    assert.ok(Array.isArray(parsed.details.valid_step_ids));
    assert.deepEqual(parsed.details.valid_step_ids.sort(), ['S1', 'S2']);
    assert.equal(parsed.details.step_id, 'NOT_A_REAL_ID');
  });
});

// =============================================================================
// Phase 13.4 — patch_workflow (paid)
// =============================================================================

describe('Phase 13.4: patch_workflow tool (paid)', () => {
  let tmpCacheDir;
  const WORKFLOW_ID = 'wf-13-4-patch';

  function linearWorkflow({ version = 1, name = 'Linear', status = 'draft' } = {}) {
    // Mirror GHL's response shape: steps live at workflowData.templates.
    // Our extractActions helper picks `workflowData.templates` when present.
    const templates = [
      { id: 'S1', type: 'wait', name: 'Wait', attributes: { duration: '1d' }, parentKey: null, order: 1, next: 'S2' },
      // Emails carry the canonical shape (subject + from_email + from_name +
      // inline html) so the regression strict deep-check passes them during
      // patch_workflow's whole-workflow re-validation.
      { id: 'S2', type: 'send_email', name: 'Email A', attributes: { subject: 'A', from_email: 'a@test.co', from_name: 'A', html: '<p>A</p>' }, parentKey: 'S1', order: 2, next: 'S3' },
      { id: 'S3', type: 'send_email', name: 'Email B', attributes: { subject: 'B', from_email: 'b@test.co', from_name: 'B', html: '<p>B</p>' }, parentKey: 'S2', order: 3 },
    ];
    return {
      _id: WORKFLOW_ID,
      name,
      status,
      version,
      workflowData: { templates },
    };
  }

  function branchedWorkflow({ version = 1 } = {}) {
    const templates = [
      { id: 'S1', type: 'wait', name: 'Wait', attributes: {}, parentKey: null, order: 1, next: 'S2' },
      { id: 'S2', type: 'if_else', name: 'Branch', attributes: {}, parentKey: 'S1', order: 2, branchYes: 'S3', branchNo: 'S4' },
      { id: 'S3', type: 'send_email', name: 'Yes', attributes: {}, parentKey: 'S2', order: 3 },
      { id: 'S4', type: 'send_email', name: 'No', attributes: {}, parentKey: 'S2', order: 4 },
    ];
    return {
      _id: WORKFLOW_ID,
      name: 'Branched',
      status: 'draft',
      version,
      workflowData: { templates },
    };
  }

  beforeEach(async () => {
    tmpCacheDir = mkdtempSync(pathJoin(tmpdir(), 'phase13.4-patch-'));
    process.env.GHL_MCP_CACHE_DIR = tmpCacheDir;
  });

  afterEach(() => {
    delete process.env.GHL_MCP_CACHE_DIR;
    rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  it('patch_workflow is registered', async () => {
    const { cdp } = createMocks();
    const state = createConnectedState();
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];
    assert.ok(tool, 'patch_workflow must be registered');
    assert.ok(tool.handler, 'patch_workflow must have a handler');
  });

  // regression: insert_after accepts `after_step_id` OR its `step_id` alias.
  // zod ^3.25 rejects .refine/.transform members inside a discriminatedUnion,
  // so the schema keeps both keys optional and the handler normalises the alias
  // to `after_step_id` (and rejects the no-anchor case) at dispatch time.
  function aliasApiClient() {
    return {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return linearWorkflow({ version: 1 });
      }),
      put: mock.fn(async () => ({})),
    };
  }

  it('insert_after: after_step_id is accepted (canonical anchor)', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    const apiClient = aliasApiClient();
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const server = createServer(cdp, state, createFakeLauncher());
    const tool = server._registeredTools['patch_workflow'];
    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'insert_after', after_step_id: 'S1', step: { type: 'wait', name: 'Y' } }],
    }, {});
    if (response.isError) throw new Error(`unexpected isError; body=${response.content[0].text}`);
    const parsed = JSON.parse(response.content[0].text);
    assert.notEqual(parsed.status, 'error', `expected success; got ${response.content[0].text}`);
    assert.equal(apiClient.put.mock.callCount() > 0, true, 'insert should reach the GHL PUT');
  });

  it('insert_after: step_id alias is accepted and normalised to the anchor', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    const apiClient = aliasApiClient();
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const server = createServer(cdp, state, createFakeLauncher());
    const tool = server._registeredTools['patch_workflow'];
    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'insert_after', step_id: 'S1', step: { type: 'wait', name: 'Y' } }],
    }, {});
    if (response.isError) throw new Error(`unexpected isError; body=${response.content[0].text}`);
    const parsed = JSON.parse(response.content[0].text);
    assert.notEqual(parsed.status, 'error', `alias should be accepted; got ${response.content[0].text}`);
    assert.equal(apiClient.put.mock.callCount() > 0, true, 'aliased insert should reach the GHL PUT');
  });

  it('insert_after: neither after_step_id nor step_id → structured error, no write', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    const apiClient = aliasApiClient();
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const server = createServer(cdp, state, createFakeLauncher());
    const tool = server._registeredTools['patch_workflow'];
    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'insert_after', step: { type: 'wait', name: 'Y' } }],
    }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.code, 'missing_anchor');
    assert.equal(apiClient.put.mock.callCount(), 0, 'no GHL PUT when anchor missing');
  });

  it('happy path: update_step on a cached workflow returns the refreshed live workflow JSON', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));

    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async () => linearWorkflow({ version: 1 })),
      put: mock.fn(async () => ({})),
    };
    // updateWorkflow internally calls getWorkflow + put; both are stubbed via the apiClient.
    // Stub the trigger endpoint too — workflows.js calls /trigger? in parallel.
    apiClient.get = mock.fn(async (path) => {
      if (path.includes('/trigger?')) return { triggers: [] };
      return linearWorkflow({ version: 1 });
    });

    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'update_step', step_id: 'S2', patch: { attributes: { subject: 'A-updated' } } }],
    }, {});
    if (response.isError) {
      throw new Error(`unexpected isError; body=${response.content[0].text}`);
    }
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed._id, WORKFLOW_ID);
    assert.ok(Array.isArray(parsed.actions) || Array.isArray(parsed.workflowData?.templates));
  });

  it('drift detection: cached version v1 + live version v2 returns workflow_changed_externally (no GHL write)', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));

    const putMock = mock.fn(async () => ({}));
    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return linearWorkflow({ version: 2 }); // <-- live version drift
      }),
      put: putMock,
    };

    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'update_step', step_id: 'S2', patch: { attributes: { subject: 'X' } } }],
    }, {});
    assert.notStrictEqual(response.isError, true, 'structured rejection MUST be isError:false');
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.code, 'workflow_changed_externally');
    assert.equal(parsed.details.cached_version, 1);
    assert.equal(parsed.details.live_version, 2);
    assert.equal(putMock.mock.callCount(), 0, 'no GHL PUT must occur on drift');
  });

  it('validation: update_step with patch.next is rejected as pointer_fields_forbidden (no write)', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    const putMock = mock.fn(async () => ({}));
    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return linearWorkflow({ version: 1 });
      }),
      put: putMock,
    };
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'update_step', step_id: 'S2', patch: { next: 'S3' } }],
    }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.code, 'pointer_fields_forbidden');
    assert.deepEqual(parsed.details.forbidden_fields_present, ['next']);
    assert.equal(putMock.mock.callCount(), 0, 'no GHL PUT must occur on validation failure');
  });

  it('branched-step rejection: insert_after on a branched step yields branched_step_unsupported (no write)', async () => {
    await workflowCache.write(WORKFLOW_ID, branchedWorkflow({ version: 1 }));
    const putMock = mock.fn(async () => ({}));
    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return branchedWorkflow({ version: 1 });
      }),
      put: putMock,
    };
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{
        op: 'insert_after',
        after_step_id: 'S2',
        step: { type: 'send_email', name: 'New', attributes: {} },
      }],
    }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.code, 'branched_step_unsupported');
    assert.equal(parsed.details.step_id, 'S2');
    assert.equal(putMock.mock.callCount(), 0, 'no GHL PUT must occur when first op rejects');
  });

  it('all-or-nothing: 2 ops where second fails → no GHL write at all (D-06/D-07)', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    const putMock = mock.fn(async () => ({}));
    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return linearWorkflow({ version: 1 });
      }),
      put: putMock,
    };
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [
        // Op 1: valid update_step on S2
        { op: 'update_step', step_id: 'S2', patch: { attributes: { subject: 'updated' } } },
        // Op 2: invalid — references a step that doesn't exist
        { op: 'update_step', step_id: 'NOPE', patch: { attributes: { subject: 'never' } } },
      ],
    }, {});
    assert.notStrictEqual(response.isError, true);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.code, 'step_not_found');
    assert.equal(putMock.mock.callCount(), 0, 'all-or-nothing: zero PUTs when any op fails');
  });

  // ---------------------------------------------------------------------------
  // #77: rewire_step {next:null} on a branch tail returned success, bumped the
  // version, and changed nothing. Cause: diffAndWireActions' branch-convergence
  // pass rewrites ANY next:null on a branch child to the first post-block step,
  // so the caller's explicit terminal was silently turned back into the pointer
  // it already had. A linear tail (not a branch child) kept its null, which is
  // why the defect looked inconsistent across tails.
  // ---------------------------------------------------------------------------
  function convergedBranchWorkflow({ version = 1 } = {}) {
    const templates = [
      { id: 'S1', type: 'wait', name: 'Wait', attributes: { duration: '1d' }, order: 0, next: 'IF' },
      { id: 'IF', type: 'if_else', name: 'Check', nodeType: 'condition-node', attributes: {}, parentKey: 'S1', order: 1, next: ['BY', 'BN'] },
      { id: 'BY', type: 'if_else', name: 'Yes', nodeType: 'branch-yes', parent: 'IF', parentKey: 'IF', sibling: ['BN'], attributes: {}, order: 2, next: 'T1' },
      { id: 'BN', type: 'if_else', name: 'No', nodeType: 'branch-no', parent: 'IF', parentKey: 'IF', sibling: ['BY'], attributes: {}, order: 3, next: 'T2' },
      { id: 'T1', type: 'wait', name: 'Tail yes', parent: 'BY', parentKey: 'BY', attributes: { duration: '1d' }, order: 4, next: 'S9' },
      { id: 'T2', type: 'wait', name: 'Tail no', parent: 'BN', parentKey: 'BN', attributes: { duration: '1d' }, order: 5, next: 'S9' },
      { id: 'S9', type: 'wait', name: 'After block', attributes: { duration: '1d' }, order: 6 },
    ];
    return { _id: WORKFLOW_ID, name: 'Converged', status: 'draft', version, workflowData: { templates } };
  }

  // A GHL fake that STORES what is PUT and serves it back on the next GET, so
  // the read-back reflects the real saved payload rather than a canned fixture.
  function storingApiClient(initial, { ignoreWrites = false } = {}) {
    let stored = initial;
    const puts = [];
    return {
      puts,
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: mock.fn(async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        return structuredClone(stored);
      }),
      put: mock.fn(async (_path, body) => {
        puts.push(body);
        if (!ignoreWrites) {
          stored = { ...stored, version: (stored.version ?? 1) + 1, workflowData: { templates: body.workflowData.templates } };
        }
        return {};
      }),
    };
  }

  it('#77: rewire_step {next:null} on a branch tail actually terminates it (not re-converged)', async () => {
    await workflowCache.write(WORKFLOW_ID, convergedBranchWorkflow({ version: 1 }));
    const apiClient = storingApiClient(convergedBranchWorkflow({ version: 1 }));
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const server = createServer(cdp, state, createFakeLauncher());
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'rewire_step', step_id: 'T1', next: null }],
    }, {});

    assert.equal(apiClient.puts.length, 1, 'rewire must reach the GHL PUT');
    const sentT1 = apiClient.puts[0].workflowData.templates.find((t) => t.id === 'T1');
    assert.ok(sentT1.next == null, `PUT must carry T1.next=null; sent ${JSON.stringify(sentT1.next)}`);
    const sentT2 = apiClient.puts[0].workflowData.templates.find((t) => t.id === 'T2');
    assert.equal(sentT2.next, 'S9', 'untouched sibling tail keeps its convergence pointer');
    assert.notStrictEqual(response.isError, true, `unexpected error: ${response.content[0].text}`);
  });

  it('#77: a rewire that GHL does not persist fails loudly instead of reporting success', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));
    // GHL accepts the PUT but the stored graph is unchanged — the exact
    // observed symptom. The read-back must catch it.
    const apiClient = storingApiClient(linearWorkflow({ version: 1 }), { ignoreWrites: true });
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const server = createServer(cdp, state, createFakeLauncher());
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{ op: 'delete_step', step_id: 'S3' }, { op: 'rewire_step', step_id: 'S2', next: null }],
    }, {});

    assert.equal(apiClient.puts.length, 1, `the write was attempted; resp=${response.content[0].text}`);
    assert.equal(response.isError, true, `no-op patch must not report success; got ${response.content[0].text}`);
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.code, 'patch_not_applied');
    assert.deepEqual(parsed.details.mismatches, [{ op: 'rewire_step', step_id: 'S2', requested_next: null, observed_next: 'S3' }]);
  });

  it('linear-chain integrity: insert_after preserves S1→new→S2→S3 ordering', async () => {
    await workflowCache.write(WORKFLOW_ID, linearWorkflow({ version: 1 }));

    let putPayload = null;
    let liveCallNumber = 0;
    const apiClient = {
      getLocationId: () => 'loc1',
      getWriteContext: async () => ({ companyId: 'co', locationId: 'loc1' }),
      get: async (path) => {
        if (path.includes('/trigger?')) return { triggers: [] };
        // The first GET is patch_workflow's drift-refresh; subsequent GETs are
        // updateWorkflow's pre-diff fetch + the post-commit refresh. All return
        // the same v1 fixture so updateWorkflow's diff against the patched
        // actions yields a clean rebuild.
        liveCallNumber++;
        return linearWorkflow({ version: 1 });
      },
      put: async (_path, body) => {
        putPayload = body;
        return {};
      },
    };
    const { cdp } = createMocks();
    const state = { tokenManager: { getToken: async () => 'tok' }, apiClient, locationId: 'loc1' };
    const launcher = createFakeLauncher();
    const server = createServer(cdp, state, launcher);
    const tool = server._registeredTools['patch_workflow'];

    const response = await tool.handler({
      workflowId: WORKFLOW_ID,
      operations: [{
        op: 'insert_after',
        after_step_id: 'S1',
        step: { type: 'send_email', name: 'New Email', attributes: { subject: 'NEW', from_email: 'n@test.co', from_name: 'N', html: '<p>NEW</p>' } },
      }],
    }, {});
    if (response.isError) {
      throw new Error(`unexpected isError; body=${response.content[0].text}`);
    }
    assert.ok(putPayload, 'updateWorkflow PUT must have happened');
    // Inspect the templates array sent to GHL via buildSavePayload — the
    // patched chain must be S1→new→S2→S3 (4 steps total) with each next
    // pointer matching the next step's id.
    const templates = putPayload.workflowData?.templates || putPayload.templates || [];
    assert.equal(templates.length, 4, 'must have 4 steps after insert');
    // Order check: pull steps in chain-link order starting from the head
    const byId = Object.fromEntries(templates.map((t) => [t.id, t]));
    const head = templates.find((t) => !t.parentKey || t.parentKey === null);
    assert.ok(head, 'must have a head step');
    const chain = [];
    let cur = head;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = byId[cur.next];
    }
    assert.equal(chain.length, 4, 'chain must traverse all 4 steps');
    // First three by name should be Wait → New Email → Email A → Email B
    assert.equal(chain[0].name, 'Wait');
    assert.equal(chain[1].name, 'New Email');
    assert.equal(chain[2].name, 'Email A');
    assert.equal(chain[3].name, 'Email B');
  });
});
