import { controllerClient } from "../sdk/instafy";
import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import {
  SPEECH_PROVIDER_ID,
  SPEECH_SYNTHESIS_CAPABILITY_ID,
  SPEECH_TRANSCRIPTION_CAPABILITY_ID,
} from "./speechCapabilityMetadata";
import {
  createSpeechRoute,
  describeSpeechRouteTransport,
  normalizeSpeechRouteBaseUrl,
  normalizeSpeechRouteConnectionType,
  normalizeSpeechRouteHostMode,
  normalizeSpeechRouteString,
  selectPreferredSpeechRoute,
  type SpeechRoute,
  type SpeechRouteHostMode,
} from "./speechRoute";

export type ProjectSpeechRouteHostMode = SpeechRouteHostMode;

export type ProjectSpeechRoute = SpeechRoute & { source: "project" };
export type ProjectSpeechRouteInput = {
  baseUrl: string;
  authToken?: string | null;
  connectionType?: string | null;
  hostMode?: ProjectSpeechRouteHostMode | null;
  updatedAt?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findSpeechIntegration(integrations: ControllerProjectIntegration[]) {
  return (
    integrations.find(
      (integration) => integration.provider.trim().toLowerCase() === SPEECH_PROVIDER_ID,
    ) ?? null
  );
}

function normalizeSpeechRouteValue(
  value: unknown,
  connectionType: string | null,
): ProjectSpeechRoute | null {
  if (!isRecord(value)) {
    return null;
  }
  return createSpeechRoute({
    baseUrl: value.baseUrl,
    authToken: value.authToken,
    connectionType: normalizeSpeechRouteConnectionType(value.connectionType) ?? connectionType,
    hostMode: value.hostMode,
    updatedAt: value.updatedAt,
    source: "project",
  }) as ProjectSpeechRoute | null;
}

function dedupeProjectSpeechRoutes(routes: ProjectSpeechRoute[]) {
  const seen = new Set<string>();
  const deduped: ProjectSpeechRoute[] = [];
  for (const route of routes) {
    const key = [
      route.baseUrl,
      route.connectionType ?? "",
      route.hostMode ?? "",
    ].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(route);
  }
  return deduped;
}

function normalizeSpeechRouteValues(
  metadata: Record<string, unknown>,
  connectionType: string | null,
): ProjectSpeechRoute[] {
  const routes: ProjectSpeechRoute[] = [];
  const storedRoutes = metadata.speechRoutes;
  if (Array.isArray(storedRoutes)) {
    for (const entry of storedRoutes) {
      const route = normalizeSpeechRouteValue(entry, connectionType);
      if (route) {
        routes.push(route);
      }
    }
  }
  if (!routes.length) {
    const legacyRoute = normalizeSpeechRouteValue(metadata.speechRoute, connectionType);
    if (legacyRoute) {
      routes.push(legacyRoute);
    }
  }
  return dedupeProjectSpeechRoutes(routes);
}

function selectLegacyProjectSpeechRoute(routes: ProjectSpeechRoute[]) {
  const nonLanRoutes = routes.filter((route) => describeSpeechRouteTransport(route) !== "desktop_lan");
  return (selectPreferredSpeechRoute(nonLanRoutes) ?? selectPreferredSpeechRoute(routes)) as ProjectSpeechRoute | null;
}

async function loadProjectSpeechIntegration(
  projectId: string,
  accessToken?: string | null,
): Promise<{
  success: boolean;
  integration: ControllerProjectIntegration | null;
  integrations: ControllerProjectIntegration[];
  error?: string;
}> {
  const result = await controllerClient.integrations
    .listForProject(projectId, {
      accessToken: accessToken ?? null,
    })
    .catch((error: unknown) => ({
      success: false,
      integrations: [],
      error: error instanceof Error ? error.message : String(error),
    }));

  if (!result.success) {
    return {
      success: false,
      integration: null,
      integrations: [],
      error: result.error,
    };
  }

  return {
    success: true,
    integration: findSpeechIntegration(result.integrations),
    integrations: result.integrations,
  };
}

function toStoredSpeechRoute(route: ProjectSpeechRouteInput, updatedAt: string) {
  return {
    baseUrl: normalizeSpeechRouteBaseUrl(route.baseUrl),
    authToken: normalizeSpeechRouteString(route.authToken),
    connectionType: normalizeSpeechRouteConnectionType(route.connectionType),
    hostMode: normalizeSpeechRouteHostMode(route.hostMode),
    updatedAt: normalizeSpeechRouteString(route.updatedAt) ?? updatedAt,
  };
}

function normalizeProjectSpeechRouteInputs(routes: ProjectSpeechRouteInput[] | null | undefined) {
  if (!routes?.length) {
    return [] as ProjectSpeechRoute[];
  }
  const normalized = routes
    .map((route) =>
      createSpeechRoute({
        baseUrl: route.baseUrl,
        authToken: route.authToken,
        connectionType: route.connectionType,
        hostMode: route.hostMode,
        updatedAt: route.updatedAt,
        source: "project",
      }) as ProjectSpeechRoute | null,
    )
    .filter((route): route is ProjectSpeechRoute => Boolean(route));
  return dedupeProjectSpeechRoutes(normalized);
}

export async function readProjectSpeechRoutes(
  projectId: string | null | undefined,
  accessToken?: string | null,
): Promise<ProjectSpeechRoute[]> {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  if (!normalizedProjectId) {
    return [];
  }

  const result = await loadProjectSpeechIntegration(normalizedProjectId, accessToken);
  if (!result.success || !result.integration || !isRecord(result.integration.metadata)) {
    return [];
  }

  return normalizeSpeechRouteValues(
    result.integration.metadata,
    normalizeSpeechRouteConnectionType(result.integration.connectionType),
  );
}

export async function readProjectSpeechRoute(
  projectId: string | null | undefined,
  accessToken?: string | null,
): Promise<ProjectSpeechRoute | null> {
  const routes = await readProjectSpeechRoutes(projectId, accessToken);
  return selectLegacyProjectSpeechRoute(routes);
}

export async function writeProjectSpeechRoutes(
  projectId: string | null | undefined,
  routes: ProjectSpeechRouteInput[] | null,
  accessToken?: string | null,
): Promise<{
  success: boolean;
  scope: "project";
  error?: string;
}> {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  if (!normalizedProjectId) {
    return {
      success: false,
      scope: "project",
      error: "Missing project id.",
    };
  }

  const result = await loadProjectSpeechIntegration(normalizedProjectId, accessToken);
  if (!result.success) {
    return {
      success: false,
      scope: "project",
      error: result.error ?? "Unable to load project speech routes.",
    };
  }

  const existingIntegration = result.integration;
  if (!existingIntegration && (!routes || routes.length === 0)) {
    return {
      success: true,
      scope: "project",
    };
  }

  const metadata = isRecord(existingIntegration?.metadata) ? { ...existingIntegration.metadata } : {};
  const normalizedRoutes = normalizeProjectSpeechRouteInputs(routes);
  if ((routes?.length ?? 0) > 0 && !normalizedRoutes.length) {
    return {
      success: false,
      scope: "project",
      error: "Missing speech route URL.",
    };
  }
  if (!normalizedRoutes.length) {
    delete metadata.speechRoute;
    delete metadata.speechRoutes;
  } else {
    const updatedAt = new Date().toISOString();
    const storedRoutes = normalizedRoutes
      .map((route) => toStoredSpeechRoute(route, updatedAt))
      .filter((route): route is NonNullable<typeof route> => Boolean(route.baseUrl));
    const legacyRoute = selectLegacyProjectSpeechRoute(normalizedRoutes);
    metadata.speechRoutes = storedRoutes;
    metadata.speechRoute = legacyRoute ? toStoredSpeechRoute(legacyRoute, updatedAt) : storedRoutes[0];
  }

  const legacyRoute = normalizeSpeechRouteValue(
    metadata.speechRoute,
    normalizeSpeechRouteConnectionType(existingIntegration?.connectionType),
  );

  const upsertResult = await controllerClient.integrations.upsert(
    normalizedProjectId,
    SPEECH_PROVIDER_ID,
    {
      accessToken: accessToken ?? null,
      status: existingIntegration?.status ?? "available",
      connectionType:
        normalizeSpeechRouteConnectionType(legacyRoute?.connectionType) ??
        normalizeSpeechRouteConnectionType(existingIntegration?.connectionType) ??
        (normalizedRoutes.length ? "direct" : "local"),
      credentialId: existingIntegration?.credentialId ?? null,
      metadata,
      requiredScopes: existingIntegration?.requiredScopes ?? [],
      capabilities:
        existingIntegration?.capabilities?.length
          ? existingIntegration.capabilities
          : [SPEECH_TRANSCRIPTION_CAPABILITY_ID, SPEECH_SYNTHESIS_CAPABILITY_ID],
    },
  );

  if (!upsertResult.success) {
    return {
      success: false,
      scope: "project",
      error: upsertResult.error ?? "Unable to save project speech routes.",
    };
  }

  return {
    success: true,
    scope: "project",
  };
}

export async function writeProjectSpeechRoute(
  projectId: string | null | undefined,
  route: {
    baseUrl: string;
    authToken?: string | null;
    connectionType?: string | null;
    hostMode?: ProjectSpeechRouteHostMode | null;
  } | null,
  accessToken?: string | null,
): Promise<{
  success: boolean;
  scope: "project";
  error?: string;
}> {
  if (route && !normalizeSpeechRouteBaseUrl(route.baseUrl)) {
    return {
      success: false,
      scope: "project",
      error: "Missing speech route URL.",
    };
  }
  return await writeProjectSpeechRoutes(projectId, route ? [route] : null, accessToken);
}
