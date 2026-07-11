const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2026-03-11';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const RATE_LIMIT_BACKOFF_MS = 500;
const RATE_LIMIT_MAX_RETRIES = 1;
const TEXT_RUN_MAX_CHARS = 2000;
const SEARCH_DEFAULT_PAGE_SIZE = 20;
const SEARCH_MAX_PAGE_SIZE = 100;

export type NotionBlockKind =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'to_do'
  | 'quote'
  | 'code'
  | 'divider';

export interface NotionAppendBlockItem {
  type: NotionBlockKind;
  text?: string;
  checked?: boolean;
  language?: string;
}

export interface NotionSearchResultItem {
  id: string;
  objectType: 'page' | 'database';
  title: string;
  url: string;
  parentId?: string;
  parentIdType?: 'page_id' | 'database_id' | 'data_source_id' | 'block_id' | 'workspace';
  properties?: Record<string, NotionDatabasePropertySchema>;
}

export interface NotionDatabasePropertySchema {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string; color?: string }>;
  description?: string | null;
}

export interface NotionSearchArgs {
  query: string;
  filter?: 'page' | 'database';
  pageSize?: number;
}

export interface NotionSearchResult {
  success: boolean;
  query: string;
  searchedAt: string;
  results?: NotionSearchResultItem[];
  hasMore?: boolean;
  nextCursor?: string | null;
  error?: string;
}

export interface NotionCreatePageArgs {
  parentType: 'page_id' | 'database_id';
  parentId: string;
  title?: string;
  properties?: Record<string, unknown>;
  children?: NotionAppendBlockItem[];
}

export interface NotionCreatePageResult {
  success: boolean;
  createdAt: string;
  pageId?: string;
  pageUrl?: string;
  error?: string;
}

export interface NotionAppendBlockArgs {
  pageId: string;
  blocks: NotionAppendBlockItem[];
}

export interface NotionAppendBlockResult {
  success: boolean;
  appendedAt: string;
  count?: number;
  error?: string;
}

interface NotionApiError {
  object: 'error';
  code: string;
  status: number;
  message: string;
}

