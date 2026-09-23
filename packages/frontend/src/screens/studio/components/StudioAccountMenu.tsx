import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useProfile } from "../../../profile/ProfileProvider";
import { useAuth } from "../../../providers/AuthProvider";
import { useStatus } from "../../../status/useStatus";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import { useWorkspaceControls } from "../workspaceControls";
import {
  checkDesktopUpdaterNow,
  desktopUpdaterBridgeAvailable,
  downloadDesktopUpdaterNow,
  installDesktopUpdaterNow,
} from "../../../desktop/updates/client";
import { applyStagedNativeOtaUpdate, triggerNativeOtaCheck } from "../../../mobile/ota/bootstrap";
import { otaIsSupportedOnThisClient } from "../../../mobile/ota/shared";
import { resolveDesktopDownloadFeedback, summarizeAppUpdateState } from "../../../updates/releaseMetadata";
import { getAppAcquisitionTarget } from "../../../updates/desktopAcquisition";
import { DESKTOP_APP_PUBLIC_LATEST_URL } from "../../../updates/desktopReleaseManifest";
import { useAppUpdateMetadata } from "../../../updates/useAppUpdateMetadata";
import { useDesktopReleaseLookup } from "../../../updates/useDesktopReleaseLookup";
import { StudioSidebarAccountSection } from "./StudioSidebarAccountSection";

export interface StudioAccountMenuProps {
  presentation?: "sidebar" | "header";
  showLabels?: boolean;
  collapsedSidebarDensity?: "comfortable" | "compact" | "dense";
  footerRef?: RefObject<HTMLDivElement | null>;
  onProfile?: () => void;
  onSupport?: () => void;
  onSignOut?: () => void;
}

