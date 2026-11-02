import { useCallback, useRef } from "react";

/**
 * Bars at the top of the screen that toasts stay below: Studio's view bar
 * (Chat | Browser | …), so a toast never covers the views the person would
 * go to from it. A bar registers itself while it is on screen; the toast
 * region reads where the lowest one ends.
 */
const bars = new Set<HTMLElement>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Where the lowest bar on screen ends, in px from the top of the viewport; 0 with none. */
export function toastClearanceBottom(): number {
  let bottom = 0;
  for (const bar of bars) {
    const box = bar.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) bottom = Math.max(bottom, box.bottom);
  }
  return Math.ceil(bottom);
}

/** Calls `listener` when a bar comes, goes or changes size. */
export function subscribeToastClearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A ref for a bar that toasts stay below while `active`. */
export function useToastClearanceRef<T extends HTMLElement>(active: boolean): (node: T | null) => void {
  const held = useRef<{ bar: HTMLElement; observer: ResizeObserver | null } | null>(null);
  return useCallback((node: T | null) => {
    if (held.current) {
      held.current.observer?.disconnect();
      bars.delete(held.current.bar);
      held.current = null;
      notify();
    }
    if (!active || !node) return;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(notify) : null;
    observer?.observe(node);
    held.current = { bar: node, observer };
    bars.add(node);
    notify();
  }, [active]);
}
