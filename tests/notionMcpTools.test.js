const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatMcpToolResult,
  projectNotionTools,
  validateProjectedNotionArguments,
} = require('../dist/main/tools/notionMcpTools');
const { CHAT_TOOLS } = require('../dist/main/tools/chatTools');
const { buildSystemPrompt } = require('../dist/main/systemPrompt');

function nativeTool(name, properties = {}, required = []) {
  return {
    name,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

test('Notion tools are hidden from the base chat catalog while disconnected', () => {
  assert.equal(CHAT_TOOLS.some(tool => tool.function.name.startsWith('notion_')), false);
});

test('uses one concise disconnected Notion instruction instead of legacy REST guidance', async () => {
  const prompt = await buildSystemPrompt('test-conversation');
  assert.match(prompt.content, /Notion: disconnected\. Ask the user to use Notion > Connect before Notion work\./);
  assert.doesNotMatch(prompt.content, /notion_query_database|NOTION_TOKEN|Connections -> add the integration/);
});

test('projects only the approved MCP capabilities under stable Jarvis names', () => {
  const projected = projectNotionTools([
    nativeTool('notion-search', { query: { type: 'string' } }, ['query']),
    nativeTool('notion-fetch', { id: { type: 'string' } }, ['id']),
    nativeTool('notion-query-data-sources', { data_source_id: { type: 'string' } }, ['data_source_id']),
    nativeTool('notion-create-pages', { pages: { type: 'array' }, parent: { type: 'object' } }, ['pages']),
    nativeTool('notion-update-page', {
      command: { type: 'string', enum: ['update_properties', 'insert_content', 'update_content', 'replace_content', 'archive'] },
      page_id: { type: 'string' },
      properties: { type: 'object' },
      new_str: { type: 'string' },
      content_updates: { type: 'array' },
      icon: { type: 'object' },
      cover: { type: 'object' },
    }, ['command', 'page_id']),
    nativeTool('notion-create-database', { parent: { type: 'object' }, schema: { type: 'string' } }, ['parent', 'schema']),
    nativeTool('notion-update-data-source', { data_source_id: { type: 'string' }, schema: { type: 'string' } }, ['data_source_id', 'schema']),
    nativeTool('notion-create-view', { database_id: { type: 'string' }, data_source_id: { type: 'string' }, name: { type: 'string' } }, ['database_id', 'data_source_id', 'name']),
    nativeTool('notion-update-view', { view_id: { type: 'string' }, filter: { type: 'object' } }, ['view_id']),
    nativeTool('notion-move-pages', { page_or_database_ids: { type: 'array' }, new_parent: { type: 'object' } }, ['page_or_database_ids', 'new_parent']),
    nativeTool('notion-delete-page', { page_id: { type: 'string' } }, ['page_id']),
  ]);

  assert.deepEqual(
    projected.map(tool => tool.definition.function.name),
    [
      'notion_search',
      'notion_fetch_page',
      'notion_query_data_source',
      'notion_create_page',
      'notion_append_blocks',
      'notion_update_page_properties',
      'notion_update_page_content',
      'notion_create_database',
      'notion_update_data_source',
      'notion_create_view',
      'notion_update_view',
      'notion_move_pages',
    ],
  );
  assert.equal(projected.some(tool => tool.nativeName === 'notion-delete-page'), false);

  const append = projected.find(tool => tool.definition.function.name === 'notion_append_blocks');
  const update = projected.find(tool => tool.definition.function.name === 'notion_update_page_properties');
  const updateContent = projected.find(tool => tool.definition.function.name === 'notion_update_page_content');
  assert.deepEqual(append.definition.function.parameters.properties.command.enum, ['insert_content']);
  assert.deepEqual(update.definition.function.parameters.properties.command.enum, ['update_properties']);
  assert.deepEqual(updateContent.definition.function.parameters.properties.command.enum, ['update_content', 'replace_content']);
  assert.equal('icon' in append.definition.function.parameters.properties, false);
  assert.equal('properties' in append.definition.function.parameters.properties, false);
  assert.deepEqual(Object.keys(update.definition.function.parameters.properties).sort(), ['command', 'cover', 'icon', 'page_id', 'properties']);
  assert.deepEqual(
    projected.find(tool => tool.definition.function.name === 'notion_create_page').definition.function.parameters.required,
    ['pages'],
  );
  assert.deepEqual(
    projected.find(tool => tool.definition.function.name === 'notion_create_database').definition.function.parameters,
    nativeTool('unused', { parent: { type: 'object' }, schema: { type: 'string' } }, ['parent', 'schema']).inputSchema,
  );
});

test('does not expose update wrappers when the native command cannot be safely constrained', () => {
  const projected = projectNotionTools([
    nativeTool('notion-update-page', { page_id: { type: 'string' } }, ['page_id']),
  ]);
  assert.deepEqual(projected, []);
});

test('validates command boundaries while allowing batch and private page creation', () => {
  const projected = projectNotionTools([
    nativeTool('notion-create-pages', { pages: { type: 'array' }, parent: { type: 'object' } }, ['pages']),
    nativeTool('notion-update-page', {
      command: { type: 'string', enum: ['insert_content', 'replace_content'] },
      page_id: { type: 'string' },
    }, ['command']),
  ]);
  const create = projected.find(tool => tool.definition.function.name === 'notion_create_page');
  const append = projected.find(tool => tool.definition.function.name === 'notion_append_blocks');

  assert.equal(validateProjectedNotionArguments(create, { pages: [{}] }), null);
  assert.equal(validateProjectedNotionArguments(create, { parent: {}, pages: [{}, {}] }), null);
  assert.match(validateProjectedNotionArguments(append, { command: 'replace_content' }), /requires command/i);
  assert.match(validateProjectedNotionArguments(append, { command: 'insert_content', icon: {} }), /does not permit parameter/i);
  assert.equal(validateProjectedNotionArguments(append, { command: 'insert_content' }), null);
});

test('propagates native MCP success and failure accurately', () => {
  assert.deepEqual(
    formatMcpToolResult({ content: [{ type: 'text', text: 'Created page.' }] }),
    { success: true, content: 'Created page.' },
  );
  assert.deepEqual(
    formatMcpToolResult({ isError: true, content: [{ type: 'text', text: 'Permission denied.' }] }),
    { success: false, content: 'Permission denied.' },
  );
});
