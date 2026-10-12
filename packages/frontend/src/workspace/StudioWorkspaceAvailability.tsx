import type { ReactNode } from "react";
import { useAuth } from "../providers/AuthProvider";
import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
import { useActiveWorkspaceVersioning } from "./useActiveWorkspaceVersioning";
import { WorkspaceAvailabilityProvider } from "./WorkspaceAvailabilityProvider";

export function StudioWorkspaceAvailability({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { activeProjectId } = useProject();
  const { effectiveRuntimeId } = useRuntime();
  const versioning = useActiveWorkspaceVersioning();
  const versioned = versioning.mode === "stateless" || versioning.mode === "desktop";
  return <WorkspaceAvailabilityProvider key={user?.id ?? "signed-out"} scope={{
    projectId: activeProjectId,
    originId: versioned ? versioning.originId : null,
    runtimeId: versioned ? null : effectiveRuntimeId,
    routing: versioned ? "default" : "legacy",
  }}>{children}</WorkspaceAvailabilityProvider>;
}
