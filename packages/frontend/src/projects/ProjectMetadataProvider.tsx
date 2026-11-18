import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { ProjectMetadata } from "../types";

interface ProjectMetadataContextValue {
  metadata: ProjectMetadata;
}

const ProjectMetadataContext = createContext<ProjectMetadataContextValue | null>(null);

export function ProjectMetadataProvider({ children }: { children: ReactNode }) {
  const [metadata, setMetadataState] = useState<ProjectMetadata>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.metadata)) as ProjectMetadata
  );

  useEffect(() => {
    return useWorkspaceStore.subscribe(
      (store) => store.state.metadata,
      (next) => setMetadataState(JSON.parse(JSON.stringify(next)) as ProjectMetadata)
    );
  }, []);

  const value = useMemo<ProjectMetadataContextValue>(() => ({ metadata }), [metadata]);

  return <ProjectMetadataContext.Provider value={value}>{children}</ProjectMetadataContext.Provider>;
}

export function useProjectMetadata(): ProjectMetadataContextValue {
  const context = useContext(ProjectMetadataContext);
  if (!context) {
    throw new Error("useProjectMetadata must be used within a ProjectMetadataProvider");
  }
  return context;
}
