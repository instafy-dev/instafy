import {
  useCallback,
  useMemo,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidePaneTab } from "./SidePaneProvider";
import { TabPill } from "../components/TabPill";

export interface SidePaneTabsProps {
  tabs: SidePaneTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (tabId: string, targetIndex: number) => void;
  className?: string;
}

export function SidePaneTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  className
}: SidePaneTabsProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const activeId = String(active.id);
      const overId = String(over.id);
      const nextIndex = tabs.findIndex((tab) => tab.id === overId);
      if (nextIndex < 0) {
        return;
      }
      const currentIndex = tabs.findIndex((tab) => tab.id === activeId);
      if (currentIndex < 0 || currentIndex === nextIndex) {
        return;
      }
      onReorder(activeId, nextIndex);
    },
    [onReorder, tabs]
  );

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  return (
    <div className={`flex flex-none items-center gap-1 px-3 py-2 ${className ?? ""}`}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableSidePaneTab
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={onSelect}
              onClose={onClose}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface SortableSidePaneTabProps {
  tab: SidePaneTab;
  isActive: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

function SortableSidePaneTab({ tab, isActive, onSelect, onClose }: SortableSidePaneTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({
    id: tab.id
  });

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition
    }),
    [transform, transition]
  );

  const handleClose = useCallback(
    (event: MouseEvent | KeyboardEvent) => {
      event.stopPropagation();
      if (tab.closable === false) {
        return;
      }
      if ("key" in event) {
        const key = event.key.toLowerCase();
        if (key !== "enter" && key !== " ") {
          return;
        }
        event.preventDefault();
      }
      onClose(tab.id);
    },
    [onClose, tab.closable, tab.id]
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`inline-flex ${isDragging ? "z-10" : ""}`}
    >
      <TabPill
        ref={setActivatorNodeRef}
        active={isActive}
        tone="slate"
        className={`group gap-2 ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPress={() => onSelect(tab.id)}
        {...listeners}
        {...attributes}
      >
        {tab.icon ? (
          <span aria-hidden="true" className="shrink-0">
            {tab.icon}
          </span>
        ) : null}
        <span className="truncate">{tab.title}</span>
        {tab.dirty ? <span className="text-xs text-rose-400">●</span> : null}
        {tab.closable !== false ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Close ${tab.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleClose}
            onKeyDown={handleClose}
            className={`ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full ${
              isActive ? "text-white/80 hover:bg-white/20" : "text-slate-400 hover:bg-slate-200/70"
            }`}
          >
            x
          </span>
        ) : null}
      </TabPill>
    </div>
  );
}
