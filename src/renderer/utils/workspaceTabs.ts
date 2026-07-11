export const DICTIONARY_TAB_ID = 'workspace:dictionary' as const;
export const USAGE_TAB_ID = 'workspace:usage' as const;
export const WORKSPACE_TAB_IDS = [DICTIONARY_TAB_ID, USAGE_TAB_ID] as const;

export type WorkspaceView = 'chat' | 'dictionary' | 'usage';
export type WorkspaceTabId = typeof WORKSPACE_TAB_IDS[number];

export function isWorkspaceTabId(id: string): id is WorkspaceTabId {
  return WORKSPACE_TAB_IDS.includes(id as WorkspaceTabId);
}

export function workspaceViewForTab(id: WorkspaceTabId): Exclude<WorkspaceView, 'chat'> {
  return id === DICTIONARY_TAB_ID ? 'dictionary' : 'usage';
}

export function workspaceTabForView(view: Exclude<WorkspaceView, 'chat'>): WorkspaceTabId {
  return view === 'dictionary' ? DICTIONARY_TAB_ID : USAGE_TAB_ID;
}
