import { useLayoutEffect, useRef } from "react";
import { Button } from "../components/Button";
import { useWorkspaceAvailability } from "./WorkspaceAvailabilityProvider";

export function WorkspaceAvailabilityBanner() {
  const { issue, checking, retry } = useWorkspaceAvailability();
  const retryHadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!issue && retryHadFocus.current && document.activeElement === document.body) {
      [...document.querySelectorAll<HTMLElement>('[data-testid="studio-context-workspace-focus"]')]
        .find((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'))?.focus({ preventScroll: true });
    }
    if (!issue) retryHadFocus.current = false;
  }, [issue]);
  if (!issue) return null;
  const message = issue.kind === "access" ? "Couldn’t access workspace files."
    : issue.kind === "unavailable" ? "Workspace files are unavailable."
    : "Can’t reach workspace files. Retrying…";
  return <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm text-slate-700 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200" data-testid="workspace-availability-banner">
    <p role="status" className="min-w-0 flex-1">{checking ? "Checking workspace connection…" : message}</p>
    <Button data-testid="workspace-availability-retry" variant="text" tone="muted" size="sm" className="shrink-0" isPending={checking} onPress={retry}
      onFocus={() => { retryHadFocus.current = true; }}
      onBlur={(event) => { if (event.currentTarget.isConnected) retryHadFocus.current = false; }}>
      Retry
    </Button>
  </div>;
}
