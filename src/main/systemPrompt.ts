import type { ChatMessage } from './providers/types';
import { getNotionPromptStatusLine } from './notionMcpService';

export function formatLocalUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60).toString().padStart(2, '0');
  const minutes = (absoluteMinutes % 60).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export function buildTemporalContext(now = new Date()): string {
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

export async function buildSystemPrompt(_conversationId: string): Promise<ChatMessage> {
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
      getNotionPromptStatusLine(),
      'When web access is unnecessary, answer normally without calling a tool.',
      'After using a tool, answer the user with the result instead of repeating raw tool output verbatim.',
    ].join(' ')
  };
}
