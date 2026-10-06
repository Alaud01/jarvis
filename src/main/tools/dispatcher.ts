import { randomUUID } from 'crypto';
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
  type BrowserControlResult,
} from '../browserControlService';
import type { FetchToolArgs, FetchToolResult } from '../fetchService';
import type { TavilySearchToolArgs, TavilySearchToolResult } from '../tavilySearchService';
import { toSearchSource } from '../tavilySearchService';
import type { SearchSourceGroup } from '../../shared/search';
import type { ChatMessage } from '../providers/types';

export function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

export function parseToolArgumentsObject(
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

export function parseFetchToolArgs(rawArguments: Record<string, unknown> | string): FetchToolArgs {
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

export function parseTavilySearchToolArgs(rawArguments: Record<string, unknown> | string): TavilySearchToolArgs {
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
export function requiresToolResultSynthesis(model: string): boolean {
  return /\bgemini\b/i.test(model);
}

export function formatFetchToolResult(result: FetchToolResult): string {
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

export function formatBrowserControlResult(
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
      lines.push('Screenshot: captured and saved as a local artifact (image attached).');
    } else if (result.imageDataUrl) {
      lines.push('Screenshot: captured (image attached).');
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

export function formatTavilySearchToolResult(result: TavilySearchToolResult): string {
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

export function createSearchSourceGroup(result: TavilySearchToolResult): SearchSourceGroup | null {
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

export function buildToolResultSynthesisMessages(
  baseMessages: ChatMessage[],
  assistantMessage: ChatMessage | undefined,
  toolMessages: ChatMessage[]
): ChatMessage[] {
  const synthesisMessages = [...baseMessages];
  const assistantContent = assistantMessage?.content.trim();
  const toolImages = toolMessages.flatMap(toolMessage => (toolMessage.images ?? []).map((image, index) => ({
    image,
    mimeType: toolMessage.imageMimeTypes?.[index],
  })));

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
    ...(toolImages.length ? {
      images: toolImages.map(({ image }) => image),
      imageMimeTypes: toolImages.map(({ mimeType }) => mimeType ?? 'image/png'),
    } : {}),
  });

  return synthesisMessages;
}

export async function runBrowserControlTool(
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
