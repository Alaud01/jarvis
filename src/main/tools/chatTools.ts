import type { ToolDefinition } from '../providers/types';

export const MAX_TAVILY_SEARCH_CALLS_PER_TURN = 5;
export const MAX_FETCH_URL_CALLS_PER_TURN = 5;
export const MAX_NOTION_CALLS_PER_TURN = 8;

export const CHAT_TOOLS: ToolDefinition[] = [
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

export const BROWSER_CONTROL_TOOL_NAMES = new Set([
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

export const NOTION_TOOL_NAMES = new Set([
  'notion_search',
  'notion_query_database',
  'notion_create_page',
  'notion_append_block',
]);