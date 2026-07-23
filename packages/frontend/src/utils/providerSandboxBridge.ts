import type {
  ProviderUiSurfaceSandboxCapability,
  ProviderUiSurfaceSandboxHostResource,
  ProviderUiSurfaceSandboxHostResourceInvalidationPayload,
  ProviderUiSurfaceSandboxHostResourceDeltaPayload,
  ProviderUiSurfaceSandboxHostSection,
  ProviderUiSurfaceSandboxHostState,
} from "@instafy/provider-contract";
import {
  createProviderUiSurfaceSandboxBridgeMessage as createSandboxBridgeMessage,
  providerUiSurfaceSandboxHasCapability,
} from "@instafy/provider-contract";

export type ProviderSandboxHostStatePayload = ProviderUiSurfaceSandboxHostState;
export type ProviderSandboxHostResourceDeltaPayload =
  ProviderUiSurfaceSandboxHostResourceDeltaPayload;
export type ProviderSandboxHostResourceInvalidationPayload =
  ProviderUiSurfaceSandboxHostResourceInvalidationPayload;
export type ProviderSandboxHostData = {
  sections: ProviderUiSurfaceSandboxHostSection[];
  resources: ProviderUiSurfaceSandboxHostResource[];
};
export type ProviderSandboxHostMutations = {
  actions: NonNullable<ProviderSandboxHostStatePayload["hostActions"]>;
  controls: NonNullable<ProviderSandboxHostStatePayload["hostControls"]>;
};
export type CreateProviderSandboxHostStatePayloadInput = {
  version?: 1;
  stateToken?: string;
  providerId: string;
  providerTitle?: string;
  familyId?: string;
  surfaceId: string;
  resolvedTheme: "light" | "dark";
  grantedCapabilities: ProviderUiSurfaceSandboxCapability[];
  hostData?: ProviderSandboxHostData;
  hostMutations?: ProviderSandboxHostMutations;
};

export function providerSandboxHostStateHasCapability(
  state: Pick<ProviderSandboxHostStatePayload, "grantedCapabilities"> | null | undefined,
  capability: ProviderUiSurfaceSandboxCapability,
): boolean {
  return providerUiSurfaceSandboxHasCapability(state, capability);
}

export function buildProviderSandboxFrameSrc(
  src: string,
  input: { providerId: string; surfaceId: string },
): string {
  const trimmedSrc = typeof src === "string" ? src.trim() : "";
  if (!trimmedSrc) {
    return trimmedSrc;
  }
  const base =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://instafy.invalid";
  try {
    const url = new URL(trimmedSrc, base);
    url.searchParams.set("mode", "provider-sandbox");
    url.searchParams.set("providerId", input.providerId);
    url.searchParams.set("surfaceId", input.surfaceId);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return trimmedSrc;
  }
}

export function isEmbeddedProviderSandboxMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!window.parent || window.parent === window) {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("mode") ?? "").trim().toLowerCase() === "provider-sandbox";
  } catch {
    return false;
  }
}

export function readEmbeddedProviderSandboxContext() {
  if (!isEmbeddedProviderSandboxMode()) {
    return null;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const providerId = (params.get("providerId") ?? "").trim();
    const surfaceId = (params.get("surfaceId") ?? "").trim();
    if (!providerId || !surfaceId) {
      return null;
    }
    return { providerId, surfaceId };
  } catch {
    return null;
  }
}

