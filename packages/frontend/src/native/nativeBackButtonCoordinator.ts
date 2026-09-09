import { App } from "@capacitor/app";

type Handler = { onBack: () => void; priority: number; order: number };
type ListenerSession = { phase: "adding" | "ready" | "removing"; remove?: () => Promise<void> };
const handlers = new Map<symbol, Handler>();
let order = 0;
let session: ListenerSession | null = null;

function reconcile() {
  if (session) {
    if (handlers.size === 0 && session.phase === "ready") {
      const previous = session;
      previous.phase = "removing";
      void previous.remove?.().catch(() => undefined).finally(() => {
        if (session === previous) session = null;
        reconcile();
      });
    }
    return;
  }
  if (handlers.size === 0) return;
  const next: ListenerSession = { phase: "adding" };
  session = next;
  void App.addListener("backButton", ({ canGoBack } = { canGoBack: false }) => {
    if (session !== next) return;
    const top = [...handlers.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)[0];
    if (top) top.onBack();
    // The last registration can disappear while native listener removal is
    // pending. Match Capacitor's default instead of swallowing that Back.
    else if (canGoBack) window.history.back();
  }).then((listener) => {
    next.remove = () => listener.remove();
    next.phase = "ready";
    reconcile();
  }).catch(() => {
    if (session === next) session = null;
  });
}

/** One native listener, with only the highest-priority/latest surface handling
 * an event. Android owns IME dismissal before it delivers this callback. */
export function registerNativeBackAction(onBack: () => void, priority = 100): () => void {
  const key = Symbol("native-back-action");
  handlers.set(key, { onBack, priority, order: ++order });
  reconcile();
  return () => {
    handlers.delete(key);
    reconcile();
  };
}
