import { useCallback, useState } from "react";
import type { HostAudioPermissionState } from "./audioSessionDiagnostics";
import { requestHostMicrophonePermission } from "./hostMicrophonePermission";

export function useHostMicrophonePermissionAction(options?: {
  refresh?: () => Promise<unknown> | unknown;
}) {
  const refresh = options?.refresh;
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPermission, setLastPermission] = useState<HostAudioPermissionState | null>(null);

  const requestPermission = useCallback(async () => {
    setRequesting(true);
    setError(null);
    try {
      const permission = await requestHostMicrophonePermission();
      setLastPermission(permission);
      await refresh?.();
      return permission;
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      return null;
    } finally {
      setRequesting(false);
    }
  }, [refresh]);

  return {
    requesting,
    error,
    lastPermission,
    requestPermission,
  };
}
