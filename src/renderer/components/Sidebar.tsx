import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
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
import { sidebarCollision } from '../utils/sidebarCollision';

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  folderId: string | null;
  isPinned: boolean;
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
  conversations: Conversation[];
  folders: Folder[];
  currentConversationId: string | null;
  onConversationSelect: (id: string) => void;
  onConversationDelete: (id: string) => void;
  onConversationRename: (id: string, title: string) => void;
  onNewChat: () => void;
  onCreateFolder: () => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveConversation: (conversationId: string, folderId: string | null) => void;
  onConversationPin: (conversationId: string, isPinned: boolean) => void;
  onConversationReorder: (
    conversationId: string,
    targetConversationId: string,
    placement: DropPlacement,
  ) => void;
  activeWorkspace: 'chat' | 'dictionary' | 'usage';
  onDictionaryOpen: () => void;
  onUsageOpen: () => void;
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

interface SidebarItemRef {
  type: 'conversation' | 'folder';
  id: string;
}

interface SidebarHighlight {
  top: number;
  left: number;
  width: number;
  height: number;
}

type DropPlacement = 'before' | 'after';

interface ConversationDropTarget {
  id: string;
  placement: DropPlacement;
}

const MENU_PADDING = 12;
const CONTEXT_MENU_WIDTH = 180;
const MOVE_MENU_WIDTH = 200;
const SIDEBAR_HOVER_RECHECK_MS = 300;
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

  return (hasFolderAssignment ? 5 : 4) * MENU_ITEM_HEIGHT + 16;
}

function estimateMoveMenuHeight(folderCount: number): number {
  return Math.min(320, Math.max(96, (folderCount + 1) * MENU_ITEM_HEIGHT + 16));
}

