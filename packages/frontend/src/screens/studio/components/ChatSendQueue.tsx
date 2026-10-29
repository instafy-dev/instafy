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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, iconButtonStyles } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";

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
  const listRef = useRef<HTMLOListElement | null>(null);
  const removedFocus = useRef<{ id: string; index: number; control: string; element: Element | null } | null>(null);
  useLayoutEffect(() => {
    const pending = removedFocus.current;
    if (!pending || items.some(item => item.id === pending.id)) return;
    removedFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement !== pending.element) return;
    const rows = listRef.current?.querySelectorAll('[data-testid="chat-send-queue-item"]');
    const row = rows?.[Math.min(pending.index, items.length - 1)];
    row?.querySelector<HTMLButtonElement>(`[data-testid="${pending.control}"]`)?.focus({ preventScroll: true });
  }, [items]);
  const preserveActionFocus = (id: string, control: string, action: (id: string) => void) => {
    const index = items.findIndex(item => item.id === id);
    const row = listRef.current?.querySelectorAll('[data-testid="chat-send-queue-item"]')[index];
    if (row?.contains(document.activeElement)) removedFocus.current = { id, index, control, element: document.activeElement };
    action(id);
  };
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
          ref={listRef}
          className="flex touch-pan-y flex-col items-end gap-2 p-1"
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
              onSendNow={onSendNow ? id => preserveActionFocus(id, "chat-send-queue-send-now", onSendNow) : undefined}
              onRemove={id => preserveActionFocus(id, "chat-send-queue-remove", onRemove)}
            />
          ))}
        </ol>
      </SortableContext>
      {typeof document !== "undefined"
        ? createPortal(
            <DragOverlay dropAnimation={null} zIndex={QUEUE_DRAG_OVERLAY_Z_INDEX}>
              {activeItem ? (
                <Surface
                  aria-hidden="true"
                  tone="floating"
                  radius="xl"
                  shadow="lg"
                  className="pointer-events-none flex w-[min(23rem,calc(100vw-2rem))] items-center gap-2 px-3 py-2.5"
                  data-testid="chat-send-queue-drag-overlay"
                >
                  <Text as="span" tone="muted" className="shrink-0"><Drag className="h-4 w-4" /></Text>
                  <Text as="span" variant="bodyCompact" tone="primary" className="truncate">{activeItem.message}</Text>
                </Surface>
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
      className={`w-full min-w-0 ${isDragging ? "relative z-10 opacity-40" : ""}`}
      data-testid="chat-send-queue-item"
    >
      <Surface tone="floating" radius="2xl" shadow="sm" className="p-3" title={item.errorMessage ?? undefined}>
        <Text variant="caption" tone="muted" className="mb-1">
          Queued {index + 1} of {count}
        </Text>
        <Text variant="bodyCompact" tone="primary" className="line-clamp-3 whitespace-pre-wrap break-words" title={item.message}>
          {item.message}
        </Text>
        {item.browserTargetLabel ? (
          <Text variant="caption" tone="muted" className="mt-1 truncate">
            Browser: {item.browserTargetLabel}
          </Text>
        ) : null}
        {item.errorMessage ? (
          <Text variant="caption" tone="danger" className="mt-1 break-words">
            {item.errorMessage}
          </Text>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {showReorderHandle ? (
            <button
              ref={setActivatorNodeRef}
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Reorder queued message ${index + 1} of ${count}: ${accessibleMessage}`}
              title="Drag to reorder"
              disabled={reorderDisabled}
              className={`${iconButtonStyles({ variant: "ghost", tone: "muted" })} mr-auto touch-none cursor-grab active:cursor-grabbing`}
              data-testid="chat-send-queue-reorder"
            >
              <Drag aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
          <div className="contents">
            {onSendNow ? (
              <IconButton
                aria-label={`Send queued message ${index + 1} now: ${accessibleMessage}`}
                title="Send now"
                variant="ghost"
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
                variant="ghost"
                preset="inline"
                isDisabled={editDisabled}
                onPress={() => onEdit(item.id)}
                data-testid="chat-send-queue-steer"
              >
                Edit
              </Button>
            ) : null}
            <IconButton
              aria-label={`Remove queued message ${index + 1}: ${accessibleMessage}`}
              title="Remove queued message"
              variant="ghost"
              isDisabled={removeDisabled}
              onPress={() => onRemove(item.id)}
              data-testid="chat-send-queue-remove"
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </Surface>
    </li>
  );
}