export function postProviderSandboxReady(): boolean {
  if (!isEmbeddedProviderSandboxMode()) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxReady",
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function requestProviderSandboxHostState(): boolean {
  if (!isEmbeddedProviderSandboxMode()) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxRequestHostState",
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function requestProviderSandboxResize(height: number): boolean {
  if (!isEmbeddedProviderSandboxMode() || !Number.isFinite(height)) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxResize",
    payload: { height },
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function requestProviderSandboxOpenExternal(url: string): boolean {
  if (!isEmbeddedProviderSandboxMode()) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxOpenExternal",
    url,
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function requestProviderSandboxInvokeHostAction(actionId: string): boolean {
  if (!isEmbeddedProviderSandboxMode()) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxInvokeHostAction",
    payload: {
      actionId,
    },
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function requestProviderSandboxUpdateHostControl(
  controlId: string,
  value: string | boolean,
): boolean {
  if (!isEmbeddedProviderSandboxMode()) {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxUpdateHostControl",
    payload: {
      controlId,
      value,
    },
  });
  if (!message) {
    return false;
  }
  try {
    window.parent.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function postProviderSandboxHostState(
  targetWindow: Pick<Window, "postMessage"> | null | undefined,
  payload: ProviderSandboxHostStatePayload,
): boolean {
  if (!targetWindow || typeof targetWindow.postMessage !== "function") {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxHostState",
    payload,
  });
  if (!message) {
    return false;
  }
  try {
    targetWindow.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function postProviderSandboxHostResourcesInvalidated(
  targetWindow: Pick<Window, "postMessage"> | null | undefined,
  payload: ProviderSandboxHostResourceInvalidationPayload,
): boolean {
  if (!targetWindow || typeof targetWindow.postMessage !== "function") {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxHostResourcesInvalidated",
    payload,
  });
  if (!message) {
    return false;
  }
  try {
    targetWindow.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function postProviderSandboxHostResourceDelta(
  targetWindow: Pick<Window, "postMessage"> | null | undefined,
  payload: ProviderSandboxHostResourceDeltaPayload,
): boolean {
  if (!targetWindow || typeof targetWindow.postMessage !== "function") {
    return false;
  }
  const message = createSandboxBridgeMessage({
    type: "instafy:providerSandboxHostResourceDelta",
    payload,
  });
  if (!message) {
    return false;
  }
  try {
    targetWindow.postMessage(message, "*");
    return true;
  } catch {
    return false;
  }
}

export function readProviderSandboxHostData(
  state:
    | Pick<ProviderSandboxHostStatePayload, "hostSections" | "hostResources">
    | null
    | undefined,
): ProviderSandboxHostData {
  return {
    sections: state?.hostSections ?? [],
    resources: state?.hostResources ?? [],
  };
}

export function readProviderSandboxHostMutations(
  state:
    | Pick<ProviderSandboxHostStatePayload, "hostActions" | "hostControls">
    | null
    | undefined,
): ProviderSandboxHostMutations {
  return {
    actions: state?.hostActions ?? [],
    controls: state?.hostControls ?? [],
  };
}

export function createProviderSandboxHostStatePayload(
  input: CreateProviderSandboxHostStatePayloadInput,
): ProviderSandboxHostStatePayload {
  const hostData = input.hostData ?? { sections: [], resources: [] };
  const hostMutations = input.hostMutations ?? { actions: [], controls: [] };

  return {
    version: input.version ?? 1,
    ...(typeof input.stateToken === "string" && input.stateToken.trim().length > 0
      ? { stateToken: input.stateToken.trim() }
      : {}),
    providerId: input.providerId,
    providerTitle: input.providerTitle ?? input.providerId,
    familyId: input.familyId ?? "",
    surfaceId: input.surfaceId,
    resolvedTheme: input.resolvedTheme,
    grantedCapabilities: input.grantedCapabilities,
    ...(hostMutations.actions.length > 0 ? { hostActions: hostMutations.actions } : {}),
    ...(hostMutations.controls.length > 0 ? { hostControls: hostMutations.controls } : {}),
    ...(hostData.sections.length > 0 ? { hostSections: hostData.sections } : {}),
    ...(hostData.resources.length > 0 ? { hostResources: hostData.resources } : {}),
  };
}

export function replaceProviderSandboxHostStateResources(
  state: ProviderSandboxHostStatePayload,
  resources: ProviderUiSurfaceSandboxHostResource[],
  options?: { stateToken?: string },
): ProviderSandboxHostStatePayload {
  const hostData = readProviderSandboxHostData(state);
  const hostMutations = readProviderSandboxHostMutations(state);
  return createProviderSandboxHostStatePayload({
    version: state.version,
    stateToken: options?.stateToken ?? state.stateToken,
    providerId: state.providerId,
    providerTitle: state.providerTitle,
    familyId: state.familyId,
    surfaceId: state.surfaceId,
    resolvedTheme: state.resolvedTheme,
    grantedCapabilities: state.grantedCapabilities,
    hostData: {
      ...hostData,
      resources,
    },
    hostMutations,
  });
}
