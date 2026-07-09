import dotenv from 'dotenv';
import { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain, shell, dialog, session } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { startPythonService, stopPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC, cleanupVoiceFlow } from './voiceFlow';
import { setOverlayThemeBackground } from './overlayWindow';
import { setMainWindow } from './audioRecorder';
import {
  loadConversation,
  loadConversationMetadata,
  loadConversations,
  saveConversation,
  saveConversationMetadata,
  saveConversations,
  deleteConversation,
  deleteFolderAndConversations,
  loadFolders,
  saveFolders,
  loadSelectedModel,
  saveSelectedModel,
  loadSelectedProvider,
  saveSelectedProvider,
  loadOpenCodeGoApiKey,
  saveOpenCodeGoApiKey,
  loadOpenRouterApiKey,
  saveOpenRouterApiKey,
  loadOpenTabIds,
  saveOpenTabIds,
  loadCurrentConversationId,
  saveCurrentConversationId,
  loadConversationDrafts,
  saveConversationDrafts,
} from './store';
import { fetchUrlContent, type FetchToolArgs, type FetchToolResult } from './fetchService';
import { tavilySearch, toSearchSource, type TavilySearchToolArgs, type TavilySearchToolResult } from './tavilySearchService';
import {
  notionSearch,
  notionCreatePage,
  notionAppendBlock,
  notionQueryDatabase,
  parseNotionSearchArgs,
  parseNotionCreatePageArgs,
  parseNotionAppendBlockArgs,
  parseNotionQueryDatabaseArgs,
  formatNotionSearchResult,
  formatNotionCreatePageResult,
  formatNotionAppendBlockResult,
  formatNotionQueryDatabaseResult,
  type NotionSearchResult,
  type NotionCreatePageResult,
  type NotionAppendBlockResult,
  type NotionQueryDatabaseResult,
} from './notionService';
import {
  browserClick,
  browserCurrentState,
  browserDrag,
  browserEvaluate,
  browserOpen,
  browserScroll,
  browserScreenshot,
  browserType,
  browserWait,
  closeBrowserControl,
  type BrowserControlResult,
} from './browserControlService';
import type { StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../shared/stream';
import type { SearchSourceGroup, SearchSourcesEvent } from '../shared/search';
import { initializeProviders, getProvider, getAvailableProviders, getAllModels, getModelsForProvider, setOpenCodeGoApiKey, setOpenRouterApiKey } from './providers/registry';
import type { ChatMessage, ToolDefinition, StreamChunk, ProviderInfo, ModelInfo } from './providers/types';
import { ATTACHMENT_DIALOG_FILTERS, readAttachments } from './attachmentService';
import {
  createDictionaryEntry,
  createReplacementRule,
  deleteDictionaryEntry,
  deleteReplacementRule,
  listDictionaryEntries,
  updateDictionaryEntry,
  updateReplacementRule,
  updateVocabularyCandidate,
} from './dictionaryService';
import type {
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
} from '../shared/dictionary';
import { debugLog, infoLog } from './logger';
import { compactMessagesIfNeeded, estimateTotalTokens, getContextThresholdTokens } from './contextCompaction';
import { getLocalVoiceModelStatus, installLocalVoiceModel } from './localVoiceModelSetup';

dotenv.config({ quiet: true });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let activeStreams = new Map<string, AbortController>();
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const MAX_TAVILY_SEARCH_CALLS_PER_TURN = 5;
const MAX_FETCH_URL_CALLS_PER_TURN = 5;
const MAX_NOTION_CALLS_PER_TURN = 8;
const CHAT_MODEL_KEEP_ALIVE = '2m';
const ONE_OFF_MODEL_KEEP_ALIVE = 0;
const REGENERABLE_CACHE_PATHS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  path.join('Service Worker', 'CacheStorage'),
];

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
  messages: ChatMessage[];
}

