import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractEntityRefs } = await import('./entity-scanner.js');

describe('extractEntityRefs', () => {
  describe('defensive handling', () => {
    it('returns empty array for empty object', () => {
      assert.deepEqual(extractEntityRefs({}), []);
    });

    it('returns empty array for null', () => {
      assert.deepEqual(extractEntityRefs(null), []);
    });

    it('returns empty array for undefined', () => {
      assert.deepEqual(extractEntityRefs(undefined), []);
    });

    it('returns empty array when templates and triggers are null/undefined', () => {
      assert.deepEqual(extractEntityRefs({ templates: null, triggers: undefined }), []);
    });

    it('skips actions with missing attributes gracefully', () => {
      const workflowData = {
        templates: [
          { id: 'a1', type: 'internal_create_opportunity', name: 'Create Opp', attributes: null },
          { id: 'a2', type: 'assign_to_user_tool', name: 'Assign User' },
        ],
      };
      assert.deepEqual(extractEntityRefs(workflowData), []);
    });
  });

  describe('pipeline/stage extraction', () => {
    it('extracts pipeline, stage, and user refs from internal_create_opportunity', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'internal_create_opportunity',
            name: 'Create Opportunity',
            attributes: {
              pipelineId: 'pipe-123',
              pipelineStageId: 'stage-456',
              assignedTo: 'user-789',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { entityType: 'pipeline', id: 'pipe-123', source: 'action:Create Opportunity', actionType: 'internal_create_opportunity' });
      assert.deepEqual(result[1], { entityType: 'pipelineStage', id: 'stage-456', source: 'action:Create Opportunity', actionType: 'internal_create_opportunity' });
      assert.deepEqual(result[2], { entityType: 'user', id: 'user-789', source: 'action:Create Opportunity', actionType: 'internal_create_opportunity' });
    });

    it('extracts pipeline and stage refs from internal_update_opportunity', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'internal_update_opportunity',
            name: 'Update Opportunity',
            attributes: {
              pipelineId: 'pipe-abc',
              pipelineStageId: 'stage-def',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { entityType: 'pipeline', id: 'pipe-abc', source: 'action:Update Opportunity', actionType: 'internal_update_opportunity' });
      assert.deepEqual(result[1], { entityType: 'pipelineStage', id: 'stage-def', source: 'action:Update Opportunity', actionType: 'internal_update_opportunity' });
    });
  });

  describe('create_opportunity snake_case extraction', () => {
    it('extracts pipeline, stage, and user refs from create_opportunity with snake_case fields', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'create_opportunity',
            name: 'Create Opp Snake',
            attributes: {
              pipeline_id: 'SyntheticPipeline001',
              pipeline_stage_id: '00000000-0000-4000-8000-000000000002',
              assigned_to: 'user-snake-1',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { entityType: 'pipeline', id: 'SyntheticPipeline001', source: 'action:Create Opp Snake', actionType: 'create_opportunity' });
      assert.deepEqual(result[1], { entityType: 'pipelineStage', id: '00000000-0000-4000-8000-000000000002', source: 'action:Create Opp Snake', actionType: 'create_opportunity' });
      assert.deepEqual(result[2], { entityType: 'user', id: 'user-snake-1', source: 'action:Create Opp Snake', actionType: 'create_opportunity' });
    });
  });

  describe('user extraction', () => {
    it('extracts user refs from assign_user user_list array', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'assign_user',
            name: 'Assign User Round Robin',
            attributes: {
              user_list: ['SyntheticUser0000001'],
              traffic_weightage: { 'SyntheticUser0000001': 1 },
              traffic_index: [{ id: 'SyntheticUser0000001' }],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'user', id: 'SyntheticUser0000001', source: 'action:Assign User Round Robin', actionType: 'assign_user' });
    });

    it('extracts multiple user refs from assign_user user_list', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'assign_user',
            name: 'Assign Multi',
            attributes: {
              user_list: ['user-a', 'user-b', 'user-c'],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 3);
      assert.deepEqual(result.map(r => r.id), ['user-a', 'user-b', 'user-c']);
      assert.ok(result.every(r => r.entityType === 'user'));
    });

    it('extracts user ref from assign_to_user_tool', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'assign_to_user_tool',
            name: 'Assign User',
            attributes: { userId: 'user-001' },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'user', id: 'user-001', source: 'action:Assign User', actionType: 'assign_to_user_tool' });
    });

    it('extracts user ref from task-notification', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'task-notification',
            name: 'Create Task',
            attributes: { assignedTo: 'user-002' },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'user', id: 'user-002', source: 'action:Create Task', actionType: 'task-notification' });
    });
  });

  describe('custom field extraction', () => {
    it('extracts custom field IDs from update_contact_field nested fields array', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'update_contact_field',
            name: 'Update Fields',
            attributes: {
              fields: [
                { field: 'SyntheticField000001', value: 'some value' },
                { field: 'SyntheticField000002', value: 'other value' },
              ],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { entityType: 'customField', id: 'SyntheticField000001', source: 'action:Update Fields', actionType: 'update_contact_field' });
      assert.deepEqual(result[1], { entityType: 'customField', id: 'SyntheticField000002', source: 'action:Update Fields', actionType: 'update_contact_field' });
    });

    it('skips standard contact field paths', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'update_contact_field',
            name: 'Update Standard Fields',
            attributes: {
              fields: [
                { field: 'firstName', value: 'John' },
                { field: 'lastName', value: 'Doe' },
                { field: 'email', value: 'john@example.com' },
                { field: 'phone', value: '555-0100' },
                { field: 'companyName', value: 'Acme' },
                { field: 'customField123', value: 'custom val' },
              ],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'customField', id: 'customField123', source: 'action:Update Standard Fields', actionType: 'update_contact_field' });
    });
  });

  describe('condition scanning', () => {
    it('extracts entity refs from if_else recursive conditions', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Check Stage',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'is',
                    field: 'opportunity.pipelineStageId',
                    value: 'stage-999',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'pipelineStage', id: 'stage-999', source: 'condition:Check Stage', actionType: 'if_else' });
    });

    it('extracts user refs from nested AND/OR condition groups', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Complex Check',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'OR',
                    conditions: [
                      {
                        operator: 'is',
                        field: 'task.assignedTo',
                        value: 'user-a',
                      },
                      {
                        operator: 'is',
                        field: 'task.assignedTo',
                        value: ['user-b', 'user-c'],
                      },
                    ],
                  },
                  {
                    operator: 'is',
                    field: 'contact.email',
                    value: 'test@example.com',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 3);
      const ids = result.map(r => r.id).sort();
      assert.deepEqual(ids, ['user-a', 'user-b', 'user-c']);
      assert.ok(result.every(r => r.entityType === 'user'));
    });
  });

  describe('trigger scanning', () => {
    it('extracts entity refs from trigger conditions', () => {
      const workflowData = {
        triggers: [
          {
            type: 'opportunity_status_changed',
            name: 'Opp Stage Changed',
            conditions: [
              {
                operator: 'is',
                field: 'opportunity.pipelineStageId',
                value: 'stage-trigger-1',
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'pipelineStage', id: 'stage-trigger-1', source: 'trigger:Opp Stage Changed' });
    });

    it('skips condition values of "any" (trigger wildcard)', () => {
      const workflowData = {
        triggers: [
          {
            type: 'opportunity_status_changed',
            name: 'Any Stage',
            conditions: [
              {
                operator: 'is',
                field: 'opportunity.pipelineStageId',
                value: 'any',
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 0);
    });
  });

  describe('tag extraction', () => {
    it('extracts tag refs from add_contact_tag', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'add_contact_tag',
            name: 'Add Tags',
            attributes: {
              tags: ['tag-abc', 'tag-def'],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { entityType: 'tag', id: 'tag-abc', source: 'action:Add Tags', actionType: 'add_contact_tag' });
      assert.deepEqual(result[1], { entityType: 'tag', id: 'tag-def', source: 'action:Add Tags', actionType: 'add_contact_tag' });
    });

    it('handles empty tags array gracefully', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'add_contact_tag',
            name: 'Empty Tags',
            attributes: { tags: [] },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 0);
    });
  });

  describe('calendar extraction', () => {
    it('extracts calendar refs from trigger conditions with calendar.id field', () => {
      const workflowData = {
        triggers: [
          {
            type: 'appointment_booked',
            name: 'Booking Trigger',
            conditions: [
              {
                operator: 'is',
                field: 'calendar.id',
                value: 'cal-12345',
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'calendar', id: 'cal-12345', source: 'trigger:Booking Trigger' });
    });
  });

  describe('conditionSubType custom field extraction', () => {
    it('extracts custom field ID from conditionSubType in if_else conditions', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Check Custom Field',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'is',
                    field: 'contact.custom_field',
                    conditionSubType: 'SyntheticField000001',
                    value: 'some-value',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'customField', id: 'SyntheticField000001', source: 'condition:Check Custom Field', actionType: 'if_else' });
    });

    it('does not extract standard contact fields from conditionSubType', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Check Email',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'is',
                    field: 'contact.email',
                    conditionSubType: 'email',
                    value: 'test@example.com',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 0);
    });
  });

  describe('wait action condition scanning', () => {
    it('extracts entity refs from wait action conditions', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'wait',
            name: 'Wait for Stage',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'is',
                    field: 'opportunity.pipelineStageId',
                    value: 'stage-wait-1',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'pipelineStage', id: 'stage-wait-1', source: 'condition:Wait for Stage', actionType: 'wait' });
    });

    it('extracts custom field from wait action conditionSubType', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'wait',
            name: 'Wait for Field',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    operator: 'is',
                    field: 'contact.custom_field',
                    conditionSubType: 'cf-wait-123',
                    value: 'expected',
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'customField', id: 'cf-wait-123', source: 'condition:Wait for Field', actionType: 'wait' });
    });
  });

  describe('workflow cross-reference extraction', () => {
    it('extracts workflow_id from add_to_workflow action', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'add_to_workflow',
            name: 'Add to Sub Workflow',
            attributes: {
              workflow_id: 'c717c6ea-1234-5678-9abc-def012345678',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const workflowRefs = result.filter(r => r.entityType === 'workflow');
      assert.equal(workflowRefs.length, 1);
      assert.deepEqual(workflowRefs[0], { entityType: 'workflow', id: 'c717c6ea-1234-5678-9abc-def012345678', source: 'action:Add to Sub Workflow', actionType: 'add_to_workflow' });
    });

    it('extracts multiple workflow_id refs from multiple add_to_workflow actions', () => {
      const workflowData = {
        templates: [
          { id: 'a1', type: 'add_to_workflow', name: 'Sub 1', attributes: { workflow_id: 'wf-aaa' } },
          { id: 'a2', type: 'add_to_workflow', name: 'Sub 2', attributes: { workflow_id: 'wf-bbb' } },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const workflowRefs = result.filter(r => r.entityType === 'workflow');
      assert.equal(workflowRefs.length, 2);
      assert.deepEqual(workflowRefs.map(r => r.id), ['wf-aaa', 'wf-bbb']);
    });
  });

  describe('tag names in condition values', () => {
    it('extracts tag names from conditionSubType=tags with conditionValue array', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Check Tags',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    conditionType: 'contact_detail',
                    conditionSubType: 'tags',
                    conditionOperator: 'contains',
                    conditionValue: ['b2b ai outreach', 'hot lead'],
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const tagRefs = result.filter(r => r.entityType === 'tag');
      assert.equal(tagRefs.length, 2);
      assert.deepEqual(tagRefs[0], { entityType: 'tag', id: 'b2b ai outreach', source: 'condition:Check Tags', actionType: 'if_else' });
      assert.deepEqual(tagRefs[1], { entityType: 'tag', id: 'hot lead', source: 'condition:Check Tags', actionType: 'if_else' });
    });

    it('does not treat conditionSubType=tags as a custom field ID', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'if_else',
            name: 'Tag Check',
            attributes: {
              conditions: {
                operator: 'AND',
                conditions: [
                  {
                    conditionType: 'contact_detail',
                    conditionSubType: 'tags',
                    conditionOperator: 'contains',
                    conditionValue: ['some-tag'],
                  },
                ],
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const cfRefs = result.filter(r => r.entityType === 'customField');
      assert.equal(cfRefs.length, 0);
    });
  });

  describe('form ID extraction', () => {
    it('extracts form refs from trigger conditions with form.id field', () => {
      const workflowData = {
        triggers: [
          {
            type: 'form_submitted',
            name: 'Form Submit',
            conditions: [
              {
                operator: 'is',
                field: 'form.id',
                value: ['SyntheticEntity00001'],
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'form', id: 'SyntheticEntity00001', source: 'trigger:Form Submit' });
    });
  });

  describe('trigger link ID extraction', () => {
    it('extracts triggerLink refs from trigger conditions with link.id field', () => {
      const workflowData = {
        triggers: [
          {
            type: 'link_clicked',
            name: 'Link Click',
            conditions: [
              {
                operator: 'is',
                field: 'link.id',
                value: 'SyntheticEntity00002',
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { entityType: 'triggerLink', id: 'SyntheticEntity00002', source: 'trigger:Link Click' });
    });

    it('extracts triggerLink refs from wait action attributes.link array', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'wait',
            name: 'Wait for Link',
            attributes: {
              link: ['SyntheticEntity00003', 'SyntheticEntity00004'],
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const linkRefs = result.filter(r => r.entityType === 'triggerLink');
      assert.equal(linkRefs.length, 2);
      assert.deepEqual(linkRefs[0], { entityType: 'triggerLink', id: 'SyntheticEntity00003', source: 'action:Wait for Link', actionType: 'wait' });
      assert.deepEqual(linkRefs[1], { entityType: 'triggerLink', id: 'SyntheticEntity00004', source: 'action:Wait for Link', actionType: 'wait' });
    });
  });

  describe('custom_values template reference extraction', () => {
    it('extracts custom_values refs from webhook payload strings', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'webhook',
            name: 'Send Webhook',
            attributes: {
              url: 'https://api.example.com/hook',
              body: '{"api_key": "{{custom_values.fathom_api_key}}", "context": "{{custom_values.business_context_for_ai}}"}',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const cvRefs = result.filter(r => r.entityType === 'customValue');
      assert.equal(cvRefs.length, 2);
      assert.deepEqual(cvRefs[0], { entityType: 'customValue', id: 'fathom_api_key', source: 'action:Send Webhook', actionType: 'webhook' });
      assert.deepEqual(cvRefs[1], { entityType: 'customValue', id: 'business_context_for_ai', source: 'action:Send Webhook', actionType: 'webhook' });
    });

    it('extracts custom_values refs from nested attribute objects', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'send_email',
            name: 'Email',
            attributes: {
              subject: 'Hello',
              html: '<p>Key: {{custom_values.some_key}}</p>',
              nested: {
                deep: {
                  value: 'Use {{custom_values.deep_ref}} here',
                },
              },
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const cvRefs = result.filter(r => r.entityType === 'customValue');
      assert.equal(cvRefs.length, 2);
      assert.deepEqual(cvRefs.map(r => r.id).sort(), ['deep_ref', 'some_key']);
    });

    it('does not extract from non-custom_values template variables', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'send_sms',
            name: 'SMS',
            attributes: {
              body: 'Hi {{contact.firstName}}, your code is {{custom_values.promo_code}}',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const cvRefs = result.filter(r => r.entityType === 'customValue');
      assert.equal(cvRefs.length, 1);
      assert.equal(cvRefs[0].id, 'promo_code');
    });

    // 260425-uzg: actionType must be threaded onto every ref produced from the
    // templates loop so audit_workflow can detect webhook-context refs and
    // refuse to suggest a destructive credential swap.
    it('tags actionType=webhook on refs from a webhook action', () => {
      const workflowData = {
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
      };
      const result = extractEntityRefs(workflowData);
      const cvRefs = result.filter(r => r.entityType === 'customValue');
      assert.equal(cvRefs.length, 1);
      assert.equal(cvRefs[0].id, 'ghl_mcp_cloudflare_webhook_token');
      assert.equal(cvRefs[0].source, 'action:Send Webhook');
      assert.equal(cvRefs[0].actionType, 'webhook');
    });

    it('tags actionType from non-webhook actions (e.g. send_email)', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'send_email',
            name: 'Promo Email',
            attributes: {
              subject: 'Hello',
              html: '<p>Use code {{custom_values.promo_code}}</p>',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const cvRefs = result.filter(r => r.entityType === 'customValue');
      assert.equal(cvRefs.length, 1);
      assert.equal(cvRefs[0].id, 'promo_code');
      assert.equal(cvRefs[0].actionType, 'send_email');
    });
  });

  describe('email template extraction', () => {
    it('extracts email template ref from email action with template_id', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'email',
            name: 'Email',
            attributes: {
              subject: 'x',
              template_id: '69dfefb22bd89f2d2aa091e7',
              templatesource: 'email-builder',
              from_email: '',
              from_name: '',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const etRefs = result.filter(r => r.entityType === 'emailTemplate');
      assert.equal(etRefs.length, 1);
      assert.deepEqual(etRefs[0], { entityType: 'emailTemplate', id: '69dfefb22bd89f2d2aa091e7', source: 'action:Email', actionType: 'email' });
    });

    it('skips email action with inline HTML (no template_id)', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'email',
            name: '24 hr Reminder Email',
            attributes: {
              subject: 'Your Meeting is in 24 Hours!',
              html: '<p>Hi {{contact.first_name}}</p>',
              from_email: '{{appointment.user.email}}',
              from_name: '{{appointment.user.name}}',
            },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const etRefs = result.filter(r => r.entityType === 'emailTemplate');
      assert.equal(etRefs.length, 0);
    });

    it('also works with send_email action type', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'send_email',
            name: 'Legacy Email',
            attributes: { template_id: 'tmpl-legacy-123' },
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      const etRefs = result.filter(r => r.entityType === 'emailTemplate');
      assert.equal(etRefs.length, 1);
      assert.equal(etRefs[0].id, 'tmpl-legacy-123');
    });
  });

  describe('accumulation', () => {
    it('accumulates refs from multiple actions in same workflow', () => {
      const workflowData = {
        templates: [
          {
            id: 'a1',
            type: 'internal_create_opportunity',
            name: 'Create Opp',
            attributes: { pipelineId: 'pipe-1', pipelineStageId: 'stage-1', assignedTo: 'user-1' },
          },
          {
            id: 'a2',
            type: 'assign_to_user_tool',
            name: 'Assign',
            attributes: { userId: 'user-2' },
          },
          {
            id: 'a3',
            type: 'update_contact_field',
            name: 'Update CF',
            attributes: {
              fields: [{ field: 'cf-1', value: 'val' }],
            },
          },
        ],
        triggers: [
          {
            type: 'task_completed',
            name: 'Task Done',
            conditions: [
              { operator: 'is', field: 'task.assignedTo', value: 'user-3' },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 6);
      const types = result.map(r => r.entityType);
      assert.ok(types.includes('pipeline'));
      assert.ok(types.includes('pipelineStage'));
      assert.ok(types.includes('user'));
      assert.ok(types.includes('customField'));
    });

    it('handles array values in trigger conditions', () => {
      const workflowData = {
        triggers: [
          {
            type: 'opportunity_status_changed',
            name: 'Multi Stage',
            conditions: [
              {
                operator: 'is-any-of',
                field: 'opportunity.pipelineStageId',
                value: ['stage-a', 'stage-b'],
              },
            ],
          },
        ],
      };
      const result = extractEntityRefs(workflowData);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { entityType: 'pipelineStage', id: 'stage-a', source: 'trigger:Multi Stage' });
      assert.deepEqual(result[1], { entityType: 'pipelineStage', id: 'stage-b', source: 'trigger:Multi Stage' });
    });
  });
});