function getNotionToken(): string | null {
  const key = process.env.NOTION_TOKEN?.trim();
  return key || null;
}

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getNotionToken()}`,
    'Notion-Version': NOTION_API_VERSION,
    'Content-Type': 'application/json',
  };
}

function extractPlainText(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((item: unknown) => {
      if (item && typeof item === 'object' && 'plain_text' in item) {
        const text = (item as { plain_text?: unknown }).plain_text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('')
    .trim();
}

function normalizePropertySchema(value: unknown): NotionDatabasePropertySchema | null {
  if (!value || typeof value !== 'object') return null;
  const prop = value as Record<string, unknown>;
  const id = typeof prop.id === 'string' ? prop.id : '';
  const name = typeof prop.name === 'string' ? prop.name : '';
  const type = typeof prop.type === 'string' ? prop.type : '';
  if (!id || !name || !type) return null;

  const schema: NotionDatabasePropertySchema = { id, name, type };

  // Extract options for select / multi_select / status properties.
  const config = prop[type] as Record<string, unknown> | undefined;
  if (config && Array.isArray(config.options)) {
    const options: Array<{ id: string; name: string; color?: string }> = [];
    for (const opt of config.options) {
      if (!opt || typeof opt !== 'object') continue;
      const o = opt as Record<string, unknown>;
      const optId = typeof o.id === 'string' ? o.id : '';
      const optName = typeof o.name === 'string' ? o.name : '';
      if (!optId || !optName) continue;
      const color = typeof o.color === 'string' ? o.color : undefined;
      options.push({ id: optId, name: optName, ...(color ? { color } : {}) });
    }
    if (options.length > 0) {
      schema.options = options;
    }
  }

  if ('description' in prop) {
    const desc = prop.description;
    schema.description = typeof desc === 'string' ? desc : null;
  }

  return schema;
}

function normalizeSearchResultItem(item: unknown): NotionSearchResultItem | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const objectTypeRaw = typeof r.object === 'string' ? r.object : '';
  if (objectTypeRaw !== 'page' && objectTypeRaw !== 'data_source' && objectTypeRaw !== 'database') {
    return null;
  }

  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;

  const url = typeof r.url === 'string' ? r.url : '';

  // Resolve title: pages store title inside properties.title; data_sources have a top-level title array.
  let title = '';
  if (objectTypeRaw === 'data_source' || objectTypeRaw === 'database') {
    title = extractPlainText(r.title);
  } else if (r.properties && typeof r.properties === 'object') {
    const props = r.properties as Record<string, unknown>;
    const titleProp = props.title;
    if (titleProp && typeof titleProp === 'object') {
      const t = titleProp as Record<string, unknown>;
      title = extractPlainText(t.title);
    }
  }

  // Extract parent reference.
  let parentId: string | undefined;
  let parentIdType: NotionSearchResultItem['parentIdType'];
  if (r.parent && typeof r.parent === 'object') {
    const parent = r.parent as Record<string, unknown>;
    const parentType = typeof parent.type === 'string' ? parent.type : '';
    if (parentType === 'page_id' && typeof parent.page_id === 'string') {
      parentId = parent.page_id;
      parentIdType = 'page_id';
    } else if (parentType === 'database_id' && typeof parent.database_id === 'string') {
      parentId = parent.database_id;
      parentIdType = 'database_id';
    } else if (parentType === 'data_source_id' && typeof parent.data_source_id === 'string') {
      parentId = parent.data_source_id;
      parentIdType = 'data_source_id';
    } else if (parentType === 'block_id' && typeof parent.block_id === 'string') {
      parentId = parent.block_id;
      parentIdType = 'block_id';
    } else if (parentType === 'workspace') {
      parentIdType = 'workspace';
    }
  }

  // Extract schema for databases / data_sources (option A from design: schema returned inline with search).
  let properties: Record<string, NotionDatabasePropertySchema> | undefined;
  if (
    (objectTypeRaw === 'data_source' || objectTypeRaw === 'database') &&
    r.properties &&
    typeof r.properties === 'object'
  ) {
    const rawProps = r.properties as Record<string, unknown>;
    const schema: Record<string, NotionDatabasePropertySchema> = {};
    for (const [key, value] of Object.entries(rawProps)) {
      const normalized = normalizePropertySchema(value);
      if (normalized) {
        schema[key] = normalized;
      }
    }
    if (Object.keys(schema).length > 0) {
      properties = schema;
    }
  }

  return {
    id,
    objectType: objectTypeRaw === 'page' ? 'page' : 'database',
    title,
    url,
    parentId,
    parentIdType,
    properties,
  };
}

function clampPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SEARCH_DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.floor(value), 1), SEARCH_MAX_PAGE_SIZE);
}

function buildSearchBody(args: NotionSearchArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: args.query,
    page_size: clampPageSize(args.pageSize),
  };
  if (args.filter === 'page' || args.filter === 'database') {
    body.filter = { property: 'object', value: args.filter === 'database' ? 'data_source' : 'page' };
  }
  return body;
}

function parseNotionErrorBody(body: string, fallbackStatus: number): NotionApiError | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { object?: unknown; code?: unknown; status?: unknown; message?: unknown };
    if (parsed.object !== 'error') return null;
    return {
      object: 'error',
      code: typeof parsed.code === 'string' ? parsed.code : '',
      status: typeof parsed.status === 'number' ? parsed.status : fallbackStatus,
      message: typeof parsed.message === 'string' ? parsed.message : '',
    };
  } catch {
    return null;
  }
}

function formatErrorWithHint(error: NotionApiError | null, fallbackStatus: number, fallbackText: string): string {
  const code = error?.code || `HTTP ${fallbackStatus}`;
  const message = error?.message || fallbackText;
  const status = error?.status ?? fallbackStatus;
  let hint = '';
  if (status === 401) {
    hint = ' Hint: NOTION_TOKEN is missing or invalid. Check that the integration token is set in the environment.';
  } else if (status === 403) {
    hint = ' Hint: the integration lacks permission for this resource. Confirm the integration was added to the relevant page or workspace.';
  } else if (status === 404) {
    hint = ' Hint: Notion returned object_not_found. The integration only sees pages/databases where it was explicitly added via Connections. Ask the user to open the page in Notion → "..." menu → Connections → add the integration.';
  } else if (status === 429) {
    hint = ' Hint: Notion rate limit reached (3 req/sec per integration). Wait a moment before retrying.';
  } else if (status === 400) {
    hint = ' Hint: invalid_request — re-check property names/types against the database schema returned by notion_search.';
  }
  return `Notion API error ${code} (${status}): ${message}.${hint}`;
}

async function notionRequest(
  endpoint: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const token = getNotionToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'NOTION_TOKEN is not configured in the environment.',
    };
  }

  const url = endpoint.startsWith('http') ? endpoint : `${NOTION_API_BASE}${endpoint}`;
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    const onParentAbort = () => abortController.abort();
    if (signal) signal.addEventListener('abort', onParentAbort);

    try {
      const response = await fetch(url, {
        method,
        headers: buildHeaders(),
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: abortController.signal,
      });

      if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
        continue;
      }

      const text = await response.text();
      let data: unknown = null;
      try {
        data = text.trim() ? JSON.parse(text) : null;
      } catch {
        // Non-JSON response; leave data null.
      }

      if (!response.ok) {
        const apiError = parseNotionErrorBody(text, response.status);
        return {
          ok: false,
          status: response.status,
          data,
          error: formatErrorWithHint(apiError, response.status, response.statusText || `HTTP ${response.status}`),
        };
      }

      return { ok: true, status: response.status, data, error: undefined };
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      const isAbortFromSignal = signal?.aborted;
      if (isAbortFromSignal) {
        return { ok: false, status: 0, data: null, error: 'Notion request aborted.' };
      }
      const message = isAbort
        ? `Notion request timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : 'Unknown Notion request error.';
      return { ok: false, status: 0, data: null, error: message };
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }
  }

  return { ok: false, status: 429, data: null, error: 'Notion rate limit persisted after retry.' };
}