const CHAT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'tavily_search',
      description: 'Search the live public web with Tavily and return ranked source results with URLs and snippets. Use this for current events, recent facts, discovery of relevant public sources, or when the user asks to search the web. Prefer answering from these results when snippets are enough; only use fetch_url on one or two high-value primary sources if you need full page text.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The web search query.'
          },
          count: {
            type: 'number',
            description: 'Optional number of results to return, from 1 to 20.'
          },
          country: {
            type: 'string',
            description: 'Optional country name to boost results from, such as "united states", "united kingdom", or "canada".'
          },
          searchDepth: {
            type: 'string',
            description: 'Optional Tavily search depth: "basic", "advanced", "fast", or "ultra-fast".'
          },
          topic: {
            type: 'string',
            description: 'Optional search topic: "general", "news", or "finance".'
          },
          timeRange: {
            type: 'string',
            description: 'Optional time range filter: "day", "week", "month", "year", or "d", "w", "m", "y".'
          }
        },
        required: ['query'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch one public http or https URL and return a readable text version of the response. Use sparingly, preferably for official or primary sources, when Tavily snippets are not enough. Avoid repeated fetches, paywalled pages, Medium, LinkedIn, social networks, CAPTCHA/challenge pages, and sites likely to block automation.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.'
          },
          maxChars: {
            type: 'number',
            description: 'Optional maximum number of response characters to return.'
          },
          rawHtml: {
            type: 'boolean',
            description: 'Optional flag to return raw HTML instead of a cleaned readable version for HTML pages.'
          }
        },
        required: ['url'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a URL in Jarvis Browser Control and return current browser state. Use this to begin browser work or navigate directly to a known page.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to open. If no scheme is provided, https:// is assumed.'
          },
          external: {
            type: 'boolean',
            description: 'Open in the user default browser instead of Jarvis Browser Control. This preserves the user browser session/privacy but Jarvis cannot inspect, click, type, or screenshot that external browser. Defaults to false.'
          }
        },
        required: ['url'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_current_state',
      description: 'Return the current Browser Control URL, title, loading status, tab summary, and visible text preview.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a Browser Control screenshot. Screenshots are transient by default; set persist to true only when the user asked for a screenshot or a durable trace artifact is useful.',
      parameters: {
        type: 'object',
        properties: {
          persist: {
            type: 'boolean',
            description: 'Whether to save the screenshot as a persistent artifact. Defaults to false.'
          }
        },
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current Browser Control page or scrollable region using mouse-wheel input from the center of the browser viewport. Use this when relevant content is below, above, or horizontally out of view.',
      parameters: {
        type: 'object',
        properties: {
          deltaY: {
            type: 'number',
            description: 'Vertical scroll delta. Positive scrolls down; negative scrolls up. Clamped to -10000..10000. Defaults to 800.'
          },
          deltaX: {
            type: 'number',
            description: 'Horizontal scroll delta. Positive scrolls right; negative scrolls left. Clamped to -10000..10000. Defaults to 0.'
          }
        },
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click a visible Browser Control target. Prefer role or text targets. Use selector only for deterministic recovery, and coordinates only as a last resort.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            description: 'Structured target: {kind:"role", role:"button", name:"Save"}, {kind:"text", text:"Continue", exact:false}, {kind:"selector", selector:"#save"}, or {kind:"coordinates", x:100, y:200}.',
            properties: {
              kind: { type: 'string', enum: ['role', 'text', 'selector', 'coordinates'] },
              role: { type: 'string' },
              name: { type: 'string' },
              text: { type: 'string' },
              exact: { type: 'boolean' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['kind'],
            additionalProperties: false,
          }
        },
        required: ['target'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description: 'Drag a visible Browser Control target to another target or coordinate using real browser input events. Use this for drag-and-drop controls, sliders, game pieces, sortable lists, and other press-move-release interactions.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'object',
            description: 'Structured drag start target: {kind:"role", role:"button", name:"Item"}, {kind:"text", text:"Item"}, {kind:"selector", selector:".piece"}, or {kind:"coordinates", x:100, y:200}.',
            properties: {
              kind: { type: 'string', enum: ['role', 'text', 'selector', 'coordinates'] },
              role: { type: 'string' },
              name: { type: 'string' },
              text: { type: 'string' },
              exact: { type: 'boolean' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
          to: {
            type: 'object',
            description: 'Structured drag end target, usually coordinates for game boards or a role/text/selector target for UI drop zones.',
            properties: {
              kind: { type: 'string', enum: ['role', 'text', 'selector', 'coordinates'] },
              role: { type: 'string' },
              name: { type: 'string' },
              text: { type: 'string' },
              exact: { type: 'boolean' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
          durationMs: {
            type: 'number',
            description: 'Optional drag movement duration in milliseconds, clamped to 0-10000. Defaults to 700.'
          },
          steps: {
            type: 'number',
            description: 'Optional number of mouse-move steps, clamped to 2-80. Defaults to 18.'
          },
          holdMs: {
            type: 'number',
            description: 'Optional hold time before moving, clamped to 0-2000. Defaults to 150.'
          }
        },
        required: ['from', 'to'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into a visible Browser Control target. Prefer role or text targets; set clear to true when replacing existing text.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            description: 'Structured target: {kind:"role", role:"textbox", name:"Email"}, {kind:"text", text:"Search"}, {kind:"selector", selector:"input[name=q]"}, or {kind:"coordinates", x:100, y:200}.',
            properties: {
              kind: { type: 'string', enum: ['role', 'text', 'selector', 'coordinates'] },
              role: { type: 'string' },
              name: { type: 'string' },
              text: { type: 'string' },
              exact: { type: 'boolean' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
          text: {
            type: 'string',
            description: 'Text to type into the target.'
          },
          clear: {
            type: 'boolean',
            description: 'Clear the target before typing. Defaults to false.'
          }
        },
        required: ['target', 'text'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait briefly for Browser Control page transitions, animations, or loading before inspecting state again.',
      parameters: {
        type: 'object',
        properties: {
          milliseconds: {
            type: 'number',
            description: 'Milliseconds to wait, clamped to 0-30000. Defaults to 1000.'
          }
        },
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Evaluate diagnostic JavaScript in Browser Control and return the result. Use sparingly for inspection or recovery when normal state, role, text, click, and type tools are insufficient.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'JavaScript expression or function body to evaluate in the current page.'
          }
        },
        required: ['script'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_search',
      description: 'Search the user\'s Notion workspace for pages and databases by title. Returns each result with its Notion ID, URL, and (for databases) the full property schema including select/multi_select/status options. Use this to resolve a page or database by name before creating pages or appending blocks, and to learn a database\'s required property names and types before calling notion_create_page.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Title text to search for. Matches pages and databases whose titles include this string.'
          },
          filter: {
            type: 'string',
            enum: ['page', 'database'],
            description: 'Optional filter to restrict results to "page" or "database" only.'
          },
          pageSize: {
            type: 'number',
            description: 'Optional number of results, clamped to 1-100. Defaults to 20.'
          }
        },
        required: ['query'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_query_database',
      description: 'Query a Notion database for its rows with full property values, optional filter, and optional sort. Use this to read what is in a database (e.g. upcoming tasks, items with a certain status, items created this week). Resolve the database ID via notion_search first. Returns each row with its properties flattened to human-readable values (title, Done, Date, Priority, etc.). Filters use Notion\'s native filter grammar and pass through verbatim — Notion validates and returns a 400 with details if the filter is malformed. Common filter examples: {"property":"Done","checkbox":{"equals":false}} (incomplete tasks), {"property":"Date","date":{"next_week":{}}} (dates in next week, also supports this_week/past_week/past_month/next_month/past_year/next_year or explicit ISO dates via before/after/on_or_before/on_or_after/equals), {"property":"Priority","select":{"equals":"High"}}. Compound: {"and":[...]} or {"or":[...]}. Sorts: [{"property":"Date","direction":"ascending"}] or [{"timestamp":"created_time","direction":"descending"}].',
      parameters: {
        type: 'object',
        properties: {
          databaseId: {
            type: 'string',
            description: 'The Notion ID (UUID, dashes optional) of the database to query. Resolve via notion_search before calling.'
          },
          filter: {
            type: 'object',
            description: 'Optional Notion filter object. Single property filter: {"property":"<name>","<type>":{<comparator>}}. Compound: {"and":[...]} or {"or":[...]. Property types: title/rich_text/url/email/phone_number (equals/contains/starts_with/ends_with/does_not_equal/does_not_contain/is_empty/is_not_empty), number (equals/greater_than/less_than/greater_than_or_equal_to/less_than_or_equal_to/does_not_equal), checkbox (equals/does_not_equal, boolean), select/multi_select/status (equals/does_not_equal/contains/does_not_contain/is_empty/is_not_empty), date (equals/before/after/on_or_before/on_or_after/this_week/past_week/past_month/past_year/next_week/next_month/next_year, plus is_empty/is_not_empty), people/relation (contains/does_not_contain/is_empty/is_not_empty), formula (string/number/boolean/date sub-filter), created_time/last_edited_time (same as date filters). Pass through verbatim — Notion validates.',
            additionalProperties: true,
          },
          sorts: {
            type: 'array',
            description: 'Optional sort criteria, in priority order. Each sort: {"property":"<name>","direction":"ascending"|"descending"} or {"timestamp":"created_time"|"last_edited_time","direction":"ascending"|"descending"}.',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string' },
                timestamp: { type: 'string', enum: ['created_time', 'last_edited_time'] },
                direction: { type: 'string', enum: ['ascending', 'descending'] }
              },
              additionalProperties: false,
            }
          },
          pageSize: {
            type: 'number',
            description: 'Optional number of rows per page, clamped to 1-100. Defaults to 20.'
          },
          startCursor: {
            type: 'string',
            description: 'Optional pagination cursor from a previous notion_query_database response\'s nextCursor. Use to fetch the next page of rows when hasMore is true.'
          }
        },
        required: ['databaseId'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_create_page',
      description: 'Create a new page in Notion under a parent page or database. When the parent is a database, supply properties matching the database schema returned by notion_search (wrong property names or types will be rejected). When the parent is a page, supply a title and optionally children blocks. Optional children blocks use the same {type, text, checked?, language?} shape as notion_append_block.',
      parameters: {
        type: 'object',
        properties: {
          parentType: {
            type: 'string',
            enum: ['page_id', 'database_id'],
            description: 'Whether the parent is a page or a database.'
          },
          parentId: {
            type: 'string',
            description: 'The Notion ID (UUID, dashes optional) of the parent page or database. Resolve via notion_search before calling.'
          },
          title: {
            type: 'string',
            description: 'Optional page title. When parentType is "database_id" and no "title" property is supplied in properties, this is written into the database\'s title property. When parentType is "page_id", this sets the page title.'
          },
          properties: {
            type: 'object',
            description: 'Optional Notion page properties keyed by property name. Each value must match the property\'s Notion type (e.g. { "title": { "title": [...] } }, { "Status": { "status": { "name": "In Progress" } } }). Inspect notion_search results for the exact property names and options of the target database.',
            additionalProperties: true,
          },
          children: {
            type: 'array',
            description: 'Optional initial content blocks appended to the new page. Same shape as notion_append_block blocks.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider'] },
                text: { type: 'string' },
                checked: { type: 'boolean' },
                language: { type: 'string' }
              },
              additionalProperties: false,
            }
          }
        },
        required: ['parentType', 'parentId'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_append_block',
      description: 'Append content blocks to an existing Notion page. Use this to add paragraphs, headings, list items, to-dos, quotes, code, or dividers to a page the user names or has previously worked with. Resolve the page via notion_search first. Supported block types: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, to_do, quote, code, divider. Each block is {type, text?, checked?, language?}; divider takes no text, to_do takes optional checked, code takes optional language.',
      parameters: {
        type: 'object',
        properties: {
          pageId: {
            type: 'string',
            description: 'The Notion ID (UUID, dashes optional) of the page to append to. Resolve via notion_search before calling.'
          },
          blocks: {
            type: 'array',
            description: 'Content blocks to append, in order. Each block: {type, text?, checked?, language?}.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider'] },
                text: { type: 'string', description: 'Block text. Omitted for divider. Long text is auto-split at Notion\'s 2000-char per-run limit.' },
                checked: { type: 'boolean', description: 'For to_do blocks only: whether the item is checked.' },
                language: { type: 'string', description: 'For code blocks only: the language identifier (e.g. "typescript", "plain text"). Defaults to "plain text".' }
              },
              required: ['type'],
              additionalProperties: false,
            }
          }
        },
        required: ['pageId', 'blocks'],
        additionalProperties: false,
      }
    }
  }
];

const BROWSER_CONTROL_TOOL_NAMES = new Set([
  'browser_open',
  'browser_current_state',
  'browser_screenshot',
  'browser_scroll',
  'browser_click',
  'browser_drag',
  'browser_type',
  'browser_wait',
  'browser_evaluate',
]);

const NOTION_TOOL_NAMES = new Set([
  'notion_search',
  'notion_query_database',
  'notion_create_page',
  'notion_append_block',
]);

async function runNotionTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (toolName === 'notion_search') {
    const parsed = parseNotionSearchArgs(args);
    const result: NotionSearchResult = await notionSearch(parsed, signal);
    return formatNotionSearchResult(result);
  }
  if (toolName === 'notion_query_database') {
    const parsed = parseNotionQueryDatabaseArgs(args);
    const result: NotionQueryDatabaseResult = await notionQueryDatabase(parsed, signal);
    return formatNotionQueryDatabaseResult(result);
  }
  if (toolName === 'notion_create_page') {
    const parsed = parseNotionCreatePageArgs(args);
    const result: NotionCreatePageResult = await notionCreatePage(parsed, signal);
    return formatNotionCreatePageResult(result);
  }
  if (toolName === 'notion_append_block') {
    const parsed = parseNotionAppendBlockArgs(args);
    const result: NotionAppendBlockResult = await notionAppendBlock(parsed, signal);
    return formatNotionAppendBlockResult(result);
  }
  throw new Error(`Unknown Notion tool: ${toolName}`);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

function formatLocalUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60).toString().padStart(2, '0');
  const minutes = (absoluteMinutes % 60).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function buildTemporalContext(now = new Date()): string {
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'system local time';
  const localDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const localTime = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(now);

  return [
    `Current local date and time: ${localDate} at ${localTime} (${resolvedTimeZone}, UTC${formatLocalUtcOffset(now)}).`,
    `Current ISO timestamp: ${now.toISOString()}.`,
    'Interpret relative dates and times like "today", "tomorrow", "tonight", "this week", and "next week" relative to this local date/time unless the user specifies a different timezone.',
  ].join(' ');
}

