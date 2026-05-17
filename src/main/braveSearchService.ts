import type { SearchSource } from '../shared/search';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_TIMEOUT_MS = 30000;

export interface BraveSearchToolArgs {
  query: string;
  count?: number;
  country?: string;
  searchLang?: string;
  freshness?: string;
}

export interface BraveSearchResultItem {
  title: string;
  url: string;
  domain: string;
  description?: string;
  age?: string;
  language?: string;
  familyFriendly?: boolean;
  profileName?: string;
  faviconUrl?: string;
  extraSnippets?: string[];
}

export interface BraveSearchToolResult {
  success: boolean;
  query: string;
  searchedAt: string;
  results?: BraveSearchResultItem[];
  error?: string;
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
      age?: unknown;
      language?: unknown;
      family_friendly?: unknown;
      extra_snippets?: unknown;
      meta_url?: {
        hostname?: unknown;
        netloc?: unknown;
      };
      profile?: {
        name?: unknown;
        long_name?: unknown;
        img?: unknown;
      };
    }>;
  };
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

function buildBraveSearchUrl(args: BraveSearchToolArgs): string {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set('q', args.query);
  url.searchParams.set('count', String(clampCount(args.count)));

  const country = normalizeOptionalToken(args.country);
  if (country) {
    url.searchParams.set('country', country);
  }

  const searchLang = normalizeOptionalToken(args.searchLang);
  if (searchLang) {
    url.searchParams.set('search_lang', searchLang);
  }

  const freshness = normalizeOptionalToken(args.freshness);
  if (freshness) {
    url.searchParams.set('freshness', freshness);
  }

  url.searchParams.set('extra_snippets', 'true');
  url.searchParams.set('text_decorations', 'false');

  return url.toString();
}

function getBraveApiKey(): string | null {
  const key = process.env.BRAVE_KEY?.trim();
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

function mapBraveResults(data: BraveWebSearchResponse): BraveSearchResultItem[] {
  return (data.web?.results ?? [])
    .map((result): BraveSearchResultItem | null => {
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      const url = typeof result.url === 'string' ? result.url.trim() : '';

      if (!title || !url) {
        return null;
      }

      const metaHostname = typeof result.meta_url?.hostname === 'string'
        ? result.meta_url.hostname.trim()
        : typeof result.meta_url?.netloc === 'string'
          ? result.meta_url.netloc.trim()
          : '';
      const profileName = typeof result.profile?.long_name === 'string'
        ? result.profile.long_name.trim()
        : typeof result.profile?.name === 'string'
          ? result.profile.name.trim()
          : undefined;
      const extraSnippets = Array.isArray(result.extra_snippets)
        ? result.extra_snippets
          .filter((snippet): snippet is string => typeof snippet === 'string')
          .map(snippet => snippet.trim())
          .filter(Boolean)
        : undefined;

      return {
        title,
        url,
        domain: metaHostname || getHostnameFromUrl(url),
        description: typeof result.description === 'string' ? result.description.trim() : undefined,
        age: typeof result.age === 'string' ? result.age.trim() : undefined,
        language: typeof result.language === 'string' ? result.language.trim() : undefined,
        familyFriendly: typeof result.family_friendly === 'boolean' ? result.family_friendly : undefined,
        profileName,
        faviconUrl: normalizeUrl(result.profile?.img),
        extraSnippets,
      };
    })
    .filter((result): result is BraveSearchResultItem => result !== null);
}

export function toSearchSource(item: BraveSearchResultItem): SearchSource {
  return {
    title: item.title,
    url: item.url,
    domain: item.domain,
    snippet: item.description,
    age: item.age,
    profileName: item.profileName,
    faviconUrl: item.faviconUrl,
  };
}

async function parseBraveError(response: Response): Promise<string> {
  const fallback = response.statusText.trim() || `HTTP ${response.status}`;

  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(trimmed) as { error?: { detail?: unknown; code?: unknown } };
      const detail = typeof parsed.error?.detail === 'string' ? parsed.error.detail.trim() : '';
      const code = typeof parsed.error?.code === 'string' ? parsed.error.code.trim() : '';
      return [code, detail].filter(Boolean).join(': ') || trimmed;
    } catch {
      return trimmed;
    }
  } catch {
    return fallback;
  }
}

export async function braveSearch(args: BraveSearchToolArgs): Promise<BraveSearchToolResult> {
  const searchedAt = new Date().toISOString();
  const query = args.query.trim();

  if (!query) {
    return {
      success: false,
      query,
      searchedAt,
      error: 'Brave search requires a non-empty query.',
    };
  }

  const apiKey = getBraveApiKey();
  if (!apiKey) {
    return {
      success: false,
      query,
      searchedAt,
      error: 'BRAVE_KEY is not configured in the environment.',
    };
  }

  const abortController = new AbortController();
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(buildBraveSearchUrl({ ...args, query }), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        query,
        searchedAt,
        error: `Brave search failed (${response.status}): ${await parseBraveError(response)}`,
      };
    }

    const data = (await response.json()) as BraveWebSearchResponse;
    return {
      success: true,
      query,
      searchedAt,
      results: mapBraveResults(data),
    };
  } catch (error) {
    const errorMessage = error instanceof DOMException && error.name === 'AbortError'
      ? `Brave search timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message
        : 'Unknown Brave search error.';

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
