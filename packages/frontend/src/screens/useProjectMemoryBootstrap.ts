import { useEffect, useRef } from "react";

import { controllerClient } from "../sdk/instafy";
import { isUUID } from "../utils/uuid";

/** How often Studio asks again, per project and page load, before it stops. */
export const PROJECT_MEMORY_BOOTSTRAP_MAX_RETRIES = 10;

const FIRST_RETRY_DELAY_MS = 1_200;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * The wait before retry `attempt` (0 for the first retry): doubling from
 * 1.2 s up to a minute, about five minutes in all, then `null`: Studio stops
 * asking until the next page load. An origin that registers late (a hosted
 * runtime still being provisioned) is covered by that window; one that stays
 * busy or does not answer (each ask holds a controller request for up to
 * 20 s) is not asked forever.
 */
export function projectMemoryBootstrapRetryDelay(attempt: number): number | null {
  if (attempt >= PROJECT_MEMORY_BOOTSTRAP_MAX_RETRIES) {
    return null;
  }
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

export type ProjectMemoryBootstrapInput = {
  activeProjectId: string | null | undefined;
  controllerProjectMissing: boolean;
  projectReadyForWorkspace: boolean;
};

/**
 * Seeds the managed project files (AGENTS.md and the default skills) once per
 * project and page load. An origin that is not there yet or is busy is asked
 * again with a growing wait, a bounded number of times.
 */
export function useProjectMemoryBootstrap({
  activeProjectId,
  controllerProjectMissing,
  projectReadyForWorkspace,
}: ProjectMemoryBootstrapInput): void {
  const doneRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectReadyForWorkspace || !projectId || controllerProjectMissing || !isUUID(projectId)) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    if (doneRef.current.has(projectId)) {
      return;
    }
    const inFlightProjects = inFlightRef.current;
    if (inFlightProjects.has(projectId)) {
      return;
    }

    let cancelled = false;
    let retryTimeout: number | null = null;

    const attemptBootstrap = async (attempt: number) => {
      if (cancelled) {
        return;
      }
      inFlightProjects.add(projectId);
      const result = await controllerClient.projects.bootstrapMemory({ projectId });
      inFlightProjects.delete(projectId);
      if (cancelled) {
        return;
      }

      if (result?.seeded === true || result?.reason === "already-present") {
        doneRef.current.add(projectId);
        if (result.seeded) {
          window.dispatchEvent(
            new CustomEvent("instafy:workspace-commit", { detail: { projectId } }),
          );
        }
        return;
      }

      const retryable =
        result == null || result.reason === "no-origin" || result.reason === "workspace-busy";
      if (retryable) {
        const delayMs = projectMemoryBootstrapRetryDelay(attempt);
        if (delayMs === null) {
          // Out of retries: quietly leave it until the next page load.
          doneRef.current.add(projectId);
          return;
        }
        retryTimeout = window.setTimeout(() => {
          void attemptBootstrap(attempt + 1);
        }, delayMs);
        return;
      }

      if (result?.reason) {
        doneRef.current.add(projectId);
      }
    };

    void attemptBootstrap(0);

    return () => {
      cancelled = true;
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
      inFlightProjects.delete(projectId);
    };
  }, [activeProjectId, controllerProjectMissing, projectReadyForWorkspace]);
}