export async function notionSearch(args: NotionSearchArgs, signal?: AbortSignal): Promise<NotionSearchResult> {
  const searchedAt = new Date().toISOString();
  const query = args.query.trim();

  if (!query) {
    return {
      success: false,
      query,
      searchedAt,
      error: 'notion_search requires a non-empty query.',
    };
  }

  const result = await notionRequest('/search', 'POST', buildSearchBody({ ...args, query }), signal);
  if (!result.ok) {
    return { success: false, query, searchedAt, error: result.error };
  }

  const data = result.data as { results?: unknown[]; has_more?: unknown; next_cursor?: unknown } | null;
  const items = Array.isArray(data?.results)
    ? data.results.map(normalizeSearchResultItem).filter((item): item is NotionSearchResultItem => item !== null)
    : [];

  return {
    success: true,
    query,
    searchedAt,
    results: items,
    hasMore: data?.has_more === true,
    nextCursor: typeof data?.next_cursor === 'string' ? data.next_cursor : null,
  };
}

export interface NotionQueryDatabaseArgs {
  databaseId: string;
  filter?: Record<string, unknown>;
  sorts?: Array<{ property?: string; timestamp?: 'created_time' | 'last_edited_time'; direction: 'ascending' | 'descending' }>;
  pageSize?: number;
  startCursor?: string;
}

export interface NotionDatabaseRow {
  id: string;
  url: string;
  title: string;
  properties: Record<string, string | number | boolean | string[] | null>;
  createdTime: string;
  lastEditedTime: string;
  isArchived: boolean;
}

export interface NotionQueryDatabaseResult {
  success: boolean;
  queriedAt: string;
  databaseId: string;
  rows?: NotionDatabaseRow[];
  hasMore?: boolean;
  nextCursor?: string | null;
  error?: string;
}

const QUERY_DEFAULT_PAGE_SIZE = 20;
const QUERY_MAX_PAGE_SIZE = 100;

function clampQueryPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return QUERY_DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.floor(value), 1), QUERY_MAX_PAGE_SIZE);
}

