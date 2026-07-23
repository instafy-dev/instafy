import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { CollaborationSettings } from "../types";

interface CollaborationContextValue {
  collaboration: CollaborationSettings;
  setEnabled: (enabled: boolean) => void;
  setGuestAccess: (allow: boolean) => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

export function CollaborationProvider({ children }: { children: ReactNode }) {
  const updateCollaboration = useWorkspaceStore((store) => store.updateCollaboration);

  const [collaboration, setCollaboration] = useState<CollaborationSettings>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.collaboration)) as CollaborationSettings
  );

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(
      (store) => store.state.collaboration,
      (next) => setCollaboration(JSON.parse(JSON.stringify(next)) as CollaborationSettings)
    );
    return unsubscribe;
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setCollaboration((current) => {
        const updated = { ...current, enabled } as CollaborationSettings;
        updateCollaboration(() => ({ ...updated }));
        return updated;
      });
    },
    [updateCollaboration]
  );

  const setGuestAccess = useCallback(
    (allow: boolean) => {
      setCollaboration((current) => {
        const updated = { ...current, allowGuestEditors: allow } as CollaborationSettings;
        updateCollaboration(() => ({ ...updated }));
        return updated;
      });
    },
    [updateCollaboration]
  );

  const value = useMemo<CollaborationContextValue>(
    () => ({ collaboration, setEnabled, setGuestAccess }),
    [collaboration, setEnabled, setGuestAccess]
  );

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}

export function useCollaboration(): CollaborationContextValue {
  const context = useContext(CollaborationContext);
  if (!context) {
    throw new Error("useCollaboration must be used within a CollaborationProvider");
  }
  return context;
}