/** One account controller for the global rail, compact header and navigation drawer. */
export function StudioAccountMenu({
  presentation = "sidebar",
  showLabels = false,
  collapsedSidebarDensity = "comfortable",
  footerRef,
  onProfile,
  onSupport,
  onSignOut,
}: StudioAccountMenuProps) {
  const controls = useWorkspaceControls();
  const { userEmail } = controls;
  const onOpenProfileSettings = onProfile ?? controls.onOpenProfileSettings;
  const onOpenBugReportInbox = onSupport ?? controls.onOpenBugReportInbox;
  const handleSignOut = onSignOut ?? controls.onSignOut;
  const { profile } = useProfile();
  const { user } = useAuth();
  const { showStatus } = useStatus();
  const isLargeScreen = useStudioDesktopLayout();
  const localFooterRef = useRef<HTMLDivElement | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateDialogShowDetails, setUpdateDialogShowDetails] = useState(false);
  const [updateActionPending, setUpdateActionPending] = useState(false);
  const updateLongPressTimerRef = useRef<number | null>(null);
  const suppressUpdateRowClickRef = useRef(false);
  useNativeBackButtonAction(updateDialogOpen, () => {
    if (!updateActionPending) setUpdateDialogOpen(false);
  }, 260);
  useEffect(() => {
    setProfileMenuOpen(false);
    setUpdateDialogOpen(false);
  }, [userEmail]);

  const fullName = profile?.fullName?.trim() || null;
  const displayName = fullName || userEmail || "Guest";
  const accountSubtitle = (() => {
    const email = userEmail?.trim() || null;
    if (!email) {
      return null;
    }
    if (!fullName) {
      return null;
    }
    if (fullName.toLowerCase() === email.toLowerCase()) {
      return null;
    }
    return email;
  })();
  const avatarUrl = profile?.avatarUrl?.trim() || null;
  const updateEntrySupported = desktopUpdaterBridgeAvailable() || otaIsSupportedOnThisClient();
  const {
    metadata: updateMetadata,
    refresh: refreshUpdateMetadata,
  } = useAppUpdateMetadata(updateEntrySupported);
  const updatePresentation = useMemo(
    () => (updateMetadata ? summarizeAppUpdateState(updateMetadata) : null),
    [updateMetadata],
  );
  const shouldRenderUpdateEntry =
    updateEntrySupported && (updateMetadata ? Boolean(updatePresentation?.show) : true);

  const acquisitionTarget = getAppAcquisitionTarget();
  const { lookup: desktopReleaseLookup } = useDesktopReleaseLookup({
    enabled: acquisitionTarget === "desktop",
    manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
  });
  const installEntry = acquisitionTarget === "mobile"
    ? { kind: "mobile-soon" as const }
    : acquisitionTarget === "desktop" && desktopReleaseLookup.status === "available"
      ? { kind: "desktop" as const, version: desktopReleaseLookup.manifest.version }
      : null;

  useEffect(() => {
    if (!profileMenuOpen && !updateDialogOpen) {
      return;
    }
    void refreshUpdateMetadata();
  }, [profileMenuOpen, refreshUpdateMetadata, updateDialogOpen]);

  const clearUpdateLongPress = useCallback(() => {
    if (updateLongPressTimerRef.current === null) {
      return;
    }
    window.clearTimeout(updateLongPressTimerRef.current);
    updateLongPressTimerRef.current = null;
  }, []);

  useEffect(() => () => clearUpdateLongPress(), [clearUpdateLongPress]);

  const openUpdateDialog = useCallback(
    async (showDetails: boolean) => {
      setProfileMenuOpen(false);
      setUpdateDialogShowDetails(showDetails);
      setUpdateDialogOpen(true);
      await refreshUpdateMetadata();
    },
    [refreshUpdateMetadata],
  );

  const handleUpdateEntryClick = useCallback(() => {
    clearUpdateLongPress();
    if (suppressUpdateRowClickRef.current) {
      suppressUpdateRowClickRef.current = false;
      return;
    }
    void openUpdateDialog(false);
  }, [clearUpdateLongPress, openUpdateDialog]);

  const handleUpdateEntryContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      clearUpdateLongPress();
      suppressUpdateRowClickRef.current = true;
      void openUpdateDialog(true);
    },
    [clearUpdateLongPress, openUpdateDialog],
  );

  const handleUpdateEntryPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      suppressUpdateRowClickRef.current = false;
      clearUpdateLongPress();
      updateLongPressTimerRef.current = window.setTimeout(() => {
        suppressUpdateRowClickRef.current = true;
        void openUpdateDialog(true);
      }, 550);
    },
    [clearUpdateLongPress, openUpdateDialog],
  );

  const handleUpdatePrimaryAction = useCallback(async () => {
    const current = updateMetadata ?? (await refreshUpdateMetadata());
    if (!current) {
      return;
    }

    setUpdateActionPending(true);
    try {
      if (current.runtime_surface === "desktop") {
        if (current.updates.primary_action === "download") {
          const result = await downloadDesktopUpdaterNow();
          const nextMeta = await refreshUpdateMetadata();
          const feedback = resolveDesktopDownloadFeedback(result, nextMeta);
          showStatus(feedback.message, feedback.intent, feedback.intent === "error" ? 3500 : 3000);
          return;
        } else if (current.updates.primary_action === "install") {
          const result = await installDesktopUpdaterNow();
          if (result?.lastInstallRequestAccepted === false) {
            showStatus("Update kept for later.", "info", 2500);
            return;
          }
          showStatus("Restarting to install update.", "success", 2500);
        } else if (current.updates.primary_action === "check") {
          const next = await checkDesktopUpdaterNow();
          const nextMeta = await refreshUpdateMetadata();
          if (next?.phase === "up_to_date" || nextMeta?.updates.phase === "up_to_date") {
            showStatus("Instafy is up to date.", "success", 2500);
          } else if (next?.phase === "error" || nextMeta?.updates.phase === "error") {
            showStatus(nextMeta?.updates.last_error ?? "Update check failed.", "error", 3500);
          }
          return;
        }
      } else if (current.runtime_surface === "native-ota") {
        if (current.updates.primary_action === "install") {
          const applied = await applyStagedNativeOtaUpdate();
          await refreshUpdateMetadata();
          if (applied) {
            showStatus("Restarting to apply the staged update.", "success", 3000);
          } else {
            showStatus("No staged update was found.", "info", 2500);
          }
          return;
        }
        if (
          current.updates.primary_action === "download" ||
          current.updates.primary_action === "check"
        ) {
          const result = await triggerNativeOtaCheck();
          const nextMeta = await refreshUpdateMetadata();
          if (nextMeta?.updates.phase === "downloaded") {
            showStatus("Update is ready. Restart to apply it.", "success", 3000);
          } else if (result?.update_available) {
            showStatus("Update detected. Instafy is staging it now.", "success", 3000);
          } else {
            showStatus("Instafy is up to date.", "success", 2500);
          }
          return;
        }
      }
      await refreshUpdateMetadata();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to complete update action.";
      showStatus(message, "error", 4000);
    } finally {
      setUpdateActionPending(false);
    }
  }, [refreshUpdateMetadata, showStatus, updateMetadata]);

  return <>
    <StudioSidebarAccountSection
      footerRef={footerRef ?? localFooterRef}
      presentation={presentation}
      showLabels={showLabels}
      collapsedSidebarDensity={collapsedSidebarDensity}
      profileMenuOpen={profileMenuOpen}
      onProfileMenuOpenChange={setProfileMenuOpen}
      avatarUrl={avatarUrl}
      userId={user?.id ?? null}
      displayName={displayName}
      accountSubtitle={accountSubtitle}
      installEntry={installEntry}
      isLargeScreen={isLargeScreen}
      shouldRenderUpdateEntry={shouldRenderUpdateEntry}
      updatePresentation={updatePresentation}
      onUpdateEntryClick={handleUpdateEntryClick}
      onUpdateEntryContextMenu={handleUpdateEntryContextMenu}
      onUpdateEntryPointerDown={handleUpdateEntryPointerDown}
      clearUpdateLongPress={clearUpdateLongPress}
      onOpenProfileSettings={onOpenProfileSettings}
      onOpenSupport={onOpenBugReportInbox}
      onSignOut={handleSignOut}
      updateDialogOpen={updateDialogOpen}
      onUpdateDialogOpenChange={setUpdateDialogOpen}
      updateMetadata={updateMetadata}
      updateDialogShowDetails={updateDialogShowDetails}
      onUpdateDialogShowDetailsChange={setUpdateDialogShowDetails}
      onUpdatePrimaryAction={handleUpdatePrimaryAction}
      updateActionPending={updateActionPending}
    />
  </>;
}
