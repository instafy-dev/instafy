import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";
import { registerNativeBackAction } from "./nativeBackButtonCoordinator";

/** Consume Android's system Back action while a dismissible native surface is open. */
export function useNativeBackButtonAction(enabled: boolean, onBack: () => void, priority = 100) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== "android") {
      return;
    }

    return registerNativeBackAction(() => onBackRef.current(), priority);
  }, [enabled, priority]);
}
