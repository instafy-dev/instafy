import { Capacitor } from "@capacitor/core";
import { focusManager } from "@tanstack/react-query";

type ListenerHandle = { remove: () => Promise<void> };
type NativeSession = {
  users: number;
  stopped: boolean;
  events: number;
  listener: ListenerHandle | null;
  unsubscribe: () => void;
};

let nativeActive: boolean | null = null;
let nativeSession: NativeSession | null = null;
const subscribers = new Set<() => void>();

/** WebView document visibility alone does not describe the native Activity. */
export function isAppForeground(): boolean {
  const documentVisible = typeof document === "undefined" || document.visibilityState === "visible";
  return documentVisible && (!Capacitor.isNativePlatform() || nativeActive === true);
}

export function subscribeAppForeground(listener: () => void): () => void {
  subscribers.add(listener);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", listener);
  return () => {
    subscribers.delete(listener);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", listener);
  };
}

function publish(): void {
  for (const listener of subscribers) listener();
}

function removeListener(listener: ListenerHandle | null): void {
  void listener?.remove().catch(() => undefined);
}

/** One native listener per application, including repeated bootstrap/HMR callers. */
export function installNativeAppForegroundBridge(): () => void {
  if (!Capacitor.isNativePlatform() || typeof document === "undefined") return () => undefined;

  let session = nativeSession;
  if (!session) {
    session = { users: 0, stopped: false, events: 0, listener: null, unsubscribe: () => undefined };
    nativeSession = session;
    nativeActive = null;
    const createdSession = session;
    const current = () => nativeSession === createdSession && !createdSession.stopped;
    const synchronizeFocus = () => {
      if (!current()) return;
      document.documentElement.dataset.instafyNativeAppState = nativeActive === null ? "unknown" : nativeActive ? "active" : "inactive";
      document.documentElement.dataset.instafyAppForeground = String(isAppForeground());
      // Identical native events do not produce additional focus/refetch events.
      focusManager.setFocused(isAppForeground());
    };
    createdSession.unsubscribe = subscribeAppForeground(synchronizeFocus);
    synchronizeFocus();
    publish();

    const update = (isActive: boolean) => {
      if (!current() || nativeActive === isActive) return;
      nativeActive = isActive;
      publish();
    };
    void import("@capacitor/app").then(async ({ App }) => {
      if (!current()) return;
      const listener = await App.addListener("appStateChange", ({ isActive }) => {
        if (!current()) return;
        createdSession.events += 1;
        update(isActive);
      });
      if (!current()) {
        removeListener(listener);
        return;
      }
      createdSession.listener = listener;
      // Subscribe before reading initial state. An event during registration or
      // the read is newer evidence and must not be overwritten by that read.
      const state = await App.getState();
      if (current() && createdSession.events === 0) update(state.isActive);
    }).catch(() => {
      // Unknown native state fails closed for exposure acknowledgements. A
      // later native event can still recover after an initial-state read error.
    });
  }

  session.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.users -= 1;
    if (session.users > 0 || nativeSession !== session) return;
    session.stopped = true;
    session.unsubscribe();
    removeListener(session.listener);
    nativeSession = null;
    nativeActive = null;
    // Until a new native bridge confirms activity, retain the same fail-closed
    // focus state instead of treating teardown as an app-resume event.
    focusManager.setFocused(false);
    delete document.documentElement.dataset.instafyNativeAppState;
    delete document.documentElement.dataset.instafyAppForeground;
    publish();
  };
}
