import type { SearchSource, SearchSourceGroup } from './search';

const CODEX_CITATION_PATTERN = /[ \t]*cite((?:turn\d+search\d+)(?:turn\d+search\d+)*)/g;
const CODEX_CITATION_REFERENCE_PATTERN = /turn(\d+)search(\d+)/g;

function getUniqueSources(groups: SearchSourceGroup[]): SearchSource[] {
  const sources: SearchSource[] = [];
  const seenUrls = new Set<string>();

  for (const group of groups) {
    for (const source of group.sources) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      sources.push(source);
    }
  }

  return sources;
}

function markdownLinkDestination(url: string): string {
  return url.replace(/</g, '%3C').replace(/>/g, '%3E');
}

/**
 * Converts Codex's private web-citation markers into ordinary Markdown links.
 *
 * Codex numbers `turnNsearchM` references by search call and result index. Jarvis
 * stores Tavily results in that same call order. If a private reference cannot
 * be resolved, omit it instead of leaking provider-specific control glyphs.
 */
export function renderCodexCitations(
  content: string,
  groups: SearchSourceGroup[] = [],
): string {
  const uniqueSources = getUniqueSources(groups);
  const sourceNumberByUrl = new Map(
    uniqueSources.map((source, index) => [source.url, index + 1]),
  );

  return content.replace(CODEX_CITATION_PATTERN, (_marker, references: string) => {
    const links: string[] = [];
    const seenUrls = new Set<string>();

    for (const match of references.matchAll(CODEX_CITATION_REFERENCE_PATTERN)) {
      const groupIndex = Number.parseInt(match[1], 10);
      const sourceIndex = Number.parseInt(match[2], 10);
      const source = groups[groupIndex]?.sources[sourceIndex];
      if (!source || seenUrls.has(source.url)) continue;

      const sourceNumber = sourceNumberByUrl.get(source.url);
      if (!sourceNumber) continue;
      seenUrls.add(source.url);
      links.push(`[${sourceNumber}](<${markdownLinkDestination(source.url)}>)`);
    }

    return links.length > 0 ? ` ${links.join(' ')}` : '';
  });
}
