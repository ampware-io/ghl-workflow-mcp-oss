import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractTags } = await import('./tag-scanner.js');

describe('extractTags', () => {
  it('returns empty array for empty object', () => {
    const result = extractTags({});
    assert.deepEqual(result, []);
  });

  it('returns tags from add_contact_tag_tool action', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'add_contact_tag_tool',
          name: 'Add Tag',
          attributes: { tags: ['hot-lead', 'follow-up'] },
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result.sort(), ['follow-up', 'hot-lead']);
  });

  it('returns tags from remove_contact_tag_tool action', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'remove_contact_tag_tool',
          name: 'Remove Tag',
          attributes: { tags: ['prospect'] },
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result, ['prospect']);
  });

  it('returns tags from if_else conditions where field === contact.tags', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'if_else',
          name: 'Check Tag',
          attributes: {
            conditions: {
              operator: 'AND',
              conditions: [
                {
                  operator: 'contains',
                  field: 'contact.tags',
                  value: 'qualified',
                },
              ],
            },
          },
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result, ['qualified']);
  });

  it('returns tags from nested AND/OR condition groups', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'if_else',
          name: 'Nested Check',
          attributes: {
            conditions: {
              operator: 'AND',
              conditions: [
                {
                  operator: 'OR',
                  conditions: [
                    {
                      operator: 'contains',
                      field: 'contact.tags',
                      value: 'vip',
                    },
                    {
                      operator: 'contains',
                      field: 'contact.tags',
                      value: ['gold', 'platinum'],
                    },
                  ],
                },
                {
                  operator: 'contains',
                  field: 'contact.email',
                  value: 'test@example.com',
                },
              ],
            },
          },
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result.sort(), ['gold', 'platinum', 'vip']);
  });

  it('returns tags from trigger conditions where field === contact.tags', () => {
    const workflowData = {
      triggers: [
        {
          type: 'contact_tag_added',
          masterType: 'highlevel',
          name: 'Tag Added',
          conditions: [
            {
              operator: 'is-any-of',
              field: 'contact.tags',
              value: ['new-lead', 'warm'],
            },
          ],
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result.sort(), ['new-lead', 'warm']);
  });

  it('returns tags from a persisted contact_tag trigger (field === tagsAdded, plain-string value)', () => {
    const workflowData = {
      triggers: [
        {
          type: 'contact_tag',
          masterType: 'highlevel',
          name: 'Contact Tag',
          conditions: [
            {
              id: 'tag-added',
              type: 'select',
              title: 'Tag Added',
              operator: 'index-of-true',
              value: 'eoi nurture complete',
              field: 'tagsAdded',
            },
          ],
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result, ['eoi nurture complete']);
  });

  it('deduplicates tags across multiple sources', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'add_contact_tag_tool',
          name: 'Add Tag',
          attributes: { tags: ['vip', 'hot-lead'] },
        },
        {
          id: 'a2',
          type: 'remove_contact_tag_tool',
          name: 'Remove Tag',
          attributes: { tags: ['vip'] },
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result.sort(), ['hot-lead', 'vip']);
  });

  it('handles mixed: actions + conditions + triggers in same workflow', () => {
    const workflowData = {
      templates: [
        {
          id: 'a1',
          type: 'add_contact_tag_tool',
          name: 'Add Tag',
          attributes: { tags: ['follow-up'] },
        },
        {
          id: 'a2',
          type: 'if_else',
          name: 'Check Tag',
          attributes: {
            conditions: {
              operator: 'AND',
              conditions: [
                {
                  operator: 'contains',
                  field: 'contact.tags',
                  value: 'qualified',
                },
              ],
            },
          },
        },
      ],
      triggers: [
        {
          type: 'contact_tag_added',
          conditions: [
            {
              operator: 'is-any-of',
              field: 'contact.tags',
              value: ['new-lead'],
            },
          ],
        },
      ],
    };
    const result = extractTags(workflowData);
    assert.deepEqual(result.sort(), ['follow-up', 'new-lead', 'qualified']);
  });

  it('handles missing/undefined workflowData gracefully', () => {
    assert.deepEqual(extractTags(undefined), []);
    assert.deepEqual(extractTags(null), []);
    assert.deepEqual(extractTags({ templates: null, triggers: undefined }), []);
  });
});
