import {
  readProjectSpeechRoutes,
  writeProjectSpeechRoutes,
  type ProjectSpeechRoute,
  type ProjectSpeechRouteInput,
} from "../../voice/projectSpeechRoute";
import { isSameSpeechRoute } from "../../voice/speechRoute";
import { readDesktopVoiceHostStatus } from "../voiceHost/client";
import {
  readDesktopSpeechTunnelStatus,
  startDesktopSpeechTunnel,
  type DesktopSpeechTunnelBridgeStatus,
} from "./client";
import { resolveControllerAccessToken } from "../../services/runtimeController/core";

export type ManagedDesktopSpeechRoute = {
  projectId: string;
  publicUrl: string;
  lanBaseUrl?: string | null;
};

export type SyncDesktopSpeechRouteResult =
  | { status: "skipped"; reason: string; managedRoute: ManagedDesktopSpeechRoute | null }
  | { status: "synced"; managedRoute: ManagedDesktopSpeechRoute }
  | { status: "error"; error: string; managedRoute: ManagedDesktopSpeechRoute | null };

type SyncDesktopSpeechRouteDependencies = {
  readDesktopVoiceHostStatus: typeof readDesktopVoiceHostStatus;
  readDesktopSpeechTunnelStatus: typeof readDesktopSpeechTunnelStatus;
  startDesktopSpeechTunnel: typeof startDesktopSpeechTunnel;
  resolveControllerAccessToken: typeof resolveControllerAccessToken;
  readProjectSpeechRoutes: typeof readProjectSpeechRoutes;
  writeProjectSpeechRoutes: typeof writeProjectSpeechRoutes;
};

const defaultDependencies: SyncDesktopSpeechRouteDependencies = {
  readDesktopVoiceHostStatus,
  readDesktopSpeechTunnelStatus,
  startDesktopSpeechTunnel,
  resolveControllerAccessToken,
  readProjectSpeechRoutes,
  writeProjectSpeechRoutes,
};

function normalizeOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRouteBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function resolveDesktopSpeechAuthToken(
  hostStatus: Awaited<ReturnType<typeof readDesktopVoiceHostStatus>>,
) {
  return (
    normalizeOptionalString(hostStatus?.speechAuthToken) ??
    normalizeOptionalString(hostStatus?.lan?.authToken)
  );
}

function isDesktopHostReady(status: Awaited<ReturnType<typeof readDesktopVoiceHostStatus>>) {
  return Boolean(
    status?.enabled &&
      status.speechService?.reachable === true &&
      status.providerHost?.reachable === true,
  );
}

function isMatchingDesktopTunnel(
  status: DesktopSpeechTunnelBridgeStatus | null,
  projectId: string,
) {
  const publicUrl = normalizeOptionalString(status?.publicUrl);
  return status?.state === "active" && status.projectId === projectId && Boolean(publicUrl);
}

function isMatchingDesktopRoute(route: ProjectSpeechRoute | null, input: {
  baseUrl: string;
  connectionType: "tunnel" | "lan";
}) {
  return isSameSpeechRoute(route, {
    baseUrl: normalizeRouteBaseUrl(input.baseUrl),
    hostMode: "desktop",
    connectionType: input.connectionType,
  });
}

function buildManagedDesktopRoutes(
  hostStatus: Awaited<ReturnType<typeof readDesktopVoiceHostStatus>>,
  publicUrl: string,
): ProjectSpeechRouteInput[] {
  const routes: ProjectSpeechRouteInput[] = [];
  const speechAuthToken = resolveDesktopSpeechAuthToken(hostStatus);
  const lanBaseUrl = normalizeOptionalString(hostStatus?.lan?.baseUrl);
  if (hostStatus?.lan?.state === "available" && lanBaseUrl) {
    routes.push({
      baseUrl: lanBaseUrl,
      ...(speechAuthToken ? { authToken: speechAuthToken } : {}),
      connectionType: "lan",
      hostMode: "desktop",
    });
  }
  routes.push({
    baseUrl: publicUrl,
    ...(speechAuthToken ? { authToken: speechAuthToken } : {}),
    connectionType: "tunnel",
    hostMode: "desktop",
  });
  return routes;
}

function removeManagedDesktopRoutes(
  routes: ProjectSpeechRoute[],
  managedRoute: ManagedDesktopSpeechRoute | null,
) {
  if (!managedRoute) {
    return routes.filter((route) => !(route.hostMode === "desktop" && (route.connectionType === "lan" || route.connectionType === "tunnel")));
  }
  return routes.filter((route) => {
    if (route.hostMode !== "desktop") {
      return true;
    }
    if (route.connectionType === "tunnel") {
      return !isMatchingDesktopRoute(route, {
        baseUrl: managedRoute.publicUrl,
        connectionType: "tunnel",
      });
    }
    if (route.connectionType === "lan" && managedRoute.lanBaseUrl) {
      return !isMatchingDesktopRoute(route, {
        baseUrl: managedRoute.lanBaseUrl,
        connectionType: "lan",
      });
    }
    return route.connectionType !== "lan";
  });
}

