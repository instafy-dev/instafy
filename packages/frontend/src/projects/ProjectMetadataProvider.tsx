import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { ProjectContent, ProjectMetadata } from "../types";

interface ProjectMetadataContextValue {
  metadata: ProjectMetadata;
  content: ProjectContent;
  setMetadata: (updater: (current: ProjectMetadata) => ProjectMetadata) => void;
  setContent: (updater: (current: ProjectContent) => ProjectContent) => void;
}

const ProjectMetadataContext = createContext<ProjectMetadataContextValue | null>(null);

export function ProjectMetadataProvider({ children }: { children: ReactNode }) {
  const updateMetadata = useWorkspaceStore((store) => store.updateMetadata);
  const updateContent = useWorkspaceStore((store) => store.updateContent);

  const [metadata, setMetadataState] = useState<ProjectMetadata>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.metadata)) as ProjectMetadata
  );
  const [content, setContentState] = useState<ProjectContent>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().state.content)) as ProjectContent
  );

  useEffect(() => {
    const unsubscribeMetadata = useWorkspaceStore.subscribe(
      (store) => store.state.metadata,
      (next) => setMetadataState(JSON.parse(JSON.stringify(next)) as ProjectMetadata)
    );
    const unsubscribeContent = useWorkspaceStore.subscribe(
      (store) => store.state.content,
      (next) => setContentState(JSON.parse(JSON.stringify(next)) as ProjectContent)
    );
    return () => {
      unsubscribeMetadata();
      unsubscribeContent();
    };
  }, []);

  const setMetadata = useCallback(
    (updater: (current: ProjectMetadata) => ProjectMetadata) => {
      setMetadataState((current) => {
        const draft = JSON.parse(JSON.stringify(current)) as ProjectMetadata;
        const updated = updater(draft);
        updateMetadata(() => JSON.parse(JSON.stringify(updated)) as ProjectMetadata);
        return JSON.parse(JSON.stringify(updated)) as ProjectMetadata;
      });
    },
    [updateMetadata]
  );

  const setContent = useCallback(
    (updater: (current: ProjectContent) => ProjectContent) => {
      setContentState((current) => {
        const draft = JSON.parse(JSON.stringify(current)) as ProjectContent;
        const updated = updater(draft);
        updateContent(() => JSON.parse(JSON.stringify(updated)) as ProjectContent);
        return JSON.parse(JSON.stringify(updated)) as ProjectContent;
      });
    },
    [updateContent]
  );

  const value = useMemo<ProjectMetadataContextValue>(
    () => ({ metadata, content, setMetadata, setContent }),
    [metadata, content, setMetadata, setContent]
  );

  return <ProjectMetadataContext.Provider value={value}>{children}</ProjectMetadataContext.Provider>;
}

export function useProjectMetadata(): ProjectMetadataContextValue {
  const context = useContext(ProjectMetadataContext);
  if (!context) {
    throw new Error("useProjectMetadata must be used within a ProjectMetadataProvider");
  }
  return context;
}
