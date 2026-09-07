import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStudioPerformanceContent } from "./useStudioPerformanceContent";

type PanelDestination = {
  projectId: string | null;
  organizationId: string | null;
  enabled: boolean;
  loading: boolean;
  error: boolean;
};

const PanelPerformanceContext = createContext<PanelDestination | null>(null);

/** Only the selected main panel supplies a destination; drawers remain unmeasured. */
export function StudioPanelPerformance({
  children,
  deferred,
  projectId,
  organizationId,
  enabled,
  loading,
  error,
  requestedPanel,
}: PanelDestination & { children: ReactNode; deferred: boolean; requestedPanel?: string }) {
  // Space hydration can temporarily select an existing Home tab while the
  // workspace still requests chat. That fallback is not the destination.
  const awaitingChatSelection = requestedPanel === "chat";
  const destination = useMemo(
    () => ({ projectId, organizationId, enabled, loading: loading || awaitingChatSelection, error }),
    [awaitingChatSelection, enabled, error, loading, organizationId, projectId],
  );
  return (
    <PanelPerformanceContext.Provider value={destination}>
      {children}
      {deferred ? null : <StudioPanelPerformanceProbe />}
    </PanelPerformanceContext.Provider>
  );
}

/** Inside Suspense, this commits only with the resolved panel or its visible fallback. */
export function StudioPanelPerformanceProbe({ loading = false, error = false }: {
  loading?: boolean;
  error?: boolean;
}) {
  const destination = useContext(PanelPerformanceContext);
  useStudioPerformanceContent({
    projectId: destination?.projectId ?? null,
    organizationId: destination?.organizationId ?? null,
    conversationId: null,
    messageCount: 0,
    loading: Boolean(destination?.loading || loading),
    error: Boolean(destination?.error || (!destination?.loading && error)),
  }, destination?.enabled ?? false, "panel");
  return null;
}
