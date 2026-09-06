import type { ReactNode } from "react";
import { Button } from "../components/Button";
import { EntryLoadingScreen } from "../components/EntryLoadingScreen";
import { useAuth } from "../providers/AuthProvider";
import { useProjectAccess } from "../projects/ProjectAccessProvider";
import { useProjectState } from "../projects/ProjectStateProvider";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../projects/projectAccessEvents";

export function StudioStartupGate({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const { projectInitialized } = useProjectAccess();
  if (loading || (user && !projectInitialized)) {
    return <EntryLoadingScreen />;
  }
  return user ? <>{children}</> : null;
}

export function ProjectAccessRecoveryBanner() {
  const { activeProjectId } = useProjectState();
  const { projectInitialized, projectAccessUnavailable, projectAccessBlocked } = useProjectAccess();
  if (!activeProjectId || !projectInitialized || !projectAccessUnavailable || projectAccessBlocked) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      <p role="status">Couldn’t check access to this space. Retrying…</p>
      <Button
        variant="outline"
        size="sm"
        onPress={() => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: activeProjectId },
        }))}
      >
        Retry
      </Button>
    </div>
  );
}
