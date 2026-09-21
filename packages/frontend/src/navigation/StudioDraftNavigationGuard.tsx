import { useNativeBackButtonAction } from "../native/useNativeBackButtonAction";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import { Button } from "../components/Button";
import { StudioDialogModal } from "../components/aria/StudioModal";
import { useStudioDraftSnapshot, useStudioDraftStore } from "../workspace/StudioDrafts";

const runImmediately = (action: () => void) => action();
const NavigationContext = createContext(runImmediately);
export function useStudioGuardedNavigation() { return useContext(NavigationContext); }

/** Guard Router Back/Forward and the tab owner's imperative entry points alike. */
export function StudioDraftNavigationGuard({ children }: { children: ReactNode }) {
  const store = useStudioDraftStore();
  const { drafts, protections } = useStudioDraftSnapshot();
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const snapshot = store?.getSnapshot();
    if (snapshot?.drafts.length && nextLocation.pathname !== "/studio") return true;
    if (!snapshot?.protections.length) return false;
    if (currentLocation.pathname !== nextLocation.pathname) return true;
    const current = new URLSearchParams(currentLocation.search);
    const next = new URLSearchParams(nextLocation.search);
    // Canonical controller IDs and drawer changes do not leave the editor.
    // Blocking those background URL updates would prompt without a user navigation.
    return ["projectId", "panel", "settingsTab", "settingsCategory", "settingsItem",
      "settingsOrgId", "teamId", "conversationId", "jobId", "reviewTab"]
      .some(key => current.get(key) !== next.get(key));
  });
  const run = useCallback((action: () => void) => {
    if (store?.getSnapshot().protections.length) setPending({ action });
    else action();
  }, [store]);
  const hasWork = drafts.length > 0 || protections.length > 0;
  useEffect(() => {
    if (!hasWork) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasWork]);
  const stay = () => {
    setPending(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  const leave = () => {
    if (protections.some(item => !item.discard)) return;
    protections.forEach(item => {
      item.discard?.();
      // Release synchronously: the continuation can navigate before React runs
      // the editor effect cleanup, which would otherwise block the same click twice.
      store?.unprotect(item.id);
    });
    if (blocker.state === "blocked") {
      if (blocker.location.pathname !== "/studio") store?.clearDrafts();
      blocker.proceed();
    } else pending?.action();
    setPending(null);
  };
  const busy = protections.some(item => !item.discard);
  useNativeBackButtonAction(Boolean(pending) || blocker.state === "blocked", stay, 300);
  return <NavigationContext.Provider value={run}>
    {children}
    <StudioDialogModal isOpen={Boolean(pending) || blocker.state === "blocked"} onOpenChange={open => { if (!open) stay(); }}
      isDismissable dialogAriaLabel="Unfinished work" modalClassName="p-5">
      <h2 className="text-lg font-semibold">{busy ? "Work is still in progress" : "Leave unfinished work?"}</h2>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {busy ? "Wait for the current operation to finish before leaving."
          : protections.length ? `Your ${protections[0].label} is still open. Discard it to leave, or keep editing.`
            : "Your unsaved settings are kept while you browse Studio. Leaving Studio will discard them."}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onPress={stay} variant="outline" autoFocus>Keep editing</Button>
        {!busy ? <Button onPress={leave}>{hasWork ? "Discard and leave" : "Continue"}</Button> : null}
      </div>
    </StudioDialogModal>
  </NavigationContext.Provider>;
}
