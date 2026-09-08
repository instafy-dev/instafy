import { useEffect, useState } from "react";
import { controllerClient } from "../../../sdk/instafy";
import type { SharedBrowserProfileStatusResult } from "../../../services/runtimeController/browserProfiles";

const REFRESH_INTERVAL_MS = 30_000;

export function SharedBrowserProfileStatus({
  projectId,
  runtimeId,
  active,
  currentUserId,
}: {
  projectId: string;
  runtimeId: string | null;
  active: boolean;
  currentUserId: string | null;
}) {
  const [observation, setObservation] = useState<{
    projectId: string;
    userId: string;
    result: SharedBrowserProfileStatusResult;
  } | null>(null);

  useEffect(() => {
    setObservation(null);
    if (!active || !currentUserId || !projectId.trim()) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (cancelled || pending || document.visibilityState === "hidden") return;
      pending = true;
      let result: SharedBrowserProfileStatusResult;
      try {
        result = await controllerClient.browserProfiles.fetchStatus(projectId);
      } catch {
        result = { success: false, error: "Shared Browser save status is unavailable." };
      }
      pending = false;
      if (!cancelled) setObservation({ projectId, userId: currentUserId, result });
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onVisibility = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, currentUserId, projectId]);

  if (!active || !currentUserId) return null;
  const result = observation?.projectId === projectId && observation?.userId === currentUserId
    ? observation.result : null;
  const status = result?.success ? result.status : null;
  const heading = !result ? "Checking saved browser data…"
    : !status ? "Save status unavailable"
    : status.enabled ? "Login recovery enabled" : "Login recovery off";
  return (
    <section
      aria-label="Shared Browser saved data"
      className="min-w-0 space-y-1 rounded-lg bg-slate-500/5 p-3 text-xs text-slate-600 dark:text-slate-300"
      data-testid="shared-browser-profile-status"
    >
      <p className="font-medium" role="status">{heading}</p>
      {!status && result ? <p>We cannot verify stored browser data. Do not rely on recovery after this session ends.</p> : null}
      {status && !status.enabled ? <p>This running browser can still be shared across devices. New login data is not being backed up.</p> : null}
      {status?.lastSavedAt ? (
        <p>
          Last stored snapshot: <time dateTime={status.lastSavedAt}>{new Date(status.lastSavedAt).toLocaleString()}</time>.
          {status.savedByRuntimeId === runtimeId && runtimeId ? " Saved by this session." : " Not confirmed as a save from this session."}
        </p>
      ) : status?.enabled ? <p>No saved snapshot yet. Login recovery is not ready.</p> : null}
      {status && !status.enabled && status.lastSavedAt ? <p>An older snapshot remains stored; recovery is disabled.</p> : null}
      <p>Snapshots contain shared cookies and site data, not open tabs or unfinished forms. Changes since the last successful save may be lost.</p>
    </section>
  );
}
