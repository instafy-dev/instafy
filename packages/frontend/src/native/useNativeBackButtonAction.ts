import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { useEffect, useRef } from "react";

/** Consume Android's system Back action while a dismissible native surface is open. */
export function useNativeBackButtonAction(enabled: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== "android") {
      return;
    }

    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;

    void App.addListener("backButton", () => onBackRef.current())
      .then((nextListener) => {
        if (disposed) {
          void nextListener.remove();
          return;
        }
        listener = nextListener;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [enabled]);
}