async function buildSystemPrompt(_conversationId: string): Promise<ChatMessage> {
  return {
    role: 'system',
    content: [
      'You are Jarvis, a desktop assistant. Your name is Jarvis.',
      buildTemporalContext(),
      'Use the tavily_search tool for current information, recent facts, source discovery, or explicit web search requests.',
      'After tavily_search, answer from search snippets and source metadata when they are enough.',
      'Use fetch_url only when the full page is necessary for accuracy, and fetch at most one or two high-value primary sources.',
      'Do not fetch Medium, LinkedIn, social networks, obvious paywalled pages, or pages likely to show CAPTCHA/anti-bot checks unless the user explicitly asks.',
      'If fetch_url reports a 403, 429, CAPTCHA, verification, or anti-bot challenge, do not retry that URL; use another source or answer from search results.',
      'When you use tavily_search, include relevant Markdown links to the sources you relied on.',
      'Use the fetch_url tool first for public webpages when you only need to read page content, summarize it, or extract information such as headlines, links, prices, or article text.',
      'Use Browser Control tools when a real browser is necessary, such as clicking, typing, submitting forms, logging in, following current page state, visually checking a page, or handling content unavailable through simple fetch.',
      'For Browser Control, work in small verified steps: open or inspect the page, act once, review the returned state, and continue only after checking the result. Prefer role or visible-text targets, use selectors for deterministic recovery, and use coordinates only as a last resort.',
      'Browser Control opens maximized. Click, type, and drag targets automatically scroll matched elements into view before acting, but use browser_scroll when you need to browse long pages or inspect content that is not currently visible.',
      'Use browser_drag for drag-and-drop, sliders, sortable items, game pieces, or any interaction that requires press-move-release rather than a click.',
      'Each conversation has its own Browser Control window. The Browser Control page persists across turns within the same conversation only. If the user asks you to continue or try again, inspect the current browser state before reopening the page.',
      'Use browser_open with external=true only when the user specifically wants the page opened in their default browser or needs their normal browser session; after external handoff, do not claim you can inspect or control that default-browser page.',
      'When providing self-contained HTML, CSS, or JavaScript for the user to copy or save, put it in a fenced Markdown code block with the correct language. Do not use Browser Control to create or preview generated local HTML unless the user explicitly asks you to preview it.',
      'Use Notion tools when the user asks to find, read, add to, or create content in their Notion pages or databases. When the target page or database is ambiguous, ask the user; never invent Notion IDs. Use notion_search to resolve a name to a Notion ID and (for databases) to learn its property schema, then notion_query_database to read rows with filters (e.g. upcoming tasks, incomplete items, items with a certain status). If a Notion call returns 404, tell the user to open the page in Notion via the "..." menu -> Connections -> add the integration, since integrations only see pages and databases where they were explicitly added.',
      'When web access is unnecessary, answer normally without calling a tool.',
      'After using a tool, answer the user with the result instead of repeating raw tool output verbatim.',
    ].join(' ')
  };
}

