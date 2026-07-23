import { useEffect, useMemo, useState } from "react";
import type { HostAudioDiagnostics } from "./audioSessionDiagnostics";
import {
  deriveHostAudioSessionState,
  type HostAudioSessionState,
} from "./hostAudioSessionState";
import type { VoiceTurnState } from "../voice/useVoiceTurnController";

export function useHostAudioSessionState(options: {
  enabled?: boolean;
  diagnostics: HostAudioDiagnostics | null;
  voiceState?: VoiceTurnState;
}) {
  const enabled = options.enabled ?? true;
  const [foreground, setForeground] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  const [focused, setFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const updateForeground = () => {
      setForeground(document.visibilityState !== "hidden");
      setFocused(document.hasFocus());
    };
    const updateFocus = () => {
      setFocused(document.hasFocus());
    };
    updateForeground();
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateFocus);
    window.addEventListener("blur", updateFocus);
    return () => {
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateFocus);
      window.removeEventListener("blur", updateFocus);
    };
  }, [enabled]);

  const value = useMemo<HostAudioSessionState | null>(() => {
    if (!enabled) {
      return null;
    }
    return deriveHostAudioSessionState({
      diagnostics: options.diagnostics,
      voiceState: options.voiceState,
      foreground,
      focused,
    });
  }, [enabled, focused, foreground, options.diagnostics, options.voiceState]);

  return {
    value,
  };
}