function extractRichTextPlain(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.rich_text)) {
    return extractPlainText(v.rich_text);
  }
  if (Array.isArray(v.title)) {
    return extractPlainText(v.title);
  }
  return '';
}

function flattenPropertyValue(propName: string, value: unknown): string | number | boolean | string[] | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const type = typeof v.type === 'string' ? v.type : '';

  switch (type) {
    case 'title':
      return extractRichTextPlain(v);
    case 'rich_text':
      return extractRichTextPlain(v);
    case 'number': {
      const num = v.number;
      return typeof num === 'number' && Number.isFinite(num) ? num : null;
    }
    case 'checkbox':
      return v.checkbox === true;
    case 'select': {
      const sel = v.select as Record<string, unknown> | null;
      return sel && typeof sel.name === 'string' ? sel.name : null;
    }
    case 'status': {
      const status = v.status as Record<string, unknown> | null;
      return status && typeof status.name === 'string' ? status.name : null;
    }
    case 'multi_select': {
      const arr = v.multi_select;
      if (!Array.isArray(arr)) return null;
      return arr
        .map((item: unknown) => {
          if (item && typeof item === 'object') {
            const m = item as Record<string, unknown>;
            return typeof m.name === 'string' ? m.name : '';
          }
          return '';
        })
        .filter((s: string) => s.length > 0);
    }
    case 'date': {
      const date = v.date as Record<string, unknown> | null;
      if (!date) return null;
      const start = typeof date.start === 'string' ? date.start : null;
      const end = typeof date.end === 'string' ? date.end : null;
      if (!start) return null;
      return end ? `${start} -> ${end}` : start;
    }
    case 'people': {
      const arr = v.people;
      if (!Array.isArray(arr)) return null;
      return arr
        .map((item: unknown) => {
          if (item && typeof item === 'object') {
            const p = item as Record<string, unknown>;
            const name = typeof p.name === 'string' ? p.name : '';
            if (name) return name;
            return typeof p.id === 'string' ? p.id : '';
          }
          return '';
        })
        .filter((s: string) => s.length > 0);
    }
    case 'relation': {
      const arr = v.relation;
      if (!Array.isArray(arr)) return null;
      return arr
        .map((item: unknown) => {
          if (item && typeof item === 'object') {
            const r = item as Record<string, unknown>;
            return typeof r.id === 'string' ? r.id : '';
          }
          return '';
        })
        .filter((s: string) => s.length > 0);
    }
    case 'rollup': {
      const rollup = v.rollup as Record<string, unknown> | null;
      if (!rollup) return null;
      const rollupType = typeof rollup.type === 'string' ? rollup.type : '';
      const rollupValue = rollup[rollupType];
      if (rollupType === 'array' && Array.isArray(rollupValue)) {
        return rollupValue
          .map((item: unknown) => {
            if (item && typeof item === 'object') {
              const r = item as Record<string, unknown>;
              if (typeof r.name === 'string') return r.name;
              if (typeof r.plain_text === 'string') return r.plain_text;
            }
            return '';
          })
          .filter((s: string) => s.length > 0);
      }
      if (rollupType === 'number' && typeof rollupValue === 'number') return rollupValue;
      if (rollupType === 'string' && typeof rollupValue === 'string') return rollupValue;
      return null;
    }
    case 'url':
      return typeof v.url === 'string' ? v.url : null;
    case 'email':
      return typeof v.email === 'string' ? v.email : null;
    case 'phone_number':
      return typeof v.phone_number === 'string' ? v.phone_number : null;
    case 'files': {
      const arr = v.files;
      if (!Array.isArray(arr)) return null;
      return arr
        .map((item: unknown) => {
          if (item && typeof item === 'object') {
            const f = item as Record<string, unknown>;
            if (typeof f.name === 'string') return f.name;
            const ext = f.external as Record<string, unknown> | undefined;
            if (ext && typeof ext.url === 'string') return ext.url;
            const file = f.file as Record<string, unknown> | undefined;
            if (file && typeof file.url === 'string') return file.url;
          }
          return '';
        })
        .filter((s: string) => s.length > 0);
    }
    case 'formula': {
      const formula = v.formula as Record<string, unknown> | null;
      if (!formula) return null;
      const formulaType = typeof formula.type === 'string' ? formula.type : '';
      const formulaValue = formula[formulaType];
      if (formulaType === 'string' && typeof formulaValue === 'string') return formulaValue;
      if (formulaType === 'number' && typeof formulaValue === 'number') return formulaValue;
      if (formulaType === 'boolean' && typeof formulaValue === 'boolean') return formulaValue;
      if (formulaType === 'date') {
        const date = formulaValue as Record<string, unknown> | null;
        if (date && typeof date.start === 'string') return date.start;
      }
      return null;
    }
    case 'created_time':
      return typeof v.created_time === 'string' ? v.created_time : null;
    case 'last_edited_time':
      return typeof v.last_edited_time === 'string' ? v.last_edited_time : null;
    case 'created_by': {
      const u = v.created_by as Record<string, unknown> | null;
      return u && typeof u.name === 'string' ? u.name : (u && typeof u.id === 'string' ? u.id : null);
    }
    case 'last_edited_by': {
      const u = v.last_edited_by as Record<string, unknown> | null;
      return u && typeof u.name === 'string' ? u.name : (u && typeof u.id === 'string' ? u.id : null);
    }
    case 'unique_id': {
      const uid = v.unique_id as Record<string, unknown> | null;
      if (!uid) return null;
      const prefix = typeof uid.prefix === 'string' ? uid.prefix : '';
      const num = typeof uid.number === 'number' ? uid.number : null;
      return num === null ? null : (prefix ? `${prefix}-${num}` : String(num));
    }
    default:
      return null;
  }
}

