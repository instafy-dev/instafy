import { useCallback, useEffect, useRef } from "react";
import { useStudioNavigationProtection } from "../workspace/StudioDrafts";
import { useStudioGuardedNavigation } from "./StudioDraftNavigationGuard";

/** Use the same dirty/busy contract for route changes and a dialog's own close controls. */
export function useStudioEditorDismissal({
  isOpen, isDirty, isPending, label, onDiscard,
}: {
  isOpen: boolean;
  isDirty: boolean;
  isPending: boolean;
  label: string;
  onDiscard: () => void;
}) {
  const guard = useStudioGuardedNavigation();
  const discarded = useRef(false);
  useEffect(() => { if (isOpen) discarded.current = false; }, [isOpen]);
  const discard = useCallback(() => {
    // Confirmation first releases protections, then resumes its action. Both
    // paths may reach this callback, but the editor must be discarded only once.
    if (discarded.current) return;
    discarded.current = true;
    onDiscard();
  }, [onDiscard]);
  useStudioNavigationProtection(isOpen && (isDirty || isPending), label, isPending ? undefined : discard);
  return useCallback(() => {
    if (isPending) return;
    if (isDirty) guard(discard);
    else discard();
  }, [discard, guard, isDirty, isPending]);
}