function hasEquivalentRoutes(currentRoutes: ProjectSpeechRoute[], nextRoutes: ProjectSpeechRouteInput[]) {
  if (currentRoutes.length !== nextRoutes.length) {
    return false;
  }
  return nextRoutes.every((route) =>
    currentRoutes.some((currentRoute) =>
      isSameSpeechRoute(currentRoute, {
        baseUrl: route.baseUrl,
        hostMode: route.hostMode,
        connectionType: route.connectionType,
      }) &&
      normalizeOptionalString(currentRoute.authToken) === normalizeOptionalString(route.authToken),
    ),
  );
}

async function clearPreviousManagedRouteIfNeeded(
  previousManagedRoute: ManagedDesktopSpeechRoute | null,
  nextManagedRoute: ManagedDesktopSpeechRoute,
  accessToken: string,
  dependencies: SyncDesktopSpeechRouteDependencies,
) {
  if (!previousManagedRoute || previousManagedRoute.projectId === nextManagedRoute.projectId) {
    return;
  }
  const previousRoutes = await dependencies.readProjectSpeechRoutes(previousManagedRoute.projectId, accessToken);
  const remainingRoutes = removeManagedDesktopRoutes(previousRoutes, previousManagedRoute);
  if (remainingRoutes.length === previousRoutes.length) {
    return;
  }
  await dependencies.writeProjectSpeechRoutes(
    previousManagedRoute.projectId,
    remainingRoutes.length ? remainingRoutes : null,
    accessToken,
  );
}

export async function syncDesktopSpeechRouteForProject(
  input: {
    projectId: string | null | undefined;
    controllerUrl: string | null | undefined;
    previousManagedRoute?: ManagedDesktopSpeechRoute | null;
  },
  overrides: Partial<SyncDesktopSpeechRouteDependencies> = {},
): Promise<SyncDesktopSpeechRouteResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const projectId = normalizeOptionalString(input.projectId);
  const controllerUrl = normalizeOptionalString(input.controllerUrl);
  const previousManagedRoute = input.previousManagedRoute ?? null;

  if (!projectId) {
    return {
      status: "skipped",
      reason: "missing_project",
      managedRoute: previousManagedRoute,
    };
  }
  if (!controllerUrl) {
    return {
      status: "skipped",
      reason: "missing_controller_url",
      managedRoute: previousManagedRoute,
    };
  }

  const hostStatus = await dependencies.readDesktopVoiceHostStatus();
  if (!isDesktopHostReady(hostStatus)) {
    return {
      status: "skipped",
      reason: "desktop_host_unavailable",
      managedRoute: previousManagedRoute,
    };
  }

  const accessToken = normalizeOptionalString(await dependencies.resolveControllerAccessToken(null));
  if (!accessToken) {
    return {
      status: "skipped",
      reason: "missing_controller_access_token",
      managedRoute: previousManagedRoute,
    };
  }

  let tunnelStatus = await dependencies.readDesktopSpeechTunnelStatus();
  if (!isMatchingDesktopTunnel(tunnelStatus, projectId)) {
    tunnelStatus = await dependencies.startDesktopSpeechTunnel({
      projectId,
      controllerUrl,
      controllerAccessToken: accessToken,
      forceRestart: false,
    });
  }

  const publicUrl = normalizeOptionalString(tunnelStatus?.publicUrl);
  if (tunnelStatus?.state !== "active" || tunnelStatus.projectId !== projectId || !publicUrl) {
    return {
      status: "error",
      error: normalizeOptionalString(tunnelStatus?.lastError) ?? "Desktop speech tunnel is unavailable.",
      managedRoute: previousManagedRoute,
    };
  }

  const managedRoutes = buildManagedDesktopRoutes(hostStatus, publicUrl);
  const currentRoutes = await dependencies.readProjectSpeechRoutes(projectId, accessToken);
  const nextRoutes = [
    ...removeManagedDesktopRoutes(currentRoutes, null),
    ...managedRoutes,
  ];
  if (!hasEquivalentRoutes(currentRoutes, nextRoutes)) {
    const writeResult = await dependencies.writeProjectSpeechRoutes(
      projectId,
      nextRoutes,
      accessToken,
    );
    if (!writeResult.success) {
      return {
        status: "error",
        error: writeResult.error ?? "Unable to save the Desktop speech route.",
        managedRoute: previousManagedRoute,
      };
    }
  }

  const managedRoute = {
    projectId,
    publicUrl,
    lanBaseUrl:
      managedRoutes.find((route) => route.connectionType === "lan")?.baseUrl ?? null,
  } satisfies ManagedDesktopSpeechRoute;

  await clearPreviousManagedRouteIfNeeded(previousManagedRoute, managedRoute, accessToken, dependencies).catch(
    () => undefined,
  );

  return {
    status: "synced",
    managedRoute,
  };
}