function parseToolArgumentsObject(
  toolName: string,
  rawArguments: Record<string, unknown> | string
): Record<string, unknown> {
  const parsed = typeof rawArguments === 'string'
    ? (() => {
      try {
        return JSON.parse(rawArguments);
      } catch {
        throw new Error(`${toolName} arguments must be valid JSON.`);
      }
    })()
    : rawArguments;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${toolName} arguments must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function parseFetchToolArgs(rawArguments: Record<string, unknown> | string): FetchToolArgs {
  const args = parseToolArgumentsObject('fetch_url', rawArguments);
  const url = typeof args.url === 'string' ? args.url.trim() : '';

  if (!url) {
    throw new Error('fetch_url requires a non-empty "url" string.');
  }

  return {
    url,
    maxChars: typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? args.maxChars : undefined,
    rawHtml: typeof args.rawHtml === 'boolean' ? args.rawHtml : undefined,
  };
}

function parseTavilySearchToolArgs(rawArguments: Record<string, unknown> | string): TavilySearchToolArgs {
  const args = parseToolArgumentsObject('tavily_search', rawArguments);
  const query = typeof args.query === 'string' ? args.query.trim() : '';

  if (!query) {
    throw new Error('tavily_search requires a non-empty "query" string.');
  }

  return {
    query,
    count: typeof args.count === 'number' && Number.isFinite(args.count) ? args.count : undefined,
    country: typeof args.country === 'string' ? args.country : undefined,
    searchDepth: typeof args.searchDepth === 'string' ? args.searchDepth : undefined,
    topic: typeof args.topic === 'string' ? args.topic : undefined,
    timeRange: typeof args.timeRange === 'string' ? args.timeRange : undefined,
  };
}

// Ollama's Gemini adapter currently rejects round-tripped tool calls because
// the follow-up request is missing provider-specific function call metadata.
function requiresToolResultSynthesis(model: string): boolean {
  return /\bgemini\b/i.test(model);
}

function logMainProcess(
  prefix: 'LLM' | 'BrowserControl',
  message: string,
  details?: Record<string, unknown>
): void {
  const label = `[${prefix}] ${message}`;
  if (details) {
    debugLog(label, details);
    return;
  }

  debugLog(label);
}

async function clearRegenerableAppCaches(): Promise<void> {
  const userDataPath = app.getPath('userData');

  await Promise.allSettled([
    session.defaultSession.clearCache(),
    ...REGENERABLE_CACHE_PATHS.map(relativePath =>
      fs.rm(path.join(userDataPath, relativePath), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
    ),
  ]).then(results => {
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
      console.warn('[Main] Some app cache cleanup tasks failed:', failures.map(failure => {
        const reason = failure.reason as NodeJS.ErrnoException;
        return {
          code: reason.code,
          path: reason.path,
          message: reason.message,
        };
      }));
    }
  });
}

function formatFetchToolResult(result: FetchToolResult): string {
  const lines = [
    result.success ? 'Fetch completed.' : 'Fetch failed.',
    `Requested URL: ${result.requestedUrl}`,
  ];

  if (result.finalUrl) {
    lines.push(`Final URL: ${result.finalUrl}`);
  }
  if (typeof result.status === 'number') {
    lines.push(`Status: ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
  }
  if (result.contentType) {
    lines.push(`Content type: ${result.contentType}`);
  }
  if (result.title) {
    lines.push(`Title: ${result.title}`);
  }
  if (result.truncated) {
    lines.push('Truncated: yes');
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  if (result.content) {
    lines.push(`Content:\n${result.content}`);
  }

  return lines.join('\n');
}

function formatBrowserControlResult(
  toolName: string,
  result: BrowserControlResult & { output?: string }
): string {
  const lines = [
    result.success ? 'Browser Control completed.' : 'Browser Control failed.',
    `Tool: ${toolName}`,
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  if (result.output) {
    lines.push(`Output:\n${result.output}`);
  }

  const state = result.state;
  if (state) {
    lines.push(`URL: ${state.url || '(blank)'}`);
    lines.push(`Title: ${state.title || '(untitled)'}`);
    lines.push(`Loading: ${state.loading ? 'yes' : 'no'}`);
    lines.push(`Active tab: ${state.activeTabId}`);
    if (state.lastAction) {
      lines.push(`Last action: ${state.lastAction.name} ${state.lastAction.success ? 'succeeded' : 'failed'}${state.lastAction.message ? ` (${state.lastAction.message})` : ''}`);
    }
    if (state.screenshotArtifact) {
      lines.push(`Screenshot: ${state.screenshotArtifact.path}`);
    }
    if (state.externalUrl) {
      lines.push(`External URL: ${state.externalUrl}`);
      lines.push('External browser control: unavailable');
    }
    if (state.visibleTextPreview) {
      lines.push(`Visible text preview:\n${state.visibleTextPreview}`);
    }
  }

  return lines.join('\n');
}

async function runBrowserControlTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<BrowserControlResult & { output?: string }> {
  const browserOptions = { signal, sessionId };

  if (toolName === 'browser_open') {
    if (typeof args.url !== 'string') {
      throw new Error('browser_open requires a URL string.');
    }
    return browserOpen(args.url, args.external === true, browserOptions);
  }

  if (toolName === 'browser_current_state') {
    return browserCurrentState(browserOptions);
  }

  if (toolName === 'browser_screenshot') {
    return browserScreenshot(args.persist === true, browserOptions);
  }

  if (toolName === 'browser_scroll') {
    const deltaX = typeof args.deltaX === 'number' && Number.isFinite(args.deltaX) ? args.deltaX : 0;
    const deltaY = typeof args.deltaY === 'number' && Number.isFinite(args.deltaY) ? args.deltaY : 800;
    return browserScroll(deltaX, deltaY, browserOptions);
  }

  if (toolName === 'browser_click') {
    return browserClick(args.target, browserOptions);
  }

  if (toolName === 'browser_drag') {
    return browserDrag(
      args.from,
      args.to,
      {
        durationMs: args.durationMs,
        steps: args.steps,
        holdMs: args.holdMs,
      },
      browserOptions,
    );
  }

  if (toolName === 'browser_type') {
    if (typeof args.text !== 'string') {
      throw new Error('browser_type requires a text string.');
    }
    return browserType(args.target, args.text, args.clear === true, browserOptions);
  }

  if (toolName === 'browser_wait') {
    const milliseconds = typeof args.milliseconds === 'number' && Number.isFinite(args.milliseconds)
      ? args.milliseconds
      : 1000;
    return browserWait(milliseconds, browserOptions);
  }

  if (toolName === 'browser_evaluate') {
    if (typeof args.script !== 'string') {
      throw new Error('browser_evaluate requires a script string.');
    }
    return browserEvaluate(args.script, browserOptions);
  }

  throw new Error(`Unknown Browser Control tool: ${toolName}`);
}

function formatTavilySearchToolResult(result: TavilySearchToolResult): string {
  const lines = [
    result.success ? 'Tavily search completed.' : 'Tavily search failed.',
    `Query: ${result.query}`,
    `Searched at: ${result.searchedAt}`,
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.answer) {
    lines.push(`Answer: ${result.answer}`);
  }
  if (result.responseTime !== undefined) {
    lines.push(`Response time: ${result.responseTime}`);
  }

  if (result.results?.length) {
    lines.push('Results:');
    result.results.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title}`);
      lines.push(`   URL: ${item.url}`);
      if (item.description) {
        lines.push(`   Snippet: ${item.description}`);
      }
      if (item.score !== undefined) {
        lines.push(`   Score: ${item.score}`);
      }
    });
  } else if (result.success) {
    lines.push('Results: none');
  }

  return lines.join('\n');
}

