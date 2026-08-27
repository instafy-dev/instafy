import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Bookmark, Send, TaskList } from "iconoir-react";
import {
  IDLE_TOUCH_SEND_MODE_PICKER_STATE,
  TOUCH_SEND_MODE_HOLD_DELAY_MS,
  cancelTouchSendModePicker,
  createTouchSendModePickerLayout,
  finishTouchSendModePicker,
  moveTouchSendModePicker,
  openTouchSendModePicker,
  startTouchSendModePicker,
  type TouchSendMode,
  type TouchSendModePickerLayout,
  type TouchSendModePickerOutcome,
  type TouchSendModePickerState,
  type TouchSendModePrimary,
  type TouchSendModeRect,
} from "./touchSendModePicker";

type TouchSendModePickerOptions = {
  primaryMode: TouchSendModePrimary;
  primaryDisabled: boolean;
  queueDisabled: boolean;
  stashDisabled: boolean;
  onOutcome: (outcome: TouchSendModePickerOutcome) => void;
};

type TouchSendModePickerView = {
  layout: TouchSendModePickerLayout;
  highlightedMode: TouchSendMode | null;
};

const TOUCH_TARGET_SIZE_PX = 64;
const TOUCH_TARGET_GAP_PX = 6;

function touchLikePointer(pointerType: string): boolean {
  const normalized = pointerType.toLowerCase();
  return normalized === "touch" || normalized === "pen";
}

function vibrate(durationMs: number) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }
  navigator.vibrate(durationMs);
}