function normalizeDatabaseRow(item: unknown): NotionDatabaseRow | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  if (r.object !== 'page') return null;

  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;

  const url = typeof r.url === 'string' ? r.url : '';
  const createdTime = typeof r.created_time === 'string' ? r.created_time : '';
  const lastEditedTime = typeof r.last_edited_time === 'string' ? r.last_edited_time : '';
  const isArchived = r.is_archived === true;

  const properties: Record<string, string | number | boolean | string[] | null> = {};
  let title = '';
  if (r.properties && typeof r.properties === 'object') {
    const rawProps = r.properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawProps)) {
      if (!value || typeof value !== 'object') continue;
      const propObj = value as Record<string, unknown>;
      const flattened = flattenPropertyValue(key, propObj);
      properties[key] = flattened;
      // Title property is special-cased for the row title.
      if (propObj.type === 'title' && typeof flattened === 'string' && !title) {
        title = flattened;
      }
    }
  }

  return { id, url, title, properties, createdTime, lastEditedTime, isArchived };
}

function buildQueryBody(args: NotionQueryDatabaseArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page_size: clampQueryPageSize(args.pageSize),
  };
  if (args.filter && typeof args.filter === 'object') {
    body.filter = args.filter;
  }
  if (Array.isArray(args.sorts) && args.sorts.length > 0) {
    body.sorts = args.sorts.map((s) => {
      const sort: Record<string, unknown> = { direction: s.direction };
      if (s.property) sort.property = s.property;
      if (s.timestamp) sort.timestamp = s.timestamp;
      return sort;
    });
  }
  if (typeof args.startCursor === 'string' && args.startCursor.trim()) {
    body.start_cursor = args.startCursor.trim();
  }
  return body;
}

export async function notionQueryDatabase(args: NotionQueryDatabaseArgs, signal?: AbortSignal): Promise<NotionQueryDatabaseResult> {
  const queriedAt = new Date().toISOString();
  const databaseId = args.databaseId.trim();
  if (!databaseId) {
    return { success: false, queriedAt, databaseId, error: 'notion_query_database requires a non-empty databaseId.' };
  }

  const result = await notionRequest(`/data_sources/${databaseId}/query`, 'POST', buildQueryBody(args), signal);
  if (!result.ok) {
    return { success: false, queriedAt, databaseId, error: result.error };
  }

  const data = result.data as { results?: unknown[]; has_more?: unknown; next_cursor?: unknown } | null;
  const rows = Array.isArray(data?.results)
    ? data.results.map(normalizeDatabaseRow).filter((row): row is NotionDatabaseRow => row !== null)
    : [];

  return {
    success: true,
    queriedAt,
    databaseId,
    rows,
    hasMore: data?.has_more === true,
    nextCursor: typeof data?.next_cursor === 'string' ? data.next_cursor : null,
  };
}