function createSearchSourceGroup(result: TavilySearchToolResult): SearchSourceGroup | null {
  if (!result.success || !result.results?.length) {
    return null;
  }

  const sources = result.results.slice(0, 5).map(toSearchSource);
  if (!sources.length) {
    return null;
  }

  return {
    id: randomUUID(),
    query: result.query,
    searchedAt: result.searchedAt,
    sources,
  };
}

function formatToolResultForSynthesis(toolMessage: ChatMessage, index: number): string {
  return [
    `Tool result ${index + 1} (${toolMessage.tool_name ?? 'tool'}):`,
    toolMessage.content,
  ].join('\n');
}

function buildToolResultSynthesisMessages(
  baseMessages: ChatMessage[],
  assistantMessage: ChatMessage | undefined,
  toolMessages: ChatMessage[]
): ChatMessage[] {
  const synthesisMessages = [...baseMessages];
  const assistantContent = assistantMessage?.content.trim();

  if (assistantContent) {
    synthesisMessages.push({
      role: 'assistant',
      content: assistantContent,
    });
  }

  synthesisMessages.push({
    role: 'system',
    content: [
      'A tool has already been executed for the latest user request.',
      'Use the tool results provided next to answer the user directly.',
      'Do not call more tools and do not mention internal tool mechanics unless the user explicitly asks.',
    ].join(' '),
  });
  synthesisMessages.push({
    role: 'user',
    content: [
      'Use these tool results to answer my previous request directly:',
      ...toolMessages.map((toolMessage, index) => formatToolResultForSynthesis(toolMessage, index)),
    ].join('\n\n'),
  });

  return synthesisMessages;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    frame: true,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  
  setMainWindow(mainWindow);
  attachMainWindowDiagnostics(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    showMainWindow();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    hideMainWindow();
  });
}

function attachMainWindowDiagnostics(window: BrowserWindow): void {
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Renderer] Failed to load:', { errorCode, errorDescription, url: validatedURL });
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Process gone:', details);
  });

  window.webContents.on('unresponsive', () => {
    console.error('[Renderer] Window became unresponsive');
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Renderer] Preload failed:', { preloadPath, error });
  });
}

function showMainWindow(): void {
  if (process.platform === 'darwin') {
    app.dock?.show();
  }
  mainWindow?.show();
  mainWindow?.focus();
}

function hideMainWindow(): void {
  mainWindow?.hide();
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../../assets/icon.png')
  );
  
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  
  tray.setToolTip('Jarvis');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      hideMainWindow();
    } else {
      showMainWindow();
    }
  });
}

ipcMain.handle('get-models', async () => {
  return await getAllModels();
});

ipcMain.handle('get-models-for-provider', async (_event, providerId: string) => {
  return await getModelsForProvider(providerId);
});

ipcMain.handle('get-providers', async () => {
  return getAvailableProviders();
});

ipcMain.handle('pick-attachment-paths', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: ATTACHMENT_DIALOG_FILTERS,
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths;
});

ipcMain.handle('read-attachments', async (_event, filePaths: unknown) => {
  if (!Array.isArray(filePaths) || filePaths.some(filePath => typeof filePath !== 'string')) {
    return { attachments: [], errors: ['Invalid attachment request.'] };
  }

  return readAttachments(filePaths);
});

