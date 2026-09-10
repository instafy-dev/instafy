import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildStudioDestinationSearch, type StudioDestination } from "../../navigation/studioNavigation";
import { getStudioVisitKey } from "../../navigation/studioVisit";
import type { CodeFile } from "../../types";
import type { StudioSearchTarget } from "./useStudioSearchRecords";
import type { OpenWorkspaceFileEventDetail } from "./components/useFilesPanelViewerState";

export interface StudioSearchNavigationOptions {
  viewerUserId: string | null;
  location: { key: string; search: string; state?: unknown };
  activeProjectId: string | null;
  projectReady: boolean;
  projectAccessBlocked: boolean;
  conversationsProjectKey: string;
  navigateToDestination: (destination: StudioDestination, options?: { forceNewVisit?: boolean }) => void;
  openFileTab: (file: Pick<CodeFile, "id" | "path" | "label">) => void;
}

interface PendingFile {
  target: Extract<StudioSearchTarget, { kind: "file" }>;
  viewerUserId: string;
  originVisit: string;
  originSearch: string;
  destinationSearch: string;
  destinationVisit: string | null;
}

interface FileLoad {
  viewerUserId: string;
  projectId: string;
  visit: string;
  controller: AbortController;
  dispose: () => void;
}

/** A lazy Files panel can accept the pending request when it mounts. Keep the
 * signal alive after acknowledgement: acceptance is not completion of its read. */
function dispatchFileOpen(projectId: string, path: string, signal: AbortSignal) {
  const runtimeWindow = window as typeof window & {
    __INSTAFY_OPEN_WORKSPACE_FILE_ACK__?: string | null;
    __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: OpenWorkspaceFileEventDetail | null;
  };
  const detail: OpenWorkspaceFileEventDetail = {
    handoffId: crypto.randomUUID(), projectId, path, source: "studio-search", signal,
  };
  let timer: number | undefined;
  let attempts = 0;
  const dispose = () => {
    window.clearTimeout(timer);
    if (runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ === detail) {
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = null;
    }
    signal.removeEventListener("abort", dispose);
  };
  const notify = () => {
    if (signal.aborted || runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ !== detail
      || runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__ === detail.handoffId) return;
    window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    if (++attempts < 30 && runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ === detail
      && runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__ !== detail.handoffId) {
      timer = window.setTimeout(notify, 16);
    }
  };
  runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
  signal.addEventListener("abort", dispose, { once: true });
  notify();
  return dispose;
}

/** Search opens normal destinations; a file tab waits for the authorized destination space. */
export function useStudioSearchNavigation({
  viewerUserId, location, activeProjectId, projectReady, projectAccessBlocked,
  conversationsProjectKey, navigateToDestination, openFileTab,
}: StudioSearchNavigationOptions) {
  const [pending, setPending] = useState<PendingFile | null>(null);
  const fileLoad = useRef<FileLoad | null>(null);
  const cancelFileLoad = useCallback(() => {
    const current = fileLoad.current;
    fileLoad.current = null;
    current?.controller.abort();
    current?.dispose();
  }, []);
  const cancelPending = useCallback(() => { setPending(null); cancelFileLoad(); }, [cancelFileLoad]);
  const visit = getStudioVisitKey(location);
  // Browser Back and account/access changes also cancel a read already accepted
  // by Files, before its asynchronous completion can update the next workspace.
  useLayoutEffect(() => {
    const current = fileLoad.current;
    if (!current) return;
    const params = new URLSearchParams(location.search);
    if (viewerUserId !== current.viewerUserId || visit !== current.visit
      || activeProjectId !== current.projectId || conversationsProjectKey !== current.projectId
      || !projectReady || projectAccessBlocked || params.get("projectId") !== current.projectId
      || params.get("panel") !== "code") cancelFileLoad();
  }, [activeProjectId, cancelFileLoad, conversationsProjectKey, location.search, projectAccessBlocked, projectReady, viewerUserId, visit]);
  useEffect(() => cancelFileLoad, [cancelFileLoad]);
  const activateTarget = useCallback((target: StudioSearchTarget) => {
    cancelPending();
    if (!viewerUserId) return;
    if (target.kind === "conversation") {
      navigateToDestination(target, { forceNewVisit: true });
      return;
    }
    if (target.kind === "org-settings") {
      navigateToDestination({ kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: target.orgId }, { forceNewVisit: true });
      return;
    }
    if (target.kind === "file" && (!target.path || target.path.startsWith("/") || target.path.includes("\\")
      || /^[a-z]:/i.test(target.path) || target.path.split("/").some((part) => !part || part === "." || part === ".."))) return;
    const projectSearch = buildStudioDestinationSearch(window.location.search, { kind: "conversation", projectId: target.projectId });
    const search = buildStudioDestinationSearch(projectSearch, target.kind === "file"
      ? { kind: "panel", panel: "code" }
      : { kind: "panel", panel: target.panel, ...(target.panel === "settings" ? { settingsTab: "project" as const } : {}) });
    navigateToDestination({ kind: "route", search }, { forceNewVisit: true });
    // Navigation cancels an older pending selection first. Schedule this one
    // afterwards so it survives that same normal navigation continuation.
    if (target.kind === "file") setPending({ target, viewerUserId, originVisit: visit, originSearch: location.search, destinationSearch: search, destinationVisit: null });
  }, [cancelPending, location.search, navigateToDestination, viewerUserId, visit]);

  useEffect(() => {
    if (!pending) return;
    if (viewerUserId !== pending.viewerUserId
      || activeProjectId === pending.target.projectId && projectAccessBlocked) { setPending(null); return; }
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
    // Search always creates a fresh visit so Back can restore its results,
    // even when a file is already open at an identical URL.
    if (pending.destinationVisit === null && visit === pending.originVisit) return;
    if (!pending.destinationVisit) setPending({ ...pending, destinationVisit: visit });
    if (activeProjectId !== pending.target.projectId || !projectReady || conversationsProjectKey !== pending.target.projectId) return;
    setPending(null);
    if (projectAccessBlocked) return;
    if (pending.target.requiresLoad) {
      cancelFileLoad();
      const controller = new AbortController();
      const load: FileLoad = { viewerUserId: pending.viewerUserId, projectId: pending.target.projectId,
        visit, controller, dispose: () => {} };
      fileLoad.current = load;
      load.dispose = dispatchFileOpen(pending.target.projectId, pending.target.path, controller.signal);
      return;
    }
    openFileTab({ id: pending.target.fileId, path: pending.target.path, label: pending.target.path.split("/").pop() || pending.target.path });
  }, [activeProjectId, cancelFileLoad, conversationsProjectKey, location.search, openFileTab, pending, projectAccessBlocked, projectReady, viewerUserId, visit]);

  return { activateTarget, cancelPending };
}
