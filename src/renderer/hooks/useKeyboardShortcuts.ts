import { useEffect } from 'react';

interface UseKeyboardShortcutsArgs {
  onSearch: () => void;
  onNewChat: () => void;
  onToggleSidebar: () => void;
  onDeleteCurrentConversation: () => void;
  tabIds: string[];
  onTabSelect: (id: string) => void;
  workspaceView: 'home' | 'chat' | 'dictionary' | 'usage';
  hasCurrentConversation: boolean;
}

function getTabShortcutIndex(key: string): number | null {
  if (key >= '1' && key <= '9') return Number(key) - 1;
  if (key === '0') return 9;
  return null;
}

export function useKeyboardShortcuts({
  onSearch,
  onNewChat,
  onToggleSidebar,
  onDeleteCurrentConversation,
  tabIds,
  onTabSelect,
  workspaceView,
  hasCurrentConversation,
}: UseKeyboardShortcutsArgs): void {
  useEffect(() => {
    const handleKeyboardShortcut = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey) {
        const tabIndex = getTabShortcutIndex(e.key);
        const tabId = tabIndex === null ? null : tabIds[tabIndex];
        if (tabId) {
          e.preventDefault();
          onTabSelect(tabId);
          return;
        }
      }

      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (workspaceView === 'chat') {
          e.preventDefault();
          onSearch();
        }
        return;
      }
      if (e.metaKey && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        onNewChat();
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        onToggleSidebar();
      }
      if (e.metaKey && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        if (hasCurrentConversation) {
          onDeleteCurrentConversation();
        }
      }
    };
    window.addEventListener('keydown', handleKeyboardShortcut);
    return () => window.removeEventListener('keydown', handleKeyboardShortcut);
  }, [onSearch, onNewChat, onToggleSidebar, onDeleteCurrentConversation, tabIds, onTabSelect, workspaceView, hasCurrentConversation]);

  useEffect(() => {
    if (!window.assistant?.onMenuNewConversation) return;
    return window.assistant.onMenuNewConversation(() => onNewChat());
  }, [onNewChat]);
}
