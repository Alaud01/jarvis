export const DICTIONARY_TAB_ID = 'workspace:dictionary' as const;
export const USAGE_TAB_ID = 'workspace:usage' as const;
export const WORKSPACE_TAB_IDS = [DICTIONARY_TAB_ID, USAGE_TAB_ID] as const;
export const WORKSPACE_VIEWS = ['home', 'chat', 'dictionary', 'usage'] as const;

export const SCROLL_KEY_HOME = 'home' as const;
export const SCROLL_KEY_DICTIONARY = 'dictionary' as const;
export const SCROLL_KEY_USAGE = 'usage' as const;

export type WorkspaceView = typeof WORKSPACE_VIEWS[number];
export type WorkspaceTabId = typeof WORKSPACE_TAB_IDS[number];
export type WorkspaceTabView = Exclude<WorkspaceView, 'chat' | 'home'>;

export function isWorkspaceTabId(id: string): id is WorkspaceTabId {
  return WORKSPACE_TAB_IDS.includes(id as WorkspaceTabId);
}

export function isWorkspaceView(value: unknown): value is WorkspaceView {
  return typeof value === 'string' && (WORKSPACE_VIEWS as readonly string[]).includes(value);
}

export function isValidOpenTabId(id: string, validConversationIds: ReadonlySet<string>): boolean {
  return validConversationIds.has(id) || isWorkspaceTabId(id);
}

export function workspaceViewForTab(id: WorkspaceTabId): WorkspaceTabView {
  return id === DICTIONARY_TAB_ID ? 'dictionary' : 'usage';
}

export function workspaceTabForView(view: WorkspaceTabView): WorkspaceTabId {
  return view === 'dictionary' ? DICTIONARY_TAB_ID : USAGE_TAB_ID;
}

export function scrollKeyForConversation(conversationId: string | null): string {
  return conversationId ? `conversation:${conversationId}` : 'conversation:new';
}

export function visibleConversationIdForWorkspace(
  view: WorkspaceView | null,
  currentConversationId: string | null,
): string | null {
  return view === 'chat' ? currentConversationId : null;
}

export function resolveLastActiveTabId(options: {
  openTabIds: readonly string[];
  currentConversationId: string | null;
  validConversationIds: ReadonlySet<string>;
}): string | null {
  const { openTabIds, currentConversationId, validConversationIds } = options;

  if (
    currentConversationId
    && validConversationIds.has(currentConversationId)
    && openTabIds.includes(currentConversationId)
  ) {
    return currentConversationId;
  }

  return [...openTabIds]
    .reverse()
    .find(id => validConversationIds.has(id) || isWorkspaceTabId(id))
    ?? null;
}

export function resolveWorkspaceView(options: {
  storedView: unknown;
  openTabIds: readonly string[];
  currentConversationId: string | null;
  validConversationIds: ReadonlySet<string>;
}): WorkspaceView {
  const { storedView, openTabIds, currentConversationId, validConversationIds } = options;

  if (storedView === 'dictionary') {
    return 'dictionary';
  }

  if (storedView === 'usage') {
    return 'usage';
  }

  if (storedView === 'chat') {
    if (currentConversationId === null) {
      return 'chat';
    }
    if (validConversationIds.has(currentConversationId)) {
      return 'chat';
    }
  }

  if (storedView === 'home') {
    return 'home';
  }

  if (currentConversationId && validConversationIds.has(currentConversationId)) {
    return 'chat';
  }

  const fallbackTabId = [...openTabIds]
    .reverse()
    .find(id => validConversationIds.has(id) || isWorkspaceTabId(id));

  if (fallbackTabId && isWorkspaceTabId(fallbackTabId)) {
    return workspaceViewForTab(fallbackTabId);
  }

  if (fallbackTabId) {
    return 'chat';
  }

  return 'home';
}
