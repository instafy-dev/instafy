import { controllerClient } from "../sdk/instafy";
import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import {
  readProjectDeviceVoicePreference,
  readProjectProviderVoicePreference,
  readProjectSpeechMode,
  writeProjectDeviceVoicePreference,
  writeProjectProviderVoicePreference,
  writeProjectSpeechMode,
  type ProjectSpeechMode,
} from "./speechPreference";
import {
  SPEECH_PROVIDER_ID,
  SPEECH_SYNTHESIS_CAPABILITY_ID,
  SPEECH_TRANSCRIPTION_CAPABILITY_ID,
} from "./speechCapabilityMetadata";

type SpeechPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

export type ProjectSpeechPreferences = {
  mode: ProjectSpeechMode;
  providerVoiceId: string | null;
  deviceVoiceId: string | null;
  updatedAt: string | null;
  source: "project" | "local" | "default";
};

function deriveSpeechPreferenceSource(options: {
  projectId: string;
  preferences: Pick<ProjectSpeechPreferences, "mode" | "providerVoiceId" | "deviceVoiceId">;
  scope: "project" | "local";
}): ProjectSpeechPreferences["source"] {
  if (preferencesAreDefault(options.preferences)) {
    return "default";
  }
  if (!options.projectId || options.scope === "local") {
    return "local";
  }
  return "project";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSpeechMode(value: unknown): ProjectSpeechMode {
  return value === "provider" || value === "device" || value === "auto" ? value : "auto";
}

function normalizeProjectSpeechPreferencesValue(value: unknown): Omit<
  ProjectSpeechPreferences,
  "source"
> | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    mode: normalizeSpeechMode(value.mode),
    providerVoiceId: normalizeOptionalString(value.providerVoiceId),
    deviceVoiceId: normalizeOptionalString(value.deviceVoiceId),
    updatedAt: normalizeOptionalString(value.updatedAt),
  };
}

function findSpeechIntegration(integrations: ControllerProjectIntegration[]) {
  return (
    integrations.find(
      (integration) => integration.provider.trim().toLowerCase() === SPEECH_PROVIDER_ID,
    ) ?? null
  );
}

function readProjectSpeechPreferencesFromIntegration(
  integration: ControllerProjectIntegration | null | undefined,
): ProjectSpeechPreferences | null {
  if (!integration || !isRecord(integration.metadata)) {
    return null;
  }
  const normalized = normalizeProjectSpeechPreferencesValue(
    integration.metadata.speechPreferences,
  );
  if (!normalized) {
    return null;
  }
  return {
    ...normalized,
    source: "project",
  };
}

export function readStoredProjectSpeechPreferences(
  storage: SpeechPreferenceStorage,
  projectId?: string | null,
): ProjectSpeechPreferences {
  const mode = readProjectSpeechMode(storage, projectId);
  const providerVoiceId = readProjectProviderVoicePreference(storage, projectId);
  const deviceVoiceId = readProjectDeviceVoicePreference(storage, projectId);
  const hasStoredPreference = mode !== "auto" || Boolean(providerVoiceId) || Boolean(deviceVoiceId);
  return {
    mode,
    providerVoiceId,
    deviceVoiceId,
    updatedAt: null,
    source: hasStoredPreference ? "local" : "default",
  };
}

function writeStoredProjectSpeechPreferences(
  storage: SpeechPreferenceStorage,
  preferences: Pick<ProjectSpeechPreferences, "mode" | "providerVoiceId" | "deviceVoiceId">,
  projectId?: string | null,
) {
  writeProjectSpeechMode(storage, preferences.mode, projectId);
  writeProjectProviderVoicePreference(storage, preferences.providerVoiceId, projectId);
  writeProjectDeviceVoicePreference(storage, preferences.deviceVoiceId, projectId);
}

function preferencesAreDefault(
  preferences: Pick<ProjectSpeechPreferences, "mode" | "providerVoiceId" | "deviceVoiceId">,
) {
  return (
    preferences.mode === "auto" &&
    !preferences.providerVoiceId?.trim() &&
    !preferences.deviceVoiceId?.trim()
  );
}

