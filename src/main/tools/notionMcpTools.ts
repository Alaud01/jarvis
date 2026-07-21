import type { ToolDefinition, ToolExecutionResult } from '../providers/types';

export interface NativeMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ProjectedNotionTool {
  definition: ToolDefinition;
  nativeName: string;
  allowedCommands?: string[];
  allowedParameters?: string[];
  singlePageOnly?: boolean;
}

const TOOL_SPECS: Array<{
  name: string;
  candidates: string[];
  description: string;
  commandPatterns?: RegExp[];
  allowedParameters?: string[];
  singlePageOnly?: boolean;
}> = [
  {
    name: 'notion_search',
    candidates: ['notion-search', 'search'],
    description: 'Search the connected Notion workspace. Use returned page, database, and data-source identifiers exactly as labeled; do not interchange database and data-source IDs.',
  },
  {
    name: 'notion_fetch_page',
    candidates: ['notion-fetch', 'fetch'],
    description: 'Fetch a Notion page or data source by ID, including its recursively rendered page content and identity metadata.',
  },
  {
    name: 'notion_query_data_source',
    candidates: ['notion-query-data-sources', 'query-data-sources', 'notion-query-data-source', 'query-data-source'],
    description: 'Query a Notion data source and return its rows. Pass a data-source identifier, not the containing database identifier.',
  },
  {
    name: 'notion_create_page',
    candidates: ['notion-create-pages', 'create-pages'],
    description: 'Create one child page under a page, or one row under a data source. A parent is required; this tool cannot create a private top-level page.',
    allowedParameters: ['parent', 'pages'],
    singlePageOnly: true,
  },
  {
    name: 'notion_append_blocks',
    candidates: ['notion-update-page', 'update-page'],
    description: 'Append content to an existing Notion page. This tool cannot replace or delete existing content.',
    commandPatterns: [/^insert_content$/i, /^insert_content_after$/i, /^append_content$/i, /^add_content$/i],
    allowedParameters: ['page_id', 'command', 'new_str', 'content', 'content_updates', 'selection_with_ellipsis', 'insert_after', 'insert_before'],
  },
  {
    name: 'notion_update_page_properties',
    candidates: ['notion-update-page', 'update-page'],
    description: 'Update properties on an existing Notion page or data-source row. This tool cannot archive or delete it.',
    commandPatterns: [/^update_properties$/i, /^update_page_properties$/i],
    allowedParameters: ['page_id', 'command', 'properties'],
  },
];

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function restrictCommandSchema(
  schema: Record<string, unknown>,
  patterns: RegExp[],
): { schema: Record<string, unknown>; allowedCommands: string[] } | null {
  const cloned = cloneSchema(schema);
  const properties = cloned.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;

  const command = (properties as Record<string, unknown>).command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const enumValues = (command as Record<string, unknown>).enum;
  if (!Array.isArray(enumValues)) return null;

  const allowedCommands = enumValues.filter(
    (value): value is string => typeof value === 'string' && patterns.some(pattern => pattern.test(value)),
  );
  if (allowedCommands.length === 0) return null;

  (command as Record<string, unknown>).enum = allowedCommands;
  return { schema: cloned, allowedCommands };
}

function asToolParameters(schema: Record<string, unknown>): ToolDefinition['function']['parameters'] | null {
  if (schema.type !== 'object') return null;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return schema as ToolDefinition['function']['parameters'];
}

function restrictParameters(
  schema: Record<string, unknown>,
  allowedNames: string[],
  requireParent = false,
): Record<string, unknown> | null {
  const cloned = cloneSchema(schema);
  if (!cloned.properties || typeof cloned.properties !== 'object' || Array.isArray(cloned.properties)) return null;
  const properties = cloned.properties as Record<string, unknown>;
  for (const name of Object.keys(properties)) {
    if (!allowedNames.includes(name)) delete properties[name];
  }
  if (requireParent && !properties.parent) return null;
  const required = Array.isArray(cloned.required)
    ? cloned.required.filter((name): name is string => typeof name === 'string' && allowedNames.includes(name))
    : [];
  if (requireParent && !required.includes('parent')) required.push('parent');
  cloned.required = required;
  cloned.additionalProperties = false;
  return cloned;
}

export function projectNotionTools(nativeTools: NativeMcpTool[]): ProjectedNotionTool[] {
  const byName = new Map(nativeTools.map(tool => [tool.name, tool]));
  const projected: ProjectedNotionTool[] = [];

  for (const spec of TOOL_SPECS) {
    const native = spec.candidates.map(name => byName.get(name)).find(Boolean);
    if (!native) continue;

    let schema = cloneSchema(native.inputSchema);
    let allowedCommands: string[] | undefined;
    if (spec.commandPatterns) {
      const restricted = restrictCommandSchema(schema, spec.commandPatterns);
      if (!restricted) continue;
      schema = restricted.schema;
      allowedCommands = restricted.allowedCommands;
    }
    if (spec.allowedParameters) {
      const restricted = restrictParameters(schema, spec.allowedParameters, spec.singlePageOnly === true);
      if (!restricted) continue;
      schema = restricted;
    }

    const parameters = asToolParameters(schema);
    if (!parameters) continue;
    projected.push({
      nativeName: native.name,
      allowedCommands,
      allowedParameters: spec.allowedParameters,
      singlePageOnly: spec.singlePageOnly,
      definition: {
        type: 'function',
        function: {
          name: spec.name,
          description: spec.description,
          parameters,
        },
      },
    });
  }

  return projected;
}

export function validateProjectedNotionArguments(
  tool: ProjectedNotionTool,
  args: Record<string, unknown>,
): string | null {
  if (tool.allowedCommands) {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!tool.allowedCommands.includes(command)) {
      return `${tool.definition.function.name} requires command ${tool.allowedCommands.map(value => JSON.stringify(value)).join(' or ')}.`;
    }
  }

  if (tool.allowedParameters) {
    const unexpected = Object.keys(args).filter(name => !tool.allowedParameters?.includes(name));
    if (unexpected.length > 0) {
      return `${tool.definition.function.name} does not permit parameter ${unexpected.map(value => JSON.stringify(value)).join(', ')}.`;
    }
  }

  if (tool.singlePageOnly) {
    if (!args.parent || typeof args.parent !== 'object' || Array.isArray(args.parent)) {
      return 'notion_create_page requires a parent page or data source; private top-level pages are outside this tool boundary.';
    }
    if (!Array.isArray(args.pages) || args.pages.length !== 1) {
      return 'notion_create_page creates exactly one page or data-source row per call.';
    }
  }

  return null;
}

export function formatMcpToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}): ToolExecutionResult {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
        parts.push(`Resource: ${block.uri}`);
      } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
        const resource = block.resource as Record<string, unknown>;
        if (typeof resource.text === 'string') parts.push(resource.text);
        else if (typeof resource.uri === 'string') parts.push(`Resource: ${resource.uri}`);
      } else if ((block.type === 'image' || block.type === 'audio') && typeof block.mimeType === 'string') {
        parts.push(`[${block.type}: ${block.mimeType}]`);
      }
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (parts.length === 0 && result.toolResult !== undefined) {
    parts.push(typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult, null, 2));
  }

  return {
    success: result.isError !== true,
    content: parts.join('\n\n') || (result.isError ? 'Notion MCP tool failed without an error message.' : 'Notion MCP tool completed.'),
  };
}