export function parseNotionQueryDatabaseArgs(raw: unknown): NotionQueryDatabaseArgs {
  const args = raw as Record<string, unknown>;
  const databaseId = typeof args.databaseId === 'string' ? args.databaseId.trim() : '';
  if (!databaseId) {
    throw new Error('notion_query_database requires a non-empty databaseId.');
  }

  let filter: Record<string, unknown> | undefined;
  if (args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)) {
    filter = args.filter as Record<string, unknown>;
  }

  let sorts: NotionQueryDatabaseArgs['sorts'] | undefined;
  if (Array.isArray(args.sorts)) {
    const validSorts: NonNullable<NotionQueryDatabaseArgs['sorts']> = [];
    for (const s of args.sorts) {
      if (!s || typeof s !== 'object') continue;
      const sort = s as Record<string, unknown>;
      const direction = sort.direction === 'ascending' || sort.direction === 'descending' ? sort.direction : 'ascending';
      const property = typeof sort.property === 'string' ? sort.property : undefined;
      const timestampRaw = typeof sort.timestamp === 'string' ? sort.timestamp : undefined;
      const timestamp: 'created_time' | 'last_edited_time' | undefined =
        timestampRaw === 'created_time' || timestampRaw === 'last_edited_time' ? timestampRaw : undefined;
      if (!property && !timestamp) continue;
      const entry: NonNullable<NotionQueryDatabaseArgs['sorts']>[number] = { direction };
      if (property) entry.property = property;
      if (timestamp) entry.timestamp = timestamp;
      validSorts.push(entry);
    }
    if (validSorts.length > 0) {
      sorts = validSorts;
    }
  }

  return {
    databaseId,
    filter,
    sorts,
    pageSize: typeof args.pageSize === 'number' && Number.isFinite(args.pageSize) ? args.pageSize : undefined,
    startCursor: typeof args.startCursor === 'string' ? args.startCursor : undefined,
  };
}

