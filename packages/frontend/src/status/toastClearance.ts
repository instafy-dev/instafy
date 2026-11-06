import { useCallback, useRef } from "react";

/**
 * Bars at the top of the screen that toasts stay below: Studio's view bar
 * (Chat | Browser | …), so a toast never covers the views the person would
 * go to from it. A bar registers itself while it is on screen; the toast
 * region reads where the lowest one ends.
 */
const bars = new Set<HTMLElement>();
/**
 * The area toasts sit over: Studio's workspace, right of its navigation (the
 * team rail, the sidebar and an open drawer), so a toast never covers the
 * navigation beside the view it was shown in. The area registers itself while
 * it is on screen; with none, toasts are centred on the whole screen.
 */
const areas = new Map<HTMLElement, ResizeObserver | null>();
/**
 * Panels over that area's right edge: the participants drawer. While one is on
 * screen, the area ends where the panel starts, so a toast never covers it,
 * unless less than a phone's width would be left: then the toast spans the
 * area, as it does on a phone.
 */
const edgePanels = new Map<HTMLElement, ResizeObserver | null>();
/** The narrowest area a toast is placed in beside an edge panel: a small phone's width. */
const MIN_TOAST_AREA_WIDTH = 320;
const listeners = new Set<() => void>();
let layoutObserver: MutationObserver | null = null;
let layoutResizeObserver: ResizeObserver | null = null;
let layoutFrame: number | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function scheduleMeasure(): void {
  if (layoutFrame !== null) return;
  layoutFrame = window.requestAnimationFrame(() => {
    layoutFrame = null;
    notify();
  });
}

function observeLayout(): void {
  layoutObserver?.disconnect();
  layoutResizeObserver?.disconnect();
  const ancestors = new Set<HTMLElement>();
  const preceding = new Set<HTMLElement>();
  for (const bar of bars) {
    for (let node: HTMLElement | null = bar; node; node = node.parentElement) {
      ancestors.add(node);
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling instanceof HTMLElement) preceding.add(sibling);
      }
    }
  }
  // Observe only the bar's layout path. Streaming text and cursor changes in
  // unrelated descendants must not force a measurement on every frame.
  for (const node of ancestors) {
    layoutObserver?.observe(node, { childList: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    layoutResizeObserver?.observe(node);
  }
  for (const node of preceding) {
    layoutObserver?.observe(node, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    layoutResizeObserver?.observe(node);
  }
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

/**
 * The span of the area toasts sit over, in px from the viewport's left edge,
 * left of any panel over its right edge; null with none on screen.
 */
export function toastArea(): { left: number; width: number } | null {
  for (const area of areas.keys()) {
    const box = area.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    let right = box.right;
    for (const panel of edgePanels.keys()) {
      const edge = panel.getBoundingClientRect();
      const along = edge.width > 0 && edge.height > 0 && edge.right >= box.right - 1 && edge.left < right;
      if (along && edge.left - box.left >= MIN_TOAST_AREA_WIDTH) right = edge.left;
    }
    return { left: Math.round(box.left), width: Math.round(right - box.left) };
  }
  return null;
}

/** Calls `listener` when a bar, the layout above it, or the area toasts sit over changes. */
export function subscribeToastClearance(listener: () => void): () => void {
  listeners.add(listener);
  // A sibling banner can move a fixed-size bar without resizing the bar.
  if (!layoutObserver && typeof MutationObserver === "function") {
    layoutObserver = new MutationObserver(records => {
      if (records.some(record => record.type === "childList")) observeLayout();
      scheduleMeasure();
    });
    layoutResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleMeasure) : null;
    observeLayout();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      layoutObserver?.disconnect();
      layoutObserver = null;
      layoutResizeObserver?.disconnect();
      layoutResizeObserver = null;
      if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
      layoutFrame = null;
    }
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
      observeLayout();
      notify();
    }
    if (!active || !node) return;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(notify) : null;
    observer?.observe(node);
    held.current = { bar: node, observer };
    bars.add(node);
    observeLayout();
    notify();
  }, [active]);
}

/** A ref that keeps its element in `registry`, watched for size changes, while `active`. */
function useRegisteredRef<T extends HTMLElement>(registry: Map<HTMLElement, ResizeObserver | null>, active: boolean): (node: T | null) => void {
  const held = useRef<HTMLElement | null>(null);
  return useCallback((node: T | null) => {
    if (held.current) {
      registry.get(held.current)?.disconnect();
      registry.delete(held.current);
      held.current = null;
      notify();
    }
    if (!active || !node) return;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(notify) : null;
    observer?.observe(node);
    registry.set(node, observer);
    held.current = node;
    notify();
  }, [active, registry]);
}

/**
 * A ref for the area toasts sit over while `active`. Its width changes when
 * the navigation beside it opens, collapses or is resized, which moves its
 * left edge.
 */
export function useToastAreaRef<T extends HTMLElement>(active: boolean): (node: T | null) => void {
  return useRegisteredRef<T>(areas, active);
}

/** A ref for a panel over the right edge of the area toasts sit over, while `active` (`edgePanels`). */
export function useToastEdgePanelRef<T extends HTMLElement>(active: boolean): (node: T | null) => void {
  return useRegisteredRef<T>(edgePanels, active);
}
