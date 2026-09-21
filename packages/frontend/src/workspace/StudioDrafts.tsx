import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { StudioPanel } from "../screens/studio/types";

type Draft = { key: string; panel: StudioPanel; value: unknown; base: unknown };
type Protection = { id: string; panel: StudioPanel; label: string; discard?: () => void };
type Snapshot = { drafts: Draft[]; protections: Protection[] };
const EMPTY: Snapshot = { drafts: [], protections: [] };

/** Session memory only. The owner is remounted on account changes. */
export class StudioDraftStore {
  private snapshot: Snapshot = EMPTY;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish(snapshot: Snapshot) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  get(key: string) { return this.snapshot.drafts.find(draft => draft.key === key); }
  set(draft: Draft) {
    const previous = this.get(draft.key);
    if (previous && Object.is(previous.value, draft.value) && Object.is(previous.base, draft.base)) return;
    this.publish({ ...this.snapshot, drafts: [...this.snapshot.drafts.filter(item => item.key !== draft.key), draft] });
  }
  remove(key: string) {
    if (this.get(key)) this.publish({ ...this.snapshot, drafts: this.snapshot.drafts.filter(item => item.key !== key) });
  }
  protect(protection: Protection) {
    this.publish({ ...this.snapshot, protections: [...this.snapshot.protections.filter(item => item.id !== protection.id), protection] });
  }
  unprotect(id: string) {
    if (this.snapshot.protections.some(item => item.id === id)) {
      this.publish({ ...this.snapshot, protections: this.snapshot.protections.filter(item => item.id !== id) });
    }
  }
  clearDrafts() { this.publish({ ...this.snapshot, drafts: [] }); }
}

const Context = createContext<StudioDraftStore | null>(null);
const PanelContext = createContext<StudioPanel>("settings");
export const StudioDraftPanel = PanelContext.Provider;
const subscribeEmpty = () => () => {};
const getEmpty = () => EMPTY;

export function StudioDraftsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new StudioDraftStore());
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useStudioDraftStore() { return useContext(Context); }
export function useStudioDraftSnapshot() {
  const store = useContext(Context);
  return useSyncExternalStore(store?.subscribe ?? subscribeEmpty, store?.getSnapshot ?? getEmpty, getEmpty);
}

/** Unedited values follow refreshed server data; edits survive panel unmounts. */
export function useStudioDraftState<T>(key: string, initial: T, ready = true): [T, Dispatch<SetStateAction<T>>] {
  const shared = useContext(Context);
  const [local] = useState(() => new StudioDraftStore());
  const store = shared ?? local;
  const panel = useContext(PanelContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const entry = snapshot.drafts.find(item => item.key === key);
  const value = entry ? entry.value as T : initial;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    // Loading placeholders must not erase a deliberately empty draft.
    if (ready && entry && Object.is(entry.value, initial)) store.remove(key);
  }, [entry, initial, key, ready, store]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const current = store.get(key);
    const previous = current ? current.value as T : initialRef.current;
    const value = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
    if (Object.is(value, initialRef.current)) store.remove(key);
    else store.set({ key, panel, base: initialRef.current, value });
  }, [key, panel, store]);
  return [value, setValue];
}

/** Complex editors/connection flows retain their mounted owner until resolved. */
export function useStudioNavigationProtection(active: boolean, label: string, discard?: () => void) {
  const store = useContext(Context);
  const panel = useContext(PanelContext);
  const id = useId();
  const discardRef = useRef(discard);
  discardRef.current = discard;
  const canDiscard = Boolean(discard);
  useEffect(() => {
    if (!store || !active) return;
    store.protect({ id, panel, label, discard: canDiscard ? () => discardRef.current?.() : undefined });
    return () => store.unprotect(id);
  }, [active, canDiscard, id, label, panel, store]);
}
