import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

type Dock = { element: HTMLDivElement; key: number };

function movePortal(portal: HTMLDivElement, target: HTMLElement) {
  if (portal.parentElement === target) return;
  const focused = portal.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const movable = target as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
  if (portal.isConnected && typeof movable.moveBefore === "function") {
    movable.moveBefore(portal, null);
  } else {
    target.appendChild(portal);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
}

function createDockStore() {
  const listeners = new Set<() => void>();
  const hosts = new Map<number, Dock>();
  const portals = new Set<HTMLDivElement>();
  let nextKey = 0;
  let current: Dock | null = null;
  const publish = () => {
    const next = [...hosts.values()].at(-1) ?? null;
    if (next === current) return;
    current = next;
    // A host's layout cleanup runs before React removes its DOM. Move the
    // portal now so pane unmounts preserve focus as well as ordinary toggles.
    portals.forEach(portal => movePortal(portal, current?.element ?? document.body));
    listeners.forEach(listener => listener());
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => current,
    attachPortal: (portal: HTMLDivElement) => {
      portals.add(portal);
      movePortal(portal, current?.element ?? document.body);
      return () => { portals.delete(portal); portal.remove(); };
    },
    register: (element: HTMLDivElement) => {
      const key = ++nextKey;
      hosts.set(key, { element, key });
      publish();
      return () => { hosts.delete(key); publish(); };
    },
  };
}

const DockContext = createContext<ReturnType<typeof createDockStore> | null>(null);
const subscribeEmpty = () => () => {};
const getEmpty = () => null;

/** Presentation changes do not rerender consumers of the status actions. */
export function StatusDockProvider({ children }: { children: ReactNode }) {
  const store = useMemo(createDockStore, []);
  return <DockContext.Provider value={store}>{children}</DockContext.Provider>;
}

export function useStatusDock() {
  const store = useContext(DockContext);
  return useSyncExternalStore(store?.subscribe ?? subscribeEmpty, store?.getSnapshot ?? getEmpty, getEmpty);
}

export function useStatusPortal(portal: HTMLDivElement | null) {
  const store = useContext(DockContext);
  useLayoutEffect(() => {
    if (!portal) return;
    if (store) return store.attachPortal(portal);
    movePortal(portal, document.body);
    return () => { portal.remove(); };
  }, [portal, store]);
}

/** A bounded row in the remaining browser pane; empty feedback takes no space. */
export function StatusDock({ active, ownerKey }: { active: boolean; ownerKey: string | null | undefined }) {
  const store = useContext(DockContext);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!active || !ownerKey || !element || !store) return;
    return store.register(element);
  }, [active, element, ownerKey, store]);
  return <div ref={setElement} className="relative min-h-0 shrink-0 overflow-y-auto"
    // At 128px of remaining space both the action row and native page retain
    // 64px. Smaller panes cannot fit both full controls; keep the page live.
    style={{ maxHeight: "max(0px, min(calc(100% - 4rem), max(4rem, 40%)))" }}
    data-testid="status-dock" />;
}
