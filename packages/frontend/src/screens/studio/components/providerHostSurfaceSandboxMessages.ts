import { createProviderUiSurfaceSandboxCapabilityProfile } from "@instafy/provider-contract";
import {
  postProviderSandboxHostState,
} from "../../../utils/providerSandboxBridge";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import {
  normalizeOptionalString,
  type ProviderHostSurfaceSandboxStateProjection,
} from "./providerHostSurfaceSandboxState";

export type HandleProviderHostSurfaceSandboxMessageInput = {
  event: MessageEvent;
  targetWindow: Window | null;
  projection: ProviderHostSurfaceSandboxStateProjection;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  setIframeHeight: (height: number) => void;
  openExternal: (url: string) => void;
};

function readMessageData(event: MessageEvent) {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
}

function readPayload(data: Record<string, unknown>) {
  return data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
    ? (data.payload as Record<string, unknown>)
    : null;
}

export function handleProviderHostSurfaceSandboxMessage({
  event,
  targetWindow,
  projection,
  hostActionBindings,
  hostControlBindings,
  setIframeHeight,
  openExternal,
}: HandleProviderHostSurfaceSandboxMessageInput) {
  if (event.source !== targetWindow) {
    return false;
  }

  const data = readMessageData(event);
  if (!data) {
    return false;
  }
  const capabilityProfile = createProviderUiSurfaceSandboxCapabilityProfile(projection.hostState);

  if (
    data.type === "instafy:providerSandboxReady" ||
    data.type === "instafy:providerSandboxRequestHostState"
  ) {
    postProviderSandboxHostState(targetWindow, projection.hostState);
    return true;
  }

  if (data.type === "instafy:providerSandboxResize") {
    if (!capabilityProfile.canResize) {
      return true;
    }
    const payload = readPayload(data);
    const nextHeight =
      typeof payload?.height === "number" && Number.isFinite(payload.height)
        ? Math.max(240, Math.min(1600, Math.round(payload.height)))
        : null;
    if (nextHeight !== null) {
      setIframeHeight(nextHeight);
    }
    return true;
  }

  if (data.type === "instafy:providerSandboxOpenExternal") {
    if (!capabilityProfile.canOpenExternal) {
      return true;
    }
    const url = typeof data.url === "string" ? data.url.trim() : "";
    if (url) {
      openExternal(url);
    }
    return true;
  }

  if (data.type === "instafy:providerSandboxInvokeHostAction") {
    if (!capabilityProfile.canInvokeHostActions) {
      return true;
    }
    const payload = readPayload(data);
    const actionId = normalizeOptionalString(payload?.actionId);
    const action =
      projection.hostMutations.actions.find((candidate) => candidate.id === actionId) ?? null;
    const hostBinding = action ? hostActionBindings?.[action.id] : null;
    if (!action || !hostBinding?.onPress || action.disabled) {
      return true;
    }
    void Promise.resolve(hostBinding.onPress()).catch(() => {});
    return true;
  }

  if (data.type === "instafy:providerSandboxUpdateHostControl") {
    if (!capabilityProfile.canUpdateHostControls) {
      return true;
    }
    const payload = readPayload(data);
    const controlId = normalizeOptionalString(payload?.controlId);
    const control =
      projection.hostMutations.controls.find((candidate) => candidate.id === controlId) ?? null;
    const hostBinding = control ? hostControlBindings?.[control.id] : null;
    if (!control || !hostBinding?.onChange || control.disabled) {
      return true;
    }
    const nextValue = payload?.value;
    if (control.kind === "toggle") {
      if (typeof nextValue !== "boolean") {
        return true;
      }
      void Promise.resolve(hostBinding.onChange(nextValue)).catch(() => {});
      return true;
    }
    if (typeof nextValue !== "string") {
      return true;
    }
    void Promise.resolve(hostBinding.onChange(nextValue)).catch(() => {});
    return true;
  }

  return false;
}
