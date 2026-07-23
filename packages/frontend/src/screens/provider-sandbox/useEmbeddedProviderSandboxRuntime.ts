import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  postProviderSandboxReady,
  readEmbeddedProviderSandboxContext,
  requestProviderSandboxHostState,
  requestProviderSandboxResize,
} from "../../utils/providerSandboxBridge";
import {
  createEmbeddedProviderSandboxRuntimeSnapshot,
  createEmbeddedProviderSandboxRuntimeState,
  resolveEmbeddedProviderSandboxRuntimeMessage,
} from "./providerSandboxEmbeddedRuntimeState";

// Thin runtime hook for embedded sandbox pages.
// It owns event subscription/effect execution and delegates state transitions
// to the embedded runtime reducer helpers.
function normalizeParam(value: string | undefined, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function applyEmbeddedTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function useEmbeddedProviderSandboxRuntime() {
  const rootRef = useRef<HTMLElement | null>(null);
  const runtimeStateRef = useRef(createEmbeddedProviderSandboxRuntimeState());
  const params = useParams();
  const embeddedContext =
    typeof window !== "undefined" ? readEmbeddedProviderSandboxContext() : null;
  const providerId = normalizeParam(embeddedContext?.providerId ?? params.providerId, "provider");
  const surfaceId = normalizeParam(embeddedContext?.surfaceId ?? params.surfaceId, "surface");
  const [runtimeState, setRuntimeState] = useState(() => createEmbeddedProviderSandboxRuntimeState());
  const snapshot = useMemo(
    () =>
      createEmbeddedProviderSandboxRuntimeSnapshot(runtimeState, {
        fallbackProviderId: providerId,
        fallbackSurfaceId: surfaceId,
      }),
    [providerId, runtimeState, surfaceId],
  );

  useEffect(() => {
    postProviderSandboxReady();
  }, []);

  useEffect(() => {
    runtimeStateRef.current = runtimeState;
  }, [runtimeState]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const transition = resolveEmbeddedProviderSandboxRuntimeMessage(runtimeStateRef.current, event);
      if (!transition.handled) {
        return;
      }
      for (const effect of transition.effects) {
        if (effect.type === "request_host_state") {
          requestProviderSandboxHostState();
          continue;
        }
        applyEmbeddedTheme(effect.theme);
      }
      setRuntimeState(transition.nextState);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }
    const nextHeight = rootRef.current.scrollHeight + 24;
    if (snapshot.capabilityProfile.canResize) {
      requestProviderSandboxResize(nextHeight);
    }
  }, [snapshot.capabilityProfile.canResize, snapshot.stateToken]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestProviderSandboxHostState();
      }
    };
    const handleFocus = () => {
      requestProviderSandboxHostState();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  return {
    rootRef,
    snapshot,
  };
}