export function formatNotionQueryDatabaseResult(result: NotionQueryDatabaseResult): string {
  const lines = [
    result.success ? 'Notion database query completed.' : 'Notion database query failed.',
    `Queried at: ${result.queriedAt}`,
    `Database ID: ${result.databaseId}`,
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.rows?.length) {
    lines.push(`Rows (${result.rows.length}):`);
    result.rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.title || '(untitled)'}`);
      lines.push(`   ID: ${row.id}`);
      if (row.url) lines.push(`   URL: ${row.url}`);
      if (row.isArchived) lines.push('   Archived: yes');
      const propEntries = Object.entries(row.properties);
      if (propEntries.length > 0) {
        lines.push('   Properties:');
        for (const [name, value] of propEntries) {
          const formatted = Array.isArray(value) ? value.join(', ') : value === null ? '(empty)' : String(value);
          lines.push(`   - ${name}: ${formatted}`);
        }
      }
    });
  } else if (result.success) {
    lines.push('Rows: none');
  }

  if (result.hasMore) {
    lines.push(`Has more: yes (next_cursor: ${result.nextCursor || 'available'})`);
  }

  return lines.join('\n');
}

function splitTextIntoRuns(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const runs: Array<{ type: 'text'; text: { content: string } }> = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, TEXT_RUN_MAX_CHARS);
    runs.push({ type: 'text', text: { content: chunk } });
    remaining = remaining.slice(TEXT_RUN_MAX_CHARS);
  }
  return runs;
}

function buildBlockObject(item: NotionAppendBlockItem): Record<string, unknown> | null {
  const type = item.type;
  if (type === 'divider') {
    return { type, divider: {} };
  }
  if (type === 'code') {
    return {
      type,
      code: {
        rich_text: splitTextIntoRuns(item.text || ''),
        language: item.language || 'plain text',
      },
    };
  }
  if (type === 'to_do') {
    return {
      type,
      to_do: {
        rich_text: splitTextIntoRuns(item.text || ''),
        checked: Boolean(item.checked),
      },
    };
  }
  // paragraph, heading_*, *_list_item, quote all use the { rich_text } shape.
  const supportedTextBlocks = [
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'quote',
  ];
  if (!supportedTextBlocks.includes(type)) return null;

  return {
    type,
    [type]: { rich_text: splitTextIntoRuns(item.text || '') },
  };
}

export async function notionAppendBlock(args: NotionAppendBlockArgs, signal?: AbortSignal): Promise<NotionAppendBlockResult> {
  const appendedAt = new Date().toISOString();
  if (!args.pageId.trim()) {
    return { success: false, appendedAt, error: 'notion_append_block requires a non-empty pageId.' };
  }
  if (!Array.isArray(args.blocks) || args.blocks.length === 0) {
    return { success: false, appendedAt, error: 'notion_append_block requires a non-empty blocks array.' };
  }

  const children = args.blocks.map(buildBlockObject).filter((b): b is Record<string, unknown> => b !== null);
  if (children.length === 0) {
    return { success: false, appendedAt, error: 'notion_append_block received no supported block types.' };
  }

  const result = await notionRequest(`/blocks/${args.pageId.trim()}/children`, 'POST', { children }, signal);
  if (!result.ok) {
    return { success: false, appendedAt, error: result.error };
  }

  const data = result.data as { results?: unknown[] } | null;
  const count = Array.isArray(data?.results) ? data.results.length : children.length;

  return { success: true, appendedAt, count };
}

export async function notionCreatePage(args: NotionCreatePageArgs, signal?: AbortSignal): Promise<NotionCreatePageResult> {
  const createdAt = new Date().toISOString();

  if (args.parentType !== 'page_id' && args.parentType !== 'database_id') {
    return { success: false, createdAt, error: 'notion_create_page parentType must be "page_id" or "database_id".' };
  }
  if (!args.parentId.trim()) {
    return { success: false, createdAt, error: 'notion_create_page requires a non-empty parentId.' };
  }

  const properties: Record<string, unknown> = { ...(args.properties || {}) };

  // If the caller supplied a title and the parent is a database, embed into a "title" property unless one was already provided.
  if (args.title && !('title' in properties) && args.parentType === 'database_id') {
    properties.title = { title: splitTextIntoRuns(args.title) };
  }

  const body: Record<string, unknown> = {
    parent: { type: args.parentType, [args.parentType]: args.parentId.trim() },
    properties,
  };

  // Optional children blocks (Notion allows up to 100 blocks on page creation).
  if (Array.isArray(args.children) && args.children.length > 0) {
    const children = args.children
      .map(buildBlockObject)
      .filter((b): b is Record<string, unknown> => b !== null);
    if (children.length > 0) {
      body.children = children;
    }
  }

  const result = await notionRequest('/pages', 'POST', body, signal);
  if (!result.ok) {
    return { success: false, createdAt, error: result.error };
  }

  const data = result.data as { id?: unknown; url?: unknown } | null;
  const pageId = typeof data?.id === 'string' ? data.id : '';
  const pageUrl = typeof data?.url === 'string' ? data.url : '';

  return {
    success: true,
    createdAt,
    pageId,
    pageUrl,
  };
}

export function parseNotionSearchArgs(raw: unknown): NotionSearchArgs {
  const args = raw as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const filterRaw = typeof args.filter === 'string' ? args.filter : undefined;
  const filter = filterRaw === 'page' || filterRaw === 'database' ? filterRaw : undefined;
  return {
    query,
    filter,
    pageSize: typeof args.pageSize === 'number' && Number.isFinite(args.pageSize) ? args.pageSize : undefined,
  };
}

export function parseNotionCreatePageArgs(raw: unknown): NotionCreatePageArgs {
  const args = raw as Record<string, unknown>;
  const parentTypeRaw = typeof args.parentType === 'string' ? args.parentType : '';
  if (parentTypeRaw !== 'page_id' && parentTypeRaw !== 'database_id') {
    throw new Error('notion_create_page requires parentType "page_id" or "database_id".');
  }
  const parentId = typeof args.parentId === 'string' ? args.parentId.trim() : '';
  if (!parentId) {
    throw new Error('notion_create_page requires a non-empty parentId.');
  }

  const title = typeof args.title === 'string' ? args.title : undefined;
  let properties: Record<string, unknown> | undefined;
  if (args.properties && typeof args.properties === 'object' && !Array.isArray(args.properties)) {
    properties = args.properties as Record<string, unknown>;
  }

  let children: NotionAppendBlockItem[] | undefined;
  if (Array.isArray(args.children)) {
    children = args.children.map((item) => {
      const b = item as Record<string, unknown>;
      return {
        type: typeof b.type === 'string' ? (b.type as NotionBlockKind) : 'paragraph',
        text: typeof b.text === 'string' ? b.text : undefined,
        checked: typeof b.checked === 'boolean' ? b.checked : undefined,
        language: typeof b.language === 'string' ? b.language : undefined,
      };
    });
  }

  return { parentType: parentTypeRaw, parentId, title, properties, children };
}

export function parseNotionAppendBlockArgs(raw: unknown): NotionAppendBlockArgs {
  const args = raw as Record<string, unknown>;
  const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : '';
  if (!pageId) {
    throw new Error('notion_append_block requires a non-empty pageId.');
  }
  if (!Array.isArray(args.blocks)) {
    throw new Error('notion_append_block requires a blocks array.');
  }
  const blocks: NotionAppendBlockItem[] = args.blocks.map((item) => {
    const b = item as Record<string, unknown>;
    return {
      type: typeof b.type === 'string' ? (b.type as NotionBlockKind) : 'paragraph',
      text: typeof b.text === 'string' ? b.text : undefined,
      checked: typeof b.checked === 'boolean' ? b.checked : undefined,
      language: typeof b.language === 'string' ? b.language : undefined,
    };
  });
  return { pageId, blocks };
}

export function formatNotionSearchResult(result: NotionSearchResult): string {
  const lines = [
    result.success ? 'Notion search completed.' : 'Notion search failed.',
    `Query: ${result.query}`,
    `Searched at: ${result.searchedAt}`,
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.results?.length) {
    lines.push('Results:');
    result.results.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.objectType === 'database' ? '[database]' : '[page]'} ${item.title || '(untitled)'}`);
      lines.push(`   ID: ${item.id}`);
      if (item.url) lines.push(`   URL: ${item.url}`);
      if (item.parentId && item.parentIdType) {
        lines.push(`   Parent: ${item.parentIdType}=${item.parentId}`);
      }
      if (item.properties) {
        const propLines = Object.values(item.properties).map((p) => {
          const opts = p.options && p.options.length > 0
            ? ` [options: ${p.options.map(o => o.name).join(', ')}]`
            : '';
          const desc = p.description ? ` (${p.description})` : '';
          return `   - ${p.name} (${p.type})${opts}${desc}`;
        });
        if (propLines.length > 0) {
          lines.push('   Properties:');
          lines.push(...propLines);
        }
      }
    });
  } else if (result.success) {
    lines.push('Results: none');
  }

  if (result.hasMore) {
    lines.push(`Has more: yes (next_cursor: ${result.nextCursor || 'available'})`);
  }

  return lines.join('\n');
}

export function formatNotionCreatePageResult(result: NotionCreatePageResult): string {
  const lines = [
    result.success ? 'Notion page created.' : 'Notion page creation failed.',
    `Created at: ${result.createdAt}`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.pageId) lines.push(`Page ID: ${result.pageId}`);
  if (result.pageUrl) lines.push(`Page URL: ${result.pageUrl}`);
  return lines.join('\n');
}

export function formatNotionAppendBlockResult(result: NotionAppendBlockResult): string {
  const lines = [
    result.success ? 'Notion blocks appended.' : 'Notion append failed.',
    `Appended at: ${result.appendedAt}`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (typeof result.count === 'number') lines.push(`Blocks appended: ${result.count}`);
  return lines.join('\n');
}
