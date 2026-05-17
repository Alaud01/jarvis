export interface SearchSource {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  age?: string;
  profileName?: string;
  faviconUrl?: string;
}

export interface SearchSourceGroup {
  id: string;
  query: string;
  searchedAt: string;
  sources: SearchSource[];
}

export interface SearchSourcesEvent {
  assistantMessageId: string;
  group: SearchSourceGroup;
}
