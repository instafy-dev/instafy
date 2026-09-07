import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { useEffect, useRef } from "react";

const backActions = new Set<() => void>();
type BackListenerSession = { listener: { remove: () => Promise<void> } | null };
let backListenerSession: BackListenerSession | null = null;

/** Consume Android Back in the most recently opened native surface only. */
export function useNativeBackButtonAction(enabled: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== "android") {
      return;
    }

    const action = () => onBackRef.current();
    backActions.add(action);
    // Capacitor broadcasts Back to every listener. Share one bridge listener so
    // closing a nested dialog cannot also dismiss or navigate the surface below.
    if (!backListenerSession) {
      const session: BackListenerSession = { listener: null };
      backListenerSession = session;
      void App.addListener("backButton", () => {
        if (backListenerSession !== session) return;
        const topAction = [...backActions].at(-1);
        topAction?.();
      })
        .then((listener) => {
          if (backListenerSession !== session) {
            void listener.remove().catch(() => undefined);
            return;
          }
          session.listener = listener;
        })
        .catch(() => {
          if (backListenerSession === session) backListenerSession = null;
        });
    }

    return () => {
      backActions.delete(action);
      if (backActions.size === 0) {
        const session = backListenerSession;
        backListenerSession = null;
        void session?.listener?.remove().catch(() => undefined);
      }
    };
  }, [enabled]);
}
