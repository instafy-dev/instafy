import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSpeechMode } from "./speechPreference";
import {
  readProjectSpeechPreferences,
  readStoredProjectSpeechPreferences,
  writeProjectSpeechPreferences,
  type ProjectSpeechPreferences,
} from "./projectSpeechPreferences";

type ProjectSpeechPreferenceWriteResult = Awaited<
  ReturnType<typeof writeProjectSpeechPreferences>
>;

function getSpeechPreferenceStorage() {
  return typeof window !== "undefined" ? window.localStorage : null;
}

function readFallbackSpeechPreferences(projectId: string | null | undefined) {
  return readStoredProjectSpeechPreferences(getSpeechPreferenceStorage(), projectId);
}

export type ProjectSpeechPreferencesState = {
  loading: boolean;
  mode: ProjectSpeechMode;
  providerVoiceId: string | null;
  deviceVoiceId: string | null;
  updatedAt: string | null;
  source: ProjectSpeechPreferences["source"];
  refresh: () => Promise<ProjectSpeechPreferences>;
  setMode: (nextMode: ProjectSpeechMode) => Promise<ProjectSpeechPreferenceWriteResult>;
  setProviderVoiceId: (
    nextVoiceId: string | null,
  ) => Promise<ProjectSpeechPreferenceWriteResult>;
  setDeviceVoiceId: (nextVoiceId: string | null) => Promise<ProjectSpeechPreferenceWriteResult>;
};

export function useProjectSpeechPreferencesState(
  projectId: string | null | undefined,
): ProjectSpeechPreferencesState {
  const [preferences, setPreferences] = useState<ProjectSpeechPreferences>(() =>
    readFallbackSpeechPreferences(projectId),
  );
  const [loading, setLoading] = useState(false);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const refresh = useCallback(async () => {
    const fallbackPreferences = readFallbackSpeechPreferences(projectId);
    setPreferences(fallbackPreferences);

    const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      setLoading(false);
      return fallbackPreferences;
    }

    setLoading(true);
    try {
      const nextPreferences = await readProjectSpeechPreferences(
        normalizedProjectId,
        getSpeechPreferenceStorage(),
      );
      setPreferences(nextPreferences);
      return nextPreferences;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const fallbackPreferences = readFallbackSpeechPreferences(projectId);
    setPreferences(fallbackPreferences);

    const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void readProjectSpeechPreferences(normalizedProjectId, getSpeechPreferenceStorage())
      .then((nextPreferences) => {
        if (!cancelled) {
          setPreferences(nextPreferences);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const savePreferences = useCallback(
    async (
      updater: (
        current: ProjectSpeechPreferences,
      ) => Pick<ProjectSpeechPreferences, "mode" | "providerVoiceId" | "deviceVoiceId">,
    ) => {
      const currentPreferences = preferencesRef.current;
      const nextPreferences = updater(currentPreferences);
      preferencesRef.current = {
        ...currentPreferences,
        ...nextPreferences,
      };

      setPreferences((current) => ({
        ...current,
        ...nextPreferences,
      }));

      const result = await writeProjectSpeechPreferences(
        projectId,
        nextPreferences,
        getSpeechPreferenceStorage(),
      );

      setPreferences((current) => ({
        ...current,
        ...nextPreferences,
        source: result.source,
      }));
      preferencesRef.current = {
        ...preferencesRef.current,
        ...nextPreferences,
        source: result.source,
      };

      return result;
    },
    [projectId],
  );

  const setMode = useCallback(
    async (nextMode: ProjectSpeechMode) =>
      savePreferences((current) => ({
        mode: nextMode,
        providerVoiceId: current.providerVoiceId,
        deviceVoiceId: current.deviceVoiceId,
      })),
    [savePreferences],
  );

  const setProviderVoiceId = useCallback(
    async (nextVoiceId: string | null) =>
      savePreferences((current) => ({
        mode: current.mode,
        providerVoiceId: nextVoiceId,
        deviceVoiceId: current.deviceVoiceId,
      })),
    [savePreferences],
  );

  const setDeviceVoiceId = useCallback(
    async (nextVoiceId: string | null) =>
      savePreferences((current) => ({
        mode: current.mode,
        providerVoiceId: current.providerVoiceId,
        deviceVoiceId: nextVoiceId,
      })),
    [savePreferences],
  );

  return {
    loading,
    mode: preferences.mode,
    providerVoiceId: preferences.providerVoiceId,
    deviceVoiceId: preferences.deviceVoiceId,
    updatedAt: preferences.updatedAt,
    source: preferences.source,
    refresh,
    setMode,
    setProviderVoiceId,
    setDeviceVoiceId,
  };
}
