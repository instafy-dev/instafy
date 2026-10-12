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

export function ProjectAccessRecoveryBanner({ children }: { children?: ReactNode }) {
  const { activeProjectId } = useProjectState();
  const {
    projectInitialized,
    projectAccessUnavailable,
    projectAccessBlocked,
    projectProvisionFailed,
    retryProjectBootstrap,
  } = useProjectAccess();
  // No space at all: the account had none and making one failed. Before this
  // the studio opened with a shut composer and no word about why.
  if (!activeProjectId && projectInitialized && projectProvisionFailed) {
    return (
      <div
        className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm text-slate-700 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200"
        data-testid="project-provision-failed"
      >
        <p role="status" className="min-w-0 flex-1">Couldn’t set up your space.</p>
        <Button variant="ghost" size="sm" className="min-h-11 shrink-0" onPress={retryProjectBootstrap}>
          Try again
        </Button>
      </div>
    );
  }
  if (!activeProjectId || !projectInitialized || !projectAccessUnavailable || projectAccessBlocked) {
    return projectAccessBlocked ? null : <>{children}</>;
  }
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm text-slate-700 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      <p role="status" className="min-w-0 flex-1">Couldn’t check access. Retrying…</p>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 shrink-0"
        onPress={() => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: activeProjectId },
        }))}
      >
        Retry
      </Button>
    </div>
  );
}
