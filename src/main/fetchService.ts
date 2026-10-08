import { lookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 50000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 45000;
const FETCH_USER_AGENT = 'Jarvis/1.0 (+desktop assistant fetch tool)';
const MIN_GLOBAL_FETCH_INTERVAL_MS = 900;
const MIN_DOMAIN_FETCH_INTERVAL_MS = 3000;
const MIN_RESPONSE_READ_BYTES = 256 * 1024;
const MAX_RESPONSE_READ_BYTES = 1024 * 1024;
const HARD_CONTENT_LENGTH_REJECT_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_POLICY_ERROR_CODE = 'ERR_FETCH_URL_NON_PUBLIC';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const FETCH_AVOID_HOST_PATTERNS = [
  /(^|\.)medium\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
];

const BOT_CHALLENGE_PATTERNS = [
  /we detected unusual activity/i,
  /automated \(?bot\)? activity/i,
  /verify you are human/i,
  /checking if the site connection is secure/i,
  /enable javascript and cookies/i,
  /captcha/i,
  /access denied/i,
];

let lastGlobalFetchAt = 0;
const lastFetchByHostname = new Map<string, number>();

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

export interface FetchToolArgs {
  url: string;
  maxChars?: number;
  rawHtml?: boolean;
}

export interface FetchToolResult {
  success: boolean;
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  fetchedAt: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampMaxChars(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.min(Math.max(Math.floor(value as number), 1000), MAX_MAX_CHARS);
}

function clampTimeoutMs(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(value as number), 1000), MAX_TIMEOUT_MS);
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error('fetch_url requires a non-empty "url" string.');
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('fetch_url only supports http and https URLs.');
  }

  assertPublicUrlTarget(url);

  return url.toString();
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function fetchPolicyError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = FETCH_POLICY_ERROR_CODE;
  return error;
}

export function isPublicIpAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export function assertPublicAddressSet(hostname: string, addresses: string[]): void {
  if (addresses.length === 0) {
    throw fetchPolicyError(`fetch_url could not resolve ${hostname}.`);
  }

  const blockedAddress = addresses.find(address => !isPublicIpAddress(address));
  if (blockedAddress) {
    throw fetchPolicyError(
      `fetch_url blocked ${hostname} because it resolves to a non-public network address.`
    );
  }
}

export function assertPublicUrlTarget(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw fetchPolicyError('fetch_url only supports http and https URLs.');
  }

  if (url.username || url.password) {
    throw fetchPolicyError('fetch_url does not allow credentials embedded in URLs.');
  }

  const hostname = normalizedHostname(url);
  if (!hostname) {
    throw fetchPolicyError('fetch_url requires a URL with a hostname.');
  }

  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw fetchPolicyError('fetch_url cannot access localhost or non-public network addresses.');
  }
}

export function resolvePublicRedirectUrl(currentUrl: string, location: string): string {
  const redirectUrl = new URL(location, currentUrl);
  assertPublicUrlTarget(redirectUrl);
  return redirectUrl.toString();
}

type SocketLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

const publicOnlyLookup: SocketLookup = (hostname, options, callback) => {
  const lookupOptions: LookupAllOptions = {
    ...options,
    all: true,
    verbatim: true,
  };

  lookup(hostname, lookupOptions, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }

    try {
      assertPublicAddressSet(hostname, addresses.map(address => address.address));
    } catch (policyError) {
      callback(policyError as NodeJS.ErrnoException, '', 0);
      return;
    }

    if (options.all) {
      callback(null, addresses);
      return;
    }

    const selected = addresses[0];
    callback(null, selected.address, selected.family);
  });
};

const publicFetchAgent = new Agent({
  connect: {
    lookup: publicOnlyLookup,
  },
});

function getHostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function shouldAvoidFetch(hostname: string): string | null {
  if (FETCH_AVOID_HOST_PATTERNS.some(pattern => pattern.test(hostname))) {
    return [
      `Skipping fetch for ${hostname}.`,
      'This site commonly blocks automated fetches or requires an interactive browser/session.',
      'Use the search result snippet, fetch an alternate source, or ask the user before opening it with browser automation.',
    ].join(' ');
  }

  return null;
}

async function waitForFetchBudget(hostname: string): Promise<void> {
  const now = Date.now();
  const globalWaitMs = Math.max(0, MIN_GLOBAL_FETCH_INTERVAL_MS - (now - lastGlobalFetchAt));
  const lastDomainFetchAt = lastFetchByHostname.get(hostname) ?? 0;
  const domainWaitMs = Math.max(0, MIN_DOMAIN_FETCH_INTERVAL_MS - (now - lastDomainFetchAt));
  const waitMs = Math.max(globalWaitMs, domainWaitMs);

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const nextFetchAt = Date.now();
  lastGlobalFetchAt = nextFetchAt;
  lastFetchByHostname.set(hostname, nextFetchAt);
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();

    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITY_MAP[normalized] ?? match;
  });
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ');
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(javascript:|mailto:|tel:|#)/i.test(trimmed)) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractTitleFromHtml(html: string): string | undefined {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    return undefined;
  }

  const title = collapseWhitespace(decodeHtmlEntities(stripHtmlTags(titleMatch[1])));
  return title || undefined;
}

