import { useCallback, useRef, useState } from "react";
import { Refresh, Trash } from "iconoir-react";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { StudioMenuAction } from "../../../components/aria/StudioMenu";
import { controllerClient } from "../../../sdk/instafy";
import type { StatusIntent } from "../../../status/useStatus";

export const CLEAR_SHARED_BROWSER_DATA_CONFIRMATION =
  "Clear Shared Browser data for everyone in this space? This signs everyone out of websites, deletes shared cookies and site data, and restarts the Shared Browser. This cannot be undone.";
const CLEAR_SHARED_BROWSER_DATA_SUCCESS =
  "Shared Browser data cleared. Starting a fresh browser…";

type ShowStatus = (
  message: string,
  intent?: StatusIntent,
  durationMs?: number,
) => void;

export function SharedBrowserDataClearAction({
  canClear,
  projectId,
  onClearStart,
  onClearSettled,
  showStatus,
  confirmation = CLEAR_SHARED_BROWSER_DATA_CONFIRMATION,
  successMessage = CLEAR_SHARED_BROWSER_DATA_SUCCESS,
}: {
  canClear: boolean;
  projectId: string | null;
  onClearStart: () => void;
  onClearSettled: (succeeded: boolean) => void;
  showStatus?: ShowStatus;
  /** What the person confirms; the default fits a separate browser session. */
  confirmation?: string;
  /** Shown once the data is cleared. */
  successMessage?: string;
}) {
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);

  const handleClear = useCallback(async () => {
    const normalizedProjectId = projectId?.trim() ?? "";
    if (!canClear || !normalizedProjectId || clearingRef.current) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(confirmation)
    ) {
      return;
    }

    clearingRef.current = true;
    setClearing(true);
    onClearStart();
    let succeeded = false;
    try {
      const result = await controllerClient.browserProfiles.clearForProject(
        normalizedProjectId,
      );
      succeeded = result.success;
      if (result.success) {
        showStatus?.(successMessage, "success", 3500);
      } else {
        showStatus?.(
          result.error ?? "Unable to clear Shared Browser data.",
          "error",
          4500,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus?.(
        message || "Unable to clear Shared Browser data.",
        "error",
        4500,
      );
    } finally {
      clearingRef.current = false;
      setClearing(false);
      onClearSettled(succeeded);
    }
  }, [canClear, confirmation, onClearSettled, onClearStart, projectId, showStatus, successMessage]);

  if (!canClear || !projectId?.trim()) {
    return null;
  }

  const label = clearing
    ? "Clearing shared browser data"
    : "Clear shared browser data";
  return (
    <StudioMenuAction
      aria-label={label}
      data-testid="shared-browser-clear-data"
      isDisabled={clearing}
      onPress={() => void handleClear()}
    >
      <MenuItemContent start={clearing ? (
        <Refresh className="animate-spin" aria-hidden="true" />
      ) : (
        <Trash aria-hidden="true" />
      )}>
      {label}
      </MenuItemContent>
    </StudioMenuAction>
  );
}
