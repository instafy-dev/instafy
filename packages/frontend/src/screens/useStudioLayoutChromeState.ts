import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceGitReviewSource } from "../workspace/gitReviewTypes";
import { useMobileSidebarHistory } from "./useMobileSidebarHistory";
import { useNativeBackButtonAction } from "../native/useNativeBackButtonAction";

export type LeftDrawerPanel = "history" | "files" | "sourceControl" | "workspaces";

export type SourceControlOpenRequest = {
  key: number;
  previewPath: string | null;
  reviewMode?: "focused" | "all";
};

const LEFT_DRAWER_WIDTH_STORAGE_NAME = "instafy.leftDrawer.width.v1";
const SIDEBAR_COLLAPSED_STORAGE_NAME = "instafy.sidebar.collapsed.v1";
const LEFT_DRAWER_DEFAULT_WIDTH = 352;

export function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_NAME);
    // Show team/space navigation on a first wide-screen visit. A saved choice wins.
    return stored === null ? false : stored === "1";
  } catch {
    return false;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_NAME, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, quota); the preference just
    // won't survive the reload.
  }
}
const LEFT_DRAWER_MIN_WIDTH = 280;
const LEFT_DRAWER_MAX_WIDTH = 560;

function clampLeftDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return LEFT_DRAWER_DEFAULT_WIDTH;
  }
  return Math.min(LEFT_DRAWER_MAX_WIDTH, Math.max(LEFT_DRAWER_MIN_WIDTH, Math.round(value)));
}

interface UseStudioLayoutChromeStateParams {
  isLargeScreen: boolean;
  scopeKey?: string | null;
}

export function shouldDismissLeftDrawerForKeydown(
  event: Pick<KeyboardEvent, "defaultPrevented" | "key">,
): boolean {
  return event.key === "Escape" && !event.defaultPrevented;
}

export function useStudioLayoutChromeState({
  isLargeScreen,
  scopeKey = null,
}: UseStudioLayoutChromeStateParams) {
  const { mobileSidebarOpen, setMobileSidebarOpen, mobileSidebarNavigation, runAfterSidebarClose } =
    useMobileSidebarHistory({ enabled: !isLargeScreen, scopeKey });
  const backMobileSidebar = mobileSidebarNavigation.back;
  useNativeBackButtonAction(mobileSidebarOpen, backMobileSidebar, 10);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() =>
    readStoredSidebarCollapsed(),
  );
  // Remember the rail preference: it used to reset to collapsed on every
  // reload, so anyone who works expanded re-opened it every session.
  const setSidebarCollapsed = useCallback(
    (update: boolean | ((current: boolean) => boolean)) => {
      setSidebarCollapsedState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        writeStoredSidebarCollapsed(next);
        return next;
      });
    },
    [],
  );
  const [leftDrawer, setLeftDrawer] = useState<null | LeftDrawerPanel>(null);
  const [mobileGitReviewSheet, setMobileGitReviewSheet] = useState<WorkspaceGitReviewSource | null>(null);
  const [sourceControlOpenRequest, setSourceControlOpenRequest] = useState<SourceControlOpenRequest | null>(null);
  const [leftDrawerWidth, setLeftDrawerWidth] = useState<number>(() => {
    if (typeof window === "undefined") {
      return LEFT_DRAWER_DEFAULT_WIDTH;
    }
    try {
      const stored = window.localStorage.getItem(LEFT_DRAWER_WIDTH_STORAGE_NAME);
      if (!stored) {
        return LEFT_DRAWER_DEFAULT_WIDTH;
      }
      const parsed = Number.parseInt(stored, 10);
      return clampLeftDrawerWidth(parsed);
    } catch {
      return LEFT_DRAWER_DEFAULT_WIDTH;
    }
  });
  const [leftDrawerResizing, setLeftDrawerResizing] = useState(false);
  const leftDrawerResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [filesExplorerPortalTarget, setFilesExplorerPortalTarget] = useState<HTMLDivElement | null>(null);
  const [workspaceSwitcherPortalTarget, setWorkspaceSwitcherPortalTarget] = useState<HTMLDivElement | null>(null);

  const handleFilesExplorerPortalRef = useCallback((node: HTMLDivElement | null) => {
    setFilesExplorerPortalTarget((current) => (current === node ? current : node));
  }, []);

  const handleWorkspaceSwitcherPortalRef = useCallback((node: HTMLDivElement | null) => {
    setWorkspaceSwitcherPortalTarget((current) => (current === node ? current : node));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(
        LEFT_DRAWER_WIDTH_STORAGE_NAME,
        String(clampLeftDrawerWidth(leftDrawerWidth)),
      );
    } catch {
      // ignore storage failures
    }
  }, [leftDrawerWidth]);

  const stopLeftDrawerResize = useCallback(() => {
    leftDrawerResizeRef.current = null;
    setLeftDrawerResizing(false);
    if (typeof document === "undefined") {
      return;
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  useEffect(() => {
    if (!leftDrawerResizing) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      const state = leftDrawerResizeRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }
      const delta = event.clientX - state.startX;
      const next = clampLeftDrawerWidth(state.startWidth + delta);
      setLeftDrawerWidth((current) => (current === next ? current : next));
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const state = leftDrawerResizeRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }
      stopLeftDrawerResize();
    };
    const handleWindowBlur = () => {
      stopLeftDrawerResize();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [leftDrawerResizing, stopLeftDrawerResize]);

  useEffect(() => {
    if (isLargeScreen && leftDrawer) {
      return;
    }
    stopLeftDrawerResize();
  }, [isLargeScreen, leftDrawer, stopLeftDrawerResize]);

  const handleLeftDrawerResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isLargeScreen || !leftDrawer) {
        return;
      }
      leftDrawerResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: leftDrawerWidth,
      };
      setLeftDrawerResizing(true);
      if (typeof document !== "undefined") {
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }
      event.preventDefault();
    },
    [isLargeScreen, leftDrawer, leftDrawerWidth],
  );

  useEffect(() => {
    if (!mobileSidebarOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissLeftDrawerForKeydown(event)) {
        backMobileSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [backMobileSidebar, mobileSidebarOpen]);

  useEffect(() => {
    // A mobile workspace URL has its own route-aware dismissal owner. Let it
    // pop/replace the visit rather than clearing UI state beneath the route.
    if (!leftDrawer || (!isLargeScreen && leftDrawer === "workspaces")) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissLeftDrawerForKeydown(event)) {
        setLeftDrawer(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isLargeScreen, leftDrawer]);

  return {
    filesExplorerPortalTarget,
    handleFilesExplorerPortalRef,
    workspaceSwitcherPortalTarget,
    handleWorkspaceSwitcherPortalRef,
    leftDrawer,
    leftDrawerResizing,
    leftDrawerWidth,
    mobileGitReviewSheet,
    mobileSidebarOpen,
    mobileSidebarNavigation,
    runAfterSidebarClose,
    setLeftDrawer,
    setMobileGitReviewSheet,
    setMobileSidebarOpen,
    setSidebarCollapsed,
    sidebarCollapsed,
    sourceControlOpenRequest,
    setSourceControlOpenRequest,
    handleLeftDrawerResizeStart,
  };
}
