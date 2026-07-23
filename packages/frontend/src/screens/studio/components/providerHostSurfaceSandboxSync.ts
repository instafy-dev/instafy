import { createProviderUiSurfaceSandboxCapabilityProfile } from "@instafy/provider-contract";
import {
  postProviderSandboxHostResourceDelta,
  postProviderSandboxHostResourcesInvalidated,
  postProviderSandboxHostState,
  type ProviderSandboxHostStatePayload,
} from "../../../utils/providerSandboxBridge";
import {
  buildProviderHostSurfaceSandboxResourceDelta,
  type ProviderHostSurfaceSandboxStateProjection,
  type ProviderSandboxHostResource,
} from "./providerHostSurfaceSandboxState";

export type ProviderHostSurfaceSandboxSyncAction =
  | {
      kind: "post_host_state";
      hostState: ProviderSandboxHostStatePayload;
    }
  | {
      kind: "post_host_resource_delta";
      resources: ProviderSandboxHostResource[];
      removedResourceIds: string[];
      stateToken?: string;
    }
  | {
      kind: "post_host_resource_invalidations";
      resourceIds: string[];
      stateToken?: string;
    };

export function runProviderHostSurfaceSandboxSyncAction(
  targetWindow: Window | null,
  action: ProviderHostSurfaceSandboxSyncAction | null,
) {
  if (!targetWindow || !action) {
    return;
  }
  if (action.kind === "post_host_state") {
    postProviderSandboxHostState(targetWindow, action.hostState);
    return;
  }
  if (action.kind === "post_host_resource_delta") {
    postProviderSandboxHostResourceDelta(targetWindow, {
      resources: action.resources,
      removedResourceIds: action.removedResourceIds,
      stateToken: action.stateToken,
    });
    return;
  }
  postProviderSandboxHostResourcesInvalidated(targetWindow, {
    resourceIds: action.resourceIds,
    stateToken: action.stateToken,
  });
}

export function resolveProviderHostSurfaceSandboxHostStateSync(input: {
  iframeLoaded: boolean;
  targetWindow: Window | null;
  previousSnapshot: string | null;
  projection: ProviderHostSurfaceSandboxStateProjection;
}) {
  const { iframeLoaded, targetWindow, previousSnapshot, projection } = input;
  const { hostPushSnapshot, hostState } = projection;

  if (!iframeLoaded || !targetWindow) {
    return {
      nextSnapshot: hostPushSnapshot,
      action: null,
    };
  }
  if (previousSnapshot === null) {
    return {
      nextSnapshot: hostPushSnapshot,
      action: null,
    };
  }
  if (previousSnapshot === hostPushSnapshot) {
    return {
      nextSnapshot: previousSnapshot,
      action: null,
    };
  }
  return {
    nextSnapshot: hostPushSnapshot,
    action: {
      kind: "post_host_state" as const,
      hostState,
    },
  };
}

export function resolveProviderHostSurfaceSandboxResourceSync(input: {
  iframeLoaded: boolean;
  targetWindow: Window | null;
  previousSnapshot: string | null;
  previousResources: ProviderSandboxHostResource[];
  projection: ProviderHostSurfaceSandboxStateProjection;
}) {
  const {
    iframeLoaded,
    targetWindow,
    previousSnapshot,
    previousResources,
    projection,
  } = input;
  const { hostData, hostResourceSnapshot, hostState } = projection;
  const hostResources = hostData.resources;
  const capabilityProfile = createProviderUiSurfaceSandboxCapabilityProfile(hostState);

  if (!capabilityProfile.canReadHostResources) {
    return {
      nextSnapshot: previousSnapshot,
      nextResources: previousResources,
      action: null,
    };
  }
  if (!iframeLoaded || !targetWindow) {
    return {
      nextSnapshot: hostResourceSnapshot,
      nextResources: hostResources,
      action: null,
    };
  }
  if (previousSnapshot === null) {
    return {
      nextSnapshot: hostResourceSnapshot,
      nextResources: hostResources,
      action: null,
    };
  }
  if (previousSnapshot === hostResourceSnapshot) {
    return {
      nextSnapshot: previousSnapshot,
      nextResources: previousResources,
      action: null,
    };
  }

  const delta = buildProviderHostSurfaceSandboxResourceDelta(previousResources, hostResources);
  if (capabilityProfile.supportsHostResourceDeltas && (delta.resources.length > 0 || delta.removedResourceIds.length > 0)) {
    return {
      nextSnapshot: hostResourceSnapshot,
      nextResources: hostResources,
      action: {
        kind: "post_host_resource_delta" as const,
        resources: delta.resources,
        removedResourceIds: delta.removedResourceIds,
        stateToken: hostState.stateToken,
      },
    };
  }

  const resourceIds = Array.from(
    new Set([
      ...delta.resources.map((resource) => resource.id),
      ...delta.removedResourceIds,
    ]),
  );

  return {
    nextSnapshot: hostResourceSnapshot,
    nextResources: hostResources,
    action:
      resourceIds.length > 0
        ? {
            kind: "post_host_resource_invalidations" as const,
            resourceIds,
            stateToken: hostState.stateToken,
          }
        : null,
  };
}
