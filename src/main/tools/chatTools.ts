import type { ToolDefinition } from '../providers/types';
import { getNotionToolDefinitions } from '../notionMcpService';

export const MAX_TAVILY_SEARCH_CALLS_PER_TURN = 5;
export const MAX_FETCH_URL_CALLS_PER_TURN = 5;
export const MAX_NOTION_CALLS_PER_TURN = 16;

const STATIC_CHAT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'tavily_search',
      description: 'Search the live public web with Tavily and return ranked source results with URLs and snippets. Use only when the user explicitly asks for web search, the answer depends on information that may have changed recently, reliable sources are required, or you have a meaningful knowledge gap. Do not search for stable facts or topics you already know well enough to answer accurately. Prefer answering from search snippets when they are enough; only use fetch_url on one or two high-value primary sources if you need full page text.',
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
];

export const CHAT_TOOLS: ToolDefinition[] = STATIC_CHAT_TOOLS.filter(
  tool => !tool.function.name.startsWith('notion_'),
);

export function getChatTools(): ToolDefinition[] {
  return [...CHAT_TOOLS, ...getNotionToolDefinitions()];
}

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