ipcMain.handle('send-message-stream', async (event, request: SendMessageStreamRequest) => {
  let flushThinkingConsoleBuffer = (_reason: string) => undefined;
  let closeThinkingSection = (_reason: string) => undefined;
  const streamKey = request.assistantMessageId;
  const streamContext: StreamEventContext = {
    conversationId: request.conversationId,
    assistantMessageId: request.assistantMessageId,
  };

  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, ...args);
      } else {
        activeStreams.get(streamKey)?.abort();
      }
    } catch {
      activeStreams.get(streamKey)?.abort();
    }
  };

  try {
    const abortController = new AbortController();
    activeStreams.set(streamKey, abortController);
    let inThinking = false;
    let streamedTextLength = 0;
    let thinkingConsoleBuffer = '';

    const sendChatChunk = (chunk: string) => {
      streamedTextLength += chunk.length;
      const payload: StreamChunkEvent = { ...streamContext, chunk };
      sendToRenderer('ollama-chunk', payload);
    };

    const provider = getProvider(request.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${request.provider}`);
    }

    flushThinkingConsoleBuffer = (reason: string) => {
      const normalizedThinking = thinkingConsoleBuffer.trim();
      if (!normalizedThinking) {
        thinkingConsoleBuffer = '';
        return;
      }

      logMainProcess(
        'LLM',
        `Thinking block (${reason})\n${normalizedThinking}`,
        {
          conversationId: request.conversationId,
          model: request.model,
          characters: normalizedThinking.length,
        }
      );
      thinkingConsoleBuffer = '';
    };

    const emitStreamChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'thinking') {
        if (!inThinking) {
          sendChatChunk('Thinking...\n');
          inThinking = true;
        }
        thinkingConsoleBuffer += chunk.content;
        sendChatChunk(chunk.content);
        return;
      }

      if (inThinking) {
        flushThinkingConsoleBuffer('before-content');
        sendChatChunk('\n...done thinking.\n');
        inThinking = false;
      }

      sendChatChunk(chunk.content);
    };

    closeThinkingSection = (reason: string) => {
      if (!inThinking) {
        flushThinkingConsoleBuffer(reason);
        return;
      }

      flushThinkingConsoleBuffer(reason);
      sendChatChunk('\n...done thinking.\n');
      inThinking = false;
    };

    const baseMessages: ChatMessage[] = [
      await buildSystemPrompt(request.conversationId),
      ...request.messages,
    ];
    let tavilySearchCallsThisTurn = 0;
    let fetchUrlCallsThisTurn = 0;
    let notionCallsThisTurn = 0;

    let allModels: ModelInfo[] = [];
    try {
      allModels = await getAllModels();
    } catch (error) {
      console.error('[Context Compaction] Failed to load model list for context limit lookup:', error);
    }
    const selectedModelInfo = allModels.find((m) => m.id === request.model);
    const modelContextLength = selectedModelInfo?.contextLength;
    const contextThresholdTokens = getContextThresholdTokens(modelContextLength);

    while (true) {
      const estimatedTokens = estimateTotalTokens(baseMessages);
      if (estimatedTokens > contextThresholdTokens) {
        logMainProcess('LLM', 'Context window approaching limit; compacting conversation history', {
          conversationId: request.conversationId,
          model: request.model,
          estimatedTokens,
          contextThresholdTokens,
          modelContextLength: modelContextLength ?? 'default (128k)',
        });
        const preCompactionCount = baseMessages.length;
        const compacted = await compactMessagesIfNeeded(baseMessages, {
          provider,
          model: request.model,
          modelContextLength,
        });
        if (compacted.length < baseMessages.length || estimateTotalTokens(compacted) < estimatedTokens) {
          baseMessages.splice(0, baseMessages.length, ...compacted);
          logMainProcess('LLM', 'Conversation history compacted', {
            conversationId: request.conversationId,
            previousMessageCount: preCompactionCount,
            compactedMessageCount: compacted.length,
            estimatedTokensAfter: estimateTotalTokens(baseMessages),
          });
        }
      }

      const turnResult = await provider.streamChat(
        request.model,
        baseMessages,
        abortController,
        emitStreamChunk,
        { tools: CHAT_TOOLS, keepAlive: CHAT_MODEL_KEEP_ALIVE }
      );
      const assistantMessage = turnResult.assistantMessage;
      const toolCalls = assistantMessage?.tool_calls ?? [];
      if (!toolCalls.length) {
        closeThinkingSection('turn-complete');
        sendToRenderer('ollama-done', streamContext);
        return { success: true };
      }

      closeThinkingSection('before-tool-call');
      const toolResultMessages: ChatMessage[] = [];

      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'tavily_search') {
          if (tavilySearchCallsThisTurn >= MAX_TAVILY_SEARCH_CALLS_PER_TURN) {
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: [
                'Tavily search skipped.',
                `Error: Search limit reached for this user turn (${MAX_TAVILY_SEARCH_CALLS_PER_TURN}).`,
                'Use the existing search results to answer directly, or ask the user whether to run more searches.',
              ].join('\n'),
            });
            continue;
          }

          let args: TavilySearchToolArgs;
          try {
            args = parseTavilySearchToolArgs(toolCall.function.arguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid tavily_search arguments.';
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: `Tavily search failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          tavilySearchCallsThisTurn += 1;
          const searchResult = await tavilySearch(args);
          const searchContent = formatTavilySearchToolResult(searchResult);
          const sourceGroup = createSearchSourceGroup(searchResult);
          if (sourceGroup) {
            const payload: SearchSourcesEvent = {
              assistantMessageId: request.assistantMessageId,
              group: sourceGroup,
            };
            sendToRenderer('search-sources-event', payload);
          }
          logMainProcess('LLM', 'Tavily search result returned to LLM', {
            query: args.query,
            success: searchResult.success,
            resultCount: searchResult.results?.length,
            error: searchResult.error?.slice(0, 300),
          });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: searchContent,
          });
          continue;
        }

        if (toolCall.function.name === 'fetch_url') {
          if (fetchUrlCallsThisTurn >= MAX_FETCH_URL_CALLS_PER_TURN) {
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: [
                'Fetch skipped.',
                `Error: Fetch limit reached for this user turn (${MAX_FETCH_URL_CALLS_PER_TURN}).`,
                'Use the search snippets, previous fetch results, or cited source URLs to answer directly.',
              ].join('\n'),
            });
            continue;
          }

          let args: FetchToolArgs;
          try {
            args = parseFetchToolArgs(toolCall.function.arguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid fetch_url arguments.';
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: `Fetch failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          fetchUrlCallsThisTurn += 1;
          const fetchResult = await fetchUrlContent(args);
          const fetchContent = formatFetchToolResult(fetchResult);
          logMainProcess('LLM', 'Fetch tool result returned to LLM', {
            url: args.url,
            success: fetchResult.success,
            status: fetchResult.status,
            contentLength: fetchResult.content?.length ?? 0,
            error: fetchResult.error?.slice(0, 300),
            preview: fetchContent.slice(0, 600),
          });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: fetchContent,
          });
          continue;
        }

        if (BROWSER_CONTROL_TOOL_NAMES.has(toolCall.function.name)) {
          try {
            const args = parseToolArgumentsObject(toolCall.function.name, toolCall.function.arguments);
            const browserResult = await runBrowserControlTool(
              toolCall.function.name,
              args,
              abortController.signal,
              request.conversationId,
            );
            const browserContent = formatBrowserControlResult(toolCall.function.name, browserResult);
            logMainProcess('BrowserControl', 'Browser Control tool result returned to LLM', {
              tool: toolCall.function.name,
              success: browserResult.success,
              url: browserResult.state?.url,
              title: browserResult.state?.title,
              error: browserResult.error?.slice(0, 300),
            });
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: browserContent,
            });
          } catch (error) {
            if (isAbortLikeError(error)) {
              throw error;
            }
            const errorMessage = error instanceof Error ? error.message : 'Invalid Browser Control tool arguments.';
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: `Browser Control failed.\nTool: ${toolCall.function.name}\nError: ${errorMessage}`,
            });
          }
          continue;
        }

        if (NOTION_TOOL_NAMES.has(toolCall.function.name)) {
          if (notionCallsThisTurn >= MAX_NOTION_CALLS_PER_TURN) {
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: [
                'Notion tool skipped.',
                `Error: Notion call limit reached for this user turn (${MAX_NOTION_CALLS_PER_TURN}).`,
                'Use the results already returned to answer, or ask the user whether to continue with more Notion operations.',
              ].join('\n'),
            });
            continue;
          }

          notionCallsThisTurn += 1;
          try {
            const args = parseToolArgumentsObject(toolCall.function.name, toolCall.function.arguments);
            const notionContent = await runNotionTool(
              toolCall.function.name,
              args,
              abortController.signal,
            );
            logMainProcess('LLM', 'Notion tool result returned to LLM', {
              tool: toolCall.function.name,
              contentPreview: notionContent.slice(0, 600),
            });
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: notionContent,
            });
          } catch (error) {
            if (isAbortLikeError(error)) {
              throw error;
            }
            const errorMessage = error instanceof Error ? error.message : 'Invalid Notion tool arguments.';
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: `Notion failed.\nTool: ${toolCall.function.name}\nError: ${errorMessage}`,
            });
          }
          continue;
        }

        toolResultMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id || toolCall.function.name,
          tool_name: toolCall.function.name,
          content: `Unknown tool: ${toolCall.function.name}`,
        });
      }

      if (requiresToolResultSynthesis(request.model)) {
        logMainProcess('LLM', 'Using tool-result synthesis fallback', {
          conversationId: request.conversationId,
          model: request.model,
          toolCallCount: toolCalls.length,
        });
        let synthesisMessages = buildToolResultSynthesisMessages(baseMessages, assistantMessage, toolResultMessages);
        const synthesisEstimatedTokens = estimateTotalTokens(synthesisMessages);
        if (synthesisEstimatedTokens > contextThresholdTokens) {
          logMainProcess('LLM', 'Synthesis messages near context limit; compacting before fallback', {
            conversationId: request.conversationId,
            model: request.model,
            synthesisEstimatedTokens,
            contextThresholdTokens,
          });
          const compactedSynthesis = await compactMessagesIfNeeded(synthesisMessages, {
            provider,
            model: request.model,
            modelContextLength,
          });
          synthesisMessages = compactedSynthesis;
        }
        const synthesisResult = await provider.streamChat(
          request.model,
          synthesisMessages,
          abortController,
          emitStreamChunk,
          { tools: null, keepAlive: CHAT_MODEL_KEEP_ALIVE },
        );

        if (synthesisResult.assistantMessage?.tool_calls?.length) {
          logMainProcess('LLM', 'Ignoring unexpected tool calls during synthesis fallback', {
            conversationId: request.conversationId,
            model: request.model,
            toolCallCount: synthesisResult.assistantMessage.tool_calls.length,
          });
        }

        closeThinkingSection('tool-synthesis-complete');
        sendToRenderer('ollama-done', streamContext);
        return { success: true };
      }

      if (assistantMessage) {
        baseMessages.push(assistantMessage);
      }
      baseMessages.push(...toolResultMessages);
    }
  } catch (error) {
    flushThinkingConsoleBuffer('stream-error');
    if (isAbortLikeError(error)) {
      closeThinkingSection('stream-abort');
      sendToRenderer('ollama-done', streamContext);
      return { success: true, aborted: true };
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during streaming';
    const errorPayload: StreamErrorEvent = { ...streamContext, error: errorMessage };
    sendToRenderer('ollama-error', errorPayload);
    throw error;
  } finally {
    activeStreams.delete(streamKey);
  }
});

ipcMain.handle('stop-stream', async (_event, request: StopStreamRequest) => {
  activeStreams.get(request.assistantMessageId)?.abort();
  await closeBrowserControl(request.conversationId).catch((error) => {
    console.error('[BrowserControl] Failed to close Browser Control after stop:', error);
  });
  return { success: true };
});

registerVoiceFlowIPC();

ipcMain.handle('voice-model:status', async () => {
  return getLocalVoiceModelStatus();
});

ipcMain.handle('voice-model:install', async () => {
  const result = await installLocalVoiceModel();
  if (result.success) {
    await stopPythonService();
    void startPythonService().catch((error) => {
      console.error('[Main] Failed to restart Python voice service after local model install:', error);
    });
  }
  return result;
});

ipcMain.handle('store:load-conversations', async () => {
  return loadConversations();
});

ipcMain.handle('store:load-conversation-list', async () => {
  return loadConversationMetadata();
});

ipcMain.handle('store:load-conversation', async (_event, id: string) => {
  return loadConversation(id);
});

ipcMain.handle('store:load-conversations-by-id', async (_event, ids: string[]) => {
  return loadConversations(ids);
});

ipcMain.handle('store:save-conversations', async (_event, conversations: unknown) => {
  saveConversations(conversations as import('./store').SerializedConversation[]);
  return { success: true };
});

ipcMain.handle('store:save-conversation-list', async (_event, metadata: unknown) => {
  saveConversationMetadata(metadata as import('./store').SerializedConversationMetadata[]);
  return { success: true };
});

ipcMain.handle('store:save-conversation', async (_event, conversation: unknown) => {
  saveConversation(conversation as import('./store').SerializedConversation);
  return { success: true };
});

ipcMain.handle('store:delete-conversation', async (_event, id: string) => {
  await deleteConversation(id);
  return { success: true };
});

ipcMain.handle('store:load-folders', async () => {
  return loadFolders();
});

ipcMain.handle('store:save-folders', async (_event, folders: unknown) => {
  saveFolders(folders as import('./store').SerializedFolder[]);
  return { success: true };
});

ipcMain.handle('store:delete-folder', async (_event, id: string) => {
  deleteFolderAndConversations(id);
  return { success: true };
});

ipcMain.handle('store:load-model', async () => {
  return loadSelectedModel();
});

ipcMain.handle('store:save-model', async (_event, model: string) => {
  saveSelectedModel(model);
  return { success: true };
});

ipcMain.handle('store:load-provider', async () => {
  return loadSelectedProvider();
});

ipcMain.handle('store:save-provider', async (_event, provider: string) => {
  saveSelectedProvider(provider);
  return { success: true };
});

ipcMain.handle('store:load-opencode-go-api-key', async () => {
  return loadOpenCodeGoApiKey();
});

ipcMain.handle('store:save-opencode-go-api-key', async (_event, key: string) => {
  saveOpenCodeGoApiKey(key);
  setOpenCodeGoApiKey(key);
  return { success: true };
});

ipcMain.handle('store:load-openrouter-api-key', async () => {
  return loadOpenRouterApiKey();
});

ipcMain.handle('store:save-openrouter-api-key', async (_event, key: string) => {
  saveOpenRouterApiKey(key);
  setOpenRouterApiKey(key);
  process.env.OPENROUTER_API_KEY = key;
  return { success: true };
});

ipcMain.handle('store:load-open-tab-ids', async () => {
  return loadOpenTabIds();
});

ipcMain.handle('store:save-open-tab-ids', async (_event, tabIds: string[]) => {
  saveOpenTabIds(tabIds);
  return { success: true };
});

ipcMain.handle('store:load-current-conversation-id', async () => {
  return loadCurrentConversationId();
});

ipcMain.handle('store:save-current-conversation-id', async (_event, id: string | null) => {
  saveCurrentConversationId(id);
  return { success: true };
});

ipcMain.handle('store:load-conversation-drafts', async () => {
  return loadConversationDrafts();
});

ipcMain.handle('store:save-conversation-drafts', async (_event, drafts: Record<string, string>) => {
  saveConversationDrafts(drafts);
  return { success: true };
});

ipcMain.handle('dictionary:list', async () => {
  return listDictionaryEntries();
});

ipcMain.handle('dictionary:create', async (_event, input: CreateDictionaryEntryInput) => {
  return createDictionaryEntry(input);
});

ipcMain.handle('dictionary:update', async (_event, id: string, input: UpdateDictionaryEntryInput) => {
  return updateDictionaryEntry(id, input);
});

ipcMain.handle('dictionary:delete', async (_event, id: string) => {
  return deleteDictionaryEntry(id);
});

ipcMain.handle('dictionary:rule-create', async (_event, input: CreateReplacementRuleInput) => {
  return createReplacementRule(input);
});

ipcMain.handle('dictionary:rule-update', async (_event, id: string, input: UpdateReplacementRuleInput) => {
  return updateReplacementRule(id, input);
});

ipcMain.handle('dictionary:rule-delete', async (_event, id: string) => {
  return deleteReplacementRule(id);
});

ipcMain.handle('dictionary:candidate-update', async (_event, id: string, input: UpdateVocabularyCandidateInput) => {
  return updateVocabularyCandidate(id, input);
});

ipcMain.handle('generate-title', async (_event, message: string, model: string, providerId: string) => {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const result = await provider.sendChat(model, [
      { role: 'system', content: 'Generate a very short title (3-6 words) for a conversation that starts with the following message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.' },
      { role: 'user', content: message },
    ], { keepAlive: ONE_OFF_MODEL_KEEP_ALIVE });
    return result.trim();
  } catch (error) {
    console.error('Failed to generate title:', error);
    const words = message.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < message.split(' ').length ? '...' : '');
  }
});

ipcMain.on('set-theme-background', (_event, isDark: boolean) => {
  setOverlayThemeBackground(isDark);
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (win) {
    win.setBackgroundColor(isDark ? '#0a0a0a' : '#ffffff');
  }
});

function broadcastMenuAction(action: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(`menu:${action}`);
    }
  }
}

function buildAppMenu(): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Conversation',
        accelerator: 'CmdOrCtrl+N',
        click: () => broadcastMenuAction('new-conversation'),
      },
      { type: 'separator' },
      { role: 'close' },
    ],
  });

  template.push({ role: 'editMenu' });

  // View menu: standard items, with toggleDevTools only in dev.
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
  ];
  if (isDev) {
    viewSubmenu.push({ role: 'toggleDevTools' });
  }
  viewSubmenu.push({ type: 'separator' }, { role: 'togglefullscreen' });

  template.push({
    label: 'View',
    submenu: viewSubmenu,
  });

  template.push({
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(process.platform === 'darwin' ? [{ role: 'front' } as Electron.MenuItemConstructorOptions] : []),
    ],
  });

  return template;
}

app.whenReady().then(async () => {
  const savedOpenCodeGoApiKey = loadOpenCodeGoApiKey() || process.env.OPENCODE_GO_API_KEY || '';
  const savedOpenRouterApiKey = loadOpenRouterApiKey() || process.env.OPENROUTER_API_KEY || '';
  if (savedOpenRouterApiKey) {
    process.env.OPENROUTER_API_KEY = savedOpenRouterApiKey;
  }

  initializeProviders(
    savedOpenCodeGoApiKey,
    savedOpenRouterApiKey,
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu()));

  // Start in tray-only mode on macOS; the Dock icon appears when the main
  // window is shown (ready-to-show) and disappears again when it's hidden.
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  await clearRegenerableAppCaches();
  createTray();
  createWindow();
  
  infoLog('[Main] Starting Python voice service...');
  
  void startPythonService()
    .then((pythonStarted) => {
      if (!pythonStarted) {
        console.error('[Main] Failed to start Python voice service - voice features will not work');
      } else {
        infoLog('[Main] Python voice service started successfully');
      }
    })
    .catch((error) => {
      console.error('[Main] Error starting Python service:', error);
    });
  
  try {
    await initializeVoiceFlow();
    infoLog('[Main] Voice flow initialized');
  } catch (error) {
    console.error('[Main] Error initializing voice flow:', error);
  }
  infoLog('[Main] Browser Control is ready for assistant-directed browser tools');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (process.platform === 'darwin') {
    showMainWindow();
  }
});

async function shutdownApplicationServices(): Promise<void> {
  const results = await Promise.allSettled([
    cleanupVoiceFlow(),
    closeBrowserControl(),
    stopPythonService(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[Main] Failed to clean up a service during shutdown:', result.reason);
    }
  }
}

app.on('before-quit', (event) => {
  isQuitting = true;

  // Electron does not await async event listeners. Hold the quit open until
  // child services have actually stopped, otherwise Ctrl+C can orphan them.
  if (shutdownComplete) {
    return;
  }

  event.preventDefault();

  if (!shutdownPromise) {
    infoLog('[Main] Stopping application services...');
    shutdownPromise = shutdownApplicationServices().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  }
});

// Development runners such as concurrently forward terminal signals directly
// to Electron. Convert them into Electron's graceful quit path.
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