function truncateContent(input: string, maxChars: number): { content: string; truncated: boolean } {
  if (input.length <= maxChars) {
    return { content: input, truncated: false };
  }

  let truncated = input.slice(0, maxChars);
  const lastParagraphBreak = truncated.lastIndexOf('\n\n');
  const lastLineBreak = truncated.lastIndexOf('\n');
  const breakIndex = Math.max(lastParagraphBreak, lastLineBreak);

  if (breakIndex > maxChars * 0.6) {
    truncated = truncated.slice(0, breakIndex);
  }

  return {
    content: `${truncated.trim()}\n\n[Content truncated after ${maxChars} characters]`,
    truncated: true,
  };
}

function htmlToReadableText(html: string, baseUrl: string): { title?: string; content: string } {
  const title = extractTitleFromHtml(html);
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;

  const withLinks = body.replace(
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, doubleQuotedHref: string | undefined, singleQuotedHref: string | undefined, innerHtml: string) => {
      const href = doubleQuotedHref ?? singleQuotedHref ?? '';
      const absoluteUrl = resolveUrl(href, baseUrl);
      const text = collapseWhitespace(decodeHtmlEntities(stripHtmlTags(innerHtml)));

      if (!text) {
        return absoluteUrl ? ` ${absoluteUrl} ` : ' ';
      }

      return absoluteUrl ? ` [${text}](${absoluteUrl}) ` : ` ${text} `;
    }
  );

  const blockSeparated = withLinks
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\s*\/(?:p|div|section|article|aside|header|footer|nav|main|ul|ol|table|tr|blockquote|pre|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const content = collapseWhitespace(decodeHtmlEntities(blockSeparated));
  if (!title) {
    return { content };
  }

  if (content.startsWith(title)) {
    return { title, content };
  }

  return {
    title,
    content: collapseWhitespace(`${title}\n\n${content}`),
  };
}

function inferContentType(contentTypeHeader: string | null, content: string): string | undefined {
  const normalizedHeader = contentTypeHeader?.split(';')[0]?.trim();
  if (normalizedHeader) {
    return normalizedHeader;
  }

  if (/^\s*</.test(content)) {
    return 'text/html';
  }

  return undefined;
}

function getResponseReadByteLimit(maxChars: number): number {
  return Math.min(
    MAX_RESPONSE_READ_BYTES,
    Math.max(MIN_RESPONSE_READ_BYTES, maxChars * 12)
  );
}

function parseContentLength(headers: Headers): number | null {
  const rawContentLength = headers.get('content-length');
  if (!rawContentLength) {
    return null;
  }

  const contentLength = Number.parseInt(rawContentLength, 10);
  return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
}

async function readResponseTextWithLimit(response: Response, byteLimit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remainingBytes = byteLimit - bytesRead;
      if (remainingBytes <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength > remainingBytes) {
        text += decoder.decode(value.slice(0, remainingBytes), { stream: true });
        bytesRead += remainingBytes;
        truncated = true;
        await reader.cancel();
        break;
      }

      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }

    text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

function detectBotChallenge(content: string, status?: number): string | null {
  const sample = content.slice(0, 12000);
  const matched = BOT_CHALLENGE_PATTERNS.some(pattern => pattern.test(sample));
  if (!matched) {
    return null;
  }

  const statusPrefix = typeof status === 'number' ? `Site returned HTTP ${status} and ` : 'Site ';
  return `${statusPrefix}appears to be showing an anti-bot or verification challenge. Do not retry this URL repeatedly; use search snippets or another source.`;
}

function findFetchPolicyMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as NodeJS.ErrnoException & { cause?: unknown };
    if (candidate.code === FETCH_POLICY_ERROR_CODE) {
      return candidate.message;
    }
    current = candidate.cause;
  }

  return undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect bodies are intentionally discarded before the next validated hop.
  }
}

async function fetchPublicResponse(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const target = new URL(currentUrl);
    assertPublicUrlTarget(target);

    const hostname = getHostname(currentUrl);
    const avoidReason = shouldAvoidFetch(hostname);
    if (avoidReason) {
      throw new Error(avoidReason);
    }

    await waitForFetchBudget(hostname);
    const response = await undiciFetch(target, {
      method: 'GET',
      redirect: 'manual',
      dispatcher: publicFetchAgent,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
        'User-Agent': FETCH_USER_AGENT,
      },
      signal,
    });

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (redirectCount === MAX_REDIRECTS) {
      await cancelResponseBody(response);
      throw new Error(`fetch_url stopped after ${MAX_REDIRECTS} redirects.`);
    }

    const nextUrl = resolvePublicRedirectUrl(currentUrl, location);
    await cancelResponseBody(response);
    currentUrl = nextUrl;
  }

  throw new Error(`fetch_url stopped after ${MAX_REDIRECTS} redirects.`);
}

