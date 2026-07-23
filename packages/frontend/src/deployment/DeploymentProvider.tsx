import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { DeploymentOptions } from "../types";

interface DeploymentContextValue {
  deployment: DeploymentOptions;
  update: (updater: (current: DeploymentOptions) => DeploymentOptions) => void;
  setSubdomain: (value: string) => void;
  setHostingPlan: (plan: DeploymentOptions["hostingPlan"]) => void;
}

const DeploymentContext = createContext<DeploymentContextValue | null>(null);

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const updateDeployment = useWorkspaceStore((store) => store.updateDeployment);

  const [deployment, setDeploymentState] = useState<DeploymentOptions>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.deployment)) as DeploymentOptions
  );

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(
      (store) => store.state.deployment,
      (next) => setDeploymentState(JSON.parse(JSON.stringify(next)) as DeploymentOptions)
    );
    return unsubscribe;
  }, []);

  const setDeployment = useCallback(
    (updater: (current: DeploymentOptions) => DeploymentOptions) => {
      setDeploymentState((current) => {
        const draft = { ...current } as DeploymentOptions;
        const updated = updater(draft);
        updateDeployment(() => ({ ...updated }));
        return { ...updated } as DeploymentOptions;
      });
    },
    [updateDeployment]
  );

  const setSubdomain = useCallback(
    (value: string) => {
      setDeployment((current) => ({
        ...current,
        subdomain: value
      }));
    },
    [setDeployment]
  );

  const setHostingPlan = useCallback(
    (plan: DeploymentOptions["hostingPlan"]) => {
      setDeployment((current) => ({
        ...current,
        hostingPlan: plan
      }));
    },
    [setDeployment]
  );

  const value = useMemo<DeploymentContextValue>(
    () => ({ deployment, update: setDeployment, setSubdomain, setHostingPlan }),
    [deployment, setDeployment, setHostingPlan, setSubdomain]
  );

  return <DeploymentContext.Provider value={value}>{children}</DeploymentContext.Provider>;
}

export function useDeployment(): DeploymentContextValue {
  const context = useContext(DeploymentContext);
  if (!context) {
    throw new Error("useDeployment must be used within a DeploymentProvider");
  }
  return context;
}
