import { useEffect } from 'react';
import type { WorkspaceView } from '../../shared/workspaceViews';

interface UseKeyboardShortcutsArgs {
  onSearch: () => void;
  onNewChat: () => void;
  onToggleSidebar: () => void;
  onDeleteCurrentConversation: () => void;
  workspaceView: WorkspaceView;
  hasCurrentConversation: boolean;
}

export function useKeyboardShortcuts({
  onSearch,
  onNewChat,
  onToggleSidebar,
  onDeleteCurrentConversation,
  workspaceView,
  hasCurrentConversation,
}: UseKeyboardShortcutsArgs): void {
  useEffect(() => {
    const handleKeyboardShortcut = (e: KeyboardEvent) => {
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
        if (workspaceView === 'chat' && hasCurrentConversation) {
          onDeleteCurrentConversation();
        }
      }
    };
    window.addEventListener('keydown', handleKeyboardShortcut);
    return () => window.removeEventListener('keydown', handleKeyboardShortcut);
  }, [onSearch, onNewChat, onToggleSidebar, onDeleteCurrentConversation, workspaceView, hasCurrentConversation]);

  useEffect(() => {
    if (!window.assistant?.onMenuNewConversation) return;
    return window.assistant.onMenuNewConversation(() => onNewChat());
  }, [onNewChat]);
}
