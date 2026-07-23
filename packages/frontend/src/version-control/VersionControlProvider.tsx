import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { VersionControlSettings } from "../types";

interface VersionControlContextValue {
  versionControl: VersionControlSettings;
  setVersionControl: (updater: (current: VersionControlSettings) => VersionControlSettings) => void;
}

const VersionControlContext = createContext<VersionControlContextValue | null>(null);

export function VersionControlProvider({ children }: { children: ReactNode }) {
  const updateVersionControl = useWorkspaceStore((store) => store.updateVersionControl);

  const [versionControl, setVersionControlState] = useState<VersionControlSettings>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.versionControl)) as VersionControlSettings
  );

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(
      (store) => store.state.versionControl,
      (next) => setVersionControlState(JSON.parse(JSON.stringify(next)) as VersionControlSettings)
    );
    return unsubscribe;
  }, []);

  const setVersionControl = useCallback(
    (updater: (current: VersionControlSettings) => VersionControlSettings) => {
      setVersionControlState((current) => {
        const draft = { ...current } as VersionControlSettings;
        const updated = updater(draft);
        updateVersionControl(() => ({ ...updated }));
        return { ...updated } as VersionControlSettings;
      });
    },
    [updateVersionControl]
  );

  const value = useMemo<VersionControlContextValue>(
    () => ({ versionControl, setVersionControl }),
    [setVersionControl, versionControl]
  );

  return <VersionControlContext.Provider value={value}>{children}</VersionControlContext.Provider>;
}

export function useVersionControlState(): VersionControlContextValue {
  const context = useContext(VersionControlContext);
  if (!context) {
    throw new Error("useVersionControlState must be used within a VersionControlProvider");
  }
  return context;
}
