const SPEECH_PROVIDER_ID = "speech";
const SPEECH_TRANSCRIPTION_CAPABILITY_ID = "speech_transcription";
const SPEECH_SYNTHESIS_CAPABILITY_ID = "speech_synthesis";

function normalizeTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function normalizeHostMode(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (normalized === "desktop" || normalized === "cli" || normalized === "server") {
    return normalized;
  }
  return "";
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeRoute(route) {
  const baseUrl = trimTrailingSlash(normalizeTrimmedString(route?.publicUrl ?? route?.baseUrl));
  const hostMode = normalizeHostMode(route?.hostMode);
  const connectionType = normalizeTrimmedString(route?.connectionType) || "tunnel";
  const authToken =
    typeof route?.authToken === "string" && route.authToken.trim().length > 0
      ? route.authToken.trim()
      : null;
  if (!baseUrl || !hostMode) {
    return null;
  }
  return {
    baseUrl,
    hostMode,
    connectionType,
    authToken,
  };
}

function describeTransport(route) {
  if (route.hostMode === "desktop" && route.connectionType === "lan") {
    return "desktop_lan";
  }
  if (route.hostMode === "desktop" && route.connectionType === "tunnel") {
    return "desktop_tunnel";
  }
  if (route.hostMode === "server") {
    return "server";
  }
  return "direct";
}

function selectLegacyRoute(routes) {
  const nonLanRoutes = routes.filter((route) => describeTransport(route) !== "desktop_lan");
  return (nonLanRoutes[0] ?? routes[0]) || null;
}

export async function publishProjectSpeechRoute(input) {
  const controllerBaseUrl = trimTrailingSlash(normalizeTrimmedString(input?.controllerUrl));
  const accessToken = normalizeTrimmedString(input?.controllerAccessToken);
  const projectId = normalizeTrimmedString(input?.projectId);
  const routes = Array.isArray(input?.routes)
    ? input.routes.map((route) => normalizeRoute(route)).filter(Boolean)
    : [normalizeRoute(input)].filter(Boolean);

  if (!controllerBaseUrl || !accessToken || !projectId || !routes.length) {
    throw new Error(
      "publishProjectSpeechRoute requires controllerUrl, controllerAccessToken, projectId, and at least one valid route.",
    );
  }

  const updatedAt = new Date().toISOString();
  const legacyRoute = selectLegacyRoute(routes);

  const response = await fetch(
    `${controllerBaseUrl}/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(SPEECH_PROVIDER_ID)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "available",
        connectionType: legacyRoute?.connectionType || "direct",
        metadata: {
          speechRoute: legacyRoute
            ? {
                baseUrl: legacyRoute.baseUrl,
                authToken: legacyRoute.authToken,
                connectionType: legacyRoute.connectionType,
                hostMode: legacyRoute.hostMode,
                updatedAt,
              }
            : null,
          speechRoutes: routes.map((route) => ({
            baseUrl: route.baseUrl,
            authToken: route.authToken,
            connectionType: route.connectionType,
            hostMode: route.hostMode,
            updatedAt,
          })),
        },
        capabilities: [SPEECH_TRANSCRIPTION_CAPABILITY_ID, SPEECH_SYNTHESIS_CAPABILITY_ID],
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to publish speech routes (${response.status} ${response.statusText}): ${detail}`,
    );
  }
}