export async function fetchUrlContent(args: FetchToolArgs, signal?: AbortSignal): Promise<FetchToolResult> {
  signal?.throwIfAborted();
  const fetchedAt = new Date().toISOString();
  let requestedUrl = args.url;

  try {
    requestedUrl = normalizeUrl(args.url);
  } catch (error) {
    return {
      success: false,
      requestedUrl,
      fetchedAt,
      error: error instanceof Error ? error.message : 'Invalid URL.',
    };
  }

  const hostname = getHostname(requestedUrl);
  const avoidReason = shouldAvoidFetch(hostname);
  if (avoidReason) {
    return {
      success: false,
      requestedUrl,
      fetchedAt,
      error: avoidReason,
    };
  }

  const maxChars = clampMaxChars(args.maxChars);
  const responseReadByteLimit = getResponseReadByteLimit(maxChars);
  const timeoutMs = clampTimeoutMs();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchPublicResponse(requestedUrl, signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal);

    const finalUrl = response.url || requestedUrl;
    const contentLength = parseContentLength(response.headers);
    const contentTypeHeader = response.headers.get('content-type');
    const headerContentType = contentTypeHeader?.split(';')[0]?.trim();

    if (contentLength !== null && contentLength > HARD_CONTENT_LENGTH_REJECT_BYTES) {
      return {
        success: false,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType: headerContentType,
        fetchedAt,
        error: `Response is too large to fetch safely (${contentLength} bytes; limit is ${HARD_CONTENT_LENGTH_REJECT_BYTES} bytes).`,
      };
    }

    const unsupportedContentType = headerContentType
      && !/html|xhtml/i.test(headerContentType)
      && !/(application|text)\/([a-z0-9.+-]*\+)?json/i.test(headerContentType)
      && !/^text\//i.test(headerContentType)
      && !/xml/i.test(headerContentType);

    if (unsupportedContentType) {
      return {
        success: false,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType: headerContentType,
        fetchedAt,
        error: `Unsupported content type: ${headerContentType}`,
      };
    }

    const rawRead = await readResponseTextWithLimit(response, responseReadByteLimit);
    const rawBody = rawRead.text;
    const contentType = inferContentType(response.headers.get('content-type'), rawBody);
    const botChallengeError = detectBotChallenge(rawBody, response.status);

    if (botChallengeError) {
      return {
        success: false,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        title: contentType && /html|xhtml/i.test(contentType) ? extractTitleFromHtml(rawBody) : undefined,
        fetchedAt,
        error: botChallengeError,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        fetchedAt,
        error: `Request failed with status ${response.status} ${response.statusText}`.trim(),
      };
    }

    if (args.rawHtml) {
      const truncated = truncateContent(rawBody, maxChars);
      return {
        success: true,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        title: extractTitleFromHtml(rawBody),
        content: truncated.content,
        truncated: rawRead.truncated || truncated.truncated,
        fetchedAt,
      };
    }

    let content = rawBody;
    let title: string | undefined;

    if (contentType && /html|xhtml/i.test(contentType)) {
      const readable = htmlToReadableText(rawBody, finalUrl);
      content = readable.content;
      title = readable.title;
    } else if (contentType && /(application|text)\/([a-z0-9.+-]*\+)?json/i.test(contentType)) {
      try {
        content = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        content = rawBody;
      }
    } else if (!contentType || /^text\//i.test(contentType) || /xml/i.test(contentType)) {
      content = rawBody;
    } else {
      return {
        success: false,
        requestedUrl,
        finalUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        fetchedAt,
        error: `Unsupported content type: ${contentType}`,
      };
    }

    const truncated = truncateContent(content, maxChars);
    return {
      success: true,
      requestedUrl,
      finalUrl,
      status: response.status,
      statusText: response.statusText,
      contentType,
      title,
      content: truncated.content,
      truncated: rawRead.truncated || truncated.truncated,
      fetchedAt,
    };
  } catch (error) {
    signal?.throwIfAborted();
    const policyMessage = findFetchPolicyMessage(error);
    const errorMessage = policyMessage
      ?? (error instanceof DOMException && error.name === 'AbortError'
      ? `Fetch timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message === 'fetch failed'
          ? 'Fetch failed. The URL may be unreachable, blocked, or unavailable from the current network environment.'
          : error.message
        : 'Unknown fetch error.');

    return {
      success: false,
      requestedUrl,
      fetchedAt,
      error: errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
