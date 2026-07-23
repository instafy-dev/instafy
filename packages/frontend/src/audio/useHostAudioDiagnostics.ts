import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyNativeHostAudioSessionSnapshot,
  readHostAudioDiagnostics,
  type HostAudioDiagnostics,
} from "./audioSessionDiagnostics";
import { useNativeHostAudioSession } from "./nativeAudioSessionBridge";

export function useHostAudioDiagnostics(options?: {
  enabled?: boolean;
  refreshIntervalMs?: number;
}) {
  const enabled = options?.enabled ?? true;
  const refreshIntervalMs = options?.refreshIntervalMs ?? 0;
  const { value: nativeAudioSession, error: nativeAudioError } = useNativeHostAudioSession({
    enabled,
  });
  const [rawValue, setRawValue] = useState<HostAudioDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return null;
    }
    setLoading(true);
    try {
      const nextValue = await readHostAudioDiagnostics();
      setRawValue(nextValue);
      setError(null);
      return nextValue;
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setRawValue(null);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || refreshIntervalMs <= 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refresh();
    }, refreshIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh, refreshIntervalMs]);

  const value = useMemo<HostAudioDiagnostics | null>(() => {
    if (!rawValue) {
      return null;
    }
    return applyNativeHostAudioSessionSnapshot(rawValue, nativeAudioSession);
  }, [nativeAudioSession, rawValue]);

  return {
    value,
    loading,
    error: error ?? nativeAudioError,
    refresh,
  };
}
