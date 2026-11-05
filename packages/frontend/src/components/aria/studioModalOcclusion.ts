import { useLayoutEffect, useSyncExternalStore } from "react";

// Native surfaces sit above renderer content. A shared modal may be a sibling
// of its native surface, so presence crosses component and portal boundaries.
// Only mounted modal content registers; notifications and popovers do not.
const mountedModals = new Set<symbol>();
const listeners = new Set<() => void>();
const snapshot = () => mountedModals.size > 0;
const serverSnapshot = () => false;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const notify = () => { for (const listener of listeners) listener(); };

/** Mount inside the actual dialog so uncontrolled and exiting modals count. */
export function StudioModalNativeOcclusion({ enabled }: { enabled: boolean }) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const token = Symbol("studio-modal");
    mountedModals.add(token);
    notify();
    return () => {
      mountedModals.delete(token);
      notify();
    };
  }, [enabled]);
  return null;
}

export function useStudioModalNativeOcclusion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
