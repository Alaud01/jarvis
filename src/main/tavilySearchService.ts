import type { SearchSource } from '../shared/search';

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_TIMEOUT_MS = 30000;
const COUNTRY_CODE_ALIASES: Record<string, string> = {
  au: 'australia',
  ca: 'canada',
  de: 'germany',
  fr: 'france',
  gb: 'united kingdom',
  in: 'india',
  jp: 'japan',
  mx: 'mexico',
  us: 'united states',
};

export interface TavilySearchToolArgs {
  query: string;
  count?: number;
  country?: string;
  searchDepth?: string;
  topic?: string;
  timeRange?: string;
}

export interface TavilySearchResultItem {
  title: string;
  url: string;
  domain: string;
  description?: string;
  score?: number;
  faviconUrl?: string;
}

export interface TavilySearchToolResult {
  success: boolean;
  query: string;
  searchedAt: string;
  answer?: string;
  responseTime?: string | number;
  results?: TavilySearchResultItem[];
  error?: string;
}

interface TavilySearchResponse {
  query?: unknown;
  answer?: unknown;
  response_time?: unknown;
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
    favicon?: unknown;
  }>;
}

function clampCount(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_COUNT;
  }

  return Math.min(Math.max(Math.floor(value as number), 1), MAX_COUNT);
}

function normalizeOptionalToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function getTavilyApiKey(): string | null {
  const key = process.env.TAVILY_KEY?.trim();
  return key || null;
}

function getHostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return value;
  }
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeCountry(value: unknown): string | undefined {
  const country = normalizeOptionalToken(value);
  if (!country) {
    return undefined;
  }

  const normalized = country.toLowerCase();
  return COUNTRY_CODE_ALIASES[normalized] ?? normalized;
}

function normalizeSearchDepth(value: unknown): string | undefined {
  const searchDepth = normalizeOptionalToken(value);
  if (!searchDepth) {
    return undefined;
  }

  return ['advanced', 'basic', 'fast', 'ultra-fast'].includes(searchDepth)
    ? searchDepth
    : undefined;
}

function normalizeTopic(value: unknown): string | undefined {
  const topic = normalizeOptionalToken(value);
  if (!topic) {
    return undefined;
  }

  return ['general', 'news', 'finance'].includes(topic) ? topic : undefined;
}

function normalizeTimeRange(value: unknown): string | undefined {
  const timeRange = normalizeOptionalToken(value);
  if (!timeRange) {
    return undefined;
  }

  return ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'].includes(timeRange)
    ? timeRange
    : undefined;
}

function buildTavilySearchBody(args: TavilySearchToolArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: args.query,
    max_results: clampCount(args.count),
    search_depth: normalizeSearchDepth(args.searchDepth) ?? 'basic',
    include_answer: false,
    include_favicon: true,
  };

  const country = normalizeCountry(args.country);
  if (country) {
    body.country = country;
  }

  const topic = normalizeTopic(args.topic);
  if (topic) {
    body.topic = topic;
  }

  const timeRange = normalizeTimeRange(args.timeRange);
  if (timeRange) {
    body.time_range = timeRange;
  }

  return body;
}

function mapTavilyResults(data: TavilySearchResponse): TavilySearchResultItem[] {
  return (data.results ?? [])
    .map((result): TavilySearchResultItem | null => {
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      const url = normalizeUrl(result.url);

      if (!title || !url) {
        return null;
      }

      return {
        title,
        url,
        domain: getHostnameFromUrl(url),
        description: typeof result.content === 'string' ? result.content.trim() : undefined,
        score: typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : undefined,
        faviconUrl: normalizeUrl(result.favicon),
      };
    })
    .filter((result): result is TavilySearchResultItem => result !== null);
}

export function toSearchSource(item: TavilySearchResultItem): SearchSource {
  return {
    title: item.title,
    url: item.url,
    domain: item.domain,
    snippet: item.description,
    faviconUrl: item.faviconUrl,
  };
}

async function parseTavilyError(response: Response): Promise<string> {
  const fallback = response.statusText.trim() || `HTTP ${response.status}`;

  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; detail?: unknown; message?: unknown };
      const error = typeof parsed.error === 'string' ? parsed.error.trim() : '';
      const detail = typeof parsed.detail === 'string' ? parsed.detail.trim() : '';
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      return [error, detail, message].filter(Boolean).join(': ') || trimmed;
    } catch {
      return trimmed;
    }
  } catch {
    return fallback;
  }
}

export async function tavilySearch(args: TavilySearchToolArgs): Promise<TavilySearchToolResult> {
  const searchedAt = new Date().toISOString();
  const query = args.query.trim();

  if (!query) {
    return {
      success: false,
      query,
      searchedAt,
      error: 'Tavily search requires a non-empty query.',
    };
  }

  const apiKey = getTavilyApiKey();
  if (!apiKey) {
    return {
      success: false,
      query,
      searchedAt,
      error: 'TAVILY_KEY is not configured in the environment.',
    };
  }

  const abortController = new AbortController();
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTavilySearchBody({ ...args, query })),
      signal: abortController.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        query,
        searchedAt,
        error: `Tavily search failed (${response.status}): ${await parseTavilyError(response)}`,
      };
    }

    const data = (await response.json()) as TavilySearchResponse;
    return {
      success: true,
      query: typeof data.query === 'string' && data.query.trim() ? data.query.trim() : query,
      searchedAt,
      answer: typeof data.answer === 'string' ? data.answer.trim() : undefined,
      responseTime: typeof data.response_time === 'string' || typeof data.response_time === 'number'
        ? data.response_time
        : undefined,
      results: mapTavilyResults(data),
    };
  } catch (error) {
    const errorMessage = error instanceof DOMException && error.name === 'AbortError'
      ? `Tavily search timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message
        : 'Unknown Tavily search error.';

    return {
      success: false,
      query,
      searchedAt,
      error: errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