export async function readProjectSpeechPreferences(
  projectId: string | null | undefined,
  storage?: SpeechPreferenceStorage,
): Promise<ProjectSpeechPreferences> {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  const fallback = readStoredProjectSpeechPreferences(storage, normalizedProjectId || null);
  if (!normalizedProjectId) {
    return fallback;
  }

  const result = await controllerClient.integrations
    .listForProject(normalizedProjectId)
    .catch((error: unknown) => ({
      success: false,
      integrations: [],
      error: error instanceof Error ? error.message : String(error),
    }));
  if (!result.success) {
    return fallback;
  }

  return (
    readProjectSpeechPreferencesFromIntegration(findSpeechIntegration(result.integrations)) ?? fallback
  );
}

export async function writeProjectSpeechPreferences(
  projectId: string | null | undefined,
  preferences: Pick<ProjectSpeechPreferences, "mode" | "providerVoiceId" | "deviceVoiceId">,
  storage?: SpeechPreferenceStorage,
): Promise<{
  success: boolean;
  scope: "project" | "local";
  source: ProjectSpeechPreferences["source"];
  error?: string;
}> {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  writeStoredProjectSpeechPreferences(storage, preferences, normalizedProjectId || null);

  if (!normalizedProjectId) {
    return {
      success: true,
      scope: "local",
      source: deriveSpeechPreferenceSource({
        projectId: normalizedProjectId,
        preferences,
        scope: "local",
      }),
    };
  }

  const integrationsResult = await controllerClient.integrations
    .listForProject(normalizedProjectId)
    .catch((error: unknown) => ({
      success: false,
      integrations: [],
      error: error instanceof Error ? error.message : String(error),
    }));
  if (!integrationsResult.success) {
    return {
      success: false,
      scope: "local",
      source: deriveSpeechPreferenceSource({
        projectId: normalizedProjectId,
        preferences,
        scope: "local",
      }),
      error: integrationsResult.error ?? "Unable to load project speech settings.",
    };
  }

  const existingIntegration = findSpeechIntegration(integrationsResult.integrations);
  if (!existingIntegration && preferencesAreDefault(preferences)) {
    return {
      success: true,
      scope: "project",
      source: deriveSpeechPreferenceSource({
        projectId: normalizedProjectId,
        preferences,
        scope: "project",
      }),
    };
  }

  const metadata = isRecord(existingIntegration?.metadata) ? { ...existingIntegration.metadata } : {};
  if (preferencesAreDefault(preferences)) {
    delete metadata.speechPreferences;
  } else {
    metadata.speechPreferences = {
      mode: preferences.mode,
      providerVoiceId: preferences.providerVoiceId,
      deviceVoiceId: preferences.deviceVoiceId,
      updatedAt: new Date().toISOString(),
    };
  }

  const result = await controllerClient.integrations.upsert(normalizedProjectId, SPEECH_PROVIDER_ID, {
    status: existingIntegration?.status ?? "available",
    connectionType: existingIntegration?.connectionType ?? "local",
    credentialId: existingIntegration?.credentialId ?? null,
    metadata,
    requiredScopes: existingIntegration?.requiredScopes ?? [],
    capabilities:
      existingIntegration?.capabilities?.length
        ? existingIntegration.capabilities
        : [SPEECH_TRANSCRIPTION_CAPABILITY_ID, SPEECH_SYNTHESIS_CAPABILITY_ID],
  });
  if (!result.success) {
    return {
      success: false,
      scope: "local",
      source: deriveSpeechPreferenceSource({
        projectId: normalizedProjectId,
        preferences,
        scope: "local",
      }),
      error: result.error ?? "Unable to save project speech settings.",
    };
  }

  return {
    success: true,
    scope: "project",
    source: deriveSpeechPreferenceSource({
      projectId: normalizedProjectId,
      preferences,
      scope: "project",
    }),
  };
}