function shouldIgnoreSidebarShortcut(e: React.KeyboardEvent): boolean {
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

function sidebarItemKey(item: SidebarItemRef): string {
  return `${item.type}:${item.id}`;
}

function DraggableConversationItem({
  conversation,
  isActive,
  isEditing,
  onSelect,
  onDelete,
  onRename,
  onStopEditing,
  onContextMenu,
  onHoverChange,
  dropPlacement,
}: {
  conversation: Conversation;
  isActive: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onStopEditing: () => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onHoverChange: (item: SidebarItemRef | null) => void;
  dropPlacement: DropPlacement | null;
}) {
  const { attributes, listeners, setNodeRef: setDraggableNodeRef, isDragging } = useDraggable({
    id: `conversation-${conversation.id}`,
    data: {
      type: 'conversation',
      id: conversation.id,
      folderId: conversation.folderId,
      isPinned: conversation.isPinned,
    },
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: `conversation-${conversation.id}`,
    data: {
      type: 'conversation',
      id: conversation.id,
      folderId: conversation.folderId,
      isPinned: conversation.isPinned,
    },
  });
  const [editTitle, setEditTitle] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const statusLabel = conversation.isStreaming
    ? 'Streaming response'
    : 'Unread completed response';
  const showStatus = conversation.isStreaming || conversation.hasUnreadComplete;
  const itemRef: SidebarItemRef = { type: 'conversation', id: conversation.id };
  const setNodeRef = useCallback((node: HTMLElement | null) => {
    setDraggableNodeRef(node);
    setDroppableNodeRef(node);
  }, [setDraggableNodeRef, setDroppableNodeRef]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditTitle(conversation.title);
  }, [conversation.title]);

  const handleFinishEdit = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(conversation.id, trimmed);
    } else {
      setEditTitle(conversation.title);
    }
    onStopEditing();
  }, [editTitle, conversation.id, conversation.title, onRename, onStopEditing]);

  const handleCancelEdit = useCallback(() => {
    setEditTitle(conversation.title);
    onStopEditing();
  }, [conversation.title, onStopEditing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFinishEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  return (
    <div
      ref={setNodeRef}
      data-sidebar-item={sidebarItemKey(itemRef)}
      className={`group relative z-10 flex items-center gap-1 px-2 py-[0.4rem] text-[0.75rem] transition-colors duration-150 cursor-grab active:cursor-grabbing ${
        isActive
          ? 'text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      } ${isDragging ? 'opacity-40' : ''}`}
      onClick={() => {
        if (!isEditing) {
          onSelect(conversation.id);
        }
      }}
      onContextMenu={(e) => onContextMenu(e, conversation.id)}
      onMouseEnter={() => onHoverChange(itemRef)}
      onMouseLeave={(event) => {
        const related = event.relatedTarget as Element | null;
        if (!related?.closest('[data-sidebar-item]')) {
          onHoverChange(null);
        }
      }}
      {...attributes}
      {...listeners}
    >
      {dropPlacement && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded-full bg-text-primary ${
            dropPlacement === 'before' ? 'top-0' : 'bottom-0'
          }`}
        />
      )}
      {isEditing ? (
        <input
          ref={inputRef}
          className="min-w-0 flex-1 border border-border-primary bg-bg-secondary px-1.5 py-0.5 text-[0.75rem] text-text-primary outline-none rounded"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleFinishEdit}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis leading-snug select-none" title={conversation.title}>
          {conversation.title}
        </span>
      )}
      <span className="relative h-5 w-5 shrink-0">
        {showStatus ? (
          <span
            className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0"
            title={statusLabel}
            aria-label={statusLabel}
          >
            {conversation.isStreaming ? (
              <span className="h-2.5 w-2.5 rounded-full border border-text-muted border-t-text-primary animate-spin" />
            ) : (
              <span className="h-2.5 w-2.5 rounded-full bg-text-primary" />
            )}
          </span>
        ) : null}
        <button
          type="button"
          className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-bg-hover"
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
      </span>
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
        <div className="folder-contents-list ml-4 border-l-1 border-border-secondary">
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
  onHoverChange,
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
  onHoverChange: (item: SidebarItemRef | null) => void;
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
  const itemRef: SidebarItemRef = { type: 'folder', id: folder.id };

  return (
    <div ref={setNodeRef}>
      <div
        data-sidebar-item={sidebarItemKey(itemRef)}
        className={`group relative z-10 flex items-center gap-1 px-1 py-[0.4rem] text-[0.75rem] transition-colors duration-150 ${
          highlighted
            ? 'bg-bg-active text-text-primary'
            : showAsSelected
              ? 'text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
        }`}
        onClick={() => {
          if (!isEditing) {
            onToggle();
          }
        }}
        onContextMenu={(e) => onContextMenu(e, folder.id)}
        onMouseEnter={() => onHoverChange(itemRef)}
        onMouseLeave={(event) => {
          const related = event.relatedTarget as Element | null;
          if (!related?.closest('[data-sidebar-item]')) {
            onHoverChange(null);
          }
        }}
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
            className="min-w-0 flex-1 border border-border-primary bg-bg-secondary px-1.5 py-0.5 text-[0.75rem] text-text-primary outline-none rounded"
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
      className={`rounded-lg outline outline-1 -outline-offset-1 transition-colors duration-150 ${
        highlighted
          ? 'outline-border-primary bg-bg-secondary'
          : 'outline-transparent bg-transparent'
      }`}
    >
      {hasConversations ? (
        <div className="flex flex-col">{children}</div>
      ) : (
        <div className="rounded-md border border-dashed border-border-secondary/50 px-3 py-3 text-sm text-text-tertiary">
          Drop chats here to remove them from folders.
        </div>
      )}
    </div>
  );
}

function PinnedDropZone({
  isDragOver,
  children,
}: {
  isDragOver: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'pinned',
    data: { type: 'pinned' },
  });
  const highlighted = isOver || isDragOver;

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col rounded-lg outline outline-1 -outline-offset-1 transition-colors duration-150 ${
        highlighted
          ? 'outline-border-primary bg-bg-secondary'
          : 'outline-transparent bg-transparent'
      }`}
    >
      {children}
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
  onConversationRename,
  onNewChat,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveConversation,
  onConversationPin,
  onConversationReorder,
  activeWorkspace,
  onDictionaryOpen,
  onUsageOpen,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
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
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [conversationDropTarget, setConversationDropTarget] = useState<ConversationDropTarget | null>(null);
  const [hoveredSidebarItem, setHoveredSidebarItem] = useState<SidebarItemRef | null>(null);
  const [sidebarHighlight, setSidebarHighlight] = useState<SidebarHighlight | null>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
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
    () => conversations.filter(c => !c.folderId && !c.isPinned),
    [conversations],
  );
  const pinnedConversations = useMemo(
    () => conversations.filter(conversation => conversation.isPinned),
    [conversations],
  );
  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    [folders],
  );

  const activeSidebarItem = useMemo<SidebarItemRef | null>(() => {
    const activeConversation = conversations.find(
      conversation => conversation.id === currentConversationId,
    );
    if (activeWorkspace !== 'chat' || !activeConversation) {
      return null;
    }

    if (
      !activeConversation.isPinned
      && activeConversation.folderId
      && !expandedFolders.has(activeConversation.folderId)
    ) {
      return { type: 'folder', id: activeConversation.folderId };
    }

    return { type: 'conversation', id: activeConversation.id };
  }, [activeWorkspace, conversations, currentConversationId, expandedFolders]);

  const highlightedSidebarItem = hoveredSidebarItem ?? activeSidebarItem;

  useEffect(() => {
    if (!hoveredSidebarItem) return;

    let hoverRecheckTimeout: number | null = null;
    const hoveredItemKey = sidebarItemKey(hoveredSidebarItem);

    const recheckSidebarHover = () => {
      const list = chatListRef.current;
      const hoveredElement = list
        ? list.querySelector<HTMLElement>(
            `[data-sidebar-item="${CSS.escape(hoveredItemKey)}"]`,
          )
        : null;

      if (!document.hasFocus() || !hoveredElement?.matches(':hover')) {
        setHoveredSidebarItem(current => (
          current && sidebarItemKey(current) === hoveredItemKey ? null : current
        ));
        return;
      }

      hoverRecheckTimeout = window.setTimeout(
        recheckSidebarHover,
        SIDEBAR_HOVER_RECHECK_MS,
      );
    };

    hoverRecheckTimeout = window.setTimeout(
      recheckSidebarHover,
      SIDEBAR_HOVER_RECHECK_MS,
    );

    return () => {
      if (hoverRecheckTimeout !== null) {
        window.clearTimeout(hoverRecheckTimeout);
      }
    };
  }, [hoveredSidebarItem]);

  const updateSidebarHighlight = useCallback(() => {
    const list = chatListRef.current;
    if (!list || !highlightedSidebarItem) {
      setSidebarHighlight(null);
      return;
    }

    const itemKey = sidebarItemKey(highlightedSidebarItem);
    const item = Array.from(list.querySelectorAll<HTMLElement>('[data-sidebar-item]'))
      .find(element => element.dataset.sidebarItem === itemKey);
    if (!item) {
      setSidebarHighlight(null);
      return;
    }

    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    setSidebarHighlight({
      top: itemRect.top - listRect.top,
      left: itemRect.left - listRect.left,
      width: itemRect.width,
      height: itemRect.height,
    });
  }, [highlightedSidebarItem]);

  useLayoutEffect(() => {
    updateSidebarHighlight();
  }, [expandedFolders, folders, conversations, updateSidebarHighlight]);

  useEffect(() => {
    const list = chatListRef.current;
    if (!list) {
      return;
    }

    const observer = new ResizeObserver(updateSidebarHighlight);
    observer.observe(list);
    window.addEventListener('resize', updateSidebarHighlight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSidebarHighlight);
    };
  }, [updateSidebarHighlight]);

  const handleConversationSelectWithFocus = useCallback((id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv?.isPinned && conv?.folderId) {
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

  const startEditingConversation = useCallback((conversationId: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    if (conversation?.folderId) {
      setExpandedFolders(prev => new Set(prev).add(conversation.folderId!));
    }
    setEditingConversationId(conversationId);
    closeMenus();
  }, [closeMenus, conversations]);

  const stopEditingConversation = useCallback(() => {
    setEditingConversationId(null);
  }, []);

  const handleCreateFolderRequest = useCallback(() => {
    const newFolderId = onCreateFolder();
    setExpandedFolders(prev => new Set(prev).add(newFolderId));
    setEditingFolderId(newFolderId);
    closeMenus();
    return newFolderId;
  }, [closeMenus, onCreateFolder]);

  const getDropPlacement = useCallback((event: DragOverEvent | DragEndEvent): DropPlacement => {
    const activeRect = event.active.rect.current.translated;
    const overRect = event.over?.rect;
    if (!activeRect || !overRect) {
      return 'before';
    }

    return activeRect.top + activeRect.height / 2 > overRect.top + overRect.height / 2
      ? 'after'
      : 'before';
  }, []);

  const resetDragState = useCallback(() => {
    setActiveId(null);
    setDragOverFolderId(null);
    setDragOverRoot(false);
    setDragOverPinned(false);
    setConversationDropTarget(null);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setDragOverFolderId(null);
    setDragOverRoot(false);
    setDragOverPinned(false);
    setConversationDropTarget(null);
    closeMenus();
  }, [closeMenus]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    resetDragState();

    if (!over) {
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type !== 'conversation') {
      return;
    }

    const conversationId = activeData.id as string;

    if (overData?.type === 'conversation') {
      const targetConversationId = overData.id as string;
      if (targetConversationId !== conversationId) {
        onConversationReorder(
          conversationId,
          targetConversationId,
          getDropPlacement(event),
        );
      }
    } else if (overData?.type === 'folder') {
      const folderId = overData.id as string;
      setExpandedFolders(prev => new Set(prev).add(folderId));
      onConversationPin(conversationId, false);
      onMoveConversation(conversationId, folderId);
    } else if (overData?.type === 'root') {
      onConversationPin(conversationId, false);
      onMoveConversation(conversationId, null);
    } else if (overData?.type === 'pinned') {
      onConversationPin(conversationId, true);
    }
  }, [getDropPlacement, onConversationPin, onConversationReorder, onMoveConversation, resetDragState]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      setDragOverPinned(false);
      setConversationDropTarget(null);
      return;
    }

    const activeData = event.active.data.current as { type?: string; id?: string } | undefined;
    if (!activeData || activeData.type !== 'conversation') {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      setDragOverPinned(false);
      setConversationDropTarget(null);
      return;
    }

    const overData = over.data.current as { type?: string; id?: string } | undefined;
    if (overData?.type === 'conversation' && overData.id) {
      const targetId = overData.id as string;
      const activeId = activeData.id as string | undefined;
      setConversationDropTarget(
        targetId !== activeId
          ? { id: targetId, placement: getDropPlacement(event) }
          : null,
      );
      setDragOverFolderId(null);
      setDragOverRoot(false);
      setDragOverPinned(false);
    } else if (overData?.type === 'folder' && overData.id) {
      setDragOverFolderId(overData.id as string);
      setDragOverRoot(false);
      setDragOverPinned(false);
      setConversationDropTarget(null);
    } else if (overData?.type === 'root') {
      setDragOverFolderId(null);
      setDragOverRoot(true);
      setDragOverPinned(false);
      setConversationDropTarget(null);
    } else if (overData?.type === 'pinned') {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      setDragOverPinned(true);
      setConversationDropTarget(null);
    } else {
      setDragOverFolderId(null);
      setDragOverRoot(false);
      setDragOverPinned(false);
      setConversationDropTarget(null);
    }
  }, [getDropPlacement]);

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
    if (editingConversationId && !conversations.some(conversation => conversation.id === editingConversationId)) {
      setEditingConversationId(null);
    }
  }, [conversations, editingConversationId]);

  useEffect(() => {
    if (focusedFolderId && !folders.some(folder => folder.id === focusedFolderId)) {
      setFocusedFolderId(null);
    }
  }, [focusedFolderId, folders]);

  const handleSidebarShortcut = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' || !e.metaKey || e.shiftKey || e.altKey
      || shouldIgnoreSidebarShortcut(e) || editingFolderId || editingConversationId
      || !focusedFolderId) return;

    e.preventDefault();
    const folderId = focusedFolderId;
    setFocusedFolderId(null);
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
  };

  useEffect(() => {
    if (isOpen) return;
    closeMenus();
    resetDragState();
    setEditingFolderId(null);
    setEditingConversationId(null);
    setHoveredSidebarItem(null);
  }, [isOpen, closeMenus, resetDragState]);

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

  const renderConversation = (conversation: Conversation) => (
    <DraggableConversationItem
      key={conversation.id}
      conversation={conversation}
      isActive={activeWorkspace === 'chat' && currentConversationId === conversation.id}
      onSelect={handleConversationSelectWithFocus}
      onDelete={onConversationDelete}
      isEditing={editingConversationId === conversation.id}
      onRename={onConversationRename}
      onStopEditing={stopEditingConversation}
      onContextMenu={handleConversationContextMenu}
      onHoverChange={setHoveredSidebarItem}
      dropPlacement={conversationDropTarget?.id === conversation.id
        ? conversationDropTarget.placement
        : null}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragCancel={resetDragState}
    >
      <aside data-sidebar inert={!isOpen} onKeyDown={handleSidebarShortcut} className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-border-primary bg-bg-primary transition-[width,min-width] duration-200 ${isOpen ? 'min-w-64 w-64' : 'w-0 min-w-0 border-r-0'}`}>
        <div className="flex-1 overflow-y-auto px-2 pb-2 pt-10">
          <div className="w-full">
            <div className="p-2">
              <button
                type="button"
                className="flex items-center justify-center bg-text-primary text-bg-primary px-3 py-2 text-[0.72rem] font-mono uppercase tracking-wide transition-all w-full duration-150 hover:opacity-80"
                onClick={() => {
                  closeMenus();
                  onNewChat();
                }}
                title="New chat (Cmd N)"
              >
                New Chat
              </button>
            </div>
            <div ref={chatListRef} className="sidebar-window-drag-region relative mt-2 flex flex-col">
              {sidebarHighlight && (
                <div
                  aria-hidden="true"
                  data-sidebar-highlight
                  className="pointer-events-none absolute z-0 rounded bg-bg-active transition-[transform,width,height,opacity] duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    width: sidebarHighlight.width,
                    height: sidebarHighlight.height,
                    transform: `translate3d(${sidebarHighlight.left}px, ${sidebarHighlight.top}px, 0)`,
                  }}
                />
              )}
              {pinnedConversations.length > 0 && (
                <div className="mb-4">
                  <div className="mb-2 flex items-center px-2">
                    <span className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">
                      Pinned
                    </span>
                  </div>
                  <PinnedDropZone isDragOver={dragOverPinned}>
                    {pinnedConversations.map(renderConversation)}
                  </PinnedDropZone>
                </div>
              )}
              <div>
                <div className="group/label mb-2 flex items-center justify-between px-2">
                  <span className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">
                    Folders
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 transition-colors hover:bg-bg-hover"
                    onClick={handleCreateFolderRequest}
                    title="Create a new folder"
                  >
                    <svg className="h-3 w-3 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </div>
                <div className="flex flex-col">
                  {sortedFolders.length > 0 ? (
                    sortedFolders.map((folder) => {
                      const allFolderConversations = conversations.filter(
                        conversation => conversation.folderId === folder.id,
                      );
                      const folderConversations = allFolderConversations.filter(conversation => !conversation.isPinned);
                      const pinnedCount = allFolderConversations.length - folderConversations.length;
                      const isExpanded = expandedFolders.has(folder.id);
                      const containsActiveConversation = activeWorkspace === 'chat' && folderConversations.some(
                        conversation => conversation.id === currentConversationId
                      );

                      return (
                        <DroppableFolderItem
                          key={folder.id}
                          folder={folder}
                          conversationCount={allFolderConversations.length}
                          isExpanded={isExpanded}
                          containsActiveConversation={containsActiveConversation}
                          isEditing={editingFolderId === folder.id}
                          onToggle={() => handleToggleFolder(folder.id)}
                          onRename={onRenameFolder}
                          onStartEditing={startEditingFolder}
                          onStopEditing={stopEditingFolder}
                          onDelete={onDeleteFolder}
                          onContextMenu={handleFolderContextMenu}
                          onHoverChange={setHoveredSidebarItem}
                          isDragOver={dragOverFolderId === folder.id}
                        >
                          {pinnedCount > 0 && (
                            <div className="py-2 pl-1 text-[0.75rem] text-text-tertiary">
                              {pinnedCount} pinned {pinnedCount === 1 ? 'chat appears' : 'chats appear'} in Pinned above.
                            </div>
                          )}
                          {folderConversations.length === 0 ? (
                            pinnedCount === 0 && <div className="py-2 pl-1 text-[0.75rem] text-text-tertiary">
                              Drop chats here or create one from a chat menu.
                            </div>
                          ) : (
                            folderConversations.map(renderConversation)
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
                {rootConversations.map(renderConversation)}
              </RootDropZone>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border-primary px-5 py-3">
          <ThemeSwitcher />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className={`group relative flex h-6 w-6 items-center justify-center transition-all duration-[150ms] ${activeWorkspace === 'usage' ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
              title="Usage dashboard"
              aria-label="Usage dashboard"
              onClick={onUsageOpen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19V5" />
                <path d="M4 19h16" />
                <path d="M8 15v-3" />
                <path d="M12 15V8" />
                <path d="M16 15v-5" />
                <path d="M20 15v-7" />
              </svg>
              <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 whitespace-nowrap rounded border border-border-primary bg-bg-secondary px-2 py-1 font-mono text-[0.6rem] text-text-primary opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                Usage dashboard
              </span>
            </button>
            <button
              type="button"
              className={`group relative flex h-6 w-6 items-center justify-center transition-all duration-[150ms] ${activeWorkspace === 'dictionary' ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
              title="Personal dictionary"
              aria-label="Personal dictionary"
              onClick={onDictionaryOpen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 whitespace-nowrap rounded border border-border-primary bg-bg-secondary px-2 py-1 font-mono text-[0.6rem] text-text-primary opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                Personal dictionary
              </span>
            </button>
          </div>
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
                  if (contextMenu.targetId) {
                    startEditingConversation(contextMenu.targetId);
                  }
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-text-primary transition-colors hover:bg-bg-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  if (contextConversation) {
                    onConversationPin(contextConversation.id, !contextConversation.isPinned);
                  }
                  closeMenus();
                }}
              >
                {contextConversation?.isPinned ? 'Unpin' : 'Pin'}
              </button>
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
