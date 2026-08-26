import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Drag, Send, Trash } from "iconoir-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "../../../components/Button";

export type QueuedChatPrompt = {
  id: string;
  message: string;
  targetHandles: string[];
  browserTargetLabel?: string | null;
  errorMessage?: string | null;
};

// React Aria positions overlays at z-index 100000. The drag preview is
// portaled to document.body to escape the queue's clipped scroll surface, so
// it must sit one layer above the popover while reordering.
const QUEUE_DRAG_OVERLAY_Z_INDEX = 100_001;

export function buildQueuedMessageAccessiblePreview(
  value: string | null | undefined,
): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}…`;
}

export function ChatSendQueue({
  items,
  onRemove,
  onReorder,
  onEdit,
  onSendNow,
  editDisabled = false,
  sendNowDisabled = false,
  removeDisabled = false,
  reorderDisabled = false,
  onDraggingChange,
}: {
  items: QueuedChatPrompt[];
  onRemove: (id: string) => void;
  onReorder: (id: string, targetIndex: number) => void;
  onEdit?: (id: string) => void;
  onSendNow?: (id: string) => void;
  editDisabled?: boolean;
  sendNowDisabled?: boolean;
  removeDisabled?: boolean;
  reorderDisabled?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  const activeItem = activeId ? items.find((item) => item.id === activeId) ?? null : null;

  useEffect(() => {
    if (!activeId || items.some((item) => item.id === activeId)) {
      return;
    }
    setActiveId(null);
    onDraggingChange?.(false);
  }, [activeId, items, onDraggingChange]);

  useEffect(
    () => () => {
      onDraggingChange?.(false);
    },
    [onDraggingChange],
  );

  if (items.length === 0) {
    return null;
  }

  const positionFor = (id: string | number): number =>
    items.findIndex((item) => item.id === String(id)) + 1;
  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    onDraggingChange?.(true);
  };
  const finishDragging = () => {
    setActiveId(null);
    onDraggingChange?.(false);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const activeIndex = items.findIndex((item) => item.id === String(active.id));
    const targetIndex = over
      ? items.findIndex((item) => item.id === String(over.id))
      : -1;
    finishDragging();
    if (activeIndex < 0 || targetIndex < 0 || activeIndex === targetIndex) {
      return;
    }
    onReorder(String(active.id), targetIndex);
  };
  const handleDragCancel = () => {
    finishDragging();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To reorder, press Space or Enter. Use the Up and Down arrow keys to move this queued message, press Space or Enter again to drop it, or press Escape to cancel.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up queued message ${positionFor(active.id)} of ${items.length}.`,
          onDragOver: ({ over }) =>
            over
              ? `Queued message will move to position ${positionFor(over.id)} of ${items.length}.`
              : undefined,
          onDragEnd: ({ active, over }) =>
            over && active.id !== over.id
              ? `Queued message moved to position ${positionFor(over.id)} of ${items.length}.`
              : "Queued message order was not changed.",
          onDragCancel: ({ active }) =>
            `Reordering canceled. Queued message returned to position ${positionFor(active.id)} of ${items.length}.`,
        },
      }}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <ol
          className="divide-y divide-slate-200/70 touch-pan-y dark:divide-slate-800/80"
          aria-label="Queued messages"
          data-testid="chat-send-queue-list"
        >
          {items.map((item, index) => (
            <SortableQueuedChatPrompt
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              showReorderHandle={items.length > 1}
              reorderDisabled={reorderDisabled}
              editDisabled={editDisabled}
              sendNowDisabled={sendNowDisabled}
              removeDisabled={removeDisabled}
              onEdit={onEdit}
              onSendNow={onSendNow}
              onRemove={onRemove}
            />
          ))}
        </ol>
      </SortableContext>
      {typeof document !== "undefined"
        ? createPortal(
            <DragOverlay dropAnimation={null} zIndex={QUEUE_DRAG_OVERLAY_Z_INDEX}>
              {activeItem ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none flex w-[min(23rem,calc(100vw-2rem))] items-center gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  data-testid="chat-send-queue-drag-overlay"
                >
                  <Drag className="h-4 w-4 flex-none text-slate-400" />
                  <span className="truncate">{activeItem.message}</span>
                </div>
              ) : null}
            </DragOverlay>,
            document.body,
          )
        : null}
    </DndContext>
  );
}

function SortableQueuedChatPrompt({
  item,
  index,
  count,
  showReorderHandle,
  reorderDisabled,
  editDisabled,
  sendNowDisabled,
  removeDisabled,
  onEdit,
  onSendNow,
  onRemove,
}: {
  item: QueuedChatPrompt;
  index: number;
  count: number;
  showReorderHandle: boolean;
  reorderDisabled: boolean;
  editDisabled: boolean;
  sendNowDisabled: boolean;
  removeDisabled: boolean;
  onEdit?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: reorderDisabled || !showReorderHandle });
  const accessibleMessage =
    buildQueuedMessageAccessiblePreview(item.message) ?? "Empty message";
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1.5 px-2 py-2.5 ${
        isDragging ? "relative z-10 opacity-40" : ""
      }`}
      data-testid="chat-send-queue-item"
    >
      {showReorderHandle ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder queued message ${index + 1} of ${count}: ${accessibleMessage}`}
          title="Drag to reorder"
          disabled={reorderDisabled}
          className="inline-flex h-9 w-9 flex-none touch-none cursor-grab items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11 dark:text-slate-500 dark:hover:bg-slate-800"
          data-testid="chat-send-queue-reorder"
        >
          <Drag aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1" title={item.errorMessage ?? undefined}>
        <span className="min-w-0">
          <span className="block truncate text-sm font-normal text-slate-800 dark:text-slate-100">
            {item.message}
          </span>
          {item.browserTargetLabel ? (
            <span className="mt-0.5 block truncate text-xxs uppercase tracking-[0.14em] text-primary-600 dark:text-primary-300">
              Browser: {item.browserTargetLabel}
            </span>
          ) : null}
          {item.errorMessage ? (
            <span className="mt-0.5 block truncate text-xs text-rose-600 dark:text-rose-300">
              {item.errorMessage}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex flex-none items-center gap-0.5">
        {onSendNow ? (
          <IconButton
            aria-label={`Send queued message ${index + 1} now: ${accessibleMessage}`}
            variant="ghost"
            size="xs"
            radius="full"
            isDisabled={sendNowDisabled}
            onPress={() => onSendNow(item.id)}
            data-testid="chat-send-queue-send-now"
          >
            <Send aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        ) : null}
        {onEdit ? (
          <Button
            aria-label={`Edit queued message ${index + 1}: ${accessibleMessage}`}
            variant="outline"
            size="xs"
            radius="full"
            isDisabled={editDisabled}
            onPress={() => onEdit(item.id)}
            className="h-7 px-2 text-xs"
            data-testid="chat-send-queue-steer"
          >
            Edit
          </Button>
        ) : null}
        <IconButton
          aria-label={`Remove queued message ${index + 1}: ${accessibleMessage}`}
          variant="ghost"
          size="xs"
          radius="full"
          isDisabled={removeDisabled}
          onPress={() => onRemove(item.id)}
          data-testid="chat-send-queue-remove"
        >
          <Trash aria-hidden="true" className="h-4 w-4" />
        </IconButton>
      </div>
    </li>
  );
}
