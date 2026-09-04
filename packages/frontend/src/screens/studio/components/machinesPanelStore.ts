import { useSyncExternalStore } from "react";

/**
 * Cross-surface focus for the Machines page: a caller (the participants
 * drawer's machine links, or anything else) names a runtime, opens the panel,
 * and the panel scrolls that machine into view and highlights it. Module-level
 * for the same reason as chatParticipantsStore — the caller and the panel live
 * in different subtrees. The focus is one-shot: the panel consumes it.
 */

let focusRuntimeId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setMachinesPanelFocus(runtimeId: string | null): void {
  focusRuntimeId = runtimeId;
  emit();
}

/** One-shot read: returns the pending focus and clears it. */
export function consumeMachinesPanelFocus(): string | null {
  const value = focusRuntimeId;
  focusRuntimeId = null;
  if (value !== null) emit();
  return value;
}

export function useMachinesPanelFocus(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => focusRuntimeId,
    () => null,
  );
}
