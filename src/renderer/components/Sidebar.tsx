import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import ThemeSwitcher from './ThemeSwitcher';

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  folderId: string | null;
  isStreaming: boolean;
  hasUnreadComplete: boolean;
}

interface Folder {
  id: string;
  name: string;
  timestamp: Date;
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  folders: Folder[];
  currentConversationId: string | null;
  onConversationSelect: (id: string) => void;
  onConversationDelete: (id: string) => void;
  onNewChat: () => void;
  onCreateFolder: () => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveConversation: (conversationId: string, folderId: string | null) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetId: string | null;
  targetType: 'conversation' | 'folder' | null;
}

interface MoveMenuState {
  visible: boolean;
  x: number;
  y: number;
  conversationId: string | null;
}

interface MenuPosition {
  x: number;
  y: number;
}

const MENU_PADDING = 12;
const CONTEXT_MENU_WIDTH = 180;
const MOVE_MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 34;

function clampMenuPosition(x: number, y: number, width: number, height: number): MenuPosition {
  if (typeof window === 'undefined') {
    return { x, y };
  }

  const maxX = Math.max(MENU_PADDING, window.innerWidth - width - MENU_PADDING);
  const maxY = Math.max(MENU_PADDING, window.innerHeight - height - MENU_PADDING);

  return {
    x: Math.min(Math.max(MENU_PADDING, x), maxX),
    y: Math.min(Math.max(MENU_PADDING, y), maxY),
  };
}

function estimateContextMenuHeight(
  targetType: 'conversation' | 'folder',
  hasFolderAssignment: boolean,
): number {
  if (targetType === 'folder') {
    return MENU_ITEM_HEIGHT * 2 + 16;
  }

  return (hasFolderAssignment ? 3 : 2) * MENU_ITEM_HEIGHT + 16;
}

function estimateMoveMenuHeight(folderCount: number): number {
  return Math.min(320, Math.max(96, (folderCount + 1) * MENU_ITEM_HEIGHT + 16));
}

function getShortcutIndex(key: string): number | null {
  if (key >= '1' && key <= '9') return parseInt(key, 10);
  if (key === '0') return 10;
  return null;
}

function shouldIgnoreSidebarShortcut(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function getMoveMenuPosition(contextMenuX: number, contextMenuY: number, folderCount: number): MenuPosition {
  const canOpenRight = typeof window === 'undefined'
    ? true
    : contextMenuX + CONTEXT_MENU_WIDTH + MOVE_MENU_WIDTH + MENU_PADDING <= window.innerWidth;

  const preferredX = canOpenRight
    ? contextMenuX + CONTEXT_MENU_WIDTH - 8
    : contextMenuX - MOVE_MENU_WIDTH + 8;

  return clampMenuPosition(
    preferredX,
    contextMenuY,
    MOVE_MENU_WIDTH,
    estimateMoveMenuHeight(folderCount),
  );
}

function DraggableConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onContextMenu,
}: {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `conversation-${conversation.id}`,
    data: { type: 'conversation', id: conversation.id },
  });
  const statusLabel = conversation.isStreaming ? 'Streaming response' : 'Unread completed response';
  const showStatus = conversation.isStreaming || conversation.hasUnreadComplete;

  return (
    <div
      ref={setNodeRef}
      className={`group flex items-center gap-1 px-2 py-[0.4rem] text-[0.85rem] transition-all duration-150 cursor-grab active:cursor-grabbing ${
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      } ${isDragging ? 'opacity-40' : ''}`}
      onClick={() => onSelect(conversation.id)}
      onContextMenu={(e) => onContextMenu(e, conversation.id)}
      {...attributes}
      {...listeners}
    >
      <span className="min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis leading-snug select-none" title={conversation.title}>
        {conversation.title}
      </span>
      {showStatus && (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center"
          title={statusLabel}
          aria-label={statusLabel}
        >
          {conversation.isStreaming ? (
            <span className="h-2.5 w-2.5 rounded-full border border-text-muted border-t-text-primary animate-spin" />
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-text-primary" />
          )}
        </span>
      )}
      <button
        type="button"
        className="shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-bg-hover"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(conversation.id);
        }}
        title="Delete conversation (Cmd Shift Backspace)"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}

function FolderContentsPanel({
  isExpanded,
  children,
}: {
  isExpanded: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`folder-contents ${isExpanded ? 'folder-contents-expanded' : ''}`}
      aria-hidden={!isExpanded}
    >
      <div className="folder-contents-inner">
        <div className="folder-contents-list ml-4 border-l-1 border-border-secondary space-y-0.5">
          {children}
        </div>
      </div>
    </div>
  );
}

