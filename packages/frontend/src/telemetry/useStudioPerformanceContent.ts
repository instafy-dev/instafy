import { useLayoutEffect } from "react";
import { studioPerformance, type StudioVisibleContent } from "./studioPerformance";

/** Record after a committed destination has had a paint opportunity. */
export function useStudioPerformanceContent(
  content: StudioVisibleContent,
  enabled = true,
  surface: "conversation" | "panel" = "conversation",
) {
  const { projectId, organizationId, conversationId, messageCount, loading, error } = content;
  // Layout cleanup also runs when Suspense hides resolved content again.
  useLayoutEffect(() => {
    if (!enabled) return;
    const complete = surface === "panel"
      ? studioPerformance.observePanel({ projectId, organizationId, loading, error })
      : studioPerformance.observe({ projectId, organizationId, conversationId, messageCount, loading, error });
    if (!complete) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(complete); });
    return () => cancelAnimationFrame(frame);
  }, [conversationId, enabled, error, loading, messageCount, organizationId, projectId, surface]);
}
