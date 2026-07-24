import { useCallback, useRef, useState } from "react";
import { Refresh, Trash } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { controllerClient } from "../../../sdk/instafy";
import type { StatusIntent } from "../../../status/useStatus";

export const CLEAR_SHARED_BROWSER_DATA_CONFIRMATION =
  "Clear Shared Browser data for everyone in this space? This signs everyone out of websites, deletes shared cookies and site data, and restarts the Shared Browser. This cannot be undone.";

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
}: {
  canClear: boolean;
  projectId: string | null;
  onClearStart: () => void;
  onClearSettled: (succeeded: boolean) => void;
  showStatus?: ShowStatus;
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
      !window.confirm(CLEAR_SHARED_BROWSER_DATA_CONFIRMATION)
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
        showStatus?.(
          "Shared Browser data cleared. Starting a fresh browser…",
          "success",
          3500,
        );
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
  }, [canClear, onClearSettled, onClearStart, projectId, showStatus]);

  if (!canClear || !projectId?.trim()) {
    return null;
  }

  const label = clearing
    ? "Clearing shared browser data"
    : "Clear shared browser data";
  return (
    <IconButton
      aria-label={label}
      className="max-[540px]:h-10 max-[540px]:w-10"
      data-testid="shared-browser-clear-data"
      isDisabled={clearing}
      onPress={() => void handleClear()}
      radius="full"
      size="sm"
      title={label}
      variant="ghost"
    >
      {clearing ? (
        <Refresh className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Trash className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </IconButton>
  );
}
