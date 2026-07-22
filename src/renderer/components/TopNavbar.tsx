import React from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Tab {
  id: string;
  title: string;
  closable?: boolean;
}

interface TopNavbarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string, e: React.MouseEvent) => void;
  onTabsReorder: (tabIds: string[]) => void;
  onNewChat: () => void;
  onMenuClick: () => void;
}

interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string, e: React.MouseEvent) => void;
}

const SortableTab: React.FC<SortableTabProps> = ({
  tab,
  isActive,
  onSelect,
  onClose,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useSortable({ id: tab.id });
  const style = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, y: 0 })
      : undefined,
    transition: isDragging ? 'none' : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group/tab relative h-8 flex grow shrink basis-[160px] min-w-0 max-w-[200px] items-center overflow-hidden font-readable text-[0.7rem] cursor-grab active:cursor-grabbing transition-[transform,background-color,color,border-color,opacity] duration-[150ms] [-webkit-app-region:no-drag] ${
        isActive
          ? 'bg-bg-primary text-text-primary border border-border-primary border-b-bg-primary -mb-px'
          : isDragging
            ? 'bg-bg-hover text-text-primary border border-transparent border-b-transparent'
            : 'text-text-secondary border border-transparent border-b-transparent hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex h-full w-full min-w-0 items-center overflow-hidden border-0 bg-transparent px-3 text-left text-inherit outline-none cursor-inherit"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => onSelect(tab.id)}
        {...attributes}
        {...listeners}
      >
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap" title={tab.title}>{tab.title}</span>
      </button>
      {tab.closable === false ? null : (
        <button
          type="button"
          className={`absolute inset-y-0 right-0 w-8 cursor-pointer flex items-center justify-center border-0 p-0 text-text-secondary transition-all duration-[150ms] hover:text-text-primary focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:text-text-primary outline-none ${
            isDragging
              ? 'opacity-0 pointer-events-none'
              : 'opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto'
          } ${
            isActive ? 'bg-bg-primary' : 'bg-bg-hover'
          }`}
          aria-label={`Close ${tab.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => onClose(tab.id, e)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      )}
    </div>
  );
};

const TopNavbar: React.FC<TopNavbarProps> = ({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabsReorder,
  onNewChat,
  onMenuClick,
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 2 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: ['Space'],
        cancel: ['Escape'],
        end: ['Space'],
      },
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = tabs.findIndex(tab => tab.id === active.id);
    const newIndex = tabs.findIndex(tab => tab.id === over.id);
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    onTabsReorder(arrayMove(tabs, oldIndex, newIndex).map(tab => tab.id));
  };

  return (
    <div className="h-[37px] bg-bg-navbar border-b border-border-primary flex items-stretch shrink-0 gap-1 select-none [-webkit-app-region:drag]">
      <div className="w-[72px] shrink-0" />
      <button
        type="button"
        className="self-center h-8 w-8 shrink-0 flex items-center justify-center cursor-pointer transition-all duration-[150ms] text-text-primary outline-none focus:outline-none focus-visible:outline-none [-webkit-app-region:no-drag]"
        onClick={onMenuClick}
        title="Toggle sidebar (Cmd+B)"
        aria-label="Toggle sidebar"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
      <div className="flex flex-1 min-w-0 items-end">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map(tab => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={activeTabId === tab.id}
                onSelect={onTabSelect}
                onClose={onTabClose}
              />
            ))}
          </SortableContext>
        </DndContext>
        <button
          type="button"
          className="h-[36px] w-10 shrink-0 flex items-center justify-center bg-transparent border-0 p-0 text-text-secondary opacity-50 cursor-pointer transition-all duration-[150ms] hover:text-text-primary hover:opacity-100 focus-visible:text-text-primary focus-visible:opacity-100 outline-none [-webkit-app-region:no-drag]"
          onClick={onNewChat}
          title="New chat (Cmd+N)"
          aria-label="New chat"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default TopNavbar;
