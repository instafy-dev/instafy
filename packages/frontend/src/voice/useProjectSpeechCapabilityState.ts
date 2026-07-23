import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  describeSpeechServiceConnection,
  readSpeechDependencyStatus,
  readSpeechVoiceOptions,
  type SpeechDependencyStatus,
  type SpeechServiceConnectionSummary,
  type SpeechVoiceOption,
} from "./speechService";
import { describeSpeechRouteLabel } from "./speechProviderDiagnostics";

export type ProjectSpeechCapabilityState = {
  loading: boolean;
  speechDependencyStatus: SpeechDependencyStatus | null;
  setSpeechDependencyStatus: Dispatch<SetStateAction<SpeechDependencyStatus | null>>;
  providerSpeechVoices: SpeechVoiceOption[];
  browserSpeechVoices: SpeechVoiceOption[];
  providerDefaultVoiceId: string | null;
  selectedProviderVoice: SpeechVoiceOption | null;
  selectedDeviceVoice: SpeechVoiceOption | null;
  connectionSummary: SpeechServiceConnectionSummary;
  routeLabel: string;
  refresh: () => Promise<void>;
};

type UseProjectSpeechCapabilityStateOptions = {
  projectId: string | null | undefined;
  enabled: boolean;
  refreshIntervalMs?: number;
  providerVoiceId?: string | null;
  deviceVoiceId?: string | null;
};

export function useProjectSpeechCapabilityState(
  options: UseProjectSpeechCapabilityStateOptions,
): ProjectSpeechCapabilityState {
  const [loading, setLoading] = useState(false);
  const [speechDependencyStatus, setSpeechDependencyStatus] = useState<SpeechDependencyStatus | null>(
    null,
  );
  const [providerSpeechVoices, setProviderSpeechVoices] = useState<SpeechVoiceOption[]>([]);
  const [browserSpeechVoices, setBrowserSpeechVoices] = useState<SpeechVoiceOption[]>([]);
  const [providerDefaultVoiceId, setProviderDefaultVoiceId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!options.enabled) {
      setSpeechDependencyStatus(null);
      setProviderSpeechVoices([]);
      setBrowserSpeechVoices([]);
      setProviderDefaultVoiceId(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [{ value }, voices] = await Promise.all([
        readSpeechDependencyStatus(),
        readSpeechVoiceOptions(),
      ]);
      setSpeechDependencyStatus(value);
      setProviderSpeechVoices(voices.providerVoices);
      setBrowserSpeechVoices(voices.browserVoices);
      setProviderDefaultVoiceId(voices.providerDefaultVoiceId);
    } finally {
      setLoading(false);
    }
  }, [options.enabled]);

  useEffect(() => {
    let cancelled = false;
    if (!options.enabled) {
      setSpeechDependencyStatus(null);
      setProviderSpeechVoices([]);
      setBrowserSpeechVoices([]);
      setProviderDefaultVoiceId(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void Promise.all([readSpeechDependencyStatus(), readSpeechVoiceOptions()])
      .then(([statusResult, voicesResult]) => {
        if (cancelled) {
          return;
        }
        setSpeechDependencyStatus(statusResult.value);
        setProviderSpeechVoices(voicesResult.providerVoices);
        setBrowserSpeechVoices(voicesResult.browserVoices);
        setProviderDefaultVoiceId(voicesResult.providerDefaultVoiceId);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    if (!options.refreshIntervalMs || options.refreshIntervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void Promise.all([readSpeechDependencyStatus(), readSpeechVoiceOptions()]).then(
        ([statusResult, voicesResult]) => {
          if (cancelled) {
            return;
          }
          setSpeechDependencyStatus(statusResult.value);
          setProviderSpeechVoices(voicesResult.providerVoices);
          setBrowserSpeechVoices(voicesResult.browserVoices);
          setProviderDefaultVoiceId(voicesResult.providerDefaultVoiceId);
        },
      );
    }, options.refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [options.enabled, options.projectId, options.refreshIntervalMs]);

  const selectedProviderVoice = useMemo(
    () =>
      providerSpeechVoices.find((voice) => voice.id === (options.providerVoiceId ?? null)) ?? null,
    [options.providerVoiceId, providerSpeechVoices],
  );
  const selectedDeviceVoice = useMemo(
    () =>
      browserSpeechVoices.find((voice) => voice.id === (options.deviceVoiceId ?? null)) ?? null,
    [browserSpeechVoices, options.deviceVoiceId],
  );
  const connectionSummary = useMemo(
    () => describeSpeechServiceConnection(speechDependencyStatus),
    [speechDependencyStatus],
  );
  const routeLabel = useMemo(
    () => describeSpeechRouteLabel(connectionSummary),
    [connectionSummary],
  );

  return {
    loading,
    speechDependencyStatus,
    setSpeechDependencyStatus,
    providerSpeechVoices,
    browserSpeechVoices,
    providerDefaultVoiceId,
    selectedProviderVoice,
    selectedDeviceVoice,
    connectionSummary,
    routeLabel,
    refresh,
  };
}
