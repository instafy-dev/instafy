import { useCallback, useEffect, useState } from "react";
import { buildStudioDestinationSearch, type StudioDestination } from "../../navigation/studioNavigation";
import { getStudioVisitKey } from "../../navigation/studioVisit";
import type { CodeFile } from "../../types";
import type { StudioSearchTarget } from "./useStudioSearchRecords";

export interface StudioSearchNavigationOptions {
  viewerUserId: string | null;
  location: { key: string; search: string; state?: unknown };
  activeProjectId: string | null;
  projectReady: boolean;
  projectAccessBlocked: boolean;
  conversationsProjectKey: string;
  navigateToDestination: (destination: StudioDestination) => void;
  openFileTab: (file: Pick<CodeFile, "id" | "path" | "label">) => void;
}

interface PendingFile {
  target: Extract<StudioSearchTarget, { kind: "file" }>;
  viewerUserId: string;
  originVisit: string;
  originSearch: string;
  destinationVisit: string | null;
}

/** Search opens normal destinations; a file tab waits for the authorized destination space. */
export function useStudioSearchNavigation({
  viewerUserId, location, activeProjectId, projectReady, projectAccessBlocked,
  conversationsProjectKey, navigateToDestination, openFileTab,
}: StudioSearchNavigationOptions) {
  const [pending, setPending] = useState<PendingFile | null>(null);
  const cancelPending = useCallback(() => setPending(null), []);
  const visit = getStudioVisitKey(location);
  const activateTarget = useCallback((target: StudioSearchTarget) => {
    setPending(null);
    if (!viewerUserId) return;
    if (target.kind === "conversation") {
      navigateToDestination(target);
      return;
    }
    if (target.kind === "org-settings") {
      navigateToDestination({ kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: target.orgId });
      return;
    }
    if (target.kind === "file" && (!target.path || target.path.startsWith("/") || target.path.includes("\\")
      || /^[a-z]:/i.test(target.path) || target.path.split("/").some((part) => !part || part === "." || part === ".."))) return;
    const projectSearch = buildStudioDestinationSearch(window.location.search, { kind: "conversation", projectId: target.projectId });
    const search = buildStudioDestinationSearch(projectSearch, target.kind === "file"
      ? { kind: "panel", panel: "code" }
      : { kind: "panel", panel: target.panel, ...(target.panel === "settings" ? { settingsTab: "project" as const } : {}) });
    navigateToDestination({ kind: "route", search });
    // Navigation cancels an older pending selection first. Schedule this one
    // afterwards so it survives that same normal navigation continuation.
    if (target.kind === "file") setPending({ target, viewerUserId, originVisit: visit, originSearch: location.search, destinationVisit: null });
  }, [location.search, navigateToDestination, viewerUserId, visit]);

  useEffect(() => {
    if (!pending) return;
    if (viewerUserId !== pending.viewerUserId) { setPending(null); return; }
    const params = new URLSearchParams(location.search);
    const destinationMatches = params.get("projectId") === pending.target.projectId && params.get("panel") === "code";
    if (pending.destinationVisit !== null && pending.destinationVisit !== visit) {
      setPending(null);
      return;
    }
    if (!destinationMatches) {
      // The drawer can defer the initial route commit. After leaving that
      // original visit, a different route always supersedes the file request.
      if (pending.destinationVisit !== null || visit !== pending.originVisit || location.search !== pending.originSearch) setPending(null);
      return;
    }
    if (!pending.destinationVisit) setPending({ ...pending, destinationVisit: visit });
    if (activeProjectId !== pending.target.projectId || !projectReady || conversationsProjectKey !== pending.target.projectId) return;
    setPending(null);
    if (projectAccessBlocked) return;
    openFileTab({ id: pending.target.fileId, path: pending.target.path, label: pending.target.path.split("/").pop() || pending.target.path });
  }, [activeProjectId, conversationsProjectKey, location.search, openFileTab, pending, projectAccessBlocked, projectReady, viewerUserId, visit]);

  return { activateTarget, cancelPending };
}
