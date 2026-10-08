export const WORKSPACE_VIEWS = ['chat', 'dictionary', 'usage', 'recently-deleted'] as const;

export const SCROLL_KEY_DICTIONARY = 'dictionary' as const;
export const SCROLL_KEY_USAGE = 'usage' as const;

export type WorkspaceView = typeof WORKSPACE_VIEWS[number];

export function isWorkspaceView(value: unknown): value is WorkspaceView {
  return typeof value === 'string' && (WORKSPACE_VIEWS as readonly string[]).includes(value);
}

export function resolveWorkspaceView(storedView: unknown): WorkspaceView {
  return isWorkspaceView(storedView) ? storedView : 'chat';
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