function DroppableFolderItem({
  folder,
  conversationCount,
  isExpanded,
  containsActiveConversation,
  isEditing,
  onToggle,
  onRename,
  onStartEditing,
  onStopEditing,
  onDelete,
  onContextMenu,
  children,
  isDragOver,
}: {
  folder: Folder;
  conversationCount: number;
  isExpanded: boolean;
  containsActiveConversation: boolean;
  isEditing: boolean;
  onToggle: () => void;
  onRename: (id: string, name: string) => void;
  onStartEditing: (id: string) => void;
  onStopEditing: () => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  children: React.ReactNode;
  isDragOver: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folder.id}`,
    data: { type: 'folder', id: folder.id },
  });
  const [editName, setEditName] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditName(folder.name);
  }, [folder.name]);

  const handleFinishEdit = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== folder.name) {
      onRename(folder.id, trimmed);
    } else {
      setEditName(folder.name);
    }
    onStopEditing();
  }, [editName, folder.id, folder.name, onRename, onStopEditing]);

  const handleCancelEdit = useCallback(() => {
    setEditName(folder.name);
    onStopEditing();
  }, [folder.name, onStopEditing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFinishEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const highlighted = isOver || isDragOver;
  const showAsSelected = containsActiveConversation && !isExpanded;

  return (
    <div ref={setNodeRef}>
      <div
        className={`group flex items-center gap-1 px-1 py-[0.4rem] text-[0.85rem] transition-all duration-150 ${
          highlighted || showAsSelected
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
        onClick={() => {
          if (!isEditing) {
            onToggle();
          }
        }}
        onContextMenu={(e) => onContextMenu(e, folder.id)}
        aria-expanded={isExpanded}
      >
        <svg className={`h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-200 ${isExpanded ? 'rotate-90' : 'rotate-0'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <svg className="h-3.5 w-3.5 shrink-0 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        {isEditing ? (
          <input
            ref={inputRef}
            className="min-w-0 flex-1 border border-border-primary bg-bg-secondary px-1.5 py-0.5 text-[0.85rem] text-text-primary outline-none rounded"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="min-w-0 flex-1 flex items-center">
            <span className="min-w-0 whitespace-nowrap mt-0.5 overflow-hidden text-ellipsis leading-snug font-medium" title={folder.name}>
              {folder.name}
            </span>
            {conversationCount > 0 && (
              <span
                className="shrink-0 rounded-full px-[0.4rem] py-[0.1rem] text-[0.65rem] text-text-tertiary leading-none"
                title={`${conversationCount} chat${conversationCount === 1 ? '' : 's'} in folder`}
              >
                {conversationCount}
              </span>
            )}
          </div>
        )}
        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              className="shrink-0 rounded p-1 hover:bg-bg-hover"
              onClick={(e) => {
                e.stopPropagation();
                onStartEditing(folder.id);
              }}
              title="Rename folder"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-1 hover:bg-bg-hover"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(folder.id);
              }}
              title="Delete folder"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <FolderContentsPanel isExpanded={isExpanded}>
        {children}
      </FolderContentsPanel>
    </div>
  );
}

function RootDropZone({
  isDragOver,
  hasConversations,
  children,
}: {
  isDragOver: boolean;
  hasConversations: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'root',
    data: { type: 'root' },
  });
  const highlighted = isOver || isDragOver;

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border transition-colors duration-150 ${
        highlighted
          ? 'border-border-primary bg-bg-secondary'
          : 'border-transparent bg-transparent'
      }`}
    >
      {hasConversations ? (
        <div className="flex flex-col gap-0.5 py-1">{children}</div>
      ) : (
        <div className="rounded-md border border-dashed border-border-secondary/50 px-3 py-3 text-sm text-text-tertiary">
          Drop chats here to remove them from folders.
        </div>
      )}
    </div>
  );
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  conversations,
  folders,
  currentConversationId,
  onConversationSelect,
  onConversationDelete,
  onNewChat,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveConversation,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetId: null,
    targetType: null,
  });
  const [moveMenu, setMoveMenu] = useState<MoveMenuState>({
    visible: false,
    x: 0,
    y: 0,
    conversationId: null,
  });
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

  const handleToggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
        setFocusedFolderId(current => (current === folderId ? null : current));
      } else {
        next.add(folderId);
        setFocusedFolderId(folderId);
      }
      return next;
    });
  }, []);

  const rootConversations = useMemo(
    () => conversations.filter(c => !c.folderId),
    [conversations],
  );
  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    [folders],
  );

  const rootShortcutTargets = useMemo(() => {
    const targets: Array<{ type: 'folder' | 'conversation'; id: string }> = [];
    for (const folder of sortedFolders) {
      targets.push({ type: 'folder', id: folder.id });
    }
    for (const conv of rootConversations) {
      targets.push({ type: 'conversation', id: conv.id });
    }
    return targets.slice(0, 10);
  }, [sortedFolders, rootConversations]);

  const folderShortcutConversations = useMemo(() => {
    if (!focusedFolderId) return [];
    return conversations.filter(c => c.folderId === focusedFolderId).slice(0, 10);
  }, [focusedFolderId, conversations]);

  const handleConversationSelectWithFocus = useCallback((id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (conv?.folderId) {
      setFocusedFolderId(conv.folderId);
      setExpandedFolders(prev => new Set(prev).add(conv.folderId!));
    } else {
      setFocusedFolderId(null);
    }
    onConversationSelect(id);
  }, [conversations, onConversationSelect]);

  const closeMenus = useCallback(() => {
    setContextMenu(prev => (prev.visible ? { ...prev, visible: false } : prev));
    setMoveMenu(prev => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  const startEditingFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => new Set(prev).add(folderId));
    setEditingFolderId(folderId);
    closeMenus();
  }, [closeMenus]);

  const stopEditingFolder = useCallback(() => {
    setEditingFolderId(null);
  }, []);

  const handleCreateFolderRequest = useCallback(() => {
    const newFolderId = onCreateFolder();
    setExpandedFolders(prev => new Set(prev).add(newFolderId));
    setEditingFolderId(newFolderId);
    closeMenus();
    return newFolderId;
  }, [closeMenus, onCreateFolder]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    closeMenus();
  }, [closeMenus]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setDragOverFolderId(null);
    setDragOverRoot(false);

    if (!over) {
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type !== 'conversation') {
      return;
    }

    const conversationId = activeData.id as string;

    if (overData?.type === 'folder') {
      const folderId = overData.id as string;
      setExpandedFolders(prev => new Set(prev).add(folderId));
      onMoveConversation(conversationId, folderId);
    } else if (overData?.type === 'root') {
      onMoveConversation(conversationId, null);
    }
  }, [onMoveConversation]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      return;
    }

    const activeData = event.active.data.current as { type?: string } | undefined;
    if (!activeData || activeData.type !== 'conversation') {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      return;
    }

    const overData = over.data.current as { type?: string; id?: string } | undefined;
    if (overData?.type === 'folder' && overData.id) {
      setDragOverFolderId(overData.id as string);
      setDragOverRoot(false);
    } else if (overData?.type === 'root') {
      setDragOverFolderId(null);
      setDragOverRoot(true);
    } else {
      setDragOverFolderId(null);
      setDragOverRoot(false);
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, targetId: string, targetType: 'conversation' | 'folder') => {
    e.preventDefault();
    e.stopPropagation();

    const targetConversation = targetType === 'conversation'
      ? conversations.find(conversation => conversation.id === targetId)
      : null;
    const position = clampMenuPosition(
      e.clientX,
      e.clientY,
      CONTEXT_MENU_WIDTH,
      estimateContextMenuHeight(targetType, Boolean(targetConversation?.folderId)),
    );

    setContextMenu({
      visible: true,
      x: position.x,
      y: position.y,
      targetId,
      targetType,
    });
    setMoveMenu(prev => ({ ...prev, visible: false }));
  }, [conversations]);

  const handleConversationContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    handleContextMenu(e, id, 'conversation');
  }, [handleContextMenu]);

  const handleFolderContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    handleContextMenu(e, id, 'folder');
  }, [handleContextMenu]);

  useEffect(() => {
    if (!(contextMenu.visible || moveMenu.visible)) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        (contextMenuRef.current && target && contextMenuRef.current.contains(target)) ||
        (moveMenuRef.current && target && moveMenuRef.current.contains(target))
      ) {
        return;
      }

      closeMenus();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [closeMenus, contextMenu.visible, moveMenu.visible]);

  useEffect(() => {
    if (!(contextMenu.visible || moveMenu.visible)) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenus();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeMenus, contextMenu.visible, moveMenu.visible]);

  useEffect(() => {
    if (editingFolderId && !folders.some(folder => folder.id === editingFolderId)) {
      setEditingFolderId(null);
    }
  }, [editingFolderId, folders]);

  useEffect(() => {
    if (focusedFolderId && !folders.some(folder => folder.id === focusedFolderId)) {
      setFocusedFolderId(null);
    }
  }, [focusedFolderId, folders]);

  useEffect(() => {
    const handleSidebarShortcut = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey) {
        return;
      }
      if (shouldIgnoreSidebarShortcut(e) || editingFolderId) {
        return;
      }

      if (e.key === 'ArrowUp') {
        if (focusedFolderId) {
          e.preventDefault();
          setFocusedFolderId(null);
        }
        return;
      }

      const index = getShortcutIndex(e.key);
      if (!index) {
        return;
      }

      e.preventDefault();

      if (focusedFolderId) {
        const conversation = folderShortcutConversations[index - 1];
        if (conversation) {
          handleConversationSelectWithFocus(conversation.id);
        }
        return;
      }

      const target = rootShortcutTargets[index - 1];
      if (!target) {
        return;
      }

      if (target.type === 'folder') {
        setFocusedFolderId(target.id);
        setExpandedFolders(prev => new Set(prev).add(target.id));
      } else {
        handleConversationSelectWithFocus(target.id);
      }
    };

    window.addEventListener('keydown', handleSidebarShortcut);
    return () => window.removeEventListener('keydown', handleSidebarShortcut);
  }, [
    editingFolderId,
    focusedFolderId,
    folderShortcutConversations,
    handleConversationSelectWithFocus,
    rootShortcutTargets,
  ]);

  const handleMoveToFolder = useCallback((conversationId: string, folderId: string | null) => {
    onMoveConversation(conversationId, folderId);
    if (folderId) {
      setExpandedFolders(prev => new Set(prev).add(folderId));
    }
    closeMenus();
  }, [closeMenus, onMoveConversation]);

  const handleCreateAndMove = useCallback((conversationId: string) => {
    const newFolderId = handleCreateFolderRequest();
    onMoveConversation(conversationId, newFolderId);
  }, [handleCreateFolderRequest, onMoveConversation]);

  const contextConversation = contextMenu.targetType === 'conversation' && contextMenu.targetId
    ? conversations.find(conversation => conversation.id === contextMenu.targetId) ?? null
    : null;


  const activeConversation = activeId
    ? conversations.find(c => `conversation-${c.id}` === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
    >
      <aside className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-border-primary bg-bg-primary transition-[width] duration-200 ${isOpen ? 'w-64' : 'w-0 border-r-0'}`}>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="p-2">
            <button
              type="button"
              className="flex items-center justify-center bg-text-primary text-bg-primary px-3 py-2 text-[0.72rem] font-mono uppercase tracking-wide transition-all w-full duration-150 hover:opacity-80"
              onClick={() => {
                closeMenus();
                onNewChat();
              }}
              title="New chat (Cmd Shift O)"
            >
              New Chat
            </button>
          </div>
          <div className="mt-8 flex flex-col gap-1">
            <div>
              <div className="group/label mb-2 flex items-center justify-between px-2">
                <span className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">
                  Folders
                </span>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-0 transition-opacity group-hover/label:opacity-100 hover:bg-bg-hover"
                  onClick={handleCreateFolderRequest}
                  title="Create a new folder"
                >
                  <svg className="h-3 w-3 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-col gap-0.5">
                {sortedFolders.length > 0 ? (
                  sortedFolders.map((folder) => {
                    const folderConversations = conversations.filter(c => c.folderId === folder.id);
                    const isExpanded = expandedFolders.has(folder.id);
                    const containsActiveConversation = folderConversations.some(
                      conversation => conversation.id === currentConversationId
                    );

                    return (
                      <DroppableFolderItem
                        key={folder.id}
                        folder={folder}
                        conversationCount={folderConversations.length}
                        isExpanded={isExpanded}
                        containsActiveConversation={containsActiveConversation}
                        isEditing={editingFolderId === folder.id}
                        onToggle={() => handleToggleFolder(folder.id)}
                        onRename={onRenameFolder}
                        onStartEditing={startEditingFolder}
                        onStopEditing={stopEditingFolder}
                        onDelete={onDeleteFolder}
                        onContextMenu={handleFolderContextMenu}
                        isDragOver={dragOverFolderId === folder.id}
                      >
                        {folderConversations.length === 0 ? (
                          <div className="py-2 pl-1 text-[0.75rem] italic text-text-tertiary">
                            Drop chats here or create one from a chat menu.
                          </div>
                        ) : (
                          folderConversations.map((conversation) => (
                            <DraggableConversationItem
                              key={conversation.id}
                              conversation={conversation}
                              isActive={currentConversationId === conversation.id}
                              onSelect={handleConversationSelectWithFocus}
                              onDelete={onConversationDelete}
                              onContextMenu={handleConversationContextMenu}
                            />
                          ))
                        )}
                      </DroppableFolderItem>
                    );
                  })
                ) : (
                  <div className="rounded-lg border border-dashed border-border-secondary/50 px-4 py-3 text-[0.75rem] text-text-tertiary text-center">
                    No folders yet. Click + to create one.
                  </div>
                )}
              </div>
            </div>

            <RootDropZone isDragOver={dragOverRoot} hasConversations={rootConversations.length > 0}>
              {rootConversations.map((conversation) => (
                <DraggableConversationItem
                  key={conversation.id}
                  conversation={conversation}
                  isActive={currentConversationId === conversation.id}
                  onSelect={handleConversationSelectWithFocus}
                  onDelete={onConversationDelete}
                  onContextMenu={handleConversationContextMenu}
                />
              ))}
            </RootDropZone>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border-primary px-5 py-3">
          <ThemeSwitcher />
          <span className="ml-auto font-mono text-[0.65rem] text-text-tertiary">v1.0</span>
        </div>
      </aside>

      <DragOverlay>
        {activeConversation ? (
          <div className="max-w-[220px] truncate rounded-md bg-bg-sidebar border border-border-primary px-3 py-2 text-[0.85rem] text-text-primary opacity-90 shadow-lg">
            {activeConversation.title}
          </div>
        ) : null}
      </DragOverlay>

      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] rounded-md border border-border-primary bg-bg-secondary py-1 text-[0.8rem] shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.targetType === 'conversation' && (
            <>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!contextMenu.targetId) {
                    return;
                  }

                  const position = getMoveMenuPosition(contextMenu.x, contextMenu.y, sortedFolders.length);
                  setContextMenu(prev => ({ ...prev, visible: false }));
                  setMoveMenu({
                    visible: true,
                    x: position.x,
                    y: position.y,
                    conversationId: contextMenu.targetId,
                  });
                }}
              >
                Move to folder...
              </button>
              {contextConversation?.folderId && (
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (contextMenu.targetId) {
                      handleMoveToFolder(contextMenu.targetId, null);
                    }
                  }}
                >
                  Remove from folder
                </button>
              )}
              <div className="my-1 border-t border-border-primary" />
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-bg-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  if (contextMenu.targetId) {
                    onConversationDelete(contextMenu.targetId);
                  }
                  closeMenus();
                }}
              >
                Delete
              </button>
            </>
          )}
          {contextMenu.targetType === 'folder' && (
            <>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  if (contextMenu.targetId) {
                    startEditingFolder(contextMenu.targetId);
                  }
                }}
              >
                Rename
              </button>
              <div className="my-1 border-t border-border-primary" />
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-bg-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  if (contextMenu.targetId) {
                    onDeleteFolder(contextMenu.targetId);
                  }
                  closeMenus();
                }}
              >
                Delete folder
              </button>
            </>
          )}
        </div>
      )}

      {moveMenu.visible && moveMenu.conversationId && (
        <div
          ref={moveMenuRef}
          className="fixed z-60 max-h-[280px] min-w-[200px] overflow-y-auto rounded-md border border-border-primary bg-bg-secondary py-1 text-[0.8rem] shadow-lg"
          style={{ left: moveMenu.x, top: moveMenu.y }}
        >
          {sortedFolders.length === 0 ? (
            <div className="px-3 py-1.5 text-text-tertiary">No folders yet</div>
          ) : (
            sortedFolders.map(folder => (
              <button
                type="button"
                key={folder.id}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
                onClick={() => handleMoveToFolder(moveMenu.conversationId!, folder.id)}
              >
                <svg className="h-3 w-3 shrink-0 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {folder.name}
              </button>
            ))
          )}
          <div className="my-1 border-t border-border-primary" />
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
            onClick={() => handleCreateAndMove(moveMenu.conversationId!)}
          >
            <svg className="h-3 w-3 shrink-0 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New folder...
          </button>
        </div>
      )}
    </DndContext>
  );
};

export default Sidebar;