function visualViewportRect(): TouchSendModeRect {
  if (typeof window === "undefined") {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  return {
    left,
    top,
    right: left + (viewport?.width ?? window.innerWidth),
    bottom: top + (viewport?.height ?? window.innerHeight),
  };
}

function domRect(rect: DOMRect): TouchSendModeRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function iconForMode(mode: TouchSendMode) {
  if (mode === "queue") {
    return <TaskList aria-hidden="true" className="h-5 w-5" />;
  }
  if (mode === "stash") {
    return <Bookmark aria-hidden="true" className="h-5 w-5" />;
  }
  return <Send aria-hidden="true" className="h-5 w-5" />;
}

function labelForMode(mode: TouchSendMode): string {
  if (mode === "queue") {
    return "Queue";
  }
  if (mode === "stash") {
    return "Stash";
  }
  return mode === "steer" ? "Steer" : "Send";
}

function formatEnabledModeLabels(layout: TouchSendModePickerLayout): string {
  const labels = layout.targets
    .filter((target) => target.enabled)
    .map((target) => labelForMode(target.mode));
  if (labels.length <= 1) {
    return labels[0] ?? "an available action";
  }
  if (labels.length === 2) {
    return `${labels[0]} or ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
}

export function useTouchSendModePicker({
  primaryMode,
  primaryDisabled,
  queueDisabled,
  stashDisabled,
  onOutcome,
}: TouchSendModePickerOptions) {
  const stateRef = useRef<TouchSendModePickerState>(IDLE_TOUCH_SEND_MODE_PICKER_STATE);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removePointerListenersRef = useRef<(() => void) | null>(null);
  const anchorRectRef = useRef<TouchSendModeRect | null>(null);
  const optionsRef = useRef({
    primaryMode,
    primaryDisabled,
    queueDisabled,
    stashDisabled,
    onOutcome,
  });
  const [view, setView] = useState<TouchSendModePickerView | null>(null);

  optionsRef.current = {
    primaryMode,
    primaryDisabled,
    queueDisabled,
    stashDisabled,
    onOutcome,
  };

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current === null) {
      return;
    }
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const removePointerListeners = useCallback(() => {
    removePointerListenersRef.current?.();
    removePointerListenersRef.current = null;
  }, []);

  const currentLayout = useCallback(() => {
    const anchor = anchorRectRef.current;
    if (!anchor) {
      return null;
    }
    const options = optionsRef.current;
    const disabledModes: TouchSendMode[] = [];
    if (options.primaryDisabled) {
      disabledModes.push(options.primaryMode);
    }
    if (options.queueDisabled) {
      disabledModes.push("queue");
    }
    if (options.stashDisabled) {
      disabledModes.push("stash");
    }
    return createTouchSendModePickerLayout({
      anchor,
      viewport: visualViewportRect(),
      primaryMode: options.primaryMode,
      disabledModes,
      targetSize: TOUCH_TARGET_SIZE_PX,
      targetGap: TOUCH_TARGET_GAP_PX,
    });
  }, []);

  const reset = useCallback(() => {
    clearHoldTimer();
    removePointerListeners();
    stateRef.current = IDLE_TOUCH_SEND_MODE_PICKER_STATE;
    anchorRectRef.current = null;
    setView(null);
  }, [clearHoldTimer, removePointerListeners]);

  useEffect(
    () => () => {
      clearHoldTimer();
      removePointerListeners();
      stateRef.current = IDLE_TOUCH_SEND_MODE_PICKER_STATE;
      anchorRectRef.current = null;
    },
    [clearHoldTimer, removePointerListeners],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (
        !touchLikePointer(event.pointerType ?? "") ||
        event.button !== 0 ||
        event.isPrimary === false ||
        stateRef.current.phase !== "idle"
      ) {
        return;
      }
      clearHoldTimer();
      anchorRectRef.current = domRect(event.currentTarget.getBoundingClientRect());
      stateRef.current = startTouchSendModePicker(
        IDLE_TOUCH_SEND_MODE_PICKER_STATE,
        event.pointerId,
        { x: event.clientX, y: event.clientY },
      );
      const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window;
      const pointerId = event.pointerId;

      const finish = (nativeEvent: PointerEvent, cancelled: boolean) => {
        if (nativeEvent.pointerId !== pointerId || stateRef.current.phase === "idle") {
          return;
        }
        const result = cancelled
          ? cancelTouchSendModePicker(stateRef.current, pointerId)
          : finishTouchSendModePicker(
              stateRef.current,
              pointerId,
              currentLayout() ?? undefined,
            );
        if (result.outcome.type === "none") {
          return;
        }
        reset();
        optionsRef.current.onOutcome(result.outcome);
      };

      const handleWindowPointerMove = (nativeEvent: PointerEvent) => {
        if (nativeEvent.pointerId !== pointerId) {
          return;
        }
        const layout = currentLayout();
        if (!layout) {
          return;
        }
        const previous = stateRef.current;
        const next = moveTouchSendModePicker(
          previous,
          pointerId,
          { x: nativeEvent.clientX, y: nativeEvent.clientY },
          layout,
        );
        if (next === previous) {
          return;
        }
        stateRef.current = next;
        if (next.phase === "cancelled") {
          clearHoldTimer();
          return;
        }
        if (next.phase !== "open") {
          return;
        }
        nativeEvent.preventDefault();
        const previousHighlightedMode =
          previous.phase === "open" ? previous.highlightedMode : null;
        if (next.highlightedMode !== previousHighlightedMode) {
          if (next.highlightedMode) {
            vibrate(6);
          }
          setView({ layout, highlightedMode: next.highlightedMode });
        }
      };
      const handleWindowPointerUp = (nativeEvent: PointerEvent) => finish(nativeEvent, false);
      const handleWindowPointerCancel = (nativeEvent: PointerEvent) => finish(nativeEvent, true);
      const handleWindowBlur = () => {
        const state = stateRef.current;
        if (state.phase === "idle") {
          return;
        }
        const result = cancelTouchSendModePicker(state, state.pointerId);
        reset();
        optionsRef.current.onOutcome(result.outcome);
      };

      ownerWindow.addEventListener("pointermove", handleWindowPointerMove, {
        capture: true,
        passive: false,
      });
      ownerWindow.addEventListener("pointerup", handleWindowPointerUp, true);
      ownerWindow.addEventListener("pointercancel", handleWindowPointerCancel, true);
      ownerWindow.addEventListener("blur", handleWindowBlur);
      removePointerListenersRef.current = () => {
        ownerWindow.removeEventListener("pointermove", handleWindowPointerMove, true);
        ownerWindow.removeEventListener("pointerup", handleWindowPointerUp, true);
        ownerWindow.removeEventListener("pointercancel", handleWindowPointerCancel, true);
        ownerWindow.removeEventListener("blur", handleWindowBlur);
      };

      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        const next = openTouchSendModePicker(stateRef.current, pointerId);
        if (next === stateRef.current || next.phase !== "open") {
          return;
        }
        const layout = currentLayout();
        if (!layout || layout.targetSize < 44) {
          stateRef.current = { phase: "cancelled", pointerId };
          return;
        }
        stateRef.current = next;
        setView({ layout, highlightedMode: null });
        vibrate(12);
      }, TOUCH_SEND_MODE_HOLD_DELAY_MS);
    },
    [clearHoldTimer, currentLayout, reset],
  );

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (stateRef.current.phase !== "idle") {
      event.preventDefault();
    }
  }, []);

  const overlay =
    view && typeof document !== "undefined"
      ? createPortal(
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[90] rounded-[1.4rem] border border-slate-200/80 bg-white/95 p-1.5 shadow-xl shadow-slate-950/15 backdrop-blur-xl dark:border-slate-700/90 dark:bg-slate-900/95"
              style={{
                left: view.layout.bounds.left - 6,
                top: view.layout.bounds.top - 6,
                width: view.layout.bounds.right - view.layout.bounds.left + 12,
                height: view.layout.bounds.bottom - view.layout.bounds.top + 12,
              }}
              data-testid="touch-send-mode-picker"
            >
              {[...view.layout.targets]
                .sort((left, right) => left.rect.left - right.rect.left)
                .map((target) => {
                  const selected = target.mode === view.highlightedMode;
                  return (
                    <div
                      key={target.mode}
                      className={`absolute flex flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold transition duration-100 ${
                        selected
                          ? "scale-[1.05] bg-primary-600 text-white shadow-md shadow-primary-600/25"
                          : "bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      } ${target.enabled ? "" : "opacity-35"}`}
                      style={{
                        left: target.rect.left - view.layout.bounds.left + 6,
                        top: target.rect.top - view.layout.bounds.top + 6,
                        width: target.rect.right - target.rect.left,
                        height: target.rect.bottom - target.rect.top,
                      }}
                      data-mode={target.mode}
                      data-selected={selected ? "true" : "false"}
                      data-disabled={target.enabled ? "false" : "true"}
                    >
                      {iconForMode(target.mode)}
                      <span>{labelForMode(target.mode)}</span>
                    </div>
                  );
                })}
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {view.highlightedMode
                ? `${labelForMode(view.highlightedMode)} selected. Release to use it.`
                : `Send options open. Slide to ${formatEnabledModeLabels(view.layout)}, then release.`}
            </span>
          </>,
          document.body,
        )
      : null;

  return {
    isOpen: view !== null,
    overlay,
    triggerProps: {
      onPointerDown: handlePointerDown,
      onContextMenu: handleContextMenu,
    },
  };
}
